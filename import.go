package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type importInput struct {
	ServerID string `json:"serverId"`
	Content  string `json:"content"`
}
type importProblem struct {
	Line    int    `json:"line"`
	Message string `json:"message"`
}
type importPlan struct {
	Nodes   []Node          `json:"nodes"`
	Errors  []importProblem `json:"errors"`
	Skipped int             `json:"skipped"`
}

func parseNodeURI(line string) (Node, error) {
	if strings.HasPrefix(strings.ToLower(line), "vmess://") {
		return parseVMessURI(line)
	}
	n := Node{Enabled: true, Tags: []string{"导入"}, Transport: "tcp"}
	u, err := url.Parse(line)
	if err != nil || u.User == nil || u.Hostname() == "" || u.User.Username() == "" {
		return n, errors.New("节点链接格式不正确或缺少凭据")
	}
	if u.Path != "" && u.Path != "/" {
		return n, errors.New("链接包含无法识别的路径，请将传输路径放在 path 参数中")
	}
	q, err := url.ParseQuery(u.RawQuery)
	if err != nil {
		return n, errors.New("链接查询参数格式不正确")
	}
	allowed := map[string]bool{"type": true, "security": true, "encryption": true, "sni": true, "peer": true, "host": true, "path": true, "pbk": true, "sid": true, "fp": true, "flow": true, "alpn": true, "insecure": true, "allowInsecure": true}
	for k, values := range q {
		if !allowed[k] || len(values) != 1 {
			return n, errors.New("链接包含不支持或重复的参数，请使用受支持的 TCP、WebSocket 或 Hysteria2 配置")
		}
	}
	for _, key := range []string{"insecure", "allowInsecure"} {
		if v := q.Get(key); v != "" && v != "0" && v != "false" {
			return n, errors.New("不支持跳过证书验证的节点，请修复证书设置")
		}
	}
	n.Port, err = strconv.Atoi(u.Port())
	if err != nil || n.Port < 1 || n.Port > 65535 {
		return n, errors.New("节点端口必须为 1–65535")
	}
	n.Host, n.Name, n.Credential = u.Hostname(), u.Fragment, u.User.Username()
	if password, ok := u.User.Password(); ok {
		n.Credential += ":" + password
	}
	n.SNI, n.WSHost, n.Path = q.Get("sni"), q.Get("host"), q.Get("path")
	if n.SNI == "" {
		n.SNI = q.Get("peer")
	} else if q.Get("peer") != "" && q.Get("peer") != n.SNI {
		return n, errors.New("SNI 参数互相冲突")
	}
	n.Transport = defaultString(q.Get("type"), "tcp")
	n.Security, n.PublicKey, n.ShortID, n.Fingerprint, n.Flow, n.ALPN = q.Get("security"), q.Get("pbk"), q.Get("sid"), q.Get("fp"), q.Get("flow"), q.Get("alpn")
	switch strings.ToLower(u.Scheme) {
	case "vless":
		n.Protocol = "VLESS"
		n.Security = defaultString(n.Security, "none")
		if v := q.Get("encryption"); v != "" && v != "none" {
			return n, errors.New("当前仅支持 VLESS encryption=none")
		}
	case "trojan":
		n.Protocol = "Trojan"
		n.Security = defaultString(n.Security, "tls")
	case "anytls":
		n.Protocol = "AnyTLS"
		n.Security = defaultString(n.Security, "tls")
		if n.Security != "tls" || n.Transport != "tcp" {
			return n, errors.New("AnyTLS 需要 TLS 与 TCP")
		}
	case "hysteria2", "hy2":
		n.Protocol = "Hysteria2"
		n.Security = defaultString(n.Security, "tls")
		n.Transport = defaultString(q.Get("type"), "udp")
	default:
		return n, errors.New("仅支持 vless://、anytls://、trojan://、hysteria2:// 和 hy2://")
	}
	if n.Protocol != "VLESS" && (q.Get("encryption") != "" || n.PublicKey != "" || n.ShortID != "" || n.Flow != "") {
		return n, errors.New("协议与连接参数不匹配")
	}
	if n.Security != "reality" && (n.PublicKey != "" || n.ShortID != "") {
		return n, errors.New("REALITY 参数需要 security=reality")
	}
	if n.Transport != "ws" && (n.Path != "" || n.WSHost != "") {
		return n, errors.New("WebSocket 参数需要 type=ws")
	}
	if n.Protocol == "Hysteria2" && n.Fingerprint != "" {
		return n, errors.New("Hysteria2 不支持该指纹参数")
	}
	if n.Security == "reality" && n.PublicKey == "" {
		return n, errors.New("REALITY 链接缺少公钥")
	}
	if n.Name == "" {
		n.Name = fmt.Sprintf("%s · %s:%d", n.Protocol, n.Host, n.Port)
	}
	return n, nil
}

func connectionKey(n Node) string {
	// Only connection semantics determine a duplicate; credentials stay in memory.
	v := []any{n.Protocol, strings.ToLower(n.Host), n.Port, n.Credential, n.Transport, n.Security, n.SNI, n.Path, n.WSHost, n.PublicKey, n.ShortID, n.Flow, n.Fingerprint, n.ALPN}
	b, _ := json.Marshal(v)
	return hash(string(b))
}

func (a *App) planImport(in importInput) importPlan {
	plan := importPlan{Nodes: []Node{}, Errors: []importProblem{}}
	var server Server
	if a.get("server", in.ServerID, &server) != nil {
		plan.Errors = append(plan.Errors, importProblem{0, "请先选择已存在的服务器"})
		return plan
	}
	content := strings.TrimSpace(in.Content)
	if content == "" {
		plan.Errors = append(plan.Errors, importProblem{0, "请粘贴节点链接"})
		return plan
	}
	if !strings.Contains(content, "://") {
		compact := strings.Join(strings.Fields(content), "")
		var decoded []byte
		var err error
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
			decoded, err = enc.DecodeString(compact)
			if err == nil {
				break
			}
		}
		if err != nil {
			plan.Errors = append(plan.Errors, importProblem{0, "无法识别链接或 Base64 内容"})
			return plan
		}
		content = string(decoded)
	}
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	existing := loadNodes(a)
	keys, names := map[string]bool{}, map[string]bool{"节点选择": true, "DIRECT": true, "REJECT": true}
	for _, n := range existing {
		names[n.Name] = true
		if secret, err := a.readSecret("node_secret", n.ID); err == nil {
			n.Credential = secret
			keys[connectionKey(n)] = true
		}
	}
	count := 0
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		count++
		if count > 100 {
			plan.Errors = append(plan.Errors, importProblem{i + 1, "每次最多导入 100 个节点"})
			break
		}
		n, err := parseNodeURI(line)
		n.ServerID = in.ServerID
		if err == nil {
			err = a.validateNode(n)
		}
		if err != nil {
			plan.Errors = append(plan.Errors, importProblem{i + 1, err.Error()})
			continue
		}
		key := connectionKey(n)
		if keys[key] {
			plan.Skipped++
			continue
		}
		if names[n.Name] {
			plan.Errors = append(plan.Errors, importProblem{i + 1, "节点名称重复或为保留名称，请修改链接末尾的名称"})
			continue
		}
		keys[key], names[n.Name] = true, true
		n.ID = id()
		plan.Nodes = append(plan.Nodes, n)
	}
	return plan
}

func (a *App) importNodes(w http.ResponseWriter, r *http.Request, preview bool) {
	var in importInput
	if decodeBody(r, &in) != nil {
		apiError(w, 400, "请求格式不正确")
		return
	}
	plan := a.planImport(in)
	if preview {
		for i := range plan.Nodes {
			plan.Nodes[i].Credential = ""
		}
		writeJSON(w, 200, plan)
		return
	}
	if len(plan.Errors) > 0 {
		writeJSON(w, 400, map[string]any{"error": "导入内容存在问题，未保存任何节点", "errors": plan.Errors})
		return
	}
	if len(plan.Nodes) == 0 {
		writeJSON(w, 200, map[string]int{"imported": 0, "skipped": plan.Skipped})
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		apiError(w, 500, "数据库不可用")
		return
	}
	defer tx.Rollback()
	for _, n := range plan.Nodes {
		secret := n.Credential
		n.Credential = ""
		body, marshalErr := json.Marshal(n)
		if marshalErr != nil {
			apiError(w, 500, "导入失败，未保存任何节点")
			return
		}
		if _, err = tx.Exec("INSERT INTO records(kind,id,body) VALUES('node',?,?)", n.ID, body); err != nil {
			apiError(w, 500, "导入失败，未保存任何节点")
			return
		}
		if _, err = tx.Exec("INSERT INTO secrets VALUES('node_secret',?,?)", n.ID, a.encrypt("node_secret:"+n.ID, secret)); err != nil {
			apiError(w, 500, "导入失败，未保存任何节点")
			return
		}
	}
	if err = tx.Commit(); err != nil {
		apiError(w, 500, "导入失败，未保存任何节点")
		return
	}
	a.audit("node.import", fmt.Sprintf("%d", len(plan.Nodes)))
	writeJSON(w, 200, map[string]int{"imported": len(plan.Nodes), "skipped": plan.Skipped})
}
