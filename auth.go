package main

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

const rememberedSessionTTL = 30 * 24 * time.Hour
const temporarySessionTTL = 12 * time.Hour

func (a *App) setSessionCookie(w http.ResponseWriter, value string, expires time.Time, remember bool) {
	c := &http.Cookie{Name: "subhub_session", Value: value, Path: "/", HttpOnly: true,
		Secure: strings.HasPrefix(a.origin, "https://"), SameSite: http.SameSiteLaxMode}
	if remember {
		c.Expires = expires
		c.MaxAge = int(time.Until(expires).Seconds())
	}
	http.SetCookie(w, c)
}

func (a *App) session(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		apiError(w, 405, "method not allowed")
		return
	}
	c, err := r.Cookie("subhub_session")
	if err != nil {
		writeJSON(w, 200, map[string]bool{"authenticated": false})
		return
	}
	var exp int64
	err = a.db.QueryRow("SELECT expires FROM sessions WHERE digest=?", hash(c.Value)).Scan(&exp)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		apiError(w, 503, "暂时无法确认登录状态，请重试")
		return
	}
	at := time.Now()
	if errors.Is(err, sql.ErrNoRows) || exp <= at.Unix() {
		writeJSON(w, 200, map[string]bool{"authenticated": false})
		return
	}
	// The prefix is covered by the stored token hash. Changing it invalidates
	// the credential. Older, unprefixed sessions remain persistent and valid.
	remember := !strings.HasPrefix(c.Value, "s.")
	if remember && exp < at.Add(rememberedSessionTTL-24*time.Hour).Unix() {
		refreshed := at.Add(rememberedSessionTTL)
		res, updateErr := a.db.Exec("UPDATE sessions SET expires=? WHERE digest=? AND expires>?", refreshed.Unix(), hash(c.Value), at.Unix())
		if updateErr != nil {
			apiError(w, 503, "暂时无法延长登录状态，请重试")
			return
		}
		n, updateErr := res.RowsAffected()
		if updateErr != nil {
			apiError(w, 503, "暂时无法确认登录状态，请重试")
			return
		}
		if n == 0 {
			writeJSON(w, 200, map[string]bool{"authenticated": false})
			return
		}
		exp = refreshed.Unix()
		a.setSessionCookie(w, c.Value, refreshed, true)
	}
	writeJSON(w, 200, map[string]any{"authenticated": true, "remembered": remember, "expiresAt": exp})
}

func (a *App) reserveLogin(ip string, at time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	cut := at.Add(-10 * time.Minute)
	for key, attempts := range a.attempts {
		kept := attempts[:0]
		for _, stamp := range attempts {
			if stamp.After(cut) {
				kept = append(kept, stamp)
			}
		}
		if len(kept) == 0 {
			delete(a.attempts, key)
		} else {
			a.attempts[key] = kept
		}
	}
	attempts := a.attempts[ip]
	if len(attempts) >= 8 || (len(attempts) == 0 && len(a.attempts) >= 4096) {
		return false
	}
	// Reserve before password verification, including concurrent requests.
	a.attempts[ip] = append(attempts, at)
	return true
}

func (a *App) beginAuth(w http.ResponseWriter) bool {
	select {
	case a.authWork <- struct{}{}:
		return true
	default:
		w.Header().Set("Retry-After", "2")
		apiError(w, 429, "登录请求繁忙，请稍后再试")
		return false
	}
}
