package main

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func TestAnyTLSImportExportAndSecretIsolation(t *testing.T) {
	a := testApp(t)
	a.put("server", "aws", Server{ID: "aws", Name: "AWS", Address: "192.0.2.1"})
	secret := "test:password/@+?with spaces"
	u := url.URL{Scheme: "anytls", User: url.User(secret), Host: "[2001:db8::1]:18445", RawQuery: "sni=tls.example.test&fp=chrome&alpn=h2", Fragment: "Tokyo AnyTLS"}
	in := importInput{ServerID: "aws", Content: u.String()}
	w := request(a, "POST", "/api/admin/nodes/import/preview", in, true)
	if w.Code != 200 || strings.Contains(w.Body.String(), secret) {
		t.Fatal("preview failed or leaked password")
	}
	w = request(a, "POST", "/api/admin/nodes/import", in, true)
	if w.Code != 200 || len(loadNodes(a)) != 1 {
		t.Fatal("AnyTLS not imported")
	}
	n := loadNodes(a)[0]
	if n.Credential != "" {
		t.Fatal("record leaked credential")
	}
	n.Credential, _ = a.readSecret("node_secret", n.ID)
	if n.Protocol != "AnyTLS" || n.Security != "tls" || n.Transport != "tcp" || n.Credential != secret {
		t.Fatal("connection semantics changed")
	}
	p, err := parseNodeURI(v2rayLines([]Node{n})[0])
	if err != nil || connectionKey(p) != connectionKey(n) {
		t.Fatal("share round trip changed connection")
	}
	line := strings.Split(strings.Split(string(renderClash([]Node{n}, nil)), "  - ")[1], "\n")[0]
	var proxy map[string]any
	if json.Unmarshal([]byte(line), &proxy) != nil || proxy["type"] != "anytls" || proxy["password"] != secret || proxy["sni"] != "tls.example.test" || proxy["udp"] != true || proxy["skip-cert-verify"] != false || proxy["client-fingerprint"] != "chrome" {
		t.Fatal("invalid AnyTLS Clash export")
	}
	w = request(a, "POST", "/api/admin/nodes/import", in, true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"skipped":1`) {
		t.Fatal("duplicate not skipped")
	}
	w = request(a, "GET", "/api/admin/overview", nil, true)
	if strings.Contains(w.Body.String(), secret) {
		t.Fatal("overview leaked password")
	}
}

func TestAnyTLSRejectUnsupportedParametersAtomically(t *testing.T) {
	a := testApp(t)
	a.put("server", "aws", Server{ID: "aws", Name: "AWS", Address: "192.0.2.1"})
	good := "anytls://test-only@node.example.test:18445?sni=tls.example.test#Good"
	for _, query := range []string{"type=ws", "type=udp", "security=none", "security=reality", "insecure=1", "allowInsecure=true", "sni=a&sni=b", "sni=a&peer=b", "path=/ws", "host=ws.example.test", "pbk=test", "sid=1234", "flow=xtls-rprx-vision", "encryption=none", "unknown=x"} {
		w := request(a, "POST", "/api/admin/nodes/import", importInput{ServerID: "aws", Content: good + "\nanytls://test-only@node.example.test:18445?" + query + "#Bad"}, true)
		if w.Code != 400 || len(loadNodes(a)) != 0 {
			t.Fatalf("accepted unsafe parameter %s or partial write", query)
		}
	}
	for _, n := range []Node{
		{Protocol: "AnyTLS", Security: "none", Transport: "tcp"},
		{Protocol: "AnyTLS", Security: "tls", Transport: "ws"},
		{Protocol: "AnyTLS", Security: "tls", Transport: "tcp", Path: "/ws"},
		{Protocol: "AnyTLS", Security: "tls", Transport: "tcp", PublicKey: "test"},
	} {
		n.Name = "Test"
		n.Host = "node.example.test"
		n.Port = 18445
		if a.validateNode(n) == nil {
			t.Fatal("invalid manual AnyTLS configuration accepted")
		}
	}
}

func TestReplaceUnmanagedVMessWithAnyTLSKeepsAssignments(t *testing.T) {
	a := testApp(t)
	a.put("node", "aws", Node{ID: "aws", Name: "AWS VMess", Protocol: "VMess", Host: "node.example.test", Port: 8443, Security: "tls", Transport: "ws"})
	a.put("member", "member", Member{ID: "member", NodeIDs: []string{"aws"}})
	a.put("profile", "profile", Profile{ID: "profile", MemberID: "member", NodeIDs: []string{"aws"}})
	n := Node{ID: "aws", Name: "AWS AnyTLS", Protocol: "AnyTLS", Host: "node.example.test", Port: 18445, Security: "tls", Transport: "tcp", Credential: "new-test-password"}
	w := request(a, "PUT", "/api/admin/node/aws", n, true)
	if w.Code != 200 {
		t.Fatal("unmanaged protocol replacement rejected")
	}
	var member Member
	var profile Profile
	a.get("member", "member", &member)
	a.get("profile", "profile", &profile)
	if !containsID(member.NodeIDs, "aws") || !containsID(profile.NodeIDs, "aws") {
		t.Fatal("assignments changed")
	}
	got, _ := a.readSecret("node_secret", "aws")
	if got != n.Credential {
		t.Fatal("replacement credential missing")
	}
}
