package main

import (
	"fmt"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

type SubscriptionFetch struct {
	At      string   `json:"at"`
	Profile string   `json:"profileId"`
	Member  string   `json:"memberId"`
	IP      string   `json:"ip"`
	UA      string   `json:"userAgent"`
	Format  string   `json:"format"`
	Status  int      `json:"status"`
	Flags   []string `json:"flags,omitempty"`
}

// fetchRetentionDays is the single definition of how long subscription
// fetch rows are kept (spec item 4.3). A daily in-process task deletes older
// rows and leaves an audit entry; recordFetch never deletes by age.
const fetchRetentionDays = 90

// Anomaly thresholds (spec item 4.2). Fixed constants for the first version;
// only successful fetches (2xx) count, matching the device-estimate口径.
const (
	anomalyHighFreqMinHits = 10
	anomalyHighFreqWindow  = time.Hour
)

var fetchURLPattern = regexp.MustCompile(`(?i)[a-z][a-z0-9+.-]*://\S+`)

func (a *App) recordFetch(r *http.Request, p Profile, status int, secret string) {
	ip := requestID(r)
	if net.ParseIP(ip) == nil {
		ip = "unknown"
	}
	ua := r.UserAgent()
	if secret != "" {
		ua = strings.ReplaceAll(ua, secret, "[redacted]")
	}
	ua = fetchURLPattern.ReplaceAllString(ua, "[url]")
	ua = strings.Map(func(c rune) rune {
		if unicode.IsControl(c) {
			return ' '
		}
		return c
	}, ua)
	chars := []rune(ua)
	if len(chars) > 200 {
		ua = string(chars[:200])
	}
	format := p.Format
	if !supportedFormat(format) {
		format = "invalid"
	}
	_, _ = a.db.Exec("INSERT INTO subscription_fetches(at,profile,member,ip,ua,format,status) VALUES(?,?,?,?,?,?,?)", now(), p.ID, p.MemberID, ip, ua, format, status)
	// Retention is handled by the daily fetch-retention task (90 days, spec
	// item 4.3) with an audit trail, not on the request path.
}

// deviceWindow is the statistics window for the device estimate, aligned with
// the member's quota cycle: the current billing window when a monthly reset
// day is set, otherwise a rolling 30-day window (spec item 1.3).
func deviceWindow(m Member, at time.Time) (time.Time, time.Time) {
	if m.ResetDay >= 1 && m.ResetDay <= 31 {
		return billingWindow(at, m.ResetDay)
	}
	return at.AddDate(0, 0, -30), at
}

// subscriptionClientName maps a subscription User-Agent to a stable client
// family. Proxy addresses are deliberately not part of device identity: many
// clients fetch through rotating proxy exits, so one device can appear from
// several IPs in a single session. Browser previews are not subscription
// clients and are excluded from the estimate.
func subscriptionClientName(userAgent string) (string, bool) {
	ua := strings.ToLower(strings.TrimSpace(userAgent))
	if ua == "" {
		return "", false
	}
	for _, preview := range []string{"mozilla/", "applewebkit", "qqurlrichservice", "curl/", "wget/", "postmanruntime/", "insomnia/"} {
		if strings.Contains(ua, preview) {
			return "", false
		}
	}
	switch {
	case strings.Contains(ua, "clashmetaforandroid"):
		return "Clash Meta for Android", true
	case strings.Contains(ua, "clashforandroid"):
		return "Clash for Android", true
	case strings.Contains(ua, "clash-verge"):
		return "Clash Verge", true
	case strings.Contains(ua, "clashx"):
		return "ClashX", true
	case strings.Contains(ua, "mihomo"):
		return "Mihomo", true
	case strings.Contains(ua, "shadowrocket"):
		return "Shadowrocket", true
	case strings.Contains(ua, "quantumult"):
		return "Quantumult X", true
	case strings.Contains(ua, "sing-box"):
		return "sing-box", true
	case strings.Contains(ua, "hiddify"):
		return "Hiddify", true
	case strings.Contains(ua, "v2rayng"):
		return "v2rayNG", true
	case strings.Contains(ua, "v2rayn"):
		return "v2rayN", true
	case strings.Contains(ua, "stash"):
		return "Stash", true
	case strings.Contains(ua, "surge"):
		return "Surge", true
	case strings.Contains(ua, "clash"):
		return "Clash", true
	default:
		// Unknown client versions are still one advisory family. Keeping the
		// full UA here would recreate the version-change overcount this
		// estimator is intended to avoid.
		return "其他订阅客户端", true
	}
}

// countDistinctDevices estimates clients as stable subscription-client
// families among successful fetches in the window. It is an estimate only and
// does not try to distinguish two devices running the exact same client.
func (a *App) countDistinctDevices(memberID string, from, to time.Time) (int, error) {
	groups, err := a.deviceGroups(memberID, from, to)
	return len(groups), err
}

type DeviceGroup struct {
	Client        string `json:"client"`
	UA            string `json:"userAgent"`
	Fetches       int    `json:"fetches"`
	SourceIPCount int    `json:"sourceIpCount"`
	LastAt        string `json:"lastAt"`
}

func (a *App) deviceGroups(memberID string, from, to time.Time) ([]DeviceGroup, error) {
	rows, err := a.db.Query("SELECT ip, ua, at FROM subscription_fetches WHERE member=? AND status>=200 AND status<300 AND at>=? AND at<? ORDER BY at ASC, id ASC",
		memberID, from.UTC().Format(time.RFC3339), to.UTC().Format(time.RFC3339))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type aggregate struct {
		group DeviceGroup
		ips   map[string]bool
	}
	byClient := map[string]*aggregate{}
	for rows.Next() {
		var ip, ua, at string
		if err := rows.Scan(&ip, &ua, &at); err != nil {
			return nil, err
		}
		client, ok := subscriptionClientName(ua)
		if !ok {
			continue
		}
		item := byClient[client]
		if item == nil {
			item = &aggregate{group: DeviceGroup{Client: client, UA: ua, LastAt: at}, ips: map[string]bool{}}
			byClient[client] = item
		}
		item.group.Fetches++
		item.group.UA = ua
		item.group.LastAt = at
		item.ips[ip] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]DeviceGroup, 0, len(byClient))
	for _, item := range byClient {
		item.group.SourceIPCount = len(item.ips)
		out = append(out, item.group)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastAt > out[j].LastAt })
	return out, nil
}

type anomalySummary struct {
	HasAnomaly bool
	Rules      []string
	MaxPerHour int // most successful fetches inside any trailing 1h window
}

// memberFetchAnomalies scans the member's successful fetches since `since`
// (ascending) and flags every record whose trailing windows cross the spec
// 4.2 threshold: the record itself is the anchor, looking back one hour for
// successful fetches. Results are computed on read and
// never persisted, so threshold changes take effect immediately and deleted
// synthetic rows leave no stale flags behind.
func (a *App) memberFetchAnomalies(memberID string, since time.Time) (map[int64][]string, anomalySummary, error) {
	rows, err := a.db.Query("SELECT id, at, ua FROM subscription_fetches WHERE member=? AND status>=200 AND status<300 AND at>=? ORDER BY at ASC, id ASC",
		memberID, since.UTC().Format(time.RFC3339))
	if err != nil {
		return nil, anomalySummary{}, err
	}
	defer rows.Close()
	type fetchPoint struct {
		id int64
		at time.Time
	}
	var points []fetchPoint
	for rows.Next() {
		var id int64
		var atText, ua string
		if err := rows.Scan(&id, &atText, &ua); err != nil {
			return nil, anomalySummary{}, err
		}
		if _, ok := subscriptionClientName(ua); !ok {
			continue
		}
		at, err := time.Parse(time.RFC3339, atText)
		if err != nil {
			continue
		}
		points = append(points, fetchPoint{id: id, at: at})
	}
	if err := rows.Err(); err != nil {
		return nil, anomalySummary{}, err
	}
	flags := map[int64][]string{}
	var sum anomalySummary
	leftHour := 0
	for i, p := range points {
		for leftHour < i && !points[leftHour].at.After(p.at.Add(-anomalyHighFreqWindow)) {
			leftHour++
		}
		perHour := i - leftHour + 1
		if perHour > sum.MaxPerHour {
			sum.MaxPerHour = perHour
		}
		var f []string
		if perHour >= anomalyHighFreqMinHits {
			f = append(f, "high_freq")
		}
		if len(f) > 0 {
			flags[p.id] = f
		}
	}
	if len(flags) > 0 {
		sum.HasAnomaly = true
		seen := map[string]bool{}
		for _, f := range flags {
			for _, rule := range f {
				seen[rule] = true
			}
		}
		for _, rule := range []string{"high_freq"} {
			if seen[rule] {
				sum.Rules = append(sum.Rules, rule)
			}
		}
	}
	return flags, sum, nil
}

// memberAnomalySummary condenses memberFetchAnomalies into the derived
// member-view fields (spec items 4.2 and 4.4). A stats failure degrades to
// "no anomaly" rather than failing the member view.
func (a *App) memberAnomalySummary(memberID string, since time.Time) (bool, []string, string) {
	_, sum, err := a.memberFetchAnomalies(memberID, since)
	if err != nil || !sum.HasAnomaly {
		return false, nil, ""
	}
	parts := []string{}
	for _, rule := range sum.Rules {
		switch rule {
		case "high_freq":
			parts = append(parts, fmt.Sprintf("1 小时内拉取 %d 次", sum.MaxPerHour))
		}
	}
	return true, sum.Rules, strings.Join(parts, "；")
}

// cleanupFetchRetention deletes fetch rows older than fetchRetentionDays
// and records the sweep in the audit log (deleted count + cutoff), per spec
// item 4.3. It only ever touches subscription_fetches.
func (a *App) cleanupFetchRetention(at time.Time) (int64, error) {
	cutoff := at.UTC().AddDate(0, 0, -fetchRetentionDays)
	res, err := a.db.Exec("DELETE FROM subscription_fetches WHERE at<?", cutoff.Format(time.RFC3339))
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	a.audit("fetch.retention", fmt.Sprintf("deleted=%d cutoff=%s", n, cutoff.Format(time.RFC3339)))
	return n, nil
}

// recordFetchRetentionTask mirrors recordBackupTask: a same-day success is
// not rewritten every minute, while a later success clears an earlier
// failure so the tasks page never keeps a stale alert.
func (a *App) recordFetchRetentionTask(n int64, err error) {
	if err != nil {
		_ = a.put("task", "fetch-retention-latest", Task{ID: "fetch-retention-latest", Name: "拉取记录清理", Kind: "fetch_retention", Created: now(), Status: "failed", Detail: "清理失败：" + err.Error()})
		return
	}
	var previous Task
	if a.get("task", "fetch-retention-latest", &previous) == nil && previous.Status == "success" && strings.HasPrefix(previous.Created, time.Now().UTC().Format("2006-01-02")) {
		return
	}
	_ = a.put("task", "fetch-retention-latest", Task{ID: "fetch-retention-latest", Name: "拉取记录清理", Kind: "fetch_retention", Created: now(), Status: "success", Detail: fmt.Sprintf("已删除 %d 条 %d 天前的拉取记录，每日自动执行", n, fetchRetentionDays)})
}

// runFetchRetentionIfDue performs the retention sweep at most once per UTC
// day. The codebase has no cron-style scheduler (spec Q3, settled from
// source): periodic work runs on in-process tickers and kind=task records
// are status displays, so the sweep hangs off the worker's minute tick
// exactly like the daily backup — the first tick of a new day runs it.
func (a *App) runFetchRetentionIfDue() {
	var previous Task
	if a.get("task", "fetch-retention-latest", &previous) == nil && strings.HasPrefix(previous.Created, time.Now().UTC().Format("2006-01-02")) {
		return
	}
	n, err := a.cleanupFetchRetention(time.Now())
	a.recordFetchRetentionTask(n, err)
}

func (a *App) fetchAuditAPI(w http.ResponseWriter, r *http.Request, path string) bool {
	if path != "subscription-fetches" {
		return false
	}
	if r.Method != "GET" {
		apiError(w, 405, "method not allowed")
		return true
	}
	if r.URL.Query().Get("view") == "devices" {
		memberID := r.URL.Query().Get("member")
		var m Member
		if memberID == "" || a.get("member", memberID, &m) != nil {
			apiError(w, 404, "用户不存在")
			return true
		}
		from, to := deviceWindow(m, time.Now())
		groups, err := a.deviceGroups(memberID, from, to)
		if err != nil {
			apiError(w, 503, "设备统计暂不可读")
			return true
		}
		writeJSON(w, 200, map[string]any{
			"memberId": memberID, "devicesUsed": len(groups),
			"from": from.UTC().Format(time.RFC3339), "to": to.UTC().Format(time.RFC3339),
			"groups": groups,
		})
		return true
	}
	member := r.URL.Query().Get("member")
	since := time.Now().UTC().AddDate(0, 0, -30)
	rows, err := a.db.Query("SELECT id,at,profile,member,ip,ua,format,status FROM subscription_fetches WHERE (?='' OR member=?) AND at>=? ORDER BY id DESC LIMIT 100", member, member, since.Format(time.RFC3339))
	if err != nil {
		apiError(w, 503, "拉取记录暂不可读")
		return true
	}
	defer rows.Close()
	out := []SubscriptionFetch{}
	ids := []int64{}
	for rows.Next() {
		var id int64
		var v SubscriptionFetch
		if rows.Scan(&id, &v.At, &v.Profile, &v.Member, &v.IP, &v.UA, &v.Format, &v.Status) == nil {
			ids = append(ids, id)
			out = append(out, v)
		}
	}
	rows.Close()
	// Anomaly flags are computed over each shown member's full 30-day
	// history (not just the displayed page) so trailing windows are exact.
	members := map[string]bool{}
	for _, v := range out {
		members[v.Member] = true
	}
	flagByID := map[int64][]string{}
	for memberID := range members {
		if flags, _, err := a.memberFetchAnomalies(memberID, since); err == nil {
			for id, f := range flags {
				flagByID[id] = f
			}
		}
	}
	for i, id := range ids {
		if f := flagByID[id]; len(f) > 0 {
			out[i].Flags = f
		}
	}
	writeJSON(w, 200, out)
	return true
}
