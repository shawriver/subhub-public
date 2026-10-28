package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func insertFetch(t *testing.T, a *App, at time.Time, member, ip, ua string, status int) {
	t.Helper()
	if _, err := a.db.Exec("INSERT INTO subscription_fetches(at,profile,member,ip,ua,format,status) VALUES(?,?,?,?,?,?,?)",
		at.UTC().Format(time.RFC3339), "profile-a", member, ip, ua, "clash", status); err != nil {
		t.Fatal(err)
	}
}

func TestDeviceWindow(t *testing.T) {
	at := time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC)
	from, to := deviceWindow(Member{ResetDay: 0}, at)
	if !from.Equal(at.AddDate(0, 0, -30)) || !to.Equal(at) {
		t.Fatalf("rolling window = %v..%v", from, to)
	}
	from, to = deviceWindow(Member{ResetDay: 15}, at)
	wantFrom := time.Date(2026, 10, 14, 16, 0, 0, 0, time.UTC) // 2026-10-15 00:00 +08
	wantTo := time.Date(2026, 11, 14, 16, 0, 0, 0, time.UTC)   // 2026-11-15 00:00 +08
	if !from.Equal(wantFrom) || !to.Equal(wantTo) {
		t.Fatalf("billing window = %v..%v, want %v..%v", from, to, wantFrom, wantTo)
	}
}

func TestCountDistinctDevices(t *testing.T) {
	a := testApp(t)
	now := time.Now().Add(-time.Minute)
	// One client across two proxy egress addresses is still one device.
	insertFetch(t, a, now, "member-a", "203.0.113.1", "ClashMeta/1.0", 200)
	insertFetch(t, a, now, "member-a", "203.0.113.1", "ClashMeta/1.0", 200)
	insertFetch(t, a, now, "member-a", "203.0.113.1", "Stash/2.0", 200)
	// A second client family counts as another device even from the same IP.
	insertFetch(t, a, now, "member-a", "203.0.113.2", "ClashMeta/1.0", 200)
	// Browser previews and empty user agents are not subscription clients.
	insertFetch(t, a, now, "member-a", "203.0.113.9", "", 200)
	insertFetch(t, a, now, "member-a", "203.0.113.10", "Mozilla/5.0 AppleWebKit/537.36 Chrome/135.0 Safari/537.36", 200)
	insertFetch(t, a, now, "member-a", "203.0.113.11", "QQUrlRichService/1.0", 200)
	// Failures, other members and out-of-window rows never count.
	insertFetch(t, a, now, "member-a", "203.0.113.3", "ClashMeta/1.0", 410)
	insertFetch(t, a, now, "member-b", "203.0.113.4", "ClashMeta/1.0", 200)
	insertFetch(t, a, now.AddDate(0, 0, -31), "member-a", "203.0.113.5", "ClashMeta/1.0", 200)

	from, to := deviceWindow(Member{}, now.Add(time.Minute))
	n, err := a.countDistinctDevices("member-a", from, to)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("distinct devices = %d, want 2", n)
	}
	groups, err := a.deviceGroups("member-a", from, to)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 2 {
		t.Fatalf("groups = %d, want 2", len(groups))
	}
	for _, g := range groups {
		if g.Client == "Clash" && (g.Fetches != 3 || g.SourceIPCount != 2) {
			t.Fatalf("proxy IP churn must collapse into one client group, got %+v", g)
		}
	}
}

func TestSubscriptionClientName(t *testing.T) {
	for ua, want := range map[string]string{
		"clash-verge/v2.5.8":                          "Clash Verge",
		"ClashMetaForAndroid/2.11.31.Meta":            "Clash Meta for Android",
		"Stash/2.0":                                   "Stash",
		"sing-box 1.12.0":                             "sing-box",
		"CustomClient/1.0":                            "其他订阅客户端",
		"CustomClient/2.0":                            "其他订阅客户端",
		"Mozilla/5.0 AppleWebKit/537.36 Chrome/135.0": "",
		"QQUrlRichService/1.0":                        "",
	} {
		if got, ok := subscriptionClientName(ua); got != want || ok != (want != "") {
			t.Fatalf("client name for %q = %q/%v, want %q", ua, got, ok, want)
		}
	}
}

func TestMemberViewsDeviceEstimate(t *testing.T) {
	a := testApp(t)
	m := Member{ID: "member-a", Name: "Family", Enabled: true}
	if err := a.put("member", m.ID, m); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(-time.Minute)
	insertFetch(t, a, now, "member-a", "203.0.113.1", "ClashMeta/1.0", 200)
	insertFetch(t, a, now, "member-a", "203.0.113.1", "Stash/2.0", 200)
	views := a.memberViews()
	if len(views) != 1 {
		t.Fatalf("views = %d", len(views))
	}
	if views[0].DevicesUsed != 2 || views[0].DeviceOverLimit {
		t.Fatalf("view = devicesUsed %d over %v, want 2/false", views[0].DevicesUsed, views[0].DeviceOverLimit)
	}
}

func TestMemberDeviceLimitValidation(t *testing.T) {
	a := testApp(t)
	base := Member{ID: "member-a", Name: "Family", Enabled: true}
	for _, limit := range []int{-1, 1000} {
		m := base
		m.DeviceLimit = limit
		if w := request(a, "PUT", "/api/admin/member/member-a", m, true); w.Code != 400 {
			t.Fatalf("deviceLimit %d: status = %d, want 400", limit, w.Code)
		}
	}
	// A fractional value must be rejected at decode time, leaving no record.
	w := request(a, "PUT", "/api/admin/member/member-a", map[string]any{"name": "Family", "enabled": true, "deviceLimit": 1.5}, true)
	if w.Code != 400 {
		t.Fatalf("fractional deviceLimit: status = %d, want 400", w.Code)
	}
	// Valid limit saves; client-supplied derived fields are discarded.
	m := base
	m.DeviceLimit, m.DevicesUsed, m.DeviceOverLimit = 2, 99, true
	if w := request(a, "PUT", "/api/admin/member/member-a", m, true); w.Code != 200 {
		t.Fatalf("valid save: status = %d (%s)", w.Code, w.Body.String())
	}
	var stored Member
	if err := a.get("member", "member-a", &stored); err != nil {
		t.Fatal(err)
	}
	if stored.DeviceLimit != 2 || stored.DevicesUsed != 0 || stored.DeviceOverLimit {
		t.Fatalf("stored = %+v", stored)
	}
}

func TestDevicesViewAPI(t *testing.T) {
	a := testApp(t)
	m := Member{ID: "member-a", Name: "Family", Enabled: true, DeviceLimit: 1}
	if err := a.put("member", m.ID, m); err != nil {
		t.Fatal(err)
	}
	now := time.Now().Add(-time.Minute)
	insertFetch(t, a, now, "member-a", "203.0.113.1", "ClashMeta/1.0", 200)
	insertFetch(t, a, now, "member-a", "203.0.113.2", "ClashMeta/1.0", 200)
	insertFetch(t, a, now, "member-a", "203.0.113.3", "Stash/2.0", 200)

	w := request(a, "GET", "/api/admin/subscription-fetches?member=member-a&view=devices", nil, true)
	if w.Code != 200 {
		t.Fatalf("status = %d (%s)", w.Code, w.Body.String())
	}
	var out struct {
		DevicesUsed int           `json:"devicesUsed"`
		Groups      []DeviceGroup `json:"groups"`
	}
	if strings.Contains(w.Body.String(), "deviceLimit") || strings.Contains(w.Body.String(), "deviceOverLimit") {
		t.Fatal("client estimate response still exposes an enforcement threshold")
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.DevicesUsed != 2 || len(out.Groups) != 2 {
		t.Fatalf("view = %+v", out)
	}
	if w := request(a, "GET", "/api/admin/subscription-fetches?member=nobody&view=devices", nil, true); w.Code != 404 {
		t.Fatalf("unknown member: status = %d, want 404", w.Code)
	}
	// The plain fetch list still works alongside the devices view.
	if w := request(a, "GET", "/api/admin/subscription-fetches?member=member-a", nil, true); w.Code != 200 || !strings.Contains(w.Body.String(), "203.0.113.1") {
		t.Fatalf("plain fetch list broken: %d %s", w.Code, w.Body.String())
	}
}
