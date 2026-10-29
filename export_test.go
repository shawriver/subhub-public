package main

import (
	"strings"
	"testing"
)

func TestRenderClashIncludesAutomaticAndFallbackGroups(t *testing.T) {
	config := string(renderClash([]Node{
		{Name: "Tokyo", Protocol: "VLESS", Host: "192.0.2.1", Port: 443, Credential: "secret", Transport: "tcp", Security: "none"},
		{Name: "Singapore", Protocol: "Trojan", Host: "192.0.2.2", Port: 443, Credential: "secret", Transport: "tcp", Security: "tls"},
	}, nil))
	for _, expected := range []string{`"name":"节点选择"`, `"type":"select"`, `"proxies":["Tokyo","Singapore","自动选择","故障转移"]`, `"name":"自动选择"`, `"type":"url-test"`, `"name":"故障转移"`, `"type":"fallback"`, `"MATCH,节点选择"`} {
		if !strings.Contains(config, expected) {
			t.Fatalf("generated config missing %s", expected)
		}
	}
	manual := strings.Index(config, `"name":"节点选择"`)
	automatic := strings.Index(config, `"name":"自动选择"`)
	if manual < 0 || automatic < 0 || manual > automatic {
		t.Fatal("manual selection group must be listed before automatic groups")
	}
	if strings.Count(config, "\nproxies:") != 1 {
		t.Fatal("group generation introduced invalid YAML")
	}
}

func TestRenderClashIncludesDefaultDNS(t *testing.T) {
	config := string(renderClash([]Node{
		{Name: "Tokyo", Protocol: "VLESS", Host: "192.0.2.1", Port: 443, Credential: "secret", Transport: "tcp", Security: "none"},
	}, nil))
	for _, expected := range []string{
		"\ndns:\n", "enhanced-mode: fake-ip", "fake-ip-range: 198.18.0.1/16",
		"default-nameserver:", "- 223.5.5.5", "- 119.29.29.29",
		"https://dns.alidns.com/dns-query", "https://doh.pub/dns-query",
		"proxy-server-nameserver:", "nameserver-policy:", "'geosite:cn,private':",
		"https://dns.google/dns-query", "https://cloudflare-dns.com/dns-query",
		"geoip-code: CN", "respect-rules: true",
	} {
		if !strings.Contains(config, expected) {
			t.Fatalf("generated config missing DNS fragment %q", expected)
		}
	}
	if strings.Count(config, "\ndns:") != 1 {
		t.Fatal("generated config must contain exactly one dns section")
	}
	// Rules and groups are unaffected by the DNS section.
	if !strings.Contains(config, `"MATCH,节点选择"`) || !strings.Contains(config, `"name":"自动选择"`) {
		t.Fatal("DNS injection disturbed rules or proxy groups")
	}
}

func TestRenderClashSmartTemplateKeepsOwnDNS(t *testing.T) {
	config := string(renderClashTemplate([]Node{
		{Name: "Tokyo", Protocol: "VLESS", Host: "192.0.2.1", Port: 443, Credential: "secret", Transport: "tcp", Security: "none"},
	}, []string{"MATCH,节点选择"}, true))
	if !strings.Contains(config, "redir-host") {
		t.Fatal("smart template lost its own DNS section")
	}
	if strings.Contains(config, "fake-ip") {
		t.Fatal("smart template must not receive the default fake-ip DNS block")
	}
	if strings.Count(config, "\ndns:") != 1 {
		t.Fatal("smart config must contain exactly one dns section")
	}
}

func TestV2RayOutputHasNoDNS(t *testing.T) {
	out := strings.Join(v2rayLines([]Node{
		{Name: "Tokyo", Protocol: "VLESS", Host: "192.0.2.1", Port: 443, Credential: "secret", Transport: "tcp", Security: "none"},
	}), "\n")
	if strings.Contains(out, "dns") {
		t.Fatalf("v2ray output must stay bare links, got %q", out)
	}
}
