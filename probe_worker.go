package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"time"
)

func runProtocolSample(parent context.Context, core, root string, in protocolRequest) ProtocolResult {
	result := ProtocolResult{State: "error", Detail: "代理协议请求失败；请检查节点、身份与测试站连通性"}
	if in.Mode != "latency" {
		result.Detail = "仅支持延迟测试"
		return result
	}
	ctx, cancel := context.WithTimeout(parent, 35*time.Second)
	defer cancel()
	dir, err := os.MkdirTemp(root, "sample-")
	if err != nil {
		result.Detail = "无法建立受保护的测试目录"
		return result
	}
	defer os.RemoveAll(dir)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return result
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	proxy := clashProxy(in.Node)
	if proxy == nil {
		return result
	}
	proxy["name"] = "probe-node"
	config := map[string]any{"socks-port": port, "bind-address": "127.0.0.1", "allow-lan": false, "mode": "rule", "log-level": "silent", "ipv6": true, "proxies": []any{proxy}, "rules": []string{"MATCH,probe-node"}, "profile": map[string]bool{"store-selected": false, "store-fake-ip": false}}
	raw, _ := json.Marshal(config)
	file := filepath.Join(dir, "probe.json")
	if os.WriteFile(file, raw, 0600) != nil {
		return result
	}
	cmd := exec.CommandContext(ctx, core, "-d", dir, "-f", file)
	// Core diagnostics can contain credentials. Do not persist or return them.
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	if cmd.Start() != nil {
		result.Detail = "测试引擎无法启动"
		return result
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	defer func() {
		_ = cmd.Process.Kill()
		select {
		case <-done:
		case <-time.After(time.Second):
		}
	}()
	ready := false
	for i := 0; i < 50; i++ {
		select {
		case <-done:
			result.Detail = "测试引擎拒绝节点配置"
			return result
		default:
		}
		c, e := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 100*time.Millisecond)
		if e == nil {
			c.Close()
			ready = true
			break
		}
		select {
		case <-ctx.Done():
			return result
		case <-time.After(100 * time.Millisecond):
		}
	}
	if !ready {
		result.Detail = "测试引擎启动超时"
		return result
	}
	proxyURL, _ := url.Parse(fmt.Sprintf("socks5://127.0.0.1:%d", port))
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL), DisableKeepAlives: true, TLSHandshakeTimeout: 8 * time.Second, ResponseHeaderTimeout: 10 * time.Second, DisableCompression: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	get := func(target string) (*http.Response, error) {
		req, e := http.NewRequestWithContext(ctx, "GET", target, nil)
		if e != nil {
			return nil, e
		}
		req.Header.Set("User-Agent", "SubHub-Protocol-Check/1")
		return client.Do(req)
	}
	samples := make([]int64, 0, 3)
	for attempt := 0; attempt < 3; attempt++ {
		started := time.Now()
		res, err := get("https://cp.cloudflare.com/generate_204")
		if err != nil {
			return result
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != 204 {
			result.Detail = "测试站未返回预期响应，未认定协议可用"
			return result
		}
		elapsed := time.Since(started).Milliseconds()
		if elapsed < 1 {
			elapsed = 1
		}
		samples = append(samples, elapsed)
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	result.State, result.LatencyMS = "verified", samples[len(samples)/2]
	result.Detail = "经实际代理访问 Cloudflare，三次请求取中位数（测试身份有效）"
	if result.LatencyMS < 1 {
		result.LatencyMS = 1
	}
	return result
}

func serveProbeWorker(socket, core string) error {
	if err := os.MkdirAll(filepath.Dir(socket), 0700); err != nil {
		return err
	}
	if info, err := os.Lstat(socket); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return fmt.Errorf("probe socket path is not a socket")
		}
		if err = os.Remove(socket); err != nil {
			return err
		}
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return err
	}
	defer listener.Close()
	defer os.Remove(socket)
	if err = os.Chmod(socket, 0600); err != nil {
		return err
	}
	sem := make(chan struct{}, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			apiError(w, 405, "method not allowed")
			return
		}
		var in protocolRequest
		if decodeBody(r, &in) != nil || in.Mode != "latency" || in.Node.Credential == "" {
			apiError(w, 400, "invalid probe request")
			return
		}
		select {
		case sem <- struct{}{}:
		default:
			apiError(w, 409, "busy")
			return
		}
		defer func() { <-sem }()
		writeJSON(w, 200, runProtocolSample(r.Context(), core, filepath.Dir(socket), in))
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 40 * time.Second, IdleTimeout: 5 * time.Second}
	return server.Serve(listener)
}
