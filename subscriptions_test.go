package main

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func saveSubscriptionTest(t *testing.T, a *App, s Subscription) {
	t.Helper()
	if w := request(a, "PUT", "/api/admin/subscription/"+s.ID, s, true); w.Code != 200 {
		t.Fatalf("save subscription: %d %s", w.Code, w.Body.String())
	}
}
func saveMemberTest(t *testing.T, a *App, m Member) {
	t.Helper()
	if w := request(a, "PUT", "/api/admin/member/"+m.ID, m, true); w.Code != 200 {
		t.Fatalf("save member: %d %s", w.Code, w.Body.String())
	}
}

func TestSubscriptionFirstUnionAndStableLinks(t *testing.T) {
	a := testApp(t)
	for _, id := range []string{"a", "b", "c"} {
		n := Node{ID: id, Name: "Node " + id, Host: "example.test", Port: 443, Protocol: "VLESS", Security: "none", Enabled: true}
		a.put("node", id, n)
		a.secret("node_secret", id, token())
	}
	s := Subscription{ID: "asia", Name: "Asia", NodeIDs: []string{"a", "b"}}
	saveSubscriptionTest(t, a, s)
	if len(a.list("member")) != 0 {
		t.Fatal("subscription needs a user")
	}
	saveSubscriptionTest(t, a, Subscription{ID: "overlap", Name: "Other", NodeIDs: []string{"b", "c"}})
	m := Member{ID: "person", Name: "Person", Enabled: true, SubscriptionIDs: []string{"asia", "overlap", "asia"}, NodeIDs: []string{"untrusted"}}
	saveMemberTest(t, a, m)
	a.get("member", m.ID, &m)
	if !reflect.DeepEqual(m.NodeIDs, []string{"a", "b", "c"}) || len(m.SubscriptionIDs) != 2 {
		t.Fatal("union or deduplication wrong")
	}
	p := Profile{ID: "personal", Name: "Personal", MemberID: m.ID, Format: "clash", FollowMemberNodes: true}
	if w := request(a, "PUT", "/api/admin/profile/"+p.ID, p, true); w.Code != 200 {
		t.Fatal(w.Code)
	}
	link := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	s.NodeIDs = []string{"b"}
	saveSubscriptionTest(t, a, s)
	a.get("member", m.ID, &m)
	if !reflect.DeepEqual(m.NodeIDs, []string{"b", "c"}) {
		t.Fatal("subscription removal lost overlap")
	}
	w := request(a, "GET", link, nil, false)
	if w.Code != 200 || strings.Contains(w.Body.String(), "Node a") || !strings.Contains(w.Body.String(), "Node c") {
		t.Fatal("link changed or stale assignment exported")
	}
	s.NodeIDs = []string{"a", "b"}
	saveSubscriptionTest(t, a, s)
	if !strings.Contains(request(a, "GET", link, nil, false).Body.String(), "Node a") {
		t.Fatal("added subscription node not exported")
	}
	// Removing all subscriptions explicitly must not retain stale posted node IDs.
	m.SubscriptionIDs = []string{}
	saveMemberTest(t, a, m)
	a.get("member", m.ID, &m)
	if len(m.NodeIDs) != 0 || request(a, "GET", link, nil, false).Code == 200 {
		t.Fatal("cleared assignment retained access")
	}
	m.SubscriptionIDs = []string{"asia"}
	saveMemberTest(t, a, m)
	if request(a, "GET", link, nil, false).Code != 200 {
		t.Fatal("reassignment rotated token")
	}
}

func TestSubscriptionReferencesAndAtomicRollback(t *testing.T) {
	a := testApp(t)
	n, m, p := fixture(t, a)
	s := Subscription{ID: "collection", Name: "Collection", NodeIDs: []string{n.ID}}
	saveSubscriptionTest(t, a, s)
	m.SubscriptionIDs = []string{s.ID}
	saveMemberTest(t, a, m)
	p.FollowMemberNodes = true
	a.put("profile", p.ID, p)
	for _, target := range []string{"subscription/" + s.ID, "node/" + n.ID} {
		if request(a, "DELETE", "/api/admin/"+target, nil, true).Code != 409 {
			t.Fatal("referenced record deleted")
		}
	}
	if request(a, "PUT", "/api/admin/subscription/bad", Subscription{ID: "bad", Name: "bad", NodeIDs: []string{"absent"}}, true).Code != 400 {
		t.Fatal("missing node accepted")
	}
	m.SubscriptionIDs = []string{"absent"}
	if request(a, "PUT", "/api/admin/member/"+m.ID, m, true).Code != 400 {
		t.Fatal("missing subscription accepted")
	}
	if request(a, "PUT", "/api/admin/subscription/anonymous", s, false).Code != 401 {
		t.Fatal("anonymous mutation accepted")
	}
	a.db.Exec("CREATE TRIGGER reject_profile_edit BEFORE UPDATE ON records WHEN OLD.kind='profile' BEGIN SELECT RAISE(ABORT,'test'); END")
	s.NodeIDs = []string{}
	if request(a, "PUT", "/api/admin/subscription/"+s.ID, s, true).Code != 400 {
		t.Fatal("profile failure not propagated")
	}
	a.get("subscription", s.ID, &s)
	a.get("member", m.ID, &m)
	if len(s.NodeIDs) != 1 || len(m.NodeIDs) != 1 {
		t.Fatal("failed reconciliation partially committed")
	}
	a.db.Exec("DROP TRIGGER reject_profile_edit")
	// An older client omitting subscriptionIds cannot bypass subscriptions.
	m.SubscriptionIDs = nil
	m.NodeIDs = []string{}
	saveMemberTest(t, a, m)
	a.get("member", m.ID, &m)
	if len(m.SubscriptionIDs) != 1 || len(m.NodeIDs) != 1 {
		t.Fatal("old client detached subscription authorization")
	}
}

func TestExplicitNodeAllocationSurvivesCollectionEditsAndRestart(t *testing.T) {
	a := testApp(t)
	n, m, p := fixture(t, a)
	other := n
	other.ID, other.Name = "node-other", "Other node"
	a.put("node", other.ID, other)
	a.secret("node_secret", other.ID, token())
	s := Subscription{ID: "shared", Name: "Shared", NodeIDs: []string{n.ID}}
	saveSubscriptionTest(t, a, s)
	m.SubscriptionIDs = []string{s.ID}
	saveMemberTest(t, a, m)
	p.FollowMemberNodes = true
	a.put("profile", p.ID, p)
	link := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	a.get("member", m.ID, &m)
	m.AssignmentMode = "nodes"
	m.NodeIDs = []string{other.ID}
	// Explicit mode wins over the old collection IDs in the posted record.
	saveMemberTest(t, a, m)
	a.get("member", m.ID, &m)
	if m.SubscriptionIDs != nil || !reflect.DeepEqual(m.NodeIDs, []string{other.ID}) {
		t.Fatal("manual allocation was replaced by collection nodes")
	}
	s.NodeIDs = []string{}
	saveSubscriptionTest(t, a, s)
	if w := request(a, "GET", link, nil, false); w.Code != 200 || !strings.Contains(w.Body.String(), other.Name) || strings.Contains(w.Body.String(), n.Name) {
		t.Fatal("manual profile did not follow the new allocation")
	}
	// Older clients may omit the new mode without losing node allocations.
	m.AssignmentMode = ""
	saveMemberTest(t, a, m)
	a.db.Close()
	reopened, err := newApp(a.dir, a.origin)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	reopened.get("member", m.ID, &m)
	if m.AssignmentMode != "nodes" || m.SubscriptionIDs != nil || len(reopened.list("subscription")) != 1 || request(reopened, "GET", link, nil, false).Code != 200 {
		t.Fatal("restart migrated an explicit manual allocation")
	}
	b, err := reopened.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	destination := testApp(t)
	if err := destination.restoreSnapshot(b); err != nil {
		t.Fatal(err)
	}
	var restored Member
	destination.get("member", m.ID, &restored)
	if restored.AssignmentMode != "nodes" || restored.SubscriptionIDs != nil || !reflect.DeepEqual(restored.NodeIDs, []string{other.ID}) {
		t.Fatal("restore changed manual allocation")
	}
	m.AssignmentMode, m.SubscriptionIDs = "subscriptions", []string{s.ID}
	saveMemberTest(t, reopened, m)
	reopened.get("member", m.ID, &m)
	if len(m.NodeIDs) != 0 || request(reopened, "GET", link, nil, false).Code == 200 {
		t.Fatal("switching back retained stale manual nodes")
	}
	m.AssignmentMode = "invalid"
	if request(reopened, "PUT", "/api/admin/member/"+m.ID, m, true).Code != 400 {
		t.Fatal("invalid assignment mode accepted")
	}
}

func TestSharedCollectionHasIndependentPersonalLinks(t *testing.T) {
	a := testApp(t)
	n, m, p := fixture(t, a)
	s := Subscription{ID: "shared", Name: "Shared", NodeIDs: []string{n.ID}}
	saveSubscriptionTest(t, a, s)
	m.SubscriptionIDs = []string{s.ID}
	saveMemberTest(t, a, m)
	p.FollowMemberNodes = true
	a.put("profile", p.ID, p)
	second, secondProfile := m, p
	second.ID, second.Name = "member-b", "Other user"
	secondProfile.ID, secondProfile.MemberID = "profile-b", second.ID
	saveMemberTest(t, a, second)
	a.put("profile", secondProfile.ID, secondProfile)
	firstLink := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	secondLink := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+secondProfile.ID, nil, true))
	if firstLink == secondLink {
		t.Fatal("collection shared a personal download token")
	}
	m.Enabled = false
	saveMemberTest(t, a, m)
	if request(a, "GET", firstLink, nil, false).Code == 200 || request(a, "GET", secondLink, nil, false).Code != 200 {
		t.Fatal("personal access is not isolated")
	}
	s.NodeIDs = []string{}
	saveSubscriptionTest(t, a, s)
	if request(a, "GET", secondLink, nil, false).Code == 200 {
		t.Fatal("collection update did not reach personal links")
	}
	s.NodeIDs = []string{n.ID}
	saveSubscriptionTest(t, a, s)
	if request(a, "GET", secondLink, nil, false).Code != 200 {
		t.Fatal("collection update rotated the personal link")
	}
	if request(a, "POST", "/api/admin/subscriptions/"+secondProfile.ID+"/revoke", nil, true).Code != 200 {
		t.Fatal("personal revoke failed")
	}
	if request(a, "GET", secondLink, nil, false).Code != 404 {
		t.Fatal("revoked personal link still works")
	}
}

func TestSubscriptionMigrationPreservesLegacyIdentity(t *testing.T) {
	a := testApp(t)
	n, m, p := fixture(t, a)
	link := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	beforeSecret, _ := a.readSecret("node_secret", n.ID)
	before := request(a, "GET", link, nil, false).Body.String()
	if err := a.migrateSubscriptions(); err != nil {
		t.Fatal(err)
	}
	a.get("member", m.ID, &m)
	if len(m.SubscriptionIDs) != 1 || !reflect.DeepEqual(m.NodeIDs, []string{n.ID}) || len(a.list("subscription")) != 1 {
		t.Fatal("legacy assignment lost")
	}
	var afterProfile Profile
	a.get("profile", p.ID, &afterProfile)
	if !reflect.DeepEqual(p, afterProfile) {
		t.Fatal("legacy profile changed")
	}
	if after := request(a, "GET", link, nil, false); after.Code != 200 || after.Body.String() != before {
		t.Fatal("migration changed original download")
	}
	a.migrateSubscriptions()
	if len(a.list("subscription")) != 1 {
		t.Fatal("migration not idempotent")
	}
	a.db.Close()
	reopened, err := newApp(a.dir, a.origin)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	afterSecret, _ := reopened.readSecret("node_secret", n.ID)
	if afterSecret != beforeSecret || request(reopened, "GET", link, nil, false).Code != 200 {
		t.Fatal("restart lost identity")
	}
}

func TestSubscriptionIndependentGrantsAndExpiry(t *testing.T) {
	a, f, n, m := setupManaged(t)
	s := Subscription{ID: "shared", Name: "Shared", NodeIDs: []string{n.ID}}
	saveSubscriptionTest(t, a, s)
	m.SubscriptionIDs = []string{s.ID}
	m.Limit = 0
	saveMemberTest(t, a, m)
	m2 := m
	m2.ID = "other"
	saveMemberTest(t, a, m2)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	x, _ := a.managedCredential(m, n)
	y, _ := a.managedCredential(m2, n)
	if x == "" || x == y {
		t.Fatal("shared subscription shared managed user credentials")
	}
	m.Expires = "2000-01-01"
	saveMemberTest(t, a, m)
	a.syncAll(context.Background())
	if len(f.clients) != 2 {
		t.Fatal("expiry did not isolate revocation")
	}
	m.Expires = ""
	saveMemberTest(t, a, m)
	a.syncAll(context.Background())
	if len(f.clients) != 3 {
		t.Fatal("unlimited did not restore access")
	}
	if exp, err := memberExpiry(m.Expires); err != nil || !exp.IsZero() {
		t.Fatal("unlimited expiration invalid")
	}
	if strings.Contains(subscriptionUserinfo(m), "expire=") {
		t.Fatal("unlimited link has expiry header")
	}
	s.NodeIDs = []string{}
	saveSubscriptionTest(t, a, s)
	a.syncAll(context.Background())
	if len(f.clients) != 1 || f.clients["existing-owner"].UUID == "" {
		t.Fatal("subscription edit failed to revoke only managed users")
	}
}

func TestSubscriptionExpiryInclusiveAndClearing(t *testing.T) {
	a := testApp(t)
	_, m, p := fixture(t, a)
	link := issuedPath(t, request(a, "POST", "/api/admin/subscriptions/"+p.ID, nil, true))
	m.Expires = "2000-01-01"
	saveMemberTest(t, a, m)
	if request(a, "GET", link, nil, false).Code != 410 {
		t.Fatal("expired link accepted")
	}
	m.Expires = ""
	saveMemberTest(t, a, m)
	w := request(a, "GET", link, nil, false)
	if w.Code != 200 || strings.Contains(w.Header().Get("Subscription-Userinfo"), "expire=") {
		t.Fatal("clearing expiry not unlimited")
	}
	m.Expires = "2028-02-29"
	boundary, _ := time.Parse(time.RFC3339, "2028-03-01T00:00:00+08:00")
	if checkMember(m, boundary.Add(-time.Nanosecond)) != nil || checkMember(m, boundary) == nil {
		t.Fatal("inclusive Shanghai boundary wrong")
	}
	m.Expires = "2027-02-29"
	if request(a, "PUT", "/api/admin/member/"+m.ID, m, true).Code != 400 {
		t.Fatal("invalid leap day saved")
	}
	m.Enabled = false
	m.Expires = ""
	if checkMember(m, time.Now()) == nil {
		t.Fatal("unlimited bypassed disabled status")
	}
}

func TestSubscriptionBackupCompatibility(t *testing.T) {
	a := testApp(t)
	_, m, _ := fixture(t, a)
	legacy, err := a.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if err := a.migrateSubscriptions(); err != nil {
		t.Fatal(err)
	}
	current, err := a.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range []backupData{legacy, current} {
		destination := testApp(t)
		if err := destination.restoreSnapshot(b); err != nil {
			t.Fatal(err)
		}
		var restored Member
		destination.get("member", m.ID, &restored)
		if len(restored.SubscriptionIDs) != 1 || len(destination.list("subscription")) != 1 {
			t.Fatal("restore lost subscription relationships")
		}
	}
	for i, r := range current.Records {
		if r.Kind == "member" {
			var bad Member
			json.Unmarshal(r.Body, &bad)
			bad.SubscriptionIDs = []string{"missing"}
			current.Records[i].Body, _ = json.Marshal(bad)
		}
	}
	if err := testApp(t).restoreSnapshot(current); err == nil {
		t.Fatal("broken subscription backup accepted")
	}
}
