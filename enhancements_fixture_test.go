package main

import (
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Disposable VPS-only browser fixture. No production records or credentials.
func TestEnhancementUIFixture(t *testing.T) {
	dir := os.Getenv("SUBHUB_UI_FIXTURE")
	if dir == "" {
		t.Skip("browser fixture only")
	}
	a, err := newApp(dir, "http://127.0.0.1:18441")
	if err != nil {
		t.Fatal(err)
	}
	defer a.db.Close()
	n, m, p := fixture(t, a)
	n.Name = "测试节点"
	a.put("node", n.ID, n)
	a.secret("node_secret", n.ID, uuid())
	a.db.Exec("INSERT INTO admin VALUES('fixture',?)", []byte("disabled-fixture-password"))
	s := Subscription{ID: "fixture-sub", Name: "测试订阅", NodeIDs: []string{n.ID}}
	a.put("subscription", s.ID, s)
	m.SubscriptionIDs = []string{s.ID}
	a.put("member", m.ID, m)
	p.FollowMemberNodes = true
	a.put("profile", p.ID, p)
	a.probeSocket = filepath.Join(dir, "probe.sock")
	listener, err := net.Listen("unix", a.probeSocket)
	if err != nil {
		t.Fatal(err)
	}
	worker := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		writeJSON(w, 200, ProtocolResult{State: "verified", LatencyMS: 37, Bytes: 2097152, DownMbps: 8.2, Detail: "隔离测试结果"})
	})}
	defer worker.Close()
	go worker.Serve(listener)
	server := &http.Server{Addr: "127.0.0.1:18441", Handler: a.routes(), ReadHeaderTimeout: 5 * time.Second}
	defer server.Close()
	time.AfterFunc(8*time.Minute, func() { server.Close() })
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		t.Fatal(err)
	}
}
