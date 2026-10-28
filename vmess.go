package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// The legacy VMess share format is Base64 JSON. Only AEAD (alterId=0),
// auto cipher and plain TCP/WebSocket are supported; never silently drop
// settings that would change the connection or disable TLS verification.
func parseVMessURI(line string) (Node, error) {
	n := Node{Protocol: "VMess", Enabled: true, Tags: []string{"导入"}, Transport: "tcp", Security: "none"}
	invalid := errors.New("VMess 链接无效；支持 AEAD（aid=0）、auto 加密及 TCP/WebSocket")
	var raw []byte
	var err error
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		raw, err = enc.DecodeString(line[len("vmess://"):])
		if err == nil {
			break
		}
	}
	if err != nil {
		return n, invalid
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return n, invalid
	}
	allowed := map[string]bool{"v": true, "ps": true, "add": true, "port": true, "id": true, "aid": true, "scy": true, "net": true, "type": true, "host": true, "path": true, "tls": true, "sni": true, "alpn": true, "fp": true}
	values := map[string]string{}
	for key, value := range fields {
		if !allowed[key] {
			return n, invalid
		}
		var s string
		if json.Unmarshal(value, &s) != nil {
			var number json.Number
			if (key != "port" && key != "aid" && key != "v") || json.Unmarshal(value, &number) != nil {
				return n, invalid
			}
			s = number.String()
		}
		values[key] = s
	}
	if v := values["v"]; v != "" && v != "2" {
		return n, invalid
	}
	if v := values["aid"]; v != "" && v != "0" {
		return n, invalid
	}
	if v := values["scy"]; v != "" && v != "auto" {
		return n, invalid
	}
	if v := values["type"]; v != "" && v != "none" {
		return n, invalid
	}
	n.Port, err = strconv.Atoi(values["port"])
	if err != nil || n.Port < 1 || n.Port > 65535 || values["id"] == "" || values["add"] == "" {
		return n, invalid
	}
	n.Name, n.Host, n.Credential = values["ps"], values["add"], values["id"]
	n.Transport = defaultString(values["net"], "tcp")
	n.Security = defaultString(values["tls"], "none")
	n.SNI, n.WSHost, n.Path, n.ALPN, n.Fingerprint = values["sni"], values["host"], values["path"], values["alpn"], values["fp"]
	if (n.Transport != "tcp" && n.Transport != "ws") || (n.Security != "tls" && n.Security != "none") {
		return n, invalid
	}
	if n.Transport != "ws" && (n.WSHost != "" || n.Path != "") {
		return n, invalid
	}
	if strings.TrimSpace(n.Name) == "" {
		n.Name = fmt.Sprintf("VMess · %s:%d", n.Host, n.Port)
	}
	return n, nil
}

func vmessURI(n Node) string {
	v := map[string]any{"v": "2", "ps": n.Name, "add": n.Host, "port": n.Port, "id": n.Credential, "aid": 0, "scy": "auto", "net": defaultString(n.Transport, "tcp"), "type": "none", "tls": defaultString(n.Security, "none"), "sni": n.SNI, "alpn": n.ALPN, "fp": n.Fingerprint}
	if n.Transport == "ws" {
		v["host"], v["path"] = n.WSHost, n.Path
	}
	b, _ := json.Marshal(v)
	return "vmess://" + base64.StdEncoding.EncodeToString(b)
}
