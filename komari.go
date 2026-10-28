package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// The public monitoring endpoint is deployment configuration. No Komari
// administrator token, agent token, shell or remote control is used.
var komariOrigin = "https://monitor.example.com"

var komariUUID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)

type KomariNode struct {
	UUID         string  `json:"uuid"`
	Name         string  `json:"name"`
	CPUName      string  `json:"cpu_name"`
	CPUCores     int     `json:"cpu_cores"`
	MemoryTotal  int64   `json:"mem_total"`
	DiskTotal    int64   `json:"disk_total"`
	OS           string  `json:"os"`
	Price        float64 `json:"price"`
	Currency     string  `json:"currency"`
	BillingCycle int     `json:"billing_cycle"`
	Expires      string  `json:"expired_at"`
	TrafficLimit int64   `json:"traffic_limit"`
	TrafficMode  string  `json:"traffic_limit_type"`
}

// Asset fields are derived views; they are never copied back into local records.
func komariAssets(s Server, nodes []KomariNode) Server {
	if s.KomariUUID == "" {
		return s
	}
	s.Specs, s.Expires, s.Price, s.Limit = "", "", "", 0
	for _, n := range nodes {
		if n.UUID != s.KomariUUID {
			continue
		}
		parts := []string{}
		if n.CPUCores > 0 {
			parts = append(parts, fmt.Sprintf("%d vCPU", n.CPUCores))
		}
		if n.MemoryTotal > 0 {
			parts = append(parts, fmt.Sprintf("%.2f GiB 内存", float64(n.MemoryTotal)/(1<<30)))
		}
		if n.DiskTotal > 0 {
			parts = append(parts, fmt.Sprintf("%.1f GiB 磁盘", float64(n.DiskTotal)/(1<<30)))
		}
		if n.CPUName != "" {
			parts = append(parts, n.CPUName)
		}
		if n.OS != "" {
			parts = append(parts, n.OS)
		}
		s.Specs = strings.Join(parts, " · ")
		if expiry, err := time.Parse(time.RFC3339Nano, n.Expires); err == nil && expiry.Year() > 1970 {
			s.Expires = expiry.In(time.FixedZone("Asia/Shanghai", 8*60*60)).Format("2006-01-02")
		}
		if n.Price == -1 {
			s.Price = "免费"
		} else if n.Price > 0 && !math.IsInf(n.Price, 0) {
			cycle := map[int]string{1: "天", 7: "周", 30: "月", 90: "季", 180: "半年", 365: "年"}[n.BillingCycle]
			if cycle == "" && n.BillingCycle > 0 {
				cycle = fmt.Sprintf("%d 天", n.BillingCycle)
			}
			s.Price = fmt.Sprintf("%s %g", n.Currency, n.Price)
			if cycle != "" {
				s.Price += " / " + cycle
			}
		}
		if n.TrafficLimit > 0 {
			s.Limit = float64(n.TrafficLimit) / 1e9
		}
		break
	}
	return s
}

type komariReport struct {
	UUID    string `json:"uuid"`
	Updated string `json:"updated_at"`
	CPU     struct {
		Usage *float64 `json:"usage"`
	} `json:"cpu"`
	RAM struct {
		Total int64 `json:"total"`
		Used  int64 `json:"used"`
	} `json:"ram"`
	Disk struct {
		Total int64 `json:"total"`
		Used  int64 `json:"used"`
	} `json:"disk"`
	Network struct {
		Up        int64 `json:"up"`
		Down      int64 `json:"down"`
		TotalUp   int64 `json:"totalUp"`
		TotalDown int64 `json:"totalDown"`
	} `json:"network"`
	// Verified against a live /api/recent sample (2026-10-22): the
	// report carries "connections": {"tcp": n, "udp": n} and a
	// top-level "uptime" in seconds. Both are optional in the payload,
	// hence pointers — absence must not read as a fabricated zero.
	Connections *struct {
		TCP int64 `json:"tcp"`
		UDP int64 `json:"udp"`
	} `json:"connections"`
	Uptime *int64 `json:"uptime"`
}
type KomariMetric struct {
	CPU            *float64 `json:"cpu"`
	Memory         *float64 `json:"memory"`
	Disk           *float64 `json:"disk"`
	UUID           string   `json:"uuid"`
	Name           string   `json:"name"`
	URL            string   `json:"url"`
	Status         string   `json:"status"`
	Error          string   `json:"error,omitempty"`
	Updated        string   `json:"updated"`
	Up             int64    `json:"up"`
	Down           int64    `json:"down"`
	TotalUp        int64    `json:"totalUp"`
	TotalDown      int64    `json:"totalDown"`
	ConnectionsTCP *int64   `json:"connectionsTcp,omitempty"`
	ConnectionsUDP *int64   `json:"connectionsUdp,omitempty"`
	UptimeSeconds  *int64   `json:"uptimeSeconds,omitempty"`
	TrafficLimit   int64    `json:"trafficLimit"`
	TrafficMode    string   `json:"trafficMode"`
	TrafficUsed    *int64   `json:"trafficUsed"`
}
type komariCache struct {
	mu      sync.RWMutex
	nodes   []KomariNode
	metrics map[string]KomariMetric
	fetched time.Time
	err     string
}
type komariView struct {
	URL     string                  `json:"url"`
	Nodes   []KomariNode            `json:"nodes"`
	Metrics map[string]KomariMetric `json:"metrics"`
	Fetched string                  `json:"fetched"`
	Error   string                  `json:"error"`
}
type komariFetch func(context.Context, string, any) error

func fetchKomari(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", komariOrigin+path, nil)
	if err != nil {
		return errors.New("Komari 请求无效")
	}
	client := &http.Client{Timeout: 4 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("暂时无法连接 Komari")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return errors.New("Komari 暂不可读，请检查站点访问设置")
	}
	var envelope struct {
		Status string          `json:"status"`
		Data   json.RawMessage `json:"data"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&envelope) != nil || envelope.Status != "success" || json.Unmarshal(envelope.Data, out) != nil {
		return errors.New("Komari 返回了不兼容的数据")
	}
	return nil
}
func latestKomari(node KomariNode, reports []komariReport, at time.Time) KomariMetric {
	v := KomariMetric{UUID: node.UUID, Name: node.Name, URL: komariOrigin + "/instance/" + node.UUID, Status: "unknown"}
	v.TrafficLimit, v.TrafficMode = max(0, node.TrafficLimit), node.TrafficMode
	var latest time.Time
	for _, r := range reports {
		t, err := time.Parse(time.RFC3339Nano, r.Updated)
		if err != nil || r.UUID != node.UUID || t.After(at.Add(30*time.Second)) || !t.After(latest) {
			continue
		}
		if r.Network.Up < 0 || r.Network.Down < 0 || r.Network.TotalUp < 0 || r.Network.TotalDown < 0 {
			continue
		}
		latest = t
		v.Updated = r.Updated
		v.Up = r.Network.Up
		v.Down = r.Network.Down
		v.TotalUp = r.Network.TotalUp
		v.TotalDown = r.Network.TotalDown
		v.CPU, v.Memory, v.Disk = nil, nil, nil
		if r.CPU.Usage != nil && !math.IsNaN(*r.CPU.Usage) && !math.IsInf(*r.CPU.Usage, 0) && *r.CPU.Usage >= 0 && *r.CPU.Usage <= 100 {
			n := *r.CPU.Usage
			v.CPU = &n
		}
		if r.RAM.Total > 0 && r.RAM.Used >= 0 && r.RAM.Used <= r.RAM.Total {
			n := float64(r.RAM.Used) / float64(r.RAM.Total) * 100
			v.Memory = &n
		}
		if r.Disk.Total > 0 && r.Disk.Used >= 0 && r.Disk.Used <= r.Disk.Total {
			n := float64(r.Disk.Used) / float64(r.Disk.Total) * 100
			v.Disk = &n
		}
		v.ConnectionsTCP, v.ConnectionsUDP, v.UptimeSeconds = nil, nil, nil
		if r.Connections != nil && r.Connections.TCP >= 0 && r.Connections.UDP >= 0 {
			tcp, udp := r.Connections.TCP, r.Connections.UDP
			v.ConnectionsTCP, v.ConnectionsUDP = &tcp, &udp
		}
		if r.Uptime != nil && *r.Uptime >= 0 {
			up := *r.Uptime
			v.UptimeSeconds = &up
		}
	}
	if latest.IsZero() {
		v.Error = "暂无有效探针记录"
		return v
	}
	var used int64
	switch v.TrafficMode {
	case "sum":
		if v.TotalUp <= math.MaxInt64-v.TotalDown {
			used = v.TotalUp + v.TotalDown
			v.TrafficUsed = &used
		}
	case "up":
		used = v.TotalUp
		v.TrafficUsed = &used
	case "down":
		used = v.TotalDown
		v.TrafficUsed = &used
	case "max":
		used = max(v.TotalUp, v.TotalDown)
		v.TrafficUsed = &used
	case "min":
		used = min(v.TotalUp, v.TotalDown)
		v.TrafficUsed = &used
	}
	v.Status = "online"
	if at.Sub(latest) > 90*time.Second {
		v.Status = "stale"
		v.Up = 0
		v.Down = 0
	}
	return v
}
func (a *App) refreshKomari(ctx context.Context, fetch komariFetch) {
	ids := map[string]bool{}
	for _, raw := range a.list("server") {
		var s Server
		if json.Unmarshal(raw, &s) == nil && komariUUID.MatchString(s.KomariUUID) {
			ids[s.KomariUUID] = true
		}
	}
	var nodes []KomariNode
	err := fetch(ctx, "/api/nodes", &nodes)
	metrics := map[string]KomariMetric{}
	if err == nil {
		safe := []KomariNode{}
		var wg sync.WaitGroup
		var mu sync.Mutex
		workers := make(chan struct{}, 4)
		seen := map[string]bool{}
		for _, n := range nodes {
			if !komariUUID.MatchString(n.UUID) || len(n.Name) > 200 || seen[n.UUID] {
				continue
			}
			seen[n.UUID] = true
			safe = append(safe, n)
			if !ids[n.UUID] {
				continue
			}
			wg.Add(1)
			go func(n KomariNode) {
				defer wg.Done()
				select {
				case workers <- struct{}{}:
				case <-ctx.Done():
					return
				}
				defer func() { <-workers }()
				var records []komariReport
				e := fetch(ctx, "/api/recent/"+n.UUID, &records)
				v := latestKomari(n, records, time.Now())
				if e != nil {
					v.Error = e.Error()
					v.Status = "unknown"
				}
				mu.Lock()
				metrics[n.UUID] = v
				mu.Unlock()
			}(n)
		}
		wg.Wait()
		nodes = safe
	}
	a.komari.mu.Lock()
	defer a.komari.mu.Unlock()
	a.komari.fetched = time.Now()
	a.komari.err = ""
	if err != nil {
		a.komari.err = err.Error()
		for k, v := range a.komari.metrics {
			v.Status = "unknown"
			v.Error = err.Error()
			v.Up = 0
			v.Down = 0
			a.komari.metrics[k] = v
		}
		return
	}
	a.komari.nodes = nodes
	a.komari.metrics = metrics
}
func (a *App) komariOverview() komariView {
	a.komari.mu.RLock()
	defer a.komari.mu.RUnlock()
	v := komariView{URL: komariOrigin, Nodes: append([]KomariNode{}, a.komari.nodes...), Metrics: map[string]KomariMetric{}, Error: a.komari.err}
	if !a.komari.fetched.IsZero() {
		v.Fetched = a.komari.fetched.UTC().Format(time.RFC3339)
	}
	for k, m := range a.komari.metrics {
		t, err := time.Parse(time.RFC3339Nano, m.Updated)
		if m.Status == "online" && (err != nil || time.Since(t) > 90*time.Second || time.Since(a.komari.fetched) > 90*time.Second) {
			m.Status = "stale"
			m.Up = 0
			m.Down = 0
		}
		v.Metrics[k] = m
	}
	return v
}
func (a *App) startKomari(ctx context.Context) {
	go func() {
		timer := time.NewTicker(5 * time.Second)
		defer timer.Stop()
		for {
			work, cancel := context.WithTimeout(ctx, 12*time.Second)
			a.refreshKomari(work, fetchKomari)
			cancel()
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			}
		}
	}()
}
func (a *App) komariAPI(w http.ResponseWriter, r *http.Request, path string) bool {
	if path != "komari/bind" || r.Method != "POST" {
		return false
	}
	var in struct {
		ServerID string `json:"serverId"`
		UUID     string `json:"uuid"`
	}
	if decodeBody(r, &in) != nil {
		apiError(w, 400, "请求无效")
		return true
	}
	var s Server
	if a.get("server", in.ServerID, &s) != nil {
		apiError(w, 404, "服务器不存在")
		return true
	}
	if in.UUID != "" {
		found := false
		view := a.komariOverview()
		for _, n := range view.Nodes {
			if n.UUID == in.UUID {
				found = true
			}
		}
		if !found || view.Error != "" || time.Since(a.komariFetched()) > 90*time.Second {
			apiError(w, 409, "Komari 节点列表不可用，请稍后重试")
			return true
		}
		for _, raw := range a.list("server") {
			var other Server
			json.Unmarshal(raw, &other)
			if other.ID != s.ID && other.KomariUUID == in.UUID {
				apiError(w, 409, "该探针已关联另一台服务器")
				return true
			}
		}
	}
	s.KomariUUID = in.UUID
	if a.put("server", s.ID, s) != nil {
		apiError(w, 500, "关联保存失败")
		return true
	}
	a.audit("komari.bind", s.ID)
	writeJSON(w, 200, map[string]bool{"ok": true})
	return true
}
func (a *App) komariFetched() time.Time {
	a.komari.mu.RLock()
	defer a.komari.mu.RUnlock()
	return a.komari.fetched
}
