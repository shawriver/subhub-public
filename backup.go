package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"golang.org/x/crypto/scrypt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type backupRecord struct {
	Kind string          `json:"kind"`
	ID   string          `json:"id"`
	Body json.RawMessage `json:"body"`
}
type backupSecret struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Value string `json:"value"`
}
type backupData struct {
	Version int            `json:"version"`
	Created string         `json:"created"`
	Records []backupRecord `json:"records"`
	Secrets []backupSecret `json:"secrets"`
}

// Account credentials/sessions are deliberately not restored. Recovery imports
// data into an already-initialized destination administrator account.
func (a *App) snapshot() (backupData, error) {
	v := backupData{Version: 1, Created: now(), Records: []backupRecord{}, Secrets: []backupSecret{}}
	rows, err := a.db.Query("SELECT kind,id,body FROM records WHERE kind IN ('server','node','member','profile','subscription','panel','grant','rule_template')")
	if err != nil {
		return v, err
	}
	for rows.Next() {
		var r backupRecord
		if err = rows.Scan(&r.Kind, &r.ID, &r.Body); err != nil {
			rows.Close()
			return v, err
		}
		v.Records = append(v.Records, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return v, err
	}
	rows, err = a.db.Query("SELECT kind,id,value FROM secrets WHERE kind IN ('node_secret','panel_token','grant_secret')")
	if err != nil {
		return v, err
	}
	defer rows.Close()
	for rows.Next() {
		var s backupSecret
		var b []byte
		if err = rows.Scan(&s.Kind, &s.ID, &b); err != nil {
			return v, err
		}
		n := a.seal.NonceSize()
		if len(b) < n {
			return v, errors.New("备份凭据损坏")
		}
		p, e := a.seal.Open(nil, b[:n], b[n:], []byte(s.Kind+":"+s.ID))
		if e != nil {
			return v, errors.New("备份凭据解密失败")
		}
		s.Value = string(p)
		v.Secrets = append(v.Secrets, s)
	}
	return v, rows.Err()
}
func sealBackup(v backupData, pass string) (string, error) {
	if len(pass) < 14 || len(pass) > 128 {
		return "", errors.New("备份密码需 14–128 字节")
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	salt := make([]byte, 16)
	rand.Read(salt)
	key, err := scrypt.Key([]byte(pass), salt, 32768, 8, 1, 32)
	if err != nil {
		return "", err
	}
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	nonce := make([]byte, aead.NonceSize())
	rand.Read(nonce)
	out := append([]byte("SUBHUB01"), salt...)
	out = append(out, nonce...)
	out = aead.Seal(out, nonce, raw, []byte("SUBHUB01"))
	return base64.StdEncoding.EncodeToString(out), nil
}
func openBackup(content, pass string) (backupData, error) {
	var v backupData
	if len(content) > 12<<20 || len(pass) > 128 {
		return v, errors.New("备份过大或密码不合法")
	}
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(content))
	if err != nil || len(b) < 52 || string(b[:8]) != "SUBHUB01" {
		return v, errors.New("不是有效的 SubHub 加密备份")
	}
	key, err := scrypt.Key([]byte(pass), b[8:24], 32768, 8, 1, 32)
	if err != nil {
		return v, err
	}
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	raw, err := aead.Open(nil, b[24:36], b[36:], []byte("SUBHUB01"))
	if err != nil {
		return v, errors.New("备份密码不正确或文件损坏")
	}
	if json.Unmarshal(raw, &v) != nil || v.Version != 1 || len(v.Records) > 10000 || len(v.Secrets) > 10000 {
		return v, errors.New("不支持的备份数据")
	}
	return v, nil
}
func (a *App) restoreSnapshot(v backupData) error {
	kinds := map[string]bool{"server": true, "node": true, "member": true, "profile": true, "subscription": true, "panel": true, "grant": true, "rule_template": true}
	secretKinds := map[string]bool{"node_secret": true, "panel_token": true, "grant_secret": true}
	records := map[string]backupRecord{}
	secrets := map[string]backupSecret{}
	for _, r := range v.Records {
		if !kinds[r.Kind] || !recordIDPattern.MatchString(r.ID) || !json.Valid(r.Body) {
			return errors.New("备份含无效记录")
		}
		var meta struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(r.Body, &meta) != nil || meta.ID != r.ID {
			return errors.New("备份记录 ID 不一致")
		}
		k := r.Kind + ":" + r.ID
		if _, ok := records[k]; ok {
			return errors.New("备份含重复记录")
		}
		records[k] = r
	}
	for _, s := range v.Secrets {
		if !secretKinds[s.Kind] || !recordIDPattern.MatchString(s.ID) {
			return errors.New("备份含无效凭据")
		}
		k := s.Kind + ":" + s.ID
		if _, ok := secrets[k]; ok {
			return errors.New("备份凭据重复")
		}
		secrets[k] = s
	}
	for _, r := range records {
		switch r.Kind {
		case "panel":
			var p Panel
			if json.Unmarshal(r.Body, &p) != nil || validPanelURL(p.URL) != nil {
				return errors.New("备份面板无效")
			}
			if _, ok := records["server:"+p.ServerID]; !ok {
				return errors.New("备份面板关联缺失")
			}
		case "member":
			var m Member
			if json.Unmarshal(r.Body, &m) != nil || !validQuota(m.Used, m.Limit) || !validCycle(m) || m.DeviceLimit < 0 || m.DeviceLimit > 999 ||
				(m.ConnectionLimitOverride != nil && !validConnectionLimit(*m.ConnectionLimitOverride)) {
				return errors.New("备份用户无效")
			}
			if _, err := memberExpiry(m.Expires); err != nil {
				return err
			}
			if (m.AssignmentMode != "" && m.AssignmentMode != "nodes" && m.AssignmentMode != "subscriptions") ||
				(m.AssignmentMode == "nodes" && m.SubscriptionIDs != nil) ||
				(m.AssignmentMode == "subscriptions" && m.SubscriptionIDs == nil) {
				return errors.New("备份用户分配方式无效")
			}
			if m.SubscriptionIDs != nil {
				nodes, err := subscriptionNodes(m.SubscriptionIDs, func(id string) (Subscription, error) {
					var s Subscription
					r, ok := records["subscription:"+id]
					if !ok {
						return s, errors.New("备份订阅关联缺失")
					}
					err := json.Unmarshal(r.Body, &s)
					return s, err
				})
				if err != nil {
					return err
				}
				if len(uniqueIDs(allocationNodes(m))) != len(nodes) {
					return errors.New("备份用户节点与订阅不一致")
				}
				for _, nid := range nodes {
					if !containsID(allocationNodes(m), nid) {
						return errors.New("备份用户节点与订阅不一致")
					}
				}
			}
			if m.AllocationNodeIDs != nil {
				effective := append([]string{}, m.AllocationNodeIDs...)
				for _, record := range records {
					if record.Kind == "profile" {
						var p Profile
						if json.Unmarshal(record.Body, &p) != nil {
							return errors.New("备份订阅无效")
						}
						if p.MemberID == m.ID && p.CustomNodes {
							effective = append(effective, p.NodeIDs...)
						}
					}
				}
				effective = uniqueIDs(effective)
				if len(effective) != len(uniqueIDs(m.NodeIDs)) {
					return errors.New("备份定制订阅与用户节点不一致")
				}
				for _, nid := range effective {
					if !containsID(m.NodeIDs, nid) {
						return errors.New("备份定制订阅与用户节点不一致")
					}
				}
			}
			for _, nid := range m.NodeIDs {
				if _, ok := records["node:"+nid]; !ok {
					return errors.New("备份节点关联缺失")
				}
			}
		case "subscription":
			var s Subscription
			if json.Unmarshal(r.Body, &s) != nil || strings.TrimSpace(s.Name) == "" || !validConnectionLimit(s.ConnectionLimit) {
				return errors.New("备份订阅无效")
			}
			for _, nid := range s.NodeIDs {
				if _, ok := records["node:"+nid]; !ok {
					return errors.New("备份订阅节点关联缺失")
				}
			}
		case "rule_template":
			var tpl RuleTemplate
			if json.Unmarshal(r.Body, &tpl) != nil || validateRuleTemplate(tpl) != nil {
				return errors.New("备份模板无效")
			}
			for _, builtin := range builtinTemplates() {
				if tpl.ID == builtin.ID {
					return errors.New("备份不能覆盖内置模板")
				}
			}
		case "profile":
			var p Profile
			json.Unmarshal(r.Body, &p)
			if p.CustomNodes && p.FollowMemberNodes {
				return errors.New("备份定制订阅分配方式无效")
			}
			if p.TemplateID != "" {
				found := false
				for _, t := range builtinTemplates() {
					if p.TemplateID == t.ID {
						found = true
					}
				}
				if _, ok := records["rule_template:"+p.TemplateID]; ok {
					found = true
				}
				if !found {
					return errors.New("备份模板关联缺失")
				}
			}
			if !supportedFormat(p.Format) {
				return errors.New("备份订阅格式无效")
			}
			if _, ok := records["member:"+p.MemberID]; !ok {
				return errors.New("备份用户关联缺失")
			}
			var member Member
			json.Unmarshal(records["member:"+p.MemberID].Body, &member)
			if p.CustomNodes && member.AllocationNodeIDs == nil {
				return errors.New("备份定制订阅缺少基础分配")
			}
			for _, nid := range p.NodeIDs {
				if _, ok := records["node:"+nid]; !ok || !containsID(member.NodeIDs, nid) {
					return errors.New("备份订阅节点关联缺失")
				}
			}
		case "grant":
			var g Grant
			json.Unmarshal(r.Body, &g)
			if _, ok := records["panel:"+g.PanelID]; !ok {
				return errors.New("备份授权面板缺失")
			}
		}
	}
	// Retain cleanup tombstones for identities created since the backup. Never
	// forget an active remote authorization during a rollback.
	for _, raw := range a.list("grant") {
		var g Grant
		json.Unmarshal(raw, &g)
		currentSecret, err := a.readSecret("grant_secret", g.ID)
		if err != nil {
			return errors.New("当前授权凭据损坏，无法安全恢复")
		}
		if old, ok := secrets["grant_secret:"+g.ID]; ok && old.Value != currentSecret {
			return errors.New("授权身份已变更，请先停用相关用户并完成撤销")
		}
		if _, ok := records["grant:"+g.ID]; !ok {
			g.Retired = true
			g.State = "pending"
			b, _ := json.Marshal(g)
			records["grant:"+g.ID] = backupRecord{"grant", g.ID, b}
			secrets["grant_secret:"+g.ID] = backupSecret{"grant_secret", g.ID, currentSecret}
		}
		var panel Panel
		if a.get("panel", g.PanelID, &panel) != nil {
			return errors.New("当前授权面板缺失")
		}
		if r, ok := records["panel:"+g.PanelID]; ok {
			var saved Panel
			json.Unmarshal(r.Body, &saved)
			if saved.URL != panel.URL {
				return errors.New("面板地址已变化，不能自动恢复授权")
			}
		} else {
			b, _ := json.Marshal(panel)
			records["panel:"+panel.ID] = backupRecord{"panel", panel.ID, b}
			token, err := a.readSecret("panel_token", panel.ID)
			if err != nil {
				return errors.New("面板凭据不可用")
			}
			secrets["panel_token:"+panel.ID] = backupSecret{"panel_token", panel.ID, token}
			var server Server
			if a.get("server", panel.ServerID, &server) == nil {
				if _, ok := records["server:"+server.ID]; !ok {
					b, _ = json.Marshal(server)
					records["server:"+server.ID] = backupRecord{"server", server.ID, b}
				}
			}
		}
	}
	tx, err := a.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, query := range []string{"DELETE FROM records WHERE kind IN ('server','node','node_probe','node_test','node_test_history','member','profile','subscription','panel','grant','rule_template')", "DELETE FROM secrets WHERE kind IN ('node_secret','panel_token','grant_secret')", "DELETE FROM access_tokens", "DELETE FROM sessions", "DELETE FROM subscription_fetches"} {
		if _, err = tx.Exec(query); err != nil {
			return err
		}
	}
	for _, r := range records {
		if r.Kind == "grant" {
			var g Grant
			json.Unmarshal(r.Body, &g)
			g.State, g.Lease = "pending", 0
			r.Body, _ = json.Marshal(g)
		}
		if _, err = tx.Exec("INSERT INTO records VALUES(?,?,?)", r.Kind, r.ID, r.Body); err != nil {
			return err
		}
	}
	for _, s := range secrets {
		if _, err = tx.Exec("INSERT INTO secrets VALUES(?,?,?)", s.Kind, s.ID, a.encrypt(s.Kind+":"+s.ID, s.Value)); err != nil {
			return err
		}
	}
	if err = migrateSubscriptionsTx(tx); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	a.audit("backup.restore", "workspace")
	a.signalSync()
	return nil
}
func (a *App) backupFiles() []string {
	names := []string{}
	entries, err := os.ReadDir(filepath.Join(a.dir, "backups"))
	if err != nil {
		return names
	}
	for _, e := range entries {
		if e.Type().IsRegular() && strings.HasPrefix(e.Name(), "daily-") && strings.HasSuffix(e.Name(), ".sealed") {
			names = append(names, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	return names
}

// Only metadata leaves this method. Decrypted records and service credentials
// stay in memory, and integrity verification does not claim a restore rehearsal.
type localBackupInfo struct {
	Name      string         `json:"name"`
	CreatedAt string         `json:"createdAt"`
	Size      int64          `json:"size"`
	Status    string         `json:"status"`
	Detail    string         `json:"detail"`
	Counts    map[string]int `json:"counts"`
}

func (a *App) inspectLocalBackup(name string) localBackupInfo {
	v := localBackupInfo{Name: name, Status: "unreadable", Detail: "文件无法读取", Counts: map[string]int{}}
	path := filepath.Join(a.dir, "backups", name)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return v
	}
	v.Size = info.Size()
	if info.Size() > 16<<20 {
		v.Status, v.Detail = "unchecked", "文件超过 16 MiB，未执行自动校验"
		return v
	}
	f, err := os.Open(path)
	if err != nil {
		return v
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, (16<<20)+1))
	if err != nil || len(b) > 16<<20 {
		return v
	}
	v.Status, v.Detail = "invalid", "完整性校验失败，文件损坏或主密钥不匹配"
	n := a.seal.NonceSize()
	if len(b) < n+a.seal.Overhead() {
		return v
	}
	raw, err := a.seal.Open(nil, b[:n], b[n:], []byte("backup:v1"))
	if err != nil {
		return v
	}
	var snapshot backupData
	if json.Unmarshal(raw, &snapshot) != nil || snapshot.Version != 1 {
		v.Detail = "备份格式不受支持"
		return v
	}
	if _, err := time.Parse(time.RFC3339, snapshot.Created); err != nil {
		v.Detail = "备份创建时间无效"
		return v
	}
	v.CreatedAt = snapshot.Created
	for _, record := range snapshot.Records {
		switch record.Kind {
		case "server", "node", "member", "profile", "subscription", "panel", "grant", "rule_template":
			v.Counts[record.Kind]++
		}
	}
	v.Status, v.Detail = "verified", "加密完整性与格式校验通过；未执行恢复演练"
	if len(snapshot.Records) == 0 {
		v.Status, v.Detail = "empty", "完整性通过，但不含业务记录"
	}
	return v
}

func (a *App) localBackups() []localBackupInfo {
	result := []localBackupInfo{}
	for _, name := range a.backupFiles() {
		if len(result) == 7 {
			break
		}
		result = append(result, a.inspectLocalBackup(name))
	}
	return result
}

type backupOperationError struct {
	stage string
	err   error
}

func (e *backupOperationError) Error() string { return e.stage + ": " + e.err.Error() }
func (e *backupOperationError) Unwrap() error { return e.err }

func backupFailureDetail(err error) string {
	detail := "自动备份失败"
	var op *backupOperationError
	if errors.As(err, &op) {
		detail += "：" + op.stage
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		// The OS cause is useful; the path or snapshot payload must not be logged.
		return detail + "（" + pathErr.Err.Error() + "）"
	}
	for _, reason := range []string{"备份凭据损坏", "备份凭据解密失败", "现有备份完整性校验失败"} {
		if strings.Contains(err.Error(), reason) {
			return detail + "（" + reason + "）"
		}
	}
	return detail + "；请检查数据目录及数据库状态"
}

func (a *App) automaticBackup(force bool) error {
	date := time.Now().UTC().Format("20060102")
	name := "daily-" + date + ".sealed"
	if force {
		name = "daily-" + time.Now().UTC().Format("20060102-150405") + ".sealed"
	}
	dir := filepath.Join(a.dir, "backups")
	path := filepath.Join(dir, name)
	if _, err := os.Lstat(path); err == nil {
		checked := a.inspectLocalBackup(name)
		if checked.Status == "verified" || checked.Status == "empty" {
			return nil
		}
		return &backupOperationError{"校验已有文件", errors.New("现有备份完整性校验失败")}
	} else if !errors.Is(err, os.ErrNotExist) {
		return &backupOperationError{"检查备份路径", err}
	}
	v, err := a.snapshot()
	if err != nil {
		return &backupOperationError{"读取数据快照", err}
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return &backupOperationError{"编码数据快照", err}
	}
	if err = os.MkdirAll(dir, 0700); err != nil {
		return &backupOperationError{"创建备份目录", err}
	}
	if err = os.WriteFile(path+".tmp", a.encrypt("backup:v1", string(raw)), 0600); err != nil {
		return &backupOperationError{"写入加密文件", err}
	}
	if err = os.Rename(path+".tmp", path); err != nil {
		return &backupOperationError{"提交备份文件", err}
	}
	files := a.backupFiles()
	for i := 7; i < len(files); i++ {
		if err = os.Remove(filepath.Join(dir, files[i])); err != nil {
			return &backupOperationError{"清理过期备份", err}
		}
	}
	return nil
}

// recordBackupTask keeps the dashboard's daily-backup task in step with the
// real result. A later success clears an earlier failure instead of leaving a
// permanent alert behind.
func (a *App) recordBackupTask(err error) {
	if err != nil {
		_ = a.put("task", "backup-latest", Task{ID: "backup-latest", Name: "每日备份", Kind: "backup", Created: now(), Status: "failed", Detail: backupFailureDetail(err)})
		return
	}
	var previous Task
	if a.get("task", "backup-latest", &previous) == nil && previous.Status == "success" && strings.HasPrefix(previous.Created, time.Now().UTC().Format("2006-01-02")) {
		return
	}
	_ = a.put("task", "backup-latest", Task{ID: "backup-latest", Name: "每日备份", Kind: "backup", Created: now(), Status: "success", Detail: "每日加密备份完成，保留最近 7 份"})
}

func (a *App) backupAPI(w http.ResponseWriter, r *http.Request, path string) bool {
	if !strings.HasPrefix(path, "backup/") || r.Method != "POST" {
		return false
	}
	if !a.reserveLogin("backup:"+requestID(r), time.Now()) {
		apiError(w, 429, "操作过于频繁")
		return true
	}
	var in struct {
		authProof
		Passphrase string `json:"passphrase"`
		Content    string `json:"content"`
		Confirm    string `json:"confirm"`
		Digest     string `json:"digest"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if dec.Decode(&in) != nil || dec.Decode(new(any)) != io.EOF {
		apiError(w, 400, "请求格式不正确")
		return true
	}
	if err := a.verifyProof(in.authProof); err != nil {
		apiError(w, 403, err.Error())
		return true
	}
	switch path {
	case "backup/export":
		v, err := a.snapshot()
		if err != nil {
			apiError(w, 500, "无法创建备份")
			return true
		}
		content, err := sealBackup(v, in.Passphrase)
		if err != nil {
			apiError(w, 400, err.Error())
			return true
		}
		a.audit("backup.export", "workspace")
		writeJSON(w, 200, map[string]string{"content": content, "filename": "subhub-" + time.Now().UTC().Format("20060102") + ".shb"})
	case "backup/preview", "backup/restore":
		v, err := openBackup(in.Content, in.Passphrase)
		if err != nil {
			apiError(w, 400, err.Error())
			return true
		}
		digest := hash(in.Content)
		if path == "backup/preview" {
			counts := map[string]int{}
			for _, rec := range v.Records {
				counts[rec.Kind]++
			}
			writeJSON(w, 200, map[string]any{"created": v.Created, "counts": counts, "digest": digest})
			return true
		}
		if in.Confirm != "恢复" || in.Digest != digest {
			apiError(w, 400, "请先预览同一备份，并输入“恢复”确认")
			return true
		}
		if err = a.automaticBackup(true); err != nil {
			apiError(w, 500, "恢复前备份失败，已取消恢复")
			return true
		}
		if err = a.restoreSnapshot(v); err != nil {
			apiError(w, 400, err.Error())
			return true
		}
		writeJSON(w, 200, map[string]bool{"loginRequired": true})
	case "backup/now":
		if err := a.automaticBackup(true); err != nil {
			a.recordBackupTask(err)
			apiError(w, 500, backupFailureDetail(err))
		} else {
			a.recordBackupTask(nil)
			a.audit("backup.create", "workspace")
			writeJSON(w, 200, map[string]bool{"ok": true})
		}
	default:
		apiError(w, 404, "操作不存在")
	}
	return true
}
