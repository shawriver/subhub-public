package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	nodeProbeTimeout        = 8 * time.Second
	nodeProbeInterval       = 5 * time.Minute
	nodeLatencyAttempt      = 2 * time.Second
	nodeLatencySamples      = 3
	nodeLatencyConcurrency  = 8
	nodeLatencyRequestLimit = 100
	nodeLatencyBatchTimeout = 20 * time.Second
)

type NodeHealth struct {
	NodeID    string `json:"nodeId"`
	State     string `json:"state"`
	LatencyMS int64  `json:"latencyMs,omitempty"`
	Method    string `json:"method,omitempty"`
	Samples   int    `json:"samples,omitempty"`
	CheckedAt string `json:"checkedAt"`
	Detail    string `json:"detail,omitempty"`
}

func (a *App) signalNodeProbe() {
	select {
	case a.probeWake <- struct{}{}:
	default:
	}
}

func (a *App) startNodeProbes(ctx context.Context) {
	go func() {
		timer := time.NewTimer(5 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
			case <-a.probeWake:
				if !timer.Stop() {
					select {
					case <-timer.C:
					default:
					}
				}
			}
			work, cancel := context.WithTimeout(ctx, 45*time.Second)
			a.probeAllNodes(work)
			cancel()
			timer.Reset(nodeProbeInterval)
		}
	}()
}

func (a *App) probeAllNodes(ctx context.Context) {
	nodes := loadNodes(a)
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for _, node := range nodes {
		node := node
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()
			var previous NodeHealth
			_ = a.get("node_probe", node.ID, &previous)
			health := probeNode(ctx, node)
			_ = a.put("node_probe", node.ID, health)
			reconcileNodeAlert(a, node, previous, health)
		}()
	}
	wg.Wait()
}

// reconcileNodeAlert keeps one task record per node. A failed record raises the
// dashboard alert while a node is unreachable; a later success clears it. The
// record is only rewritten when the probe outcome changes.
func reconcileNodeAlert(a *App, node Node, previous, current NodeHealth) {
	alertID := "node-alert-" + node.ID
	var existing Task
	hasAlert := a.get("task", alertID, &existing) == nil && existing.Status == "failed"
	switch {
	case current.State == "unreachable" || current.State == "config_error":
		if hasAlert && previous.State == current.State {
			return
		}
		name := "节点不可达 · " + node.Name
		if current.State == "config_error" {
			name = "节点配置异常 · " + node.Name
		}
		_ = a.put("task", alertID, Task{ID: alertID, Name: name, Kind: "node-alert", Created: now(), Status: "failed", Detail: defaultString(current.Detail, "探测失败") + "；每 5 分钟复查，恢复后自动清除"})
	case !hasAlert:
		return
	case current.State == "disabled":
		_ = a.put("task", alertID, Task{ID: alertID, Name: "节点已停用 · " + node.Name, Kind: "node-alert", Created: now(), Status: "success", Detail: "已从订阅排除，不再产生可用性告警"})
	case current.State == "unverified":
		_ = a.put("task", alertID, Task{ID: alertID, Name: "节点改为客户端验证 · " + node.Name, Kind: "node-alert", Created: now(), Status: "success", Detail: "当前协议无法由控制器直接探测，已停止告警"})
	default:
		_ = a.put("task", alertID, Task{ID: alertID, Name: "节点已恢复 · " + node.Name, Kind: "node-alert", Created: now(), Status: "success", Detail: defaultString(current.Detail, "探测恢复正常")})
	}
}

func probeNode(ctx context.Context, node Node) NodeHealth {
	health := NodeHealth{NodeID: node.ID, CheckedAt: now()}
	if !node.Enabled {
		health.State, health.Detail = "disabled", "节点已停用"
		return health
	}
	if node.Host == "" || node.Port < 1 || node.Port > 65535 {
		health.State, health.Detail = "config_error", "服务器地址或端口不完整"
		return health
	}
	if strings.EqualFold(node.Protocol, "Hysteria2") || strings.EqualFold(node.Transport, "udp") {
		return probeICMP(ctx, node)
	}

	probeCtx, cancel := context.WithTimeout(ctx, nodeProbeTimeout)
	defer cancel()
	samples, successes := sampleTCP(probeCtx, node.Host, node.Port)
	health.Method = "tcp"
	health.Samples = successes
	if successes < 2 {
		health.State, health.Detail = "unreachable", fmt.Sprintf("TCP 握手未稳定成功（%d/%d）", successes, nodeLatencySamples)
		return health
	}
	health.State = "reachable"
	health.LatencyMS = medianLatency(samples)
	health.Detail = fmt.Sprintf("从 SubHub 主机向节点端口发起 %d 次 TCP 握手，取中位数；代理握手未验证", successes)
	return health
}

func sampleTCP(ctx context.Context, host string, port int) ([]int64, int) {
	samples := make([]int64, 0, nodeLatencySamples)
	successes := 0
	address := net.JoinHostPort(host, strconv.Itoa(port))
	for attempt := 0; attempt < nodeLatencySamples; attempt++ {
		if ctx.Err() != nil {
			break
		}
		attemptCtx, cancel := context.WithTimeout(ctx, nodeLatencyAttempt)
		started := time.Now()
		conn, err := (&net.Dialer{}).DialContext(attemptCtx, "tcp", address)
		cancel()
		if err != nil {
			continue
		}
		elapsed := time.Since(started).Milliseconds()
		_ = conn.Close()
		if elapsed < 1 {
			elapsed = 1
		}
		samples = append(samples, elapsed)
		successes++
	}
	return samples, successes
}

func medianLatency(samples []int64) int64 {
	if len(samples) == 0 {
		return 0
	}
	ordered := append([]int64(nil), samples...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i] < ordered[j] })
	return ordered[len(ordered)/2]
}

func probeICMP(ctx context.Context, node Node) NodeHealth {
	health := NodeHealth{NodeID: node.ID, CheckedAt: now(), Method: "icmp"}
	if runtime.GOOS != "linux" {
		health.State, health.Detail = "unverified", "当前运行环境不支持 ICMP 延迟测量"
		return health
	}
	ping, err := exec.LookPath("ping")
	if err != nil {
		health.State, health.Detail = "unverified", "ICMP 工具不可用，UDP/QUIC 节点需客户端验证"
		return health
	}
	probeCtx, cancel := context.WithTimeout(ctx, nodeProbeTimeout)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, ping, "-n", "-q", "-c", strconv.Itoa(nodeLatencySamples), "-i", "0.2", "-W", "2", "--", node.Host)
	output, err := cmd.CombinedOutput()
	if err != nil {
		health.State, health.Detail = "unverified", "ICMP 无响应；UDP/QUIC 节点需客户端验证"
		return health
	}
	latency, ok := parsePingAverage(output)
	if !ok {
		health.State, health.Detail = "unverified", "ICMP 结果无法解析；UDP/QUIC 节点需客户端验证"
		return health
	}
	health.State, health.LatencyMS, health.Samples = "reachable", latency, nodeLatencySamples
	health.Detail = "从 SubHub 主机回显节点 IP，取三次 ICMP 往返平均值；UDP/QUIC 代理握手未验证"
	return health
}

func parsePingAverage(output []byte) (int64, bool) {
	fields := bytes.Fields(output)
	for i, field := range fields {
		if string(field) != "=" || i+1 >= len(fields) {
			continue
		}
		parts := strings.Split(string(fields[i+1]), "/")
		if len(parts) < 2 {
			continue
		}
		value, err := strconv.ParseFloat(parts[1], 64)
		if err != nil {
			return 0, false
		}
		latency := int64(value + 0.5)
		if latency < 1 {
			latency = 1
		}
		return latency, true
	}
	return 0, false
}

func (a *App) nodeLatencyAPI(w http.ResponseWriter, r *http.Request, path string) bool {
	if path != "nodes/latency" {
		return false
	}
	if r.Method != "POST" {
		apiError(w, 405, "method not allowed")
		return true
	}
	var in struct {
		NodeIDs []string `json:"nodeIds"`
	}
	if decodeBody(r, &in) != nil || len(in.NodeIDs) > nodeLatencyRequestLimit {
		apiError(w, 400, "请选择不超过 100 个节点")
		return true
	}
	allNodes := loadNodes(a)
	byID := make(map[string]Node, len(allNodes))
	for _, node := range allNodes {
		byID[node.ID] = node
	}
	seen := map[string]bool{}
	nodes := make([]Node, 0, len(in.NodeIDs))
	if len(in.NodeIDs) == 0 {
		for _, node := range allNodes {
			if node.Enabled {
				nodes = append(nodes, node)
			}
		}
	} else {
		for _, nodeID := range in.NodeIDs {
			if seen[nodeID] {
				continue
			}
			seen[nodeID] = true
			node, ok := byID[nodeID]
			if !ok || !node.Enabled {
				apiError(w, 400, "节点不存在或已停用")
				return true
			}
			nodes = append(nodes, node)
		}
	}
	select {
	case a.nodeLatencyWork <- struct{}{}:
		defer func() { <-a.nodeLatencyWork }()
	default:
		apiError(w, 409, "延迟测试正在进行，请稍后再试")
		return true
	}
	ctx, cancel := context.WithTimeout(r.Context(), nodeLatencyBatchTimeout)
	defer cancel()
	results := make([]NodeHealth, len(nodes))
	sem := make(chan struct{}, nodeLatencyConcurrency)
	var wg sync.WaitGroup
	for i, node := range nodes {
		i, node := i, node
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				results[i] = NodeHealth{NodeID: node.ID, State: "unreachable", CheckedAt: now(), Detail: "延迟测试超时"}
				return
			}
			result := probeNode(ctx, node)
			results[i] = result
			_ = a.put("node_probe", node.ID, result)
		}()
	}
	wg.Wait()
	reachable := 0
	for _, result := range results {
		if result.State == "reachable" {
			reachable++
		}
	}
	a.audit("node.latency.batch", strconv.Itoa(len(results)))
	writeJSON(w, 200, map[string]any{"results": results, "total": len(results), "reachable": reachable, "checkedAt": now()})
	return true
}

func (a *App) nodeHealth() map[string]NodeHealth {
	out := map[string]NodeHealth{}
	for _, raw := range a.list("node_probe") {
		var health NodeHealth
		if json.Unmarshal(raw, &health) == nil && health.NodeID != "" {
			out[health.NodeID] = health
		}
	}
	return out
}
