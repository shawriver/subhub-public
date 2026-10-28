package main

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

const testKomariUUID = "11111111-1111-4111-8111-111111111111"

func TestKomariLatestIdentityFreshnessAndUnits(t *testing.T) {
	at := time.Now()
	n := KomariNode{UUID: testKomariUUID, Name: "Node"}
	old := komariReport{UUID: n.UUID, Updated: at.Add(-2 * time.Minute).Format(time.RFC3339Nano)}
	recent := old
	recent.Updated = at.Add(-3 * time.Second).Format(time.RFC3339Nano)
	recent.Network.TotalUp = 123456789
	recent.Network.TotalDown = 987654321
	recent.Network.Up = 321
	cpu := 42.5
	recent.CPU.Usage = &cpu
	recent.RAM.Total = 1000
	recent.RAM.Used = 250
	recent.Disk.Total = 2000
	recent.Disk.Used = 1000
	wrong := recent
	wrong.UUID = "other"
	wrong.Updated = at.Format(time.RFC3339Nano)
	v := latestKomari(n, []komariReport{recent, wrong, old}, at)
	if v.Status != "online" || v.TotalUp != 123456789 || v.Up != 321 {
		t.Fatal("wrong sample or units")
	}
	if v.CPU == nil || *v.CPU != 42.5 || v.Memory == nil || *v.Memory != 25 || v.Disk == nil || *v.Disk != 50 {
		t.Fatal("resource measurements incorrect")
	}
	v = latestKomari(n, []komariReport{old}, at)
	if v.Status != "stale" || v.Up != 0 {
		t.Fatal("stale sample shown live")
	}
	future := recent
	future.Updated = at.Add(time.Hour).Format(time.RFC3339Nano)
	if latestKomari(n, []komariReport{future, wrong}, at).Status != "unknown" {
		t.Fatal("invalid identity/time accepted")
	}
}
func TestKomariFailureCannotChangeSubscriptionUsage(t *testing.T) {
	a, _, _, m := setupManaged(t)
	s := Server{ID: "srv", Name: "Node", Address: "node.example.test", KomariUUID: testKomariUUID}
	a.put("server", s.ID, s)
	fetch := func(ctx context.Context, path string, out any) error {
		var b []byte
		if path == "/api/nodes" {
			b, _ = json.Marshal([]KomariNode{{UUID: testKomariUUID, Name: "Node"}})
		} else {
			r := komariReport{UUID: testKomariUUID, Updated: now()}
			r.Network.TotalUp = 9000000000
			b, _ = json.Marshal([]komariReport{r})
		}
		return json.Unmarshal(b, out)
	}
	a.refreshKomari(context.Background(), fetch)
	if a.komariOverview().Metrics[testKomariUUID].TotalUp != 9000000000 {
		t.Fatal("missing host traffic")
	}
	var after Member
	a.get("member", m.ID, &after)
	if after.Used != m.Used {
		t.Fatal("host bytes counted against member")
	}
	a.refreshKomari(context.Background(), func(context.Context, string, any) error { return errors.New("offline") })
	if a.komariOverview().Metrics[testKomariUUID].Status != "unknown" {
		t.Fatal("failed fetch remains online")
	}
	if err := a.syncAll(context.Background()); err != nil {
		t.Fatal("monitor failure broke subscription sync", err)
	}
	a.get("member", m.ID, &after)
	if after.Provision != "ready" {
		t.Fatal("independent grant not provisioned")
	}
	a.komari.fetched = time.Now().Add(-2 * time.Minute)
	a.komari.metrics[testKomariUUID] = KomariMetric{Status: "online", Updated: now(), Up: 123}
	if a.komariOverview().Metrics[testKomariUUID].Status != "stale" {
		t.Fatal("stalled collector remains online")
	}
}
func TestKomariBindingValidationAndBackup(t *testing.T) {
	a := testApp(t)
	s := Server{ID: "one", Name: "One", Address: "192.0.2.1"}
	a.put("server", s.ID, s)
	a.put("server", "two", Server{ID: "two", Name: "Two", Address: "192.0.2.2"})
	a.komari.nodes = []KomariNode{{UUID: testKomariUUID, Name: "One"}}
	a.komari.fetched = time.Now()
	payload := map[string]string{"serverId": s.ID, "uuid": testKomariUUID}
	if request(a, "POST", "/api/admin/komari/bind", payload, false).Code != 401 {
		t.Fatal("unprotected mapping")
	}
	if request(a, "POST", "/api/admin/komari/bind", payload, true).Code != 200 {
		t.Fatal("bind failed")
	}
	payload["serverId"] = "two"
	if request(a, "POST", "/api/admin/komari/bind", payload, true).Code != 409 {
		t.Fatal("duplicate mapping accepted")
	}
	if request(a, "PUT", "/api/admin/server/one", s, true).Code != 200 {
		t.Fatal("record edit failed")
	}
	a.get("server", s.ID, &s)
	if s.KomariUUID != testKomariUUID {
		t.Fatal("stale form removed binding")
	}
	snap, err := a.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	b := testApp(t)
	if b.restoreSnapshot(snap) != nil {
		t.Fatal("restore failed")
	}
	var restored Server
	b.get("server", s.ID, &restored)
	if restored.KomariUUID != testKomariUUID {
		t.Fatal("backup lost mapping")
	}
	payload["serverId"] = "one"
	payload["uuid"] = ""
	if request(a, "POST", "/api/admin/komari/bind", payload, true).Code != 200 {
		t.Fatal("unbind failed")
	}
}
