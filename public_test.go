package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestPublicStatusUsesOnlySafeLiveFields(t *testing.T) {
	a := testApp(t)
	a.put("server", "public-test-id", Server{ID: "public-test-id", Name: "Tokyo", Region: "Japan", Address: "secret-address.example", Note: "secret-note", Price: "secret-price", KomariUUID: testKomariUUID, CPU: 99, Status: "online"})
	a.put("node", "private-node-id", Node{ID: "private-node-id", Name: "private-node-name", Credential: "private-credential"})
	a.komari.fetched = time.Now()
	a.komari.metrics = map[string]KomariMetric{testKomariUUID: {Status: "online", Updated: now(), Up: 100, Down: 200, TotalUp: 300, TotalDown: 400, Error: "private-monitor-error"}}
	w := request(a, "GET", "/api/public/status", nil, false)
	if w.Code != 200 {
		t.Fatal("public status unavailable")
	}
	// trafficLimit/trafficUsed/totalUp/totalDown left this list on
	// 2026-10-22: the owner-approved public status page shows the
	// quota bar and cumulative counters. Price, expiry, addresses,
	// notes, identities and trafficMode stay private.
	for _, secret := range []string{"secret-address", "secret-note", "secret-price", "private-node", "private-credential", testKomariUUID, "public-test-id", "private-monitor-error", "komariUuid", "panelId", "trafficMode"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Fatal("private field exposed")
		}
	}
	var body struct{ Machines []PublicMachine }
	json.Unmarshal(w.Body.Bytes(), &body)
	if len(body.Machines) != 1 || body.Machines[0].Status != "online" || body.Machines[0].Up == nil || *body.Machines[0].Up != 100 {
		t.Fatal("wrong public measurement")
	}
	a.komari.fetched = time.Now().Add(-2 * time.Minute)
	w = request(a, "GET", "/api/public/status", nil, false)
	json.Unmarshal(w.Body.Bytes(), &body)
	if body.Machines[0].Status != "stale" || body.Machines[0].Up != nil {
		t.Fatal("stale data presented as live")
	}
	a.komari.metrics = nil
	w = request(a, "GET", "/api/public/status", nil, false)
	json.Unmarshal(w.Body.Bytes(), &body)
	if body.Machines[0].Status != "unknown" {
		t.Fatal("unknown data replaced with fabricated values")
	}
	if request(a, "POST", "/api/public/status", nil, false).Code != 405 {
		t.Fatal("public mutation allowed")
	}
	if request(a, "GET", "/api/admin/overview", nil, false).Code != 401 {
		t.Fatal("management exposed")
	}
}

func TestPublicMemberPortalExposesOnlyOwnSummary(t *testing.T) {
	a := testApp(t)
	_, member, profile := fixture(t, a)
	member.Enabled = true
	member.Expires = "2035-10-17"
	member.Used = 0.25
	member.Limit = 10
	if err := a.put("member", member.ID, member); err != nil {
		t.Fatal(err)
	}
	issued := request(a, "POST", "/api/admin/subscriptions/"+profile.ID, nil, true)
	path := issuedPath(t, issued)
	tokenValue := strings.TrimPrefix(strings.Split(path, "?")[0], "/sub/")
	w := request(a, "GET", "/api/public/member/"+tokenValue, nil, false)
	if w.Code != 200 {
		t.Fatalf("public member status unavailable: %d", w.Code)
	}
	var body PublicMember
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Name != member.Name || body.UsedGB != member.Used || body.LimitGB != member.Limit || body.Status != "active" {
		t.Fatalf("unexpected public member summary: %+v", body)
	}
	for _, private := range []string{"credential", "nodeId", "address", "password", "uuid"} {
		if strings.Contains(w.Body.String(), private) {
			t.Fatalf("public member response exposed %s", private)
		}
	}
	if request(a, "GET", "/api/public/member/invalid", nil, false).Code != 404 {
		t.Fatal("invalid portal token accepted")
	}
}
