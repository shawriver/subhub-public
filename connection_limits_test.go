package main

import (
	"encoding/json"
	"testing"
)

func intPtr(v int) *int { return &v }

func TestSubscriptionConnectionLimitResolution(t *testing.T) {
	subs := map[string]Subscription{
		"basic":     {ID: "basic", Name: "Basic", ConnectionLimit: 120},
		"family":    {ID: "family", Name: "Family", ConnectionLimit: 360},
		"unlimited": {ID: "unlimited", Name: "Unlimited", ConnectionLimit: 0},
	}
	lookup := func(id string) (Subscription, error) {
		s, ok := subs[id]
		if !ok {
			return s, assertError("missing")
		}
		return s, nil
	}
	if got, err := subscriptionConnectionLimit([]string{"basic", "family"}, lookup); err != nil || got != 360 {
		t.Fatalf("combined default = %d, %v; want 360", got, err)
	}
	if got, err := subscriptionConnectionLimit([]string{"basic", "unlimited"}, lookup); err != nil || got != 0 {
		t.Fatalf("unlimited subscription = %d, %v; want 0", got, err)
	}
}

type assertError string

func (e assertError) Error() string { return string(e) }

func TestMemberConnectionLimitPrecedence(t *testing.T) {
	a := testApp(t)
	s := Subscription{ID: "family", Name: "Family", ConnectionLimit: 240}
	saveSubscriptionTest(t, a, s)
	m := Member{ID: "member-a", Name: "Family", Enabled: true, SubscriptionIDs: []string{s.ID}}
	saveMemberTest(t, a, m)

	views := a.memberViews()
	if len(views) != 1 || views[0].ConnectionLimit != 240 || views[0].ConnectionLimitSource != "subscription" {
		t.Fatalf("subscription default view = %+v", views)
	}

	m.ConnectionLimitOverride = intPtr(100)
	saveMemberTest(t, a, m)
	if got, source := a.effectiveConnectionLimit(m); got != 100 || source != "override" {
		t.Fatalf("override = %d/%s, want 100/override", got, source)
	}

	m.ConnectionLimitOverride = intPtr(0)
	saveMemberTest(t, a, m)
	if got, source := a.effectiveConnectionLimit(m); got != 0 || source != "override" {
		t.Fatalf("unlimited override = %d/%s, want 0/override", got, source)
	}
}

func TestConnectionLimitValidationAndDerivedFields(t *testing.T) {
	a := testApp(t)
	for _, limit := range []int{-1, maxConnectionLimit + 1} {
		s := Subscription{ID: "sub", Name: "Sub", ConnectionLimit: limit}
		if w := request(a, "PUT", "/api/admin/subscription/sub", s, true); w.Code != 400 {
			t.Fatalf("subscription limit %d: status = %d", limit, w.Code)
		}
		m := Member{ID: "member", Name: "Member", ConnectionLimitOverride: intPtr(limit)}
		if w := request(a, "PUT", "/api/admin/member/member", m, true); w.Code != 400 {
			t.Fatalf("member limit %d: status = %d", limit, w.Code)
		}
	}

	body := map[string]any{"name": "Member", "enabled": true, "connectionLimitOverride": 1.5}
	if w := request(a, "PUT", "/api/admin/member/member", body, true); w.Code != 400 {
		t.Fatalf("fractional override: status = %d", w.Code)
	}

	m := Member{ID: "member", Name: "Member", Enabled: true, ConnectionLimitOverride: intPtr(99), ConnectionLimit: 77, ConnectionLimitSource: "spoofed"}
	if w := request(a, "PUT", "/api/admin/member/member", m, true); w.Code != 200 {
		t.Fatalf("valid save: %d %s", w.Code, w.Body.String())
	}
	var stored Member
	if err := a.get("member", "member", &stored); err != nil {
		t.Fatal(err)
	}
	if stored.ConnectionLimit != 0 || stored.ConnectionLimitSource != "" || stored.ConnectionLimitOverride == nil || *stored.ConnectionLimitOverride != 99 {
		t.Fatalf("stored policy = %+v", stored)
	}
}

func TestPublicMemberIncludesConnectionPolicy(t *testing.T) {
	a := testApp(t)
	n, m, p := fixture(t, a)
	s := Subscription{ID: "family", Name: "Family", ConnectionLimit: 320, NodeIDs: []string{n.ID}}
	saveSubscriptionTest(t, a, s)
	m.AssignmentMode = "subscriptions"
	m.SubscriptionIDs = []string{s.ID}
	saveMemberTest(t, a, m)
	link := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	tokenValue := link[len("/sub/"):]
	w := request(a, "GET", "/api/public/member/"+tokenValue, nil, false)
	if w.Code != 200 {
		t.Fatalf("status = %d (%s)", w.Code, w.Body.String())
	}
	var out struct {
		ConnectionLimit       int    `json:"connectionLimit"`
		ConnectionLimitSource string `json:"connectionLimitSource"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.ConnectionLimit != 320 || out.ConnectionLimitSource != "subscription" {
		t.Fatalf("public policy = %+v", out)
	}
}
