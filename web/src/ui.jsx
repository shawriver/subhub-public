import React, { useEffect, useRef } from "react";
import { Moon, Sun, X } from "lucide-react";
import { toggleAppearance } from "./theme.js";
import { pct } from "./format.js";
import { latencyTone } from "./model.js";

/* Shared building blocks for the rewritten UI: glass surfaces, the
   24-cell segmented meter (Komari's signature gauge), tags and dots. */

export function Glass({ as: Tag = "section", className = "", children, ...rest }) {
  return <Tag className={`glass ${className}`} {...rest}>{children}</Tag>;
}

export function PageHeading({ icon: Icon, title, description, children }) {
  return <div className="page-head">
    <div className="page-heading">
      <span className="page-heading-icon" aria-hidden="true"><Icon size={26} /></span>
      <div><h1>{title}</h1>{description && <p className="page-sub">{description}</p>}</div>
    </div>
    {children && <div className="head-actions">{children}</div>}
  </div>;
}

export function SummaryStat({ icon: Icon, label, tone = "blue", children }) {
  return <div className={`summary-stat tone-${tone}`}>
    <div className="summary-stat-label"><span>{label}</span><IconChip icon={Icon} tone={tone} size={34} /></div>
    <strong className="summary-stat-value">{children}</strong>
  </div>;
}

export function AppearanceToggle({ theme }) {
  const dark = theme?.appearance === "dark" || (theme?.appearance === "system" && document.documentElement.dataset.appearance === "dark");
  return <button type="button" className="icon-btn appearance-toggle" onClick={toggleAppearance}
    aria-label={dark ? "切换浅色" : "切换深色"} title={dark ? "切换浅色" : "切换深色"}>
    {dark ? <Sun size={17} /> : <Moon size={17} />}
  </button>;
}

export const METER_KINDS = {
  cpu: { label: "CPU", color: "var(--metric-cpu)" },
  memory: { label: "内存", color: "var(--metric-memory)" },
  disk: { label: "磁盘", color: "var(--metric-disk)" },
  load: { label: "负载", color: "var(--metric-load)" }
};

export function SegMeter({ kind, value, display }) {
  const meta = METER_KINDS[kind];
  const cells = 24;
  const has = value !== null && value !== undefined && Number.isFinite(Number(value));
  const on = has ? Math.max(0, Math.min(cells, Math.round(Number(value) / 100 * cells))) : 0;
  return (
    <div className="meter">
      <div className="meter-top">
        <span className="meter-name"><i style={{ background: meta.color }} />{meta.label}</span>
        <span className="meter-val">{has ? (display ?? pct(value)) : "—"}</span>
      </div>
      <div className="segs" role="img" aria-label={`${meta.label} ${has ? pct(value) : "暂无数据"}`}>
        {Array.from({ length: cells }, (_, i) => (
          <i key={i} className={i < on ? `on-${kind}` : ""} />
        ))}
      </div>
    </div>
  );
}

export function StatusDot({ status }) {
  return <span className={`dot dot-${status || "pending"}`} aria-label={status === "online" ? "在线" : status === "warning" ? "需留意" : "待接入"} />;
}

export function TagPill({ tone = "gray", children }) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

export function ThinBar({ value, tone = "green" }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return <div className="thinbar"><i className={`fill-${tone}`} style={{ width: `${v}%` }} /></div>;
}

/* ---------- visual-strengthening components (viz) ---------- */

/* Small coloured tile that carries a lucide icon; tone picks the hue
   from the CSS palette (.tone-blue / .tone-green / …). */
export function IconChip({ icon: Icon, tone = "blue", size = 30 }) {
  if (!Icon) return null;
  return (
    <span className={`ico-chip tone-${tone}`} style={{ width: size, height: size }} aria-hidden="true">
      <Icon size={Math.round(size * 0.56)} strokeWidth={2} />
    </span>
  );
}

/* Ring gauge for a 0–100 ratio, with centred content. */
export function Ring({ value, size = 76, stroke = 8, color = "var(--accent)", children, label }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={label || `占比 ${v.toFixed(1)}%`}>
      <svg className="ring-svg" width={size} height={size}>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle className="ring-fill" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke}
          stroke={color} strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

/* Thick gradient progress band — the visual replacement for hairline
   bars where a ratio is the point of the card. `color` is any CSS
   background (solid or gradient). */
export function ThickBar({ value, color }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return <div className="thickbar"><i style={{ width: `${v}%`, background: color }} /></div>;
}

export const RATIO_GRADIENTS = {
  green: "linear-gradient(90deg, #2f9e65, #57c785)",
  amber: "linear-gradient(90deg, #d97706, #e2a928)",
  red: "linear-gradient(90deg, #dc2626, #f87171)",
  blue: "linear-gradient(90deg, #2f5be0, #3b82f6)"
};

/* Mini area sparkline over a numeric series. Renders nothing when the
   series has fewer than two points or is all zeros — callers check
   data presence, this guard keeps empty art off the page. */
export function Sparkline({ points, color = "var(--accent)", height = 30, gid }) {
  const vals = (points || []).map(v => Math.max(0, Number(v) || 0));
  if (vals.length < 2 || vals.every(v => v === 0)) return null;
  const W = 100, H = height, max = Math.max(...vals, 1);
  const step = W / (vals.length - 1);
  const xy = vals.map((v, i) => [i * step, H - 2 - (v / max) * (H - 5)]);
  const line = xy.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const id = `spark-${gid || "x"}`;
  return (
    <svg className="viz-spark-svg" viewBox={`0 0 ${W} ${H}`} height={height} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.03" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* Latency as a length: log-scaled bar (1 s fills it) in the five-grade
   latency colour, with the number beside it. */
export function LatencyBar({ ms }) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) {
    return <span className="lat" style={{ color: "var(--text-tertiary)" }}>—</span>;
  }
  const v = Number(ms);
  const frac = Math.max(0.04, Math.min(1, Math.log10(v + 1) / 3));
  const color = latencyTone(v);
  return (
    <span className="latbar">
      <span className="latbar-track"><i style={{ width: `${frac * 100}%`, background: color }} /></span>
      <span className="lat" style={{ color }}>{`${v} ms`}</span>
    </span>
  );
}

export function Modal({ title, kicker, children, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const node = ref.current;
    const prev = document.activeElement;
    node && node.focus();
    const onKey = e => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (prev && prev.isConnected) prev.focus(); };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal glass-strong" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}>
        <header className="modal-head">
          <div>{kicker && <p className="kicker">{kicker}</p>}<h2>{title}</h2></div>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function PlaceholderNote({ children }) {
  return <p className="m2-note">{children}</p>;
}
