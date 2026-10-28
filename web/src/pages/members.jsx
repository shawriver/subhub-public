import React, { useEffect, useMemo, useState } from "react";
import { Activity, History, Layers, Link2, Pencil, Plus, RefreshCw, Smartphone, TriangleAlert, Trash2, Unlink, UserCheck, Users } from "lucide-react";
import { Glass, Modal, PageHeading, RATIO_GRADIENTS, SummaryStat, TagPill, ThickBar } from "../ui.jsx";
import { dateOnly, daysUntil, gbAsBytes, stamp } from "../format.js";
import { deleteRecord, getDevices, getFetches, newRecordId, revokeSubscription, saveRecord } from "../api.js";
import { ConfirmDialog, IssueDialog, ProfileForm, useSubscriptionLinks } from "./subscriptions.jsx";

/* Members page (M2 rewrite, spec items 1 & 4): member cards with the
   derived device estimate + fetch-anomaly marks, a detail modal with the
   devices view and the fetch audit list, and the create/edit form.
   Derived view fields (devicesUsed / connectionLimit / connectionLimitSource /
   hasAnomaly / anomalyRules / anomalySummary / quotaUsed) are computed by the
   backend on read and must never be sent back on save. */

const DERIVED_FIELDS = ["devicesUsed", "deviceOverLimit", "hasAnomaly", "anomalyRules", "anomalySummary", "quotaUsed", "connectionLimit", "connectionLimitSource"];

function cleanMemberBody(member, overrides = {}) {
  const body = { ...member, ...overrides };
  for (const key of DERIVED_FIELDS) delete body[key];
  return body;
}

/* Allowance boundaries are Beijing dates, even when stored as UTC. */
function rfcDateText(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? stamp(value)
    : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium" }).format(d);
}

function expiryInfo(member) {
  if (!member.expires) return { text: "无到期期限", soon: false };
  const days = daysUntil(member.expires);
  if (days === null) return { text: dateOnly(member.expires), soon: false };
  const tail = days < 0 ? `已过期 ${-days} 天` : days === 0 ? "今天到期" : `剩 ${days} 天`;
  return { text: `${dateOnly(member.expires)} · ${tail}`, soon: days <= 7 };
}

function resetText(member) {
  if (!member.resetDay || member.resetDay <= 0) return "累计额度不重置";
  return `每月 ${member.resetDay} 日重置 · 下次 ${rfcDateText(member.cycleEnd)}`;
}

function quotaText(member) {
  const used = gbAsBytes(member.quotaUsed);
  return member.limit > 0 ? `本周期 ${used} / ${gbAsBytes(member.limit)}` : `本周期 ${used} · 不限额`;
}

function connectionText(member) {
  if (!(member.connectionLimit > 0)) return "不限";
  return `${member.connectionLimit} 条 · ${member.connectionLimitSource === "override" ? "用户覆盖" : "订阅默认"}`;
}

function quotaBar(member) {
  if (!member.limit || member.limit <= 0) return { value: 100, tone: "blue" };
  const ratio = (Number(member.quotaUsed) || 0) / member.limit * 100;
  return { value: ratio, tone: ratio >= 90 ? "amber" : "green" };
}

function truncate(text, max = 72) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function EnableSwitch({ member, busy, onToggle }) {
  return (
    <button type="button" className={`mb-switch ${member.enabled ? "on" : ""}`} role="switch" aria-checked={!!member.enabled}
      aria-label={`${member.enabled ? "停用" : "启用"}用户 ${member.name}`} disabled={busy}
      onClick={e => { e.stopPropagation(); onToggle(member); }}>
      <span className="mb-switch-knob" />
    </button>
  );
}

function MemberCard({ member, busy, profileCount, onOpen, onLinks, onToggle }) {
  const expiry = expiryInfo(member);
  const bar = quotaBar(member);
  return (
    <article className={`glass machine mb-card ${!member.enabled ? "mb-card-disabled" : ""}`} onClick={onOpen}
      role="button" tabIndex={0} onKeyDown={e => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(); }
      }} aria-label={`用户 ${member.name}`}>
      <div className="m-head">
        <span className="avatar" aria-hidden="true">{String(member.name || "?").trim().charAt(0).toUpperCase() || "?"}</span>
        <span className="m-name">{member.name}</span>
        <span className="m-head-right">
          {member.enabled ? <span className="badge badge-ok">启用中</span> : <span className="badge badge-idle">已停用</span>}
        </span>
      </div>
      {member.email && <p className="mb-email">{member.email}</p>}

      <div className="m-tags">
        {member.connectionLimit > 0 && <TagPill tone="purple">并发 ≤ {member.connectionLimit}</TagPill>}
        {member.hasAnomaly && <TagPill tone="amber">拉取异常</TagPill>}
        {(member.subscriptionIds || []).length > 0 && <TagPill tone="gray">{member.subscriptionIds.length} 个订阅</TagPill>}
        <TagPill tone="gray">{(member.nodeIds || []).length} 个节点</TagPill>
      </div>

      <div className="mb-quota">
        <div className="mb-quota-row"><span>流量额度</span><strong>{quotaText(member)}</strong></div>
        <ThickBar value={bar.value} color={bar.tone === "amber" ? RATIO_GRADIENTS.amber : bar.tone === "blue" ? RATIO_GRADIENTS.blue : RATIO_GRADIENTS.green} />
      </div>

      <div className="mb-meta">
        <div className="mb-meta-line"><span>并发上限</span><strong>{connectionText(member)}</strong></div>
        <div className="mb-meta-line"><span>客户端估算</span><strong>{member.devicesUsed || 0} 种已识别</strong></div>
        <div className="mb-meta-line"><span>到期</span><strong className={expiry.soon ? "expire-soon" : ""}>{expiry.text}</strong></div>
        <div className="mb-meta-line"><span>重置</span><strong>{resetText(member)}</strong></div>
        {member.hasAnomaly && member.anomalySummary && <p className="mb-anomaly-text">拉取异常：{member.anomalySummary}</p>}
      </div>

      <div className="m-foot">
        <button type="button" className="btn btn-small mb-links-button" onClick={e => { e.stopPropagation(); onLinks(); }}>
          <Link2 size={14} />个人订阅<span className="mb-profile-count">{profileCount}</span>
        </button>
        <span className="mb-card-switch"><span className="mb-toggle-label">{member.enabled ? "已启用" : "已停用"}</span>
          <EnableSwitch member={member} busy={busy} onToggle={onToggle} /></span>
      </div>
    </article>
  );
}

function DevicesSection({ member }) {
  const [state, setState] = useState({ loading: true, error: "", data: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: "", data: null });
    getDevices(member.id)
      .then(data => { if (alive) setState({ loading: false, error: "", data }); })
      .catch(e => { if (alive) setState({ loading: false, error: e.message || "客户端估算加载失败", data: null }); });
    return () => { alive = false; };
  }, [member.id]);

  const d = state.data;
  return (
    <section className="mb-section">
      <h3 className="mb-section-title"><Smartphone size={16} />客户端估算</h3>
      {state.loading && <p className="muted">正在加载客户端估算…</p>}
      {state.error && <p className="form-error">{state.error}</p>}
      {d && (
        <>
          <div className="mb-gauge-row">
            <span className="mb-gauge">{d.devicesUsed}</span>
            <span className="mb-gauge-unit">种可识别客户端</span>
            <span className="mb-gauge-note">审计估算，不作为设备身份或连接上限</span>
          </div>
          <p className="mb-window">统计窗口：{stamp(d.from)} → {stamp(d.to)}</p>
          {(!d.groups || d.groups.length === 0)
            ? <p className="muted">统计窗口内暂无可识别的订阅客户端拉取记录。</p>
            : <div className="table-wrap"><table className="mb-table">
                <thead><tr><th>订阅客户端</th><th>来源 IP 数</th><th>拉取次数</th><th>最近拉取</th></tr></thead>
                <tbody>
                  {d.groups.map((g, i) => (
                    <tr key={`${g.client || "client"}-${i}`}>
                      <td>
                        <div className="mb-client-cell">
                          <strong>{g.client || "未知订阅客户端"}</strong>
                          <span className="mb-client-ua" title={g.userAgent || ""}>{truncate(g.userAgent, 54) || "无客户端标识"}</span>
                        </div>
                      </td>
                      <td className="mb-nowrap">{g.sourceIpCount || 0} 个<span className="mb-inline-hint"> · 不参与设备或连接计数</span></td>
                      <td>{g.fetches}</td>
                      <td>{stamp(g.lastAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>}
          <p className="mb-note">这里只按可识别的订阅客户端种类做审计估算。浏览器预览、空客户端标识和代理出口 IP 变化都不计数；两台设备使用同一个客户端也会合并。它不能证明真实设备数量，也不参与并发连接限制。</p>
        </>
      )}
    </section>
  );
}

function FetchesSection({ member }) {
  const [state, setState] = useState({ loading: true, error: "", rows: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: "", rows: null });
    getFetches(member.id)
      .then(rows => { if (alive) setState({ loading: false, error: "", rows: Array.isArray(rows) ? rows : [] }); })
      .catch(e => { if (alive) setState({ loading: false, error: e.message || "拉取记录加载失败", rows: null }); });
    return () => { alive = false; };
  }, [member.id]);

  return (
    <section className="mb-section">
      <h3 className="mb-section-title"><History size={16} />拉取记录</h3>
      {state.loading && <p className="muted">正在加载拉取记录…</p>}
      {state.error && <p className="form-error">{state.error}</p>}
      {state.rows && (state.rows.length === 0
        ? <p className="muted">最近暂无拉取记录。用户用订阅链接拉取配置后，这里会留下时间、IP 与客户端记录。</p>
        : <>
            <div className="table-wrap"><table className="mb-table">
              <thead><tr><th>时间</th><th>IP</th><th>客户端</th><th>格式</th><th>状态</th><th>标记</th></tr></thead>
              <tbody>
                {state.rows.map((f, i) => {
                  const flags = Array.isArray(f.flags) ? f.flags : [];
                  return (
                    <tr key={`${f.at}-${f.ip}-${i}`} className={flags.length ? "mb-row-flagged" : ""}>
                      <td className="mb-nowrap">{stamp(f.at)}</td>
                      <td className="mb-mono">{f.ip || "—"}</td>
                      <td><span className="mb-ua" title={f.userAgent || ""}>{truncate(f.userAgent) || "未知客户端"}</span></td>
                      <td>{f.format || "—"}</td>
                      <td>{f.status >= 200 && f.status < 300
                        ? <span className="badge badge-ok">{f.status}</span>
                        : <span className="badge badge-bad">{f.status || "—"}</span>}</td>
                      <td><span className="mb-flag-cell">
                        {flags.includes("high_freq") && <span className="badge badge-warn">高频拉取</span>}
                      </span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
            <p className="mb-note">显示最近 30 天内最多 100 条记录；带标记的行表示可识别订阅客户端在任意滚动 1 小时内成功拉取至少 10 次。浏览器预览、IP 变化和失败请求不计入异常。</p>
          </>)}
    </section>
  );
}

const REVOKE_REASON_TEXT = {
  quota: "因超额被禁用",
  expired: "因到期被禁用",
  manual: "被管理员停用",
  lease: "租约到期失效"
};

/* Most recent grant revocation for this member, across all of their
   grants (backend gap G2/G6 fix): the reason, when it happened, and the
   numbers it was decided on. Once restored it stays as history — the
   backend never clears lastRevocation, lastRestore only adds a stamp. */
function RevocationSection({ member, data }) {
  const grants = (data.grants || []).filter(g => g.memberId === member.id);
  let latest = null;
  for (const g of grants) {
    if (g.lastRevocation && (!latest || g.lastRevocation.at > latest.lastRevocation.at)) latest = g;
  }
  if (!latest) return null;
  const rev = latest.lastRevocation;
  const restored = latest.lastRestore && latest.lastRestore.at > rev.at;
  const stillRevoked = grants.some(g => g.state === "revoked");
  const nodeName = (data.nodes || []).find(n => n.id === latest.nodeId)?.name || latest.nodeId;
  const reasonText = REVOKE_REASON_TEXT[rev.reason] || "被禁用";
  const snapshot = rev.limit > 0
    ? `已用 ${gbAsBytes(rev.used)} / 额度 ${gbAsBytes(rev.limit)}`
    : `已用 ${gbAsBytes(rev.used)} / 不限额`;
  return (
    <section className="mb-section">
      <h3 className="mb-section-title"><History size={16} />授权撤销记录</h3>
      <p className="mb-note">
        <span className={`badge ${stillRevoked && !restored ? "badge-bad" : "badge-ok"}`}>
          {stillRevoked && !restored ? "当前已禁用" : "历史记录"}
        </span>{" "}
        最近一次：{reasonText} · {stamp(rev.at)} · {snapshot}
        {rev.expires ? ` · 到期日 ${dateOnly(rev.expires)}` : ""} · 节点 {nodeName}
        {restored ? ` · 已于 ${stamp(latest.lastRestore.at)} 恢复` : ""}
      </p>
    </section>
  );
}

function MemberDetail({ member, data, onClose, onEdit, onLinks, onRefresh }) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const expiry = expiryInfo(member);
  const profiles = (data.profiles || []).filter(p => p.memberId === member.id);
  const subNames = (member.subscriptionIds || []).map(id => (data.subscriptions || []).find(s => s.id === id)?.name || id);
  const nodeNames = (member.nodeIds || []).map(id => (data.nodes || []).find(n => n.id === id)?.name || id);

  const rows = [
    ["状态", member.enabled ? "启用中" : "已停用"],
    ["邮箱", member.email || "未填写"],
    ["备注", member.note || "—"],
    ["累计用量", gbAsBytes(member.used)],
    ["本周期用量", gbAsBytes(member.quotaUsed)],
    ["流量额度", member.limit > 0 ? gbAsBytes(member.limit) : "不限额"],
    ["本周期窗口", member.cycleStart || member.cycleEnd ? `${stamp(member.cycleStart)} → ${stamp(member.cycleEnd)}` : "无周期（累计额度）"],
    ["下次重置日", member.resetDay > 0 ? rfcDateText(member.cycleEnd) : "不重置"],
    ["到期日", expiry.text],
    ["并发连接上限", connectionText(member)],
    ["客户端估算", `${member.devicesUsed || 0} 种可识别客户端（仅审计）`]
  ];

  const doDelete = async () => {
    if (!confirming) { setConfirming(true); return; }
    setDeleting(true); setError("");
    try {
      await deleteRecord("member", member.id);
      onClose();
      onRefresh();
    } catch (e) {
      setError(e.message || "删除失败，请稍后重试");
      setDeleting(false);
      setConfirming(false);
    }
  };

  return (
    <div className="mb-wide-wrap">
      <Modal title={member.name} kicker="MEMBER DETAILS" onClose={onClose}>
        <div className="mb-link-summary">
          <div><strong>个人订阅</strong><p>{profiles.length} 份订阅 · {(member.nodeIds || []).length} 个已分配节点</p></div>
          <button type="button" className="btn btn-primary" onClick={onLinks}><Link2 size={15} />管理订阅链接</button>
        </div>
        <dl className="detail-list">
          {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>

        <RevocationSection member={member} data={data} />
        <DevicesSection member={member} />
        <FetchesSection member={member} />

        <section className="mb-section">
          <h3 className="mb-section-title"><Layers size={16} />订阅与节点</h3>
          <dl className="detail-list">
            <div><dt>分配订阅</dt><dd>{subNames.length ? subNames.join("、") : "未分配"}</dd></div>
            <div><dt>个人订阅</dt><dd>{profiles.length
              ? profiles.map(p => `${p.name || p.id}（${p.format || "—"}）`).join("、")
              : "暂无"}</dd></div>
            <div><dt>分配节点</dt><dd>{(member.nodeIds || []).length} 个{nodeNames.length ? `：${truncate(nodeNames.join("、"), 120)}` : ""}</dd></div>
          </dl>
        </section>

        {error && <p className="form-error mb-detail-error" role="alert">{error}</p>}
        <div className="mb-detail-actions">
          <button type="button" className="btn btn-primary" onClick={() => onEdit(member)}><Pencil size={15} />编辑用户</button>
          <button type="button" className={`btn ${confirming ? "mb-btn-danger" : ""}`} onClick={doDelete} disabled={deleting}>
            <Trash2 size={15} />{deleting ? "删除中…" : confirming ? "确认删除？再次点击将删除该用户" : "删除用户"}
          </button>
          {confirming && !deleting && <button type="button" className="btn" onClick={() => setConfirming(false)}>取消</button>}
        </div>
        {confirming && <p className="mb-note">删除后该用户的订阅档案与访问链接会一并失效，此操作不可恢复。若后端提示仍有授权未撤销，请先停用用户，等待授权撤销成功后再删除。</p>}
      </Modal>
    </div>
  );
}

function MemberLinks({ member, data, onClose, onCreate, onCustomize, onEdit, onIssue, onRevoke, onDelete, onAllocate }) {
  const profiles = (data.profiles || []).filter(p => p.memberId === member.id);
  const collections = (data.subscriptions || []).filter(s => (member.subscriptionIds || []).includes(s.id));
  return (
    <Modal title={`${member.name} · 个人订阅`} kicker="PERSONAL SUBSCRIPTIONS" onClose={onClose}>
      <div className="sb-wide" />
      <div className="mb-allocation">
        <span className="mb-allocation-icon"><Layers size={20} /></span>
        <div><strong>{collections.length ? collections.map(s => s.name).join("、") : "单独分配节点"}</strong>
          <p>{(member.nodeIds || []).length} 个节点 · {member.enabled ? "用户已启用" : "用户已停用"}</p></div>
        <button type="button" className="btn btn-small" onClick={onAllocate}>调整分配</button>
      </div>
      <p className="mb-note">个人订阅链接只属于 {member.name}，使用此用户的额度与到期设置。</p>
      <div className="mb-section-heading"><h3>订阅链接</h3>
        <div className="mb-link-create-actions">
          <button type="button" className="btn btn-small" onClick={onCustomize}><Pencil size={14} />定制订阅</button>
          <button type="button" className="btn btn-primary btn-small" onClick={onCreate}><Plus size={14} />新建个人订阅</button>
        </div>
      </div>
      {profiles.length === 0
        ? <div className="empty-state mb-links-empty"><Link2 size={26} /><h3>还没有个人订阅</h3>
            <p>{(member.nodeIds || []).length ? "创建个人订阅使用已分配节点，或单独定制需要的节点。" : "分配订阅或定制节点后，生成专属链接。"}</p></div>
        : <div className="mb-profile-list">{profiles.map(p => (
          <article key={p.id} className="mb-profile-row">
            <span className="mb-profile-icon"><Link2 size={18} /></span>
            <div className="mb-profile-info"><strong>{p.name}</strong>
              <p>{p.format === "clash" ? "Clash" : p.format === "v2ray" ? "V2Ray" : "Base64"} · {p.customNodes ? "定制节点" : "个人订阅"} · {p.followMemberNodes ? `跟随分配 · ${(member.allocationNodeIds ?? member.nodeIds ?? []).length} 个节点` : `${(p.nodeIds || []).length} 个节点`}</p>
            </div>
            <div className="mb-profile-actions">
              <button type="button" className="btn btn-small" onClick={() => onIssue(p)}><Link2 size={13} />生成链接</button>
              <button type="button" className="icon-btn" aria-label={`编辑 ${p.name}`} title="编辑个人订阅" onClick={() => onEdit(p)}><Pencil size={15} /></button>
              <button type="button" className="icon-btn" aria-label={`撤销 ${p.name} 的链接`} title="撤销链接" onClick={() => onRevoke(p)}><Unlink size={15} /></button>
              <button type="button" className="icon-btn" aria-label={`删除 ${p.name}`} title="删除订阅" onClick={() => onDelete(p)}><Trash2 size={15} /></button>
            </div>
          </article>
        ))}</div>}
    </Modal>
  );
}

function MemberForm({ member, data, onClose, onSaved }) {
  const editing = !!member;
  const [name, setName] = useState(member?.name || "");
  const [email, setEmail] = useState(member?.email || "");
  const [enabled, setEnabled] = useState(member ? !!member.enabled : true);
  const [expires, setExpires] = useState(member?.expires || "");
  const [limit, setLimit] = useState(member ? String(member.limit ?? 0) : "0");
  const [used, setUsed] = useState(member ? String(member.used ?? 0) : "0");
  const [resetDay, setResetDay] = useState(member ? String(member.resetDay ?? 0) : "0");
  const [connectionOverride, setConnectionOverride] = useState(member?.connectionLimitOverride != null);
  const [connectionLimit, setConnectionLimit] = useState(String(member?.connectionLimitOverride ?? member?.connectionLimit ?? 0));
  const [note, setNote] = useState(member?.note || "");
  const [subscriptionIds, setSubscriptionIds] = useState(member?.subscriptionIds || []);
  const [assignmentMode, setAssignmentMode] = useState(member?.assignmentMode || (member?.subscriptionIds != null || !member ? "subscriptions" : "nodes"));
  const [nodeIds, setNodeIds] = useState(member?.allocationNodeIds ?? member?.nodeIds ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const inheritedConnection = useMemo(() => {
    const selected = (data.subscriptions || []).filter(s => subscriptionIds.includes(s.id));
    if (selected.length === 0) return { limit: 0, label: "未分配订阅，默认不限" };
    if (selected.some(s => !(s.connectionLimit > 0))) return { limit: 0, label: "分配的订阅中有不限值，合并后不限" };
    const limit = Math.max(...selected.map(s => s.connectionLimit));
    return { limit, label: `跟随订阅默认，当前 ${limit} 条` };
  }, [data.subscriptions, subscriptionIds]);

  const nodeGroups = useMemo(() => {
    const groups = new Map();
    for (const node of data.nodes || []) {
      const key = node.serverId || "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(node);
    }
    return [...groups.entries()].map(([serverId, nodes]) => ({
      serverId,
      serverName: (data.servers || []).find(s => s.id === serverId)?.name || "未关联服务器",
      nodes
    }));
  }, [data]);

  const toggleId = (list, setList, id) =>
    setList(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);

  const submit = async e => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) { setError("用户名不能为空"); return; }
    const limitNum = Number(limit);
    const usedNum = Number(used);
    if (!Number.isFinite(limitNum) || !Number.isFinite(usedNum) || limitNum < 0 || usedNum < 0) {
      setError("用量和额度必须是有效的非负数"); return;
    }
    const resetNum = Number(resetDay);
    if (!Number.isInteger(resetNum) || resetNum < 0 || resetNum > 31) {
      setError("流量重置日必须是 0–31 的整数，0 表示累计额度不按月重置"); return;
    }
    const connectionNum = Number(connectionLimit);
    if (connectionOverride && (!Number.isInteger(connectionNum) || connectionNum < 0 || connectionNum > 10000)) {
      setError("并发连接上限必须是 0–10000 之间的整数，0 表示不限制"); return;
    }
    const fields = {
      name: trimmedName, email: email.trim(), enabled, expires,
      limit: limitNum, used: usedNum, resetDay: resetNum,
      connectionLimitOverride: connectionOverride ? connectionNum : null,
      note, assignmentMode, subscriptionIds: assignmentMode === "subscriptions" ? [...subscriptionIds] : null,
      nodeIds: [...nodeIds], allocationNodeIds: assignmentMode === "nodes" ? [...nodeIds] : null
    };
    setSaving(true); setError("");
    try {
      if (editing) {
        await saveRecord("member", member.id, cleanMemberBody(member, fields));
      } else {
        const id = newRecordId();
        await saveRecord("member", id, { id, ...fields, groupId: "", provision: "", cycleBase: 0 });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err.message || "保存失败，请稍后重试");
      setSaving(false);
    }
  };

  return (
    <div className="mb-form-wrap">
      <Modal title={editing ? "编辑用户" : "新建用户"} kicker="MEMBER" onClose={onClose}>
        <form onSubmit={submit}>
          <div className="field-grid">
            <label className="field"><span>姓名</span>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="例如：小明" autoFocus />
            </label>
            <label className="field"><span>邮箱</span>
              <input type="text" value={email} onChange={e => setEmail(e.target.value)} placeholder="可选，用于识别用户" />
            </label>
          </div>

          <div className="field-grid">
            <label className="field"><span>到期日期（可空）</span>
              <input className="mb-input" type="date" value={expires} onChange={e => setExpires(e.target.value)} />
              <small>留空表示无到期期限。</small>
            </label>
            <label className="field"><span>启用状态</span>
              <span className="mb-form-switch-row">
                <button type="button" className={`mb-switch ${enabled ? "on" : ""}`} role="switch" aria-checked={enabled}
                  aria-label="启用该用户" onClick={() => setEnabled(v => !v)}><span className="mb-switch-knob" /></button>
                <span className="mb-toggle-label">{enabled ? "启用中" : "已停用"}</span>
              </span>
              <small>停用后该用户的订阅链接立即不可用。</small>
            </label>
          </div>

          <div className="field-grid">
            <label className="field"><span>流量额度（GB，0 = 不限）</span>
              <input className="mb-input" type="number" min="0" step="any" value={limit} onChange={e => setLimit(e.target.value)} />
            </label>
            <label className="field"><span>累计用量（GB）</span>
              <input className="mb-input" type="number" min="0" step="any" value={used} readOnly={editing} onChange={e => setUsed(e.target.value)} />
              {editing && <small>由节点流量统计更新。</small>}
            </label>
            <label className="field"><span>每月重置日（0–31）</span>
              <input className="mb-input" type="number" min="0" max="31" step="1" value={resetDay} onChange={e => setResetDay(e.target.value)} />
              <small>0 表示累计额度不按月重置；填 1–31 表示每月该日重置本周期用量。</small>
            </label>
          </div>

          <div className="field mb-connection-policy">
            <span>并发连接上限</span>
            <label className="mb-override-row">
              <input type="checkbox" checked={connectionOverride} onChange={e => {
                if (!connectionOverride) setConnectionLimit(String(inheritedConnection.limit));
                setConnectionOverride(e.target.checked);
              }} />
              <span><strong>为此用户单独覆盖</strong><small>{connectionOverride ? "用户设置优先于所有订阅默认值。" : inheritedConnection.label}</small></span>
            </label>
            {connectionOverride && <input className="mb-input" type="number" min="0" max="10000" step="1" value={connectionLimit}
              onChange={e => setConnectionLimit(e.target.value)} aria-label="用户并发连接上限" />}
            <small>0 表示不限；多个订阅合并时取最宽松值。该值作为订阅分享策略记录，当前 3x-ui 不提供通用的每用户 TCP 并发计数接口，机场订阅也无法由 SubHub 控制。</small>
          </div>

          <label className="field"><span>备注</span>
            <textarea className="mb-input" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="可选，内部备注" />
          </label>

          <div className="field">
            <span>节点分配方式</span>
            <div className="segmented mb-assignment" role="group" aria-label="节点分配方式">
              <button type="button" className={assignmentMode === "subscriptions" ? "active" : ""} aria-pressed={assignmentMode === "subscriptions"} onClick={() => setAssignmentMode("subscriptions")}>订阅</button>
              <button type="button" className={assignmentMode === "nodes" ? "active" : ""} aria-pressed={assignmentMode === "nodes"} onClick={() => setAssignmentMode("nodes")}>单独节点</button>
            </div>
          </div>
          {assignmentMode === "subscriptions" ? <div className="field">
            <span>选择订阅</span>
            {(data.subscriptions || []).length === 0
              ? <p className="muted">暂无订阅，可先到订阅页创建。</p>
              : <div className="mb-check-list">
                  {(data.subscriptions || []).map(s => (
                    <label key={s.id} className="mb-check-item">
                      <input type="checkbox" checked={subscriptionIds.includes(s.id)}
                        onChange={() => toggleId(subscriptionIds, setSubscriptionIds, s.id)} />
                      <span>{s.name}<small>{(s.nodeIds || []).length} 个节点</small></span>
                    </label>
                  ))}
                </div>}
            <small>分配的节点自动合并，后续订阅更新会同步给该用户。定制订阅独立保留。</small>
          </div> : <div className="field">
            <span>分配节点（按服务器分组）</span>
            {(data.nodes || []).length === 0
              ? <p className="muted">暂无节点，可先到节点页添加。</p>
              : nodeGroups.map(group => (
                  <div key={group.serverId || "none"} className="mb-check-group">
                    <p className="mb-check-group-title">{group.serverName}</p>
                    <div className="mb-check-list">
                      {group.nodes.map(n => (
                        <label key={n.id} className="mb-check-item">
                          <input type="checkbox" checked={nodeIds.includes(n.id)}
                            onChange={() => toggleId(nodeIds, setNodeIds, n.id)} />
                          <span>{n.name}<small>{n.protocol || ""}{n.enabled ? "" : " · 已停用"}</small></span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
          </div>}

          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="mb-form-actions">
            <button type="button" className="btn" onClick={onClose} disabled={saving}>取消</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? "保存中…" : editing ? "保存修改" : "创建用户"}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default function MembersPage({ data, search, onRefresh }) {
  const [detailId, setDetailId] = useState(null);
  const [formMember, setFormMember] = useState(null); // null + formOpen=false: closed; {member:null}: create
  const [formOpen, setFormOpen] = useState(false);
  const [togglingId, setTogglingId] = useState("");
  const [toggleError, setToggleError] = useState("");
  const [linksMemberId, setLinksMemberId] = useState(null);
  const [profileForm, setProfileForm] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [notice, setNotice] = useState("");
  const { issue, runIssue, closeIssue } = useSubscriptionLinks();

  const members = data.members || [];
  const counts = {
    total: members.length,
    enabled: members.filter(m => m.enabled).length,
    limited: members.filter(m => m.connectionLimit > 0).length,
    anomaly: members.filter(m => m.hasAnomaly).length
  };
  const q = (search || "").trim().toLowerCase();
  const list = members.filter(m => !q || `${m.name || ""} ${m.email || ""}`.toLowerCase().includes(q));
  const detail = members.find(m => m.id === detailId) || null;
  const linksMember = members.find(m => m.id === linksMemberId) || null;

  const openCreate = () => { setFormMember(null); setFormOpen(true); };
  const openEdit = member => { setDetailId(null); setFormMember(member); setFormOpen(true); };
  const openLinks = member => { setDetailId(null); setLinksMemberId(member.id); };
  const askRevoke = profile => setConfirm({
    title: "撤销订阅链接", message: `撤销「${profile.name}」后，现有链接立即失效。之后可重新生成。`,
    confirmLabel: "撤销链接", danger: true, onConfirm: async () => {
      await revokeSubscription(profile.id);
      setNotice(`已撤销「${profile.name}」的链接`);
    }
  });
  const askDeleteProfile = profile => setConfirm({
    title: "删除个人订阅", message: `删除「${profile.name}」后，链接失效。${profile.customNodes ? "此定制订阅独有的节点授权会移除，已分配订阅和其他定制订阅保留。" : "已分配订阅保留。"}`,
    confirmLabel: "删除订阅", danger: true, onConfirm: async () => {
      await deleteRecord("profile", profile.id);
      onRefresh();
      setNotice(`已删除「${profile.name}」`);
    }
  });

  const toggleEnabled = async member => {
    setTogglingId(member.id); setToggleError("");
    try {
      await saveRecord("member", member.id, cleanMemberBody(member, { enabled: !member.enabled }));
      onRefresh();
    } catch (e) {
      setToggleError(e.message || "切换启用状态失败，请稍后重试");
    } finally {
      setTogglingId("");
    }
  };

  return (
    <div className="page management-page members-page tone-pink">
      <PageHeading icon={Users} title="用户" description="管理个人订阅、流量额度、并发连接上限与到期设置">
          <button type="button" className="btn" onClick={onRefresh}><RefreshCw size={15} />刷新记录</button>
          <button type="button" className="btn btn-primary" onClick={openCreate}><Plus size={15} />新建用户</button>
      </PageHeading>

      <Glass className="ribbon">
        <SummaryStat icon={Users} label="用户总数" tone="pink">{counts.total}</SummaryStat>
        <SummaryStat icon={UserCheck} label="启用中" tone="green">{counts.enabled}</SummaryStat>
        <SummaryStat icon={Activity} label="有限连接" tone="amber">{counts.limited}</SummaryStat>
        <SummaryStat icon={TriangleAlert} label="拉取异常" tone="purple">{counts.anomaly}</SummaryStat>
      </Glass>

      {toggleError && <div className="notice-error" role="alert">{toggleError}</div>}
      {notice && <p className="sb-notice" role="status">{notice}</p>}

      {list.length === 0
        ? <Glass className="list-panel"><div className="empty-state"><Users size={26} />
            <h3>{members.length ? "没有匹配的用户" : "还没有用户"}</h3>
            <p>{members.length ? "试试其他姓名或邮箱关键词。" : "新建用户后分配订阅，或为其定制节点订阅。"}</p></div></Glass>
        : <section className="mb-grid">
            {list.map(m => (
              <MemberCard key={m.id} member={m} busy={togglingId === m.id} profileCount={(data.profiles || []).filter(p => p.memberId === m.id).length}
                onOpen={() => { setNotice(""); setDetailId(m.id); }} onLinks={() => { setNotice(""); openLinks(m); }} onToggle={toggleEnabled} />
            ))}
          </section>}

      {detail && (
        <MemberDetail member={detail} data={data} onClose={() => setDetailId(null)}
          onEdit={openEdit} onLinks={() => openLinks(detail)} onRefresh={onRefresh} />
      )}
      {linksMember && !profileForm && !issue && !confirm && !formOpen && (
        <MemberLinks member={linksMember} data={data} onClose={() => setLinksMemberId(null)}
          onCreate={() => setProfileForm({ initial: null, memberId: linksMember.id })}
          onCustomize={() => setProfileForm({ initial: null, memberId: linksMember.id, custom: true })}
          onEdit={p => setProfileForm({ initial: p, memberId: linksMember.id })}
          onIssue={runIssue} onRevoke={askRevoke} onDelete={askDeleteProfile} onAllocate={() => openEdit(linksMember)} />
      )}
      {profileForm && <ProfileForm data={data} initial={profileForm.initial} fixedMemberId={profileForm.memberId} custom={profileForm.custom}
        onClose={() => setProfileForm(null)} onSaved={onRefresh} />}
      {issue && <IssueDialog state={issue} onClose={closeIssue} onRotate={p => runIssue(p, true)} />}
      {confirm && <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />}
      {formOpen && (
        <MemberForm member={formMember} data={data}
          onClose={() => setFormOpen(false)} onSaved={onRefresh} />
      )}
    </div>
  );
}
