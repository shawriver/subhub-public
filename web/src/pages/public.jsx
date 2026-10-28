import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDown, ArrowUp, ArrowUpRight, Clock, Gauge, Globe2, LayoutDashboard, RefreshCw, Server, ServerOff, Waves } from "lucide-react";
import { AppearanceToggle, Glass, SegMeter, StatusDot } from "../ui.jsx";
import { getPublicStatus } from "../api.js";
import { bytes, flagOf, rate, regionCode, REGION_NAMES, stamp } from "../format.js";

/* Public status page (/status, no login): a Komari-style machine wall fed
   by GET /api/public/status. Shows only what the backend's PublicMachine
   carries — status, CPU/memory/disk segmented meters, live rates,
   cumulative traffic and the traffic quota bar. Connection counts,
   uptime and commercial details stay internal. */

const STATUS_META = {
  online: { label: "在线", cls: "badge-ok" },
  stale: { label: "数据陈旧", cls: "badge-warn" },
  unknown: { label: "未知", cls: "badge-idle" }
};

const HISTORY_LIMIT = 40;

function PublicHeader({ theme, komariUrl }) {
  return (
    <header className="pub-head">
      <div className="pub-brand">
        {theme?.logoUrl
          ? <img className="brand-logo" src={theme.logoUrl} alt="" width={40} height={40} />
          : <span className="pub-brand-icon"><Server size={21} /></span>}
        <div><h1>{theme?.brandName || "SubHub"}</h1><p className="pub-sub">服务器状态</p></div>
      </div>
      <div className="pub-head-actions">
        <AppearanceToggle theme={theme} />
        {komariUrl && <a className="btn pub-komari-link" href={komariUrl} target="_blank" rel="noopener noreferrer">
          监控详情 <ArrowUpRight size={14} />
        </a>}
        <a className="btn btn-primary" href="/admin"><LayoutDashboard size={15} />后台管理</a>
      </div>
    </header>
  );
}

function QuotaSegs({ used, limit }) {
  const ratio = limit > 0 ? Math.max(0, Math.min(1, Number(used || 0) / limit)) : 0;
  const cells = 24;
  const on = Math.round(ratio * cells);
  const tone = ratio >= 0.9 ? "pub-seg-red" : ratio >= 0.7 ? "pub-seg-amber" : "pub-seg-accent";
  return (
    <div className="segs pub-quota-segs" role="img" aria-label={`流量配额已用 ${(ratio * 100).toFixed(1)}%`}>
      {Array.from({ length: cells }, (_, i) => (
        <i key={i} className={i < on ? tone : ""} />
      ))}
    </div>
  );
}

/* Two-series bandwidth history collected in the browser while this page
   stays open. Values come from real polls; nothing is synthesised. */
function LiveChart({ up, down }) {
  const points = { up: up.slice(-HISTORY_LIMIT), down: down.slice(-HISTORY_LIMIT) };
  const length = Math.max(points.up.length, points.down.length);
  const max = Math.max(...points.up, ...points.down, 1);
  const path = series => {
    if (series.length < 2) return "";
    const step = 100 / Math.max(1, length - 1);
    return series.map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${(28 - (v / max) * 25).toFixed(2)}`).join(" ");
  };
  const area = path(points.down);
  return (
    <svg className="pub-live-chart" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <line className="pub-live-baseline" x1="0" y1="28" x2="100" y2="28" />
      {area && <path className="pub-live-area" d={`${area} L100,28 L0,28 Z`} />}
      {area && <path className="pub-live-line-down" d={area} />}
      {points.up.length > 1 && <path className="pub-live-line-up" d={path(points.up)} />}
    </svg>
  );
}

function RateBar({ value, max, tone }) {
  const width = max > 0 ? Math.max(2, Math.min(100, (Number(value || 0) / max) * 100)) : 0;
  return <i className={`pub-rate-bar pub-rate-${tone}`} style={{ width: `${width}%` }} />;
}

function MachineCard({ m, rateMax }) {
  const code = regionCode(m.region) || regionCode(m.flag);
  const meta = STATUS_META[m.status] || STATUS_META.unknown;
  const online = m.status === "online";
  const limit = Number(m.trafficLimit || 0);
  const used = Number(m.trafficUsed || 0);
  const hasTotals = m.totalUp !== undefined && m.totalUp !== null;
  const hasQuota = limit > 0 && m.trafficUsed != null;
  return (
    <article className={`glass pub-wall-card pub-machine-${m.status || "unknown"}`} aria-label={`服务器 ${m.name}`}>
      <header className="pub-wall-card-head">
        <span className="pub-wall-flag" aria-hidden="true">{flagOf(code, m.flag)}</span>
        <div className="pub-wall-ident">
          <strong>{m.name}</strong>
          <span>{code ? `${code} · ${REGION_NAMES[code] || m.region}` : (m.region || "地区未记录")}</span>
        </div>
        <span className="pub-wall-state">
          <StatusDot status={online ? "online" : m.status === "stale" ? "warning" : "pending"} />
          <span className={`badge ${meta.cls}`}>{meta.label}</span>
        </span>
      </header>

      <div className="pub-wall-meters">
        <SegMeter kind="cpu" value={m.cpu} />
        <SegMeter kind="memory" value={m.memory} />
        <div className="pub-wall-meter-wide"><SegMeter kind="disk" value={m.disk} /></div>
      </div>

      <div className="pub-wall-rates">
        <div className="pub-wall-rate">
          <span className="pub-rate-label"><ArrowUp size={12} />上行</span>
          <strong className="network-up">{online ? rate(m.up) : "—"}</strong>
          <span className="pub-rate-track"><RateBar value={m.up} max={rateMax} tone="up" /></span>
        </div>
        <div className="pub-wall-rate">
          <span className="pub-rate-label"><ArrowDown size={12} />下行</span>
          <strong className="network-down">{online ? rate(m.down) : "—"}</strong>
          <span className="pub-rate-track"><RateBar value={m.down} max={rateMax} tone="down" /></span>
        </div>
      </div>

      <dl className="pub-wall-totals">
        <div><dt><ArrowUp size={11} />出站</dt><dd>{hasTotals ? bytes(m.totalUp) : "—"}</dd></div>
        <div><dt><ArrowDown size={11} />入站</dt><dd>{hasTotals ? bytes(m.totalDown) : "—"}</dd></div>
      </dl>

      <div className="pub-wall-quota">
        {hasQuota ? (
          <>
            <div className="pub-quota-top">
              <span>已用流量</span>
              <strong>{bytes(used)}<small> / {bytes(limit)}</small></strong>
            </div>
            <QuotaSegs used={used} limit={limit} />
          </>
        ) : (
          <p className="pub-quota-none">{limit > 0 ? "用量暂不可用" : "暂无额度数据"}</p>
        )}
      </div>
    </article>
  );
}

function SummaryBand({ machines, historyUp, historyDown, onlineCount, regionCount }) {
  const totalUp = machines.reduce((sum, m) => sum + (Number(m.up) || 0), 0);
  const totalDown = machines.reduce((sum, m) => sum + (Number(m.down) || 0), 0);
  const lifetime = machines.reduce((sum, m) => sum + (Number(m.totalUp) || 0) + (Number(m.totalDown) || 0), 0);
  const outbound = machines.reduce((sum, m) => sum + (Number(m.totalUp) || 0), 0);
  const inbound = machines.reduce((sum, m) => sum + (Number(m.totalDown) || 0), 0);
  const ratio = machines.length ? (onlineCount / machines.length) * 100 : 0;
  return (
    <Glass className="pub-band">
      <div className="pub-band-cell">
        <span className="pub-band-label"><Server size={13} />在线服务器</span>
        <strong className="pub-band-value">{onlineCount}<small> / {machines.length}</small></strong>
        <div className="pub-band-track" role="img" aria-label={`在线率 ${ratio.toFixed(0)}%`}><i style={{ width: `${ratio}%` }} /></div>
      </div>
      <div className="pub-band-cell">
        <span className="pub-band-label"><Activity size={13} />实时带宽</span>
        <strong className="pub-band-value">{rate(totalUp + totalDown)}</strong>
        <LiveChart up={historyUp} down={historyDown} />
        <p className="pub-band-note"><span className="network-up">↑ {rate(totalUp)}</span><span className="network-down">↓ {rate(totalDown)}</span></p>
      </div>
      <div className="pub-band-cell">
        <span className="pub-band-label"><Waves size={13} />累计流量</span>
        <strong className="pub-band-value">{bytes(lifetime)}</strong>
        <p className="pub-band-note"><span className="network-up">↑ {bytes(outbound)}</span><span className="network-down">↓ {bytes(inbound)}</span></p>
      </div>
      <div className="pub-band-cell">
        <span className="pub-band-label"><Globe2 size={13} />覆盖地区</span>
        <strong className="pub-band-value">{regionCount}</strong>
        <p className="pub-band-note"><span><Gauge size={11} />{machines.length} 台服务器</span></p>
      </div>
    </Glass>
  );
}

export default function PublicStatusPage({ theme }) {
  const [data, setData] = useState(null);
  const [closed, setClosed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("all");
  const [history, setHistory] = useState({ up: [], down: [] });
  const dataRef = useRef(null);
  const machines = Array.isArray(data?.machines) ? data.machines : [];
  const groups = useMemo(() => {
    const map = new Map();
    for (const m of machines) {
      const code = regionCode(m.region) || regionCode(m.flag) || "";
      map.set(code, (map.get(code) || 0) + 1);
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([code, count]) => ({code, count}));
  }, [machines]);

  const load = useCallback(async () => {
    try {
      const v = await getPublicStatus();
      dataRef.current = v;
      setData(v);
      setClosed(false);
      setFailed(false);
      const machines = Array.isArray(v.machines) ? v.machines : [];
      const up = machines.reduce((sum, m) => sum + (Number(m.up) || 0), 0);
      const down = machines.reduce((sum, m) => sum + (Number(m.down) || 0), 0);
      setHistory(prev => ({
        up: [...prev.up, up].slice(-HISTORY_LIMIT),
        down: [...prev.down, down].slice(-HISTORY_LIMIT)
      }));
      const secs = Number(v.refreshSeconds);
      return Number.isFinite(secs) && secs >= 2 ? secs : 5;
    } catch (e) {
      if ((e.message || "").includes("已关闭")) {
        setClosed(true);
      } else if (!dataRef.current) {
        setFailed(true);
      }
      return 5;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer;
    const tick = async () => {
      const secs = await load();
      if (!alive) return;
      timer = setTimeout(tick, secs * 1000);
    };
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [load]);

  if (closed) {
    return (
      <div className="pub-page">
        <PublicHeader theme={theme} />
        <Glass className="pub-state">
          <span className="pub-state-icon"><ServerOff size={26} /></span>
          <h2>公开状态页已关闭</h2>
          <p>管理员已关闭公开状态页，服务器状态暂不对外展示。</p>
        </Glass>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="pub-page">
        <PublicHeader theme={theme} />
        <Glass className="pub-state">
          {failed ? (
            <>
              <h2>状态暂不可用</h2>
              <p>暂时读不到服务器状态，请稍后再试。</p>
              <button type="button" className="btn" onClick={load}><RefreshCw size={15} />重新尝试</button>
            </>
          ) : (
            <p className="pub-loading">正在加载服务器状态…</p>
          )}
        </Glass>
      </div>
    );
  }

  const refreshSeconds = Number(data.refreshSeconds) || 5;
  const onlineCount = machines.filter(m => m.status === "online").length;
  const rateMax = Math.max(...machines.map(m => Math.max(Number(m.up) || 0, Number(m.down) || 0)), 1);

  const regions = groups.filter(g => g.code);
  const activeFilter = groups.some(g => g.code === filter) ? filter : "all";
  const shown = activeFilter === "all" ? machines : machines.filter(m => (regionCode(m.region) || regionCode(m.flag) || "") === activeFilter);

  return (
    <div className="pub-page pub-page-wall">
      <PublicHeader theme={theme} komariUrl={data.komariUrl} />
      <SummaryBand machines={machines} historyUp={history.up} historyDown={history.down} onlineCount={onlineCount} regionCount={regions.length} />

      <div className="pub-wall-bar">
        <div className="pub-filters segmented" role="group" aria-label="地区筛选">
          <button type="button" className={activeFilter === "all" ? "active" : ""} aria-pressed={activeFilter === "all"} onClick={() => setFilter("all")}>
            全部<span className="sv2-chip-count">{machines.length}</span>
          </button>
          {regions.map(g => (
            <button key={g.code} type="button" className={activeFilter === g.code ? "active" : ""} aria-pressed={activeFilter === g.code} onClick={() => setFilter(g.code)}>
              <span aria-hidden="true">{flagOf(g.code)}</span>{g.code}<span className="sv2-chip-count">{g.count}</span>
            </button>
          ))}
        </div>
        <span className="pub-wall-refresh"><RefreshCw size={13} />每 {refreshSeconds} 秒刷新</span>
      </div>

      {shown.length
        ? <section className="pub-wall-grid" aria-label="服务器状态">{shown.map(m => <MachineCard key={m.name} m={m} rateMax={rateMax} />)}</section>
        : machines.length
          ? <Glass className="pub-state"><p className="pub-loading">该地区暂无服务器记录。</p></Glass>
          : <Glass className="pub-state"><p className="pub-loading">暂无服务器记录。</p></Glass>}

      <p className="pub-foot">
        <Clock size={13} />数据来自 Komari 探针 · 每 {refreshSeconds} 秒刷新
        {data.updatedAt ? <span> · 更新于 {stamp(data.updatedAt)}</span> : null}
      </p>
    </div>
  );
}
