package main

import (
	"context"
	"testing"
)

// executeFixture builds the managed fixture in execute mode with the
// grant active and the remote client present, as stage-2 rigs start.
func executeFixture(t *testing.T) (*App, *mockPanel, Node, Member) {
	t.Helper()
	a, f, n, m := setupObservedPanel(t)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	g := loadGrant(t, a, m, n)
	seedRemoteClient(t, a, f, g)
	if err := a.setObserveMode(false); err != nil {
		t.Fatal(err)
	}
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if g = loadGrant(t, a, m, n); g.State != "active" {
		t.Fatalf("fixture grant should be active, got %q", g.State)
	}
	return a, f, n, m
}

func patchMember(t *testing.T, a *App, id string, fn func(*Member)) Member {
	t.Helper()
	var m Member
	if err := a.get("member", id, &m); err != nil {
		t.Fatal(err)
	}
	fn(&m)
	if err := a.put("member", m.ID, m); err != nil {
		t.Fatal(err)
	}
	return m
}

func removeRemoteClient(f *mockPanel, email string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.clients, email)
}

func TestRevocationReasonQuotaAndRestoreKeepsRecord(t *testing.T) {
	a, f, n, m := executeFixture(t)
	g := loadGrant(t, a, m, n)
	// 12 GB of panel counters against the 10 GB fixture limit.
	f.setTraffic(g.Email, 7_000_000_000, 5_000_000_000)
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	g = loadGrant(t, a, m, n)
	if g.State != "revoked" {
		t.Fatalf("over-quota grant should be revoked, got %q", g.State)
	}
	rev := g.LastRevocation
	if rev == nil {
		t.Fatal("revocation must stamp lastRevocation")
	}
	if rev.Reason != "quota" {
		t.Fatalf("reason = %q, want quota", rev.Reason)
	}
	if rev.At == "" || rev.Limit != 10 || rev.Used < 12 {
		t.Fatalf("snapshot wrong: %+v", rev)
	}
	if g.LastRestore != nil {
		t.Fatal("no restore has happened yet")
	}
	// Raise the limit: the grant must come back, stamp lastRestore, and
	// keep the revocation record as history.
	patchMember(t, a, m.ID, func(mm *Member) { mm.Limit = 20 })
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	g = loadGrant(t, a, m, n)
	if g.State != "active" {
		t.Fatalf("grant should be restored, got %q", g.State)
	}
	if g.LastRestore == nil || g.LastRestore.At == "" {
		t.Fatal("restore must stamp lastRestore")
	}
	if g.LastRevocation == nil || g.LastRevocation.Reason != "quota" {
		t.Fatal("restore must not clear the revocation record")
	}
}

func TestRevocationReasonExpired(t *testing.T) {
	a, _, n, m := executeFixture(t)
	patchMember(t, a, m.ID, func(mm *Member) { mm.Expires = "2020-01-01" })
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	g := loadGrant(t, a, m, n)
	if g.State != "revoked" {
		t.Fatalf("expired grant should be revoked, got %q", g.State)
	}
	if g.LastRevocation == nil || g.LastRevocation.Reason != "expired" {
		t.Fatalf("revocation = %+v, want reason expired", g.LastRevocation)
	}
	if g.LastRevocation.Expires != "2020-01-01" {
		t.Fatalf("snapshot expires = %q, want 2020-01-01", g.LastRevocation.Expires)
	}
}

func TestRevocationReasonManual(t *testing.T) {
	a, _, n, m := executeFixture(t)
	patchMember(t, a, m.ID, func(mm *Member) { mm.Enabled = false })
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	g := loadGrant(t, a, m, n)
	if g.State != "revoked" {
		t.Fatalf("disabled member grant should be revoked, got %q", g.State)
	}
	if g.LastRevocation == nil || g.LastRevocation.Reason != "manual" {
		t.Fatalf("revocation = %+v, want reason manual", g.LastRevocation)
	}
}

func TestRevocationReasonLease(t *testing.T) {
	a, f, n, m := executeFixture(t)
	g := loadGrant(t, a, m, n)
	// The remote client is already gone (its lease lapsed while SubHub
	// was away) and the assignment is then withdrawn: reconciling must
	// record the lease cause, not an active delete.
	removeRemoteClient(f, g.Email)
	patchMember(t, a, m.ID, func(mm *Member) { mm.NodeIDs = nil })
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	g = loadGrant(t, a, m, n)
	if g.State != "revoked" {
		t.Fatalf("grant should be revoked, got %q", g.State)
	}
	if g.LastRevocation == nil || g.LastRevocation.Reason != "lease" {
		t.Fatalf("revocation = %+v, want reason lease", g.LastRevocation)
	}
	for _, call := range f.mutations() {
		if call == "POST clients/del/"+g.Email {
			t.Fatal("no live client existed, so no delete may be issued")
		}
	}
}
