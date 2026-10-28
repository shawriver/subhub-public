package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// seedFetches inserts n successful fetches for member starting at `start`,
// spaced `step` apart, all from `ip`.
func seedFetches(t *testing.T, a *App, member, ip string, start time.Time, n int, step time.Duration) {
	t.Helper()
	for i := 0; i < n; i++ {
		insertFetch(t, a, start.Add(time.Duration(i)*step), member, ip, "ClashMeta/1.0", 200)
	}
}

func TestFetchAnomalyHighFreqBoundary(t *testing.T) {
	a := testApp(t)
	base := time.Now().Add(-2 * time.Hour)
	seedFetches(t, a, "member-a", "203.0.113.1", base, 9, time.Minute)
	_, sum, err := a.memberFetchAnomalies("member-a", base.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if sum.HasAnomaly {
		t.Fatal("9 fetches in an hour must not flag high_freq")
	}
	// The 10th fetch inside the same hour crosses the threshold and is the
	// one that gets flagged.
	seedFetches(t, a, "member-a", "203.0.113.1", base.Add(9*time.Minute), 1, time.Minute)
	flags, sum, err := a.memberFetchAnomalies("member-a", base.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if !sum.HasAnomaly || len(sum.Rules) != 1 || sum.Rules[0] != "high_freq" || sum.MaxPerHour != 10 {
		t.Fatalf("summary = %+v", sum)
	}
	if len(flags) != 1 {
		t.Fatalf("flagged rows = %d, want exactly the 10th fetch", len(flags))
	}
	for _, f := range flags {
		if len(f) != 1 || f[0] != "high_freq" {
			t.Fatalf("flags = %v", f)
		}
	}
}

func TestFetchAnomalyIgnoresProxyIPChurn(t *testing.T) {
	a := testApp(t)
	base := time.Now().Add(-3 * time.Hour)
	insertFetch(t, a, base, "member-a", "203.0.113.1", "ClashMeta/1.0", 200)
	insertFetch(t, a, base.Add(time.Hour), "member-a", "203.0.113.2", "ClashMeta/1.0", 200)
	_, sum, err := a.memberFetchAnomalies("member-a", base.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	insertFetch(t, a, base.Add(2*time.Hour), "member-a", "203.0.113.3", "ClashMeta/1.0", 200)
	flags, sum, err := a.memberFetchAnomalies("member-a", base.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if sum.HasAnomaly || len(flags) != 0 {
		t.Fatalf("rotating proxy IPs must not be treated as a fetch anomaly: %+v %v", sum, flags)
	}
}

func TestFetchAnomalyIgnoresBrowserPreviews(t *testing.T) {
	a := testApp(t)
	base := time.Now().Add(-2 * time.Hour)
	for i := 0; i < 12; i++ {
		insertFetch(t, a, base.Add(time.Duration(i)*time.Minute), "member-a", "203.0.113.1", "Mozilla/5.0 AppleWebKit/537.36 Chrome/135.0", 200)
	}
	flags, sum, err := a.memberFetchAnomalies("member-a", base.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if sum.HasAnomaly || len(flags) != 0 {
		t.Fatalf("browser previews must not trigger client anomaly rules: %+v %v", sum, flags)
	}
}

func TestFetchAnomalyIgnoresFailures(t *testing.T) {
	a := testApp(t)
	base := time.Now().Add(-2 * time.Hour)
	// 12 failed fetches in an hour: no flags, and they must not push a
	// smaller set of successes over the threshold either.
	for i := 0; i < 12; i++ {
		insertFetch(t, a, base.Add(time.Duration(i)*time.Minute), "member-a", "203.0.113.1", "ClashMeta/1.0", 410)
	}
	seedFetches(t, a, "member-a", "203.0.113.1", base.Add(20*time.Minute), 5, time.Minute)
	flags, sum, err := a.memberFetchAnomalies("member-a", base.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if sum.HasAnomaly || len(flags) != 0 {
		t.Fatalf("failures leaked into anomaly computation: %+v %v", sum, flags)
	}
}

func TestFetchAnomalySurfacesInAPIAndMemberView(t *testing.T) {
	a := testApp(t)
	_, m, _ := fixture(t, a)
	base := time.Now().Add(-30 * time.Minute)
	seedFetches(t, a, m.ID, "203.0.113.7", base, 10, time.Minute)
	insertFetch(t, a, base.Add(11*time.Minute), m.ID, "203.0.113.8", "ClashMeta/1.0", 200)
	insertFetch(t, a, base.Add(12*time.Minute), m.ID, "203.0.113.9", "ClashMeta/1.0", 200)

	w := request(a, "GET", "/api/admin/subscription-fetches?member="+m.ID, nil, true)
	var rows []SubscriptionFetch
	if err := json.Unmarshal(w.Body.Bytes(), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != 12 {
		t.Fatalf("rows = %d, want 12", len(rows))
	}
	var flagged int
	for _, row := range rows {
		if len(row.Flags) > 0 {
			flagged++
		}
	}
	if flagged == 0 {
		t.Fatal("no flagged rows in fetch list")
	}
	// The newest row sits inside a busy hour and carries the high-frequency flag.
	if got := strings.Join(rows[0].Flags, ","); got != "high_freq" {
		t.Fatalf("newest row flags = %q", got)
	}

	for _, view := range a.memberViews() {
		if view.ID == m.ID {
			if !view.HasAnomaly || view.AnomalySummary == "" || len(view.AnomalyRules) != 1 || view.AnomalyRules[0] != "high_freq" {
				t.Fatalf("member view anomaly = %+v", view)
			}
			return
		}
	}
	t.Fatal("fixture member missing from views")
}
