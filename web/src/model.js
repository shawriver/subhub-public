import { regionCode, flagOf } from "./format.js";

/* Derivations over the GET /api/admin/overview payload. The backend
   already folds Komari readings into server.status and exposes raw
   metrics under data.komari.metrics[server.komariUuid]. */

export function metricOf(data, server) {
  if (!server || !server.komariUuid) return null;
  return data.komari?.metrics?.[server.komariUuid] || null;
}

export function serverView(data, server) {
  const metric = metricOf(data, server);
  const code = regionCode(server.region) || regionCode(server.flag);
  const nodes = data.nodes.filter(n => n.serverId === server.id);
  const panels = (data.panels || []).filter(p => p.serverId === server.id);
  const subUsedBytes = (data.grants || []).reduce((sum, g) => {
    const panel = (data.panels || []).find(p => p.id === g.panelId);
    return sum + (panel && panel.serverId === server.id ? Number(g.used || 0) : 0);
  }, 0);
  return {
    server,
    metric,
    code,
    flag: flagOf(code, server.flag),
    nodeCount: nodes.length,
    enabledNodes: nodes.filter(n => n.enabled).length,
    panelLinked: panels.length > 0,
    panelOk: panels.some(p => p.status === "connected"),
    subUsedBytes,
    online: server.status === "online"
  };
}

export function nodeHealthOf(data, node) {
  const health = data.nodeHealth?.[node.id] || null;
  let state = "pending";
  if (health?.state === "reachable") state = "ok";
  else if (health?.state === "unreachable" || health?.state === "config_error") state = "problem";
  return {
    node, health, state,
    latencyMs: health?.state === "reachable" ? health.latencyMs || null : null
  };
}

export function nodeSummary(data) {
  const enabled = data.nodes.filter(n => n.enabled);
  const rows = enabled.map(n => nodeHealthOf(data, n));
  const healthy = rows.filter(r => r.state === "verified" || r.state === "ok").length;
  const problems = rows.filter(r => r.state === "problem");
  return { total: enabled.length, healthy, problems, rows };
}

export function latencyTone(ms) {
  if (ms === null || ms === undefined) return "var(--text-tertiary)";
  if (ms < 50) return "var(--lat-excellent)";
  if (ms < 100) return "var(--lat-good)";
  if (ms < 180) return "var(--lat-moderate)";
  if (ms < 300) return "var(--lat-elevated)";
  return "var(--lat-critical)";
}

/* "Today" traffic: Komari reports cumulative counters only, so the
   browser keeps a per-day baseline (first reading of the day) and shows
   the delta. Counters that reset mid-day clamp at zero. */
const DAY_KEY = "subhub-day-totals-v1";

export function todayTraffic(data) {
  let up = 0, down = 0;
  for (const server of data.servers) {
    const m = metricOf(data, server);
    if (m) { up += Number(m.totalUp || 0); down += Number(m.totalDown || 0); }
  }
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  try {
    const saved = JSON.parse(localStorage.getItem(DAY_KEY) || "null");
    if (!saved || saved.day !== today) {
      localStorage.setItem(DAY_KEY, JSON.stringify({ day: today, up, down }));
      return { up: 0, down: 0, total: 0 };
    }
    const dUp = Math.max(0, up - saved.up);
    const dDown = Math.max(0, down - saved.down);
    return { up: dUp, down: dDown, total: dUp + dDown };
  } catch {
    return { up: 0, down: 0, total: 0 };
  }
}

/* Asset overview: server prices are free text ("¥ 120 / 年", "$7 / 月").
   Parse amount + currency + period and normalise to CNY per year with
   fixed display rates; unparseable prices are counted, not guessed. */
const FX = { "¥": 1, "￥": 1, CNY: 1, RMB: 1, "$": 7.2, USD: 7.2, "€": 7.8, EUR: 7.8, "£": 9.1, GBP: 9.1 };

export function parsePriceToCNYYear(price) {
  const text = String(price || "");
  const m = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  let fx = 1;
  for (const key of Object.keys(FX)) {
    if (text.toUpperCase().includes(key)) { fx = FX[key]; break; }
  }
  let perYear = amount;
  if (/月|\/mo|month/i.test(text)) perYear = amount * 12;
  else if (/季|quarter/i.test(text)) perYear = amount * 4;
  return perYear * fx;
}

export function assetSummary(data) {
  let total = 0, priced = 0;
  let next = null;
  for (const s of data.servers) {
    const v = parsePriceToCNYYear(s.price);
    if (v !== null) { total += v; priced++; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s.expires || "")) {
      if (!next || s.expires < next.server.expires) next = { server: s };
    }
  }
  return { totalCNY: total, priced, totalServers: data.servers.length, next };
}
