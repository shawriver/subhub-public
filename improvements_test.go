package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestKomariAssetSourceAndEditIsolation(t *testing.T) {
	a := testApp(t)
	s := Server{ID: "s", Name: "S", Address: "192.0.2.1", KomariUUID: testKomariUUID, Specs: "old local", Expires: "2030-01-01", Price: "old price", Limit: 22}
	a.put("server", s.ID, s)
	a.komari.nodes = []KomariNode{{UUID: testKomariUUID, CPUCores: 2, MemoryTotal: 1 << 30, DiskTotal: 20 << 30, CPUName: "CPU", OS: "Linux", Price: 4.5, Currency: "C$", BillingCycle: 30, Expires: "2026-10-23T00:00:00Z", TrafficLimit: 100 << 30}}
	a.komari.fetched = time.Now()
	w := request(a, "GET", "/api/admin/overview", nil, true)
	var v struct{ Servers []Server }
	json.Unmarshal(w.Body.Bytes(), &v)
	got := v.Servers[0]
	if got.Price != "C$ 4.5 / 月" || got.Expires != "2026-10-23" || !strings.Contains(got.Specs, "2 vCPU") || got.Limit != float64(100<<30)/1e9 {
		t.Fatal("Komari asset view incorrect")
	}
	got.Name = "Updated"
	if request(a, "PUT", "/api/admin/server/s", got, true).Code != 200 {
		t.Fatal("edit failed")
	}
	a.get("server", s.ID, &got)
	if got.Specs != s.Specs || got.Price != s.Price || got.Expires != s.Expires || got.Limit != s.Limit {
		t.Fatal("derived asset snapshot persisted")
	}
	a.komari.nodes[0].Price = 0
	if komariAssets(s, a.komari.nodes).Price != "" {
		t.Fatal("zero price incorrectly presented as free")
	}
	a.komari.nodes[0].Price = -1
	if komariAssets(s, a.komari.nodes).Price != "免费" {
		t.Fatal("explicit free price lost")
	}
	if got = komariAssets(s, nil); got.Price != "" || got.Specs != "" || got.Expires != "" {
		t.Fatal("unavailable Komari falls back to stale manual facts")
	}
}

func TestKomariConcurrentCollectionAndTrafficModes(t *testing.T) {
	a := testApp(t)
	nodes := []KomariNode{}
	for i := 0; i < 7; i++ {
		n := KomariNode{UUID: fmt.Sprintf("%08d-1111-4111-8111-111111111111", i), Name: "N"}
		nodes = append(nodes, n)
		a.put("server", fmt.Sprint(i), Server{ID: fmt.Sprint(i), KomariUUID: n.UUID})
	}
	var current, peak atomic.Int32
	fetch := func(ctx context.Context, path string, out any) error {
		if path == "/api/nodes" {
			b, _ := json.Marshal(nodes)
			return json.Unmarshal(b, out)
		}
		value := current.Add(1)
		defer current.Add(-1)
		for {
			old := peak.Load()
			if value <= old || peak.CompareAndSwap(old, value) {
				break
			}
		}
		time.Sleep(15 * time.Millisecond)
		r := komariReport{UUID: strings.TrimPrefix(path, "/api/recent/"), Updated: now()}
		b, _ := json.Marshal([]komariReport{r})
		return json.Unmarshal(b, out)
	}
	a.refreshKomari(context.Background(), fetch)
	if peak.Load() < 2 || peak.Load() > 4 || len(a.komariOverview().Metrics) != 7 {
		t.Fatal("collector is sequential, unbounded, or incomplete")
	}
	r := komariReport{UUID: testKomariUUID, Updated: now()}
	r.Network.TotalUp = 300
	r.Network.TotalDown = 500
	for mode, want := range map[string]int64{"sum": 800, "up": 300, "down": 500, "max": 500, "min": 300} {
		v := latestKomari(KomariNode{UUID: testKomariUUID, TrafficMode: mode, TrafficLimit: 1000}, []komariReport{r}, time.Now())
		if v.TrafficUsed == nil || *v.TrafficUsed != want || v.TrafficLimit != 1000 {
			t.Fatal("incorrect traffic accounting direction")
		}
	}
	if latestKomari(KomariNode{UUID: testKomariUUID, TrafficMode: "unknown"}, []komariReport{r}, time.Now()).TrafficUsed != nil {
		t.Fatal("unknown direction guessed")
	}
}

func TestExplicitPanelAdoptionPreservesOwnerAndPreventsDuplicates(t *testing.T) {
	a := testApp(t)
	f := newFakePanel(t)
	ctx := context.Background()
	a.put("server", "s", Server{ID: "s", Name: "S", Address: "node.example.test"})
	p := PanelInput{Panel: Panel{ID: "p", ServerID: "s", Name: "P", URL: f.server.URL}, Token: f.token}
	if err := a.savePanel(ctx, p); err != nil {
		t.Fatal(err)
	}
	list, err := a.discover(ctx, p.Panel)
	if err != nil {
		t.Fatal(err)
	}
	n := *list[0].Node
	n.ID = "existing-import"
	n.Name = "Owner import"
	n.PanelID = ""
	n.InboundID = 0
	n.Managed = false
	n.Host = "retained-endpoint.example"
	a.put("node", n.ID, n)
	owner := f.clients["existing-owner"]
	a.secret("node_secret", n.ID, token())
	if a.attachInbound(ctx, p.Panel, 7, n.ID) == nil {
		t.Fatal("wrong credential adopted")
	}
	a.secret("node_secret", n.ID, owner.UUID)
	changed := n
	changed.PublicKey = "mismatch"
	a.put("node", n.ID, changed)
	if a.attachInbound(ctx, p.Panel, 7, n.ID) == nil {
		t.Fatal("mismatched transport identity adopted")
	}
	a.put("node", n.ID, n)
	a.put("member", "assigned", Member{ID: "assigned", NodeIDs: []string{n.ID}})
	if a.attachInbound(ctx, p.Panel, 7, n.ID) == nil {
		t.Fatal("assigned shared identity switched")
	}
	a.db.Exec("DELETE FROM records WHERE kind='member'")
	if err = a.attachInbound(ctx, p.Panel, 7, n.ID); err != nil {
		t.Fatal(err)
	}
	if err = a.attachInbound(ctx, p.Panel, 7, n.ID); err != nil {
		t.Fatal("adoption not idempotent")
	}
	if err = a.attachInbound(ctx, p.Panel, 7); err != nil {
		t.Fatal(err)
	}
	if len(loadNodes(a)) != 1 {
		t.Fatal("duplicate record created")
	}
	var got Node
	a.get("node", n.ID, &got)
	if !got.Managed || got.PanelID != p.ID || got.Host != n.Host || got.Name != n.Name {
		t.Fatal("identity lost")
	}
	secret, _ := a.readSecret("node_secret", n.ID)
	if secret != owner.UUID || f.clients["existing-owner"].UUID != owner.UUID || len(f.clients) != 1 {
		t.Fatal("owner credential or remote client changed")
	}
}

func TestDemoRemovedAndNoPrivateSeedInBundle(t *testing.T) {
	a := testApp(t)
	for _, p := range []string{"/demo", "/demo/servers", "/demo/nodes"} {
		if request(a, "GET", p, nil, false).Code != 404 {
			t.Fatal("demo route still served")
		}
	}
	for _, p := range []string{"/", "/login", "/app.js"} {
		w := request(a, "GET", p, nil, false)
		for _, bad := range []string{"demo-user-credential", "demo-password", "demoData", "/demo", "VMISS · Los Angeles"} {
			if strings.Contains(w.Body.String(), bad) {
				t.Fatal("demo seed/route in anonymous response")
			}
		}
	}
}
