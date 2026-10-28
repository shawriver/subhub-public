package main

// Phase-2 observe mode (spec item 5). While observe mode is on, the 60s
// sync keeps reading panels and sampling traffic counters, but never
// issues a mutating client call (add/update/del). Every would-be action
// is recorded on the grant itself (latest pending action, shown in the
// admin UI), in the audit log (only when the pending action for a grant
// changes, so the minute-by-minute rounds do not flood it), and as a
// per-round count summary consumed by the sync task detail.
//
// The switch is a records entry (kind "setting", id "sync"). A missing
// record means ON: a fresh install — and a restored backup, since the
// setting is deliberately outside the backup snapshot's kind whitelist —
// starts out observing. Only an explicit admin action turns execution
// on. Turning it off is audited like every other disposition change.

type syncSettings struct {
	ObserveMode bool `json:"observeMode"`
}

func (a *App) observeMode() bool {
	var s syncSettings
	if err := a.get("setting", "sync", &s); err != nil {
		return true
	}
	return s.ObserveMode
}

func (a *App) setObserveMode(on bool) error {
	return a.put("setting", "sync", syncSettings{ObserveMode: on})
}

// noteSyncRound stores the would-be action counts of the latest sync
// round for the sync task detail and the settings API.
func (a *App) noteSyncRound(counts map[string]int) {
	a.obsMu.Lock()
	defer a.obsMu.Unlock()
	a.obsLast = counts
	a.obsLastAt = now()
}

func (a *App) lastSyncRound() (map[string]int, string) {
	a.obsMu.Lock()
	defer a.obsMu.Unlock()
	out := map[string]int{}
	for k, v := range a.obsLast {
		out[k] = v
	}
	return out, a.obsLastAt
}

// noteObserved records one would-be mutating panel action in observe
// mode: bumps the per-round count, stamps the grant, and writes an
// audit entry when the grant's pending action changes.
func (a *App) noteObserved(g *Grant, action string, counts map[string]int) {
	if counts != nil {
		counts[action]++
	}
	if g.Observed != action {
		g.Observed = action
		a.audit("observe.grant."+action, g.MemberID)
	}
	g.ObservedAt = now()
}
