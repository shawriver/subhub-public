package main

import (
	"strings"
	"testing"
)

func validAppearance() map[string]any {
	return map[string]any{
		"appearance":     "dark",
		"accent":         "#76e4c2",
		"background":     "/wallpaper.webp",
		"surfaceOpacity": 55,
		"brandName":      "SubHub Pro",
		"brandSub":       "PRIVATE NETWORK",
		"workspace":      "My Network",
		"logoUrl":        "",
	}
}

func TestAppearanceUnsetIsNullAndStatusCarriesIt(t *testing.T) {
	a := testApp(t)
	w := request(a, "GET", "/api/admin/appearance", nil, true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"appearance":null`) {
		t.Fatalf("fresh appearance GET = %d %s", w.Code, w.Body.String())
	}
	w = request(a, "GET", "/api/status", nil, false)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"appearance":null`) {
		t.Fatalf("status must carry appearance for pre-login branding: %d %s", w.Code, w.Body.String())
	}
}

func TestAppearanceRequiresAdmin(t *testing.T) {
	a := testApp(t)
	if w := request(a, "GET", "/api/admin/appearance", nil, false); w.Code != 401 {
		t.Fatalf("unauthenticated appearance GET = %d, want 401", w.Code)
	}
	if w := request(a, "POST", "/api/admin/appearance", validAppearance(), false); w.Code != 401 {
		t.Fatalf("unauthenticated appearance POST = %d, want 401", w.Code)
	}
	if a.storedAppearance() != nil {
		t.Fatal("unauthenticated write must not be stored")
	}
}

func TestAppearanceRoundTrip(t *testing.T) {
	a := testApp(t)
	in := validAppearance()
	in["brandName"] = "  我的面板  "
	w := request(a, "POST", "/api/admin/appearance", in, true)
	if w.Code != 200 {
		t.Fatalf("valid appearance POST = %d %s", w.Code, w.Body.String())
	}
	got := a.storedAppearance()
	if got == nil {
		t.Fatal("appearance must be stored")
	}
	if got.BrandName != "我的面板" || got.Appearance != "dark" || got.SurfaceOpacity != 55 || got.Accent != "#76e4c2" {
		t.Fatalf("stored appearance mismatch (brand must be trimmed): %+v", got)
	}
	w = request(a, "GET", "/api/admin/appearance", nil, true)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"brandName":"我的面板"`) {
		t.Fatalf("appearance GET round-trip = %d %s", w.Code, w.Body.String())
	}
	w = request(a, "GET", "/api/status", nil, false)
	if !strings.Contains(w.Body.String(), `"brandName":"我的面板"`) {
		t.Fatalf("status must carry the stored branding: %s", w.Body.String())
	}
	if auditCount(a, "appearance.update", "appearance") != 1 {
		t.Fatal("saving appearance must be audited")
	}
	// A data:image wallpaper is legitimate (CSP allows data:) and
	// must be accepted as-is.
	in = validAppearance()
	in["background"] = "data:image/png;base64,iVBORw0KGgo="
	if w := request(a, "POST", "/api/admin/appearance", in, true); w.Code != 200 {
		t.Fatalf("data:image wallpaper must be accepted: %d %s", w.Code, w.Body.String())
	}
}

func TestAppearanceValidation(t *testing.T) {
	a := testApp(t)
	cases := map[string]func(map[string]any){
		"unknown mode":      func(m map[string]any) { m["appearance"] = "blue" },
		"accent not hex":    func(m map[string]any) { m["accent"] = "red" },
		"accent short":      func(m map[string]any) { m["accent"] = "#12345" },
		"opacity too low":   func(m map[string]any) { m["surfaceOpacity"] = 29 },
		"opacity too high":  func(m map[string]any) { m["surfaceOpacity"] = 101 },
		"external wallaper": func(m map[string]any) { m["background"] = "https://evil.example/x.png" },
		"protocol-relative": func(m map[string]any) { m["background"] = "//evil.example/x.png" },
		"external logo":     func(m map[string]any) { m["logoUrl"] = "https://evil.example/logo.png" },
		"empty brand":       func(m map[string]any) { m["brandName"] = "   " },
		"newline brand":     func(m map[string]any) { m["brandSub"] = "a\nb" },
		"overlong brand":    func(m map[string]any) { m["workspace"] = strings.Repeat("长", 81) },
	}
	for name, mutate := range cases {
		in := validAppearance()
		mutate(in)
		if w := request(a, "POST", "/api/admin/appearance", in, true); w.Code != 400 {
			t.Fatalf("%s: POST = %d, want 400 (%s)", name, w.Code, w.Body.String())
		}
	}
	if a.storedAppearance() != nil {
		t.Fatal("invalid submissions must never be stored")
	}
}
