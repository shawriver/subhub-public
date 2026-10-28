import React, { useEffect, useMemo, useState } from "react";
import { Activity, Database, ExternalLink, Link2, Pencil, Plus, RefreshCw, Server as ServerIcon, Trash2, Waypoints } from "lucide-react";
import { Glass, Modal, PageHeading, SegMeter, SummaryStat } from "../ui.jsx";
import { bytes, rate, stamp } from "../format.js";
import { metricOf, nodeHealthOf, serverView } from "../model.js";
import { DeleteServer, KomariBinding, PanelEditor, ServerEditor } from "../record-forms.jsx";

const FILTERS = [["all", "全部"], ["online", "在线"], ["alert", "告警"], ["offline", "离线"], ["pending", "待连接"]];
const MAX_NODE_BLOCKS = 14;

/* 状态分类（优先级互斥）：待连接 = 未关联 Komari 探针；离线 = 后端
   latestKomari 无有效探针记录（komari.go 中该情形 status 为 "unknown"，
   含采集失败；后端没有 "offline" 取值）；在线 = 后端折叠后的
   server.status === "online"；其余有探针者（status "stale" 数据过期等）
   归告警。 */
function categoryOf(view) {
  const s = view.server;
  const m = view.metric;
  if (!s.komariUuid) return "pending";
  if (!m || m.status === "unknown") return "offline";
  if (s.status === "online") return "online";
  return "alert";
}

function StatusBadge({ category, metric }) {
  if (category === "pending") return <span className="badge badge-idle">未关联探针</span>;
  if (category === "offline") return <span className="badge badge-bad">探针离线</span>;
  if (category === "online") return <span className="badge badge-ok">探针在线</span>;
  return <span className="badge badge-warn">{metric?.status === "stale" ? "数据已过期" : (metric?.error ? "采集异常" : "待留意")}</span>;
}

function ConnectBadge({ server }) {
  if (server.agent) return <span className="badge badge-ok">Agent</span>;
  if (server.komariUuid) return <span className="badge sv2-badge-komari">Komari 探针</span>;
  return <span className="badge badge-idle">未接入</span>;
}

function connectLabel(server) {
  if (server.agent) return "Agent";
  if (server.komariUuid) return "Komari 探针";
  return "未接入";
}

function heartbeatText(view, nowMs) {
  const m = view.metric;
  if (m?.updated) {
    const t = Date.parse(m.updated);
    if (Number.isFinite(t)) return `${Math.max(0, Math.round((nowMs - t) / 1000))} 秒前`;
    return stamp(m.updated);
  }
  if (view.server.lastSeen) return stamp(view.server.lastSeen);
  return "尚无";
}

function NodeBlocks({ items }) {
  if (!items.length) return <span className="muted">无节点</span>;
  const running = items.filter(i => i.state === "verified" || i.state === "ok").length;
  const shown = items.slice(0, MAX_NODE_BLOCKS);
  return (
    <div className="sv2-node-blocks" title={`节点运行 ${running}/${items.length}`}>
      <span className="sv2-blocks">
        {shown.map(i => (
          <i key={i.node.id} className={`sv2-block sv2-block-${i.state === "verified" || i.state === "ok" ? "ok" : i.state === "problem" ? "bad" : "idle"}`} title={i.node.name} />
        ))}
        {items.length > MAX_NODE_BLOCKS && <span className="sv2-more">+{items.length - MAX_NODE_BLOCKS}</span>}
      </span>
      <span className="sv2-node-run">{running}/{items.length}</span>
    </div>
  );
}

function ServerDetail({ view, data, onClose, onAction }) {
  const { server: s, metric } = view;
  const nodeItems = (data.nodes || []).filter(n => n.serverId === s.id).map(n => nodeHealthOf(data, n));
  const nodeRunning = nodeItems.filter(i => i.state === "verified" || i.state === "ok").length;
  const rows = [
    ["服务商", s.provider || "未记录"],
    ["公网地址", s.address || "未记录"],
    ["地区", s.region || "未记录"],
    ["用途", s.role || "代理节点"],
    ["接入方式", connectLabel(s)],
    ["节点", `${view.nodeCount} 个（${nodeRunning} 个运行中，${view.enabledNodes} 个参与订阅）`],
    ["3x-ui 面板", view.panelLinked ? (view.panelOk ? "已连接" : "连接异常") : "未接入"],
    ["订阅累计流量", bytes(view.subUsedBytes)],
    ["整机累计流量", metric ? `↑ ${bytes(metric.totalUp)} · ↓ ${bytes(metric.totalDown)}` : "暂无数据"],
    ["已用流量", metric?.trafficLimit > 0 && metric.trafficUsed != null ? `${bytes(metric.trafficUsed)} / ${bytes(metric.trafficLimit)}` : "暂无额度数据"],
    ["最近心跳", metric?.updated ? stamp(metric.updated) : (s.lastSeen ? stamp(s.lastSeen) : "尚无")],
    ["备注", s.note || "—"]
  ];
  return (
    <Modal title={s.name} kicker="SERVER DETAILS" onClose={onClose}>
      <dl className="detail-list">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {s.komariUuid && data.komari?.url && (
        <a className="btn btn-block" href={`${data.komari.url}/instance/${encodeURIComponent(s.komariUuid)}`} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={15} />在 Komari 查看监控详情
        </a>
      )}
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => onAction("edit", s)}><Pencil size={15} />编辑</button>
        <button type="button" className="btn" onClick={() => onAction("komari", s)}><Link2 size={15} />关联 Komari</button>
        <button type="button" className="btn" onClick={() => onAction("panel", s)}><ServerIcon size={15} />{view.panelLinked ? "更新面板" : "接入面板"}</button>
        <button type="button" className="icon-btn danger-icon" title="删除服务器记录" aria-label="删除服务器记录" onClick={() => onAction("delete", s)}><Trash2 size={16} /></button>
      </div>
    </Modal>
  );
}

export default function ServersPage({ data, search, onRefresh }) {
  const [filter, setFilter] = useState("all");
  const [detailId, setDetailId] = useState(null);
  const [action, setAction] = useState(null);
  const openAction = (kind, server) => { setDetailId(null); setAction({ kind, server }); };
  const saved = id => { setAction(null); if (id) setDetailId(id); onRefresh(); };
  const [nowMs, setNowMs] = useState(() => Date.now());

  /* 心跳秒数本地走字：每 5 秒只重渲染，不拉新数据。 */
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  /* 实时速率保鲜：页面可见时每 15 秒请壳子刷新一次 overview。 */
  useEffect(() => {
    if (typeof onRefresh !== "function") return undefined;
    const id = setInterval(() => { if (!document.hidden) onRefresh(); }, 15000);
    return () => clearInterval(id);
  }, [onRefresh]);

  const views = useMemo(() => data.servers.map(s => serverView(data, s)), [data]);
  const categories = useMemo(() => {
    const map = new Map();
    for (const v of views) map.set(v.server.id, categoryOf(v));
    return map;
  }, [views]);
  const counts = useMemo(() => {
    const c = { all: views.length, online: 0, alert: 0, offline: 0, pending: 0 };
    for (const v of views) c[categories.get(v.server.id)] += 1;
    return c;
  }, [views, categories]);

  const nodesByServer = useMemo(() => {
    const map = new Map();
    for (const n of data.nodes || []) {
      const item = nodeHealthOf(data, n);
      const arr = map.get(n.serverId);
      if (arr) arr.push(item); else map.set(n.serverId, [item]);
    }
    return map;
  }, [data]);

  /* 顶部实时汇总：速率只聚合在线机（后端对 stale 已把速率清零，这里再按
     server.status 兜一层）；本月流量来自后端 trafficDaily 日统计，当月无
     行时返回 null 降级显示「日统计累积中」。 */
  const live = useMemo(() => {
    let up = 0, down = 0;
    for (const v of views) {
      if (!v.online || !v.metric) continue;
      up += Number(v.metric.up || 0);
      down += Number(v.metric.down || 0);
    }
    return { up, down };
  }, [views]);
  const monthKey = useMemo(
    () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date()),
    []
  );
  const monthlyBytes = useMemo(() => {
    const rows = data.trafficDaily;
    if (!Array.isArray(rows)) return null;
    let total = 0, found = false;
    for (const r of rows) {
      if (r && typeof r.date === "string" && r.date.startsWith(monthKey)) {
        total += Number(r.up || 0) + Number(r.down || 0);
        found = true;
      }
    }
    return found ? total : null;
  }, [data.trafficDaily, monthKey]);
  const nodeStats = useMemo(() => {
    const all = data.nodes || [];
    let running = 0;
    for (const n of all) {
      if (!n.enabled) continue;
      const st = nodeHealthOf(data, n).state;
      if (st === "verified" || st === "ok") running += 1;
    }
    return { running, total: all.length };
  }, [data]);

  const q = (search || "").trim().toLowerCase();
  const list = views.filter(v => {
    const s = v.server;
    if (filter !== "all" && categories.get(s.id) !== filter) return false;
    if (!q) return true;
    return `${s.name} ${s.region} ${s.provider} ${s.address}`.toLowerCase().includes(q);
  });
  const detail = views.find(v => v.server.id === detailId) || null;

  return (
    <div className="page management-page servers-page tone-cyan">
      <PageHeading icon={ServerIcon} title="服务器">
          <button type="button" className="btn" onClick={onRefresh}><RefreshCw size={15} />刷新记录</button>
          <button type="button" className="btn btn-primary" onClick={() => openAction("edit", null)}><Plus size={15} />添加服务器</button>
      </PageHeading>

      <Glass className="ribbon sv2-live">
        <SummaryStat icon={Activity} label="实时速率" tone="cyan"><span className="summary-rate"><span>↑ {rate(live.up)}</span><span>↓ {rate(live.down)}</span></span></SummaryStat>
        <SummaryStat icon={Database} label="本月总流量" tone="blue">
          {monthlyBytes !== null
            ? bytes(monthlyBytes)
            : <span className="sv2-live-pending">日统计累积中</span>}
        </SummaryStat>
        <SummaryStat icon={Waypoints} label="节点" tone="purple">{nodeStats.running}/{nodeStats.total} <small>运行中</small></SummaryStat>
      </Glass>

      <Glass className="list-panel">
        <div className="list-toolbar">
          <div className="segmented" role="group" aria-label="状态筛选">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>
                {label}<span className="sv2-chip-count">{counts[key]}</span>
              </button>
            ))}
          </div>
          <span className="toolbar-hint">{list.length} 台</span>
        </div>

        {list.length === 0
          ? <div className="empty-state"><ServerIcon size={26} /><h3>{views.length ? "没有匹配的记录" : "还没有服务器记录"}</h3>
              <p>{views.length ? "试试其他关键词或调整筛选条件。" : "添加 VPS，接入 3x-ui 管理订阅，并关联现有 Komari 探针。"}</p></div>
          : <div className="table-wrap"><table className="srv-table sv2-table">
              <thead><tr>
                <th>服务器</th><th>状态</th><th>接入</th><th className="col-meter">指标</th><th>整机流量</th><th>订阅流量</th><th>节点</th><th>心跳</th><th aria-label="操作" />
              </tr></thead>
              <tbody>
                {list.map(v => {
                  const s = v.server;
                  const m = metricOf(data, s);
                  const category = categories.get(s.id);
                  const nodeItems = nodesByServer.get(s.id) || [];
                  return (
                    <tr key={s.id} className="click-row" onClick={() => setDetailId(s.id)}>
                      <td className="row-name"><div className="srv-cell">
                        <span className="srv-flag">{v.flag}</span>
                        <div><strong>{s.name}</strong><small>{s.provider || "服务商未记录"} · {s.address || "地址未记录"}</small></div>
                      </div></td>
                      <td data-label="状态"><StatusBadge category={category} metric={m} /></td>
                      <td data-label="接入"><ConnectBadge server={s} /></td>
                      <td className="col-meter"><div className="mini-meters">
                        <SegMeter kind="cpu" value={m?.cpu} />
                        <SegMeter kind="memory" value={m?.memory} />
                        <SegMeter kind="disk" value={m?.disk} />
                      </div></td>
                      <td className="row-wide" data-label="整机流量">{m
                        ? (v.online
                          ? <div className="traffic-cell"><strong>↑ {rate(m.up)} · ↓ {rate(m.down)}</strong><small>累计 ↑ {bytes(m.totalUp)} · ↓ {bytes(m.totalDown)}</small></div>
                          : <div className="traffic-cell"><strong>↑ {bytes(m.totalUp)} · ↓ {bytes(m.totalDown)}</strong><small>探针未在线，显示累计值</small></div>)
                        : <span className="muted">暂无数据</span>}</td>
                      <td data-label="订阅累计"><div className="traffic-cell"><strong>{bytes(v.subUsedBytes)}</strong></div></td>
                      <td data-label="节点"><NodeBlocks items={nodeItems} /></td>
                      <td data-label="心跳"><span className="sv2-heartbeat">{heartbeatText(v, nowMs)}</span></td>
                      <td className="row-actions"><div className="nd-row-actions" onClick={e => e.stopPropagation()}>
                        <button type="button" className="icon-btn" title="编辑服务器" aria-label={`编辑 ${s.name}`} onClick={() => openAction("edit", s)}><Pencil size={16} /></button>
                        <button type="button" className="icon-btn" title="关联 Komari" aria-label={`关联 ${s.name} 的 Komari`} onClick={() => openAction("komari", s)}><Link2 size={16} /></button>
                        <button type="button" className="btn btn-small" onClick={() => setDetailId(s.id)}>详情</button>
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>}
      </Glass>

      {detail && <ServerDetail view={detail} data={data} onClose={() => setDetailId(null)} onAction={openAction} />}
      {action?.kind === "edit" && <ServerEditor server={action.server} onClose={() => setAction(null)} onSaved={saved} />}
      {action?.kind === "komari" && <KomariBinding server={action.server} data={data} onClose={() => setAction(null)} onSaved={() => saved(action.server.id)} />}
      {action?.kind === "panel" && <PanelEditor server={action.server} panel={data.panels.find(p => p.serverId === action.server.id)} onClose={() => setAction(null)} onSaved={() => saved(action.server.id)} />}
      {action?.kind === "delete" && <DeleteServer server={action.server} onClose={() => setAction(null)} onSaved={() => saved()} />}
    </div>
  );
}
