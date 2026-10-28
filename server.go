package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

const appVersion = "0.2.11"

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/status", a.status)
	mux.HandleFunc("/api/setup", a.setupAdmin)
	mux.HandleFunc("/api/login", a.login)
	mux.HandleFunc("/api/logout", a.logout)
	mux.HandleFunc("/api/session", a.session)
	mux.HandleFunc("/api/public/status", a.publicStatus)
	mux.HandleFunc("/api/public/member/", a.publicMember)
	mux.HandleFunc("/api/agent/", a.agentPoll)
	mux.Handle("/api/admin/", a.requireAdmin(http.HandlerFunc(a.adminAPI)))
	mux.HandleFunc("/sub/", a.subscription)
	mux.HandleFunc("/", a.web)
	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Robots-Tag", "noindex, nofollow")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func apiError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
func decodeBody(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("request must contain exactly one JSON value")
	}
	return nil
}
func requestID(r *http.Request) string {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if host == "" {
		host = r.RemoteAddr
	}
	// Only the local reverse proxy may supply a client address. Use the
	// rightmost hop; an arbitrary leftmost X-Forwarded-For is not trusted.
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		if client := net.ParseIP(strings.TrimSpace(parts[len(parts)-1])); client != nil {
			host = client.String()
		}
	}
	return host
}

func (a *App) status(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		apiError(w, 405, "method not allowed")
		return
	}
	var n int
	if err := a.db.QueryRow("SELECT count(*) FROM admin").Scan(&n); err != nil {
		apiError(w, 503, "数据库不可用")
		return
	}
	writeJSON(w, 200, map[string]any{"setupRequired": n == 0, "version": appVersion, "appearance": a.storedAppearance()})
}
func (a *App) setupAdmin(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		apiError(w, 405, "method not allowed")
		return
	}
	var in struct {
		Token    string `json:"token"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeBody(r, &in); err != nil {
		apiError(w, 400, "请求格式不正确")
		return
	}
	if utf8.RuneCountInString(in.Password) < 14 || len(in.Password) > 72 {
		apiError(w, 400, "密码至少需要 14 个字符，UTF-8 编码不超过 72 字节")
		return
	}
	if in.Username == "" {
		in.Username = "admin"
	}
	if strings.TrimSpace(in.Username) == "" || len(in.Username) > 128 {
		apiError(w, 400, "用户名格式不正确")
		return
	}
	if !a.beginAuth(w) {
		return
	}
	defer func() { <-a.authWork }()
	tx, err := a.db.Begin()
	if err != nil {
		apiError(w, 500, "数据库不可用")
		return
	}
	defer tx.Rollback()
	var count int
	if err = tx.QueryRow("SELECT count(*) FROM admin").Scan(&count); err != nil || count != 0 {
		apiError(w, 409, "管理员已经初始化")
		return
	}
	var exp int64
	if err = tx.QueryRow("SELECT expires FROM setup WHERE digest=?", hash(in.Token)).Scan(&exp); err != nil || exp <= time.Now().Unix() {
		apiError(w, 403, "设置链接无效或已过期")
		return
	}
	h, err := bcrypt.GenerateFromPassword([]byte(in.Password), 12)
	if err != nil {
		apiError(w, 500, "无法创建密码")
		return
	}
	if _, err = tx.Exec("INSERT INTO admin(username,password) VALUES(?,?)", in.Username, h); err != nil {
		apiError(w, 409, "管理员已经初始化")
		return
	}
	if _, err = tx.Exec("DELETE FROM setup"); err != nil {
		apiError(w, 500, "保存失败")
		return
	}
	if err = tx.Commit(); err != nil {
		apiError(w, 500, "保存失败")
		return
	}
	a.audit("admin.setup", in.Username)
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (a *App) login(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		apiError(w, 405, "method not allowed")
		return
	}
	if !a.reserveLogin(requestID(r), time.Now()) {
		w.Header().Set("Retry-After", "600")
		apiError(w, 429, "尝试次数过多，请稍后再试")
		return
	}
	if !a.beginAuth(w) {
		return
	}
	defer func() { <-a.authWork }()
	var in struct {
		Username, Password, Code string
		Remember                 *bool `json:"remember"`
	}
	if err := decodeBody(r, &in); err != nil {
		apiError(w, 400, "请求格式不正确")
		return
	}
	var h []byte
	if err := a.db.QueryRow("SELECT password FROM admin WHERE username=?", in.Username).Scan(&h); err != nil || bcrypt.CompareHashAndPassword(h, []byte(in.Password)) != nil {
		apiError(w, 401, "用户名或密码错误")
		return
	}
	remember := in.Remember == nil || *in.Remember
	ttl, prefix := temporarySessionTTL, "s."
	if remember {
		ttl, prefix = rememberedSessionTTL, "r."
	}
	t := prefix + token()
	exp := time.Now().Add(ttl)
	if !a.verifyOTP(in.Code) {
		apiError(w, 401, "需要有效的二步验证码；已使用的验证码请等待下一组")
		return
	}
	_, _ = a.db.Exec("DELETE FROM sessions WHERE expires <= ?", time.Now().Unix())
	_, err := a.db.Exec("INSERT INTO sessions VALUES(?,?)", hash(t), exp.Unix())
	if err != nil {
		apiError(w, 500, "无法创建登录会话")
		return
	}
	a.setSessionCookie(w, t, exp, remember)
	a.audit("admin.login", in.Username)
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		apiError(w, 405, "method not allowed")
		return
	}
	if r.Header.Get("X-SubHub-Request") != "1" {
		apiError(w, 403, "请求校验失败")
		return
	}
	if c, err := r.Cookie("subhub_session"); err == nil {
		if _, err := a.db.Exec("DELETE FROM sessions WHERE digest=?", hash(c.Value)); err != nil {
			apiError(w, 503, "退出失败，请重试")
			return
		}
	}
	http.SetCookie(w, &http.Cookie{Name: "subhub_session", Value: "", Path: "/", HttpOnly: true, Secure: strings.HasPrefix(a.origin, "https://"), SameSite: http.SameSiteLaxMode, MaxAge: -1})
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (a *App) isAdmin(r *http.Request) bool {
	c, err := r.Cookie("subhub_session")
	if err != nil {
		return false
	}
	var exp int64
	err = a.db.QueryRow("SELECT expires FROM sessions WHERE digest=?", hash(c.Value)).Scan(&exp)
	return err == nil && exp > time.Now().Unix()
}
func (a *App) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, cookieErr := r.Cookie("subhub_session")
		var expires int64
		var lookupErr error
		if cookieErr == nil {
			lookupErr = a.db.QueryRow("SELECT expires FROM sessions WHERE digest=?", hash(c.Value)).Scan(&expires)
			if lookupErr != nil && !errors.Is(lookupErr, sql.ErrNoRows) {
				apiError(w, 503, "暂时无法确认登录状态，请重试")
				return
			}
		}
		if cookieErr != nil || errors.Is(lookupErr, sql.ErrNoRows) || expires <= time.Now().Unix() {
			apiError(w, 401, "请先登录")
			return
		}
		if r.Method != "GET" && r.Method != "HEAD" && r.Header.Get("X-SubHub-Request") != "1" {
			apiError(w, 403, "请求校验失败")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) adminAPI(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/admin/")
	if a.nodeLatencyAPI(w, r, path) {
		return
	}
	if r.Method != "GET" && r.Method != "HEAD" {
		a.writeMu.Lock()
		defer a.writeMu.Unlock()
	}
	if path == "tasks/batch-delete" && r.Method == "POST" {
		a.batchDeleteTasks(w, r)
		return
	}
	if a.publicSettingsAPI(w, r, path) {
		return
	}
	if a.templatesAPI(w, r, path) || a.fetchAuditAPI(w, r, path) || a.protocolAPI(w, r, path) || a.packageMembersAPI(w, r, path) {
		return
	}
	if a.komariAPI(w, r, path) {
		return
	}
	if a.queueAgentAPI(w, r, path) {
		return
	}
	if a.accountAPI(w, r, path) || a.backupAPI(w, r, path) {
		return
	}
	if a.panelAPI(w, r, path) {
		return
	}
	if (path == "nodes/import/preview" || path == "nodes/import") && r.Method == "POST" {
		a.importNodes(w, r, path == "nodes/import/preview")
		return
	}
	if path == "overview" && r.Method == "GET" {
		a.overview(w)
		return
	}
	if path == "appearance" {
		a.appearanceAPI(w, r)
		return
	}
	if path == "sync-settings" {
		if r.Method == "GET" {
			counts, at := a.lastSyncRound()
			writeJSON(w, 200, map[string]any{"observeMode": a.observeMode(), "lastRound": counts, "lastRoundAt": at})
			return
		}
		if r.Method == "POST" {
			var in struct {
				ObserveMode *bool `json:"observeMode"`
			}
			if decodeBody(r, &in) != nil || in.ObserveMode == nil {
				apiError(w, 400, "请求格式不正确")
				return
			}
			if err := a.setObserveMode(*in.ObserveMode); err != nil {
				apiError(w, 500, "保存失败")
				return
			}
			if *in.ObserveMode {
				a.audit("sync.observe.enable", "sync")
			} else {
				a.audit("sync.observe.disable", "sync")
			}
			a.signalSync()
			writeJSON(w, 200, map[string]any{"observeMode": *in.ObserveMode})
			return
		}
	}
	if path == "audit" && r.Method == "GET" {
		rows, err := a.db.Query("SELECT at,action,target FROM audit ORDER BY id DESC LIMIT 50")
		if err != nil {
			apiError(w, 503, "数据库不可用")
			return
		}
		defer rows.Close()
		out := []map[string]string{}
		for rows.Next() {
			var at, action, target string
			_ = rows.Scan(&at, &action, &target)
			out = append(out, map[string]string{"at": at, "action": action, "target": target})
		}
		writeJSON(w, 200, out)
		return
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 3 && parts[0] == "subscriptions" && parts[2] == "revoke" && r.Method == "POST" {
		var p Profile
		if a.get("profile", parts[1], &p) != nil {
			apiError(w, 404, "订阅不存在")
			return
		}
		if _, err := a.db.Exec("DELETE FROM access_tokens WHERE profile=?", p.ID); err != nil {
			apiError(w, 500, "撤销失败")
			return
		}
		a.audit("subscription.revoke", p.ID)
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	if len(parts) == 2 && (parts[0] == "subscription" || parts[0] == "preview") && r.Method == "GET" {
		a.previewSubscription(w, r, parts[1])
		return
	}
	if len(parts) == 2 && parts[0] == "subscriptions" && r.Method == "POST" {
		a.issueSubscription(w, r, parts[1])
		return
	}
	if len(parts) == 2 && parts[0] == "task" && r.Method == "POST" {
		var v Task
		if e := decodeBody(r, &v); e != nil {
			apiError(w, 400, "请求格式不正确")
			return
		}
		if v.ID == "" {
			v.ID = id()
		}
		if validAgentAction(v.Kind) {
			apiError(w, 400, "主机操作必须通过确认入口创建")
			return
		}
		v.Created = now()
		if v.Status == "" {
			v.Status = "queued"
		}
		if e := a.put("task", v.ID, v); e != nil {
			apiError(w, 500, "保存失败")
			return
		}
		a.audit("task.queue", v.ID)
		writeJSON(w, 201, v)
		return
	}
	if len(parts) != 2 {
		apiError(w, 404, "接口不存在")
		return
	}
	kind, recordID := parts[0], parts[1]
	if (kind == "server" || kind == "node" || kind == "member" || kind == "profile" || kind == "subscription" || kind == "task") == false {
		apiError(w, 404, "记录类型不存在")
		return
	}
	switch r.Method {
	case "DELETE":
		var deletedProfile Profile
		if kind == "profile" {
			_ = a.get("profile", recordID, &deletedProfile)
		}
		if kind == "subscription" {
			for _, raw := range a.list("member") {
				var m Member
				_ = json.Unmarshal(raw, &m)
				if containsID(m.SubscriptionIDs, recordID) {
					apiError(w, 409, "订阅已分配给用户，请先解除分配")
					return
				}
			}
		}
		if kind == "node" {
			for _, raw := range a.list("subscription") {
				var s Subscription
				_ = json.Unmarshal(raw, &s)
				if containsID(s.NodeIDs, recordID) {
					apiError(w, 409, "节点仍被订阅引用，请先修改订阅")
					return
				}
			}
		}
		if kind == "task" {
			var t Task
			if a.get("task", recordID, &t) == nil && validAgentAction(t.Kind) {
				apiError(w, 409, "主机任务记录不可直接删除")
				return
			}
		}
		if a.hasLiveGrants(kind, recordID) {
			apiError(w, 409, "请先停用用户或移除节点分配，等待授权撤销成功后再删除")
			return
		}
		if kind == "server" {
			for _, raw := range a.list("panel") {
				var p Panel
				json.Unmarshal(raw, &p)
				if p.ServerID == recordID {
					apiError(w, 409, "服务器仍关联已接入面板")
					return
				}
			}
		}
		if kind == "member" || kind == "node" {
			for _, raw := range a.list("profile") {
				var p Profile
				_ = json.Unmarshal(raw, &p)
				if (kind == "member" && p.MemberID == recordID) || (kind == "node" && containsID(p.NodeIDs, recordID)) {
					apiError(w, 409, "记录仍被订阅引用，请先删除或修改订阅")
					return
				}
			}
		}
		if kind == "server" {
			for _, raw := range a.list("node") {
				var n Node
				_ = json.Unmarshal(raw, &n)
				if n.ServerID == recordID {
					apiError(w, 409, "服务器仍有关联节点")
					return
				}
			}
		}
		if kind == "node" {
			for _, raw := range a.list("member") {
				var m Member
				_ = json.Unmarshal(raw, &m)
				for _, n := range m.NodeIDs {
					if n == recordID {
						apiError(w, 409, "节点仍分配给用户")
						return
					}
				}
			}
		}
		tx, err := a.db.Begin()
		if err != nil {
			apiError(w, 500, "数据库不可用")
			return
		}
		defer tx.Rollback()
		res, err := tx.Exec("DELETE FROM records WHERE kind=? AND id=?", kind, recordID)
		if err != nil {
			apiError(w, 500, "删除失败")
			return
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			apiError(w, 404, "记录不存在")
			return
		}
		if kind == "profile" {
			_, err = tx.Exec("DELETE FROM access_tokens WHERE profile=?", recordID)
			if err == nil && deletedProfile.MemberID != "" {
				var raw []byte
				var m Member
				err = tx.QueryRow("SELECT body FROM records WHERE kind='member' AND id=?", deletedProfile.MemberID).Scan(&raw)
				if err == nil {
					err = json.Unmarshal(raw, &m)
				}
				if err == nil {
					err = reconcileMemberAccess(tx, m)
				}
			}
		}
		if kind == "node" {
			if _, err = tx.Exec("DELETE FROM secrets WHERE kind='node_secret' AND id=?", recordID); err == nil {
				_, err = tx.Exec("DELETE FROM records WHERE kind='node_probe' AND id=?", recordID)
			}
			if err == nil {
				_, err = tx.Exec("DELETE FROM records WHERE kind='task' AND id=?", "node-alert-"+recordID)
			}
		}
		if err != nil {
			apiError(w, 500, "删除失败")
			return
		}
		if err = tx.Commit(); err != nil {
			apiError(w, 500, "删除失败")
			return
		}
		a.audit(kind+".delete", recordID)
		writeJSON(w, 200, map[string]bool{"ok": true})
	case "PUT":
		a.saveRecord(w, r, kind, recordID)
	default:
		apiError(w, 405, "method not allowed")
	}
}

func (a *App) batchDeleteTasks(w http.ResponseWriter, r *http.Request) {
	var in struct {
		IDs []string `json:"ids"`
	}
	if decodeBody(r, &in) != nil || len(in.IDs) == 0 || len(in.IDs) > 500 {
		apiError(w, 400, "请选择 1–500 条任务记录")
		return
	}
	unique := make([]string, 0, len(in.IDs))
	seen := map[string]bool{}
	for _, taskID := range in.IDs {
		if !recordIDPattern.MatchString(taskID) {
			apiError(w, 400, "任务记录 ID 不合法")
			return
		}
		if !seen[taskID] {
			seen[taskID] = true
			unique = append(unique, taskID)
		}
	}
	tx, err := a.db.Begin()
	if err != nil {
		apiError(w, 500, "数据库不可用")
		return
	}
	defer tx.Rollback()
	deleted, skipped := 0, 0
	for _, taskID := range unique {
		var raw []byte
		if tx.QueryRow("SELECT body FROM records WHERE kind='task' AND id=?", taskID).Scan(&raw) != nil {
			continue
		}
		var task Task
		if json.Unmarshal(raw, &task) != nil || validAgentAction(task.Kind) {
			skipped++
			continue
		}
		result, err := tx.Exec("DELETE FROM records WHERE kind='task' AND id=?", taskID)
		if err != nil {
			apiError(w, 500, "批量删除失败")
			return
		}
		if n, _ := result.RowsAffected(); n > 0 {
			deleted++
		}
	}
	if err := tx.Commit(); err != nil {
		apiError(w, 500, "批量删除失败")
		return
	}
	a.audit("task.batch-delete", fmt.Sprintf("%d deleted; %d skipped", deleted, skipped))
	writeJSON(w, 200, map[string]int{"deleted": deleted, "skipped": skipped})
}
func (a *App) saveRecord(w http.ResponseWriter, r *http.Request, kind, recordID string) {
	if err := a.saveValidatedRecord(r, kind, recordID); err != nil {
		apiError(w, 400, err.Error())
		return
	}
	if kind == "node" {
		_, _ = a.db.Exec("DELETE FROM records WHERE kind='node_probe' AND id=?", recordID)
		a.signalNodeProbe()
	}
	a.audit(kind+".save", recordID)
	a.signalSync()
	writeJSON(w, 200, map[string]string{"id": recordID})
}
func (a *App) overview(w http.ResponseWriter) {
	monitor := a.komariOverview()
	servers := []Server{}
	for _, raw := range a.list("server") {
		var s Server
		if json.Unmarshal(raw, &s) != nil {
			continue
		}
		s.Status, s.LastSeen, s.Agent = "pending", "", false
		s.CPU, s.Memory, s.Disk, s.Upload, s.Download = 0, 0, 0, 0, 0
		if m, ok := monitor.Metrics[s.KomariUUID]; ok {
			s.LastSeen = m.Updated
			if m.Status == "online" {
				s.Status = "online"
			} else {
				s.Status = "warning"
			}
		}
		servers = append(servers, komariAssets(s, monitor.Nodes))
	}
	dailyTraffic, trafficSince := a.trafficDaily(62)
	writeJSON(w, 200, map[string]any{"servers": servers, "nodes": loadNodes(a), "nodeHealth": a.nodeHealth(), "nodeTests": a.protocolResults(), "ruleTemplates": a.ruleTemplates(), "members": a.memberViews(), "subscriptions": a.list("subscription"), "profiles": a.list("profile"), "tasks": a.list("task"), "panels": a.list("panel"), "grants": a.list("grant"), "syncSettings": map[string]any{"observeMode": a.observeMode()}, "komari": monitor, "trafficDaily": dailyTraffic, "trafficSince": trafficSince, "fetchStats": a.fetchStats30d(), "generatedAt": now(), "capabilities": map[string]bool{"recordManagement": true, "subscriptionExport": true, "nodeEnrollment": true, "credentialSync": true, "nodeProbe": true, "protocolProbe": true, "connectionLimitPolicy": true, "nativeConnectionEnforcement": false}})
}
func loadNodes(a *App) []Node {
	nodes := []Node{}
	for _, raw := range a.list("node") {
		var n Node
		if json.Unmarshal(raw, &n) == nil {
			nodes = append(nodes, n)
		}
	}
	return nodes
}
func (a *App) issueSubscription(w http.ResponseWriter, r *http.Request, profileID string) {
	var p Profile
	if err := a.get("profile", profileID, &p); err != nil {
		apiError(w, 404, "订阅不存在")
		return
	}
	var in struct {
		Rotate bool   `json:"rotate"`
		Format string `json:"format"`
	}
	if r.Body != nil && r.ContentLength != 0 {
		if decodeBody(r, &in) != nil {
			apiError(w, 400, "请求格式不正确")
			return
		}
	}
	p.Format = defaultString(in.Format, p.Format)
	if _, err := a.render(p); err != nil {
		apiError(w, 409, err.Error())
		return
	}
	tx, err := a.db.Begin()
	if err != nil {
		apiError(w, 500, "数据库不可用")
		return
	}
	defer tx.Rollback()
	var count int
	if err = tx.QueryRow("SELECT count(*) FROM access_tokens WHERE profile=?", profileID).Scan(&count); err != nil {
		apiError(w, 500, "无法读取订阅链接")
		return
	}
	if count > 0 && !in.Rotate {
		apiError(w, 409, "已有订阅链接；请明确选择重新生成，旧链接将立即失效")
		return
	}
	t := token()
	if _, err = tx.Exec("DELETE FROM access_tokens WHERE profile=?", profileID); err != nil {
		apiError(w, 500, "无法更新订阅链接")
		return
	}
	if _, err = tx.Exec("INSERT INTO access_tokens VALUES(?,?)", hash(t), profileID); err != nil {
		apiError(w, 500, "无法创建订阅链接")
		return
	}
	if err = tx.Commit(); err != nil {
		apiError(w, 500, "保存失败")
		return
	}
	a.audit("subscription.issue", profileID)
	writeJSON(w, 200, map[string]string{"url": fmt.Sprintf("%s/sub/%s?format=%s", a.origin, t, p.Format), "portalUrl": fmt.Sprintf("%s/me/%s", a.origin, t), "warning": "链接仅本次显示，请妥善保存；重新生成会使旧链接失效"})
}
func (a *App) subProfile(tokenValue string) (Profile, error) {
	var pid string
	if err := a.db.QueryRow("SELECT profile FROM access_tokens WHERE digest=?", hash(tokenValue)).Scan(&pid); err != nil {
		return Profile{}, err
	}
	var p Profile
	if err := a.get("profile", pid, &p); err != nil {
		return p, err
	}
	return p, nil
}
func (a *App) previewSubscription(w http.ResponseWriter, r *http.Request, profileID string) {
	var p Profile
	if err := a.get("profile", profileID, &p); err != nil {
		apiError(w, 404, "订阅不存在")
		return
	}
	p.Format = defaultString(r.URL.Query().Get("format"), p.Format)
	body, err := a.render(p)
	if err != nil {
		apiError(w, 409, err.Error())
		return
	}
	writeJSON(w, 200, map[string]string{"content": string(body), "format": p.Format, "warning": "预览包含节点凭据，请勿公开"})
}
func subscriptionUserinfo(m Member) string {
	info := fmt.Sprintf("upload=0; download=%d; total=%d", int64(memberQuotaUsed(m)*1e9), int64(m.Limit*1e9))
	if exp, err := memberExpiry(m.Expires); err == nil && !exp.IsZero() {
		info += fmt.Sprintf("; expire=%d", exp.Unix())
	}
	return info
}
func (a *App) subscription(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		apiError(w, 405, "method not allowed")
		return
	}
	tokenValue := strings.TrimPrefix(r.URL.Path, "/sub/")
	p, err := a.subProfile(tokenValue)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	var m Member
	p.Format = defaultString(r.URL.Query().Get("format"), p.Format)
	fetchStatus := http.StatusOK
	defer func() { a.recordFetch(r, p, fetchStatus, tokenValue) }()
	if err := a.get("member", p.MemberID, &m); err != nil || !m.Enabled {
		fetchStatus = http.StatusNotFound
		http.NotFound(w, r)
		return
	}
	if err := checkMember(m, time.Now()); err != nil {
		fetchStatus = http.StatusGone
		http.Error(w, "subscription unavailable", http.StatusGone)
		return
	}
	p.Format = defaultString(r.URL.Query().Get("format"), p.Format)
	if !supportedFormat(p.Format) {
		fetchStatus = http.StatusBadRequest
		apiError(w, 400, "不支持的订阅格式")
		return
	}
	body, err := a.render(p)
	if err != nil {
		fetchStatus = http.StatusConflict
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	w.Header().Set("Subscription-Userinfo", subscriptionUserinfo(m))
	w.Header().Set("Profile-Web-Page-Url", fmt.Sprintf("%s/me/%s", a.origin, tokenValue))
	w.Header().Set("Profile-Update-Interval", "6")
	if p.Format == "clash" {
		w.Header().Set("Content-Type", "text/yaml; charset=utf-8")
	} else {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	_, _ = w.Write(body)
}
func (a *App) render(p Profile) ([]byte, error) {
	if !supportedFormat(p.Format) {
		return nil, errors.New("不支持的订阅格式")
	}
	var m Member
	if err := a.get("member", p.MemberID, &m); err != nil {
		return nil, errors.New("用户不存在")
	}
	if err := checkMember(m, time.Now()); err != nil {
		return nil, err
	}
	nodes := []Node{}
	names := map[string]bool{"节点选择": true, "自动选择": true, "故障转移": true, "DIRECT": true, "REJECT": true, "AI": true, "Telegram": true, "流媒体": true}
	for _, raw := range a.list("node") {
		var n Node
		if json.Unmarshal(raw, &n) != nil || !n.Enabled || !containsID(p.NodeIDs, n.ID) || !containsID(m.NodeIDs, n.ID) {
			continue
		}
		if err := a.validateNode(n); err != nil {
			return nil, err
		}
		if names[n.Name] {
			return nil, errors.New("订阅内节点名称重复或使用了保留名称，请先重命名")
		}
		names[n.Name] = true
		if n.Security == "reality" && n.PublicKey == "" {
			return nil, errors.New("REALITY 节点尚未填写公钥")
		}
		var s string
		var err error
		if n.PanelID != "" {
			s, err = a.managedCredential(m, n)
		} else {
			s, err = a.readSecret("node_secret", n.ID)
		}
		if err != nil || s == "" {
			return nil, errors.New("所选节点缺少可用凭据，请检查节点配置")
		}
		n.Credential = s
		nodes = append(nodes, n)
	}
	if len(nodes) == 0 {
		return nil, errors.New("没有可导出的已配置节点")
	}
	if p.Format == "v2ray" || p.Format == "base64" {
		return []byte(base64.StdEncoding.EncodeToString([]byte(strings.Join(v2rayLines(nodes), "\n")))), nil
	}
	return a.renderProfileClash(nodes, p)
}
func (n Node) SNIText() string { return defaultString(n.SNI, n.WSHost) }
func defaultString(s, f string) string {
	if s == "" {
		return f
	}
	return s
}
func (a *App) web(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/demo" || strings.HasPrefix(r.URL.Path, "/demo/") {
		http.NotFound(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		apiError(w, 404, "接口不存在")
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	data, err := fs.ReadFile(assets, "web/dist/"+path)
	if err != nil {
		data, err = fs.ReadFile(assets, "web/dist/index.html")
		path = "index.html"
	}
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if ct := mime.TypeByExtension("." + strings.Split(path, ".")[len(strings.Split(path, "."))-1]); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if path == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	} else if strings.HasSuffix(path, ".js") || strings.HasSuffix(path, ".css") {
		w.Header().Set("Cache-Control", "public, max-age=300")
	}
	_, _ = w.Write(data)
}
