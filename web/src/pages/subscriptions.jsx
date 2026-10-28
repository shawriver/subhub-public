import React, { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  Activity, Check, Copy, Eye, FileText, Layers, Link2, Network, Pencil, Plus,
  RefreshCw, Save, Trash2, Unlink, Users, Waypoints
} from "lucide-react";
import { Glass, IconChip, Modal, PageHeading, SummaryStat, TagPill } from "../ui.jsx";
import { stamp } from "../format.js";
import {
  assignPackageMembers, deleteRecord, deleteRuleTemplate, issueSubscription, newRecordId,
  previewProfile, revokeSubscription, saveRecord, saveRuleTemplate
} from "../api.js";

/* Subscription formats: values are exactly the backend's supportedFormat
   set (records.go: "clash" | "v2ray" | "base64"). Do not add others —
   the API rejects anything else with 不支持的订阅格式. */
const FORMATS = [["clash", "Clash"], ["v2ray", "V2Ray"], ["base64", "Base64"]];
const FORMAT_TONES = { clash: "region", v2ray: "plan", base64: "gray" };

function formatLabel(value) {
  return (FORMATS.find(([key]) => key === value) || [value, value])[1];
}

function parseRules(text) {
  return String(text || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function rulesText(rules) {
  return (rules || []).join("\n");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function groupNodes(nodes, servers) {
  const groups = (servers || [])
    .map(s => ({ key: s.id, title: s.name, nodes: (nodes || []).filter(n => n.serverId === s.id) }))
    .filter(g => g.nodes.length > 0);
  const known = new Set((servers || []).map(s => s.id));
  const rest = (nodes || []).filter(n => !known.has(n.serverId));
  if (rest.length > 0) groups.push({ key: "__none", title: "未关联服务器", nodes: rest });
  return groups;
}

/* Node multi-select grouped by server. allowedIds (optional) restricts
   which nodes may be picked — profile nodes must belong to the member,
   the backend rejects anything else. */
function NodePicker({ nodes, servers, value, onChange, allowedIds = null, disabled = false, disabledNote = "" }) {
  const groups = useMemo(() => groupNodes(nodes, servers), [nodes, servers]);
  const selected = new Set(value || []);
  const allowed = allowedIds ? new Set(allowedIds) : null;
  const selectable = (nodes || []).filter(n => !allowed || allowed.has(n.id));
  const toggle = (id, on) => {
    const next = new Set(selected);
    if (on) next.add(id); else next.delete(id);
    onChange([...next]);
  };
  return (
    <div className="sb-node-picker">
      <div className="sb-node-picker-head">
        <span>已选 <strong>{selected.size}</strong> 个节点</span>
        {!disabled && selectable.length > 0 && (
          <span className="sb-node-picker-tools">
            <button type="button" onClick={() => onChange(selectable.map(n => n.id))}>选择全部节点</button>
            <button type="button" onClick={() => onChange([])}>清空</button>
          </span>
        )}
      </div>
      {disabled && disabledNote && <p className="sb-picker-note">{disabledNote}</p>}
      <div className="sb-node-list">
        {groups.length === 0 && <p className="muted">暂无可选节点。</p>}
        {groups.map(group => (
          <div key={group.key} className="sb-node-group">
            <p className="sb-node-group-title">{group.title}<span>{group.nodes.filter(n => selected.has(n.id)).length} / {group.nodes.length}</span></p>
            {group.nodes.map(node => {
              const blocked = allowed && !allowed.has(node.id);
              const off = disabled || blocked;
              return (
                <label key={node.id} className={`sb-node-row ${off ? "is-disabled" : ""}`}>
                  <input type="checkbox" checked={selected.has(node.id)} disabled={off}
                    onChange={e => toggle(node.id, e.target.checked)} />
                  <span className="sb-node-name">{node.name}</span>
                  <span className="proto">{node.protocol || "—"}</span>
                  {node.enabled === false && <span className="badge badge-idle">已停用</span>}
                  {blocked && <span className="badge badge-warn">未分配给该用户</span>}
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function ToggleRow({ label, hint, checked, onChange, disabled = false }) {
  return (
    <label className={`sb-toggle ${disabled ? "is-disabled" : ""}`}>
      <span className="sb-toggle-text"><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
    </label>
  );
}

export function ConfirmDialog({ state, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    setBusy(true);
    setError("");
    try {
      await state.onConfirm();
      onClose();
    } catch (e) {
      setError(e.message || "操作失败，请稍后重试");
      setBusy(false);
    }
  };
  return (
    <Modal title={state.title} kicker={state.kicker || "请确认"} onClose={onClose}>
      <div className="sb-wide" />
      <p className="sb-confirm-text">{state.message}</p>
      {error && <p className="form-error">{error}</p>}
      <div className="sb-form-foot">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className={`btn ${state.danger ? "sb-btn-danger" : "btn-primary"}`} onClick={run} disabled={busy}>
          {busy ? "处理中…" : state.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function ProfileForm({ data, initial, fixedMemberId, custom = false, onClose, onSaved }) {
  const isNew = !initial;
  const customNodes = initial ? !!initial.customNodes : custom;
  const members = data.members || [];
  const templates = data.ruleTemplates || [];
  const [name, setName] = useState(initial?.name || (fixedMemberId ? `${members.find(m => m.id === fixedMemberId)?.name || "用户"} · ${customNodes ? "定制订阅" : "个人订阅"}` : ""));
  const [memberId, setMemberId] = useState(initial?.memberId || fixedMemberId || members[0]?.id || "");
  const [format, setFormat] = useState(initial?.format || "clash");
  const [nodeIds, setNodeIds] = useState(initial?.nodeIds || (customNodes ? (members.find(m => m.id === fixedMemberId)?.allocationNodeIds ?? members.find(m => m.id === fixedMemberId)?.nodeIds ?? []) : []));
  const [follow, setFollow] = useState(isNew ? !customNodes : Boolean(initial?.followMemberNodes));
  const [templateId, setTemplateId] = useState(initial?.templateId || "");
  const [rules, setRules] = useState(rulesText(initial?.rules));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const member = members.find(m => m.id === memberId) || null;
  const memberNodeIds = member?.allocationNodeIds ?? member?.nodeIds ?? [];

  const changeMember = nextId => {
    setMemberId(nextId);
    const next = members.find(m => m.id === nextId);
    const allowed = new Set(next?.nodeIds || []);
    setNodeIds(prev => prev.filter(id => allowed.has(id)));
  };

  const save = async () => {
    if (!name.trim()) { setError("请填写订阅名称。"); return; }
    if (!memberId) { setError("请选择所属用户。"); return; }
    setBusy(true);
    setError("");
    const id = isNew ? newRecordId() : initial.id;
    const body = {
      id,
      name: name.trim(),
      memberId,
      format,
      nodeIds: follow ? [...memberNodeIds] : nodeIds,
      followMemberNodes: follow,
      customNodes,
      templateId: templateId || "",
      rules: parseRules(rules),
      updated: initial?.updated || ""
    };
    try {
      await saveRecord("profile", id, body);
      onSaved();
      onClose();
    } catch (e) {
      setError(e.message || "保存失败，请稍后重试");
      setBusy(false);
    }
  };

  return (
    <Modal title={customNodes ? (isNew ? "新建定制订阅" : "编辑定制订阅") : (isNew ? "新建个人订阅" : "编辑个人订阅")} kicker={customNodes ? "CUSTOM SUBSCRIPTION" : "PERSONAL SUBSCRIPTION"} onClose={onClose}>
      <div className="sb-wide" />
      <label className="field">
        <span>名称</span>
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="例如：日常订阅" />
      </label>
      <div className="field-grid">
        <label className="field">
          <span>所属用户</span>
          <select className="sb-control" aria-label="所属用户" value={memberId} disabled={!isNew || !!fixedMemberId} onChange={e => changeMember(e.target.value)}>
            <option value="">请选择用户</option>
            {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          {!isNew && <small>订阅创建后不能转给另一位用户，需要时请新建订阅。</small>}
        </label>
        <label className="field">
          <span>格式</span>
          <select className="sb-control" value={format} onChange={e => setFormat(e.target.value)}>
            {FORMATS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
      </div>
      {customNodes
        ? <p className="sb-confirm-text mb-note">为 {member?.name || "此用户"} 单独选择节点，保留已分配订阅。定制内容不影响其他用户。</p>
        : <ToggleRow label="跟随订阅分配" checked={follow} onChange={setFollow}
          hint="分配的订阅更新后，此链接的节点自动更新。" />}
      <div className="field">
        <span>节点{!follow && !customNodes && member && `（仅可选用已分配给 ${member.name} 的节点）`}</span>
        <NodePicker nodes={data.nodes || []} servers={data.servers || []} value={follow ? memberNodeIds : nodeIds}
          onChange={setNodeIds} allowedIds={customNodes ? null : member ? memberNodeIds : []} disabled={follow}
          disabledNote={`正在跟随用户分配：当前共 ${memberNodeIds.length} 个节点，下发时自动同步。`} />
      </div>
      <label className="field">
        <span>规则模板</span>
        <select className="sb-control" aria-label="规则模板" value={templateId} onChange={e => setTemplateId(e.target.value)}>
          <option value="">不使用模板（使用下方自定义规则）</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.builtin ? "（内置）" : ""}</option>)}
        </select>
        {templateId
          ? <small>自定义规则优先于模板，可用于添加个人例外。</small>
          : <small>不选模板时，下发使用下方自定义规则。</small>}
      </label>
      <label className="field">
        <span>自定义规则（每行一条）</span>
        <textarea className="sb-control sb-textarea mono" rows={5} value={rules}
          onChange={e => setRules(e.target.value)}
          placeholder={"GEOIP,CN,DIRECT\nMATCH,节点选择"} />
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="sb-form-foot">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
          <Save size={15} />{busy ? "保存中…" : "保存"}
        </button>
      </div>
    </Modal>
  );
}

function SubscriptionForm({ data, initial, onClose, onSaved }) {
  const isNew = !initial;
  const [name, setName] = useState(initial?.name || "");
  const [note, setNote] = useState(initial?.note || "");
  const [connectionLimit, setConnectionLimit] = useState(String(initial?.connectionLimit ?? 0));
  const [nodeIds, setNodeIds] = useState(initial?.nodeIds || []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!name.trim()) { setError("请填写集合名称。"); return; }
    const connectionNum = Number(connectionLimit);
    if (!Number.isInteger(connectionNum) || connectionNum < 0 || connectionNum > 10000) {
      setError("并发连接上限必须是 0–10000 之间的整数，0 表示不限制。"); return;
    }
    setBusy(true);
    setError("");
    const id = isNew ? newRecordId() : initial.id;
    try {
      await saveRecord("subscription", id, {
        id, name: name.trim(), note, nodeIds, connectionLimit: connectionNum, updated: initial?.updated || ""
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e.message || "保存失败，请稍后重试");
      setBusy(false);
    }
  };

  return (
    <Modal title={isNew ? "新建订阅" : "编辑订阅"} kicker="NODE SUBSCRIPTION" onClose={onClose}>
      <div className="sb-wide" />
      <label className="field">
        <span>名称</span>
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="例如：全节点订阅 / 亚洲订阅" />
      </label>
      <label className="field">
        <span>备注</span>
        <textarea className="sb-control sb-textarea" rows={3} value={note} onChange={e => setNote(e.target.value)} placeholder="这个集合的用途…" />
      </label>
      <label className="field">
        <span>新分配用户的默认并发连接上限</span>
        <input className="sb-control" type="number" min="0" max="10000" step="1" value={connectionLimit}
          onChange={e => setConnectionLimit(e.target.value)} />
        <small>0 表示不限制。用户可在用户页单独覆盖；机场等外部订阅凭据不受 SubHub 控制。</small>
      </label>
      <div className="field">
        <span>节点</span>
        <NodePicker nodes={data.nodes || []} servers={data.servers || []} value={nodeIds} onChange={setNodeIds} />
        <small>订阅可重复分配给多位用户，之后无需逐个勾选节点。</small>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="sb-form-foot">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
          <Save size={15} />{busy ? "保存中…" : "保存"}
        </button>
      </div>
    </Modal>
  );
}

function PackageMembersDialog({ data, plan, onClose, onSaved }) {
  const [memberIds, setMemberIds] = useState((data.members || []).filter(m => (m.subscriptionIds || []).includes(plan.id)).map(m => m.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true); setError("");
    try { await assignPackageMembers(plan.id, memberIds); onSaved(); onClose(); }
    catch (e) { setError(e.message); setBusy(false); }
  };
  return <Modal title={`分配订阅 · ${plan.name}`} kicker="SUBSCRIPTION MEMBERS" onClose={onClose}>
    <p className="sb-confirm-text">选择使用此订阅的用户。用户的其他订阅和定制订阅会保留。</p>
    <div className="mb-check-list package-members-list">
      {(data.members || []).map(m => <label className="mb-check-item" key={m.id}>
        <input type="checkbox" checked={memberIds.includes(m.id)} onChange={e => setMemberIds(e.target.checked ? [...memberIds, m.id] : memberIds.filter(id => id !== m.id))} />
        <span>{m.name}<small>{m.enabled ? "已启用" : "已停用"}</small></span>
      </label>)}
    </div>
    {(data.members || []).some(m => memberIds.includes(m.id) && m.assignmentMode === "nodes") &&
      <p className="sb-warn">原先单独分配节点的用户将改用订阅分配；其定制订阅继续保留。</p>}
    {!(data.members || []).length && <p className="muted">先在用户页新建用户。</p>}
    {error && <p className="form-error">{error}</p>}
    <div className="sb-form-foot"><button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
      <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "分配中…" : "保存分配"}</button></div>
  </Modal>;
}

function TemplateForm({ initial, source, onClose, onSaved }) {
  const isNew = !initial;
  const base = initial || source;
  const [name, setName] = useState(base?.name || "");
  const [smart, setSmart] = useState(Boolean(base?.smart));
  const [rules, setRules] = useState(rulesText(base?.rules));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!name.trim()) { setError("请填写模板名称。"); return; }
    setBusy(true);
    setError("");
    const id = isNew ? newRecordId() : initial.id;
    try {
      await saveRuleTemplate(id, { name: name.trim(), rules: parseRules(rules), smart });
      onSaved();
      onClose();
    } catch (e) {
      setError(e.message || "保存失败，请稍后重试");
      setBusy(false);
    }
  };

  return (
    <Modal title={isNew ? (source ? "另存为自定义模板" : "新建规则模板") : "编辑规则模板"} kicker="RULE TEMPLATE" onClose={onClose}>
      <div className="sb-wide" />
      <label className="field">
        <span>名称</span>
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="例如：游戏直连优先" />
      </label>
      <ToggleRow label="智能分流" checked={smart} onChange={setSmart}
        hint="开启后可使用 AI / Telegram / 流媒体 策略组与 RULE-SET 规则集（由 smart 网络段提供）。" />
      <label className="field">
        <span>规则（每行一条）</span>
        <textarea className="sb-control sb-textarea mono" rows={10} value={rules} onChange={e => setRules(e.target.value)}
          placeholder={"GEOIP,LAN,DIRECT\nGEOIP,CN,DIRECT\nMATCH,节点选择"} />
        <small>规则由后端校验：类型、参数个数与策略组引用不合法时保存会被拒绝，并在此处显示原因。</small>
      </label>
      {error && <p className="form-error">{error}</p>}
      <div className="sb-form-foot">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
          <Save size={15} />{busy ? "保存中…" : "保存"}
        </button>
      </div>
    </Modal>
  );
}

function TemplateView({ template, onClose, onDuplicate, onEdit }) {
  return (
    <Modal title={template.name} kicker="RULE TEMPLATE" onClose={onClose}>
      <div className="sb-wide" />
      <div className="sb-view-tags">
        {template.builtin
          ? <span className="badge badge-idle">内置模板</span>
          : <span className="badge badge-ok">自定义模板</span>}
        {template.smart && <TagPill tone="plan">智能分流</TagPill>}
        <span className="muted">{(template.rules || []).length} 条规则</span>
      </div>
      <div className="sb-rule-lines">
        {(template.rules || []).length === 0
          ? <p className="muted">该模板没有规则。</p>
          : template.rules.map((rule, i) => (
            <div key={i} className="sb-rule-line"><span>{i + 1}</span><code>{rule}</code></div>
          ))}
      </div>
      <div className="sb-form-foot">
        <button type="button" className="btn" onClick={onClose}>关闭</button>
        {template.builtin
          ? <button type="button" className="btn btn-primary" onClick={() => onDuplicate(template)}>另存为自定义</button>
          : <button type="button" className="btn btn-primary" onClick={() => onEdit(template)}><Pencil size={15} />编辑模板</button>}
      </div>
    </Modal>
  );
}

function LinkRow({ label, value }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div className="field">
      <span>{label}</span>
      <div className="sb-link-row">
        <input type="text" aria-label={label} readOnly value={value} className="mono" onFocus={e => e.target.select()} />
        <button type="button" className="btn btn-small" onClick={copy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制"}
        </button>
      </div>
    </div>
  );
}

export function IssueDialog({ state, onClose, onRotate }) {
  const profile = state.profile;
  return (
    <Modal title="订阅链接" kicker="ONE-TIME LINK" onClose={onClose}>
      <div className="sb-wide" />
      <p className="sb-confirm-text">为「{profile.name}」生成订阅链接。</p>
      {state.stage === "loading" && <p className="muted">正在生成链接…</p>}
      {state.stage === "error" && <p className="form-error">{state.error}</p>}
      {state.stage === "conflict" && (
        <>
          <p className="sb-warn">已有链接，重新生成将使旧链接立即失效。</p>
          <p className="muted">{state.error}</p>
          <div className="sb-form-foot">
            <button type="button" className="btn" onClick={onClose}>取消</button>
            <button type="button" className="btn sb-btn-danger" onClick={() => onRotate(profile)}>重新生成</button>
          </div>
        </>
      )}
      {state.stage === "done" && (
        <>
          {state.warning && <p className="sb-warn">{state.warning}</p>}
          <LinkRow label="订阅链接（只显示这一次）" value={state.url} />
          <LinkRow label="用户门户链接" value={state.portalUrl} />
          {state.qr && (
            <div className="sb-qr">
              <img src={state.qr} alt="订阅链接二维码" width={180} height={180} />
              <p className="muted">扫码导入订阅链接</p>
            </div>
          )}
          <div className="sb-form-foot">
            <button type="button" className="btn btn-primary" onClick={onClose}>我已保存</button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function useSubscriptionLinks() {
  const [issue, setIssue] = useState(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const closeIssue = () => { generation.current++; setIssue(null); };
  const runIssue = async (profile, rotate = false) => {
    const request = ++generation.current;
    setIssue({ profile, stage: "loading" });
    try {
      const res = await issueSubscription(profile.id, rotate ? { rotate: true } : {});
      let qr = "";
      try { qr = await QRCode.toDataURL(res.url, { width: 240, margin: 1 }); } catch { /* copying stays available */ }
      if (request === generation.current) setIssue({ profile, stage: "done", url: res.url, portalUrl: res.portalUrl, warning: res.warning, qr });
    } catch (e) {
      const message = e.message || "生成链接失败，请稍后重试";
      if (request === generation.current) setIssue({
        profile, stage: !rotate && message.includes("已有订阅链接") ? "conflict" : "error", error: message
      });
    }
  };
  return { issue, runIssue, closeIssue };
}

function PreviewDialog({ state, onClose, onFormat }) {
  const content = state.content || "";
  const hasDns = state.format === "clash" && /(^|\n)\s*dns\s*:/.test(content);
  return (
    <Modal title={`下发预览 · ${state.profile.name}`} kicker="DELIVERY PREVIEW" onClose={onClose}>
      <div className="sb-wide" />
      <div className="sb-preview-bar">
        <div className="segmented" role="group" aria-label="预览格式">
          {FORMATS.map(([key, label]) => (
            <button key={key} type="button" className={state.format === key ? "active" : ""} onClick={() => onFormat(key)}>{label}</button>
          ))}
        </div>
        {hasDns && <span className="badge badge-ok">已含 DNS 段</span>}
      </div>
      {state.warning && <p className="sb-warn">{state.warning}</p>}
      {state.loading
        ? <p className="muted">正在渲染下发内容…</p>
        : state.error
          ? <p className="form-error">{state.error}</p>
          : <pre className="sb-preview">{content}</pre>}
      <div className="sb-form-foot">
        <button type="button" className="btn" onClick={onClose}>关闭</button>
      </div>
    </Modal>
  );
}

export default function SubscriptionsPage({ data, search, onRefresh }) {
  const [profileForm, setProfileForm] = useState(null); // null | {initial}
  const [subForm, setSubForm] = useState(null);
  const [tplForm, setTplForm] = useState(null); // null | {initial} | {source}
  const [tplView, setTplView] = useState(null);
  const { issue, runIssue, closeIssue } = useSubscriptionLinks();
  const [section, setSection] = useState("collections");
  const [assignPlan, setAssignPlan] = useState(null);
  const [preview, setPreview] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [notice, setNotice] = useState("");

  const profiles = data.profiles || [];
  const subscriptions = data.subscriptions || [];
  const templates = data.ruleTemplates || [];
  const members = data.members || [];

  const memberName = id => members.find(m => m.id === id)?.name || "用户已删除";
  const memberOf = id => members.find(m => m.id === id) || null;
  const templateName = id => templates.find(t => t.id === id)?.name || "模板已删除";

  const q = (search || "").trim().toLowerCase();
  const match = (...fields) => !q || fields.join(" ").toLowerCase().includes(q);
  const profileList = profiles.filter(p => match(p.name, memberName(p.memberId), p.format, p.templateId ? templateName(p.templateId) : ""));
  const subList = subscriptions.filter(s => match(s.name, s.note || ""));
  const tplList = templates.filter(t => match(t.name));

  const flash = message => {
    setNotice(message);
    setTimeout(() => setNotice(""), 4000);
  };

  const loadPreview = async (profile, format) => {
    setPreview({ profile, format, loading: true, content: "", warning: "", error: "" });
    try {
      const res = await previewProfile(profile.id, format);
      setPreview({ profile, format: res.format || format, loading: false, content: res.content || "", warning: res.warning || "", error: "" });
    } catch (e) {
      setPreview({ profile, format, loading: false, content: "", warning: "", error: e.message || "预览失败，请稍后重试" });
    }
  };

  const askRevoke = profile => setConfirm({
    title: "撤销订阅链接",
    kicker: "REVOKE LINK",
    message: `撤销「${profile.name}」的链接后，现有链接立即失效，持有该链接的用户将无法再获取订阅。订阅配置本身不会被删除，之后可以重新生成新链接。`,
    confirmLabel: "撤销链接",
    danger: true,
    onConfirm: async () => {
      await revokeSubscription(profile.id);
      flash(`已撤销「${profile.name}」的订阅链接。`);
    }
  });

  const askDeleteProfile = profile => setConfirm({
    title: "删除订阅配置",
    kicker: "DELETE PROFILE",
    message: `确定删除订阅配置「${profile.name}」吗？其订阅链接会一并失效，此操作不可恢复。`,
    confirmLabel: "删除",
    danger: true,
    onConfirm: async () => {
      await deleteRecord("profile", profile.id);
      onRefresh();
      flash(`已删除订阅配置「${profile.name}」。`);
    }
  });

  const askDeleteSubscription = sub => setConfirm({
    title: "删除订阅",
    kicker: "DELETE COLLECTION",
    message: `确定删除订阅「${sub.name}」吗？仍在使用的订阅需要先解除分配。`,
    confirmLabel: "删除",
    danger: true,
    onConfirm: async () => {
      await deleteRecord("subscription", sub.id);
      onRefresh();
      flash(`已删除订阅「${sub.name}」。`);
    }
  });

  const askDeleteTemplate = tpl => setConfirm({
    title: "删除规则模板",
    kicker: "DELETE TEMPLATE",
    message: `确定删除自定义模板「${tpl.name}」吗？若仍有订阅配置在用，删除会被拒绝并提示原因。`,
    confirmLabel: "删除",
    danger: true,
    onConfirm: async () => {
      await deleteRuleTemplate(tpl.id);
      onRefresh();
      flash(`已删除规则模板「${tpl.name}」。`);
    }
  });

  const refCount = sub => members.filter(m => (m.subscriptionIds || []).includes(sub.id)).length;

  return (
    <div className="page management-page subscriptions-page tone-green">
      <PageHeading icon={Layers} title="订阅" description="把常用节点组合成订阅，一次选择，分配给家人和朋友">
          <button type="button" className="btn" onClick={onRefresh}><RefreshCw size={15} />刷新记录</button>
          <button type="button" className="btn btn-primary" onClick={() => setSubForm({ initial: null })}><Plus size={15} />新建订阅</button>
      </PageHeading>

      {notice && <p className="sb-notice">{notice}</p>}

      <Glass className="ribbon">
        <SummaryStat icon={Layers} label="订阅" tone="green">{subscriptions.length}</SummaryStat>
        <SummaryStat icon={Users} label="已分配用户" tone="blue">{members.filter(m => m.subscriptionIds?.length).length}</SummaryStat>
        <SummaryStat icon={Link2} label="定制订阅" tone="purple">{profiles.filter(p => p.customNodes).length}</SummaryStat>
        <SummaryStat icon={FileText} label="规则模板" tone="amber">{templates.length}</SummaryStat>
      </Glass>

      <div className="sb-tabs segmented" role="group" aria-label="订阅分类">
        {[["collections", "订阅", Layers, subList.length], ["profiles", "个人订阅", Network, profileList.length], ["templates", "分流模板", FileText, tplList.length]].map(([key, label, Icon, count]) => (
          <button key={key} type="button" className={section === key ? "active" : ""} aria-label={label} aria-pressed={section === key} onClick={() => setSection(key)}>
            <Icon size={15} />{label}<span className="sb-tab-count">{count}</span>
          </button>
        ))}
      </div>

      <Glass className="list-panel" hidden={section !== "profiles"}>
        <div className="sb-section-head">
          <h2><Network size={17} />个人订阅</h2>
          <span className="toolbar-hint">每份订阅属于一位用户，单独生成链接</span>
          <button type="button" className="btn btn-small" onClick={() => setProfileForm({ initial: null })}><Plus size={14} />新建</button>
        </div>
        {profileList.length === 0
          ? <div className="empty-state"><Network size={26} /><h3>{profiles.length ? "没有匹配的个人订阅" : "还没有个人订阅"}</h3>
              <p>{profiles.length ? "试试其他关键词。" : "为用户新建个人订阅后，即可生成独立链接。"}</p></div>
          : <div className="table-wrap"><table className="srv-table sb-table">
              <thead><tr><th>名称</th><th>所属用户</th><th>格式</th><th>节点</th><th>规则模板</th><th>更新时间</th><th aria-label="操作" /></tr></thead>
              <tbody>
                {profileList.map(p => {
                  const member = memberOf(p.memberId);
                  const nodeCount = (p.nodeIds || []).length;
                  return (
                    <tr key={p.id}>
                      <td><strong className="sb-cell-name">{p.name}</strong></td>
                      <td>{memberName(p.memberId)}</td>
                      <td><TagPill tone={FORMAT_TONES[p.format] || "gray"}>{formatLabel(p.format)}</TagPill></td>
                      <td>{p.followMemberNodes
                        ? <span>跟随订阅分配<small className="sb-cell-sub">{member ? `当前 ${(member.allocationNodeIds ?? member.nodeIds ?? []).length} 个` : `${nodeCount} 个`}</small></span>
                        : <span className="node-num">{nodeCount}</span>}</td>
                      <td>{p.templateId ? templateName(p.templateId) : <span className="muted">自定义规则 · {(p.rules || []).length} 条</span>}</td>
                      <td><span className="muted">{p.updated ? stamp(p.updated) : "—"}</span></td>
                      <td><div className="sb-actions">
                        <button type="button" className="btn btn-small" onClick={() => runIssue(p, false)}><Link2 size={13} />生成链接</button>
                        <button type="button" className="btn btn-small" onClick={() => loadPreview(p, p.format)}><Eye size={13} />预览</button>
                        <button type="button" className="icon-btn" title="编辑" aria-label={`编辑 ${p.name}`} onClick={() => setProfileForm({ initial: p })}><Pencil size={15} /></button>
                        <button type="button" className="icon-btn" title="撤销链接" aria-label={`撤销 ${p.name} 的链接`} onClick={() => askRevoke(p)}><Unlink size={15} /></button>
                        <button type="button" className="icon-btn" title="删除" aria-label={`删除 ${p.name}`} onClick={() => askDeleteProfile(p)}><Trash2 size={15} /></button>
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>}
      </Glass>

      <Glass className="list-panel" hidden={section !== "collections"}>
        <div className="sb-section-head">
          <h2><Layers size={17} />订阅</h2>
          <span className="toolbar-hint">选择节点组成订阅，再分配给多位用户</span>
          <button type="button" className="btn btn-small" onClick={() => setSubForm({ initial: null })}><Plus size={14} />新建</button>
        </div>
        {subList.length === 0
          ? <div className="empty-state"><Layers size={26} /><h3>{subscriptions.length ? "没有匹配的订阅" : "还没有订阅"}</h3>
              <p>{subscriptions.length ? "试试其他关键词。" : "创建全节点订阅，或勾选需要的节点组成专用订阅。"}</p></div>
          : <div className="subscription-grid">
                {subList.map(s => {
                  const selectedNodes = (data.nodes || []).filter(n => (s.nodeIds || []).includes(n.id));
                  return <article key={s.id} className="subscription-card" aria-label={`订阅 ${s.name}`}>
                    <div className="subscription-card-head">
                      <IconChip icon={Layers} tone="green" size={42} />
                      <div><h3>{s.name}</h3>{s.note && <p>{s.note}</p>}</div>
                      <div className="sb-actions">
                      <button type="button" className="icon-btn" title="编辑" aria-label={`编辑 ${s.name}`} onClick={() => setSubForm({ initial: s })}><Pencil size={15} /></button>
                      <button type="button" className="icon-btn" title="删除" aria-label={`删除 ${s.name}`} onClick={() => askDeleteSubscription(s)}><Trash2 size={15} /></button>
                      </div>
                    </div>
                    <div className="subscription-card-stats">
                      <div><Waypoints size={15} /><strong>{(s.nodeIds || []).length}</strong><span>个节点</span></div>
                      <div><Users size={15} /><span>{refCount(s)} 位用户</span></div>
                      <div><Activity size={15} /><strong>{s.connectionLimit > 0 ? s.connectionLimit : "∞"}</strong><span>并发上限</span></div>
                    </div>
                    <div className="subscription-card-nodes">
                      {selectedNodes.slice(0, 3).map(n => <span key={n.id}>{n.name}</span>)}
                      {selectedNodes.length > 3 && <span className="subscription-more">+{selectedNodes.length - 3}</span>}
                      {!selectedNodes.length && <span className="muted">尚未选择节点</span>}
                    </div>
                    <div className="subscription-card-foot">
                      <span>{s.updated ? `更新于 ${stamp(s.updated)}` : "更新时间未记录"}</span>
                      <button type="button" className="btn btn-small btn-primary" onClick={() => setAssignPlan(s)}><Users size={14} />分配用户</button>
                    </div>
                  </article>;
                })}
            </div>}
      </Glass>

      <Glass className="list-panel" hidden={section !== "templates"}>
        <div className="sb-section-head">
          <h2><FileText size={17} />规则模板</h2>
          <span className="toolbar-hint">{tplList.length} 条 · 内置模板不可修改，可另存为自定义后调整</span>
          <button type="button" className="btn btn-small" onClick={() => setTplForm({ initial: null })}><Plus size={14} />新建</button>
        </div>
        {tplList.length === 0
          ? <div className="empty-state"><FileText size={26} /><h3>没有匹配的规则模板</h3><p>试试其他关键词。</p></div>
          : <div className="table-wrap"><table className="srv-table sb-table">
              <thead><tr><th>名称</th><th>类型</th><th>规则条数</th><th>智能分流</th><th aria-label="操作" /></tr></thead>
              <tbody>
                {tplList.map(t => (
                  <tr key={t.id}>
                    <td><strong className="sb-cell-name">{t.name}</strong></td>
                    <td>{t.builtin ? <span className="badge badge-idle">内置</span> : <span className="badge badge-ok">自定义</span>}</td>
                    <td>{(t.rules || []).length} 条</td>
                    <td>{t.smart ? <TagPill tone="plan">智能分流</TagPill> : <span className="muted">—</span>}</td>
                    <td><div className="sb-actions">
                      <button type="button" className="btn btn-small" onClick={() => setTplView(t)}><Eye size={13} />查看</button>
                      {t.builtin
                        ? <button type="button" className="btn btn-small" onClick={() => setTplForm({ source: t })}>另存为自定义</button>
                        : <>
                            <button type="button" className="icon-btn" title="编辑" aria-label={`编辑 ${t.name}`} onClick={() => setTplForm({ initial: t })}><Pencil size={15} /></button>
                            <button type="button" className="icon-btn" title="删除" aria-label={`删除 ${t.name}`} onClick={() => askDeleteTemplate(t)}><Trash2 size={15} /></button>
                          </>}
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table></div>}
      </Glass>

      {profileForm && (
        <ProfileForm data={data} initial={profileForm.initial}
          onClose={() => setProfileForm(null)} onSaved={onRefresh} />
      )}
      {assignPlan && <PackageMembersDialog data={data} plan={assignPlan} onClose={() => setAssignPlan(null)} onSaved={onRefresh} />}
      {subForm && (
        <SubscriptionForm data={data} initial={subForm.initial}
          onClose={() => setSubForm(null)} onSaved={onRefresh} />
      )}
      {tplForm && (
        <TemplateForm initial={tplForm.initial || null} source={tplForm.source || null}
          onClose={() => setTplForm(null)} onSaved={onRefresh} />
      )}
      {tplView && (
        <TemplateView template={tplView} onClose={() => setTplView(null)}
          onDuplicate={t => { setTplView(null); setTplForm({ source: t }); }}
          onEdit={t => { setTplView(null); setTplForm({ initial: t }); }} />
      )}
      {issue && (
        <IssueDialog state={issue} onClose={closeIssue} onRotate={profile => runIssue(profile, true)} />
      )}
      {preview && (
        <PreviewDialog state={preview} onClose={() => setPreview(null)}
          onFormat={format => loadPreview(preview.profile, format)} />
      )}
      {confirm && <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
