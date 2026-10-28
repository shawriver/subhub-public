package main

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestVMessImportExportAndSecretIsolation(t *testing.T) {
	a := testApp(t)
	a.put("server", "aws", Server{ID: "aws", Name: "AWS", Address: "192.0.2.1"})
	// Numeric port/aid occur in common client shares, alongside string forms.
	v := map[string]any{"v": "2", "ps": "Tokyo VMess", "add": "node.example.test", "port": 8443, "id": "01234567-89ab-4cde-8fab-0123456789ab", "aid": 0, "scy": "auto", "net": "ws", "type": "none", "host": "ws.example.test", "path": "/private path?x=1", "tls": "tls", "sni": "tls.example.test", "alpn": "http/1.1", "fp": "chrome"}
	b, _ := json.Marshal(v)
	link := "vmess://" + base64.RawStdEncoding.EncodeToString(b)
	in := importInput{ServerID: "aws", Content: link}
	w := request(a, "POST", "/api/admin/nodes/import/preview", in, true)
	if w.Code != 200 || strings.Contains(w.Body.String(), v["id"].(string)) {
		t.Fatal("preview failed or leaked UUID")
	}
	w = request(a, "POST", "/api/admin/nodes/import", in, true)
	if w.Code != 200 || len(loadNodes(a)) != 1 {
		t.Fatal("VMess not imported")
	}
	n := loadNodes(a)[0]
	n.Credential, _ = a.readSecret("node_secret", n.ID)
	if n.Protocol != "VMess" || n.Port != 8443 || n.Credential != v["id"] || n.Path != v["path"] || n.WSHost != v["host"] || n.SNI != v["sni"] {
		t.Fatal("connection semantics changed")
	}
	p, err := parseNodeURI(v2rayLines([]Node{n})[0])
	if err != nil || connectionKey(p) != connectionKey(n) {
		t.Fatal("VMess share round trip changed connection")
	}
	clash := string(renderClash([]Node{n}, nil))
	line := strings.Split(clash, "  - ")[1]
	var proxy map[string]any
	if json.Unmarshal([]byte(strings.Split(line, "\n")[0]), &proxy) != nil || proxy["type"] != "vmess" || proxy["alterId"] != float64(0) || proxy["cipher"] != "auto" || proxy["tls"] != true || proxy["servername"] != v["sni"] || proxy["uuid"] != v["id"] {
		t.Fatal("Clash export missing required VMess fields")
	}
	w = request(a, "POST", "/api/admin/nodes/import", in, true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"skipped":1`) {
		t.Fatal("duplicate was not skipped")
	}
	for key, bad := range map[string]any{"aid": 64, "scy": "none", "allowInsecure": true, "type": "http", "net": "grpc", "tls": "reality", "port": 0} {
		copy := map[string]any{}
		for k, value := range v {
			copy[k] = value
		}
		copy[key] = bad
		badJSON, _ := json.Marshal(copy)
		input := importInput{ServerID: "aws", Content: link + "\nvmess://" + base64.StdEncoding.EncodeToString(badJSON)}
		w = request(a, "POST", "/api/admin/nodes/import", input, true)
		if w.Code != 400 || len(loadNodes(a)) != 1 {
			t.Fatalf("unsafe %s accepted or partial import", key)
		}
	}
}
