package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testApp(t *testing.T) *App {
	t.Helper()
	a, err := newApp(t.TempDir(), "https://subhub.example.test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.db.Close() })
	return a
}

func request(a *App, method, path string, body any, admin bool) *httptest.ResponseRecorder {
	var content string
	if body != nil {
		b, _ := json.Marshal(body)
		content = string(b)
	}
	r := httptest.NewRequest(method, path, strings.NewReader(content))
	r.RemoteAddr = "192.0.2.7:2000"
	r.Header.Set("X-SubHub-Request", "1")
	if admin {
		// Test-only random session, never log it.
		session := token()
		a.db.Exec("INSERT INTO sessions VALUES(?,?)", hash(session), time.Now().Add(time.Hour).Unix())
		r.AddCookie(&http.Cookie{Name: "subhub_session", Value: session})
	}
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}

func fixture(t *testing.T, a *App) (Node, Member, Profile) {
	t.Helper()
	node := Node{ID: "node-a", Name: "Test VLESS", Protocol: "VLESS", Host: "2001:db8::1", Port: 443, Enabled: true, Security: "none", Transport: "tcp"}
	member := Member{ID: "member-a", Name: "Family", Enabled: true, Limit: 20, Used: 1.5, NodeIDs: []string{node.ID}}
	profile := Profile{ID: "profile-a", Name: "Family profile", MemberID: member.ID, Format: "clash", NodeIDs: []string{node.ID}}
	for _, v := range []struct {
		kind, id string
		value    any
	}{{"node", node.ID, node}, {"member", member.ID, member}, {"profile", profile.ID, profile}} {
		if err := a.put(v.kind, v.id, v.value); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.secret("node_secret", node.ID, token()); err != nil {
		t.Fatal(err)
	}
	return node, member, profile
}

func TestInvalidRecordsDoNotWrite(t *testing.T) {
	a := testApp(t)
	node, _, _ := fixture(t, a)
	for _, tc := range []struct {
		name, kind string
		body       any
	}{
		{"server name", "server", Server{Name: "  "}},
		{"node port", "node", Node{Name: "Bad", Host: "example.test", Port: 70000, Protocol: "VLESS", Credential: token()}},
		{"unsupported protocol", "node", Node{Name: "Bad", Host: "example.test", Port: 443, Protocol: "Shadowsocks", Credential: token()}},
		{"invalid date", "member", Member{Name: "Bad", Expires: "not-a-date"}},
		{"negative quota", "member", Member{Name: "Bad", Limit: -1}},
		{"negative usage", "member", Member{Name: "Bad", Used: -1}},
		{"ID mismatch", "member", Member{ID: "different", Name: "Bad"}},
		{"missing node", "member", Member{Name: "Bad", NodeIDs: []string{"absent"}}},
		{"unsupported format", "profile", Profile{Name: "Bad", Format: "invalid"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := request(a, "PUT", "/api/admin/"+tc.kind+"/bad", tc.body, true)
			if w.Code != 400 {
				t.Fatalf("status=%d", w.Code)
			}
			var count int
			a.db.QueryRow("SELECT count(*) FROM records WHERE id='bad' OR id='different'").Scan(&count)
			if count != 0 {
				t.Fatal("invalid record persisted")
			}
			a.db.QueryRow("SELECT count(*) FROM secrets WHERE id='bad'").Scan(&count)
			if count != 0 {
				t.Fatal("invalid credential persisted")
			}
		})
	}
	before, _ := a.readSecret("node_secret", node.ID)
	node.Port = -1
	node.Credential = token()
	if w := request(a, "PUT", "/api/admin/node/"+node.ID, node, true); w.Code != 400 {
		t.Fatal(w.Code)
	}
	after, _ := a.readSecret("node_secret", node.ID)
	if before != after {
		t.Fatal("invalid edit replaced working credential")
	}
}

func TestCredentialAndRecordCommitTogether(t *testing.T) {
	a := testApp(t)
	node, _, _ := fixture(t, a)
	before, _ := a.readSecret("node_secret", node.ID)
	_, err := a.db.Exec("CREATE TRIGGER deny_record_update BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT, 'test failure'); END")
	if err != nil {
		t.Fatal(err)
	}
	node.Credential = token()
	if w := request(a, "PUT", "/api/admin/node/"+node.ID, node, true); w.Code < 400 {
		t.Fatal("save unexpectedly succeeded")
	}
	after, _ := a.readSecret("node_secret", node.ID)
	if before != after {
		t.Fatal("failed record save changed credential")
	}
}

func issuedPath(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("issue status=%d", w.Code)
	}
	var result map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(result["url"])
	if err != nil {
		t.Fatal("invalid URL")
	}
	return u.RequestURI()
}

func TestSubscriptionRotationAndMemberIsolation(t *testing.T) {
	a := testApp(t)
	node, member, profile := fixture(t, a)
	path := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+profile.ID, nil, true))
	if w := request(a, "GET", path, nil, false); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := request(a, "POST", "/api/admin/subscriptions/"+profile.ID, nil, true); w.Code != 409 {
		t.Fatal("implicit rotation allowed")
	}
	if w := request(a, "GET", path, nil, false); w.Code != 200 {
		t.Fatal("old link lost")
	}
	if w := request(a, "POST", "/api/admin/subscriptions/"+profile.ID, map[string]any{"rotate": true, "format": "unknown"}, true); w.Code != 409 {
		t.Fatal("invalid format accepted")
	}
	if w := request(a, "GET", path, nil, false); w.Code != 200 {
		t.Fatal("failed preflight revoked existing link")
	}
	a.db.Exec("CREATE TRIGGER deny_token_insert BEFORE INSERT ON access_tokens BEGIN SELECT RAISE(ABORT, 'test failure'); END")
	if w := request(a, "POST", "/api/admin/subscriptions/"+profile.ID, map[string]any{"rotate": true}, true); w.Code != 500 {
		t.Fatal(w.Code)
	}
	if w := request(a, "GET", path, nil, false); w.Code != 200 {
		t.Fatal("failed rotation lost old link")
	}
	a.db.Exec("DROP TRIGGER deny_token_insert")
	newPath := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+profile.ID, map[string]any{"rotate": true, "format": "v2ray"}, true))
	if !strings.HasSuffix(newPath, "format=v2ray") {
		t.Fatal("requested format ignored")
	}
	if w := request(a, "GET", path, nil, false); w.Code != 404 {
		t.Fatal("old link still valid")
	}
	second := member
	second.ID = "member-b"
	secondProfile := profile
	secondProfile.ID = "profile-b"
	secondProfile.MemberID = second.ID
	a.put("member", second.ID, second)
	a.put("profile", secondProfile.ID, secondProfile)
	secondPath := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+secondProfile.ID, nil, true))
	member.Enabled = false
	a.put("member", member.ID, member)
	if w := request(a, "GET", newPath, nil, false); w.Code != 404 {
		t.Fatal("disabled member can download")
	}
	if w := request(a, "GET", secondPath, nil, false); w.Code != 200 {
		t.Fatal("other member affected")
	}
	member.Enabled = true
	member.Expires = "2020-01-01"
	a.put("member", member.ID, member)
	if w := request(a, "GET", newPath, nil, false); w.Code != 410 {
		t.Fatal("expired member can download")
	}
	member.Expires = ""
	member.Used = member.Limit
	a.put("member", member.ID, member)
	if w := request(a, "GET", newPath, nil, false); w.Code != 410 {
		t.Fatal("quota not enforced")
	}
	member.Used = 0
	member.NodeIDs = []string{}
	a.put("member", member.ID, member)
	if w := request(a, "GET", newPath, nil, false); w.Code != 409 {
		t.Fatal("removed node still exported")
	}
	overview := request(a, "GET", "/api/admin/overview", nil, true)
	secret, _ := a.readSecret("node_secret", node.ID)
	if strings.Contains(overview.Body.String(), secret) {
		t.Fatal("credential leaked in overview")
	}
	// Tokens cannot survive deleting and recreating the same owner.
	if w := request(a, "DELETE", "/api/admin/member/"+second.ID, nil, true); w.Code != 409 {
		t.Fatal("referenced owner deleted")
	}
	secondProfile.MemberID = member.ID
	if w := request(a, "PUT", "/api/admin/profile/"+secondProfile.ID, secondProfile, true); w.Code != 400 {
		t.Fatal("subscription reassigned to another owner")
	}
}

func TestExpiryUnitsAndHeaders(t *testing.T) {
	a := testApp(t)
	_, m, p := fixture(t, a)
	m.Expires = "2035-10-17"
	a.put("member", m.ID, m)
	exp, err := memberExpiry(m.Expires)
	if err != nil {
		t.Fatal(err)
	}
	if exp.UTC().Format(time.RFC3339) != "2035-10-17T16:00:00Z" {
		t.Fatal("expiry does not include Shanghai calendar day")
	}
	if err := checkMember(m, exp.Add(-time.Nanosecond)); err != nil {
		t.Fatal(err)
	}
	if err := checkMember(m, exp); err == nil {
		t.Fatal("expiry boundary accepted")
	}
	m.Expires = "invalid"
	if checkMember(m, time.Now()) == nil {
		t.Fatal("invalid date fails open")
	}
	path := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	w := request(a, "GET", path, nil, false)
	info := w.Header().Get("Subscription-Userinfo")
	if !strings.Contains(info, "download=1500000000; total=20000000000; expire=") {
		t.Fatalf("wrong quota units: %s", info)
	}
	if portal := w.Header().Get("Profile-Web-Page-Url"); !strings.Contains(portal, "/me/") {
		t.Fatalf("missing member portal URL: %s", portal)
	}
	for _, path := range []string{path, "/sub/invalid", "/api/admin/overview"} {
		w := request(a, "GET", path, nil, false)
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("private/error response cacheable")
		}
	}
}

func TestExportEscapingTransportAndIPv6(t *testing.T) {
	credential := token() + "@: /?"
	nodes := []Node{
		{Name: "Name ' \"\nproxies: evil", Protocol: "VLESS", Host: "2001:db8::3", Port: 443, Credential: credential, Transport: "tcp", Security: "none"},
		{Name: "Trojan WS", Protocol: "Trojan", Host: "example.test", Port: 443, Credential: credential, Transport: "ws", Security: "tls", Path: "/a'\"\\\n", WSHost: "ws.example.test", SNI: "tls.example.test", ALPN: "h2, http/1.1"},
		{Name: "Hysteria2", Protocol: "Hysteria2", Host: "2001:db8::4", Port: 443, Credential: credential, Transport: "udp", Security: "tls"},
		{Name: "Reality", Protocol: "VLESS", Host: "example.test", Port: 443, Credential: credential, Transport: "tcp", Security: "reality", PublicKey: "test-public-key", Flow: "xtls-rprx-vision"},
	}
	config := string(renderClash(nodes, []string{"MATCH,节点选择\nproxies: evil"}))
	var parsed []map[string]any
	inProxies := false
	for _, line := range strings.Split(config, "\n") {
		if line == "proxies:" {
			inProxies = true
			continue
		}
		if line == "proxy-groups:" {
			break
		}
		if inProxies {
			var p map[string]any
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "  - ")), &p); err != nil {
				t.Fatal("invalid YAML flow value")
			}
			parsed = append(parsed, p)
		}
	}
	if len(parsed) != len(nodes) || parsed[0]["name"] != nodes[0].Name || parsed[0]["uuid"] != credential {
		t.Fatal("scalar escaping changed data")
	}
	if parsed[0]["tls"] != false || parsed[3]["tls"] != true {
		t.Fatal("TLS mode lost")
	}
	ws := parsed[1]["ws-opts"].(map[string]any)
	if ws["path"] != nodes[1].Path || ws["headers"].(map[string]any)["Host"] != nodes[1].WSHost {
		t.Fatal("Trojan WebSocket parameters lost")
	}
	if len(parsed[1]["alpn"].([]any)) != 2 {
		t.Fatal("ALPN is not a list")
	}
	if strings.Count(config, "\nproxies:") != 1 {
		t.Fatal("YAML injection")
	}
	for i, line := range v2rayLines(nodes) {
		u, err := url.Parse(line)
		if err != nil {
			t.Fatal("invalid node URI")
		}
		if u.Hostname() != nodes[i].Host || u.Port() != "443" || u.User.Username() != credential || u.Fragment != nodes[i].Name {
			t.Fatal("URI escaping/IPv6 round trip failed")
		}
		if i == 1 && (u.Query().Get("path") != nodes[i].Path || u.Query().Get("type") != "ws") {
			t.Fatal("URI WebSocket parameters lost")
		}
	}
	a := testApp(t)
	_, _, p := fixture(t, a)
	p.Format = "v2ray"
	out, err := a.render(p)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(string(out))
	if err != nil || !strings.HasPrefix(string(raw), "vless://") {
		t.Fatal("bad V2Ray envelope")
	}
}

func TestLoginRateLimitConcurrentAndProxy(t *testing.T) {
	a := testApp(t)
	at := time.Now()
	var accepted atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 80; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if a.reserveLogin("192.0.2.1", at) {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 8 {
		t.Fatalf("concurrent accepted=%d", accepted.Load())
	}
	if !a.reserveLogin("192.0.2.2", at) {
		t.Fatal("different client blocked")
	}
	if !a.reserveLogin("192.0.2.1", at.Add(11*time.Minute)) {
		t.Fatal("limit did not expire")
	}
	for _, tc := range []struct{ remote, forwarded, want string }{
		{"127.0.0.1:1234", "198.51.100.1", "198.51.100.1"},
		{"127.0.0.1:1234", "192.0.2.1, 198.51.100.1", "198.51.100.1"},
		{"198.51.100.2:1234", "192.0.2.1", "198.51.100.2"},
	} {
		r := httptest.NewRequest("POST", "/api/login", nil)
		r.RemoteAddr = tc.remote
		r.Header.Set("X-Forwarded-For", tc.forwarded)
		if requestID(r) != tc.want {
			t.Fatal("incorrect proxy trust")
		}
	}
	for i := 0; i < 5000; i++ {
		a.reserveLogin(fmt.Sprint(i), at)
	}
	if len(a.attempts) > 4096 {
		t.Fatal("unbounded login memory")
	}
}

func TestSetupCannotCreateSecondAdmin(t *testing.T) {
	a := testApp(t)
	first, err := a.issueSetup()
	if err != nil {
		t.Fatal(err)
	}
	setup, err := a.issueSetup()
	if err != nil {
		t.Fatal(err)
	}
	password := token()
	if w := request(a, "POST", "/api/setup", map[string]string{"token": first, "password": password}, false); w.Code != 403 {
		t.Fatal("old setup token remains valid")
	}
	if w := request(a, "POST", "/api/setup", map[string]string{"token": setup, "password": strings.Repeat("a", 73)}, false); w.Code != 400 {
		t.Fatal("bcrypt length not validated")
	}
	if w := request(a, "POST", "/api/setup", map[string]string{"token": setup, "password": password}, false); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if _, err := a.issueSetup(); err == nil {
		t.Fatal("setup issued after initialization")
	}
	// Even a stale/manually injected token must not bypass the singleton check.
	stale := token()
	a.db.Exec("INSERT INTO setup VALUES(?,?)", hash(stale), time.Now().Add(time.Hour).Unix())
	if w := request(a, "POST", "/api/setup", map[string]string{"token": stale, "username": "second", "password": password}, false); w.Code != 409 {
		t.Fatal("second admin created")
	}
	w := request(a, "POST", "/api/login", map[string]string{"username": "admin", "password": password}, false)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatal("session cookie weakened")
	}
}

func TestMissingMasterKeyFailsClosed(t *testing.T) {
	dir := t.TempDir()
	a, err := newApp(dir, "http://localhost")
	if err != nil {
		t.Fatal(err)
	}
	a.db.Close()
	if err = os.Remove(filepath.Join(dir, "master.key")); err != nil {
		t.Fatal(err)
	}
	if reopened, err := newApp(dir, "http://localhost"); err == nil {
		reopened.db.Close()
		t.Fatal("replaced lost key")
	}
}

func TestStrictBodyAndAuth(t *testing.T) {
	a := testApp(t)
	if w := request(a, "GET", "/api/admin/overview", nil, false); w.Code != 401 {
		t.Fatal("admin auth missing")
	}
	r := httptest.NewRequest("PUT", "/", strings.NewReader("{\"name\":\"first\"} {\"name\":\"second\"}"))
	var server Server
	if decodeBody(r, &server) == nil {
		t.Fatal("trailing JSON accepted")
	}
}

func TestFailedDeleteKeepsWorkingSubscription(t *testing.T) {
	a := testApp(t)
	_, _, p := fixture(t, a)
	path := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	if _, err := a.db.Exec("CREATE TRIGGER deny_delete BEFORE DELETE ON records BEGIN SELECT RAISE(ABORT, 'test failure'); END"); err != nil {
		t.Fatal(err)
	}
	if w := request(a, "DELETE", "/api/admin/profile/"+p.ID, nil, true); w.Code != 500 {
		t.Fatal(w.Code)
	}
	if w := request(a, "GET", path, nil, false); w.Code != 200 {
		t.Fatal("failed deletion revoked working subscription")
	}
}
