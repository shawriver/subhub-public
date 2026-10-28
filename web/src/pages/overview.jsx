import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight, ChartPie, Database, Gauge, HeartPulse, RefreshCw,
  Server as ServerIcon, TrendingUp, UserCheck, Users
} from "lucide-react";
import {
  Glass, IconChip, RATIO_GRADIENTS, Ring, SegMeter,
  Sparkline, StatusDot, TagPill, ThickBar
} from "../ui.jsx";
import { bytes, dateOnly, daysUntil, pct, rate, REGION_NAMES, shortDate, stamp } from "../format.js";
import { nodeSummary, serverView } from "../model.js";

/* Overview (content-enriched rewrite).
   Every number on this page comes from a real payload field:
   - monthly / daily traffic: data.trafficDaily (backend day aggregates
     built from Komari cumulative-counter diffs) — the old localStorage
     estimate (model.todayTraffic) is retired and must not come back;
   - live rates: sum of metric.up/down over online servers, resampled
     in-page every 5 s while the page is open;
   - quota: metric.trafficUsed / metric.trafficLimit (Komari pointers);
   - users: data.members derived view + data.fetchStats (30-day fetch
     log aggregates). Online connection counts have no data source yet
     and are explicitly not shown. */

/* ---------- date helpers (all calendar math on YYYY-MM-DD, UTC) ---------- */

function shanghaiToday() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function addDays(dateStr, delta) {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(ms)) return dateStr;
  return new Date(ms + delta * 86400000).toISOString().slice(0, 10);
}

/* Fill a [start..end] inclusive window from trafficDaily rows; days the
   backend has no aggregate for come back as explicit zeros. */
function dailyWindow(daily, endDate, count) {
  const byDate = new Map();
  for (const row of daily || []) {
    if (row && /^\d{4}-\d{2}-\d{2}$/.test(row.date || "")) {
      byDate.set(row.date, { up: Number(row.up || 0), down: Number(row.down || 0) });
    }
  }
  const days = [];
  for (let i = count - 1; i >= 0; i--) {
    const date = addDays(endDate, -i);
    const hit = byDate.get(date);
    days.push({ date, up: hit ? hit.up : 0, down: hit ? hit.down : 0, total: hit ? hit.up + hit.down : 0, has: !!hit });
  }
  return days;
}

function BigBytes({ value }) {
  const [num, unit] = bytes(value).split(" ");
  return <div className="ov-big">{num}<span className="unit">{unit || ""}</span></div>;
}

function OverviewCard({ label, icon, tone = "blue", children, detail }) {
  return (
    <Glass className={`ov-card ov2-card tone-${tone}`}>
      <div className="ov-label viz-label">{icon && <IconChip icon={icon} tone={tone} />}<span>{label}</span></div>
      {children}
      {detail}
    </Glass>
  );
}

/* ---------- 1. 本月已用（真实日统计） ---------- */

function MonthTrafficCard({ data, today }) {
  const daily = Array.isArray(data.trafficDaily) ? data.trafficDaily : [];
  const monthPrefix = today.slice(0, 7);
  const monthRows = daily.filter(r => r && typeof r.date === "string" && r.date.startsWith(monthPrefix));
  const up = monthRows.reduce((s, r) => s + Number(r.up || 0), 0);
  const down = monthRows.reduce((s, r) => s + Number(r.down || 0), 0);

  /* 计入统计的服务器数：当月日统计里出现过的 serverId 并集；
     老载荷没有 servers 明细时退到已关联探针的服务器数，并如实改口径文案。 */
  const serverIds = new Set();
  for (const r of monthRows) {
    if (r.servers && typeof r.servers === "object") for (const id of Object.keys(r.servers)) serverIds.add(id);
  }
  const komariCount = (data.servers || []).filter(s => s.komariUuid).length;
  const counted = serverIds.size > 0
    ? { n: serverIds.size, note: "按日统计口径" }
    : { n: komariCount, note: "已关联 Komari 探针" };

  const since = data.trafficSince || "";
  const incomplete = !!since && since > `${monthPrefix}-01` && since <= today;

  if (daily.length === 0) {
    return (
      <OverviewCard label="本月已用流量" icon={Database} tone="green" detail={
        <div className="ov-detail">日流量由后端按 Komari 累计计数差分逐日累积，暂无可展示的历史。</div>
      }>
        <div className="ov-big ov2-big-text">统计累积中</div>
      </OverviewCard>
    );
  }

  return (
    <OverviewCard label="本月已用流量" icon={Database} tone="green" detail={
      <div className="ov-detail ov2-detail-stack">
        <span><span className="ov2-up">↑ {bytes(up)}</span><span className="ov2-down">↓ {bytes(down)}</span></span>
        <span className="ov-hint">计入统计 {counted.n} 台服务器（{counted.note}）</span>
        {incomplete && <span className="ov2-warn-note">日统计自 {since} 起，本月数据不完整</span>}
        <span className="ov-hint">趋势见上方主图 · 近 30 天每日流量</span>
      </div>
    }>
      <BigBytes value={up + down} />
    </OverviewCard>
  );
}

/* ---------- 2. 实时网速（在线服务器速率合计 + 本页采样） ---------- */

function LiveRateCard({ views, onRefresh }) {
  const [samples, setSamples] = useState([]);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const live = useMemo(() => {
    let up = 0, down = 0, n = 0;
    for (const v of views) {
      if (v.online && v.metric) { up += Number(v.metric.up || 0); down += Number(v.metric.down || 0); n++; }
    }
    return { up, down, n };
  }, [views]);

  /* 本页挂载期间每 5 秒拉一次新数据（页面不可见时跳过）。 */
  useEffect(() => {
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (refreshRef.current) refreshRef.current();
    }, 5000);
    return () => clearInterval(id);
  }, []);

  /* 每次拿到新载荷（live 合计变化）就记一个采样，最多保留最近 60 个。 */
  useEffect(() => {
    setSamples(prev => [...prev.slice(-59), { up: live.up, down: live.down }]);
  }, [live]);

  const peakDown = samples.reduce((m, s) => Math.max(m, s.down), 0);
  const peakUp = samples.reduce((m, s) => Math.max(m, s.up), 0);

  /* Enlarged gradient area chart over the in-page samples, with the
     session peak annotated on the download curve. */
  const W = 260, H = 86, PAD = 4;
  const maxV = Math.max(1, ...samples.map(s => Math.max(s.up, s.down)));
  const xyOf = key => samples.map((s, i) => {
    const x = samples.length > 1 ? i / (samples.length - 1) * (W - PAD * 2) + PAD : W / 2;
    const y = H - 4 - (s[key] / maxV) * (H - 18);
    return [x, y];
  });
  const areaOf = key => {
    const pts = xyOf(key);
    if (!pts.length) return "";
    const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    return `${line} L${pts[pts.length - 1][0].toFixed(1)},${H} L${pts[0][0].toFixed(1)},${H} Z`;
  };
  const lineOf = key => xyOf(key).map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const peakIdx = samples.reduce((best, s, i) => (s.down > (samples[best]?.down || 0) ? i : best), 0);
  const peakPt = samples.length > 1 ? xyOf("down")[peakIdx] : null;
  const peakAnchor = peakPt ? (peakPt[0] < 60 ? "start" : peakPt[0] > W - 60 ? "end" : "middle") : "middle";

  return (
    <OverviewCard label="实时网速" icon={Gauge} tone="blue" detail={
      <div className="ov-detail ov2-detail-stack">
        <span>↑ {rate(live.up)} · {live.n} 台在线服务器合计</span>
        <span>本次峰值 ↓ {rate(peakDown)} · ↑ {rate(peakUp)}</span>
        {samples.length > 1
          ? <svg viewBox={`0 0 ${W} ${H}`} className="viz-live-svg" role="img" aria-label="本次打开页面以来的总速率采样面积图">
              <defs>
                <linearGradient id="liveGradDown" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: "#2f9e65" }} stopOpacity="0.38" />
                  <stop offset="100%" style={{ stopColor: "#2f9e65" }} stopOpacity="0.03" />
                </linearGradient>
                <linearGradient id="liveGradUp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" style={{ stopColor: "var(--accent)" }} stopOpacity="0.34" />
                  <stop offset="100%" style={{ stopColor: "var(--accent)" }} stopOpacity="0.03" />
                </linearGradient>
              </defs>
              <path d={areaOf("up")} fill="url(#liveGradUp)" />
              <path d={lineOf("up")} className="ov2-line-up" fill="none" />
              <path d={areaOf("down")} fill="url(#liveGradDown)" />
              <path d={lineOf("down")} className="ov2-line-down" fill="none" />
              {peakPt && peakDown > 0 && <>
                <circle cx={peakPt[0]} cy={peakPt[1]} r="3.2" className="viz-peak-dot" style={{ fill: "#2f9e65" }} />
                <text x={peakPt[0]} y={Math.max(10, peakPt[1] - 7)} textAnchor={peakAnchor}
                  className="viz-peak-tag viz-peak-tag-down">峰值 {rate(peakDown)}</text>
              </>}
            </svg>
          : <span className="ov-hint">速率采样中…</span>}
        <span className="ov-hint">本次打开页面以来的采样（每 5 秒一次，最多 60 个）</span>
      </div>
    }>
      <div className="ov-big ov2-rate-big tone-green">↓ {rate(live.down)}</div>
    </OverviewCard>
  );
}

/* ---------- 3. 用户与接入（只展示有数据源的项） ---------- */

function AccessCard({ data }) {
  const members = Array.isArray(data.members) ? data.members : [];
  const enabled = members.filter(m => m.enabled).length;
  const fs = data.fetchStats || null;
  return (
    <OverviewCard label="用户与接入" icon={Users} tone="purple" detail={
      <div className="ov-detail ov2-detail-stack">
        {fs
          ? <>
              <div className="ov2-kv"><span>近 30 天活跃 IP</span><strong>{Number(fs.distinctIps30d || 0)} 个</strong></div>
              <div className="ov2-kv"><span>近 30 天订阅拉取</span><strong>{Number(fs.fetches30d || 0)} 次</strong></div>
              <div className="ov2-kv"><span>近 30 天活跃用户</span><strong>{Number(fs.distinctMembers30d || 0)} 人</strong></div>
            </>
          : <span>近 30 天拉取统计暂无数据</span>}
      </div>
    }>
      <div className="ov-big">{enabled}<span className="unit">/ {members.length} 人启用</span></div>
    </OverviewCard>
  );
}

/* ---------- 4. 服务器状态 ---------- */

function ServerStatusCard({ data, views }) {
  const online = views.filter(v => v.server.status === "online").length;
  const warning = views.filter(v => v.server.status === "warning").length;
  const pending = views.length - online - warning;
  return (
    <OverviewCard label="服务器状态" icon={ServerIcon} tone="cyan" detail={
      <>
        <div className="ov2-pill-row">
          <span className="ov2-pill ov2-pill-green"><i />在线 {online}</span>
          <span className="ov2-pill ov2-pill-amber"><i />告警 {warning}</span>
          <span className="ov2-pill ov2-pill-gray"><i />待连接 {pending}</span>
        </div>
        <ThickBar value={views.length ? online / views.length * 100 : 0} color={RATIO_GRADIENTS.green} />
        <div className="ov-detail">{online === views.length && views.length > 0 ? "全部在线" : `${views.length - online} 台待留意`}{data.generatedAt ? ` · 更新于 ${stamp(data.generatedAt)}` : ""}</div>
      </>
    }>
      <div className="ov-big">{online}<span className="unit">/ {views.length} 台在线</span></div>
    </OverviewCard>
  );
}

/* ---------- 5. 限额配额（Komari trafficLimit / trafficUsed） ---------- */

function QuotaCard({ views }) {
  const limited = useMemo(() => views
    .filter(v => v.metric && Number(v.metric.trafficLimit || 0) > 0 && v.metric.trafficUsed != null)
    .map(v => ({
      name: v.server.name,
      used: Number(v.metric.trafficUsed || 0),
      limit: Number(v.metric.trafficLimit || 0)
    }))
    .sort((a, b) => (b.used / b.limit) - (a.used / a.limit)), [views]);

  if (limited.length === 0) {
    return (
      <OverviewCard label="已用流量" icon={ChartPie} tone="orange" detail={
        <div className="ov-detail">暂无完整的 Komari 流量额度与用量数据。</div>
      }>
        <div className="ov-big ov2-big-text">额度数据暂不可用</div>
      </OverviewCard>
    );
  }

  const sumUsed = limited.reduce((s, x) => s + x.used, 0);
  const sumLimit = limited.reduce((s, x) => s + x.limit, 0);
  const ratio = sumLimit > 0 ? sumUsed / sumLimit * 100 : 0;
  const tone = ratio > 90 ? "red" : ratio >= 70 ? "amber" : "green";
  const pill = ratio > 90
    ? <span className="ov2-pill ov2-pill-red"><i />接近上限</span>
    : ratio >= 70
      ? <span className="ov2-pill ov2-pill-amber"><i />余量偏紧</span>
      : <span className="ov2-pill ov2-pill-green"><i />余量充足</span>;

  const ringColor = tone === "red" ? "var(--status-error)" : tone === "amber" ? "#e2a928" : "var(--status-online)";
  return (
    <OverviewCard label="已用流量" icon={ChartPie} tone="orange" detail={
      <div className="ov-detail ov2-detail-stack">
        {limited.slice(0, 3).map(x => (
          <div className="ov2-kv" key={x.name}><span>{x.name}</span><strong>{(x.used / x.limit * 100).toFixed(1)}%</strong></div>
        ))}
        {limited.length > 3 && <span className="ov-hint">等共 {limited.length} 台限额服务器</span>}
      </div>
    }>
      <div className="viz-quota-main">
        <div className="ov-quota-fraction">
          <strong>{bytes(sumUsed)}</strong>
          <span>/ {bytes(sumLimit)}</span>
          <small>已使用 / 总流量</small>
        </div>
        <div className="viz-quota-side">
          {pill}
          <span className="ov-hint">{ratio.toFixed(1)}% 已使用 · 剩余 {bytes(Math.max(0, sumLimit - sumUsed))}</span>
        </div>
      </div>
    </OverviewCard>
  );
}

/* ---------- 6. 用户状态（超额 / 有限连接 / 拉取异常） ---------- */

function MemberStatusCard({ data }) {
  const members = Array.isArray(data.members) ? data.members : [];
  const over = members.filter(m => Number(m.limit || 0) > 0 && Number(m.quotaUsed || 0) >= Number(m.limit || 0));
  const limited = members.filter(m => Number(m.connectionLimit || 0) > 0).length;
  const anomaly = members.filter(m => m.hasAnomaly).length;
  return (
    <OverviewCard label="用户流量状态" icon={UserCheck} tone="pink" detail={
      <div className="ov-detail ov2-detail-stack">
        <div className="ov2-chip-row">
          <span className="ov2-chip">有限连接 {limited} 人</span>
          <span className="ov2-chip">拉取异常 {anomaly} 人</span>
        </div>
        <span>{members.length === 0
          ? "还没有用户。"
          : over.length === 0
            ? "暂无用户超出本周期流量额度。"
            : `超额用户：${over.slice(0, 3).map(m => m.name || m.id).join("、")}${over.length > 3 ? ` 等 ${over.length} 人` : ""}`}</span>
      </div>
    }>
      <div className="ov-big">{over.length}<span className="unit">/ {members.length} 人超额</span></div>
    </OverviewCard>
  );
}

/* ---------- 主视觉：近 30 天每日流量（面积图＋7 日均线） ---------- */

function DailyTrafficChart({ data, today }) {
  const daily = Array.isArray(data.trafficDaily) ? data.trafficDaily : [];
  const days = useMemo(() => dailyWindow(daily, today, 30), [daily, today]);
  const total30 = days.reduce((s, d) => s + d.total, 0);
  const up30 = days.reduce((s, d) => s + d.up, 0);
  const down30 = days.reduce((s, d) => s + d.down, 0);
  const peak = days.reduce((best, d) => (d.total > (best?.total || 0) ? d : best), null);
  const peakIdx = peak && peak.total > 0 ? days.indexOf(peak) : -1;
  const since = data.trafficSince || "";
  const sinceNote = !!since && days.length > 0 && since > days[0].date;

  const W = 720, H = 232, TOP = 26, BOTTOM = 26;
  const chartH = H - TOP - BOTTOM;
  const maxV = Math.max(1, ...days.map(d => d.total));
  const slot = W / days.length;
  const cx = i => i * slot + slot / 2;
  const cy = v => TOP + chartH - v / maxV * chartH;
  const rolling = days.map((d, i) => {
    const from = Math.max(0, i - 6);
    const slice = days.slice(from, i + 1);
    return slice.reduce((s, x) => s + x.total, 0) / slice.length;
  });
  const linePoints = rolling.map((v, i) => `${cx(i).toFixed(1)},${cy(v).toFixed(1)}`).join(" ");
  const areaLine = days.map((d, i) => `${i === 0 ? "M" : "L"}${cx(i).toFixed(1)},${cy(d.total).toFixed(1)}`).join(" ");
  const areaPath = days.length
    ? `${areaLine} L${cx(days.length - 1).toFixed(1)},${TOP + chartH} L${cx(0).toFixed(1)},${TOP + chartH} Z`
    : "";
  const [totalNum, totalUnit] = bytes(total30).split(" ");
  const peakAnchor = peakIdx >= 0 ? (cx(peakIdx) < 110 ? "start" : cx(peakIdx) > W - 110 ? "end" : "middle") : "middle";

  return (
    <Glass className="wide viz-hero">
      <div className="viz-hero-head">
        <h2 className="wide-title"><IconChip icon={TrendingUp} tone="blue" />近 30 天每日流量
          <span className="ov2-wide-sub">整机流量 · 按日聚合（Komari 累计计数差分）</span>
        </h2>
        <div className="viz-hero-total">
          <span>近 30 天合计</span>
          <strong>{totalNum}<span className="unit">{totalUnit || ""}</span></strong>
        </div>
      </div>
      {sinceNote && <p className="ov2-since-note">日流量统计自 {since} 起累积，此前无数据</p>}
      {daily.length === 0
        ? <p className="wide-empty">暂无日流量数据，统计累积中。后端开始按日落库后，这里会画出最近 30 天的每日流量面积图与 7 日均线。</p>
        : <>
            <div className="ov2-chart-wrap">
              <svg viewBox={`0 0 ${W} ${H}`} className="viz-area-svg" role="img"
                aria-label={`近 30 天每日流量面积图，合计 ${bytes(total30)}，峰值日 ${peak && peak.total > 0 ? `${shortDate(peak.date)} ${bytes(peak.total)}` : "暂无"}`}>
                <defs>
                  <linearGradient id="heroGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" style={{ stopColor: "var(--accent)" }} stopOpacity="0.40" />
                    <stop offset="100%" style={{ stopColor: "var(--accent)" }} stopOpacity="0.04" />
                  </linearGradient>
                </defs>
                <text x={0} y={13} className="ov2-axis-label">{bytes(maxV)}</text>
                <line x1={0} x2={W} y1={TOP + chartH} y2={TOP + chartH} className="ov2-axis-line" />
                <path d={areaPath} fill="url(#heroGrad)" />
                <path d={areaLine} className="viz-area-line" />
                {days.map((d, i) => (
                  <rect key={d.date} x={i * slot} y={TOP} width={slot} height={chartH} fill="transparent">
                    <title>{`${d.date} · ↑ ${bytes(d.up)} · ↓ ${bytes(d.down)}`}</title>
                  </rect>
                ))}
                <polyline points={linePoints} className="ov2-avg-line" />
                {peakIdx >= 0 && <>
                  <circle cx={cx(peakIdx)} cy={cy(peak.total)} r="4" className="viz-peak-dot" />
                  <text x={cx(peakIdx)} y={Math.max(13, cy(peak.total) - 10)} textAnchor={peakAnchor}
                    className="viz-peak-label">峰值 {shortDate(peak.date)} · {bytes(peak.total)}</text>
                </>}
              </svg>
              <div className="ov2-chart-dates">
                <span>{days[0] ? shortDate(days[0].date) : ""}</span>
                <span className="ov2-legend"><i className="ov2-legend-bar" />每日流量<i className="ov2-legend-line" />7 日滚动均值</span>
                <span>今天 · {days[days.length - 1] ? shortDate(days[days.length - 1].date) : ""}</span>
              </div>
            </div>
            <div className="ov2-stat-row">
              <div><span>日均</span><strong>{bytes(total30 / 30)}</strong></div>
              <div><span>峰值日</span><strong>{peak && peak.total > 0 ? `${shortDate(peak.date)} · ${bytes(peak.total)}` : "—"}</strong></div>
              <div><span>其中上传</span><strong>{bytes(up30)}</strong></div>
              <div><span>其中下载</span><strong>{bytes(down30)}</strong></div>
            </div>
          </>}
    </Glass>
  );
}

/* ---------- M1 保留：服务器玻璃卡（原样沿用） ---------- */

function ServerCard({ view, onOpen, spark }) {
  const { server: s, metric, code, flag } = view;
  const days = daysUntil(s.expires);
  const expiryText = !s.expires ? "到期未记录" : days === null ? `到期 ${dateOnly(s.expires)}` : days < 0 ? `已过期 ${-days} 天` : days === 0 ? "今天到期" : `到期 ${shortDate(s.expires)} · 剩 ${days} 天`;
  const limit = metric ? Number(metric.trafficLimit || 0) : 0;
  const usedQ = metric ? Number(metric.trafficUsed || 0) : 0;
  const ratioQ = limit > 0 ? usedQ / limit * 100 : 0;
  const gradQ = ratioQ > 90 ? RATIO_GRADIENTS.red : ratioQ >= 70 ? RATIO_GRADIENTS.amber : RATIO_GRADIENTS.green;
  return (
    <article className="glass machine" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === "Enter") onOpen(); }} aria-label={`服务器 ${s.name}`}>
      <div className="m-head">
        <span className="m-flag">{flag}</span>
        <span className="m-name">{s.name}</span>
        <span className="m-head-right">
          <span className={`expire ${days !== null && days <= 7 ? "expire-soon" : ""}`}>{expiryText}</span>
          <StatusDot status={s.status} />
        </span>
      </div>
      <div className="m-tags">
        {code && <TagPill tone="region">{code} · {REGION_NAMES[code] || s.region}</TagPill>}
        {s.specs && <TagPill tone="plan">{s.specs.split("·").slice(0, 2).join("·").trim()}</TagPill>}
        {view.panelLinked
          ? <TagPill tone={view.panelOk ? "green" : "amber"}>{view.panelOk ? "3x-ui 已同步" : "面板连接异常"}</TagPill>
          : <TagPill tone="gray">未接入面板</TagPill>}
        <TagPill tone="gray">{view.nodeCount} 个节点</TagPill>
      </div>
      <div className="meters">
        <div className="meter-row">
          <SegMeter kind="cpu" value={metric?.cpu} />
          <SegMeter kind="memory" value={metric?.memory} />
        </div>
        <div className="meter-row">
          <SegMeter kind="disk" value={metric?.disk} />
          <SegMeter kind="load" value={null} />
        </div>
      </div>
      {spark && (
        <div className="viz-spark">
          <div className="viz-spark-top"><span>近 14 天每日流量</span><strong>{bytes(spark.sum)}</strong></div>
          <Sparkline points={spark.series} gid={s.id} />
        </div>
      )}
      {limit > 0 && (
        <div className="viz-squota">
          <div className="viz-squota-top"><span>已用流量</span><strong>{bytes(usedQ)} / {bytes(limit)}</strong></div>
          <ThickBar value={ratioQ} color={gradQ} />
        </div>
      )}
      <div className="m-foot">
        {metric
          ? <><span className="up">↑ {bytes(metric.totalUp)}</span><span className="down">↓ {bytes(metric.totalDown)}</span>
              {view.online && <span className="live">实时 ↑ {bytes(metric.up)}/s · ↓ {bytes(metric.down)}/s</span>}</>
          : <span className="live">{s.komariUuid ? "等待 Komari 数据" : "未关联 Komari 探针"}</span>}
      </div>
    </article>
  );
}

const SORTS = [["default", "默认"], ["expiry", "到期优先"], ["name", "名称"]];

export default function OverviewPage({ data, theme, onNavigate, onRefresh }) {
  const [region, setRegion] = useState("all");
  const [sortIdx, setSortIdx] = useState(0);

  const views = useMemo(() => data.servers.map(s => serverView(data, s)), [data]);
  const nodes = useMemo(() => nodeSummary(data), [data]);
  const today = useMemo(() => shanghaiToday(), [data]);

  /* Per-server 14-day series from the traffic_day per-server
     breakdown (row.servers[serverId] = {up, down}). A server with no
     breakdown rows in the window gets null — no line is drawn rather
     than inventing one. */
  const sparkOf = useMemo(() => {
    const byDate = new Map();
    for (const r of data.trafficDaily || []) {
      if (r && r.date) byDate.set(r.date, r.servers || null);
    }
    return serverId => {
      const series = [];
      let any = false, sum = 0;
      for (let i = 13; i >= 0; i--) {
        const sv = byDate.get(addDays(today, -i))?.[serverId];
        if (sv) any = true;
        const t = sv ? Number(sv.up || 0) + Number(sv.down || 0) : 0;
        series.push(t);
        sum += t;
      }
      return any && sum > 0 ? { series, sum } : null;
    };
  }, [data, today]);

  const regions = useMemo(() => {
    const counts = new Map();
    for (const v of views) if (v.code) counts.set(v.code, (counts.get(v.code) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [views]);

  const wall = useMemo(() => {
    let list = region === "all" ? [...views] : views.filter(v => v.code === region);
    const sort = SORTS[sortIdx][0];
    if (sort === "name") list.sort((a, b) => a.server.name.localeCompare(b.server.name, "zh-CN"));
    if (sort === "expiry") list.sort((a, b) => (a.server.expires || "9999") < (b.server.expires || "9999") ? -1 : 1);
    return list;
  }, [views, region, sortIdx]);

  const problemNode = nodes.problems[0];
  const nodeRows = useMemo(() => {
    const order = { problem: 0, pending: 1, ok: 2, verified: 3 };
    return [...nodes.rows].sort((a, b) => order[a.state] - order[b.state]).slice(0, 7);
  }, [nodes]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{theme.brandName}</h1>
          <p className="page-sub">{theme.workspace} · 私人网络工作台 · 服务器、节点与订阅都在这里</p>
        </div>
        <button type="button" className="btn" onClick={onRefresh}><RefreshCw size={15} />刷新数据</button>
      </div>

      <DailyTrafficChart data={data} today={today} />

      <section className="ov2-grid">
        <MonthTrafficCard data={data} today={today} />
        <LiveRateCard views={views} onRefresh={onRefresh} />
        <AccessCard data={data} />
        <ServerStatusCard data={data} views={views} />
        <QuotaCard views={views} />
        <MemberStatusCard data={data} />
      </section>

      <div className="filter-row">
        <nav className="glass filter-bar" aria-label="按地区筛选服务器">
          <button type="button" className={`fpill ${region === "all" ? "active" : ""}`} onClick={() => setRegion("all")}>全部</button>
          {regions.map(([code]) => (
            <button key={code} type="button" className={`fpill ${region === code ? "active" : ""}`} onClick={() => setRegion(code)}>{code}</button>
          ))}
        </nav>
        <button type="button" className="glass sort-pill" onClick={() => setSortIdx(i => (i + 1) % SORTS.length)} title="切换排序">
          ⇅ {SORTS[sortIdx][1]}
        </button>
      </div>

      <Glass className="region-counts" aria-label="各地区服务器数量">
        {regions.length === 0 && <span className="rc-empty">暂无服务器记录</span>}
        {regions.map(([code, count], i) => (
          <React.Fragment key={code}>
            {i > 0 && <span className="rc-sep" />}
            <button type="button" className={`rc-item ${region === code ? "active" : ""}`} onClick={() => setRegion(region === code ? "all" : code)}>
              <span className="rc-code">{code}</span>
              <span className="rc-name">{REGION_NAMES[code] || ""}</span>
              <span className="rc-num">{count}</span>
            </button>
          </React.Fragment>
        ))}
      </Glass>

      {wall.length
        ? <section className="machines">{wall.map(v => <ServerCard key={v.server.id} view={v} spark={sparkOf(v.server.id)} onOpen={() => onNavigate("servers")} />)}</section>
        : <Glass className="empty-panel"><p>这个地区还没有服务器。</p></Glass>}

      <Glass className="wide">
        <h2 className="wide-title"><IconChip icon={HeartPulse} tone="pink" />节点健康
          <button type="button" className="more-link" onClick={() => onNavigate("nodes")}>全部 {nodes.total} 个 <ArrowUpRight size={13} /></button>
        </h2>
        {nodeRows.length === 0 && <p className="wide-empty">还没有节点。先在节点页添加或从面板接入。</p>}
        <div className="node-list">
          {nodeRows.map(r => (
            <div className="node-row" key={r.node.id}>
              <span className="node-name">{r.node.name}</span>
              <span className="proto proto-blue">{r.node.protocol}</span>
              {r.node.security === "reality" && <span className="proto proto-green">REALITY</span>}
              <span className="node-right">
                {r.state === "verified" && <span className="badge badge-ok">✓ 已验证</span>}
                {r.state === "problem" && <span className="badge badge-bad">✗ 未通过</span>}
                {(r.state === "ok" || r.state === "pending") && <span className="badge badge-idle">{r.state === "ok" ? "端口可达" : "待验证"}</span>}
              </span>
            </div>
          ))}
        </div>
        <p className="wide-foot">这里的健康状态由 FRM 主机探活；从你当前设备出发的延迟请在节点页单独测试。当前节点健康占比 {nodes.total ? pct(nodes.healthy / nodes.total * 100) : "—"}。</p>
      </Glass>
    </div>
  );
}
