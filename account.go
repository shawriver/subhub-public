package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"golang.org/x/crypto/bcrypt"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

type authProof struct {
	Password string `json:"password"`
	Code     string `json:"code"`
}

func totp(secret string, step int64) string {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(secret)
	if err != nil {
		return ""
	}
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, uint64(step))
	h := hmac.New(sha1.New, key)
	h.Write(b)
	sum := h.Sum(nil)
	o := sum[len(sum)-1] & 15
	v := binary.BigEndian.Uint32(sum[o:o+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", v%1000000)
}
func (a *App) otpEnabled() bool {
	var n int
	return a.db.QueryRow("SELECT count(*) FROM secrets WHERE kind='security' AND id='totp'").Scan(&n) == nil && n == 1
}

// The step counter is advanced atomically so a successful OTP cannot be replayed.
func (a *App) verifyOTP(code string) bool {
	var enabled int
	if a.db.QueryRow("SELECT count(*) FROM secrets WHERE kind='security' AND id='totp'").Scan(&enabled) != nil {
		return false
	}
	if enabled == 0 {
		return true
	}
	secret, err := a.readSecret("security", "totp")
	if err != nil || len(code) != 6 {
		return false
	}
	var counter int64 = -1
	for delta := int64(-1); delta <= 1; delta++ {
		s := time.Now().Unix()/30 + delta
		if subtle.ConstantTimeCompare([]byte(totp(secret, s)), []byte(code)) == 1 {
			counter = s
		}
	}
	if counter < 0 {
		return false
	}
	res, err := a.db.Exec("INSERT INTO auth_counter(id,step) VALUES('totp',?) ON CONFLICT(id) DO UPDATE SET step=excluded.step WHERE auth_counter.step < excluded.step", counter)
	if err != nil {
		return false
	}
	n, _ := res.RowsAffected()
	return n == 1
}
func (a *App) verifyProof(in authProof) error {
	var h string
	if a.db.QueryRow("SELECT password FROM admin LIMIT 1").Scan(&h) != nil || bcrypt.CompareHashAndPassword([]byte(h), []byte(in.Password)) != nil {
		return errors.New("当前密码不正确")
	}
	if !a.verifyOTP(in.Code) {
		return errors.New("验证码无效、已使用或设备时间不正确")
	}
	return nil
}
func (a *App) accountAPI(w http.ResponseWriter, r *http.Request, path string) bool {
	if path == "security" && r.Method == "GET" {
		writeJSON(w, 200, map[string]any{"totpEnabled": a.otpEnabled(), "backupSchedule": "每日，保留最近 7 份", "backupFiles": a.backupFiles(), "backups": a.localBackups()})
		return true
	}
	if !strings.HasPrefix(path, "security/") || r.Method != "POST" {
		return false
	}
	if !a.reserveLogin("security:"+requestID(r), time.Now()) {
		apiError(w, 429, "安全操作尝试过多，请稍后再试")
		return true
	}
	if !a.beginAuth(w) {
		return true
	}
	defer func() { <-a.authWork }()
	var in struct {
		authProof
		NewPassword string `json:"newPassword"`
	}
	if decodeBody(r, &in) != nil {
		apiError(w, 400, "请求格式不正确")
		return true
	}
	if err := a.verifyProof(in.authProof); err != nil {
		apiError(w, 403, err.Error())
		return true
	}
	switch path {
	case "security/password":
		if utf8.RuneCountInString(in.NewPassword) < 14 || len(in.NewPassword) > 72 {
			apiError(w, 400, "新密码至少 14 个字符且不超过 72 字节")
			return true
		}
		h, err := bcrypt.GenerateFromPassword([]byte(in.NewPassword), 12)
		if err != nil {
			apiError(w, 500, "无法处理密码")
			return true
		}
		tx, err := a.db.Begin()
		if err != nil {
			apiError(w, 500, "数据库不可用")
			return true
		}
		defer tx.Rollback()
		if _, err = tx.Exec("UPDATE admin SET password=?", h); err == nil {
			_, err = tx.Exec("DELETE FROM sessions")
		}
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			apiError(w, 500, "修改失败")
			return true
		}
		a.audit("admin.password", "admin")
		writeJSON(w, 200, map[string]bool{"loginRequired": true})
	case "security/totp/start":
		if a.otpEnabled() {
			apiError(w, 409, "二步验证已启用")
			return true
		}
		b := make([]byte, 20)
		rand.Read(b)
		secret := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b)
		pending, _ := json.Marshal(map[string]any{"secret": secret, "expires": time.Now().Add(10 * time.Minute).Unix()})
		if a.secret("security", "totp_pending", string(pending)) != nil {
			apiError(w, 500, "保存失败")
			return true
		}
		u := "otpauth://totp/SubHub:admin?secret=" + secret + "&issuer=" + url.QueryEscape("SubHub") + "&algorithm=SHA1&digits=6&period=30"
		writeJSON(w, 200, map[string]string{"secret": secret, "uri": u})
	case "security/totp/enable":
		raw, err := a.readSecret("security", "totp_pending")
		var p struct {
			Secret  string `json:"secret"`
			Expires int64  `json:"expires"`
		}
		if err != nil || json.Unmarshal([]byte(raw), &p) != nil || p.Expires < time.Now().Unix() {
			apiError(w, 400, "设置已过期，请重新开始")
			return true
		}
		good := false
		for d := int64(-1); d <= 1; d++ {
			good = good || subtle.ConstantTimeCompare([]byte(totp(p.Secret, time.Now().Unix()/30+d)), []byte(in.Code)) == 1
		}
		if !good {
			apiError(w, 400, "验证码不正确")
			return true
		}
		tx, err := a.db.Begin()
		if err != nil {
			apiError(w, 500, "数据库不可用")
			return true
		}
		defer tx.Rollback()
		_, err = tx.Exec("INSERT INTO secrets VALUES('security','totp',?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value", a.encrypt("security:totp", p.Secret))
		if err == nil {
			_, err = tx.Exec("DELETE FROM secrets WHERE kind='security' AND id='totp_pending'")
		}
		if err == nil {
			_, err = tx.Exec("DELETE FROM sessions")
		}
		if err == nil {
			_, err = tx.Exec("DELETE FROM auth_counter")
		}
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			apiError(w, 500, "保存失败")
			return true
		}
		a.audit("admin.totp.enable", "admin")
		writeJSON(w, 200, map[string]bool{"loginRequired": true})
	case "security/totp/disable":
		tx, err := a.db.Begin()
		if err != nil {
			apiError(w, 500, "数据库不可用")
			return true
		}
		defer tx.Rollback()
		_, err = tx.Exec("DELETE FROM secrets WHERE kind='security' AND id IN ('totp','totp_pending')")
		if err == nil {
			_, err = tx.Exec("DELETE FROM sessions")
		}
		if err == nil {
			err = tx.Commit()
		}
		if err != nil {
			apiError(w, 500, "保存失败")
			return true
		}
		a.audit("admin.totp.disable", "admin")
		writeJSON(w, 200, map[string]bool{"loginRequired": true})
	default:
		apiError(w, 404, "操作不存在")
	}
	return true
}
