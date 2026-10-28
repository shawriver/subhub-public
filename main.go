package main

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"time"
)

//go:embed web/dist/*
var assets embed.FS

func main() {
	data := flag.String("data", "/var/lib/subhub", "private runtime data directory")
	addr := flag.String("listen", "127.0.0.1:18440", "listen address")
	origin := flag.String("origin", "http://127.0.0.1:18440", "public origin")
	komariURL := flag.String("komari-url", os.Getenv("SUBHUB_KOMARI_URL"), "public Komari monitoring base URL")
	issueSetup := flag.Bool("issue-setup", false, "issue a one-time administrator setup token")
	connectPanel := flag.Bool("connect-panel", false, "read panel connection JSON from stdin and save encrypted credentials")
	probeWorker := flag.Bool("probe-worker", false, "run the isolated protocol test worker")
	probeSocket := flag.String("probe-socket", "/run/subhub-probe/api.sock", "private protocol worker socket")
	probeCore := flag.String("probe-core", "/opt/subhub-probe/bin/mihomo", "protocol engine path")
	instanceName := flag.String("instance-name", "", "display name of this instance, used as the source label of node test results")
	flag.Parse()
	if *komariURL != "" {
		normalized, problem := normalizeKomariURL(*komariURL)
		if problem != "" {
			log.Fatal(problem)
		}
		komariOrigin = normalized
	}
	if *probeWorker {
		log.Fatal(serveProbeWorker(*probeSocket, *probeCore))
		return
	}
	a, err := newApp(*data, *origin)
	if err != nil {
		log.Fatal(err)
	}
	defer a.db.Close()
	a.probeSocket = *probeSocket
	explicitInstanceName := *instanceName
	if explicitInstanceName == "" {
		explicitInstanceName = os.Getenv("SUBHUB_INSTANCE_NAME")
	}
	a.instanceName = resolveInstanceName(explicitInstanceName)
	if *connectPanel {
		var in struct {
			Server     Server     `json:"server"`
			Panel      PanelInput `json:"panel"`
			InboundIDs []int      `json:"inboundIds"`
		}
		if json.NewDecoder(os.Stdin).Decode(&in) != nil {
			log.Fatal("invalid connection input")
		}
		if in.Server.ID != "" {
			var old Server
			if a.get("server", in.Server.ID, &old) != nil {
				if err = a.put("server", in.Server.ID, in.Server); err != nil {
					log.Fatal("server save failed")
				}
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err = a.savePanel(ctx, in.Panel); err != nil {
			log.Fatal(err)
		}
		for _, iid := range in.InboundIDs {
			if err = a.attachInbound(ctx, in.Panel.Panel, iid); err != nil {
				log.Fatal(err)
			}
		}
		log.Print("panel connected; credentials encrypted")
		return
	}
	if *issueSetup {
		t, err := a.issueSetup()
		if err != nil {
			log.Fatal(err)
		}
		os.Stdout.WriteString(t + "\n")
		return
	}
	server := &http.Server{Addr: *addr, Handler: a.routes(), ReadHeaderTimeout: 8 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16384}
	a.startWorker(context.Background())
	a.startNodeProbes(context.Background())
	a.startKomari(context.Background())
	log.Printf("SubHub %s listening on %s", appVersion, *addr)
	log.Fatal(server.ListenAndServe())
}
