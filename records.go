package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var recordIDPattern = regexp.MustCompile("^[A-Za-z0-9_-]{1,100}$")
var hostnamePattern = regexp.MustCompile("^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$")

func containsID(ids []string, id string) bool {
	for _, candidate := range ids {
		if candidate == id {
			return true
		}
	}
	return false
}

func supportedFormat(format string) bool {
	return format == "clash" || format == "v2ray" || format == "base64"
}

func (a *App) validateNode(n Node) error {
	if strings.TrimSpace(n.Name) == "" || len(n.Name) > 200 || n.Port < 1 || n.Port > 65535 {
		return errors.New("请填写节点名称及有效端口（1–65535）")
	}
	if n.Host == "" || len(n.Host) > 253 || (net.ParseIP(n.Host) == nil && !hostnamePattern.MatchString(n.Host)) {
		return errors.New("节点地址必须是 IP 或域名，不包含协议、路径或端口")
	}
	switch n.Protocol {
	case "VMess":
		if n.Security != "" && n.Security != "none" && n.Security != "tls" {
			return errors.New("VMess 支持 TLS 或无 TLS")
		}
	case "VLESS":
		if n.Security != "" && n.Security != "none" && n.Security != "tls" && n.Security != "reality" {
			return errors.New("不支持的 VLESS 安全方式")
		}
	case "Trojan", "Hysteria2", "AnyTLS":
		if n.Security != "tls" {
			return errors.New("Trojan、Hysteria2 和 AnyTLS 需要 TLS")
		}
	default:
		return errors.New("目前支持 VLESS、VMess、Trojan、Hysteria2 和 AnyTLS")
	}
	if n.Protocol == "AnyTLS" {
		if n.Transport != "" && n.Transport != "tcp" {
			return errors.New("AnyTLS 使用 TCP 传输")
		}
		if n.Path != "" || n.WSHost != "" || n.PublicKey != "" || n.ShortID != "" {
			return errors.New("AnyTLS 不支持 WebSocket 或 REALITY 参数")
		}
	} else if n.Protocol == "Hysteria2" {
		if n.Transport != "" && n.Transport != "udp" {
			return errors.New("Hysteria2 使用 UDP 传输")
		}
	} else if n.Transport != "" && n.Transport != "tcp" && n.Transport != "ws" {
		return errors.New("当前协议支持 TCP 或 WebSocket 传输")
	}
	if n.Security == "reality" && n.Transport != "" && n.Transport != "tcp" {
		return errors.New("当前 REALITY 导出仅支持 TCP")
	}
	if n.Flow != "" && (n.Protocol != "VLESS" || n.Flow != "xtls-rprx-vision" || n.Transport == "ws" || (n.Security != "tls" && n.Security != "reality")) {
		return errors.New("Vision flow 需要 VLESS TCP 与 TLS/REALITY")
	}
	if n.ServerID != "" {
		var server Server
		if err := a.get("server", n.ServerID, &server); err != nil {
			return errors.New("关联服务器不存在")
		}
	}
	return nil
}

func validQuota(used, limit float64) bool {
	return used >= 0 && limit >= 0 && used < float64(math.MaxInt64)/1e9 && limit < float64(math.MaxInt64)/1e9
}

// Validate every field before the first write; credentials and metadata commit together.
func (a *App) saveValidatedRecord(r *http.Request, kind, recordID string) error {
	if !recordIDPattern.MatchString(recordID) {
		return errors.New("记录 ID 不合法")
	}
	var record any
	var bodyID *string
	credential := ""
	switch kind {
	case "server":
		v := new(Server)
		if err := decodeBody(r, v); err != nil {
			return errors.New("请求格式不正确")
		}
		var old Server
		if a.get("server", recordID, &old) == nil {
			v.KomariUUID = old.KomariUUID
			if old.KomariUUID != "" {
				v.Specs, v.Expires, v.Price, v.Limit = old.Specs, old.Expires, old.Price, old.Limit
			}
		} else if v.KomariUUID != "" {
			return errors.New("请通过 Komari 关联入口绑定探针")
		}
		if strings.TrimSpace(v.Name) == "" {
			return errors.New("服务器名称不能为空")
		}
		if v.Address == "" || len(v.Address) > 253 || (net.ParseIP(v.Address) == nil && !hostnamePattern.MatchString(v.Address)) {
			return errors.New("服务器地址必须是 IP 或域名")
		}
		if _, err := memberExpiry(v.Expires); err != nil {
			return errors.New("到期日期格式不正确")
		}
		if v.Status == "" {
			v.Status = "pending"
		}
		record, bodyID = v, &v.ID
	case "node":
		v := new(Node)
		if err := decodeBody(r, v); err != nil {
			return errors.New("请求格式不正确")
		}
		if v.ExternalPort < 0 || v.ExternalPort > 65535 {
			return errors.New("外部端口必须在 1–65535 之间")
		}
		if v.ExternalPort > 0 && v.Transport != "ws" && v.Security != "tls" {
			return errors.New("外部端口覆盖只用于反向代理的 TLS 或 WebSocket 节点")
		}
		if v.ExternalSNI != "" && (net.ParseIP(v.ExternalSNI) != nil || len(v.ExternalSNI) > 253 || !hostnamePattern.MatchString(v.ExternalSNI)) {
			return errors.New("外部 TLS 名称必须是域名")
		}
		if err := a.validateNode(*v); err != nil {
			return err
		}
		var old Node
		if a.get("node", recordID, &old) == nil {
			if old.PanelID != v.PanelID || old.InboundID != v.InboundID {
				return errors.New("受管节点关联不能直接修改")
			}
			if old.PanelID != "" && (old.Host != v.Host || old.Port != v.Port || old.Path != v.Path || old.WSHost != v.WSHost ||
				old.Protocol != v.Protocol || old.Transport != v.Transport || v.Credential != "") {
				return errors.New("受管节点的连接参数和凭据由 3x-ui 管理")
			}
			if old.PanelID != "" && v.Security != old.Security && !(old.Transport == "ws" && v.Transport == "ws" && v.Security == "tls") {
				return errors.New("受管节点的协议和凭据由 3x-ui 管理")
			}
		} else if v.PanelID != "" || v.InboundID != 0 {
			return errors.New("请通过面板发现接入受管节点")
		}
		credential, v.Credential = v.Credential, ""
		record, bodyID = v, &v.ID
	case "member":
		v := new(Member)
		if err := decodeBody(r, v); err != nil {
			return errors.New("请求格式不正确")
		}
		if strings.TrimSpace(v.Name) == "" {
			return errors.New("用户名不能为空")
		}
		if _, err := memberExpiry(v.Expires); err != nil {
			return errors.New("到期日期格式不正确")
		}
		if !validQuota(v.Used, v.Limit) {
			return errors.New("用量和额度必须是有效的非负数")
		}
		if v.ConnectionLimitOverride != nil && !validConnectionLimit(*v.ConnectionLimitOverride) {
			return errors.New("用户并发连接上限必须是 0–10000 之间的整数，0 表示不限制")
		}
		if v.DeviceLimit < 0 || v.DeviceLimit > 999 {
			return errors.New("设备上限必须是 0–999 之间的整数，0 表示不限制")
		}
		// Derived view fields are never accepted from clients.
		v.ConnectionLimit, v.ConnectionLimitSource = 0, ""
		v.DevicesUsed, v.DeviceOverLimit = 0, false
		var existing Member
		if err := a.get("member", recordID, &existing); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		// Explicit node allocation survives collection edits and restarts.
		// Older clients omitting the mode retain the existing assignment.
		if v.AssignmentMode == "" {
			v.AssignmentMode = existing.AssignmentMode
			if v.SubscriptionIDs != nil {
				v.AssignmentMode = "subscriptions"
			}
		}
		switch v.AssignmentMode {
		case "nodes":
			v.SubscriptionIDs = nil
			// Updated clients send the base separately from effective access.
			if v.AllocationNodeIDs != nil &&
				(strings.Join(v.AllocationNodeIDs, "\x00") != strings.Join(existing.AllocationNodeIDs, "\x00") ||
					strings.Join(v.NodeIDs, "\x00") == strings.Join(existing.NodeIDs, "\x00")) {
				v.NodeIDs = append([]string{}, v.AllocationNodeIDs...)
			}
		case "", "subscriptions":
			if v.SubscriptionIDs == nil && existing.SubscriptionIDs != nil {
				v.SubscriptionIDs = append([]string{}, existing.SubscriptionIDs...)
			}
			if v.AssignmentMode == "subscriptions" && v.SubscriptionIDs == nil {
				v.SubscriptionIDs = []string{}
			}
		default:
			return errors.New("请选择订阅集合或单独节点分配")
		}
		if v.SubscriptionIDs != nil {
			v.SubscriptionIDs = uniqueIDs(v.SubscriptionIDs)
			var err error
			v.NodeIDs, err = subscriptionNodes(v.SubscriptionIDs, func(id string) (Subscription, error) {
				var s Subscription
				err := a.get("subscription", id, &s)
				return s, err
			})
			if err != nil {
				return err
			}
		}
		for _, nodeID := range v.NodeIDs {
			var n Node
			if a.get("node", nodeID, &n) != nil {
				return errors.New("分配的节点不存在")
			}
		}
		if v.NodeIDs == nil {
			v.NodeIDs = []string{}
		}
		v.NodeIDs = uniqueIDs(v.NodeIDs)
		v.AllocationNodeIDs = append([]string{}, v.NodeIDs...)
		var old Member
		if a.get("member", recordID, &old) == nil {
			v.Used = old.Used
			v.Provision = old.Provision
		}
		if err := configureCycle(v, old, time.Now()); err != nil {
			return err
		}
		record, bodyID = v, &v.ID
	case "subscription":
		v := new(Subscription)
		if err := decodeBody(r, v); err != nil {
			return errors.New("请求格式不正确")
		}
		v.Name = strings.TrimSpace(v.Name)
		if v.Name == "" || len(v.Name) > 200 {
			return errors.New("请填写订阅名称（最多 200 字节）")
		}
		if len(v.Note) > 4000 {
			return errors.New("订阅备注过长")
		}
		if !validConnectionLimit(v.ConnectionLimit) {
			return errors.New("订阅并发连接上限必须是 0–10000 之间的整数，0 表示不限制")
		}
		v.NodeIDs = uniqueIDs(v.NodeIDs)
		for _, nid := range v.NodeIDs {
			var n Node
			if err := a.get("node", nid, &n); err != nil {
				return errors.New("订阅中的节点不存在")
			}
		}
		v.Updated = now()
		record, bodyID = v, &v.ID
	case "profile":
		v := new(Profile)
		if err := decodeBody(r, v); err != nil {
			return errors.New("请求格式不正确")
		}
		if strings.TrimSpace(v.Name) == "" {
			return errors.New("订阅名称不能为空")
		}
		if !supportedFormat(v.Format) {
			return errors.New("不支持的订阅格式")
		}
		if v.TemplateID != "" {
			t, err := a.ruleTemplate(v.TemplateID)
			if err != nil {
				return err
			}
			if err := validateRuleTemplate(RuleTemplate{ID: "exceptions", Name: "exceptions", Smart: t.Smart, Rules: v.Rules}); err != nil {
				return err
			}
		}
		var member Member
		if a.get("member", v.MemberID, &member) != nil {
			return errors.New("订阅用户不存在")
		}
		if v.CustomNodes && v.FollowMemberNodes {
			return errors.New("定制订阅请选择独立节点")
		}
		if v.FollowMemberNodes {
			v.NodeIDs = append([]string{}, allocationNodes(member)...)
		}
		var old Profile
		if err := a.get("profile", recordID, &old); err == nil && old.MemberID != v.MemberID {
			return errors.New("订阅不能转给另一位用户，请新建订阅")
		} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return errors.New("无法读取订阅")
		}
		for _, nodeID := range v.NodeIDs {
			if v.CustomNodes {
				var n Node
				if a.get("node", nodeID, &n) != nil {
					return errors.New("定制订阅中的节点不存在")
				}
			} else if !containsID(allocationNodes(member), nodeID) {
				return errors.New("订阅包含未分配给该用户的节点")
			}
		}
		if v.NodeIDs == nil {
			v.NodeIDs = []string{}
		}
		v.NodeIDs = uniqueIDs(v.NodeIDs)
		if len(v.Rules) > 500 {
			return errors.New("分流规则最多 500 条")
		}
		for _, rule := range v.Rules {
			if len(rule) > 2048 || strings.ContainsAny(rule, "\r\n\x00") || !strings.Contains(rule, ",") {
				return errors.New("分流规则格式不正确，请每行填写一条规则")
			}
		}
		v.Updated = now()
		record, bodyID = v, &v.ID
	case "task":
		v := new(Task)
		if err := decodeBody(r, v); err != nil {
			return errors.New("请求格式不正确")
		}
		var old Task
		if validAgentAction(v.Kind) || (a.get("task", recordID, &old) == nil && validAgentAction(old.Kind)) {
			return errors.New("主机任务只能通过运维入口操作")
		}
		record, bodyID = v, &v.ID
	default:
		return errors.New("记录类型不存在")
	}
	if *bodyID != "" && *bodyID != recordID {
		return errors.New("记录 ID 与请求路径不一致")
	}
	*bodyID = recordID
	body, err := json.Marshal(record)
	if err != nil {
		return errors.New("无法保存记录")
	}
	tx, err := a.db.Begin()
	if err != nil {
		return errors.New("数据库不可用")
	}
	defer tx.Rollback()
	if credential != "" {
		_, err = tx.Exec("INSERT INTO secrets VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value", "node_secret", recordID, a.encrypt("node_secret:"+recordID, credential))
		if err != nil {
			return errors.New("无法保存节点凭据")
		}
	}
	if _, err = tx.Exec("INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body", kind, recordID, body); err != nil {
		return errors.New("无法保存记录")
	}
	if member, ok := record.(*Member); ok {
		if err := reconcileMemberAccess(tx, *member); err != nil {
			return errors.New("用户与订阅同步失败，修改已回滚")
		}
	}
	if profile, ok := record.(*Profile); ok {
		var m Member
		var raw []byte
		if err := tx.QueryRow("SELECT body FROM records WHERE kind='member' AND id=?", profile.MemberID).Scan(&raw); err != nil {
			return errors.New("订阅用户不可用，修改已回滚")
		}
		if json.Unmarshal(raw, &m) != nil || reconcileMemberAccess(tx, m) != nil {
			return errors.New("定制订阅与用户同步失败，修改已回滚")
		}
	}
	if _, ok := record.(*Subscription); ok {
		if err := reconcileSubscribers(tx, recordID); err != nil {
			return errors.New("订阅与用户同步失败，修改已回滚")
		}
	}
	return tx.Commit()
}

func uniqueIDs(ids []string) []string {
	out := []string{}
	for _, id := range ids {
		if !containsID(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// Removal is durable: reassigning a node must not silently re-grant it to a
// manually selected profile. Follow profiles intentionally mirror the member.
func reconcileProfiles(tx *sql.Tx, member Member) error {
	rows, err := tx.Query("SELECT body FROM records WHERE kind='profile'")
	if err != nil {
		return err
	}
	profiles := []Profile{}
	for rows.Next() {
		var raw []byte
		var p Profile
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return err
		}
		if err = json.Unmarshal(raw, &p); err != nil {
			rows.Close()
			return err
		}
		if p.MemberID == member.ID {
			profiles = append(profiles, p)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, p := range profiles {
		if p.CustomNodes {
			continue
		}
		ids := []string{}
		if p.FollowMemberNodes {
			ids = append(ids, allocationNodes(member)...)
		} else {
			for _, id := range p.NodeIDs {
				if containsID(allocationNodes(member), id) {
					ids = append(ids, id)
				}
			}
		}
		if strings.Join(ids, "\x00") == strings.Join(p.NodeIDs, "\x00") {
			continue
		}
		p.NodeIDs, p.Updated = ids, now()
		body, err := json.Marshal(p)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE records SET body=? WHERE kind='profile' AND id=?", body, p.ID); err != nil {
			return err
		}
	}
	return nil
}

// Dates are inclusive in the owner's timezone: access ends at the next midnight.
func memberExpiry(date string) (time.Time, error) {
	if date == "" {
		return time.Time{}, nil
	}
	t, err := time.ParseInLocation("2006-01-02", date, time.FixedZone("Asia/Shanghai", 8*3600))
	if err != nil {
		return time.Time{}, err
	}
	return t.AddDate(0, 0, 1), nil
}

func checkMember(m Member, at time.Time) error {
	if !m.Enabled {
		return errors.New("用户已停用")
	}
	exp, err := memberExpiry(m.Expires)
	if err != nil {
		return errors.New("到期日期无效，请联系管理员")
	}
	if !exp.IsZero() && !at.Before(exp) {
		return errors.New("订阅已到期")
	}
	if !validQuota(m.Used, m.Limit) {
		return errors.New("流量额度无效，请联系管理员")
	}
	if m.Limit > 0 && memberQuotaUsed(m) >= m.Limit {
		return errors.New("订阅流量额度已用完")
	}
	return nil
}
