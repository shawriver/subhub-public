package main

import (
	"net/http"
	"regexp"
	"strings"
)

// Appearance & branding sync (Phase 1U follow-up). The admin's theme
// choices — mode, accent, wallpaper, surface opacity, brand strings —
// live on the server as a records entry (kind "setting", id
// "appearance") so every browser and device converges on the same
// look. The browser's localStorage remains the instant-apply cache
// that paints before first render; this record is the source of truth
// it syncs from and pushes changes back to.
//
// Like the sync setting, the record is deliberately outside the
// backup snapshot's kind whitelist: a fresh install or a restored
// backup falls back to the product defaults instead of resurrecting
// stale branding.
//
// The public /api/status payload carries the stored appearance so a
// brand-new browser's login and setup screens pick the branding up
// before sign-in. The fields are exactly what those screens render —
// nothing sensitive — and writes stay behind the admin session.

type appearanceSettings struct {
	Appearance     string `json:"appearance"` // light | dark | system
	Accent         string `json:"accent"`     // #rrggbb
	Background     string `json:"background"` // same-origin path or data:image URL
	SurfaceOpacity int    `json:"surfaceOpacity"`
	BrandName      string `json:"brandName"`
	BrandSub       string `json:"brandSub"`
	Workspace      string `json:"workspace"`
	LogoURL        string `json:"logoUrl"` // same-origin path or data:image URL
}

var accentPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// storedAppearance returns the saved appearance, or nil when the
// admin has never saved one (clients then use their defaults).
func (a *App) storedAppearance() *appearanceSettings {
	var s appearanceSettings
	if err := a.get("setting", "appearance", &s); err != nil {
		return nil
	}
	return &s
}

// imageRefAllowed mirrors the CSP (img-src 'self' data:): a wallpaper
// or logo the browser could actually load is either a same-origin
// path or an inline data:image URL. Anything else would be blocked by
// the browser anyway, so it is rejected at the door.
func imageRefAllowed(s string, maxLen int) bool {
	if s == "" {
		return true
	}
	if len(s) > maxLen {
		return false
	}
	if strings.HasPrefix(s, "data:image/") {
		return true
	}
	return strings.HasPrefix(s, "/") && !strings.HasPrefix(s, "//")
}

func brandText(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if s == "" || len([]rune(s)) > 80 || strings.ContainsAny(s, "\r\n") {
		return "", false
	}
	return s, true
}

// validateAppearance normalises a client-supplied appearance for
// storage, reporting the first problem in the API's error style.
func validateAppearance(in appearanceSettings) (appearanceSettings, string) {
	switch in.Appearance {
	case "light", "dark", "system":
	default:
		return in, "外观模式不正确"
	}
	if !accentPattern.MatchString(in.Accent) {
		return in, "主色格式不正确"
	}
	if in.SurfaceOpacity < 30 || in.SurfaceOpacity > 100 {
		return in, "表面不透明度须在 30–100 之间"
	}
	if !imageRefAllowed(in.Background, 2_000_000) {
		return in, "壁纸仅支持本站路径或 data:image 链接"
	}
	if !imageRefAllowed(in.LogoURL, 200_000) {
		return in, "Logo 仅支持本站路径或 data:image 链接"
	}
	var ok bool
	if in.BrandName, ok = brandText(in.BrandName); !ok {
		return in, "品牌名称不正确"
	}
	if in.BrandSub, ok = brandText(in.BrandSub); !ok {
		return in, "品牌副标题不正确"
	}
	if in.Workspace, ok = brandText(in.Workspace); !ok {
		return in, "工作区名称不正确"
	}
	return in, ""
}

func (a *App) appearanceAPI(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		writeJSON(w, 200, map[string]any{"appearance": a.storedAppearance()})
	case "POST":
		var in appearanceSettings
		if decodeBody(r, &in) != nil {
			apiError(w, 400, "请求格式不正确")
			return
		}
		out, problem := validateAppearance(in)
		if problem != "" {
			apiError(w, 400, problem)
			return
		}
		if err := a.put("setting", "appearance", out); err != nil {
			apiError(w, 500, "保存失败")
			return
		}
		a.audit("appearance.update", "appearance")
		writeJSON(w, 200, map[string]any{"appearance": out})
	default:
		apiError(w, 405, "method not allowed")
	}
}
