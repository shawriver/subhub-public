package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func cookieRequest(a *App, method, path string, cookie *http.Cookie, mutationHeader bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if mutationHeader {
		r.Header.Set("X-SubHub-Request", "1")
	}
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}

func TestRememberedAndTemporaryLogin(t *testing.T) {
	a := testApp(t)
	password := token()
	h, _ := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	a.db.Exec("INSERT INTO admin VALUES('admin',?)", h)
	for _, remember := range []bool{true, false} {
		w := request(a, "POST", "/api/login", map[string]any{"username": "admin", "password": password, "remember": remember}, false)
		if w.Code != 200 {
			t.Fatal("login failed")
		}
		cookies := w.Result().Cookies()
		if len(cookies) != 1 {
			t.Fatal("missing session cookie")
		}
		c := cookies[0]
		if !c.HttpOnly || !c.Secure || c.Path != "/" || c.SameSite != http.SameSiteLaxMode {
			t.Fatal("invalid cookie protection")
		}
		var expires int64
		a.db.QueryRow("SELECT expires FROM sessions WHERE digest=?", hash(c.Value)).Scan(&expires)
		if remember {
			if c.MaxAge < 29*24*3600 || c.Expires.Before(time.Now().Add(29*24*time.Hour)) || expires < time.Now().Add(29*24*time.Hour).Unix() {
				t.Fatal("remembered session is not persistent")
			}
		} else if c.MaxAge != 0 || !c.Expires.IsZero() || expires > time.Now().Add(12*time.Hour).Unix() || !strings.HasPrefix(c.Value, "s.") {
			t.Fatal("temporary session retained beyond policy")
		}
		if cookieRequest(a, "GET", "/api/admin/overview", c, false).Code != 200 {
			t.Fatal("new session rejected")
		}
		if cookieRequest(a, "POST", "/api/logout", c, false).Code != 403 {
			t.Fatal("cross-site logout not blocked")
		}
		w = cookieRequest(a, "POST", "/api/logout", c, true)
		if w.Code != 200 || w.Result().Cookies()[0].MaxAge != -1 {
			t.Fatal("logout did not clear cookie")
		}
		if cookieRequest(a, "GET", "/api/admin/overview", c, false).Code != 401 {
			t.Fatal("logout token remains usable")
		}
	}
}

func TestSessionRefreshPreservesLegacyAndCannotReviveRevoked(t *testing.T) {
	a := testApp(t)
	for _, value := range []string{token(), "r." + token(), "s." + token()} {
		expires := time.Now().Add(time.Hour).Unix()
		a.db.Exec("INSERT INTO sessions VALUES(?,?)", hash(value), expires)
		cookie := &http.Cookie{Name: "subhub_session", Value: value}
		w := cookieRequest(a, "GET", "/api/session", cookie, false)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"authenticated":true`) {
			t.Fatal("valid session not restored")
		}
		var actual int64
		a.db.QueryRow("SELECT expires FROM sessions WHERE digest=?", hash(value)).Scan(&actual)
		if strings.HasPrefix(value, "s.") {
			if actual != expires || len(w.Result().Cookies()) != 0 {
				t.Fatal("temporary session unexpectedly extended")
			}
		} else {
			if actual < time.Now().Add(29*24*time.Hour).Unix() || len(w.Result().Cookies()) != 1 {
				t.Fatal("remembered session not extended")
			}
			if len(cookieRequest(a, "GET", "/api/session", cookie, false).Result().Cookies()) != 0 {
				t.Fatal("unnecessary repeated renewal")
			}
		}
		a.db.Exec("UPDATE sessions SET expires=? WHERE digest=?", time.Now().Add(-time.Second).Unix(), hash(value))
		w = cookieRequest(a, "GET", "/api/session", cookie, false)
		if !strings.Contains(w.Body.String(), `"authenticated":false`) || len(w.Result().Cookies()) != 0 {
			t.Fatal("expired session revived")
		}
		a.db.Exec("DELETE FROM sessions WHERE digest=?", hash(value))
		if !strings.Contains(cookieRequest(a, "GET", "/api/session", cookie, false).Body.String(), `"authenticated":false`) {
			t.Fatal("revoked session revived")
		}
	}
	if cookieRequest(a, "POST", "/api/session", nil, false).Code != 405 {
		t.Fatal("unsupported session method accepted")
	}
}

func TestSessionSurvivesAppReopenAndDatabaseErrorIsNotLogout(t *testing.T) {
	dir := t.TempDir()
	a, err := newApp(dir, "https://subhub.example.test")
	if err != nil {
		t.Fatal(err)
	}
	value := "r." + token()
	a.db.Exec("INSERT INTO sessions VALUES(?,?)", hash(value), time.Now().Add(rememberedSessionTTL).Unix())
	a.db.Close()
	a, err = newApp(dir, "https://subhub.example.test")
	if err != nil {
		t.Fatal(err)
	}
	c := &http.Cookie{Name: "subhub_session", Value: value}
	w := cookieRequest(a, "GET", "/api/session", c, false)
	var result struct{ Authenticated bool }
	json.Unmarshal(w.Body.Bytes(), &result)
	if w.Code != 200 || !result.Authenticated {
		t.Fatal("session lost on app restart")
	}
	a.db.Close()
	w = cookieRequest(a, "GET", "/api/session", c, false)
	if w.Code != 503 || len(w.Result().Cookies()) != 0 {
		t.Fatal("database outage incorrectly reported as logout")
	}
	if cookieRequest(a, "GET", "/api/admin/overview", c, false).Code != 503 {
		t.Fatal("admin lookup database failure incorrectly reported as logout")
	}
}
