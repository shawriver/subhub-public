import React, { useMemo, useState } from "react";
import { CircleCheck, Gauge, Loader2, Pencil, Plus, Power, RefreshCw, Server, Tags, TriangleAlert, Trash2, Upload, Waypoints } from "lucide-react";
import { Glass, IconChip, LatencyBar, Modal, PageHeading, SummaryStat } from "../ui.jsx";
import { stamp } from "../format.js";
import { latencyTone, nodeHealthOf, nodeSummary } from "../model.js";
import { deleteRecord, importNodes, importPreview, saveRecord } from "../api.js";
import { NodeEditor } from "../record-forms.jsx";
import { measureClientLatency } from "../client-probe.js";

/* Node management and one-click latency checks from the current device. */

const FILTERS = [["all", "全部"], ["healthy", "健康"], ["problem", "异常"], ["pending", "未测"]];
const HEALTH_LABEL = { ok: "可达", problem: "异常", pending: "未测" };

function serverNameOf(data, node) {
  const s = (data.servers || []).find(x => x.id === node.serverId);
  return s ? s.name : (node.serverId || "未分配服务器");
}

function healthBadge(state) {
  if (state === "verified") return <span className="badge badge-ok">已验证</span>;
  if (state === "ok") return <span className="badge badge-ok">FRM 可达</span>;
  if (state === "problem") return <span className="badge badge-bad">FRM 异常</span>;
  return <span className="badge badge-idle">未探活</span>;
}

export default function NodesPage({ data, search, onRefresh }) {
  const [filter, setFilter] = useState("all");
  const [groupBy, setGroupBy] = useState("server");
  const [groupValue, setGroupValue] = useState("all");
  const [editor, setEditor] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [actionError, setActionError] = useState("");
  const [busyToggleId, setBusyToggleId] = useState(null);
  const [testingIds, setTestingIds] = useState([]);
  const [clientLatencies, setClientLatencies] = useState({});
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [impServerId, setImpServerId] = useState("");
  const [impContent, setImpContent] = useState("");
  const [impPreview, setImpPreview] = useState(null);
  const [impError, setImpError] = useState("");
  const [impBusy, setImpBusy] = useState("");

  const summary = useMemo(() => nodeSummary(data), [data]);
  const rows = useMemo(() => (data.nodes || []).map(n => nodeHealthOf(data, n)), [data]);

  const counts = useMemo(() => ({
    all: rows.length,
    healthy: rows.filter(r => r.state === "ok").length,
    problem: rows.filter(r => r.state === "problem").length,
    pending: rows.filter(r => r.state === "pending").length
  }), [rows]);

  const q = (search || "").trim().toLowerCase();
  const serverOptions = useMemo(() => (data.servers || []).map(s => ({
    value: s.id, label: s.name, count: rows.filter(r => r.node.serverId === s.id).length
  })).filter(x => x.count > 0), [data.servers, rows]);
  const protocolOptions = useMemo(() => {
    const counts = new Map();
    for (const r of rows) {
      const protocol = String(r.node.protocol || "未知").toUpperCase();
      counts.set(protocol, (counts.get(protocol) || 0) + 1);
    }
    return [...counts.entries()].map(([value, count]) => ({ value, label: value, count })).sort((a, b) => a.value.localeCompare(b.value));
  }, [rows]);
  const groupOptions = groupBy === "protocol" ? protocolOptions : serverOptions;
  const groupField = groupBy === "protocol" ? "protocol" : "serverId";
  const groupLabel = groupBy === "protocol" ? "协议" : "服务器";
  const nodeMatchesGroup = (node, value) => {
    if (value === "all") return true;
    if (groupBy === "protocol") return String(node.protocol || "未知").toUpperCase() === value;
    return node.serverId === value;
  };
  const list = rows.filter(r => {
    const n = r.node;
    if (!nodeMatchesGroup(n, groupValue)) return false;
    if (filter === "healthy" && r.state !== "ok") return false;
    if (filter === "problem" && r.state !== "problem") return false;
    if (filter === "pending" && r.state !== "pending") return false;
    if (!q) return true;
    return `${n.name} ${serverNameOf(data, n)} ${n.protocol}`.toLowerCase().includes(q);
  });

  const detailRow = rows.find(r => r.node.id === detailId) || null;

  const isTesting = (node) => testingIds.includes(node.id);

  const testLatencies = async (nodes) => {
    const ids = [...new Set((nodes || []).filter(node => node.enabled).map(node => node.id))];
    if (!ids.length || testingIds.length) return;
    const byID = new Map((nodes || []).filter(node => node.enabled).map(node => [node.id, node]));
    setTestingIds(ids);
    setActionError("");
    try {
      let cursor = 0;
      let failed = 0;
      const worker = async () => {
        while (cursor < ids.length) {
          const node = byID.get(ids[cursor]);
          cursor += 1;
          if (!node) continue;
          try {
            const result = await measureClientLatency(node, data.nodes || []);
            setClientLatencies(previous => ({ ...previous, [node.id]: { ...result, state: "ok" } }));
          } catch (error) {
            failed += 1;
            setClientLatencies(previous => ({
              ...previous,
              [node.id]: { state: "problem", detail: error?.message || "当前设备无法连接该节点", checkedAt: new Date().toISOString() }
            }));
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
      if (failed) setActionError(`${failed} 个节点未能从当前设备测得延迟，可检查本地网络后重试。`);
    } finally {
      setTestingIds([]);
    }
  };

  const testAllLatencies = () => testLatencies((data.nodes || []).filter(node => node.enabled));

  /* ---------- 启停 / 删除 ---------- */
  const toggleNode = async (node) => {
    setBusyToggleId(node.id);
    setActionError("");
    try {
      await saveRecord("node", node.id, { ...node, enabled: !node.enabled });
      await onRefresh();
    } catch (e) {
      setActionError(e.message || "保存失败，请稍后重试");
    } finally {
      setBusyToggleId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await deleteRecord("node", deleteTarget.id);
      const deletedId = deleteTarget.id;
      setDeleteTarget(null);
      if (detailId === deletedId) setDetailId(null);
      await onRefresh();
    } catch (e) {
      setDeleteError(e.message || "删除失败，请稍后重试");
    } finally {
      setDeleteBusy(false);
    }
  };

  /* ---------- 导入 ---------- */
  const openImport = () => {
    setImpServerId(data.servers?.[0]?.id || "");
    setImpContent("");
    setImpPreview(null);
    setImpError("");
    setImpBusy("");
    setImportOpen(true);
  };

  const impBody = () => ({ serverId: impServerId, content: impContent });

  const doPreview = async () => {
    if (!impServerId) { setImpError("请先选择目标服务器"); return; }
    if (!impContent.trim()) { setImpError("请粘贴节点分享链接，每行一条"); return; }
    setImpBusy("preview");
    setImpError("");
    try {
      const result = await importPreview(impBody());
      setImpPreview(result);
    } catch (e) {
      setImpPreview(null);
      setImpError(e.message || "预览失败，请稍后重试");
    } finally {
      setImpBusy("");
    }
  };

  const doImport = async () => {
    setImpBusy("import");
    setImpError("");
    try {
      await importNodes(impBody());
      setImportOpen(false);
      await onRefresh();
    } catch (e) {
      setImpError(e.message || "导入失败，未保存任何节点");
    } finally {
      setImpBusy("");
    }
  };

  const testButtons = (node, small) => {
    const testing = isTesting(node);
    return (
      <button type="button" className={`btn ${small ? "btn-small" : ""}`} disabled={!node.enabled || testingIds.length > 0}
        aria-label={`测试 ${node.name} 延迟`} title="从当前浏览器设备向节点发起三次连接；Hysteria2/UDP 使用同服务器 TCP 入口估算"
        onClick={e => { e.stopPropagation(); testLatencies([node]); }}>
        {testing ? <Loader2 size={14} className="nd-spin" /> : <Gauge size={14} />}{testing ? "测试中…" : "测试延迟"}
      </button>
    );
  };

  const detailNode = detailRow?.node || null;
  const detailPanel = detailNode ? (data.panels || []).find(p => p.id === detailNode.panelId) : null;

  return (
    <div className="page management-page nodes-page tone-purple">
      <PageHeading icon={Waypoints} title="节点">
          <button type="button" className="btn" title="从当前浏览器设备测试全部启用节点" onClick={testAllLatencies} disabled={!data.nodes?.some(node => node.enabled) || testingIds.length > 0}>
            {testingIds.length ? <Loader2 size={15} className="nd-spin" /> : <Gauge size={15} />}{testingIds.length ? `测试中 ${testingIds.length}` : "一键测延迟"}
          </button>
          <button type="button" className="btn" onClick={onRefresh}><RefreshCw size={15} />刷新记录</button>
          <button type="button" className="btn btn-primary" onClick={openImport}><Upload size={15} />导入节点</button>
          <button type="button" className="btn" onClick={() => setEditor({})}><Plus size={15} />添加节点</button>
      </PageHeading>

      <Glass className="ribbon">
        <SummaryStat icon={Waypoints} label="全部节点" tone="purple">{data.nodes.length}</SummaryStat>
        <SummaryStat icon={Power} label="已启用" tone="blue">{summary.total}</SummaryStat>
        <SummaryStat icon={CircleCheck} label="健康" tone="green">{summary.healthy}</SummaryStat>
        <SummaryStat icon={TriangleAlert} label="异常" tone="amber">{summary.problems.length}</SummaryStat>
      </Glass>

      {actionError && <div className="notice-error" role="alert">{actionError}</div>}

      <Glass className="list-panel">
        <div className="list-toolbar">
          <div className="segmented" role="group" aria-label="健康状态筛选">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>
                {label}{key === "problem" && counts.problem > 0 && <span className="seg-count">{counts.problem}</span>}
              </button>
            ))}
          </div>
          <span className="toolbar-hint">{list.length} 个节点 · 延迟来自当前设备</span>
        </div>
        <div className="nd-group-bar">
          <div className="segmented" role="group" aria-label="节点分组方式">
            <button type="button" className={groupBy === "server" ? "active" : ""} onClick={() => { setGroupBy("server"); setGroupValue("all"); }}>
              <Server size={14} />按服务器
            </button>
            <button type="button" className={groupBy === "protocol" ? "active" : ""} onClick={() => { setGroupBy("protocol"); setGroupValue("all"); }}>
              <Tags size={14} />按协议
            </button>
          </div>
          <div className="nd-group-pills" aria-label={`按${groupLabel}筛选`}>
            <button type="button" className={groupValue === "all" ? "active" : ""} onClick={() => setGroupValue("all")}>
              全部<span>{rows.length}</span>
            </button>
            {groupOptions.map(option => (
              <button key={option.value} type="button" className={groupValue === option.value ? "active" : ""} onClick={() => setGroupValue(option.value)}>
                {option.label}<span>{option.count}</span>
              </button>
            ))}
          </div>
        </div>

        {list.length === 0
          ? <div className="empty-state"><Waypoints size={26} /><h3>{rows.length ? "没有匹配的节点" : "还没有节点"}</h3>
              <p>{rows.length ? "试试其他关键词或调整筛选条件。" : "从面板同步，或用分享链接导入节点。"}</p></div>
          : <div className="table-wrap"><table className="srv-table nd-table">
              <thead><tr>
                <th>节点</th><th>协议</th><th>服务器</th><th>启用</th><th>入口健康</th><th>设备延迟</th><th aria-label="操作" />
              </tr></thead>
              <tbody>
                {list.map(r => {
                  const n = r.node;
                  const testing = isTesting(n);
                  const client = clientLatencies[n.id];
                  return (
                    <tr key={n.id} className="click-row" onClick={() => setDetailId(n.id)}>
                      <td className="row-name"><div className="srv-cell"><IconChip icon={Waypoints} tone="purple" size={36} /><div>
                        <strong>{n.name}</strong>
                        <small className="mono">{n.host}:{n.port}</small>
                      </div></div></td>
                      <td data-label="协议"><span className="proto proto-blue">{n.protocol || "—"}</span>{n.security === "reality" && <span className="proto proto-green">REALITY</span>}</td>
                      <td data-label="服务器">{serverNameOf(data, n)}</td>
                      <td data-label="启用">
                        <button type="button" className={`nd-switch ${n.enabled ? "is-on" : ""}`} role="switch" aria-checked={n.enabled}
                          aria-label={`${n.enabled ? "停用" : "启用"}节点 ${n.name}`} disabled={busyToggleId === n.id}
                          onClick={e => { e.stopPropagation(); toggleNode(n); }}>
                          <span className="nd-switch-track"><span className="nd-switch-thumb" /></span>
                          <span>{busyToggleId === n.id ? "保存中" : n.enabled ? "已启用" : "已停用"}</span>
                        </button>
                      </td>
                      <td data-label="健康">{testing ? <span className="badge badge-warn">测试中</span> : healthBadge(r.state)}</td>
                      <td data-label="延迟">{testing
                        ? <span className="badge badge-warn">测量中</span>
                        : client?.state === "problem"
                          ? <span className="badge badge-bad" title={client.detail}>测速失败</span>
                          : <LatencyBar ms={client?.latencyMs || null} />}</td>
                      <td className="row-actions"><div className="nd-row-actions" onClick={e => e.stopPropagation()}>
                        {testButtons(n, true)}
                        <button type="button" className="icon-btn" title="编辑节点" aria-label={`编辑 ${n.name}`} onClick={() => setEditor({ node: n })}><Pencil size={16} /></button>
                        <button type="button" className="btn btn-small" onClick={() => setDetailId(n.id)}>详情</button>
                      </div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>}
      </Glass>

      {detailNode && detailRow && (
        <Modal title={detailNode.name} kicker="NODE DETAILS" onClose={() => setDetailId(null)}>
          <div className="nd-detail-badges">
            <span className="proto proto-blue">{detailNode.protocol || "—"}</span>
            {detailNode.security === "reality" && <span className="proto proto-green">REALITY</span>}
            {detailNode.enabled ? <span className="badge badge-ok">已启用</span> : <span className="badge badge-idle">已停用</span>}
            {healthBadge(detailRow.state)}
            {detailNode.managed && <span className="badge badge-warn">面板受管</span>}
          </div>

          <h3 className="nd-section-title">连接参数</h3>
          <dl className="detail-list">
            <div><dt>地址</dt><dd className="mono">{detailNode.host}:{detailNode.port}</dd></div>
            <div><dt>所属服务器</dt><dd>{serverNameOf(data, detailNode)}</dd></div>
            <div><dt>传输</dt><dd>{detailNode.transport || "tcp"}</dd></div>
            <div><dt>安全</dt><dd>{detailNode.security || "—"}</dd></div>
            <div><dt>SNI</dt><dd className="mono">{detailNode.sni || "—"}</dd></div>
            <div><dt>Flow</dt><dd className="mono">{detailNode.flow || "—"}</dd></div>
            <div><dt>ALPN</dt><dd className="mono">{detailNode.alpn || "—"}</dd></div>
            <div><dt>路径</dt><dd className="mono">{detailNode.path || "—"}</dd></div>
            <div><dt>WS Host</dt><dd className="mono">{detailNode.wsHost || "—"}</dd></div>
            <div><dt>指纹</dt><dd className="mono">{detailNode.fingerprint || "—"}</dd></div>
            <div><dt>公钥</dt><dd className="mono nd-break">{detailNode.publicKey || "—"}</dd></div>
            <div><dt>Short ID</dt><dd className="mono">{detailNode.shortId || "—"}</dd></div>
            <div><dt>标签</dt><dd>{detailNode.tags?.length ? detailNode.tags.join("、") : "—"}</dd></div>
            <div><dt>受管状态</dt><dd>{detailNode.managed
              ? `面板受管${detailPanel ? ` · ${detailPanel.name}` : detailNode.panelId ? ` · 面板 ${detailNode.panelId}` : ""}${detailNode.inboundId ? ` · 入站 #${detailNode.inboundId}` : ""}`
              : "手动维护（非面板受管）"}</dd></div>
            <div><dt>配置已应用</dt><dd>{detailNode.applied ? "是" : "否"}</dd></div>
          </dl>

          <h3 className="nd-section-title">当前设备与服务器探活</h3>
          <dl className="detail-list">
            <div><dt>当前设备延迟</dt><dd><span className="lat" style={{ color: latencyTone(clientLatencies[detailNode.id]?.latencyMs) }}>{clientLatencies[detailNode.id]?.latencyMs ? `${clientLatencies[detailNode.id].latencyMs} ms` : "—"}</span></dd></div>
            <div><dt>FRM 探活</dt><dd>{HEALTH_LABEL[detailRow.state] || detailRow.state}{detailRow.health?.checkedAt ? ` · ${stamp(detailRow.health.checkedAt)}` : ""}</dd></div>
            {clientLatencies[detailNode.id] ? (
              <>
                <div><dt>测量方式</dt><dd>{clientLatencies[detailNode.id].method === "server-tcp" ? "同服务器 TCP 入口 · 当前浏览器" : "节点入口直连 · 当前浏览器"}</dd></div>
                {clientLatencies[detailNode.id].measuresMs && <div><dt>三次样本</dt><dd>{clientLatencies[detailNode.id].measuresMs.join(" / ")} ms，取中位数</dd></div>}
                <div><dt>测试时间</dt><dd>{stamp(clientLatencies[detailNode.id].checkedAt)}</dd></div>
                <div><dt>说明</dt><dd className="nd-detail-full">{clientLatencies[detailNode.id].detail || "结果来自你当前使用的浏览器和网络，包含 TLS/TCP 建连耗时；更换网络后需要重新测试。"}</dd></div>
              </>
            ) : <div><dt>最近测试</dt><dd>尚未从当前设备测试</dd></div>}
            {detailRow.health && <div><dt>FRM 探活详情</dt><dd className="nd-detail-full">{detailRow.health.detail || "—"}</dd></div>}
          </dl>

          {isTesting(detailNode) && <p className="nd-running"><Loader2 size={14} className="nd-spin" />正在测量延迟，结果自动更新…</p>}
          {actionError && <p className="form-error nd-inline-error">{actionError}</p>}

          <div className="nd-actions">
            <button type="button" className="btn" onClick={() => { setDetailId(null); setEditor({ node: detailNode }); }}><Pencil size={15} />编辑节点</button>
            {testButtons(detailNode, false)}
          </div>
          <div className="nd-actions">
            <button type="button" className="btn" disabled={busyToggleId === detailNode.id} onClick={() => toggleNode(detailNode)}>
              {busyToggleId === detailNode.id ? <Loader2 size={14} className="nd-spin" /> : <Gauge size={14} />}{detailNode.enabled ? "停用节点" : "启用节点"}
            </button>
            <button type="button" className="btn nd-btn-danger" onClick={() => { setDeleteError(""); setDeleteTarget(detailNode); }}>
              <Trash2 size={14} />删除节点
            </button>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <Modal title="删除节点" kicker="NODE DELETE" onClose={() => !deleteBusy && setDeleteTarget(null)}>
          <p className="nd-confirm-text">确定要删除节点「{deleteTarget.name}」吗？删除后订阅中将不再包含此节点，此操作不可撤销。</p>
          {deleteError && <p className="form-error nd-inline-error">{deleteError}</p>}
          <div className="nd-actions">
            <button type="button" className="btn" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>取消</button>
            <button type="button" className="btn nd-btn-danger" disabled={deleteBusy} onClick={confirmDelete}>
              {deleteBusy ? <Loader2 size={14} className="nd-spin" /> : <Trash2 size={14} />}确认删除
            </button>
          </div>
        </Modal>
      )}

      {importOpen && (
        <Modal title="导入节点" kicker="NODE IMPORT" onClose={() => !impBusy && setImportOpen(false)}>
          <label className="field">
            <span>目标服务器</span>
            <select className="nd-select" value={impServerId} onChange={e => { setImpServerId(e.target.value); setImpPreview(null); }}>
              <option value="">请选择服务器</option>
              {(data.servers || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>分享链接（每行一条）</span>
            <textarea className="nd-textarea" rows={7} value={impContent} placeholder={"vless://…#节点名\ntrojan://…"}
              onChange={e => { setImpContent(e.target.value); setImpPreview(null); }} />
            <small>支持 vless / trojan / anytls / hysteria2 / vmess 分享链接，也可粘贴整段 Base64 订阅内容。先预览确认，再正式导入。</small>
          </label>

          {impPreview && (
            <div className="nd-preview">
              <p className="nd-preview-title">将导入 {impPreview.nodes?.length || 0} 个节点{impPreview.skipped ? ` · 跳过重复 ${impPreview.skipped} 个` : ""}</p>
              {impPreview.nodes?.length > 0 && (
                <ul className="nd-preview-list">
                  {impPreview.nodes.map(n => <li key={n.id || `${n.name}-${n.host}-${n.port}`}><strong>{n.name}</strong><span className="proto proto-blue">{n.protocol}</span><span className="mono">{n.host}:{n.port}</span></li>)}
                </ul>
              )}
              {impPreview.errors?.length > 0 && (
                <ul className="nd-error-list">
                  {impPreview.errors.map((err, i) => <li key={i}>{err.line > 0 ? `第 ${err.line} 行：` : ""}{err.message}</li>)}
                </ul>
              )}
              {impPreview.errors?.length > 0 && <p className="nd-preview-note">存在无法导入的行，修正后可重新预览；后端在有错误时不会保存任何节点。</p>}
            </div>
          )}
          {impError && <p className="form-error nd-inline-error">{impError}</p>}

          <div className="nd-actions">
            <button type="button" className="btn" disabled={!!impBusy} onClick={() => setImportOpen(false)}>取消</button>
            <button type="button" className="btn" disabled={!!impBusy} onClick={doPreview}>
              {impBusy === "preview" ? <Loader2 size={14} className="nd-spin" /> : <Gauge size={14} />}预览导入
            </button>
            <button type="button" className="btn btn-primary" disabled={!!impBusy || !impPreview || !(impPreview.nodes?.length) || (impPreview.errors?.length > 0)} onClick={doImport}>
              {impBusy === "import" ? <Loader2 size={14} className="nd-spin" /> : <Upload size={14} />}确认导入
            </button>
          </div>
        </Modal>
      )}
      {editor && <NodeEditor node={editor.node} data={data} onClose={() => setEditor(null)} onSaved={id => { setEditor(null); setDetailId(id); onRefresh(); }} />}
    </div>
  );
}
