package main

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestReverseProxyNodeUsesExternalEndpoint(t *testing.T) {
	n := Node{
		ID: "proxy-ws", Name: "Proxy WS", ServerID: "server", Host: "192.0.2.10",
		Port: 29020, ExternalPort: 443, ExternalSNI: "proxy.example.test",
		Protocol: "VLESS", Transport: "ws", Security: "tls",
		Path: "/private-ws", Credential: "test-only-uuid",
	}
	line := v2rayLines([]Node{n})[0]
	u, err := url.Parse(line)
	if err != nil {
		t.Fatal(err)
	}
	if u.Port() != "443" || u.Query().Get("security") != "tls" || u.Query().Get("sni") != "proxy.example.test" || u.Query().Get("host") != "proxy.example.test" {
		t.Fatalf("external proxy fields were lost: %s", line)
	}
	rendered := string(renderClash([]Node{n}, nil))
	var proxy map[string]any
	for _, line := range strings.Split(rendered, "\n") {
		if strings.Contains(line, `"name":"Proxy WS"`) {
			start := strings.Index(line, "{")
			if start < 0 {
				t.Fatal("missing proxy object")
			}
			if err := json.Unmarshal([]byte(strings.TrimSpace(line[start:])), &proxy); err != nil {
				t.Fatal(err)
			}
		}
	}
	if proxy["port"] != float64(443) || proxy["tls"] != true || proxy["servername"] != "proxy.example.test" {
		t.Fatalf("Clash external proxy fields were lost: %#v", proxy)
	}
	ws, _ := proxy["ws-opts"].(map[string]any)
	headers, _ := ws["headers"].(map[string]any)
	if headers["Host"] != "proxy.example.test" {
		t.Fatalf("WebSocket Host was lost: %#v", proxy)
	}
}

func TestManagedReverseProxyCanOnlyOverrideExportEndpoint(t *testing.T) {
	a := testApp(t)
	a.put("server", "server", Server{ID: "server", Name: "Server", Address: "192.0.2.10"})
	old := Node{
		PanelID: "panel", InboundID: 2, ID: "managed-ws", Name: "Managed WS", ServerID: "server",
		Host: "192.0.2.10", Port: 29020, Enabled: true, Protocol: "VLESS",
		Transport: "ws", Security: "none", Path: "/private-ws", Managed: true,
	}
	a.put("node", old.ID, old)
	override := old
	override.Security, override.ExternalPort, override.ExternalSNI = "tls", 443, "proxy.example.test"
	body, _ := json.Marshal(override)
	req := httptest.NewRequest("PUT", "/api/admin/node/"+old.ID, strings.NewReader(string(body)))
	if err := a.saveValidatedRecord(req, "node", old.ID); err != nil {
		t.Fatalf("safe external endpoint override rejected: %v", err)
	}
	var saved Node
	if a.get("node", old.ID, &saved) != nil || saved.ExternalPort != 443 || saved.ExternalSNI != "proxy.example.test" || saved.Security != "tls" {
		t.Fatalf("external endpoint override was not saved: %#v", saved)
	}
	unsafe := saved
	unsafe.Port = 1234
	body, _ = json.Marshal(unsafe)
	req = httptest.NewRequest("PUT", "/api/admin/node/"+old.ID, strings.NewReader(string(body)))
	if err := a.saveValidatedRecord(req, "node", old.ID); err == nil {
		t.Fatal("managed inbound port must remain read-only")
	}
}
