import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2, CheckSquare2, Clock3, DatabaseBackup, Download, FileUp, History,
  CalendarDays, ListChecks, Play, RefreshCw, ScrollText, ShieldCheck, Square, TriangleAlert, Trash2, X
} from "lucide-react";
import { Glass, IconChip, Modal, PageHeading, SummaryStat } from "../ui.jsx";
import { bytes, stamp } from "../format.js";
import {
  backupAction, deleteRecord, deleteTaskRecords, getAudit, getSecurity,
  getSyncSettings, setObserveMode, triggerSync
} from "../api.js";

/* Tasks & backup page (M2): panel sync (observe mode + manual trigger),
   the task record list, the audit log, and local backups. Backup actions
   are proof-gated on the backend (admin password + TOTP when enabled),
   so each one goes through the shared verification modal below. */

const STATUS_META = {
  success: ["badge-ok", "成功"],
  failed: ["badge-bad", "失败"],
  running: ["tk-badge-run", "运行中"],
  queued: ["badge-idle", "排队中"]
};

const KIND_LABELS = {
  sync: "同步",
  backup: "备份",
  fetch_retention: "记录清理",
  "node-alert": "节点告警",
  "check-updates": "检查更新",
  "system-update": "系统更新",
  "host-reboot": "主机重启",
  "proxy-restart": "代理重启"
};

const BACKUP_STATUS = {
  verified: ["badge-ok", "校验通过"],
  empty: ["badge-warn", "内容为空"],
  invalid: ["badge-bad", "校验失败"],
  unreadable: ["badge-bad", "无法读取"],
  unchecked: ["badge-idle", "未校验"]
};

const ROUND_LABELS = { add: "新增", update: "更新", revoke: "撤销" };
const RETENTION_TASK_ID = "fetch-retention-latest";

function timeText(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : stamp(value);
}

function shanghaiDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function countsText(counts) {
  const entries = Object.entries(counts || {}).filter(([, v]) => Number(v) > 0);
  if (!entries.length) return "无记录";
  return entries.map(([k, v]) => `${k} ${v}`).join(" · ");
}

function TaskStatus({ status }) {
  const [cls, label] = STATUS_META[status] || ["badge-idle", status || "未知"];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function BackupStatus({ status }) {
  const [cls, label] = BACKUP_STATUS[status] || ["badge-idle", status || "未知"];
  return <span className={`badge ${cls}`}>{label}</span>;
}

/* ---------- verification modal for the three backup actions ---------- */

const VERIFY_TITLES = {
  now: ["立即备份", "LOCAL BACKUP"],
  export: ["下载加密备份", "ENCRYPTED EXPORT"],
  restore: ["从备份恢复", "RESTORE"]
};

function VerifyModal({ action, totpEnabled, onClose, onBackupDone }) {
  const [title, kicker] = VERIFY_TITLES[action];
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [fileName, setFileName] = useState("");
  const [content, setContent] = useState("");
  const [preview, setPreview] = useState(null);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const fileRef = useRef(null);

  const proof = () => ({ password, ...(totpEnabled ? { code } : {}) });
  const passphraseBytes = new TextEncoder().encode(passphrase).length;
  const passphraseOk = passphraseBytes >= 14 && passphraseBytes <= 128;

  async function guard(fn) {
    setBusy(true);
    setError("");
    try { await fn(); } catch (e) { setError(e.message || "操作失败，请稍后重试"); } finally { setBusy(false); }
  }

  const runNow = () => guard(async () => {
    await backupAction("now", proof());
    onBackupDone();
  });

  const runExport = () => guard(async () => {
    if (!passphraseOk) throw new Error("备份口令需 14–128 字节");
    const r = await backupAction("export", { ...proof(), passphrase });
    const blob = new Blob([r.content], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = r.filename || "subhub-backup.shb";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setDone(`加密备份已下载（${r.filename || "subhub-backup.shb"}）。恢复时需要同一个口令，请妥善保管。`);
  });

  const pickFile = e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setFileName(f.name);
    setPreview(null);
    setConfirmText("");
    setError("");
    f.text().then(t => setContent(t)).catch(() => setError("备份文件读取失败"));
  };

  const runPreview = () => guard(async () => {
    if (!content) throw new Error("请先选择备份文件");
    if (!passphraseOk) throw new Error("备份口令需 14–128 字节");
    const r = await backupAction("preview", { ...proof(), content, passphrase });
    setPreview(r);
  });

  const runRestore = () => guard(async () => {
    if (!preview) throw new Error("请先预览备份");
    if (confirmText !== "恢复") throw new Error("请输入“恢复”二字确认");
    await backupAction("restore", {
      ...proof(), content, passphrase, confirm: "恢复", digest: preview.digest
    });
    // Backend answers {loginRequired:true}; either way the session is over.
    setDone("恢复完成，请重新登录");
  });

  if (done) {
    return (
      <Modal title={title} kicker={kicker} onClose={onClose}>
        <div className="tk-done">
          <CheckCircle2 size={30} />
          <p>{done}</p>
          {action === "restore"
            ? <button type="button" className="btn btn-primary" onClick={() => {
                window.dispatchEvent(new Event("subhub-session-expired"));
                onClose();
              }}>重新登录</button>
            : <button type="button" className="btn" onClick={onClose}>关闭</button>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} kicker={kicker} onClose={onClose}>
      <p className="tk-verify-hint"><ShieldCheck size={14} />此操作需验证管理员身份，验证信息只发送给后端，不会保存。</p>

      <label className="field">
        <span>管理员密码</span>
        <input type="password" autoComplete="current-password" value={password}
          onChange={e => setPassword(e.target.value)} placeholder="输入当前管理员密码" />
      </label>
      {totpEnabled && (
        <label className="field">
          <span>二步验证码</span>
          <input type="text" inputMode="numeric" autoComplete="one-time-code" value={code}
            onChange={e => setCode(e.target.value)} placeholder="验证器中的 6 位验证码" />
        </label>
      )}

      {(action === "export" || action === "restore") && (
        <label className="field">
          <span>备份口令</span>
          <input type="password" autoComplete="new-password" value={passphrase}
            onChange={e => { setPassphrase(e.target.value); if (action === "restore") { setPreview(null); setConfirmText(""); } }}
            placeholder="至少 14 字节" />
          <small>口令不保存，恢复时需要同一个口令。当前 {passphraseBytes} 字节{passphrase && !passphraseOk ? "，长度不足或超限" : ""}。</small>
        </label>
      )}

      {action === "restore" && (
        <>
          <div className="field">
            <span>备份文件</span>
            <div className="tk-file-row">
              <button type="button" className="btn btn-small" onClick={() => fileRef.current && fileRef.current.click()}>
                <FileUp size={14} />选择备份文件
              </button>
              <span className="muted">{fileName || "尚未选择 .shb 备份文件"}</span>
              <input ref={fileRef} type="file" accept=".shb,text/plain" hidden onChange={pickFile} />
            </div>
            <small>恢复会先自动备份当前数据，再用所选备份整体替换；恢复后需要重新登录。</small>
          </div>

          {preview && (
            <dl className="detail-list tk-preview">
              <div><dt>备份创建时间</dt><dd>{timeText(preview.created)}</dd></div>
              <div><dt>内容计数</dt><dd className="mono">{countsText(preview.counts)}</dd></div>
              <div><dt>摘要</dt><dd className="mono tk-digest" title={preview.digest}>{preview.digest}</dd></div>
            </dl>
          )}

          {preview && (
            <label className="field">
              <span>确认恢复</span>
              <input type="text" value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="输入“恢复”二字确认" />
            </label>
          )}
        </>
      )}

      {error && <p className="form-error">{error}</p>}

      <div className="tk-modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>取消</button>
        {action === "now" && (
          <button type="button" className="btn btn-primary" onClick={runNow} disabled={busy || !password}>
            <DatabaseBackup size={15} />{busy ? "备份中…" : "验证并立即备份"}
          </button>
        )}
        {action === "export" && (
          <button type="button" className="btn btn-primary" onClick={runExport} disabled={busy || !password || !passphraseOk}>
            <Download size={15} />{busy ? "生成中…" : "验证并下载"}
          </button>
        )}
        {action === "restore" && !preview && (
          <button type="button" className="btn btn-primary" onClick={runPreview} disabled={busy || !password || !content || !passphraseOk}>
            {busy ? "校验中…" : "验证并预览备份"}
          </button>
        )}
        {action === "restore" && preview && (
          <button type="button" className="btn btn-primary" onClick={runRestore} disabled={busy || confirmText !== "恢复"}>
            {busy ? "恢复中…" : "确认恢复"}
          </button>
        )}
      </div>
    </Modal>
  );
}

/* ---------- page ---------- */

export default function TasksPage({ data, search, onRefresh }) {
  const tasks = useMemo(() => data.tasks || [], [data]);
  const serverNames = useMemo(() => {
    const m = new Map();
    (data.servers || []).forEach(s => m.set(s.id, s.name));
    return m;
  }, [data]);

  /* --- sync card --- */
  const [sync, setSync] = useState(null);
  const [syncErr, setSyncErr] = useState("");
  const [obsBusy, setObsBusy] = useState(false);
  const [trigBusy, setTrigBusy] = useState(false);
  const [syncNote, setSyncNote] = useState("");

  const loadSync = async () => {
    try { setSync(await getSyncSettings()); setSyncErr(""); }
    catch (e) { setSyncErr(e.message || "同步设置加载失败"); }
  };
  useEffect(() => { loadSync(); }, []);

  const toggleObserve = async v => {
    setObsBusy(true);
    setSyncNote("");
    try {
      const r = await setObserveMode(v);
      setSync(s => ({ ...(s || {}), observeMode: r && typeof r.observeMode === "boolean" ? r.observeMode : v }));
      setSyncNote(v ? "观察模式已开启" : "观察模式已关闭，同步将真正修改面板");
      loadAudit();
    } catch (e) { setSyncNote(e.message || "保存失败"); }
    finally { setObsBusy(false); }
  };

  const runSyncNow = async () => {
    setTrigBusy(true);
    setSyncNote("");
    try {
      await triggerSync();
      setSyncNote("已排队，同步将在后台执行");
      onRefresh();
    } catch (e) { setSyncNote(e.message || "排队失败"); }
    finally { setTrigBusy(false); }
  };

  /* --- task list --- */
  const [expanded, setExpanded] = useState(() => new Set());
  const toggleExpanded = id => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const [delTarget, setDelTarget] = useState(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState("");
  const [pageNote, setPageNote] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [batchTarget, setBatchTarget] = useState(null);
  const [batchMode, setBatchMode] = useState(false);

  const today = shanghaiDay(new Date());
  const failedCount = tasks.filter(t => t.status === "failed").length;
  const todayCount = tasks.filter(t => shanghaiDay(t.created) === today).length;
  const activeCount = tasks.filter(t => t.status === "running" || t.status === "queued").length;

  const q = (search || "").trim().toLowerCase();
  const list = tasks.filter(t => {
    if (!q) return true;
    return `${t.name || ""} ${t.detail || ""}`.toLowerCase().includes(q);
  });
  const selectable = list.filter(t => !VALID_AGENT_KINDS.has(t.kind));
  const selectedVisible = selectable.filter(t => selected.has(t.id));
  const allSelected = selectable.length > 0 && selectedVisible.length === selectable.length;

  const toggleSelected = id => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(prev => {
    const next = new Set(prev);
    for (const t of selectable) {
      if (allSelected) next.delete(t.id); else next.add(t.id);
    }
    return next;
  });
  const doBatchDelete = async () => {
    if (!batchTarget?.length) return;
    setDelBusy(true);
    setDelErr("");
    try {
      const result = await deleteTaskRecords(batchTarget.map(t => t.id));
      setBatchTarget(null);
      setSelected(new Set());
      setBatchMode(false);
      setPageNote(`已删除 ${result.deleted || 0} 条任务记录${result.skipped ? `，${result.skipped} 条受保护记录未删除` : ""}`);
      await onRefresh();
    } catch (e) {
      setDelErr(e.message || "批量删除失败");
    } finally {
      setDelBusy(false);
    }
  };

  const doDelete = async () => {
    if (!delTarget) return;
    setDelBusy(true);
    setDelErr("");
    try {
      await deleteRecord("task", delTarget.id);
      setDelTarget(null);
      setPageNote(`已删除任务记录「${delTarget.name || delTarget.id}」`);
      onRefresh();
    } catch (e) { setDelErr(e.message || "删除失败"); }
    finally { setDelBusy(false); }
  };

  const closeBatchMode = () => {
    setBatchMode(false);
    setSelected(new Set());
    setDelErr("");
  };

  /* --- audit card --- */
  const [audit, setAudit] = useState(null);
  const [auditErr, setAuditErr] = useState("");
  const [auditBusy, setAuditBusy] = useState(false);
  const loadAudit = async () => {
    setAuditBusy(true);
    try { const rows = await getAudit(); setAudit(Array.isArray(rows) ? rows : []); setAuditErr(""); }
    catch (e) { setAuditErr(e.message || "审计日志加载失败"); }
    finally { setAuditBusy(false); }
  };
  useEffect(() => { loadAudit(); }, []);

  /* --- backup card --- */
  const [security, setSecurity] = useState(null);
  const [secErr, setSecErr] = useState("");
  const [backupNote, setBackupNote] = useState("");
  const [verifyAction, setVerifyAction] = useState(null);
  const loadSecurity = async () => {
    try { setSecurity(await getSecurity()); setSecErr(""); }
    catch (e) { setSecErr(e.message || "备份信息加载失败"); }
  };
  useEffect(() => { loadSecurity(); }, []);

  const roundEntries = sync && sync.lastRound ? Object.entries(sync.lastRound) : [];

  return (
    <div className="page management-page tasks-page tone-amber">
      <PageHeading icon={ListChecks} title="任务与备份" description="监控同步状态、处理任务记录，并管理审计日志与加密备份">
        <button type="button" className="btn" onClick={onRefresh}><RefreshCw size={15} />刷新记录</button>
      </PageHeading>

      <Glass className="ribbon tk-overview">
        <SummaryStat icon={ListChecks} label="任务总数" tone="amber">{tasks.length}</SummaryStat>
        <SummaryStat icon={Clock3} label="进行中" tone="blue">{activeCount}</SummaryStat>
        <SummaryStat icon={TriangleAlert} label="失败" tone="red">{failedCount}</SummaryStat>
        <SummaryStat icon={CalendarDays} label="今日执行" tone="green">{todayCount}</SummaryStat>
      </Glass>

      <div className="tk-control-grid">
        <Glass className="task-sync-card tone-blue">
          <header className="tk-section-head">
            <div className="wide-title"><IconChip icon={RefreshCw} tone="blue" size={34} />面板同步</div>
            <button type="button" className="btn btn-small btn-primary" onClick={runSyncNow} disabled={trigBusy}>
              <Play size={14} />{trigBusy ? "排队中…" : "立即同步"}
            </button>
          </header>
          {syncErr
            ? <p className="form-error tk-mt-sm">同步设置加载失败：{syncErr} <button type="button" className="tk-link" onClick={loadSync}>重试</button></p>
            : !sync
              ? <p className="muted tk-mt-sm">加载同步设置中…</p>
              : <>
                  <div className="tk-mode-line">
                    <div>
                      <strong>{sync.observeMode ? "观察模式已开启" : "同步正在真实执行"}</strong>
                      <span>{sync.observeMode ? "只记录将执行的操作，不修改面板" : "按用户分配与用量新增、更新或撤销面板客户端"}</span>
                    </div>
                    <button type="button" role="switch" aria-checked={!!sync.observeMode} aria-label="观察模式开关"
                      className={`tk-switch ${sync.observeMode ? "on" : ""}`} disabled={obsBusy}
                      onClick={() => toggleObserve(!sync.observeMode)}><span /></button>
                  </div>
                  <div className="tk-sync-foot">
                    <span><Clock3 size={13} />{timeText(sync.lastRoundAt)}</span>
                    <div className="tk-chips">
                      {roundEntries.length > 0
                        ? roundEntries.map(([k, v]) => <span key={k} className="tk-chip">{ROUND_LABELS[k] || k} {v}</span>)
                        : <span className="muted">本轮没有待执行操作</span>}
                    </div>
                  </div>
                  {syncNote && <p className="auth-info tk-mt-sm">{syncNote}</p>}
                </>}
        </Glass>

        <Glass className="task-backup-card tone-green">
          <header className="tk-section-head">
            <div className="wide-title"><IconChip icon={DatabaseBackup} tone="green" size={34} />备份与恢复</div>
            <button type="button" className="btn btn-small" onClick={loadSecurity} disabled={!security}><RefreshCw size={13} />刷新</button>
          </header>
          {secErr
            ? <p className="form-error">备份信息加载失败：{secErr} <button type="button" className="tk-link" onClick={loadSecurity}>重试</button></p>
            : !security
              ? <p className="muted">加载备份信息中…</p>
              : <>
                  <div className="tk-backup-summary">
                    <div><span>备份计划</span><strong>{security.backupSchedule || "未记录"}</strong></div>
                    <div><span>可用快照</span><strong>{(security.backups || []).length}</strong></div>
                    <span className={`badge ${security.totpEnabled ? "badge-ok" : "badge-idle"}`}>{security.totpEnabled ? "二步验证已启用" : "二步验证未启用"}</span>
                  </div>
                  {(security.backups || []).length > 0 && <div className="tk-backup-latest">
                    <span>最近快照</span><strong className="mono">{security.backups[0].name}</strong>
                    <small>{security.backups[0].createdAt ? timeText(security.backups[0].createdAt) : "创建时间未知"} · {bytes(security.backups[0].size)}</small>
                  </div>}
                  <div className="tk-backup-actions">
                    <button type="button" className="btn btn-primary" onClick={() => { setBackupNote(""); setVerifyAction("now"); }}><DatabaseBackup size={15} />立即备份</button>
                    <button type="button" className="btn" onClick={() => { setBackupNote(""); setVerifyAction("export"); }}><Download size={15} />导出</button>
                    <button type="button" className="btn" onClick={() => { setBackupNote(""); setVerifyAction("restore"); }}><FileUp size={15} />恢复</button>
                  </div>
                  {backupNote && <p className="auth-info tk-mt-sm">{backupNote}</p>}
                </>}
        </Glass>
      </div>

      <Glass className="list-panel tk-task-panel">
        <div className="list-toolbar">
          <span className="wide-title"><IconChip icon={ListChecks} tone="amber" size={30} />任务记录</span>
          <span className="tk-task-tools">
            <span className="toolbar-hint">{list.length} 条{q ? "（已按搜索过滤）" : ""}</span>
            {batchMode ? (
              <>
                <span className="toolbar-hint tk-selected-count">{selected.size ? `已选 ${selected.size} 条` : "选择要删除的记录"}</span>
                <button type="button" className="btn btn-small tk-btn-danger" disabled={!selectedVisible.length}
                  onClick={() => { setBatchTarget(selectedVisible); setDelErr(""); }}>
                  <Trash2 size={13} />批量删除
                </button>
                <button type="button" className="btn btn-small" onClick={closeBatchMode} title="退出批量管理">
                  <X size={14} />取消
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-small" disabled={!selectable.length} onClick={() => setBatchMode(true)}>
                <ListChecks size={14} />批量删除
              </button>
            )}
          </span>
        </div>
        {pageNote && <p className="auth-info tk-inline-note">{pageNote}</p>}
        {batchMode && (
          <div className="tk-batch-note">
            <CheckSquare2 size={15} />
            <span>可删除记录会显示复选框；主机更新、重启和代理重启记录受保护。</span>
            <button type="button" className="tk-link" onClick={toggleAll} disabled={!selectable.length}>
              {allSelected ? "取消全选" : "全选当前列表"}
            </button>
          </div>
        )}

        {list.length === 0
          ? <div className="empty-state"><ListChecks size={26} /><h3>{tasks.length ? "没有匹配的记录" : "还没有任务记录"}</h3>
              <p>{tasks.length ? "试试其他关键词。" : "同步、备份与清理等后台任务执行后会出现在这里。"}</p></div>
          : <div className="table-wrap"><table className="srv-table tk-table">
              <thead><tr>
                {batchMode && <th className="tk-check-cell" aria-label="批量选择" />}
                <th>名称</th><th>类型</th><th>状态</th><th>详情</th><th>关联服务器</th><th>创建时间</th><th aria-label="操作" />
              </tr></thead>
              <tbody>
                {list.map(t => {
                  const detail = t.detail || "";
                  const isOpen = expanded.has(t.id);
                  const long = detail.length > 90;
                  const protectedTask = VALID_AGENT_KINDS.has(t.kind);
                  return (
                    <tr key={t.id} className={selected.has(t.id) ? "tk-row-selected" : ""}>
                      {batchMode && (
                        <td className="tk-check-cell">
                          <button type="button" className={`tk-check-button ${selected.has(t.id) ? "checked" : ""}`}
                            aria-label={`${selected.has(t.id) ? "取消选择" : "选择"}任务 ${t.name || t.id}`}
                            aria-pressed={selected.has(t.id)} disabled={protectedTask}
                            title={protectedTask ? "主机类任务记录受保护" : undefined}
                            onClick={() => toggleSelected(t.id)}>
                            {selected.has(t.id) ? <CheckSquare2 size={18} /> : <Square size={18} />}
                          </button>
                        </td>
                      )}
                      <td><div className="tk-name-cell">
                        <strong>{t.name || t.id}</strong>
                        {t.kind === "fetch_retention" && t.id === RETENTION_TASK_ID && <span className="tag tag-green">保留 90 天</span>}
                      </div></td>
                      <td><span className="muted">{KIND_LABELS[t.kind] || t.kind || "—"}</span></td>
                      <td><TaskStatus status={t.status} /></td>
                      <td data-label="详情"><div className="tk-detail">
                        <span className={isOpen ? "" : "tk-clamp"}>{detail || "—"}</span>
                        {long && <button type="button" className="tk-link" onClick={() => toggleExpanded(t.id)}>{isOpen ? "收起" : "展开"}</button>}
                      </div></td>
                      <td data-label="关联服务器">{t.serverId
                        ? <span>{serverNames.get(t.serverId) || "未知服务器"}</span>
                        : <span className="muted">—</span>}</td>
                      <td data-label="创建时间"><span className="tk-time">{timeText(t.created)}</span></td>
                      <td className="tk-row-actions"><button type="button" className="btn btn-small" aria-label={`删除任务 ${t.name || t.id}`}
                        onClick={() => { setDelTarget(t); setDelErr(""); }}>
                        <Trash2 size={13} />删除</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>}
      </Glass>

      <Glass className="task-audit-card tone-purple tk-audit-section">
        <header className="settings-head">
          <div><h3>审计日志</h3><p>最近 50 条管理操作记录</p></div>
          <div className="tk-section-head-actions"><button type="button" className="btn btn-small" onClick={loadAudit} disabled={auditBusy}>
            <History size={14} />{auditBusy ? "刷新中…" : "刷新"}
          </button><IconChip icon={ScrollText} tone="purple" size={38} /></div>
        </header>
        {auditErr
          ? <p className="form-error">审计日志加载失败：{auditErr}</p>
          : !audit
            ? <p className="muted">加载审计日志中…</p>
            : audit.length === 0
              ? <p className="muted">暂无审计记录。</p>
              : <div className="tk-scroll"><table className="srv-table tk-audit-table">
                  <thead><tr><th>时间</th><th>动作</th><th>对象</th></tr></thead>
                  <tbody>
                    {audit.map((row, i) => (
                      <tr key={`${row.at}-${row.action}-${i}`}>
                        <td><span className="tk-time">{timeText(row.at)}</span></td>
                        <td><span className="mono tk-action">{row.action}</span></td>
                        <td>{row.target || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>}
      </Glass>


      {verifyAction && security && (
        <VerifyModal
          action={verifyAction}
          totpEnabled={!!security.totpEnabled}
          onClose={() => setVerifyAction(null)}
          onBackupDone={() => {
            setVerifyAction(null);
            setBackupNote("立即备份完成，备份列表已刷新。");
            loadSecurity();
            onRefresh();
          }}
        />
      )}

      {delTarget && (
        <Modal title="删除任务记录" kicker="DELETE TASK" onClose={() => !delBusy && setDelTarget(null)}>
          <p className="tk-confirm-text">
            确定删除任务记录「{delTarget.name || delTarget.id}」吗？此操作不可恢复。
            {delTarget.kind && VALID_AGENT_KINDS.has(delTarget.kind) ? "该记录属于主机类任务，后端可能会拒绝删除。" : ""}
          </p>
          {delErr && <p className="form-error">{delErr}</p>}
          <div className="tk-modal-actions">
            <button type="button" className="btn" onClick={() => setDelTarget(null)} disabled={delBusy}>取消</button>
            <button type="button" className="btn tk-btn-danger" onClick={doDelete} disabled={delBusy}>
              <Trash2 size={14} />{delBusy ? "删除中…" : "确认删除"}
            </button>
          </div>
        </Modal>
      )}
      {batchTarget && (
        <Modal title="批量删除任务记录" kicker="DELETE TASKS" onClose={() => !delBusy && setBatchTarget(null)}>
          <p className="tk-confirm-text">确定删除已选择的 {batchTarget.length} 条任务记录吗？此操作不可恢复。</p>
          <p className="setting-hint">主机更新、重启和代理重启类记录受保护，不会进入批量删除范围。</p>
          {delErr && <p className="form-error">{delErr}</p>}
          <div className="tk-modal-actions">
            <button type="button" className="btn" onClick={() => setBatchTarget(null)} disabled={delBusy}>取消</button>
            <button type="button" className="btn tk-btn-danger" onClick={doBatchDelete} disabled={delBusy}>
              <Trash2 size={14} />{delBusy ? "删除中…" : `删除 ${batchTarget.length} 条`}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const VALID_AGENT_KINDS = new Set(["check-updates", "system-update", "host-reboot", "proxy-restart"]);
