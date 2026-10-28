package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// The Komari /api/recent payload shape below mirrors a live sample
// captured 2026-10-22: connections {tcp, udp} and a top-level uptime
// in seconds sit next to cpu/ram/disk/network.
func TestLatestKomariParsesConnectionsAndUptime(t *testing.T) {
	var reports []komariReport
	raw := `[{"uuid":"` + testKomariUUID + `","updated_at":"` + time.Now().Format(time.RFC3339Nano) + `",` +
		`"cpu":{"usage":1.5},"ram":{"total":1000,"used":500},"disk":{"total":2000,"used":1000},` +
		`"network":{"up":10,"down":20,"totalUp":300,"totalDown":400},` +
		`"connections":{"tcp":52,"udp":2},"uptime":184276}]`
	if err := json.Unmarshal([]byte(raw), &reports); err != nil {
		t.Fatal(err)
	}
	v := latestKomari(KomariNode{UUID: testKomariUUID, Name: "Node", TrafficLimit: 5000, TrafficMode: "sum"}, reports, time.Now())
	if v.Status != "online" {
		t.Fatal("sample not online")
	}
	if v.ConnectionsTCP == nil || *v.ConnectionsTCP != 52 || v.ConnectionsUDP == nil || *v.ConnectionsUDP != 2 {
		t.Fatal("connections not parsed")
	}
	if v.UptimeSeconds == nil || *v.UptimeSeconds != 184276 {
		t.Fatal("uptime not parsed")
	}

	// A report without the optional objects must leave the fields nil,
	// never fabricated zeros.
	reports[0].Connections = nil
	reports[0].Uptime = nil
	v = latestKomari(KomariNode{UUID: testKomariUUID, Name: "Node"}, reports, time.Now())
	if v.ConnectionsTCP != nil || v.ConnectionsUDP != nil || v.UptimeSeconds != nil {
		t.Fatal("absent connections/uptime fabricated")
	}
}

func TestPublicStatusExposesApprovedTrafficAndProbeFields(t *testing.T) {
	a := testApp(t)
	a.put("server", "pub-page-id", Server{ID: "pub-page-id", Name: "Fremont", Region: "US", Address: "secret-address.example", Price: "secret-price", KomariUUID: testKomariUUID})
	used := int64(700)
	tcp, udp, uptime := int64(52), int64(2), int64(184276)
	a.komari.fetched = time.Now()
	a.komari.metrics = map[string]KomariMetric{testKomariUUID: {
		Status: "online", Updated: now(), Up: 100, Down: 200,
		TotalUp: 300, TotalDown: 400, TrafficLimit: 5000, TrafficMode: "sum", TrafficUsed: &used,
		ConnectionsTCP: &tcp, ConnectionsUDP: &udp, UptimeSeconds: &uptime,
	}}
	w := request(a, "GET", "/api/public/status", nil, false)
	if w.Code != 200 {
		t.Fatalf("public status unavailable: %d", w.Code)
	}
	var body struct {
		Machines  []PublicMachine `json:"machines"`
		KomariURL string          `json:"komariUrl"`
		Disabled  bool            `json:"disabled"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.KomariURL != defaultKomariURL || body.Disabled {
		t.Fatal("default page settings missing from response")
	}
	if len(body.Machines) != 1 {
		t.Fatal("wrong machine count")
	}
	m := body.Machines[0]
	if m.TotalUp == nil || *m.TotalUp != 300 || m.TotalDown == nil || *m.TotalDown != 400 {
		t.Fatal("cumulative counters not exposed")
	}
	if m.TrafficLimit != 5000 || m.TrafficUsed == nil || *m.TrafficUsed != 700 {
		t.Fatal("traffic quota not exposed")
	}
	for _, secret := range []string{"secret-address", "secret-price", testKomariUUID, "pub-page-id", "trafficMode", "connectionsTcp", "connectionsUdp", "uptimeSeconds"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("private field exposed")
		}
	}
}

func TestPublicPageSettingsDefaultsToggleAndValidation(t *testing.T) {
	a := testApp(t)

	// Admin gate: the settings endpoint must not be public.
	if w := request(a, "GET", "/api/admin/public-settings", nil, false); w.Code != 401 {
		t.Fatalf("public-settings readable without admin: %d", w.Code)
	}
	// Defaults: enabled, default Komari URL.
	w := request(a, "GET", "/api/admin/public-settings", nil, true)
	var got publicPageSettings
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &got) != nil || !got.Enabled || got.KomariURL != defaultKomariURL {
		t.Fatalf("wrong defaults: %d %s", w.Code, w.Body.String())
	}
	if w := request(a, "GET", "/api/public/status", nil, false); w.Code != 200 {
		t.Fatalf("status should be on by default: %d", w.Code)
	}

	// Bad URL scheme is rejected.
	if w := request(a, "POST", "/api/admin/public-settings", map[string]any{"enabled": true, "komariUrl": "ftp://example.com"}, true); w.Code != 400 {
		t.Fatalf("non-http komariUrl accepted: %d", w.Code)
	}

	// Disable: the public endpoint 404s with the closed message, and
	// an empty komariUrl falls back to the default.
	w = request(a, "POST", "/api/admin/public-settings", map[string]any{"enabled": false, "komariUrl": ""}, true)
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &got) != nil || got.Enabled || got.KomariURL != defaultKomariURL {
		t.Fatalf("disable not saved: %d %s", w.Code, w.Body.String())
	}
	w = request(a, "GET", "/api/public/status", nil, false)
	if w.Code != 404 || !strings.Contains(w.Body.String(), "公开状态页已关闭") {
		t.Fatalf("disabled status page still served: %d %s", w.Code, w.Body.String())
	}

	// Re-enable with a custom URL; it round-trips through both APIs.
	w = request(a, "POST", "/api/admin/public-settings", map[string]any{"enabled": true, "komariUrl": "https://monitor.example.com"}, true)
	if w.Code != 200 {
		t.Fatalf("re-enable failed: %d", w.Code)
	}
	w = request(a, "GET", "/api/public/status", nil, false)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"komariUrl":"https://monitor.example.com"`) || !strings.Contains(w.Body.String(), `"disabled":false`) {
		t.Fatalf("custom komariUrl not served: %d %s", w.Code, w.Body.String())
	}
}

func TestNormalizeKomariURL(t *testing.T) {
	original := komariOrigin
	komariOrigin = "https://monitor.example.com/"
	t.Cleanup(func() { komariOrigin = original })

	for _, value := range []string{"", " https://monitor.example.com/ ", "https://monitor.example.com/base/"} {
		if got, problem := normalizeKomariURL(value); problem != "" || !strings.HasPrefix(got, "https://monitor.example.com") {
			t.Fatalf("normalize %q = %q, %q", value, got, problem)
		}
	}
	for _, value := range []string{"ftp://example.com", "//example.com", "https://user:pass@example.com", "https://example.com/?token=secret", "https://example.com/#fragment", strings.Repeat("x", 501)} {
		if got, problem := normalizeKomariURL(value); problem == "" || got != "" {
			t.Fatalf("invalid Komari URL accepted: %q => %q, %q", value, got, problem)
		}
	}
}
