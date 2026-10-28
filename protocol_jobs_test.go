package main

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProtocolCancellationOwnsExactRun(t *testing.T) {
	a := testApp(t)
	n, _, _ := fixture(t, a)
	dir, err := os.MkdirTemp("", "subhub-probe-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	a.probeSocket = filepath.Join(dir, "p.sock")
	listener, err := net.Listen("unix", a.probeSocket)
	if err != nil {
		t.Fatal(err)
	}
	seen := make(chan struct{}, 1)
	stopped := make(chan struct{}, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in protocolRequest
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			t.Error("invalid worker request")
			return
		}
		seen <- struct{}{}
		<-r.Context().Done()
		stopped <- struct{}{}
	})}
	defer srv.Close()
	go srv.Serve(listener)
	path := "/api/admin/nodes/" + n.ID + "/test"
	start := request(a, "POST", path, map[string]string{"mode": "latency"}, true)
	if start.Code != 202 {
		t.Fatal(start.Code)
	}
	var running ProtocolResult
	if json.Unmarshal(start.Body.Bytes(), &running) != nil || running.RunID == "" {
		t.Fatal("missing run identity")
	}
	select {
	case <-seen:
	case <-time.After(3 * time.Second):
		t.Fatal("worker was not started")
	}
	if request(a, "DELETE", path, map[string]string{"runId": running.RunID}, false).Code != 401 {
		t.Fatal("unauthenticated cancellation")
	}
	if request(a, "DELETE", path, map[string]string{"runId": "other-run"}, true).Code != 409 {
		t.Fatal("unrelated run could cancel the worker")
	}
	if request(a, "POST", path, map[string]string{"mode": "latency"}, true).Code != 409 {
		t.Fatal("parallel test admitted")
	}
	if request(a, "DELETE", path, map[string]string{"runId": running.RunID}, true).Code != 202 {
		t.Fatal("cancellation rejected")
	}
	deadline := time.Now().Add(3 * time.Second)
	for len(a.protocolWork) > 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(a.protocolWork) != 0 {
		t.Fatal("worker slot not released after cancellation")
	}
	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("cancellation did not reach the worker")
	}
	if v := a.protocolResults()[n.ID]; v.State != "cancelled" || v.RunID != running.RunID {
		t.Fatal("cancelled result not recorded")
	}
	if request(a, "DELETE", path, map[string]string{"runId": running.RunID}, true).Code != 409 {
		t.Fatal("finished run could be cancelled again")
	}
	response := request(a, "GET", "/api/admin/node-test-history", nil, true)
	var rows []ProtocolResult
	if json.Unmarshal(response.Body.Bytes(), &rows) != nil || len(rows) != 1 || rows[0].State != "cancelled" {
		t.Fatal("cancellation missing from history")
	}
}

func TestProtocolHistoryPrivacyRetentionAndIsolation(t *testing.T) {
	a := testApp(t)
	n, _, _ := fixture(t, a)
	v := ProtocolResult{NodeID: n.ID, NodeName: n.Name, CheckedAt: now(), State: "verified", ConfigHash: "internal-identity-hash", Bytes: 2097152}
	for i := 0; i < 502; i++ {
		if err := a.recordProtocolHistory(v); err != nil {
			t.Fatal(err)
		}
	}
	old := v
	old.CheckedAt = time.Now().AddDate(0, 0, -31).UTC().Format(time.RFC3339)
	if err := a.recordProtocolHistory(old); err != nil {
		t.Fatal(err)
	}
	var count int
	a.db.QueryRow("SELECT count(*) FROM records WHERE kind='node_test_history'").Scan(&count)
	if count > 500 {
		t.Fatal("history retention exceeded")
	}
	path := "/api/admin/node-test-history"
	if request(a, "GET", path, nil, false).Code != 401 {
		t.Fatal("unauthenticated history")
	}
	w := request(a, "GET", path+"?node=missing", nil, true)
	if w.Body.String() != "[]\n" {
		t.Fatal("node history leaked across filters")
	}
	w = request(a, "GET", path+"?node="+n.ID, nil, true)
	var rows []ProtocolResult
	if json.Unmarshal(w.Body.Bytes(), &rows) != nil || len(rows) != 100 {
		t.Fatal("history response not bounded")
	}
	if strings.Contains(w.Body.String(), v.ConfigHash) {
		t.Fatal("internal identity hash in history response")
	}
	var stored string
	a.db.QueryRow("SELECT body FROM records WHERE kind='node_test_history' LIMIT 1").Scan(&stored)
	if strings.Contains(stored, v.ConfigHash) || strings.Contains(stored, "credential") {
		t.Fatal("history stored credential information")
	}
	for _, row := range rows {
		if row.CheckedAt == old.CheckedAt {
			t.Fatal("expired history retained")
		}
	}
}
