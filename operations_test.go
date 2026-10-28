package main

import (
	"context"
	"encoding/json"
	"errors"
	"golang.org/x/crypto/bcrypt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakePanel struct {
	mu      sync.Mutex
	clients map[string]remoteClient
	token   string
	fail    bool
	server  *httptest.Server
}

func newFakePanel(t *testing.T) *fakePanel {
	f := &fakePanel{clients: map[string]remoteClient{}, token: token()}
	f.clients["existing-owner"] = remoteClient{Email: "existing-owner", UUID: uuid(), Enable: true, Inbounds: []int{7}}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer "+f.token {
			w.WriteHeader(401)
			return
		}
		if f.fail {
			w.WriteHeader(503)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/panel/api/")
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
		case path == "server/status":
			obj = map[string]any{"cpu": 12.5, "mem": map[string]int{"current": 2, "total": 4}, "disk": map[string]int{"current": 1, "total": 5}}
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
			old, exists := f.clients[c.Email]
			if path == "clients/add" && exists {
				writeJSON(w, 200, map[string]any{"success": false})
				return
			}
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
func setupManaged(t *testing.T) (*App, *fakePanel, Node, Member) {
	t.Helper()
	a := testApp(t)
	f := newFakePanel(t)
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
	a.put("member", m.ID, m)
	// The lifecycle tests exercise the real execution path against the
	// fake panel. Observe mode (the product default for a fresh install)
	// is covered separately in observe_test.go.
	if err := a.setObserveMode(false); err != nil {
		t.Fatal(err)
	}
	return a, f, n, m
}
func TestManagedGrantLifecycleAndIsolation(t *testing.T) {
	a, f, n, m := setupManaged(t)
	m2 := m
	m2.ID = "member-other"
	m2.Name = "Other"
	a.put("member", m2.ID, m2)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	s1, err := a.managedCredential(m, n)
	if err != nil {
		t.Fatal(err)
	}
	s2, err := a.managedCredential(m2, n)
	if err != nil || s1 == s2 {
		t.Fatal("member credentials not independent")
	}
	if len(f.clients) != 3 {
		t.Fatal("remote grant count")
	}
	p := Profile{ID: "profile-managed", Name: "Test", MemberID: m.ID, NodeIDs: []string{n.ID}, Format: "clash"}
	a.put("profile", p.ID, p)
	body, err := a.render(p)
	if err != nil || !strings.Contains(string(body), s1) || strings.Contains(string(body), s2) {
		t.Fatal("wrong member exported")
	}
	if strings.Contains(request(a, "GET", "/api/admin/overview", nil, true).Body.String(), s1) {
		t.Fatal("list leaked grant secret")
	}
	m.Enabled = false
	a.put("member", m.ID, m)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.clients) != 2 || f.clients["existing-owner"].UUID == "" {
		t.Fatal("revocation affected other client")
	}
	if _, err = a.managedCredential(m, n); err == nil {
		t.Fatal("revoked credential export")
	}
	var g Grant
	a.get("grant", grantID(m.ID, n.ID), &g)
	if g.State != "revoked" {
		t.Fatal("revocation not persisted")
	}
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal("repeat revoke not idempotent")
	}
}
func TestSyncFailureLeaseQuotaAndCounters(t *testing.T) {
	a, f, n, m := setupManaged(t)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	var g Grant
	a.get("grant", grantID(m.ID, n.ID), &g)
	if g.Lease-time.Now().Unix() > 181 || g.Lease-time.Now().Unix() < 175 {
		t.Fatal("lease bounds")
	}
	c := f.clients[g.Email]
	c.Traffic = &struct {
		Up   int64 `json:"up"`
		Down int64 `json:"down"`
	}{Up: 2_000_000_000, Down: 3_000_000_000}
	f.clients[g.Email] = c
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.get("member", m.ID, &m)
	if m.Used != 5 {
		t.Fatal("actual traffic not collected")
	}
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.get("member", m.ID, &m)
	if m.Used != 5 {
		t.Fatal("double counted")
	}
	m.Limit = 4
	a.put("member", m.ID, m)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := f.clients[g.Email]; ok {
		t.Fatal("quota didn't revoke")
	}
	m.Limit = 10
	a.put("member", m.ID, m)
	f.fail = true
	if err := a.syncAll(context.Background()); err == nil {
		t.Fatal("remote error hidden")
	}
	a.get("grant", g.ID, &g)
	if g.State != "error" {
		t.Fatal("failure not persisted")
	}
	f.fail = false
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := a.managedCredential(m, n); err != nil {
		t.Fatal("retry failed")
	}
}
func TestForeignIdentityConflictAndManagedValidation(t *testing.T) {
	a, f, n, m := setupManaged(t)
	a.syncAll(context.Background())
	var g Grant
	a.get("grant", grantID(m.ID, n.ID), &g)
	c := f.clients[g.Email]
	c.UUID = uuid()
	f.clients[g.Email] = c
	m.Enabled = false
	a.put("member", m.ID, m)
	if err := a.syncAll(context.Background()); err == nil {
		t.Fatal("identity conflict ignored")
	}
	if f.clients[g.Email].UUID != c.UUID {
		t.Fatal("foreign identity modified")
	}
	n.PanelID = "another"
	if request(a, "PUT", "/api/admin/node/"+n.ID, n, true).Code != 400 {
		t.Fatal("binding editable")
	}
	for _, u := range []string{"http://example.com", "https://user:pass@example.com", "http://169.254.169.254", "https://example.com?token=foo"} {
		if validPanelURL(u) == nil {
			t.Fatal("bad URL accepted")
		}
	}
}
func TestEncryptedBackupRoundTripAndTampering(t *testing.T) {
	a := testApp(t)
	fixture(t, a)
	pass := token()
	snap, err := a.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := sealBackup(snap, pass)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(encoded, "Family") {
		t.Fatal("plaintext backup")
	}
	decoded, err := openBackup(encoded, pass)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = openBackup(encoded, token()); err == nil {
		t.Fatal("wrong password accepted")
	}
	changed := encoded[:len(encoded)-8] + "AAAAAAAA"
	if _, err = openBackup(changed, pass); err == nil {
		t.Fatal("tampered backup accepted")
	}
	b := testApp(t)
	if err = b.restoreSnapshot(decoded); err != nil {
		t.Fatal(err)
	}
	if len(b.list("member")) != 1 || len(b.list("node")) != 1 {
		t.Fatal("records lost")
	}
	n := loadNodes(b)[0]
	if _, err = b.readSecret("node_secret", n.ID); err != nil {
		t.Fatal("secrets not reencrypted")
	}
	if err = a.automaticBackup(true); err != nil || len(a.backupFiles()) != 1 {
		t.Fatal("automatic backup failed")
	}
}

func TestBackupTaskClearsAfterSuccess(t *testing.T) {
	a := testApp(t)
	a.recordBackupTask(errors.New("disk full"))
	var task Task
	if a.get("task", "backup-latest", &task) != nil || task.Status != "failed" {
		t.Fatalf("failed backup did not raise a task: %+v", task)
	}
	a.recordBackupTask(nil)
	if a.get("task", "backup-latest", &task) != nil || task.Status != "success" {
		t.Fatalf("successful backup did not clear the failure: %+v", task)
	}
	created := task.Created
	a.recordBackupTask(nil)
	if a.get("task", "backup-latest", &task) != nil || task.Created != created {
		t.Fatal("unchanged success state was rewritten")
	}
}

func TestBackupRestoreKeepsRevocationTombstone(t *testing.T) {
	a, f, n, m := setupManaged(t)
	snap, err := a.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if err = a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = a.restoreSnapshot(snap); err != nil {
		t.Fatal(err)
	}
	var g Grant
	if a.get("grant", grantID(m.ID, n.ID), &g) != nil || !g.Retired {
		t.Fatal("forgot remote identity")
	}
	if err = a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.clients) != 1 {
		t.Fatal("orphan identity not revoked")
	}
	if err = a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err = a.managedCredential(m, n); err != nil || len(f.clients) != 2 {
		t.Fatal("restored assignment was permanently retired")
	}
	var restored Grant
	a.get("grant", g.ID, &restored)
	if restored.Retired {
		t.Fatal("restored assignment remains retired")
	}
	// Restoring a snapshot without the member must never recreate its grant.
	kept := []backupRecord{}
	for _, r := range snap.Records {
		if r.Kind != "member" {
			kept = append(kept, r)
		}
	}
	snap.Records = kept
	if err = a.restoreSnapshot(snap); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err = a.syncAll(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if len(f.clients) != 1 {
		t.Fatal("removed member regained authorization")
	}
}
func TestTOTPAndAccountSecurity(t *testing.T) {
	if got := totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1); got != "287082" {
		t.Fatal("RFC vector failed", got)
	}
	a := testApp(t)
	pass := token()
	h, _ := bcrypt.GenerateFromPassword([]byte(pass), bcrypt.MinCost)
	a.db.Exec("INSERT INTO admin VALUES('admin',?)", h)
	secret := "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
	a.secret("security", "totp", secret)
	if a.verifyOTP("wrong") {
		t.Fatal("invalid OTP accepted")
	}
	code := totp(secret, time.Now().Unix()/30)
	if !a.verifyOTP(code) || a.verifyOTP(code) {
		t.Fatal("OTP replay accepted")
	}
	w := request(a, "POST", "/api/login", map[string]string{"username": "admin", "password": pass}, false)
	if w.Code != 401 {
		t.Fatal("missing OTP login accepted")
	}
	a.db.Exec("DELETE FROM auth_counter")
	w = request(a, "POST", "/api/login", map[string]string{"username": "admin", "password": pass, "code": code}, false)
	if w.Code != 200 {
		t.Fatal("OTP login failed", w.Code)
	}
}
func TestBackupFailureRollsBackRecords(t *testing.T) {
	a := testApp(t)
	fixture(t, a)
	snap, _ := a.snapshot()
	a.db.Exec("CREATE TRIGGER deny_restore BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT,'test'); END")
	if err := a.restoreSnapshot(snap); err == nil {
		t.Fatal("expected restore failure")
	}
	if len(a.list("member")) != 1 {
		t.Fatal("failed restore erased records")
	}
}
func TestRetiredHostAgentAndTaskGate(t *testing.T) {
	a := testApp(t)
	if w := request(a, "POST", "/api/admin/host-actions", map[string]string{"action": "host-reboot"}, true); w.Code != 410 {
		t.Fatal("retired operation accepted")
	}
	if w := request(a, "POST", "/api/agent/old", map[string]string{}, false); w.Code != 410 {
		t.Fatal("retired agent accepted")
	}
	if w := request(a, "POST", "/api/admin/task/new", Task{ID: "bypass", Kind: "host-reboot", Status: "queued"}, true); w.Code != 400 {
		t.Fatal("generic task bypass")
	}
}
