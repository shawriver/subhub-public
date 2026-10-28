package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestBillingMonthBoundaries(t *testing.T) {
	for _, c := range []struct {
		at         string
		day        int
		start, end string
	}{
		{"2024-02-28T15:59:59Z", 31, "2024-01-30T16:00:00Z", "2024-02-28T16:00:00Z"},
		{"2024-02-28T16:00:00Z", 31, "2024-02-28T16:00:00Z", "2024-03-30T16:00:00Z"},
		{"2026-02-28T16:00:00Z", 31, "2026-02-27T16:00:00Z", "2026-03-30T16:00:00Z"},
		{"2026-12-31T16:00:00Z", 1, "2026-12-31T16:00:00Z", "2027-01-31T16:00:00Z"},
	} {
		at, _ := time.Parse(time.RFC3339, c.at)
		s, e := billingWindow(at, c.day)
		if s.UTC().Format(time.RFC3339) != c.start || e.UTC().Format(time.RFC3339) != c.end {
			t.Fatalf("incorrect billing window for %s", c.at)
		}
	}
}
func TestCycleConfigurationAndForgery(t *testing.T) {
	a := testApp(t)
	_, m, _ := fixture(t, a)
	m.ResetDay = 31
	m.CycleBase = 999
	m.CycleStart = "forged"
	m.QuotaUsed = -1
	if w := request(a, "PUT", "/api/admin/member/"+m.ID, m, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	a.get("member", m.ID, &m)
	if !validCycle(m) || m.CycleBase != m.Used || memberQuotaUsed(m) != 0 || m.QuotaUsed != 0 {
		t.Fatal("cycle metadata accepted from client")
	}
	old := m
	m.CycleBase = 0
	m.Used = 0
	if w := request(a, "PUT", "/api/admin/member/"+m.ID, m, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	a.get("member", m.ID, &m)
	if m.CycleBase != old.CycleBase || m.Used != old.Used {
		t.Fatal("forged usage reset")
	}
	if advanceCycle(&m, time.Now()) {
		t.Fatal("reset not idempotent")
	}
	m.ResetDay = 0
	if err := configureCycle(&m, old, time.Now()); err != nil || !validCycle(m) || memberQuotaUsed(m) != m.Used {
		t.Fatal("cumulative switch")
	}
	old.ResetDay = 32
	if configureCycle(&old, m, time.Now()) == nil {
		t.Fatal("invalid reset day")
	}
}
func TestMonthlyExhaustionAndResumption(t *testing.T) {
	a, f, n, m := setupManaged(t)
	m.ResetDay = 1
	advanceCycle(&m, time.Now())
	m.Used = m.Limit
	m.CycleBase = 0
	a.put("member", m.ID, m)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.clients) != 1 {
		t.Fatal("exhausted user received grant")
	}
	start, _ := billingWindow(time.Now(), 1)
	advanceCycle(&m, start.Add(-time.Second))
	m.CycleBase = 0
	a.put("member", m.ID, m)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.get("member", m.ID, &m)
	if m.Used != m.Limit || memberQuotaUsed(m) != 0 {
		t.Fatal("lifetime usage lost or allowance not reset")
	}
	if _, err := a.managedCredential(m, n); err != nil {
		t.Fatal("monthly grant not resumed")
	}
	if !strings.Contains(subscriptionUserinfo(m), "download=0;") {
		t.Fatal("subscription quota header not reset")
	}
}
func TestFetchAuditStatusesPrivacyAndIsolation(t *testing.T) {
	a := testApp(t)
	_, m, p := fixture(t, a)
	path := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	for _, c := range []struct {
		path   string
		status int
	}{{path, 200}, {path + "?format=unsupported", 400}} {
		if w := request(a, "GET", c.path, nil, false); w.Code != c.status {
			t.Fatal(w.Code)
		}
	}
	m.Enabled = false
	a.put("member", m.ID, m)
	request(a, "GET", path, nil, false)
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "198.51.100.4:8080"
	r.Header.Set("X-Forwarded-For", "1.1.1.1")
	secret := token()
	r.Header.Set("User-Agent", "client "+secret+" https://example.test/sub/hidden\nnext")
	a.recordFetch(r, p, 410, secret)
	w := request(a, "GET", "/api/admin/subscription-fetches?member="+m.ID, nil, true)
	var rows []SubscriptionFetch
	json.Unmarshal(w.Body.Bytes(), &rows)
	if len(rows) != 4 || rows[0].IP != "198.51.100.4" || rows[1].Status != 404 || rows[2].Format != "invalid" || rows[3].Status != 200 {
		t.Fatal("incorrect audit states")
	}
	if strings.Contains(w.Body.String(), secret) || strings.Contains(w.Body.String(), "hidden") || strings.Contains(w.Body.String(), "https://") {
		t.Fatal("audit leaked token or URL")
	}
	if w := request(a, "GET", "/api/admin/subscription-fetches?member=other", nil, true); w.Body.String() != "[]\n" {
		t.Fatal("member isolation")
	}
	if request(a, "GET", "/api/admin/subscription-fetches", nil, false).Code != 401 {
		t.Fatal("unauthenticated audit")
	}
	request(a, "GET", "/sub/invalid", nil, false)
	var count int
	a.db.QueryRow("SELECT count(*) FROM subscription_fetches").Scan(&count)
	if count != 4 {
		t.Fatal("invalid token persisted")
	}
}
func TestFetchRetention(t *testing.T) {
	a := testApp(t)
	_, _, p := fixture(t, a)
	insert := func(at time.Time) {
		if _, err := a.db.Exec("INSERT INTO subscription_fetches(at,profile,member,ip,ua,format,status) VALUES(?,?,?,?,?,?,?)", at.UTC().Format(time.RFC3339), p.ID, p.MemberID, "unknown", "", "clash", 200); err != nil {
			t.Fatal(err)
		}
	}
	nowT := time.Now()
	insert(nowT.AddDate(0, 0, -89))  // inside the 90-day retention: kept
	insert(nowT.AddDate(0, 0, -91))  // outside: deleted
	insert(nowT.AddDate(0, 0, -200)) // outside: deleted
	insert(nowT)
	// recordFetch no longer deletes by age on the request path.
	a.recordFetch(httptest.NewRequest("GET", "/", nil), p, 200, "")
	var count int
	a.db.QueryRow("SELECT count(*) FROM subscription_fetches").Scan(&count)
	if count != 5 {
		t.Fatalf("recordFetch changed retention behavior, count=%d", count)
	}
	n, err := a.cleanupFetchRetention(nowT)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("cleanup deleted %d rows, want 2", n)
	}
	a.db.QueryRow("SELECT count(*) FROM subscription_fetches").Scan(&count)
	if count != 3 {
		t.Fatalf("survivors=%d, want 3", count)
	}
	a.db.QueryRow("SELECT count(*) FROM subscription_fetches WHERE at<?", nowT.AddDate(0, 0, -90).UTC().Format(time.RFC3339)).Scan(&count)
	if count != 0 {
		t.Fatal("row older than retention kept")
	}
	var audits int
	a.db.QueryRow("SELECT count(*) FROM audit WHERE action='fetch.retention' AND target LIKE 'deleted=2 %'").Scan(&audits)
	if audits != 1 {
		t.Fatal("retention sweep not audited with deleted count")
	}
	// The daily runner executes once and records a visible task.
	a.runFetchRetentionIfDue()
	var task Task
	if err := a.get("task", "fetch-retention-latest", &task); err != nil || task.Status != "success" || task.Kind != "fetch_retention" {
		t.Fatalf("retention task = %+v, err=%v", task, err)
	}
	a.runFetchRetentionIfDue() // same-day second call must be a no-op
	a.db.QueryRow("SELECT count(*) FROM audit WHERE action='fetch.retention'").Scan(&audits)
	if audits != 2 {
		t.Fatalf("retention ran %d times, want 2 (explicit + once daily)", audits)
	}
}
func TestReusableTemplatesAndReferences(t *testing.T) {
	a := testApp(t)
	n, _, p := fixture(t, a)
	tpl := builtinTemplates()[1]
	tpl.ID = "custom"
	tpl.Builtin = false
	if request(a, "PUT", "/api/admin/rule-templates/custom", tpl, true).Code != 200 {
		t.Fatal("custom template save")
	}
	p.TemplateID = tpl.ID
	p.Rules = []string{"DOMAIN,example.test,DIRECT", "MATCH,REJECT"}
	if w := request(a, "PUT", "/api/admin/profile/"+p.ID, p, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	out, err := a.render(p)
	s := string(out)
	if err != nil || !strings.Contains(s, "rule-providers:") || !strings.Contains(s, "redir-host") || strings.Count(s, "MATCH,") != 1 || strings.Index(s, "example.test") > strings.Index(s, "RULE-SET,private") || !strings.Contains(s, "MATCH,REJECT") {
		t.Fatal("template composition")
	}
	n.Name = "AI"
	a.put("node", n.ID, n)
	out, err = a.render(p)
	if err == nil {
		t.Fatal("group collision")
	}
	if request(a, "DELETE", "/api/admin/rule-templates/custom", nil, true).Code != 409 {
		t.Fatal("referenced template deleted")
	}
	if request(a, "PUT", "/api/admin/rule-templates/smart-v1", tpl, true).Code != 409 {
		t.Fatal("builtin modified")
	}
	for _, rule := range []string{"RULE-SET,missing,DIRECT", "DOMAIN,x,missing", "MATCH,AI", "DOMAIN,x,DIRECT\nMATCH,REJECT", "IP-CIDR,x"} {
		if validateRuleTemplate(RuleTemplate{ID: "test", Name: "test", Rules: []string{rule}}) == nil {
			t.Fatal("invalid rule accepted")
		}
	}
	if request(a, "GET", "/api/admin/rule-templates", nil, false).Code != 401 {
		t.Fatal("template auth")
	}
}
func TestCycleTemplateBackupRoundTrip(t *testing.T) {
	a := testApp(t)
	_, m, p := fixture(t, a)
	m.ResetDay = 31
	advanceCycle(&m, time.Now())
	m.Used += 2
	a.put("member", m.ID, m)
	tpl := builtinTemplates()[1]
	tpl.ID = "custom"
	tpl.Builtin = false
	a.put("rule_template", tpl.ID, tpl)
	p.TemplateID = tpl.ID
	a.put("profile", p.ID, p)
	a.recordFetch(httptest.NewRequest("GET", "/", nil), p, 200, "")
	snap, err := a.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	b := testApp(t)
	if err = b.restoreSnapshot(snap); err != nil {
		t.Fatal(err)
	}
	var restored Member
	b.get("member", m.ID, &restored)
	if !validCycle(restored) || memberQuotaUsed(restored) != 2 {
		t.Fatal("cycle backup lost")
	}
	var profile Profile
	b.get("profile", p.ID, &profile)
	if _, err = b.render(profile); err != nil {
		t.Fatal("template backup lost")
	}
	for i, r := range snap.Records {
		if r.Kind == "member" {
			m.CycleEnd = "invalid"
			snap.Records[i].Body, _ = json.Marshal(m)
		}
	}
	if b.restoreSnapshot(snap) == nil {
		t.Fatal("invalid cycle backup accepted")
	}
	var count int
	b.db.QueryRow("SELECT count(*) FROM subscription_fetches").Scan(&count)
	if count != 0 {
		t.Fatal("audit copied")
	}
}
func TestProtocolGuardsAndCredentialStaleness(t *testing.T) {
	a := testApp(t)
	n, _, _ := fixture(t, a)
	path := "/api/admin/nodes/" + n.ID + "/test"
	if request(a, "POST", path, map[string]string{"mode": "latency"}, false).Code != 401 {
		t.Fatal("protocol auth")
	}
	n.ServerID = "aws-ec2-tpe"
	a.put("node", n.ID, n)
	if request(a, "POST", path, map[string]string{"mode": "download"}, true).Code != 400 {
		t.Fatal("retired download sampling accepted")
	}
	if request(a, "POST", path, map[string]string{"mode": "latency", "memberId": "other"}, true).Code != 400 {
		t.Fatal("unassigned identity")
	}
	a.protocolWork <- struct{}{}
	if request(a, "POST", path, map[string]string{"mode": "latency"}, true).Code != 409 {
		t.Fatal("concurrency cap")
	}
	<-a.protocolWork
	v := ProtocolResult{NodeID: n.ID, State: "verified", ConfigHash: a.protocolIdentityHash(n, "")}
	a.put("node_test", n.ID, v)
	a.secret("node_secret", n.ID, token())
	if a.protocolResults()[n.ID].State != "stale" {
		t.Fatal("credential change not invalidated")
	}
	v.ConfigHash = a.protocolIdentityHash(n, "")
	v.State = "running"
	v.CheckedAt = time.Now().Add(-2 * time.Minute).Format(time.RFC3339)
	a.put("node_test", n.ID, v)
	if a.protocolResults()[n.ID].State != "interrupted" {
		t.Fatal("interrupted job stuck")
	}
	if strings.Contains(request(a, "GET", "/api/admin/overview", nil, true).Body.String(), v.ConfigHash) {
		t.Fatal("internal hash exposed")
	}
}
func TestProtocolManagedIdentityOverSocket(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Linux deployment socket test")
	}
	a, _, n, m := setupManaged(t)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	secret, _ := a.managedCredential(m, n)
	a.probeSocket = filepath.Join(t.TempDir(), "p.sock")
	listener, err := net.Listen("unix", a.probeSocket)
	if err != nil {
		t.Fatal(err)
	}
	seen := make(chan protocolRequest, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in protocolRequest
		json.NewDecoder(r.Body).Decode(&in)
		seen <- in
		writeJSON(w, 200, ProtocolResult{State: "verified", LatencyMS: 12})
	})}
	defer srv.Close()
	go srv.Serve(listener)
	if w := request(a, "POST", "/api/admin/nodes/"+n.ID+"/test", map[string]string{"mode": "latency", "memberId": m.ID}, true); w.Code != 202 {
		t.Fatal(w.Code)
	}
	select {
	case in := <-seen:
		if in.Node.Credential != secret {
			t.Fatal("wrong credential sent")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("worker request missing")
	}
	deadline := time.Now().Add(3 * time.Second)
	for len(a.protocolWork) > 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if result := a.protocolResults()[n.ID]; result.State != "verified" || result.LatencyMS != 12 || result.MemberID != m.ID {
		t.Fatal("result not persisted")
	}
}
func TestSmartTemplateInstalledEngine(t *testing.T) {
	core := os.Getenv("SUBHUB_TEST_MIHOMO")
	if core == "" {
		t.Skip("engine validation runs on VPS")
	}
	a := testApp(t)
	_, _, p := fixture(t, a)
	p.TemplateID = "smart-v1"
	a.secret("node_secret", "node-a", uuid())
	out, err := a.render(p)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "config.yaml")
	os.WriteFile(file, out, 0600)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, core, "-t", "-d", dir, "-f", file)
	if err = cmd.Run(); err != nil {
		t.Fatal("installed engine rejected smart template")
	}
}
