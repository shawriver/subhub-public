package main

import (
	"context"
	"net"
	"strconv"
	"testing"
)

func TestProbeNodeReportsReachabilityWithoutClaimingProtocolHealth(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	_, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(portText)
	health := probeNode(context.Background(), Node{ID: "node", Protocol: "VLESS", Transport: "tcp", Host: "127.0.0.1", Port: port, Enabled: true})
	if health.State != "reachable" || health.LatencyMS < 1 || health.NodeID != "node" {
		t.Fatalf("unexpected TCP probe result: %+v", health)
	}
	if health.Detail == "代理可用" {
		t.Fatal("TCP reachability must not be presented as protocol health")
	}
}

func TestProbeNodeMarksHysteria2ForClientVerification(t *testing.T) {
	health := probeNode(context.Background(), Node{ID: "h2", Protocol: "Hysteria2", Transport: "udp", Host: "192.0.2.1", Port: 443, Enabled: true})
	if health.State != "unverified" {
		t.Fatalf("unexpected Hysteria2 probe result: %+v", health)
	}
}

func TestProbeNodeDoesNotDialDisabledNode(t *testing.T) {
	health := probeNode(context.Background(), Node{ID: "disabled", Host: "invalid", Port: 1, Enabled: false})
	if health.State != "disabled" {
		t.Fatalf("disabled node was probed: %+v", health)
	}
}

func TestNodeAlertRaisesAndClearsOnRecovery(t *testing.T) {
	a := testApp(t)
	node := Node{ID: "alert-node", Name: "Tokyo", Protocol: "VLESS", Host: "192.0.2.1", Port: 443, Enabled: true}
	reachable := NodeHealth{NodeID: node.ID, State: "reachable", CheckedAt: now()}
	unreachable := NodeHealth{NodeID: node.ID, State: "unreachable", CheckedAt: now(), Detail: "TCP 连接失败"}

	reconcileNodeAlert(a, node, reachable, unreachable)
	var alert Task
	if a.get("task", "node-alert-"+node.ID, &alert) != nil || alert.Status != "failed" || alert.Kind != "node-alert" {
		t.Fatalf("unreachable node did not raise an alert: %+v", alert)
	}

	reconcileNodeAlert(a, node, unreachable, reachable)
	if a.get("task", "node-alert-"+node.ID, &alert) != nil || alert.Status != "success" {
		t.Fatalf("recovered node did not clear the alert: %+v", alert)
	}

	// A healthy node must not create an alert record from scratch.
	fresh := testApp(t)
	reconcileNodeAlert(fresh, node, NodeHealth{NodeID: node.ID}, reachable)
	if fresh.get("task", "node-alert-"+node.ID, &alert) == nil {
		t.Fatal("healthy node created a spurious alert")
	}
}

func TestRemovingNodeClearsItsAlert(t *testing.T) {
	a := testApp(t)
	node := Node{ID: "removable-node", Name: "Tokyo", Protocol: "VLESS", Enabled: true}
	if err := a.put("node", node.ID, node); err != nil {
		t.Fatal(err)
	}
	reconcileNodeAlert(a, node, NodeHealth{NodeID: node.ID, State: "reachable"}, NodeHealth{NodeID: node.ID, State: "unreachable", Detail: "TCP 连接失败"})
	if w := request(a, "DELETE", "/api/admin/node/"+node.ID, nil, true); w.Code != 200 {
		t.Fatalf("node delete failed: %d %s", w.Code, w.Body.String())
	}
	var alert Task
	if a.get("task", "node-alert-"+node.ID, &alert) == nil {
		t.Fatal("node alert survived node deletion")
	}
}
