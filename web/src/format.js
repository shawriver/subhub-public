// Display formatting helpers (decimal units, matching how the backend
// and 3x-ui account traffic: member usage is stored as decimal GB).

export function bytes(value) {
  let n = Number(value || 0);
  if (!Number.isFinite(n) || n < 0) n = 0;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function gbAsBytes(gbValue) {
  return bytes(Math.max(0, Number(gbValue || 0)) * 1e9);
}

export function rate(bytesPerSecond) {
  return `${bytes(bytesPerSecond)}/s`;
}

export function pct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return `${Math.round(Number(value))}%`;
}

export function dateOnly(value) {
  if (!value) return "无期限";
  const d = new Date(`${value}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "日期无效";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(d);
}

export function shortDate(value) {
  if (!value) return "";
  const d = new Date(`${value}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function stamp(value) {
  if (!value) return "尚无记录";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "尚无记录";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" }).format(d);
}

export function daysUntil(dateStr, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "")) return null;
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const start = Date.parse(`${today}T00:00:00+08:00`);
  const target = Date.parse(`${dateStr}T00:00:00+08:00`);
  if (!Number.isFinite(target)) return null;
  return Math.round((target - start) / 86400000);
}

// Region helpers: records store free-form region text; the UI works with
// two-letter codes plus a flag derived from the code itself.
const REGION_ALIASES = [
  ["US", ["美国", "US", "United States", "America", "Fremont", "Los Angeles", "San Jose", "洛杉矶", "弗里蒙特", "圣何塞"]],
  ["HK", ["香港", "HK", "Hong Kong"]],
  ["JP", ["日本", "JP", "Japan", "Tokyo", "东京"]],
  ["SG", ["新加坡", "SG", "Singapore"]],
  ["TW", ["台湾", "臺灣", "TW", "Taiwan", "Taipei", "台北", "臺北"]],
  ["DE", ["德国", "DE", "Germany", "Frankfurt", "法兰克福"]],
  ["GB", ["英国", "GB", "UK", "United Kingdom"]],
  ["CA", ["加拿大", "CA", "Canada"]],
  ["AU", ["澳大利亚", "AU", "Australia"]],
  ["KR", ["韩国", "KR", "Korea"]],
  ["FR", ["法国", "FR", "France"]],
  ["NL", ["荷兰", "NL", "Netherlands"]],
  ["CN", ["中国", "CN", "China"]]
];

export const REGION_NAMES = Object.fromEntries(REGION_ALIASES.map(([code, names]) => [code, names[0]]));

export function regionCode(region) {
  const text = String(region || "").trim();
  if (!text) return "";
  for (const [code, names] of REGION_ALIASES) {
    if (names.some(n => n.length === 2 && /^[A-Z]+$/.test(n)
      ? text.toUpperCase().split(/[^A-Z]+/).includes(n)
      : text.toLowerCase().includes(n.toLowerCase()))) return code;
  }
  return "";
}

export function flagOf(code, stored) {
  if (stored && !/^[A-Za-z]{2}$/.test(stored)) return stored;
  if (!code && /^[A-Za-z]{2}$/.test(stored || "") && REGION_NAMES[stored.toUpperCase()]) code = stored.toUpperCase();
  if (!code || code.length !== 2) return "🌐";
  const base = 0x1f1e6;
  return String.fromCodePoint(base + code.charCodeAt(0) - 65, base + code.charCodeAt(1) - 65);
}
