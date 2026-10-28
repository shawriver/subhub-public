package main

import (
	"encoding/json"
	"testing"
	"time"
)

var trafficTestAt = time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)

func TestTrafficDeltasNormalIncrement(t *testing.T) {
	prev := map[string]trafficBaseline{
		"srv-1": {UUID: "uuid-1", Up: 1000, Down: 2000, At: "2026-10-22T11:59:00Z"},
	}
	samples := []trafficSample{{ServerID: "srv-1", UUID: "uuid-1", Up: 1500, Down: 2600}}
	deltas, next := computeTrafficDeltas(prev, samples, trafficTestAt)
	if len(deltas) != 1 || deltas["srv-1"] != (trafficCounter{Up: 500, Down: 600}) {
		t.Fatalf("deltas = %+v", deltas)
	}
	if b := next["srv-1"]; b.Up != 1500 || b.Down != 2600 || b.UUID != "uuid-1" || b.At != "2026-10-22T12:00:00Z" {
		t.Fatalf("baseline = %+v", b)
	}
	// The input baseline map must not be mutated in place.
	if prev["srv-1"].Up != 1000 {
		t.Fatalf("prev mutated: %+v", prev["srv-1"])
	}
}

func TestTrafficDeltasCounterReset(t *testing.T) {
	prev := map[string]trafficBaseline{
		"srv-1": {UUID: "uuid-1", Up: 5000, Down: 4000},
	}
	// Probe restarted: cumulative counters dropped below the baseline, so
	// the delta is the post-reset cumulative itself.
	samples := []trafficSample{{ServerID: "srv-1", UUID: "uuid-1", Up: 300, Down: 100}}
	deltas, next := computeTrafficDeltas(prev, samples, trafficTestAt)
	if deltas["srv-1"] != (trafficCounter{Up: 300, Down: 100}) {
		t.Fatalf("deltas = %+v", deltas)
	}
	if b := next["srv-1"]; b.Up != 300 || b.Down != 100 {
		t.Fatalf("baseline = %+v", b)
	}
}

func TestTrafficDeltasFirstSeenIsBaselineOnly(t *testing.T) {
	samples := []trafficSample{{ServerID: "srv-1", UUID: "uuid-1", Up: 999999, Down: 888888}}
	deltas, next := computeTrafficDeltas(nil, samples, trafficTestAt)
	if len(deltas) != 0 {
		t.Fatalf("first sighting must produce zero delta, got %+v", deltas)
	}
	if b := next["srv-1"]; b.Up != 999999 || b.Down != 888888 {
		t.Fatalf("baseline = %+v", b)
	}
}

func TestTrafficDeltasAbsentServerKeepsBaseline(t *testing.T) {
	prev := map[string]trafficBaseline{
		"srv-1": {UUID: "uuid-1", Up: 100, Down: 100, At: "2026-10-22T11:00:00Z"},
		"srv-2": {UUID: "uuid-2", Up: 700, Down: 900, At: "2026-10-22T11:00:00Z"},
	}
	samples := []trafficSample{{ServerID: "srv-1", UUID: "uuid-1", Up: 150, Down: 130}}
	deltas, next := computeTrafficDeltas(prev, samples, trafficTestAt)
	if len(deltas) != 1 {
		t.Fatalf("deltas = %+v", deltas)
	}
	if b := next["srv-2"]; b != prev["srv-2"] {
		t.Fatalf("absent server baseline changed: %+v, want %+v", b, prev["srv-2"])
	}
}

func TestTrafficDeltasMultiServerBreakdown(t *testing.T) {
	prev := map[string]trafficBaseline{
		"srv-1": {UUID: "uuid-1", Up: 1000, Down: 1000},
		"srv-2": {UUID: "uuid-2", Up: 2000, Down: 500},
		"srv-3": {UUID: "uuid-3", Up: 50, Down: 50},
	}
	samples := []trafficSample{
		{ServerID: "srv-1", UUID: "uuid-1", Up: 1100, Down: 1250},
		{ServerID: "srv-2", UUID: "uuid-2", Up: 2000, Down: 900},
		{ServerID: "srv-3", UUID: "uuid-3", Up: 50, Down: 50}, // idle: no delta entry
	}
	deltas, _ := computeTrafficDeltas(prev, samples, trafficTestAt)
	if len(deltas) != 2 {
		t.Fatalf("deltas = %+v, want exactly srv-1 and srv-2", deltas)
	}
	if deltas["srv-1"] != (trafficCounter{Up: 100, Down: 250}) {
		t.Fatalf("srv-1 delta = %+v", deltas["srv-1"])
	}
	if deltas["srv-2"] != (trafficCounter{Up: 0, Down: 400}) {
		t.Fatalf("srv-2 delta = %+v", deltas["srv-2"])
	}
}

// seedKomariMetric installs one metric directly into the in-memory Komari
// cache, the same shape refreshKomari would leave behind.
func seedKomariMetric(a *App, uuid string, totalUp, totalDown int64) {
	a.komari.mu.Lock()
	defer a.komari.mu.Unlock()
	if a.komari.metrics == nil {
		a.komari.metrics = map[string]KomariMetric{}
	}
	a.komari.fetched = time.Now()
	a.komari.metrics[uuid] = KomariMetric{UUID: uuid, Status: "online", Updated: time.Now().UTC().Format(time.RFC3339), TotalUp: totalUp, TotalDown: totalDown}
}

func TestAccumulateTrafficEndToEnd(t *testing.T) {
	a := testApp(t)
	const uuid = "11111111-1111-1111-1111-111111111111"
	if err := a.put("server", "srv-1", Server{ID: "srv-1", Name: "S1", KomariUUID: uuid}); err != nil {
		t.Fatal(err)
	}
	today := time.Now().In(billingZone).Format("2006-01-02")

	// First tick only establishes the baseline: no day record yet.
	seedKomariMetric(a, uuid, 1000, 2000)
	a.accumulateTraffic()
	var day trafficDay
	if err := a.get("traffic_day", today, &day); err == nil {
		t.Fatalf("first tick must not book the lifetime cumulative, day = %+v", day)
	}

	// Second tick books only the increment, total and per-server alike.
	seedKomariMetric(a, uuid, 1600, 2900)
	a.accumulateTraffic()
	if err := a.get("traffic_day", today, &day); err != nil {
		t.Fatal(err)
	}
	if day.Up != 600 || day.Down != 900 {
		t.Fatalf("day totals = %d/%d, want 600/900", day.Up, day.Down)
	}
	if day.Servers["srv-1"] != (trafficCounter{Up: 600, Down: 900}) {
		t.Fatalf("per-server = %+v", day.Servers)
	}
	if day.Date != today || day.UpdatedAt == "" {
		t.Fatalf("day = %+v", day)
	}

	days, since := a.trafficDaily(62)
	if len(days) != 1 || since != today || days[0].Date != today {
		t.Fatalf("trafficDaily = %+v, since = %q", days, since)
	}

	// A Komari outage skips the round entirely: baseline stays put, so the
	// recovery tick still measures from the last good counters.
	a.komari.mu.Lock()
	a.komari.err = "暂时无法连接 Komari"
	a.komari.mu.Unlock()
	seedKomariMetric(a, uuid, 999999, 999999)
	a.accumulateTraffic()
	var state trafficState
	if err := a.get("traffic_state", "counters", &state); err != nil {
		t.Fatal(err)
	}
	if b := state.ByServer["srv-1"]; b.Up != 1600 || b.Down != 2900 {
		t.Fatalf("baseline moved during outage: %+v", b)
	}
}

func TestFetchStats30d(t *testing.T) {
	a := testApp(t)
	nowT := time.Now()
	insertFetch(t, a, nowT.Add(-time.Hour), "member-a", "203.0.113.1", "ClashMeta/1.0", 200)
	insertFetch(t, a, nowT.Add(-2*time.Hour), "member-a", "203.0.113.2", "ClashMeta/1.0", 200)
	insertFetch(t, a, nowT.Add(-3*time.Hour), "member-b", "203.0.113.1", "ClashMeta/1.0", 410)
	// Older than 30 days: excluded.
	insertFetch(t, a, nowT.AddDate(0, 0, -31), "member-c", "203.0.113.9", "ClashMeta/1.0", 200)
	s := a.fetchStats30d()
	if s.Fetches30d != 3 || s.DistinctIPs30d != 2 || s.DistinctMembers30d != 2 {
		t.Fatalf("fetchStats = %+v, want {3 2 2}", s)
	}
}

func TestOverviewIncludesTrafficFields(t *testing.T) {
	a := testApp(t)
	w := request(a, "GET", "/api/admin/overview", nil, true)
	var out map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"trafficDaily", "trafficSince", "fetchStats"} {
		if _, ok := out[key]; !ok {
			t.Fatalf("overview missing %q", key)
		}
	}
	if string(out["trafficDaily"]) != "[]" || string(out["trafficSince"]) != `""` {
		t.Fatalf("empty traffic fields = %s / %s", out["trafficDaily"], out["trafficSince"])
	}
	var stats fetchStats
	if err := json.Unmarshal(out["fetchStats"], &stats); err != nil {
		t.Fatal(err)
	}
}
