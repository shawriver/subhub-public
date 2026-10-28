import { useEffect, useState } from "react";

/* Appearance settings for the rewritten UI.
   Everything is applied through CSS variables on <html>: --accent,
   --surface-alpha and --wallpaper, plus data-appearance for the
   light/dark token sets.
   v3 key bump (visual-strengthening pass): the pre-v3 default surface
   opacity (55) read as solid white cards and hid the wallpaper, so
   stored opacity values from the v1/v2 era are deliberately NOT
   carried over — the new default is 30, the same surfaceOpacity the
   owner's Komari (LuminaPlus) runs, and only choices made under the
   v3 key (or pushed from one) are honoured. Branding, accent, mode
   and wallpaper choices still migrate. */

export const THEME_KEY = "subhub-appearance-v3";
const PREV_KEYS = ["subhub-appearance-v2", "subhub-appearance-v1"];
const LEGACY_KEY = PREV_KEYS[1];

export const THEME_DEFAULTS = {
  appearance: "system",         // light | dark | system (Komari default)
  accent: "#3b82f6",            // LuminaPlus primary blue
  background: "/wallpaper.jpg", // bundled sakura wallpaper
  surfaceOpacity: 45,           // 30-100; balanced readability and wallpaper visibility
  brandName: "SubHub",
  brandSub: "PRIVATE NETWORK",
  workspace: "My Network",
  logoUrl: ""
};

export const ACCENT_PRESETS = [
  ["#3b82f6", "蓝"],
  ["#76e4c2", "薄荷"],
  ["#8b5cf6", "紫"],
  ["#06b6d4", "青"],
  ["#f59e0b", "琥珀"],
  ["#ef4444", "红"]
];

function readKey(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function loadTheme() {
  const saved = readKey(THEME_KEY);
  if (saved) return { ...THEME_DEFAULTS, ...saved };
  // Pre-v3 records: migrate identity choices only. surfaceOpacity is
  // intentionally reset to the new default (see the header note) so a
  // first open under v3 shows the new glass look instead of the old
  // near-solid cards.
  for (const key of PREV_KEYS) {
    const legacy = readKey(key);
    if (legacy) {
      const imported = { ...THEME_DEFAULTS };
      for (const k of ["appearance", "accent", "brandName", "brandSub", "workspace", "logoUrl"]) {
        if (legacy[k]) imported[k] = legacy[k];
      }
      return imported;
    }
  }
  return { ...THEME_DEFAULTS };
}

export function resolveAppearance(theme) {
  if (theme.appearance === "light" || theme.appearance === "dark") return theme.appearance;
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.appearance = resolveAppearance(theme);
  const accent = /^#[0-9a-f]{6}$/i.test(theme.accent || "") ? theme.accent : THEME_DEFAULTS.accent;
  root.style.setProperty("--accent", accent);
  // Choose the higher-contrast foreground for bright custom colours too.
  const luminance = hex => {
    const channels = hex.match(/[0-9a-f]{2}/gi).map(c => parseInt(c, 16) / 255);
    const linear = channels.map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  };
  const lightness = luminance(accent);
  const darkContrast = (lightness + .05) / .05;
  root.style.setProperty("--accent-ink", darkContrast > 1.05 / (lightness + .05) ? "#000000" : "#ffffff");
  const opacity = Math.min(100, Math.max(30, Number(theme.surfaceOpacity) || 100));
  root.style.setProperty("--surface-alpha", String(opacity));
  if (theme.background) {
    root.dataset.wallpaper = "on";
    root.style.setProperty("--wallpaper", `url(${JSON.stringify(theme.background)})`);
  } else {
    delete root.dataset.wallpaper;
    root.style.removeProperty("--wallpaper");
  }
  document.title = `${theme.brandName || THEME_DEFAULTS.brandName} · 私人网络工作台`;
}

export function saveTheme(theme) {
  try { localStorage.setItem(THEME_KEY, JSON.stringify(theme)); } catch { /* private mode */ }
  applyTheme(theme);
  window.dispatchEvent(new CustomEvent("subhub-theme", { detail: theme }));
  schedulePush(theme);
}

/* ---- server sync ----------------------------------------------------
   The server record (GET/POST /api/admin/appearance) is the source of
   truth across devices; localStorage stays the instant-apply cache
   that paints before first render. Boot adopts the record carried by
   /api/status (branding is public — the login screen renders it),
   then an authenticated pass migrates a locally customised theme up
   when the server has none yet. Later edits are pushed back debounced.
   Pushes stay disarmed until the boot sync settles, so the pre-paint
   default apply can never overwrite a server value not yet seen;
   failures are silent — the cache keeps the UI correct and the next
   load or settings visit re-syncs. */

let applyingRemote = false;
let pushArmed = false;
let pushTimer = 0;

function sameTheme(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function adoptRemote(remote) {
  const next = { ...THEME_DEFAULTS, ...remote };
  pushArmed = true;
  if (sameTheme(next, loadTheme())) return;
  applyingRemote = true;
  try { saveTheme(next); } finally { applyingRemote = false; }
}

async function pushTheme(theme) {
  try {
    await fetch("/api/admin/appearance", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-SubHub-Request": "1" },
      body: JSON.stringify(theme)
    });
  } catch { /* offline or logged out: the cache remains correct */ }
}

function schedulePush(theme) {
  if (!pushArmed || applyingRemote) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushTheme(theme), 700);
}

/* Authenticated sync pass: adopt the server record, or — when the
   server has none — migrate this browser's stored customisations up
   (bare defaults are not frozen onto the server). Runs at boot and
   again when the settings page opens. Returns false when there is no
   admin session yet. */
export async function syncAppearance() {
  try {
    const res = await fetch("/api/admin/appearance", { credentials: "same-origin" });
    if (!res.ok) return false;
    const data = await res.json();
    if (data.appearance) { adoptRemote(data.appearance); return true; }
    pushArmed = true;
    let customised = false;
    try { customised = !!(localStorage.getItem(THEME_KEY) || localStorage.getItem(LEGACY_KEY)); } catch { /* private mode */ }
    if (customised) pushTheme(loadTheme());
    return true;
  } catch { return false; }
}

export function useTheme() {
  const [theme, setTheme] = useState(loadTheme);
  useEffect(() => {
    const onLocal = e => setTheme(e.detail || loadTheme());
    const onStorage = e => { if (e.key === THEME_KEY) setTheme(loadTheme()); };
    window.addEventListener("subhub-theme", onLocal);
    window.addEventListener("storage", onStorage);
    return () => { window.removeEventListener("subhub-theme", onLocal); window.removeEventListener("storage", onStorage); };
  }, []);
  const update = patch => { const next = { ...loadTheme(), ...patch }; saveTheme(next); setTheme(next); };
  return [theme, update];
}

export function toggleAppearance() {
  const next = document.documentElement.dataset.appearance === "dark" ? "light" : "dark";
  saveTheme({ ...loadTheme(), appearance: next });
}

/* Apply before first paint of the app and track OS changes in system mode. */
if (typeof window !== "undefined") {
  applyTheme(loadTheme());
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      const t = loadTheme();
      if (t.appearance === "system") applyTheme(t);
    });
  }
  // Boot sync: /api/status carries the stored appearance (null when
  // never saved) so even pre-login screens converge on the server
  // branding; the authenticated pass then handles local migration.
  fetch("/api/status")
    .then(r => (r.ok ? r.json() : null))
    .then(s => { if (s && s.appearance) adoptRemote(s.appearance); })
    .catch(() => {})
    .finally(() => { syncAppearance(); });
}
