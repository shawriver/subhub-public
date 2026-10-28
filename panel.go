package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Panel struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ServerID string `json:"serverId"`
	URL      string `json:"url"`
	Status   string `json:"status"`
	Error    string `json:"error"`
	LastSync string `json:"lastSync"`
}
type PanelInput struct {
	Panel
	Token string `json:"token"`
}
type remoteInbound struct {
	ID       int             `json:"id"`
	Remark   string          `json:"remark"`
	Protocol string          `json:"protocol"`
	Port     int             `json:"port"`
	Enable   bool            `json:"enable"`
	Listen   string          `json:"listen"`
	Settings json.RawMessage `json:"settings"`
	Stream   json.RawMessage `json:"streamSettings"`
}
type remoteClient struct {
	UUID     string `json:"uuid"`
	Password string `json:"password"`
	Auth     string `json:"auth"`
	Email    string `json:"email"`
	Enable   bool   `json:"enable"`
	Expiry   int64  `json:"expiryTime"`
	Total    int64  `json:"totalGB"`
	Inbounds []int  `json:"inboundIds"`
	Traffic  *struct {
		Up   int64 `json:"up"`
		Down int64 `json:"down"`
	} `json:"traffic"`
}

func validPanelURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("面板地址不合法，请勿在 URL 中放置凭据")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "https" && !(u.Scheme == "http" && ip != nil && ip.IsLoopback()) {
		return errors.New("远程面板必须使用 HTTPS；仅回环 IP 允许 HTTP")
	}
	if ip != nil && (ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast()) {
		return errors.New("不允许的面板地址")
	}
	return nil
}
func panelCall(ctx context.Context, p Panel, token, method, path string, body, out any) error {
	if err := validPanelURL(p.URL); err != nil {
		return err
	}
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(p.URL, "/")+"/panel/api/"+path, reader)
	if err != nil {
		return errors.New("无法创建面板请求")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Requested-With", "XMLHttpRequest")
	client := &http.Client{Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Do(req)
	if err != nil {
		return errors.New("无法连接面板，请检查地址、证书和网络")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("面板返回 HTTP %d，请检查 API 令牌和基础路径", resp.StatusCode)
	}
	var envelope struct {
		Success bool            `json:"success"`
		Obj     json.RawMessage `json:"obj"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&envelope) != nil || !envelope.Success {
		return errors.New("面板拒绝操作或返回不兼容数据")
	}
	if out != nil && len(envelope.Obj) > 0 {
		if json.Unmarshal(envelope.Obj, out) != nil {
			return errors.New("面板数据格式不兼容")
		}
	}
	return nil
}
func (a *App) panelCall(ctx context.Context, p Panel, method, path string, body, out any) error {
	secret, err := a.readSecret("panel_token", p.ID)
	if err != nil {
		return errors.New("面板令牌不可用")
	}
	return panelCall(ctx, p, secret, method, path, body, out)
}
func (a *App) savePanel(ctx context.Context, in PanelInput) error {
	if !recordIDPattern.MatchString(in.ID) || strings.TrimSpace(in.Name) == "" {
		return errors.New("请填写面板名称")
	}
	if err := validPanelURL(in.URL); err != nil {
		return err
	}
	var server Server
	if a.get("server", in.ServerID, &server) != nil {
		return errors.New("关联服务器不存在")
	}
	var old Panel
	if a.get("panel", in.ID, &old) == nil && (old.URL != in.URL || old.ServerID != in.ServerID) {
		return errors.New("已接入面板的地址和服务器不能变更，请新增连接")
	}
	for _, raw := range a.list("panel") {
		var p Panel
		json.Unmarshal(raw, &p)
		if p.ID != in.ID && p.ServerID == in.ServerID {
			return errors.New("该服务器已有面板连接")
		}
	}
	if in.Token == "" {
		in.Token, _ = a.readSecret("panel_token", in.ID)
	}
	if len(in.Token) < 16 {
		return errors.New("请填写有效的 API 令牌")
	}
	var list []remoteInbound
	if err := panelCall(ctx, in.Panel, in.Token, "GET", "inbounds/list", nil, &list); err != nil {
		return err
	}
	// Verify the unified clients API before allowing enrollment (3x-ui v3).
	var clients []remoteClient
	if err := panelCall(ctx, in.Panel, in.Token, "GET", "clients/list", nil, &clients); err != nil {
		return errors.New("需要支持 /clients API 的 3x-ui v3 版本")
	}
	in.Status, in.Error, in.LastSync = "connected", "", now()
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	b, _ := json.Marshal(in.Panel)
	if _, err = tx.Exec("INSERT INTO records VALUES('panel',?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body", in.ID, b); err != nil {
		return err
	}
	if _, err = tx.Exec("INSERT INTO secrets VALUES('panel_token',?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value", in.ID, a.encrypt("panel_token:"+in.ID, in.Token)); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	a.audit("panel.connect", in.ID)
	a.signalSync()
	return nil
}
func nestedJSON(raw json.RawMessage, v any) error {
	var s string
	if len(raw) > 0 && raw[0] == '"' {
		if err := json.Unmarshal(raw, &s); err != nil {
			return err
		}
		raw = []byte(s)
	}
	return json.Unmarshal(raw, v)
}
func (a *App) inboundNode(p Panel, ib remoteInbound) (Node, error) {
	var server Server
	if a.get("server", p.ServerID, &server) != nil {
		return Node{}, errors.New("服务器不存在")
	}
	n := Node{ID: "managed-" + hash(p.ID + fmt.Sprint(":", ib.ID))[:20], Name: ib.Remark, ServerID: p.ServerID, PanelID: p.ID, InboundID: ib.ID, Host: server.Address, Port: ib.Port, Enabled: ib.Enable, Managed: true, Applied: true, Tags: []string{"3x-ui"}, Transport: "tcp"}
	if n.Name == "" {
		n.Name = fmt.Sprintf("%s · %d", p.Name, ib.Port)
	}
	var stream struct {
		Network  string `json:"network"`
		Security string `json:"security"`
		Reality  struct {
			PrivateKey  string   `json:"privateKey"`
			ServerNames []string `json:"serverNames"`
			ShortIDs    []string `json:"shortIds"`
			Settings    struct {
				PublicKey   string `json:"publicKey"`
				Fingerprint string `json:"fingerprint"`
			} `json:"settings"`
		} `json:"realitySettings"`
		TLS struct {
			ServerName string   `json:"serverName"`
			ALPN       []string `json:"alpn"`
		} `json:"tlsSettings"`
		WS struct {
			Path    string            `json:"path"`
			Host    string            `json:"host"`
			Headers map[string]string `json:"headers"`
		} `json:"wsSettings"`
	}
	if err := nestedJSON(ib.Stream, &stream); err != nil {
		return n, errors.New("无法识别传输配置")
	}
	n.Transport, n.Security = defaultString(stream.Network, "tcp"), defaultString(stream.Security, "none")
	if n.Transport == "raw" {
		n.Transport = "tcp"
	}
	switch ib.Protocol {
	case "vless":
		n.Protocol = "VLESS"
	case "trojan":
		n.Protocol = "Trojan"
	case "hysteria", "hysteria2":
		n.Protocol = "Hysteria2"
		n.Transport = "udp"
	default:
		return n, errors.New("暂不支持此协议")
	}
	n.SNI, n.ALPN = stream.TLS.ServerName, strings.Join(stream.TLS.ALPN, ",")
	if n.Transport == "ws" {
		n.Path, n.WSHost = stream.WS.Path, defaultString(stream.WS.Host, stream.WS.Headers["Host"])
	}
	if n.Security == "reality" {
		n.PublicKey = stream.Reality.Settings.PublicKey
		if n.PublicKey == "" {
			raw, err := base64.RawURLEncoding.DecodeString(stream.Reality.PrivateKey)
			if err != nil {
				return n, errors.New("无法读取 REALITY 公钥")
			}
			key, err := ecdh.X25519().NewPrivateKey(raw)
			if err != nil {
				return n, errors.New("REALITY 密钥格式不正确")
			}
			n.PublicKey = base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes())
		}
		if len(stream.Reality.ServerNames) > 0 {
			n.SNI = stream.Reality.ServerNames[0]
		}
		if len(stream.Reality.ShortIDs) > 0 {
			n.ShortID = stream.Reality.ShortIDs[0]
		}
		n.Fingerprint = defaultString(stream.Reality.Settings.Fingerprint, "chrome")
		n.Flow = "xtls-rprx-vision"
	}
	// A loopback WS inbound is normally behind a reverse proxy. Guessing its
	// external port/security would produce broken or unintended CDN profiles.
	if ip := net.ParseIP(ib.Listen); ip != nil && ip.IsLoopback() {
		return n, errors.New("本地反向代理入站需手动填写外部端点，不能自动接入")
	}
	if err := a.validateNode(n); err != nil {
		return n, err
	}
	return n, nil
}

type discoveredInbound struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	Supported bool   `json:"supported"`
	Reason    string `json:"reason"`
	Node      *Node  `json:"node,omitempty"`
}

func (a *App) discover(ctx context.Context, p Panel) ([]discoveredInbound, error) {
	var list []remoteInbound
	if err := a.panelCall(ctx, p, "GET", "inbounds/list", nil, &list); err != nil {
		return nil, err
	}
	out := []discoveredInbound{}
	for _, ib := range list {
		n, err := a.inboundNode(p, ib)
		v := discoveredInbound{ID: ib.ID, Name: ib.Remark, Supported: err == nil}
		if err != nil {
			v.Reason = err.Error()
		} else {
			v.Node = &n
		}
		out = append(out, v)
	}
	return out, nil
}
func (a *App) attachInbound(ctx context.Context, p Panel, inboundID int, adoptIDs ...string) error {
	adoptID := ""
	if len(adoptIDs) > 0 {
		adoptID = adoptIDs[0]
	}
	list, err := a.discover(ctx, p)
	if err != nil {
		return err
	}
	for _, v := range list {
		if v.ID == inboundID {
			if !v.Supported {
				return errors.New(v.Reason)
			}
			for _, n := range loadNodes(a) {
				if n.PanelID == p.ID && n.InboundID == inboundID {
					if adoptID == "" || adoptID == n.ID {
						return nil
					}
					return errors.New("该入站已经关联另一条节点记录")
				}
			}
			if adoptID != "" {
				return a.adoptInbound(ctx, p, *v.Node, adoptID)
			}
			var old Node
			if a.get("node", v.Node.ID, &old) == nil {
				return nil
			}
			for _, n := range loadNodes(a) {
				if n.Name == v.Node.Name {
					return errors.New("节点名称冲突，请先修改现有记录名称")
				}
			}
			if err = a.put("node", v.Node.ID, v.Node); err != nil {
				return err
			}
			a.audit("node.attach", v.Node.ID)
			a.signalSync()
			return nil
		}
	}
	return errors.New("入站不存在")
}

// Explicit adoption preserves node identity, endpoint, display settings and the
// encrypted owner credential. Only a matching remote client can authorize it.
func (a *App) adoptInbound(ctx context.Context, p Panel, discovered Node, nodeID string) error {
	var old Node
	if a.get("node", nodeID, &old) != nil {
		return errors.New("待关联节点不存在")
	}
	if old.Managed || old.PanelID != "" || old.InboundID != 0 || old.ServerID != p.ServerID ||
		old.Protocol != discovered.Protocol || old.Port != discovered.Port ||
		old.Transport != discovered.Transport || old.Security != discovered.Security ||
		old.PublicKey != discovered.PublicKey || old.ShortID != discovered.ShortID || old.SNI != discovered.SNI ||
		old.Flow != discovered.Flow || old.Path != discovered.Path || old.WSHost != discovered.WSHost {
		return errors.New("现有节点与面板入站配置不一致，拒绝自动关联")
	}
	// Switching an actively distributed shared identity requires an explicit
	// migration; this operation is only for previously unassigned imports.
	for _, raw := range a.list("member") {
		var m Member
		json.Unmarshal(raw, &m)
		if containsID(m.NodeIDs, nodeID) {
			return errors.New("该节点已分配用户，请先移除分配再关联")
		}
	}
	for _, raw := range a.list("profile") {
		var profile Profile
		json.Unmarshal(raw, &profile)
		if containsID(profile.NodeIDs, nodeID) {
			return errors.New("该节点已用于订阅，请先移除引用再关联")
		}
	}
	secret, err := a.readSecret("node_secret", old.ID)
	if err != nil || secret == "" {
		return errors.New("现有节点凭据不可读")
	}
	var clients []remoteClient
	if err = a.panelCall(ctx, p, "GET", "clients/list", nil, &clients); err != nil {
		return err
	}
	matched := false
	for _, client := range clients {
		if remoteCredential(client, old.Protocol) != secret || !client.Enable {
			continue
		}
		for _, iid := range client.Inbounds {
			if iid == discovered.InboundID {
				matched = true
			}
		}
	}
	if !matched {
		return errors.New("现有凭据未匹配该面板入站的有效用户")
	}
	old.PanelID, old.InboundID, old.Managed, old.Applied = p.ID, discovered.InboundID, true, true
	if !containsID(old.Tags, "3x-ui") {
		old.Tags = append(old.Tags, "3x-ui")
	}
	if err = a.put("node", old.ID, old); err != nil {
		return err
	}
	a.audit("node.adopt", old.ID)
	a.signalSync()
	return nil
}
func (a *App) panelAPI(w http.ResponseWriter, r *http.Request, path string) bool {
	if path == "panels" && r.Method == "POST" {
		var in PanelInput
		if decodeBody(r, &in) != nil {
			apiError(w, 400, "请求格式不正确")
			return true
		}
		if in.ID == "" {
			in.ID = id()
		}
		if err := a.savePanel(r.Context(), in); err != nil {
			apiError(w, 400, err.Error())
		} else {
			writeJSON(w, 200, map[string]string{"id": in.ID})
		}
		return true
	}
	parts := strings.Split(path, "/")
	if len(parts) == 3 && parts[0] == "panels" {
		var p Panel
		if a.get("panel", parts[1], &p) != nil {
			apiError(w, 404, "面板不存在")
			return true
		}
		switch parts[2] {
		case "discover":
			if r.Method == "GET" {
				v, err := a.discover(r.Context(), p)
				if err != nil {
					apiError(w, 502, err.Error())
				} else {
					writeJSON(w, 200, v)
				}
				return true
			}
		case "attach":
			if r.Method == "POST" {
				var in struct {
					InboundID   int    `json:"inboundId"`
					AdoptNodeID string `json:"adoptNodeId"`
				}
				if decodeBody(r, &in) != nil {
					apiError(w, 400, "请求格式不正确")
					return true
				}
				if err := a.attachInbound(r.Context(), p, in.InboundID, in.AdoptNodeID); err != nil {
					apiError(w, 400, err.Error())
				} else {
					writeJSON(w, 200, map[string]bool{"ok": true})
				}
				return true
			}
		case "restart":
			if r.Method == "POST" {
				var in struct {
					Confirm string `json:"confirm"`
				}
				if decodeBody(r, &in) != nil || in.Confirm != p.Name {
					apiError(w, 400, "请输入面板名称确认重启 Xray")
					return true
				}
				if err := a.panelCall(r.Context(), p, "POST", "server/restartXrayService", map[string]any{}, nil); err != nil {
					apiError(w, 502, err.Error())
				} else {
					a.audit("xray.restart", p.ID)
					a.signalSync()
					writeJSON(w, 200, map[string]bool{"ok": true})
				}
				return true
			}
		}
	}
	if path == "sync" && r.Method == "POST" {
		a.signalSync()
		writeJSON(w, 202, map[string]bool{"queued": true})
		return true
	}
	return false
}
