package main

import (
	"strings"
	"testing"
)

func TestResolveInstanceName(t *testing.T) {
	if got := resolveInstanceName("俄亥俄测试"); got != "俄亥俄测试" {
		t.Fatalf("explicit name = %q", got)
	}
	if got := resolveInstanceName("  padded  "); got != "padded" {
		t.Fatalf("explicit name not trimmed: %q", got)
	}
	fallback := resolveInstanceName("")
	if fallback == "" || strings.Contains(fallback, "Fremont") || strings.Contains(fallback, "家人云") {
		t.Fatalf("fallback name = %q", fallback)
	}
	app := &App{instanceName: "俄亥俄测试"}
	if got := app.probeSourceLabel(); got != "俄亥俄测试 → 所选节点 → 测试站" {
		t.Fatalf("source label = %q", got)
	}
	bare := &App{}
	if got := bare.probeSourceLabel(); !strings.HasSuffix(got, " → 所选节点 → 测试站") || strings.Contains(got, "Fremont") {
		t.Fatalf("default source label = %q", got)
	}
}
