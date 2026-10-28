package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

func alpnList(s string) []string {
	values := []string{}
	for _, part := range strings.Split(s, ",") {
		if v := strings.TrimSpace(part); v != "" {
			values = append(values, v)
		}
	}
	return values
}

func v2rayLines(nodes []Node) []string {
	lines := []string{}
	for _, n := range nodes {
		if n.Protocol == "VMess" {
			lines = append(lines, vmessURI(n))
			continue
		}
		q := url.Values{}
		scheme := ""
		switch n.Protocol {
		case "VLESS":
			scheme = "vless"
			q.Set("encryption", "none")
			q.Set("security", defaultString(n.Security, "none"))
			if n.Security == "reality" {
				q.Set("pbk", n.PublicKey)
				q.Set("sid", n.ShortID)
				q.Set("fp", defaultString(n.Fingerprint, "chrome"))
			}
			if n.Flow != "" {
				q.Set("flow", n.Flow)
			}
		case "Trojan":
			scheme = "trojan"
			q.Set("security", "tls")
		case "AnyTLS":
			scheme = "anytls"
			q.Set("security", "tls")
		case "Hysteria2":
			scheme = "hysteria2"
		default:
			continue
		}
		if n.Protocol != "Hysteria2" {
			q.Set("type", defaultString(n.Transport, "tcp"))
			if n.Transport == "ws" {
				q.Set("path", defaultString(n.Path, "/"))
				q.Set("host", defaultString(n.WSHost, defaultString(n.ExternalSNI, n.SNI)))
			}
		}
		if sni := defaultString(n.ExternalSNI, n.SNIText()); sni != "" {
			q.Set("sni", sni)
		}
		if alpn := alpnList(n.ALPN); len(alpn) > 0 {
			q.Set("alpn", strings.Join(alpn, ","))
		}
		if n.Fingerprint != "" && n.Security == "tls" && n.Protocol != "Hysteria2" {
			q.Set("fp", n.Fingerprint)
		}
		port := n.Port
		if n.ExternalPort > 0 {
			port = n.ExternalPort
		}
		u := url.URL{Scheme: scheme, User: url.User(n.Credential), Host: net.JoinHostPort(n.Host, strconv.Itoa(port)), RawQuery: q.Encode(), Fragment: n.Name}
		lines = append(lines, u.String())
	}
	return lines
}

// JSON strings/maps are valid YAML flow values and escape every user-controlled
// scalar consistently, including quotes, line breaks and embedded rules.
func yamlValue(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func renderClash(nodes []Node, rules []string) []byte {
	return renderClashTemplate(nodes, rules, false)
}

func clashProxy(n Node) map[string]any {
	port := n.Port
	if n.ExternalPort > 0 {
		port = n.ExternalPort
	}
	p := map[string]any{"name": n.Name, "server": n.Host, "port": port}
	switch n.Protocol {
	case "VMess":
		p["type"], p["uuid"], p["alterId"], p["cipher"] = "vmess", n.Credential, 0, "auto"
		p["tls"], p["udp"] = n.Security == "tls", true
		if s := defaultString(n.ExternalSNI, n.SNIText()); s != "" {
			p["servername"] = s
		}
	case "VLESS":
		p["type"], p["uuid"], p["tls"], p["udp"] = "vless", n.Credential, n.Security == "tls" || n.Security == "reality", true
		if s := defaultString(n.ExternalSNI, n.SNIText()); s != "" {
			p["servername"] = s
		}
		if n.Security == "reality" {
			p["reality-opts"] = map[string]string{"public-key": n.PublicKey, "short-id": n.ShortID}
			p["client-fingerprint"] = defaultString(n.Fingerprint, "chrome")
		}
		if n.Flow != "" {
			p["flow"] = n.Flow
		}
	case "Trojan":
		p["type"], p["password"], p["sni"], p["udp"] = "trojan", n.Credential, n.SNIText(), true
	case "Hysteria2":
		p["type"], p["password"], p["sni"], p["skip-cert-verify"] = "hysteria2", n.Credential, n.SNIText(), false
	case "AnyTLS":
		p["type"], p["password"], p["sni"] = "anytls", n.Credential, n.SNIText()
		p["udp"], p["skip-cert-verify"] = true, false
	default:
		return nil
	}
	if n.Transport == "ws" {
		p["network"] = "ws"
		p["ws-opts"] = map[string]any{"path": defaultString(n.Path, "/"), "headers": map[string]string{"Host": defaultString(n.WSHost, defaultString(n.ExternalSNI, n.SNI))}}
	}
	if alpn := alpnList(n.ALPN); len(alpn) > 0 {
		p["alpn"] = alpn
	}
	if n.Security == "tls" && n.Fingerprint != "" && n.Protocol != "Hysteria2" {
		p["client-fingerprint"] = n.Fingerprint
	}
	return p
}

// defaultClashDNS is the single definition of the DNS section shipped with
// every non-smart Clash config (spec: subhub-Pro 功能开发规格 条目 2). Validated
// verbatim with `mihomo -t` on the Ohio test instance. Smart templates carry
// their own DNS via writeSmartNetwork and do not use this block.
const defaultClashDNS = `dns:
  enable: true
  ipv6: false
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter:
    - '*.lan'
    - '*.local'
    - '+.home.arpa'
    - 'localhost'
    - 'time.*.com'
    - 'time.*.gov'
    - 'pool.ntp.org'
    - 'ntp.*.com'
    - 'stun.*.*'
    - 'stun.*.*.*'
    - '*.srv.nintendo.net'
    - '*.stun.playstation.net'
    - 'xbox.*.microsoft.com'
    - '*.xboxlive.com'
    - 'msftconnecttest.com'
    - '*.msftconnecttest.com'
    - 'msftncsi.com'
    - '*.music.163.com'
    - 'music.163.com'
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29
  nameserver:
    - https://dns.alidns.com/dns-query
    - https://doh.pub/dns-query
  proxy-server-nameserver:
    - https://dns.alidns.com/dns-query
    - https://doh.pub/dns-query
  nameserver-policy:
    'geosite:cn,private':
      - https://dns.alidns.com/dns-query
      - https://doh.pub/dns-query
  fallback:
    - https://dns.google/dns-query
    - https://cloudflare-dns.com/dns-query
  fallback-filter:
    geoip: true
    geoip-code: CN
    ipcidr:
      - 240.0.0.0/4
  respect-rules: true
`

func renderClashTemplate(nodes []Node, rules []string, smart bool) []byte {
	var b bytes.Buffer
	b.WriteString("# Generated by SubHub. Contains private node credentials.\nmixed-port: 7890\nallow-lan: false\nmode: rule\nlog-level: info\nipv6: true\n")
	if smart {
		writeSmartNetwork(&b)
	}
	b.WriteString("proxies:\n")
	names := []string{}
	for _, n := range nodes {
		p := clashProxy(n)
		if p == nil {
			continue
		}
		fmt.Fprintf(&b, "  - %s\n", yamlValue(p))
		names = append(names, n.Name)
	}
	automatic := []string{"自动选择", "故障转移"}
	selectNames := append(append([]string{}, automatic...), names...)
	b.WriteString("proxy-groups:\n")
	for _, group := range []map[string]any{
		{"name": "自动选择", "type": "url-test", "proxies": names, "url": "https://www.gstatic.com/generate_204", "interval": 300, "tolerance": 50, "lazy": true},
		{"name": "故障转移", "type": "fallback", "proxies": names, "url": "https://www.gstatic.com/generate_204", "interval": 300, "lazy": true},
		{"name": "节点选择", "type": "select", "proxies": selectNames},
	} {
		fmt.Fprintf(&b, "  - %s\n", yamlValue(group))
	}
	if smart {
		for _, name := range []string{"AI", "Telegram", "流媒体"} {
			fmt.Fprintf(&b, "  - %s\n", yamlValue(map[string]any{"name": name, "type": "select", "proxies": append([]string{"节点选择"}, names...)}))
		}
	}
	b.WriteString("rules:\n")
	if len(rules) == 0 {
		rules = []string{"GEOIP,LAN,DIRECT", "GEOIP,CN,DIRECT", "MATCH,节点选择"}
	}
	for _, rule := range rules {
		fmt.Fprintf(&b, "  - %s\n", yamlValue(rule))
	}
	if !smart {
		// Top-level key order is irrelevant to YAML parsers; appending the
		// DNS section last keeps it a pure addition at the final assembly
		// layer and leaves the proxies/groups/rules layout byte-stable.
		b.WriteString(defaultClashDNS)
	}
	return b.Bytes()
}
