package main

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPackageAndCustomSubscriptionsAreIndependent(t *testing.T) {
	a := testApp(t)
	n, m, p := fixture(t, a)
	second := n
	second.ID, second.Name = "custom-node", "Custom Node"
	a.put("node", second.ID, second)
	a.secret("node_secret", second.ID, token())
	s := Subscription{ID: "plan", Name: "Family package", NodeIDs: []string{n.ID}}
	saveSubscriptionTest(t, a, s)
	m.SubscriptionIDs = []string{s.ID}
	saveMemberTest(t, a, m)
	p.FollowMemberNodes = true
	a.put("profile", p.ID, p)
	link := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	custom := Profile{ID: "custom", Name: "Custom subscription", MemberID: m.ID, Format: "clash", CustomNodes: true, NodeIDs: []string{second.ID}}
	if w := request(a, "PUT", "/api/admin/profile/"+custom.ID, custom, true); w.Code != 200 {
		t.Fatal("custom profile not accepted", w.Code)
	}
	customLink := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+custom.ID, nil, true))
	a.get("member", m.ID, &m)
	if !reflect.DeepEqual(allocationNodes(m), []string{n.ID}) || len(m.NodeIDs) != 2 || !containsID(m.SubscriptionIDs, s.ID) {
		t.Fatal("custom profile replaced the package allocation")
	}
	if w := request(a, "GET", link, nil, false); w.Code != 200 || strings.Contains(w.Body.String(), second.Name) {
		t.Fatal("package subscription inherited custom nodes")
	}
	if w := request(a, "GET", customLink, nil, false); w.Code != 200 || strings.Contains(w.Body.String(), n.Name) {
		t.Fatal("custom subscription inherited package nodes")
	}
	// Package removal retains custom access and its original URL.
	s.NodeIDs = []string{}
	saveSubscriptionTest(t, a, s)
	a.get("member", m.ID, &m)
	if len(allocationNodes(m)) != 0 || !reflect.DeepEqual(m.NodeIDs, []string{second.ID}) ||
		request(a, "GET", customLink, nil, false).Code != 200 || request(a, "GET", link, nil, false).Code == 200 {
		t.Fatal("package edit changed independent custom access")
	}
	b, err := a.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	destination := testApp(t)
	if err = destination.restoreSnapshot(b); err != nil {
		t.Fatal(err)
	}
	var restored Member
	destination.get("member", m.ID, &restored)
	if restored.AllocationNodeIDs == nil || len(allocationNodes(restored)) != 0 || !reflect.DeepEqual(restored.NodeIDs, m.NodeIDs) {
		t.Fatal("snapshot conflated empty base and custom access")
	}
	// Restarts preserve custom-only access with an empty package base.
	a.db.Close()
	reopened, err := newApp(a.dir, a.origin)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	reopened.get("member", m.ID, &m)
	if len(allocationNodes(m)) != 0 || request(reopened, "GET", customLink, nil, false).Code != 200 {
		t.Fatal("restart broadened package access")
	}
	if request(reopened, "DELETE", "/api/admin/profile/"+custom.ID, nil, true).Code != 200 {
		t.Fatal("custom deletion failed")
	}
	reopened.get("member", m.ID, &m)
	if len(m.NodeIDs) != 0 || request(reopened, "GET", customLink, nil, false).Code != 404 {
		t.Fatal("deleting custom subscription retained its access")
	}
}

func TestCustomManagedSubscriptionProvisionAndRevoke(t *testing.T) {
	a, f, n, m := setupManaged(t)
	m.NodeIDs, m.AllocationNodeIDs = []string{}, []string{}
	m.AssignmentMode = "nodes"
	saveMemberTest(t, a, m)
	p := Profile{ID: "custom-managed", Name: "Custom managed", MemberID: m.ID, Format: "clash", NodeIDs: []string{n.ID}, CustomNodes: true}
	if request(a, "PUT", "/api/admin/profile/"+p.ID, p, true).Code != 200 {
		t.Fatal("custom save failed")
	}
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	a.get("member", m.ID, &m)
	credential, err := a.managedCredential(m, n)
	if err != nil || credential == "" {
		t.Fatal("custom node authorization was not provisioned")
	}
	link := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	if request(a, "GET", link, nil, false).Code != 200 {
		t.Fatal("managed custom export failed")
	}
	w := request(a, "POST", "/api/admin/nodes/"+n.ID+"/test", map[string]string{"mode": "latency"}, true)
	var run ProtocolResult
	if w.Code != 202 || json.Unmarshal(w.Body.Bytes(), &run) != nil || run.MemberID != m.ID {
		t.Fatal("one-click managed latency did not select the ready member identity")
	}
	// This fixture has no worker; await its safe unavailable result before DB cleanup.
	deadline := time.Now().Add(3 * time.Second)
	for len(a.protocolWork) > 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(a.protocolWork) != 0 {
		t.Fatal("unavailable worker did not finish")
	}
	if request(a, "DELETE", "/api/admin/profile/"+p.ID, nil, true).Code != 200 {
		t.Fatal("custom deletion failed")
	}
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.clients) != 1 || f.clients["existing-owner"].UUID == "" {
		t.Fatal("custom revocation changed the owner or retained a managed identity")
	}
}

func TestPackageAssignmentIsAtomicAndPreservesOtherAccess(t *testing.T) {
	a := testApp(t)
	n, first, p := fixture(t, a)
	second := first
	second.ID = "member-b"
	a.put("member", second.ID, second)
	s := Subscription{ID: "plan", Name: "Shared package", NodeIDs: []string{n.ID}}
	saveSubscriptionTest(t, a, s)
	p.FollowMemberNodes = true
	a.put("profile", p.ID, p)
	path := "/api/admin/subscriptions/" + s.ID + "/members"
	body := map[string]any{"memberIds": []string{first.ID, second.ID}}
	if request(a, "POST", path, body, false).Code != 401 {
		t.Fatal("anonymous package assignment")
	}
	if request(a, "POST", path, map[string]any{"memberIds": []string{first.ID, "missing"}}, true).Code != 400 {
		t.Fatal("missing member accepted")
	}
	a.db.Exec("CREATE TRIGGER reject_member_update BEFORE UPDATE ON records WHEN OLD.kind='member' AND OLD.id='member-b' BEGIN SELECT RAISE(ABORT,'test'); END")
	if request(a, "POST", path, body, true).Code != 500 {
		t.Fatal("partial package assignment accepted")
	}
	a.get("member", first.ID, &first)
	if containsID(first.SubscriptionIDs, s.ID) {
		t.Fatal("failed assignment partially committed")
	}
	a.db.Exec("DROP TRIGGER reject_member_update")
	if request(a, "POST", path, body, true).Code != 200 {
		t.Fatal("package assignment rejected")
	}
	a.get("member", first.ID, &first)
	a.get("member", second.ID, &second)
	if !containsID(first.SubscriptionIDs, s.ID) || !containsID(second.SubscriptionIDs, s.ID) {
		t.Fatal("package was not shared")
	}
	link := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	// A different package and a custom subscription survive removal.
	other := Subscription{ID: "other", Name: "Other", NodeIDs: []string{n.ID}}
	saveSubscriptionTest(t, a, other)
	first.SubscriptionIDs = append(first.SubscriptionIDs, other.ID)
	saveMemberTest(t, a, first)
	custom := Profile{ID: "custom", Name: "Custom", MemberID: first.ID, Format: "clash", NodeIDs: []string{n.ID}, CustomNodes: true}
	if request(a, "PUT", "/api/admin/profile/custom", custom, true).Code != 200 {
		t.Fatal("custom setup failed")
	}
	if request(a, "POST", path, map[string]any{"memberIds": []string{second.ID}}, true).Code != 200 {
		t.Fatal("unassignment failed")
	}
	a.get("member", first.ID, &first)
	if !reflect.DeepEqual(first.SubscriptionIDs, []string{other.ID}) || request(a, "GET", link, nil, false).Code != 200 {
		t.Fatal("package unassignment changed other packages or the link")
	}
	// Malformed backup metadata cannot grant arbitrary custom access.
	b, err := a.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	for i, r := range b.Records {
		if r.Kind == "member" && r.ID == first.ID {
			var m Member
			json.Unmarshal(r.Body, &m)
			m.NodeIDs = []string{}
			b.Records[i].Body, _ = json.Marshal(m)
		}
	}
	if testApp(t).restoreSnapshot(b) == nil {
		t.Fatal("inconsistent custom backup accepted")
	}
}

func TestCustomSubscriptionFailureDoesNotChangeMemberAccess(t *testing.T) {
	a := testApp(t)
	n, m, _ := fixture(t, a)
	p := Profile{ID: "custom", Name: "Custom", MemberID: m.ID, Format: "clash", CustomNodes: true, NodeIDs: []string{"missing"}}
	if request(a, "PUT", "/api/admin/profile/custom", p, true).Code != 400 {
		t.Fatal("missing custom node accepted")
	}
	p.NodeIDs = []string{n.ID}
	p.FollowMemberNodes = true
	if request(a, "PUT", "/api/admin/profile/custom", p, true).Code != 400 {
		t.Fatal("ambiguous custom allocation accepted")
	}
	p.FollowMemberNodes = false
	a.db.Exec("CREATE TRIGGER reject_custom_member BEFORE UPDATE ON records WHEN OLD.kind='member' BEGIN SELECT RAISE(ABORT,'test'); END")
	if request(a, "PUT", "/api/admin/profile/custom", p, true).Code != 400 {
		t.Fatal("member failure did not roll back custom profile")
	}
	var saved Profile
	if a.get("profile", p.ID, &saved) == nil {
		t.Fatal("custom profile partially committed")
	}
}
