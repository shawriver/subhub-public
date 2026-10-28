package main

import (
	"encoding/json"
	"sort"
	"time"
)

// Daily traffic rollup (for the overview page's 30-day chart). There is no
// historical daily series anywhere else in the system: Komari only exposes
// cumulative counters, so this rollup samples the counter deltas once per
// worker tick and accumulates them into per-day records. Days before this
// feature shipped simply have no record — nothing is backfilled.
//
// Storage (records KV):
//   - kind "traffic_day", id = Asia/Shanghai date "2006-01-02":
//     {date, up, down, servers: {serverId: {up, down}}, updatedAt} in bytes.
//   - kind "traffic_state", id = "counters":
//     {byServer: {serverId: {uuid, up, down, at}}} — the last cumulative
//     counter baseline each delta was computed against.

type trafficCounter struct {
	Up   int64 `json:"up"`
	Down int64 `json:"down"`
}

type trafficDay struct {
	Date      string                    `json:"date"`
	Up        int64                     `json:"up"`
	Down      int64                     `json:"down"`
	Servers   map[string]trafficCounter `json:"servers"`
	UpdatedAt string                    `json:"updatedAt"`
}

type trafficBaseline struct {
	UUID string `json:"uuid"`
	Up   int64  `json:"up"`
	Down int64  `json:"down"`
	At   string `json:"at"`
}

type trafficState struct {
	ByServer map[string]trafficBaseline `json:"byServer"`
}

// trafficSample is one server's cumulative Komari counters at tick time.
type trafficSample struct {
	ServerID string
	UUID     string
	Up       int64
	Down     int64
}

// computeTrafficDeltas is the pure core of the rollup: given the previous
// counter baselines and the current samples it returns the per-server byte
// deltas to add to the day record, plus the new baselines to persist.
//
//   - A server seen for the first time only establishes its baseline
//     (delta 0): its lifetime cumulative must not land on today.
//   - cur >= prev: delta = cur - prev.
//   - cur < prev (counter reset / probe restart): delta = cur, i.e. only
//     what accumulated since the reset is counted.
//   - A server absent from samples keeps its previous baseline untouched,
//     so its next delta still spans the gap correctly.
func computeTrafficDeltas(prev map[string]trafficBaseline, samples []trafficSample, at time.Time) (map[string]trafficCounter, map[string]trafficBaseline) {
	next := make(map[string]trafficBaseline, len(prev)+len(samples))
	for id, b := range prev {
		next[id] = b
	}
	deltas := map[string]trafficCounter{}
	atText := at.UTC().Format(time.RFC3339)
	for _, s := range samples {
		base, seen := prev[s.ServerID]
		next[s.ServerID] = trafficBaseline{UUID: s.UUID, Up: s.Up, Down: s.Down, At: atText}
		if !seen {
			continue
		}
		du, dd := s.Up-base.Up, s.Down-base.Down
		if s.Up < base.Up {
			du = s.Up
		}
		if s.Down < base.Down {
			dd = s.Down
		}
		if du > 0 || dd > 0 {
			deltas[s.ServerID] = trafficCounter{Up: du, Down: dd}
		}
	}
	return deltas, next
}

// accumulateTraffic folds the current Komari cumulative counters into
// today's traffic_day record. It is called from the worker's minute tick
// while writeMu is held; it must not take writeMu itself.
//
// The whole round is skipped when Komari is unavailable (view.Error set):
// during an outage the cached counters are unreliable, and treating them
// as real samples could zero or skew the baselines. Metrics carrying a
// per-node error are skipped for the same reason — their totals are zero
// placeholders, and baselining against them would make the probe's real
// lifetime cumulative land as one huge delta when it recovers.
//
// Deltas are booked to the Asia/Shanghai date of the tick that observes
// them, so a delta spanning midnight lands entirely on the new day. That
// is an accepted approximation (at most one tick of traffic is affected).
func (a *App) accumulateTraffic() {
	view := a.komariOverview()
	if view.Error != "" {
		return
	}
	serverByUUID := map[string]string{}
	for _, raw := range a.list("server") {
		var s Server
		if json.Unmarshal(raw, &s) == nil && s.KomariUUID != "" {
			serverByUUID[s.KomariUUID] = s.ID
		}
	}
	samples := []trafficSample{}
	for uuid, m := range view.Metrics {
		serverID, ok := serverByUUID[uuid]
		if !ok || m.Error != "" {
			continue
		}
		samples = append(samples, trafficSample{ServerID: serverID, UUID: uuid, Up: m.TotalUp, Down: m.TotalDown})
	}
	if len(samples) == 0 {
		return
	}
	at := time.Now()
	date := at.In(billingZone).Format("2006-01-02")
	var state trafficState
	_ = a.get("traffic_state", "counters", &state) // missing = no baselines yet
	deltas, next := computeTrafficDeltas(state.ByServer, samples, at)
	if len(deltas) > 0 {
		var day trafficDay
		if err := a.get("traffic_day", date, &day); err != nil {
			day = trafficDay{Date: date}
		}
		if day.Servers == nil {
			day.Servers = map[string]trafficCounter{}
		}
		day.Date = date
		for serverID, d := range deltas {
			day.Up += d.Up
			day.Down += d.Down
			c := day.Servers[serverID]
			c.Up += d.Up
			c.Down += d.Down
			day.Servers[serverID] = c
		}
		day.UpdatedAt = at.UTC().Format(time.RFC3339)
		_ = a.put("traffic_day", date, day)
	}
	// The baseline is saved after the day record so a failure mid-round
	// re-counts a tick rather than silently dropping it.
	_ = a.put("traffic_state", "counters", trafficState{ByServer: next})
}

// trafficDaily returns the stored day records in ascending date order,
// capped at the most recent `limit` days, plus the earliest stored date
// ("" when nothing has accumulated yet).
func (a *App) trafficDaily(limit int) ([]trafficDay, string) {
	days := []trafficDay{}
	for _, raw := range a.list("traffic_day") {
		var d trafficDay
		if json.Unmarshal(raw, &d) != nil || d.Date == "" {
			continue
		}
		if d.Servers == nil {
			d.Servers = map[string]trafficCounter{}
		}
		days = append(days, d)
	}
	sort.Slice(days, func(i, j int) bool { return days[i].Date < days[j].Date })
	since := ""
	if len(days) > 0 {
		since = days[0].Date
	}
	if limit > 0 && len(days) > limit {
		days = days[len(days)-limit:]
	}
	return days, since
}

type fetchStats struct {
	Fetches30d         int64 `json:"fetches30d"`
	DistinctIPs30d     int64 `json:"distinctIps30d"`
	DistinctMembers30d int64 `json:"distinctMembers30d"`
}

// fetchStats30d summarizes subscription_fetches over the last 30 days for
// the overview page. A query failure degrades to zeroes; it must never
// fail the overview response as a whole.
func (a *App) fetchStats30d() fetchStats {
	var s fetchStats
	since := time.Now().UTC().AddDate(0, 0, -30).Format(time.RFC3339)
	if err := a.db.QueryRow("SELECT COUNT(*), COUNT(DISTINCT ip), COUNT(DISTINCT member) FROM subscription_fetches WHERE at>=?", since).Scan(&s.Fetches30d, &s.DistinctIPs30d, &s.DistinctMembers30d); err != nil {
		return fetchStats{}
	}
	return s
}
