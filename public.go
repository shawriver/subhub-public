package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Deliberately independent of Server/Node JSON: this endpoint exposes only
// owner-approved status fields, never addresses, notes, identities or secrets.
type PublicMachine struct {
	Name    string   `json:"name"`
	Region  string   `json:"region"`
	Flag    string   `json:"flag"`
	Status  string   `json:"status"`
	Updated string   `json:"updated"`
	CPU     *float64 `json:"cpu"`
	Memory  *float64 `json:"memory"`
	Disk    *float64 `json:"disk"`
	Up      *int64   `json:"up"`
	Down    *int64   `json:"down"`
	// Public counters and quota; connection counts and uptime remain
	// internal monitoring data (owner decision 2026-10-25).
	TotalUp      *int64 `json:"totalUp,omitempty"`
	TotalDown    *int64 `json:"totalDown,omitempty"`
	TrafficLimit int64  `json:"trafficLimit"`
	TrafficUsed  *int64 `json:"trafficUsed,omitempty"`
}

// Public status page settings (records kind "public_page", id
// "settings"). A missing record uses the deployment-level Komari URL.
var defaultKomariURL = komariOrigin

type publicPageSettings struct {
	Enabled   bool   `json:"enabled"`
	KomariURL string `json:"komariUrl"`
}

func (a *App) publicPage() publicPageSettings {
	out := publicPageSettings{Enabled: true, KomariURL: defaultKomariURL}
	var rec struct {
		Enabled   *bool  `json:"enabled"`
		KomariURL string `json:"komariUrl"`
	}
	if err := a.get("public_page", "settings", &rec); err != nil {
		return out
	}
	if rec.Enabled != nil {
		out.Enabled = *rec.Enabled
	}
	if url := strings.TrimSpace(rec.KomariURL); url != "" {
		out.KomariURL = url
	}
	return out
}

// publicSettingsAPI serves GET/POST /api/admin/public-settings.
// The parent wires it into adminAPI's dispatch chain.
func (a *App) publicSettingsAPI(w http.ResponseWriter, r *http.Request, path string) bool {
	if path != "public-settings" {
		return false
	}
	switch r.Method {
	case "GET":
		s := a.publicPage()
		writeJSON(w, 200, map[string]any{"enabled": s.Enabled, "komariUrl": s.KomariURL})
	case "POST":
		var in publicPageSettings
		if decodeBody(r, &in) != nil {
			apiError(w, 400, "请求格式不正确")
			return true
		}
		url, problem := normalizeKomariURL(in.KomariURL)
		if problem != "" {
			apiError(w, 400, "Komari 链接须以 http:// 或 https:// 开头")
			return true
		}
		out := publicPageSettings{Enabled: in.Enabled, KomariURL: url}
		if err := a.put("public_page", "settings", out); err != nil {
			apiError(w, 500, "保存失败")
			return true
		}
		a.audit("public_page.update", "settings")
		writeJSON(w, 200, map[string]any{"enabled": out.Enabled, "komariUrl": out.KomariURL})
	default:
		apiError(w, 405, "method not allowed")
	}
	return true
}

func normalizeKomariURL(value string) (string, string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return komariOrigin, ""
	}
	if len(value) > 500 {
		return "", "Komari 链接过长"
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", "Komari 链接格式不正确"
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed.String(), ""
}

type PublicMember struct {
	LifetimeUsedGB        float64 `json:"lifetimeUsedGb"`
	CycleEnd              string  `json:"cycleEnd,omitempty"`
	ResetDay              int     `json:"resetDay"`
	Name                  string  `json:"name"`
	Profile               string  `json:"profile"`
	Status                string  `json:"status"`
	UsedGB                float64 `json:"usedGb"`
	LimitGB               float64 `json:"limitGb"`
	Expires               string  `json:"expires"`
	AvailableNodes        int     `json:"availableNodes"`
	ConnectionLimit       int     `json:"connectionLimit"`
	ConnectionLimitSource string  `json:"connectionLimitSource"`
	Updated               string  `json:"updated"`
}

func (a *App) publicMember(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		apiError(w, 405, "method not allowed")
		return
	}
	tokenValue := strings.TrimPrefix(r.URL.Path, "/api/public/member/")
	if tokenValue == "" {
		http.NotFound(w, r)
		return
	}
	profile, err := a.subProfile(tokenValue)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	var member Member
	if a.get("member", profile.MemberID, &member) != nil {
		http.NotFound(w, r)
		return
	}
	status := "active"
	if !member.Enabled {
		status = "disabled"
	} else if exp, err := memberExpiry(member.Expires); err != nil {
		status = "invalid"
	} else if !exp.IsZero() && !time.Now().Before(exp) {
		status = "expired"
	} else if member.Limit > 0 && memberQuotaUsed(member) >= member.Limit {
		status = "exhausted"
	}
	available := 0
	for _, node := range loadNodes(a) {
		if node.Enabled && containsID(profile.NodeIDs, node.ID) && containsID(member.NodeIDs, node.ID) {
			available++
		}
	}
	connectionLimit, connectionLimitSource := a.effectiveConnectionLimit(member)
	writeJSON(w, http.StatusOK, PublicMember{Name: member.Name, Profile: profile.Name, Status: status, UsedGB: memberQuotaUsed(member), LifetimeUsedGB: member.Used, CycleEnd: member.CycleEnd, ResetDay: member.ResetDay, LimitGB: member.Limit, Expires: member.Expires, AvailableNodes: available, ConnectionLimit: connectionLimit, ConnectionLimitSource: connectionLimitSource, Updated: now()})
}

func (a *App) publicStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		apiError(w, 405, "method not allowed")
		return
	}
	page := a.publicPage()
	if !page.Enabled {
		apiError(w, 404, "公开状态页已关闭")
		return
	}
	monitor := a.komariOverview()
	rows, err := a.db.Query("SELECT body FROM records WHERE kind='server' ORDER BY id")
	if err != nil {
		apiError(w, 503, "状态暂不可读，请稍后重试")
		return
	}
	defer rows.Close()
	machines := []PublicMachine{}
	for rows.Next() {
		var body []byte
		var server Server
		if rows.Scan(&body) != nil || json.Unmarshal(body, &server) != nil {
			apiError(w, 503, "状态暂不可读，请稍后重试")
			return
		}
		p := PublicMachine{Name: server.Name, Region: server.Region, Flag: server.Flag, Status: "unknown"}
		if m, ok := monitor.Metrics[server.KomariUUID]; ok {
			p.Status, p.Updated = m.Status, m.Updated
			// The quota limit is static node configuration, not a live
			// measurement, so it is safe to show for any known metric.
			p.TrafficLimit = max(0, m.TrafficLimit)
			if m.Status == "online" {
				up, down := m.Up, m.Down
				p.Up, p.Down = &up, &down
				p.CPU, p.Memory, p.Disk = m.CPU, m.Memory, m.Disk
				totalUp, totalDown := m.TotalUp, m.TotalDown
				p.TotalUp, p.TotalDown = &totalUp, &totalDown
				if m.TrafficUsed != nil {
					used := *m.TrafficUsed
					p.TrafficUsed = &used
				}
			}
		}
		machines = append(machines, p)
	}
	if rows.Err() != nil {
		apiError(w, 503, "状态暂不可读，请稍后重试")
		return
	}
	writeJSON(w, 200, map[string]any{"machines": machines, "updatedAt": monitor.Fetched, "refreshSeconds": 5, "monitorAvailable": monitor.Error == "" && monitor.Fetched != "", "komariUrl": page.KomariURL, "disabled": false})
}
