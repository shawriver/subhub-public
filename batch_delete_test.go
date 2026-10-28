package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestBatchDeleteTasksSkipsProtectedKinds(t *testing.T) {
	a := testApp(t)
	for _, task := range []Task{
		{ID: "success-a", Name: "A", Kind: "sync", Status: "success"},
		{ID: "success-b", Name: "B", Kind: "backup", Status: "success"},
		{ID: "protected-a", Name: "C", Kind: "host-reboot", Status: "success"},
	} {
		if err := a.put("task", task.ID, task); err != nil {
			t.Fatal(err)
		}
	}
	body := `{"ids":["success-a","success-b","protected-a","missing"]}`
	w := requestRawJSON(a, "POST", "/api/admin/tasks/batch-delete", body, true)
	if w.Code != 200 {
		t.Fatalf("batch delete status=%d body=%s", w.Code, w.Body.String())
	}
	var result map[string]int
	if json.Unmarshal(w.Body.Bytes(), &result) != nil || result["deleted"] != 2 || result["skipped"] != 1 {
		t.Fatalf("unexpected result: %s", w.Body.String())
	}
	if len(a.list("task")) != 1 {
		t.Fatalf("protected task was removed")
	}
	var protected Task
	if a.get("task", "protected-a", &protected) != nil || protected.Kind != "host-reboot" {
		t.Fatalf("protected task was not preserved")
	}
}

func TestBatchDeleteTasksRejectsEmptyAndOversizedBatches(t *testing.T) {
	a := testApp(t)
	for _, body := range []string{
		`{"ids":[]}`,
		`{"ids":["bad id"]}`,
		`{"ids":` + strings.Repeat(`"task",`, 500) + `"task"]}`,
	} {
		if w := requestRawJSON(a, "POST", "/api/admin/tasks/batch-delete", body, true); w.Code != 400 {
			t.Fatalf("invalid batch accepted: status=%d body=%s", w.Code, w.Body.String())
		}
	}
	if w := requestRawJSON(a, "POST", "/api/admin/tasks/batch-delete", `{"ids":["task"]}`, false); w.Code != 401 {
		t.Fatal("unauthenticated batch delete accepted")
	}
}

func requestRawJSON(a *App, method, path, body string, admin bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "192.0.2.7:2000"
	r.Header.Set("X-SubHub-Request", "1")
	if admin {
		session := token()
		a.db.Exec("INSERT INTO sessions VALUES(?,?)", hash(session), time.Now().Add(time.Hour).Unix())
		r.AddCookie(&http.Cookie{Name: "subhub_session", Value: session})
	}
	w := httptest.NewRecorder()
	a.routes().ServeHTTP(w, r)
	return w
}
