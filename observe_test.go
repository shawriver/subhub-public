package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// mockPanel is a call-logging 3x-ui v3 stand-in for observe-mode tests:
// it records every request so tests can prove that observe mode issues
// zero mutating calls, and that execute mode maps quota/expiry onto the
// client payload exactly.
type mockPanel struct {
	mu      sync.Mutex
	clients map[string]remoteClient
	token   string
	calls   []string
	server  *httptest.Server
}

func newMockPanel(t *testing.T) *mockPanel {
	f := &mockPanel{clients: map[string]remoteClient{}, token: token()}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer "+f.token {
			w.WriteHeader(401)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/panel/api/")
		f.calls = append(f.calls, r.Method+" "+path)
		var obj any
		switch {
		case path == "inbounds/list":
			obj = []remoteInbound{{ID: 7, Remark: "Managed test", Protocol: "vless", Port: 443, Enable: true, Stream: json.RawMessage(`{"network":"tcp","security":"tls","tlsSettings":{"serverName":"node.example.test"}}`)}}
		case path == "clients/list":
			rows := []remoteClient{}
			for _, c := range f.clients {
				rows = append(rows, c)
			}
			obj = rows
		case path == "clients/add" || strings.HasPrefix(path, "clients/update/"):
			var payload map[string]json.RawMessage
			json.NewDecoder(r.Body).Decode(&payload)
			var client map[string]json.RawMessage
			ids := []int{7}
			if path == "clients/add" {
				json.Unmarshal(payload["client"], &client)
				json.Unmarshal(payload["inboundIds"], &ids)
			} else {
				client = payload
			}
			var c remoteClient
			b, _ := json.Marshal(client)
			json.Unmarshal(b, &c)
			json.Unmarshal(client["id"], &c.UUID)
			old := f.clients[c.Email]
			c.Inbounds = ids
			c.Traffic = old.Traffic
			f.clients[c.Email] = c
		case strings.HasPrefix(path, "clients/del/"):
			delete(f.clients, strings.TrimPrefix(path, "clients/del/"))
		default:
			w.WriteHeader(404)
			return
		}
		writeJSON(w, 200, map[string]any{"success": true, "obj": obj})
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *mockPanel) mutations() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []string{}
	for _, c := range f.calls {
		if strings.HasPrefix(c, "POST") {
			out = append(out, c)
		}
	}
	return out
}

func (f *mockPanel) seed(c remoteClient) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.clients[c.Email] = c
}

func (f *mockPanel) client(email string) (remoteClient, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.clients[email]
	return c, ok
}

func (f *mockPanel) setTraffic(email string, up, down int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.clients[email]
	c.Traffic = &struct {
		Up   int64 `json:"up"`
		Down int64 `json:"down"`
	}{Up: up, Down: down}
	f.clients[email] = c
}

// setupObservedPanel mirrors setupManaged but deliberately leaves the
// observe-mode setting untouched so tests start from the product
// default.
func setupObservedPanel(t *testing.T) (*App, *mockPanel, Node, Member) {
	t.Helper()
	a := testApp(t)
	f := newMockPanel(t)
	s := Server{ID: "srv", Name: "Server", Address: "node.example.test"}
	if err := a.put("server", s.ID, s); err != nil {
		t.Fatal(err)
	}
	p := PanelInput{Panel: Panel{ID: "panel-test", Name: "Panel", ServerID: s.ID, URL: f.server.URL}, Token: f.token}
	if err := a.savePanel(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if err := a.attachInbound(context.Background(), p.Panel, 7); err != nil {
		t.Fatal(err)
	}
	n := loadNodes(a)[0]
	m := Member{ID: "member-managed", Name: "Family", Enabled: true, NodeIDs: []string{n.ID}, Limit: 10}
	if err := a.put("member", m.ID, m); err != nil {
		t.Fatal(err)
	}
	return a, f, n, m
}

func loadGrant(t *testing.T, a *App, m Member, n Node) Grant {
	t.Helper()
	var g Grant
	if err := a.get("grant", grantID(m.ID, n.ID), &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func auditCount(a *App, action, target string) int {
	var n int
	if err := a.db.QueryRow("SELECT count(*) FROM audit WHERE action=? AND target=?", action, target).Scan(&n); err != nil {
		return -1
	}
	return n
}

// seedRemoteClient places a panel-side client that matches the grant's
// identity, as if an earlier execute-mode round had provisioned it.
func seedRemoteClient(t *testing.T, a *App, f *mockPanel, g Grant) {
	t.Helper()
	secret, err := a.readSecret("grant_secret", g.ID)
	if err != nil {
		t.Fatal(err)
	}
	f.seed(remoteClient{Email: g.Email, UUID: secret, Enable: true, Inbounds: []int{g.InboundID}})
}

func TestObserveModeDefaultsOnAndSettingsAPI(t *testing.T) {
	a := testApp(t)
	if !a.observeMode() {
		t.Fatal("fresh install must start in observe mode")
	}
	w := request(a, "GET", "/api/admin/sync-settings", nil, true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"observeMode":true`) {
		t.Fatalf("settings GET = %d %s", w.Code, w.Body.String())
	}
	w = request(a, "POST", "/api/admin/sync-settings", map[string]any{}, true)
	if w.Code != 400 {
		t.Fatalf("missing observeMode must be rejected, got %d", w.Code)
	}
	w = request(a, "POST", "/api/admin/sync-settings", map[string]any{"observeMode": false}, true)
	if w.Code != 200 || a.observeMode() {
		t.Fatalf("turning observe off failed: %d", w.Code)
	}
	if auditCount(a, "sync.observe.disable", "sync") != 1 {
		t.Fatal("turning observe off must be audited")
	}
	w = request(a, "POST", "/api/admin/sync-settings", map[string]any{"observeMode": true}, true)
	if w.Code != 200 || !a.observeMode() {
		t.Fatalf("turning observe back on failed: %d", w.Code)
	}
	if auditCount(a, "sync.observe.enable", "sync") != 1 {
		t.Fatal("turning observe on must be audited")
	}
}

func TestObserveModeZeroSideEffectsAndPullback(t *testing.T) {
	a, f, n, m := setupObservedPanel(t)
	if !a.observeMode() {
		t.Fatal("fixture must start in observe mode")
	}
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	g := loadGrant(t, a, m, n)
	if g.Observed != "add" || g.State == "active" {
		t.Fatalf("grant should record a pending add without executing it: %+v", g)
	}
	if got := f.mutations(); len(got) != 0 {
		t.Fatalf("observe mode issued mutating calls: %v", got)
	}
	if auditCount(a, "observe.grant.add", m.ID) != 1 {
		t.Fatal("would-be add must be audited once")
	}
	// A second identical round must not spam the audit log.
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if auditCount(a, "observe.grant.add", m.ID) != 1 {
		t.Fatal("unchanged pending action must not re-audit every round")
	}
	counts, _ := a.lastSyncRound()
	if counts["add"] != 1 {
		t.Fatalf("round summary should count the pending add: %v", counts)
	}
	// The client appears on the panel (provisioned elsewhere): the
	// pending action becomes an update, and traffic pull-back still runs
	// because it is read-only.
	seedRemoteClient(t, a, f, g)
	f.setTraffic(g.Email, 2_000_000_000, 1_000_000_000)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	g = loadGrant(t, a, m, n)
	if g.Observed != "update" {
		t.Fatalf("existing client should pend an update, got %q", g.Observed)
	}
	var member Member
	if err := a.get("member", m.ID, &member); err != nil {
		t.Fatal(err)
	}
	if member.Used != 3 {
		t.Fatalf("traffic pull-back must run in observe mode, used=%v", member.Used)
	}
	if got := f.mutations(); len(got) != 0 {
		t.Fatalf("observe mode issued mutating calls: %v", got)
	}
	// Same counters again: no double counting.
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := a.get("member", m.ID, &member); err != nil {
		t.Fatal(err)
	}
	if member.Used != 3 {
		t.Fatalf("traffic double counted in observe mode, used=%v", member.Used)
	}
	// Counter rollback (panel reset/rebuilt client): the negative delta
	// is treated as the counter's new value, same as execute mode.
	f.setTraffic(g.Email, 500_000_000, 1_000_000_000)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := a.get("member", m.ID, &member); err != nil {
		t.Fatal(err)
	}
	if member.Used != 3.5 {
		t.Fatalf("counter rollback mishandled, used=%v", member.Used)
	}
	if got := f.mutations(); len(got) != 0 {
		t.Fatalf("observe mode issued mutating calls: %v", got)
	}
}

func TestObserveModeRevokeOnExpiry(t *testing.T) {
	a, f, n, m := setupObservedPanel(t)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	g := loadGrant(t, a, m, n)
	seedRemoteClient(t, a, f, g)
	var member Member
	if err := a.get("member", m.ID, &member); err != nil {
		t.Fatal(err)
	}
	member.Expires = "2020-01-01"
	if err := a.put("member", member.ID, member); err != nil {
		t.Fatal(err)
	}
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	g = loadGrant(t, a, m, n)
	if g.Observed != "revoke" {
		t.Fatalf("expired member should pend a revocation, got %q", g.Observed)
	}
	if got := f.mutations(); len(got) != 0 {
		t.Fatalf("observe mode must not delete the client: %v", got)
	}
	if _, ok := f.client(g.Email); !ok {
		t.Fatal("client must still exist on the panel in observe mode")
	}
	if auditCount(a, "observe.grant.revoke", m.ID) != 1 {
		t.Fatal("would-be revocation must be audited")
	}
}

func TestObserveModeRevokeOnQuota(t *testing.T) {
	a, f, n, m := setupObservedPanel(t)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	g := loadGrant(t, a, m, n)
	seedRemoteClient(t, a, f, g)
	// 12 GB of panel counters against a 10 GB limit: the same round that
	// pulls the traffic back must already judge the member over quota.
	f.setTraffic(g.Email, 7_000_000_000, 5_000_000_000)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	var member Member
	if err := a.get("member", m.ID, &member); err != nil {
		t.Fatal(err)
	}
	if member.Used != 12 {
		t.Fatalf("pull-back expected 12 GB, got %v", member.Used)
	}
	g = loadGrant(t, a, m, n)
	if g.Observed != "revoke" {
		t.Fatalf("over-quota member should pend a revocation, got %q", g.Observed)
	}
	if got := f.mutations(); len(got) != 0 {
		t.Fatalf("observe mode issued mutating calls: %v", got)
	}
}

func TestExecuteModePayloadMappingAndDelete(t *testing.T) {
	a, f, n, m := setupObservedPanel(t)
	if err := a.setObserveMode(false); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	g := loadGrant(t, a, m, n)
	if g.State != "active" || g.Observed != "" {
		t.Fatalf("execute mode must provision for real: %+v", g)
	}
	muts := f.mutations()
	if len(muts) != 1 || muts[0] != "POST clients/add" {
		t.Fatalf("expected exactly one clients/add, got %v", muts)
	}
	c, ok := f.client(g.Email)
	if !ok {
		t.Fatal("client not created on the panel")
	}
	if !c.Enable {
		t.Fatal("provisioned client must be enabled")
	}
	if c.Total != 10_000_000_000 {
		t.Fatalf("totalGB must equal the full remaining quota in bytes, got %d", c.Total)
	}
	if c.Expiry < start.Add(2*time.Minute).UnixMilli() || c.Expiry > time.Now().Add(4*time.Minute).UnixMilli() {
		t.Fatalf("expiryTime must be the ~3 minute lease in ms, got %d", c.Expiry)
	}
	// Traffic accrues; the renewal update caps totalGB at
	// remaining quota + the client's own cumulative counter (= 10 GB
	// again here), and pull-back lands on the member.
	f.setTraffic(g.Email, 2_000_000_000, 1_000_000_000)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	var member Member
	if err := a.get("member", m.ID, &member); err != nil {
		t.Fatal(err)
	}
	if member.Used != 3 {
		t.Fatalf("pull-back expected 3 GB, got %v", member.Used)
	}
	c, _ = f.client(g.Email)
	if c.Total != 10_000_000_000 {
		t.Fatalf("renewal totalGB = remaining + remote cumulative, got %d", c.Total)
	}
	muts = f.mutations()
	if len(muts) != 2 || muts[1] != "POST clients/update/"+g.Email {
		t.Fatalf("expected a clients/update renewal, got %v", muts)
	}
	// Disabling the member revokes for real in execute mode.
	member.Enabled = false
	if err := a.put("member", member.ID, member); err != nil {
		t.Fatal(err)
	}
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.client(g.Email); ok {
		t.Fatal("revoked client must be deleted from the panel")
	}
	muts = f.mutations()
	if len(muts) != 3 || muts[2] != "POST clients/del/"+g.Email {
		t.Fatalf("expected a clients/del revocation, got %v", muts)
	}
	g = loadGrant(t, a, m, n)
	if g.State != "revoked" {
		t.Fatalf("grant must be revoked, got %q", g.State)
	}
}
