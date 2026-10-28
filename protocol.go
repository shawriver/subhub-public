package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

type ProtocolResult struct {
	RunID      string  `json:"runId,omitempty"`
	NodeName   string  `json:"nodeName,omitempty"`
	NodeID     string  `json:"nodeId"`
	MemberID   string  `json:"memberId,omitempty"`
	Mode       string  `json:"mode"`
	State      string  `json:"state"`
	CheckedAt  string  `json:"checkedAt"`
	LatencyMS  int64   `json:"latencyMs,omitempty"`
	DownMbps   float64 `json:"downMbps,omitempty"`
	Bytes      int64   `json:"bytes"`
	EgressIP   string  `json:"egressIp,omitempty"`
	Detail     string  `json:"detail"`
	Source     string  `json:"source"`
	ConfigHash string  `json:"configHash,omitempty"`
}

// Historical samples contain only result fields, never credentials or their hash.
func (a *App) recordProtocolHistory(result ProtocolResult) error {
	result.ConfigHash = ""
	key := fmt.Sprintf("%020d-%s", time.Now().UnixNano(), id())
	if err := a.put("node_test_history", key, result); err != nil {
		return err
	}
	cutoff := time.Now().AddDate(0, 0, -30).UTC().Format(time.RFC3339)
	_, err := a.db.Exec(`DELETE FROM records WHERE kind='node_test_history' AND
		(json_extract(body,'$.checkedAt') < ? OR id NOT IN
		(SELECT id FROM records WHERE kind='node_test_history' ORDER BY id DESC LIMIT 500))`, cutoff)
	return err
}

func (a *App) protocolHistory(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		apiError(w, 405, "method not allowed")
		return
	}
	rows, err := a.db.Query(`SELECT body FROM records WHERE kind='node_test_history'
		AND json_extract(body,'$.checkedAt') >= ?
		AND (? = '' OR json_extract(body,'$.nodeId') = ?)
		ORDER BY id DESC LIMIT 100`, time.Now().AddDate(0, 0, -30).UTC().Format(time.RFC3339), r.URL.Query().Get("node"), r.URL.Query().Get("node"))
	if err != nil {
		apiError(w, 503, "暂时无法读取测试历史")
		return
	}
	defer rows.Close()
	out := []ProtocolResult{}
	for rows.Next() {
		var raw []byte
		var v ProtocolResult
		if rows.Scan(&raw) != nil || json.Unmarshal(raw, &v) != nil {
			continue
		}
		v.ConfigHash = ""
		out = append(out, v)
	}
	if rows.Err() != nil {
		apiError(w, 503, "暂时无法读取测试历史")
		return
	}
	writeJSON(w, 200, out)
}

type protocolRequest struct {
	Node Node   `json:"node"`
	Mode string `json:"mode"`
}

// resolveInstanceName implements the source-label priority chain (spec item
// 3.2): an explicit launch-time name (flag -instance-name or env
// SUBHUB_INSTANCE_NAME) wins, then the OS hostname, then the neutral
// fallback 本机. There is deliberately no stored site-name setting in the
// backend — the setup table only holds one-time setup tokens and the
// branding name lives in the browser — so the chain starts at the
// launch-time override (spec Q2, settled from source).
func resolveInstanceName(explicit string) string {
	if name := strings.TrimSpace(explicit); name != "" {
		return name
	}
	if host, err := os.Hostname(); err == nil && strings.TrimSpace(host) != "" {
		return strings.TrimSpace(host)
	}
	return "本机"
}

// probeSourceLabel names the instance actually running the test instead of a
// hardcoded location, so test instances on other hosts stop claiming to be
// Fremont. The label is stamped by the main process when the node_test
// record is created; the probe worker never rewrites it.
func (a *App) probeSourceLabel() string {
	name := a.instanceName
	if name == "" {
		name = resolveInstanceName("")
	}
	return name + " → 所选节点 → 测试站"
}

func protocolConfigHash(n Node) string {
	b, _ := json.Marshal(n)
	return hash(string(b))
}

func (a *App) protocolIdentityHash(n Node, memberID string) string {
	var err error
	if memberID != "" {
		var m Member
		if a.get("member", memberID, &m) != nil || !containsID(m.NodeIDs, n.ID) || checkMember(m, time.Now()) != nil {
			return "unavailable"
		}
		if n.PanelID != "" {
			n.Credential, err = a.managedCredential(m, n)
		} else {
			n.Credential, err = a.readSecret("node_secret", n.ID)
		}
	} else {
		n.Credential, err = a.readSecret("node_secret", n.ID)
	}
	if err != nil {
		return "unavailable"
	}
	return protocolConfigHash(n)
}

func (a *App) protocolResults() map[string]ProtocolResult {
	out := map[string]ProtocolResult{}
	for _, raw := range a.list("node_test") {
		var v ProtocolResult
		if json.Unmarshal(raw, &v) != nil {
			continue
		}
		var n Node
		if a.get("node", v.NodeID, &n) != nil {
			continue
		}
		if a.protocolIdentityHash(n, v.MemberID) != v.ConfigHash {
			v.State = "stale"
			v.Detail = "节点配置已修改，请重新验证"
		}
		if v.State == "running" {
			at, _ := time.Parse(time.RFC3339, v.CheckedAt)
			if time.Since(at) > time.Minute {
				v.State = "interrupted"
				v.Detail = "测试中断，请重试"
			}
		}
		v.ConfigHash = ""
		out[v.NodeID] = v
	}
	return out
}

func (a *App) callProtocolWorker(ctx context.Context, request protocolRequest) (ProtocolResult, error) {
	var result ProtocolResult
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", a.probeSocket)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 45 * time.Second}
	body, _ := json.Marshal(request)
	req, err := http.NewRequestWithContext(ctx, "POST", "http://probe/test", bytes.NewReader(body))
	if err != nil {
		return result, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return result, errors.New("协议测试服务不可用，请检查测试服务")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return result, errors.New("协议测试服务繁忙或拒绝请求")
	}
	if json.NewDecoder(io.LimitReader(res.Body, 16384)).Decode(&result) != nil {
		return result, errors.New("协议测试返回无效结果")
	}
	return result, nil
}

func (a *App) protocolAPI(w http.ResponseWriter, r *http.Request, path string) bool {
	if path == "node-test-history" {
		a.protocolHistory(w, r)
		return true
	}
	parts := strings.Split(path, "/")
	if len(parts) != 3 || parts[0] != "nodes" || parts[2] != "test" {
		return false
	}
	if r.Method == "GET" {
		if result, ok := a.protocolResults()[parts[1]]; ok {
			writeJSON(w, 200, result)
		} else {
			apiError(w, 404, "暂无测试记录")
		}
		return true
	}
	if r.Method == "DELETE" {
		var in struct {
			RunID string `json:"runId"`
		}
		if decodeBody(r, &in) != nil || in.RunID == "" {
			apiError(w, 400, "请指定要停止的测试")
			return true
		}
		a.protocolMu.Lock()
		defer a.protocolMu.Unlock()
		if a.protocolCancel == nil || a.protocolNode != parts[1] || a.protocolRun != in.RunID {
			apiError(w, 409, "该测试已结束或已被替换")
			return true
		}
		a.protocolCancel()
		a.audit("node.test.cancel", parts[1])
		writeJSON(w, 202, map[string]bool{"cancelled": true})
		return true
	}
	if r.Method != "POST" {
		apiError(w, 405, "method not allowed")
		return true
	}
	var in struct {
		Mode     string `json:"mode"`
		MemberID string `json:"memberId"`
	}
	if decodeBody(r, &in) != nil || in.Mode != "latency" {
		apiError(w, 400, "仅支持延迟测试")
		return true
	}
	var n Node
	if a.get("node", parts[1], &n) != nil || !n.Enabled {
		apiError(w, 404, "节点不存在或已停用")
		return true
	}
	var secret string
	var err error
	if in.MemberID != "" {
		var m Member
		if a.get("member", in.MemberID, &m) != nil || !containsID(m.NodeIDs, n.ID) || checkMember(m, time.Now()) != nil {
			apiError(w, 400, "该用户当前无权使用此节点")
			return true
		}
		if n.PanelID != "" {
			secret, err = a.managedCredential(m, n)
		} else {
			secret, err = a.readSecret("node_secret", n.ID)
		}
	} else {
		secret, err = a.readSecret("node_secret", n.ID)
		// Managed nodes can use an existing ready grant for the one-click check.
		// The selected identity is stamped on the result and checked as usual.
		if (err != nil || secret == "") && n.PanelID != "" {
			for _, raw := range a.list("member") {
				var m Member
				if json.Unmarshal(raw, &m) != nil || !containsID(m.NodeIDs, n.ID) || checkMember(m, time.Now()) != nil {
					continue
				}
				if candidate, credentialErr := a.managedCredential(m, n); credentialErr == nil && candidate != "" {
					secret, err, in.MemberID = candidate, nil, m.ID
					break
				}
			}
		}
		if err != nil || secret == "" {
			apiError(w, 409, "请选择一位已分配此节点的用户以验证独立授权")
			return true
		}
	}
	if err != nil || secret == "" {
		apiError(w, 409, "测试身份尚未就绪，请先同步授权")
		return true
	}
	if !a.reserveLogin("protocol:"+n.ID, time.Now()) {
		apiError(w, 429, "测试过于频繁，请稍后重试")
		return true
	}
	select {
	case a.protocolWork <- struct{}{}:
	default:
		apiError(w, 409, "已有一个协议测试正在运行，请稍后再试")
		return true
	}
	n.Credential = secret
	result := ProtocolResult{RunID: id(), NodeName: n.Name, NodeID: n.ID, MemberID: in.MemberID, Mode: in.Mode, State: "running", CheckedAt: now(), Source: a.probeSourceLabel(), ConfigHash: protocolConfigHash(n), Detail: "正在通过实际代理协议验证"}
	if a.put("node_test", n.ID, result) != nil {
		<-a.protocolWork
		apiError(w, 500, "无法创建测试记录")
		return true
	}
	n.Credential = secret
	response := result
	response.ConfigHash = ""
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	a.protocolMu.Lock()
	a.protocolCancel, a.protocolNode, a.protocolRun = cancel, n.ID, result.RunID
	a.protocolMu.Unlock()
	go func() {
		defer func() {
			a.protocolMu.Lock()
			a.protocolCancel, a.protocolNode, a.protocolRun = nil, "", ""
			a.protocolMu.Unlock()
			<-a.protocolWork
		}()
		defer cancel()
		measured, err := a.callProtocolWorker(ctx, protocolRequest{Node: n, Mode: in.Mode})
		if errors.Is(ctx.Err(), context.Canceled) {
			result.State, result.Detail = "cancelled", "测试已停止"
		} else if err != nil {
			result.State = "error"
			result.Detail = err.Error()
		} else {
			result.State = measured.State
			result.Detail = measured.Detail
			result.LatencyMS = measured.LatencyMS
			result.DownMbps = measured.DownMbps
			result.Bytes = measured.Bytes
			result.EgressIP = measured.EgressIP
		}
		result.CheckedAt = now()
		a.writeMu.Lock()
		defer a.writeMu.Unlock()
		var current Node
		_ = a.recordProtocolHistory(result)
		if a.get("node", n.ID, &current) == nil && a.protocolIdentityHash(current, result.MemberID) == result.ConfigHash {
			_ = a.put("node_test", n.ID, result)
		}
	}()
	a.audit("node.test", n.ID)
	writeJSON(w, 202, response)
	return true
}
