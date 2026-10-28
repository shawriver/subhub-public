package main

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func importFixture(t *testing.T, a *App) (string, string) {
	t.Helper()
	server := Server{ID: "import-server", Name: "Import server", Address: "192.0.2.10"}
	if err := a.put("server", server.ID, server); err != nil {
		t.Fatal(err)
	}
	secret := token() + ":@/?"
	u := url.URL{Scheme: "trojan", Host: "[2001:db8::6]:443", User: url.User(secret), RawQuery: "security=tls&type=ws&path=%2Ftest&sni=example.test&host=ws.example.test&alpn=h2%2Chttp%2F1.1", Fragment: "Imported node"}
	return u.String(), secret
}

func TestImportPreviewCommitAndDuplicates(t *testing.T) {
	a := testApp(t)
	link, secret := importFixture(t, a)
	in := importInput{ServerID: "import-server", Content: base64.StdEncoding.EncodeToString([]byte(link))}
	w := request(a, "POST", "/api/admin/nodes/import/preview", in, true)
	if w.Code != 200 {
		t.Fatal(w.Code)
	}
	if strings.Contains(w.Body.String(), secret) || strings.Contains(w.Body.String(), url.QueryEscape(secret)) || strings.Contains(w.Body.String(), "credential") {
		t.Fatal("preview leaked credential")
	}
	if len(a.list("node")) != 0 {
		t.Fatal("preview mutated storage")
	}
	var plan importPlan
	if json.Unmarshal(w.Body.Bytes(), &plan) != nil || len(plan.Nodes) != 1 || len(plan.Errors) != 0 {
		t.Fatal("bad preview")
	}
	w = request(a, "POST", "/api/admin/nodes/import", in, true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"imported":1`) {
		t.Fatal(w.Code)
	}
	nodes := loadNodes(a)
	if len(nodes) != 1 || nodes[0].Host != "2001:db8::6" || nodes[0].WSHost != "ws.example.test" || nodes[0].Path != "/test" {
		t.Fatal("import parameters lost")
	}
	got, err := a.readSecret("node_secret", nodes[0].ID)
	if err != nil || got != secret {
		t.Fatal("credential round trip failed")
	}
	in.Content = link + "\n" + link
	w = request(a, "POST", "/api/admin/nodes/import", in, true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"skipped":2`) || len(loadNodes(a)) != 1 {
		t.Fatal("duplicates not skipped")
	}
	if w := request(a, "POST", "/api/admin/nodes/import/preview", in, false); w.Code != 401 {
		t.Fatal("unauthenticated import")
	}
}

func TestImportRejectsPartialAndUnsafeParameters(t *testing.T) {
	for _, suffix := range []string{"&insecure=1", "&obfs=salamander", "&security=none", "&type=grpc", "&unknown=value"} {
		t.Run(suffix, func(t *testing.T) {
			a := testApp(t)
			link, _ := importFixture(t, a)
			u, _ := url.Parse(link)
			u.RawQuery += suffix
			u.Fragment = "Invalid"
			in := importInput{ServerID: "import-server", Content: link + "\n" + u.String()}
			w := request(a, "POST", "/api/admin/nodes/import", in, true)
			if w.Code != 400 || len(loadNodes(a)) != 0 {
				t.Fatal("partial or unsupported import accepted")
			}
		})
	}
	a := testApp(t)
	link, secret := importFixture(t, a)
	invalid := link + "\nhttps://airport.example.test/sub?token=" + secret
	w := request(a, "POST", "/api/admin/nodes/import/preview", importInput{ServerID: "import-server", Content: invalid}, true)
	if strings.Contains(w.Body.String(), secret) || strings.Contains(w.Body.String(), "airport.example.test") {
		t.Fatal("errors echo credential URL")
	}
	w = request(a, "POST", "/api/admin/nodes/import", importInput{ServerID: "missing", Content: link}, true)
	if w.Code != 400 {
		t.Fatal("unregistered server accepted")
	}
	_, err := parseNodeURI("vless://test@example.test:443?type=ws&security=reality&pbk=test")
	if err != nil {
		t.Fatal("parser should leave semantic checking to validator")
	}
	if len(a.planImport(importInput{ServerID: "import-server", Content: strings.Repeat(link+"\n", 101)}).Errors) == 0 {
		t.Fatal("batch cap absent")
	}
}

func TestImportTransactionRollsBack(t *testing.T) {
	a := testApp(t)
	link, _ := importFixture(t, a)
	if _, err := a.db.Exec("CREATE TRIGGER deny_import_secret BEFORE INSERT ON secrets BEGIN SELECT RAISE(ABORT,'test'); END"); err != nil {
		t.Fatal(err)
	}
	w := request(a, "POST", "/api/admin/nodes/import", importInput{ServerID: "import-server", Content: link}, true)
	if w.Code != 500 || len(loadNodes(a)) != 0 {
		t.Fatal("failed import left records")
	}
}

func TestImportProtocolRoundTrips(t *testing.T) {
	a := testApp(t)
	nodes := []Node{
		{Name: "VLESS Reality", Protocol: "VLESS", Host: "example.test", Port: 443, Security: "reality", Transport: "tcp", PublicKey: "test-public", ShortID: "aabb", Flow: "xtls-rprx-vision", Credential: token()},
		{Name: "VLESS WS", Protocol: "VLESS", Host: "example.test", Port: 443, Security: "tls", Transport: "ws", Path: "/path ?a=b", WSHost: "ws.example.test", Credential: token()},
		{Name: "HY2", Protocol: "Hysteria2", Host: "2001:db8::1", Port: 443, Security: "tls", Transport: "udp", Credential: token(), SNI: "example.test"},
	}
	for _, n := range nodes {
		lines := v2rayLines([]Node{n})
		p, err := parseNodeURI(lines[0])
		if err != nil {
			t.Fatal(err)
		}
		if err = a.validateNode(p); err != nil {
			t.Fatal(err)
		}
		if p.Protocol != n.Protocol || p.Credential != n.Credential || p.Host != n.Host || p.Path != n.Path || p.Flow != n.Flow || p.PublicKey != n.PublicKey {
			t.Fatal("protocol round trip failed")
		}
	}
}

func TestMemberProfilesReconcileAtomically(t *testing.T) {
	a := testApp(t)
	n, m, p := fixture(t, a)
	n2 := n
	n2.ID = "node-b"
	n2.Name = "Other node"
	a.put("node", n2.ID, n2)
	a.secret("node_secret", n2.ID, token())
	m.NodeIDs = append(m.NodeIDs, n2.ID)
	a.put("member", m.ID, m)
	p.NodeIDs = []string{n.ID, n2.ID}
	a.put("profile", p.ID, p)
	follow := p
	follow.ID = "follow"
	follow.FollowMemberNodes = true
	a.put("profile", follow.ID, follow)
	link := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	m.NodeIDs = []string{n2.ID}
	if w := request(a, "PUT", "/api/admin/member/"+m.ID, m, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	a.get("profile", p.ID, &p)
	a.get("profile", follow.ID, &follow)
	if len(p.NodeIDs) != 1 || p.NodeIDs[0] != n2.ID || len(follow.NodeIDs) != 1 {
		t.Fatal("removed nodes remain in profiles")
	}
	w := request(a, "GET", link, nil, false)
	if w.Code != 200 || strings.Contains(w.Body.String(), n.Name) {
		t.Fatal("saved edit changed URL or kept removed node")
	}
	m.NodeIDs = []string{n.ID, n2.ID}
	if w := request(a, "PUT", "/api/admin/member/"+m.ID, m, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	a.get("profile", p.ID, &p)
	a.get("profile", follow.ID, &follow)
	if len(p.NodeIDs) != 1 || len(follow.NodeIDs) != 2 {
		t.Fatal("manual selection/follow semantics lost")
	}
	// A profile update failure must roll back the member edit too.
	a.db.Exec("CREATE TRIGGER deny_profile_update BEFORE UPDATE ON records WHEN OLD.kind='profile' BEGIN SELECT RAISE(ABORT,'test'); END")
	m.NodeIDs = []string{}
	if w := request(a, "PUT", "/api/admin/member/"+m.ID, m, true); w.Code != 400 {
		t.Fatal(w.Code)
	}
	var after Member
	a.get("member", m.ID, &after)
	if len(after.NodeIDs) != 2 {
		t.Fatal("failed profile reconciliation changed member")
	}
}

func TestEditRevokeAndDeleteLifecycle(t *testing.T) {
	a := testApp(t)
	n, m, p := fixture(t, a)
	path := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	p.Name = "Renamed"
	p.FollowMemberNodes = true
	p.Rules = []string{"MATCH,节点选择"}
	if w := request(a, "PUT", "/api/admin/profile/"+p.ID, p, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := request(a, "GET", path, nil, false); w.Code != 200 {
		t.Fatal("edit revoked URL")
	}
	if w := request(a, "POST", "/api/admin/subscriptions/"+p.ID+"/revoke", nil, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := request(a, "GET", path, nil, false); w.Code != 404 {
		t.Fatal("revoked URL valid")
	}
	var saved Profile
	if a.get("profile", p.ID, &saved) != nil {
		t.Fatal("revoke deleted configuration")
	}
	path = issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	if w := request(a, "DELETE", "/api/admin/member/"+m.ID, nil, true); w.Code != 409 {
		t.Fatal("referenced member deleted")
	}
	if w := request(a, "DELETE", "/api/admin/node/"+n.ID, nil, true); w.Code != 409 {
		t.Fatal("assigned node deleted")
	}
	if w := request(a, "DELETE", "/api/admin/profile/"+p.ID, nil, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := request(a, "GET", path, nil, false); w.Code != 404 {
		t.Fatal("deleted profile link still valid")
	}
	if w := request(a, "DELETE", "/api/admin/member/"+m.ID, nil, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w := request(a, "DELETE", "/api/admin/node/"+n.ID, nil, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if _, err := a.readSecret("node_secret", n.ID); err == nil {
		t.Fatal("deleted node secret retained")
	}
}
