package main

import (
	"encoding/json"
	"net"
	"net/http"
	"testing"
)

func TestNodeLatencyBatchRequiresAdmin(t *testing.T) {
	a := testApp(t)
	w := request(a, "POST", "/api/admin/nodes/latency", map[string]any{"nodeIds": []string{"node-a"}}, false)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated latency test status=%d", w.Code)
	}
}

func TestNodeLatencyBatchMeasuresEnabledNodes(t *testing.T) {
	a := testApp(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			conn.Close()
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	for _, node := range []Node{
		{ID: "node-a", Name: "Node A", Protocol: "VLESS", Host: "127.0.0.1", Port: port, Enabled: true},
		{ID: "node-b", Name: "Node B", Protocol: "Trojan", Host: "127.0.0.1", Port: port, Enabled: true},
		{ID: "node-c", Name: "Disabled", Protocol: "VLESS", Host: "127.0.0.1", Port: port, Enabled: false},
	} {
		a.put("node", node.ID, node)
	}
	w := request(a, "POST", "/api/admin/nodes/latency", map[string]any{"nodeIds": []string{}}, true)
	if w.Code != http.StatusOK {
		t.Fatalf("latency batch status=%d body=%s", w.Code, w.Body.String())
	}
	var response struct {
		Results   []NodeHealth `json:"results"`
		Total     int          `json:"total"`
		Reachable int          `json:"reachable"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Total != 2 || response.Reachable != 2 || len(response.Results) != 2 {
		t.Fatalf("unexpected latency response: %+v", response)
	}
	for _, result := range response.Results {
		if result.State != "reachable" || result.Method != "tcp" || result.Samples != nodeLatencySamples || result.LatencyMS < 1 {
			t.Fatalf("invalid latency result: %+v", result)
		}
	}
	if health := a.nodeHealth(); health["node-a"].LatencyMS < 1 || health["node-c"].State != "" {
		t.Fatalf("latency results were not persisted correctly: %+v", health)
	}
}

func TestNodeLatencyBatchRejectsDisabledExplicitNode(t *testing.T) {
	a := testApp(t)
	a.put("node", "node-a", Node{ID: "node-a", Name: "Disabled", Protocol: "VLESS", Host: "127.0.0.1", Port: 1, Enabled: false})
	w := request(a, "POST", "/api/admin/nodes/latency", map[string]any{"nodeIds": []string{"node-a"}}, true)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("disabled latency test status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestMedianLatencyUsesMiddleSample(t *testing.T) {
	if got := medianLatency([]int64{31, 9, 15}); got != 15 {
		t.Fatalf("median=%d", got)
	}
}

func TestParsePingAverage(t *testing.T) {
	output := []byte("3 packets transmitted, 3 received, 0% packet loss, time 401ms\nrtt min/avg/max/mdev = 108.1/109.8/111.2/1.1 ms\n")
	if got, ok := parsePingAverage(output); !ok || got != 110 {
		t.Fatalf("average=%d ok=%v", got, ok)
	}
}
