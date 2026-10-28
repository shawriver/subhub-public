import React, { useCallback, useEffect, useState } from "react";
import { Activity, CalendarClock, Clock, Layers, Link2Off, RefreshCw, RotateCcw, UserRound } from "lucide-react";
import { Glass, RATIO_GRADIENTS, ThickBar } from "../ui.jsx";
import { getPublicMember } from "../api.js";
import { dateOnly, stamp } from "../format.js";

const STATUS_META = {
  active: { label: "正常", cls: "badge-ok" },
  disabled: { label: "已停用", cls: "badge-idle" },
  expired: { label: "已过期", cls: "badge-bad" },
  exhausted: { label: "额度用尽", cls: "badge-bad" },
  invalid: { label: "状态异常", cls: "badge-bad" }
};

function fmtGb(value) {
  const n = Number(value || 0);
  return `${(Number.isFinite(n) ? n : 0).toFixed(2)} GB`;
}

function cycleDateText(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "short", day: "numeric" }).format(d);
}

export default function PortalPage({ theme }) {
  const token = location.pathname.split("/").filter(Boolean)[1] || "";
  const [member, setMember] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!token) { setFailed(true); setLoading(false); return; }
    setRefreshing(true);
    try {
      const v = await getPublicMember(token);
      setMember(v);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60000);
    return () => clearInterval(timer);
  }, [load]);

  if (loading) {
    return (
      <Glass className="po-state">
        <p className="po-loading">正在加载你的用量信息…</p>
      </Glass>
    );
  }

  if (failed || !member) {
    return (
      <div className="po-page">
        <header className="po-brand">
          <p className="kicker">{theme?.brandSub || "PRIVATE NETWORK"}</p>
          <h1>{theme?.brandName || "SubHub"}</h1>
        </header>
        <Glass className="po-state">
          <span className="po-state-icon"><Link2Off size={26} /></span>
          <h2>链接无效或已撤销</h2>
          <p>这个自查链接可能已被重新签发或撤销，旧链接无法再查看用量。请向管理员索取最新链接后再打开。</p>
          <button type="button" className="btn" onClick={load}><RefreshCw size={15} />重新尝试</button>
        </Glass>
      </div>
    );
  }

  const meta = STATUS_META[member.status] || { label: member.status || "未知状态", cls: "badge-idle" };
  const hasLimit = Number(member.limitGb) > 0;
  const usedPct = hasLimit ? (Number(member.usedGb || 0) / Number(member.limitGb)) * 100 : 0;
  const connectionText = member.connectionLimit > 0
    ? `${member.connectionLimit} 条`
    : "不限";
  const resetText = member.resetDay > 0
    ? `每月 ${member.resetDay} 日重置${member.cycleEnd ? ` · 下次重置 ${cycleDateText(member.cycleEnd)}` : ""}`
    : "不按月重置";

  return (
    <div className="po-page">
      <header className="po-brand">
        <p className="kicker">{theme?.brandSub || "PRIVATE NETWORK"}</p>
        <h1>{theme?.brandName || "SubHub"}</h1>
        <p className="po-brand-sub">个人用量自查</p>
      </header>

      <Glass className="po-hero">
        <div className="po-greeting">
          <span className="po-avatar" aria-hidden="true"><UserRound size={20} /></span>
          <div className="po-greeting-text">
            <h2>你好，{member.name}</h2>
            <p>{member.profile ? `订阅方案：${member.profile}` : "这是你的订阅用量概览"}</p>
          </div>
          <span className={`badge ${meta.cls} po-status`}>{meta.label}</span>
        </div>
      </Glass>

      <Glass className="po-usage-card">
        <div className="po-usage-head">
          <span className="po-label">本周期已用</span>
          <span className="po-usage-pct">{hasLimit ? `${usedPct.toFixed(1)}%` : "不限额"}</span>
        </div>
        <div className="po-usage-big">
          {fmtGb(member.usedGb)}
          {hasLimit
            ? <span className="po-usage-limit"> / {fmtGb(member.limitGb)}</span>
            : <span className="po-usage-limit"> · 不限额</span>}
        </div>
        {hasLimit
          ? <ThickBar value={usedPct} color={usedPct >= 90 ? RATIO_GRADIENTS.red : usedPct >= 70 ? RATIO_GRADIENTS.amber : RATIO_GRADIENTS.green} />
          : <p className="po-usage-hint">当前方案不限流量额度，按周期正常使用即可。</p>}
      </Glass>

      <div className="po-grid">
        <Glass className="po-stat">
          <span className="po-stat-label"><Layers size={14} />累计用量</span>
          <strong>{fmtGb(member.lifetimeUsedGb)}</strong>
          <small>自开通以来全部周期合计</small>
        </Glass>
        <Glass className="po-stat">
          <span className="po-stat-label"><CalendarClock size={14} />到期日期</span>
          <strong>{member.expires ? dateOnly(member.expires) : "无期限"}</strong>
          <small>{member.expires ? "到期后订阅将停止可用" : "当前方案没有到期日期"}</small>
        </Glass>
        <Glass className="po-stat">
          <span className="po-stat-label"><RotateCcw size={14} />重置安排</span>
          <strong className="po-stat-small">{resetText}</strong>
          <small>{member.resetDay > 0 ? "额度按月滚动重置" : "额度不按自然月重置"}</small>
        </Glass>
        <Glass className="po-stat">
          <span className="po-stat-label"><Layers size={14} />可用节点</span>
          <strong>{member.availableNodes} 个</strong>
          <small>当前方案可使用的节点数量</small>
        </Glass>
        <Glass className="po-stat">
          <span className="po-stat-label"><Activity size={14} />并发连接</span>
          <strong>{connectionText}</strong>
          <small>{member.connectionLimitSource === "override" ? "管理员为用户单独设置" : "跟随分配订阅的默认值"}</small>
        </Glass>
      </div>

      <p className="po-foot">
        <Clock size={13} />数据更新时间：{stamp(member.updated)} · 页面每 60 秒自动刷新
        <button type="button" className="btn btn-small po-refresh" onClick={load} disabled={refreshing}>
          <RefreshCw size={13} />{refreshing ? "刷新中…" : "立即刷新"}
        </button>
      </p>
    </div>
  );
}
