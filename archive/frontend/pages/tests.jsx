import React, { useEffect, useMemo, useRef, useState } from "react";
import { Download, Gauge, History, Loader2, Play, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { cancelNodeTest, getNodeTest, getTestHistory, testNode } from "../api.js";
import { bytes, stamp } from "../format.js";
import { Glass, LatencyBar } from "../ui.jsx";

const LABELS = { queued: "等待", running: "测试中", verified: "通过", partial: "部分通过", error: "失败", cancelled: "已停止", stale: "配置已变更", interrupted: "已中断", skipped: "未执行" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function ResultState({ state }) {
  const tone = state === "verified" ? "ok" : state === "error" ? "bad" : ["running", "partial", "interrupted"].includes(state) ? "warn" : "idle";
  return <span className={`badge badge-${tone}`}>{state === "running" && <Loader2 size={12} className="nd-spin" />}{LABELS[state] || "未测"}</span>;
}

export default function TestsPage({ data, onRefresh }) {
  const [selected, setSelected] = useState([]);
  const [server, setServer] = useState("");
  const [mode, setMode] = useState("latency");
  const [identity, setIdentity] = useState("");
  const [allowMetered, setAllowMetered] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);
  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState("");
  const [tab, setTab] = useState("current");
  const [sort, setSort] = useState("order");
  const [error, setError] = useState("");
  const jobRef = useRef(null);
  const aliveRef = useRef(true);

  const loadHistory = async () => {
    try { const rows = await getTestHistory(); if (aliveRef.current) { setHistory(rows); setHistoryError(""); } }
    catch (err) { if (aliveRef.current) setHistoryError(err.message); }
  };
  useEffect(() => {
    aliveRef.current = true;
    loadHistory();
    return () => {
      aliveRef.current = false;
      const job = jobRef.current;
      if (job) {
        job.stop = true;
        if (job.active) cancelNodeTest(job.active.nodeId, job.active.runId).catch(() => {});
      }
    };
  }, []);

  const nodes = data.nodes.filter(n => n.enabled && (!server || n.serverId === server));
  const picked = data.nodes.filter(n => n.enabled && selected.includes(n.id));
  const metered = mode === "download" && picked.some(n => n.serverId === "aws-ec2-tpe");
  const completed = results.filter(r => !["queued", "running"].includes(r.state)).length;
  const passed = results.filter(r => r.state === "verified").length;
  const progress = results.length ? Math.round(completed / results.length * 100) : 0;
  const totalBytes = results.reduce((sum, r) => sum + (r.bytes || 0), 0);
  const visibleResults = useMemo(() => {
    const rows = [...(tab === "history" ? history : results)];
    if (sort === "speed") rows.sort((a, b) => (b.downMbps || 0) - (a.downMbps || 0));
    if (sort === "latency") rows.sort((a, b) => (a.latencyMs || Infinity) - (b.latencyMs || Infinity));
    return rows;
  }, [results, history, tab, sort]);

  const toggle = id => {
    setSelected(old => old.includes(id) ? old.filter(x => x !== id) : [...old, id]);
    setAllowMetered(false);
  };
  const update = (nodeId, patch) => {
    if (aliveRef.current) setResults(rows => rows.map(r => r.nodeId === nodeId ? { ...r, ...patch } : r));
  };
  const start = async () => {
    if (jobRef.current || !picked.length || metered && !allowMetered) return;
    const queue = [...picked];
    const job = { stop: false, active: null };
    jobRef.current = job;
    setRunning(true); setError(""); setTab("current");
    setResults(queue.map(n => ({ nodeId: n.id, nodeName: n.name, state: "queued", mode, bytes: 0 })));
    try {
      for (const node of queue) {
        if (job.stop) break;
        update(node.id, { state: "running" });
        let started;
        try {
          const body = { mode, ...(identity ? { memberId: identity } : {}), ...(allowMetered ? { allowMetered: true } : {}) };
          try { started = await testNode(node.id, body); }
          catch (err) {
            if (identity || !err.message.includes("请选择一位已分配此节点")) throw err;
            const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
            const member = data.members.find(m => m.enabled && m.nodeIds?.includes(node.id) && (!m.limit || (m.quotaUsed ?? m.used) < m.limit) && (!m.expires || m.expires >= today));
            if (!member) throw new Error("暂无可用测试身份，请先分配用户并同步授权");
            started = await testNode(node.id, { ...body, memberId: member.id });
          }
          job.active = { nodeId: node.id, runId: started.runId };
          update(node.id, started);
          if (job.stop) await cancelNodeTest(node.id, started.runId).catch(() => {});
          const deadline = Date.now() + 65000;
          while (Date.now() < deadline) {
            const result = await getNodeTest(node.id);
            if (result.runId !== started.runId) throw new Error("该节点测试已被替换，请查看最新记录");
            update(node.id, result);
            if (result.state !== "running") {
              if (["stale", "interrupted"].includes(result.state)) {
                job.stop = true;
                await cancelNodeTest(node.id, started.runId).catch(() => {});
              }
              break;
            }
            await sleep(1500);
          }
          if (Date.now() >= deadline) {
            await cancelNodeTest(node.id, started.runId).catch(() => {});
            update(node.id, { state: "interrupted", detail: "等待结果超时，请刷新历史记录" });
            job.stop = true;
          }
          job.active = null;
        } catch (err) {
          const stopped = job.stop;
          if (job.active) {
            job.stop = true;
            await cancelNodeTest(job.active.nodeId, job.active.runId).catch(() => {});
          }
          job.active = null;
          update(node.id, { state: stopped ? "cancelled" : "error", detail: err.message });
        }
      }
    } finally {
      jobRef.current = null;
      if (aliveRef.current) {
        setResults(rows => rows.map(r => r.state === "queued" ? { ...r, state: "skipped" } : r));
        setRunning(false);
        loadHistory();
        onRefresh();
      }
    }
  };
  const stop = async () => {
    const job = jobRef.current;
    if (!job) return;
    job.stop = true;
    if (job.active) {
      try { await cancelNodeTest(job.active.nodeId, job.active.runId); }
      catch (err) { setError(err.message); }
    }
  };

  return <div className="page test-page">
    <div className="page-head"><h1>测速</h1><div className="head-actions">
      <button type="button" className="btn" onClick={loadHistory}><RefreshCw size={15} />刷新历史</button>
      {running ? <button type="button" className="btn btn-danger" onClick={stop}><Square size={15} />停止测试</button>
        : <button type="button" className="btn btn-primary" disabled={!picked.length || metered && !allowMetered} onClick={start}><Play size={15} />开始测试{picked.length ? ` · ${picked.length}` : ""}</button>}
    </div></div>
    <div className="test-controls">
      <div className="segmented" role="group" aria-label="测试模式">
        <button type="button" className={mode === "latency" ? "active" : ""} disabled={running} onClick={() => { setMode("latency"); setAllowMetered(false); }}><ShieldCheck size={15} />协议验证</button>
        <button type="button" className={mode === "download" ? "active" : ""} disabled={running} onClick={() => { setMode("download"); setAllowMetered(false); }}><Download size={15} />下载采样</button>
      </div>
      <label className="field"><span>服务器</span><select value={server} disabled={running} onChange={e => setServer(e.target.value)}>
        <option value="">全部服务器</option>{data.servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select></label>
      <label className="field"><span>测试身份</span><select value={identity} disabled={running} onChange={e => setIdentity(e.target.value)}>
        <option value="">自动选择可用身份</option>{data.members.filter(m => m.enabled).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select></label>
    </div>
    <div className="test-node-picker">
      <label className="check-line"><input type="checkbox" disabled={running || !nodes.length} checked={!!nodes.length && nodes.every(n => selected.includes(n.id))}
        onChange={e => { const visible = new Set(nodes.map(n => n.id)); setSelected(old => e.target.checked ? [...new Set([...old, ...visible])] : old.filter(id => !visible.has(id))); setAllowMetered(false); }} />全选当前列表</label>
      <div className="test-pick-list">{nodes.map(n => <label key={n.id} className={`test-pick ${selected.includes(n.id) ? "picked" : ""}`}>
        <input type="checkbox" disabled={running} checked={selected.includes(n.id)} onChange={() => toggle(n.id)} /><span>{n.name}</span><small>{n.protocol}</small>
      </label>)}</div>
      {!nodes.length && <p className="muted">暂无启用的节点</p>}
      {metered && <label className="check-line test-metered"><input type="checkbox" disabled={running} checked={allowMetered} onChange={e => setAllowMetered(e.target.checked)} />允许本轮台北节点下载采样（每节点最多 2 MiB，另有协议开销）</label>}
    </div>
    <div className="test-progress" aria-live="polite">
      <div><Gauge size={18} /><strong>{running ? "测试进行中" : results.length ? "本轮已结束" : "等待测试"}</strong><span>{completed} / {results.length} · 通过 {passed} · 采样 {bytes(totalBytes)}</span></div>
      <progress max="100" value={progress} aria-label="批量测试进度" />
    </div>
    <p className="test-context">来源：SubHub 所在服务器 → 所选节点 → 测试站。串行执行；下载每节点最多 2 MiB，小样本速度不代表本地网速或峰值带宽。</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <Glass className="list-panel test-results">
      <div className="list-toolbar">
        <div className="segmented" role="group" aria-label="测试结果视图">
          <button type="button" className={tab === "current" ? "active" : ""} onClick={() => setTab("current")}>本轮结果</button>
          <button type="button" className={tab === "history" ? "active" : ""} onClick={() => { setTab("history"); loadHistory(); }}><History size={14} />历史记录</button>
        </div>
        <select aria-label="结果排序" value={sort} onChange={e => setSort(e.target.value)}>
          <option value="order">默认顺序</option><option value="latency">延迟从低到高</option><option value="speed">速度从高到低</option>
        </select>
      </div>
      {tab === "history" && historyError && <p className="form-error test-context" role="alert">{historyError}</p>}
      {!visibleResults.length ? <div className="empty-state"><Gauge size={26} /><h3>{tab === "history" ? "暂无历史记录" : "暂无测试结果"}</h3></div>
        : <div className="table-wrap"><table className="srv-table test-table"><thead><tr><th>节点</th><th>状态</th><th>延迟</th><th>下载</th><th>采样量</th><th>时间 / 来源</th></tr></thead>
          <tbody>{visibleResults.map((r, i) => <tr key={`${r.runId || r.nodeId}-${i}`}>
            <td className="row-name"><strong>{r.nodeName || data.nodes.find(n => n.id === r.nodeId)?.name || r.nodeId}</strong><small className="result-mode">{r.mode === "download" ? "下载采样" : "协议验证"}</small></td>
            <td data-label="状态"><ResultState state={r.state} /></td><td data-label="延迟"><LatencyBar ms={r.latencyMs || null} /></td>
            <td data-label="下载"><strong>{r.downMbps ? `${r.downMbps.toFixed(2)} Mbps` : "—"}</strong></td>
            <td data-label="采样量">{r.bytes ? bytes(r.bytes) : "—"}</td>
            <td className="row-wide" data-label="详情"><div className="test-result-detail"><span>{r.checkedAt ? stamp(r.checkedAt) : "—"}</span><small>{r.source}</small><small>{r.detail}</small></div></td>
          </tr>)}</tbody></table></div>}
    </Glass>
    {tab === "history" && <p className="test-context">保留最近 30 天、全站最多 500 条；显示最近 100 条。</p>}
  </div>;
}
