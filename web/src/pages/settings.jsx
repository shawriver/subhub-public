import React, { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, ExternalLink, Eye, EyeOff, Globe, KeyRound, Link2, LogOut, Palette, RefreshCw, RotateCcw, Server, ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
import { Glass } from "../ui.jsx";
import { ACCENT_PRESETS, THEME_DEFAULTS, syncAppearance } from "../theme.js";
import { api, bindKomari, getPublicSettings, getSecurity, newRecordId, savePublicSettings, securityAction, triggerSync } from "../api.js";
import { stamp } from "../format.js";

function AppearanceCard({ theme, updateTheme }) {
  const modes = [["light", "浅色"], ["dark", "深色"], ["system", "跟随系统"]];
  return (
    <Glass className="settings-card">
      <header className="settings-head">
        <div><h3>界面外观</h3><p>主题、主色和背景，即时保存</p></div>
        <Palette size={19} />
      </header>

      <div className="setting-block">
        <span className="setting-label">外观模式</span>
        <div className="theme-options" role="group" aria-label="外观模式">
          {modes.map(([key, label]) => (
            <button key={key} type="button" className={`theme-option ${theme.appearance === key ? "active" : ""}`}
              aria-label={label} aria-pressed={theme.appearance === key} onClick={() => updateTheme({ appearance: key })}>
              <span className={`theme-sample theme-sample-${key}`} aria-hidden="true">
                <span className="theme-sample-nav"><i /><i /><i /><i /></span>
                <span className="theme-sample-main"><span className="theme-sample-bar" /><span className="theme-sample-cards"><i /><i /><i /></span><span className="theme-sample-chart"><i /><i /><i /><i /><i /><i /><i /></span></span>
              </span>
              <span className="theme-option-label">{label}<span className="theme-option-check" aria-hidden="true">{theme.appearance === key && <Check size={12} />}</span></span>
            </button>
          ))}
        </div>
      </div>

      <div className="setting-block">
        <span className="setting-label">主色</span>
        <div className="accent-row" role="group" aria-label="主色">
          {ACCENT_PRESETS.map(([value, label]) => (
            <button key={value} type="button" className={`accent-swatch ${theme.accent === value ? "active" : ""}`}
              style={{ "--swatch": value }} aria-label={`主色 ${label}`} aria-pressed={theme.accent === value} title={label}
              onClick={() => updateTheme({ accent: value })}><span className="accent-swatch-color" aria-hidden="true">{theme.accent === value && <Check size={15} />}</span><span>{label}</span></button>
          ))}
          <label className="accent-custom"><input type="color" aria-label="自定义主色" value={theme.accent} onChange={e => updateTheme({ accent: e.target.value })} /><span>自定义</span></label>
        </div>
      </div>

      <div className="st-section st-wallpaper-fields field-grid">
        <label className="field">
          <span>背景壁纸</span>
          <input type="text" placeholder="留空使用纯色背景" value={theme.background}
            onChange={e => updateTheme({ background: e.target.value.trim() })} />
          <small>默认使用樱花壁纸。支持本站路径或 data: 链接。</small>
        </label>
        <label className="field">
          <span>壁纸表面不透明度 · {theme.surfaceOpacity}%</span>
          <input type="range" min="30" max="100" step="1" value={theme.surfaceOpacity}
            disabled={!theme.background}
            onChange={e => updateTheme({ surfaceOpacity: Number(e.target.value) })} />
          <small>{theme.background ? "调整壁纸上方卡片的透明效果。" : "设置壁纸后可调整。"}</small>
        </label>
      </div>

      <div className="st-section">
        <h4 className="setting-label">品牌与工作区</h4>
        <div className="field-grid">
          <label className="field"><span>品牌名称</span><input type="text" value={theme.brandName} onChange={e => updateTheme({ brandName: e.target.value })} /></label>
          <label className="field"><span>品牌副标题</span><input type="text" value={theme.brandSub} onChange={e => updateTheme({ brandSub: e.target.value })} /></label>
          <label className="field"><span>工作区名称</span><input type="text" value={theme.workspace} onChange={e => updateTheme({ workspace: e.target.value })} /></label>
          <label className="field"><span>Logo 图片链接</span><input type="url" placeholder="留空使用默认标记" value={theme.logoUrl} onChange={e => updateTheme({ logoUrl: e.target.value.trim() })} /></label>
        </div>
      </div>

      <div className="settings-foot">
        <button type="button" className="btn" onClick={() => updateTheme({ ...THEME_DEFAULTS })}><RotateCcw size={15} />恢复默认</button>
      </div>
    </Glass>
  );
}

function SecurityCard({ onLogout }) {
  const [security, setSecurity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [curPw, setCurPw] = useState("");
  const [pwCode, setPwCode] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState("");

  const [startPw, setStartPw] = useState("");
  const [totpSetup, setTotpSetup] = useState(null);
  const [totpCode, setTotpCode] = useState("");
  const [totpBusy, setTotpBusy] = useState(false);
  const [totpError, setTotpError] = useState("");

  const [disPw, setDisPw] = useState("");
  const [disCode, setDisCode] = useState("");
  const [disBusy, setDisBusy] = useState(false);
  const [disError, setDisError] = useState("");

  useEffect(() => {
    let alive = true;
    getSecurity()
      .then(v => { if (alive) { setSecurity(v); setLoading(false); } })
      .catch(e => { if (alive) { setLoadError(e.message || "安全设置加载失败"); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  const totpEnabled = !!security?.totpEnabled;

  const submitPassword = async e => {
    e.preventDefault();
    if (pwBusy) return;
    if ([...newPw].length < 14) { setPwError("新密码至少需要 14 个字符"); return; }
    setPwBusy(true); setPwError("");
    try {
      const res = await securityAction("password", { password: curPw, code: totpEnabled ? pwCode.trim() : "", newPassword: newPw });
      if (res?.loginRequired) { onLogout(); return; }
      setCurPw(""); setPwCode(""); setNewPw("");
    } catch (err) { setPwError(err.message); } finally { setPwBusy(false); }
  };

  const startTotp = async e => {
    e.preventDefault();
    if (totpBusy) return;
    setTotpBusy(true); setTotpError("");
    try {
      const res = await securityAction("totp/start", { password: startPw, code: "" });
      let qr = "";
      try { qr = await QRCode.toDataURL(res.uri, { width: 220, margin: 1 }); } catch { /* 二维码生成失败时仍可手动输入密钥 */ }
      setTotpSetup({ secret: res.secret, uri: res.uri, qr });
      setTotpCode("");
    } catch (err) { setTotpError(err.message); } finally { setTotpBusy(false); }
  };

  const enableTotp = async e => {
    e.preventDefault();
    if (totpBusy) return;
    if (!/^\d{6}$/.test(totpCode.trim())) { setTotpError("请输入认证器上的 6 位验证码"); return; }
    setTotpBusy(true); setTotpError("");
    try {
      const res = await securityAction("totp/enable", { password: startPw, code: totpCode.trim() });
      if (res?.loginRequired) { onLogout(); return; }
      setTotpSetup(null); setStartPw("");
    } catch (err) { setTotpError(err.message); } finally { setTotpBusy(false); }
  };

  const disableTotp = async e => {
    e.preventDefault();
    if (disBusy) return;
    if (!/^\d{6}$/.test(disCode.trim())) { setDisError("请输入当前 6 位验证码"); return; }
    setDisBusy(true); setDisError("");
    try {
      const res = await securityAction("totp/disable", { password: disPw, code: disCode.trim() });
      if (res?.loginRequired) { onLogout(); return; }
      setDisPw(""); setDisCode("");
    } catch (err) { setDisError(err.message); } finally { setDisBusy(false); }
  };

  return (
    <Glass className="settings-card">
      <header className="settings-head">
        <div><h3>账户安全</h3><p>管理员密码与二步验证</p></div>
        <KeyRound size={19} />
      </header>

      {loading && <p className="muted">正在加载安全设置…</p>}
      {loadError && <p className="form-error" role="alert">{loadError}</p>}

      {security && (
        <>
          <div className="setting-row">
            <div><strong>二步验证</strong><span>登录时需要认证器 App 的 6 位验证码</span></div>
            {totpEnabled
              ? <span className="badge badge-ok">已启用</span>
              : <span className="badge badge-idle">未启用</span>}
          </div>
          {security.backupSchedule && (
            <div className="setting-row">
              <div><strong>自动备份</strong><span>{security.backupSchedule}</span></div>
            </div>
          )}

          <div className="st-section">
            <span className="setting-label">修改密码</span>
            <form onSubmit={submitPassword}>
              <div className="field-grid">
                <label className="field"><span>当前密码</span>
                  <input type="password" value={curPw} onChange={e => setCurPw(e.target.value)} required autoComplete="current-password" />
                </label>
                <label className="field"><span>新密码</span>
                  <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} required autoComplete="new-password" />
                </label>
              </div>
              {totpEnabled && (
                <label className="field"><span>二步验证码</span>
                  <input type="text" value={pwCode} onChange={e => setPwCode(e.target.value)} required inputMode="numeric" autoComplete="one-time-code" placeholder="6 位验证码" />
                </label>
              )}
              <p className="setting-hint">新密码至少 14 个字符。修改后所有登录会话失效，需要重新登录。</p>
              {pwError && <p className="form-error" role="alert">{pwError}</p>}
              <button type="submit" className="btn btn-primary" disabled={pwBusy}>{pwBusy ? "正在更新…" : "更新密码"}</button>
            </form>
          </div>

          <div className="st-section">
            <span className="setting-label">二步验证（TOTP）</span>
            {!totpEnabled && !totpSetup && (
              <form onSubmit={startTotp}>
                <label className="field"><span>当前密码</span>
                  <input type="password" value={startPw} onChange={e => setStartPw(e.target.value)} required autoComplete="current-password" />
                  <small>先验证当前密码，再生成绑定二维码。</small>
                </label>
                {totpError && <p className="form-error" role="alert">{totpError}</p>}
                <button type="submit" className="btn" disabled={totpBusy}>{totpBusy ? "正在生成…" : "开始设置"}</button>
              </form>
            )}
            {!totpEnabled && totpSetup && (
              <form onSubmit={enableTotp}>
                <p className="setting-hint">用认证器 App 扫描二维码，或手动输入下方密钥，然后填入 App 显示的 6 位验证码确认启用。启用成功后需要重新登录。</p>
                {totpSetup.qr
                  ? <div className="st-qr-wrap"><img className="st-qr" src={totpSetup.qr} alt="二步验证绑定二维码" /></div>
                  : <p className="setting-hint">二维码生成失败，请手动输入密钥：</p>}
                <div className="st-secret"><span>密钥</span><code className="mono">{totpSetup.secret}</code></div>
                <label className="field"><span>验证码</span>
                  <input type="text" value={totpCode} onChange={e => setTotpCode(e.target.value)} required inputMode="numeric" autoComplete="one-time-code" placeholder="6 位验证码" />
                </label>
                {totpError && <p className="form-error" role="alert">{totpError}</p>}
                <div className="st-actions">
                  <button type="submit" className="btn btn-primary" disabled={totpBusy}>{totpBusy ? "正在启用…" : "确认启用"}</button>
                  <button type="button" className="btn" disabled={totpBusy} onClick={() => { setTotpSetup(null); setTotpError(""); setTotpCode(""); }}>取消</button>
                </div>
              </form>
            )}
            {totpEnabled && (
              <form onSubmit={disableTotp}>
                <label className="field"><span>当前密码</span>
                  <input type="password" value={disPw} onChange={e => setDisPw(e.target.value)} required autoComplete="current-password" />
                </label>
                <label className="field"><span>当前验证码</span>
                  <input type="text" value={disCode} onChange={e => setDisCode(e.target.value)} required inputMode="numeric" autoComplete="one-time-code" placeholder="6 位验证码" />
                  <small>关闭后登录不再要求验证码，所有会话都会失效并需要重新登录。</small>
                </label>
                {disError && <p className="form-error" role="alert">{disError}</p>}
                <button type="submit" className="btn" disabled={disBusy}>{disBusy ? "正在关闭…" : "关闭二步验证"}</button>
              </form>
            )}
          </div>
        </>
      )}
    </Glass>
  );
}

function KomariRow({ server, nodes, onRefresh }) {
  const current = server.komariUuid || "";
  const [selected, setSelected] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => { setSelected(current); setDone(false); }, [current]);

  const currentName = current ? (nodes.find(n => n.uuid === current)?.name || "当前节点列表中未找到") : "";

  const save = async () => {
    if (busy || selected === current) return;
    setBusy(true); setError(""); setDone(false);
    try {
      await bindKomari({ serverId: server.id, uuid: selected });
      setDone(true);
      if (onRefresh) onRefresh();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="st-bind-row">
      <div className="st-bind-head">
        <strong>{server.name}</strong>
        {current
          ? <span className="badge badge-ok">已关联</span>
          : <span className="badge badge-idle">未关联</span>}
      </div>
      <p className="st-sub">{current ? `当前关联：${currentName}` : "尚未关联 Komari 探针"}</p>
      <div className="st-row-controls">
        <select className="st-select" aria-label={`${server.name} 的 Komari 节点`} value={selected} onChange={e => { setSelected(e.target.value); setDone(false); setError(""); }}>
          <option value="">取消关联（不关联探针）</option>
          {nodes.map(n => <option key={n.uuid} value={n.uuid}>{n.name || n.uuid}</option>)}
          {current && !nodes.some(n => n.uuid === current) && <option value={current}>{currentName}（当前）</option>}
        </select>
        <button type="button" className="btn btn-small" disabled={busy || selected === current} onClick={save}>{busy ? "保存中…" : "保存关联"}</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {done && <p className="st-success">关联已保存</p>}
    </div>
  );
}

function KomariCard({ data, onRefresh }) {
  const servers = data.servers || [];
  const nodes = data.komari?.nodes || [];
  return (
    <Glass className="settings-card">
      <header className="settings-head">
        <div><h3>Komari 关联</h3><p>把服务器与 Komari 探针节点对应起来</p></div>
        <Link2 size={19} />
      </header>
      {data.komari?.error && (
        <p className="st-alert" role="alert">Komari 数据暂不可用：{data.komari.error}。节点列表可能不完整，保存关联时后端会再次校验。</p>
      )}
      {servers.length === 0
        ? <p className="muted">还没有服务器记录，先在服务器页添加记录后再关联探针。</p>
        : servers.map(s => <KomariRow key={s.id} server={s} nodes={nodes} onRefresh={onRefresh} />)}
      <div className="settings-foot">
        {data.komari?.url && <a className="btn" href={data.komari.url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />在 Komari 查看监控</a>}
        <p>监控站点：{data.komari?.url || "尚未配置"}</p>
      </div>
    </Glass>
  );
}

function panelBadge(panel) {
  if (panel.status === "connected") return <span className="badge badge-ok">已连接</span>;
  if (panel.status) return <span className="badge badge-bad">{panel.status === "error" ? "连接异常" : panel.status}</span>;
  return <span className="badge badge-idle">未知状态</span>;
}

function PanelsCard({ data, onRefresh }) {
  const servers = data.servers || [];
  const panels = data.panels || [];
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [syncError, setSyncError] = useState("");

  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [formDone, setFormDone] = useState("");

  useEffect(() => {
    if (!serverId && servers.length) setServerId(servers[0].id);
  }, [servers, serverId]);

  const serverName = id => servers.find(s => s.id === id)?.name || "未知服务器";

  const doSync = async () => {
    if (syncBusy) return;
    setSyncBusy(true); setSyncError(""); setSyncMsg("");
    try {
      await triggerSync();
      setSyncMsg("已触发同步，稍后刷新页面查看最新状态。");
    } catch (e) { setSyncError(e.message); } finally { setSyncBusy(false); }
  };

  const submitPanel = async e => {
    e.preventDefault();
    if (formBusy) return;
    if (!name.trim() || !serverId || !url.trim() || !token) { setFormError("请完整填写名称、所属服务器、面板地址与访问令牌"); return; }
    setFormBusy(true); setFormError(""); setFormDone("");
    try {
      await api("/api/admin/panels", {
        method: "POST",
        body: JSON.stringify({ id: newRecordId(), name: name.trim(), serverId, url: url.trim(), token })
      });
      setFormDone("面板已接入，正在等待首次同步。");
      setName(""); setUrl(""); setToken("");
      if (onRefresh) onRefresh();
    } catch (err) { setFormError(err.message); } finally { setFormBusy(false); }
  };

  return (
    <Glass className="settings-card">
      <header className="settings-head">
        <div><h3>节点面板</h3><p>3x-ui 面板接入与同步状态</p></div>
        <Server size={19} />
      </header>

      {panels.length === 0
        ? <p className="muted">还没有接入任何面板，用下方表单接入第一台 3x-ui 面板。</p>
        : panels.map(p => (
          <div className="setting-row" key={p.id}>
            <div>
              <strong>{p.name}</strong>
              <span className="st-sub">{serverName(p.serverId)}{p.url ? ` · ${p.url}` : ""}</span>
              <span className="st-sub">最近同步：{stamp(p.lastSync)}</span>
              {p.error && <span className="st-sub st-error-text">{p.error}</span>}
            </div>
            {panelBadge(p)}
          </div>
        ))}

      <div className="st-section">
        <div className="st-actions">
          <button type="button" className="btn" onClick={doSync} disabled={syncBusy}>{syncBusy ? "正在触发…" : "立即同步"}</button>
        </div>
        {syncMsg && <p className="st-success">{syncMsg}</p>}
        {syncError && <p className="form-error" role="alert">{syncError}</p>}
      </div>

      <details className="st-section st-expand" open={panels.length === 0}>
        <summary>接入新面板<ChevronRight size={16} /></summary>
        <div className="st-expand-body">
          <form onSubmit={submitPanel}>
            <div className="field-grid">
              <label className="field"><span>面板名称</span>
                <input type="text" value={name} onChange={e => setName(e.target.value)} required placeholder="例如：新加坡 3x-ui" />
              </label>
              <label className="field"><span>所属服务器</span>
                <select className="st-select" value={serverId} onChange={e => setServerId(e.target.value)} required disabled={!servers.length}>
                  {servers.length === 0 && <option value="">暂无服务器</option>}
                  {servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
            </div>
            <div className="field-grid st-panel-credentials">
              <label className="field"><span>面板地址</span>
                <input type="url" value={url} onChange={e => setUrl(e.target.value)} required placeholder="https://面板地址或路径" />
              </label>
              <label className="field"><span>访问令牌</span>
                <input type="password" value={token} onChange={e => setToken(e.target.value)} required autoComplete="off" placeholder="3x-ui API 令牌" />
                <small>令牌只提交给后端加密保存，页面不会回显，也不会写入浏览器存储。</small>
              </label>
            </div>
            {formError && <p className="form-error" role="alert">{formError}</p>}
            {formDone && <p className="st-success">{formDone}</p>}
            <button type="submit" className="btn btn-primary" disabled={formBusy || !servers.length}>{formBusy ? "正在接入…" : "接入面板"}</button>
          </form>
        </div>
      </details>
    </Glass>
  );
}

/* 公开状态页：未登录可访问的 /status 开关与 Komari 详情链接。
   后端契约：GET/POST /api/admin/public-settings {enabled, komariUrl}；
   记录缺失时后端默认开启、链接指向默认 Komari 站点。 */
function PublicPageCard() {
  const [enabled, setEnabled] = useState(true);
  const [komariUrl, setKomariUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    let alive = true;
    getPublicSettings()
      .then(v => { if (alive) { setEnabled(!!v.enabled); setKomariUrl(v.komariUrl || ""); setLoading(false); } })
      .catch(e => { if (alive) { setError(e.message || "公开状态页设置加载失败"); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  const save = async () => {
    if (busy) return;
    setBusy(true); setError(""); setDone("");
    try {
      const v = await savePublicSettings({ enabled, komariUrl: komariUrl.trim() });
      setEnabled(!!v.enabled);
      setKomariUrl(v.komariUrl || "");
      setDone("已保存");
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Glass className="settings-card">
      <header className="settings-head">
        <div><h3>公开状态页</h3><p>未登录可访问的服务器状态页（/status）</p></div>
        <Globe size={19} />
      </header>

      {loading && <p className="muted">正在加载公开状态页设置…</p>}
      {!loading && (
        <>
          <div className="setting-row">
            <div>
              <strong>启用公开状态页</strong>
              <span>关闭后公开页与其数据接口都会停用（返回 404）</span>
            </div>
            <button type="button" role="switch" aria-checked={enabled} aria-label="公开状态页开关"
              className={`switch ${enabled ? "on" : ""}`} disabled={busy}
              onClick={() => { setEnabled(v => !v); setDone(""); }}>
              <span />
            </button>
          </div>

          <label className="field">
            <span>Komari 监控链接</span>
            <input type="url" value={komariUrl} onChange={e => { setKomariUrl(e.target.value); setDone(""); }} placeholder="https://monitor.example.com" />
            <small>公开页右上角「监控详情」跳转到这个地址；留空保存会恢复默认。公开页只展示状态、实时速率与流量配额，不含价格、到期等信息。</small>
          </label>

          {error && <p className="form-error" role="alert">{error}</p>}
          {done && <p className="st-success">{done}</p>}

          <div className="settings-foot">
            <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "保存中…" : "保存设置"}</button>
            <a className="btn" href="/status" target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />打开公开页</a>
          </div>
        </>
      )}
    </Glass>
  );
}

const OBSERVED_LABEL = { add: "将新增", update: "将更新", revoke: "将撤销" };

/* 面板同步运维：观察模式开关 + 上轮待执行计数 + 各授权的待执行动作。
   后端契约：GET/POST /api/admin/sync-settings；grant.observed 随
   overview 的 grants 一同下发（data 由外壳传入）。 */
function SyncOpsCard({ data, onRefresh }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api("/api/admin/sync-settings"));
      setError("");
    } catch (e) {
      setError(e.message || "读取同步状态失败");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const observe = state ? !!state.observeMode : null;
  const counts = state?.lastRound || {};
  const pending = [
    ["add", counts.add || 0],
    ["update", counts.update || 0],
    ["revoke", counts.revoke || 0]
  ];
  const pendingTotal = pending.reduce((s, [, n]) => s + n, 0);
  const members = new Map((data?.members || []).map(m => [m.id, m.name || m.id]));
  const observedGrants = (data?.grants || []).filter(g => g.observed);

  const flip = async next => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api("/api/admin/sync-settings", { method: "POST", body: JSON.stringify({ observeMode: next }) });
      setState(prev => ({ ...(prev || {}), ...saved }));
      setConfirmingOff(false);
      setNotice(next
        ? "观察模式已开启：后续同步只读取与记录，不会改动面板上的客户端。"
        : "观察模式已关闭：从下一轮同步起（约 60 秒内）将真实执行面板客户端的新增、更新与删除。");
      if (onRefresh) onRefresh();
    } catch (e) {
      setError(e.message || "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Glass className="settings-card">
      <header className="settings-head">
        <div><h3>面板同步</h3><p>3x-ui 订阅同步的观察模式与待执行动作</p></div>
        {observe === false ? <EyeOff size={19} /> : <Eye size={19} />}
      </header>

      <div className="setting-row">
        <div>
          <strong>观察模式</strong>
          <span>{observe === null ? "正在读取状态…" : observe
            ? "开启中：同步只回拉流量、记录将执行的动作，不动面板客户端"
            : "已关闭：同步正在真实执行面板客户端的新增 / 更新 / 删除"}</span>
        </div>
        <button type="button" role="switch" aria-checked={observe === true} aria-label="观察模式开关"
          className={`switch ${observe ? "on" : ""}`} disabled={observe === null || busy}
          onClick={() => { if (observe) setConfirmingOff(true); else flip(true); }}>
          <span />
        </button>
      </div>

      {confirmingOff && (
        <div className="ops-confirm" role="alert">
          <strong>关闭观察模式 = 开始真实执行</strong>
          <p>下一轮同步（约 60 秒内）起，面板同步会按用户分配的订阅与用量，在 3x-ui 面板上真实新增、更新或删除客户端；超额或到期的用户会撤销授权。此操作会记入审计日志。</p>
          <div className="ops-confirm-actions">
            <button type="button" className="btn btn-danger" disabled={busy} onClick={() => flip(false)}>确认关闭，开始真实执行</button>
            <button type="button" className="btn" disabled={busy} onClick={() => setConfirmingOff(false)}>再想想</button>
          </div>
        </div>
      )}

      <div className="setting-row">
        <div>
          <strong>上一轮待执行动作</strong>
          <span>{state?.lastRoundAt ? `记录于 ${stamp(state.lastRoundAt)}` : "尚无同步记录"}</span>
        </div>
        <span className={`badge ${pendingTotal ? "badge-warn" : "badge-idle"}`}>{pendingTotal ? `共 ${pendingTotal} 项` : "无待执行"}</span>
      </div>
      <div className="ops-counts">
        {pending.map(([key, n]) => (
          <div key={key} className="ops-count"><strong>{n}</strong><span>{OBSERVED_LABEL[key]}</span></div>
        ))}
      </div>

      {observedGrants.length > 0 && (
        <div className="setting-block">
          <span className="setting-label">各授权的待执行动作</span>
          <ul className="ops-grants">
            {observedGrants.map(g => (
              <li key={g.id || `${g.memberId}-${g.nodeId}`}>
                <span>{members.get(g.memberId) || g.memberId || "成员"}</span>
                <span className="badge badge-warn">{OBSERVED_LABEL[g.observed] || g.observed}</span>
                <small>{stamp(g.observedAt)}</small>
              </li>
            ))}
          </ul>
        </div>
      )}

      {notice && <p className="ops-note ok">{notice}</p>}
      {error && <p className="ops-note bad" role="alert">{error}</p>}
      <div className="settings-foot">
        <button type="button" className="btn" onClick={load} disabled={busy}><RefreshCw size={15} />刷新状态</button>
        <p>新装或从备份恢复的实例一律从观察模式起步；开关的每一次翻动都会记入审计日志。待执行动作的明细也可在任务与审计页查看。</p>
      </div>
    </Glass>
  );
}

const SETTINGS_SECTIONS = [
  { id: "appearance", title: "外观与品牌", icon: Palette, tone: "blue", description: "调整主题、主色、背景和工作区名称。" },
  { id: "public", title: "公开页面", icon: Globe, tone: "cyan", description: "管理公开状态页及监控详情入口。" },
  { id: "connections", title: "服务接入", icon: Server, tone: "purple", description: "管理节点面板与 Komari 探针关联。" },
  { id: "sync", title: "面板同步", icon: RefreshCw, tone: "amber", description: "查看同步状态，管理观察模式和待执行动作。" },
  { id: "security", title: "账户安全", icon: ShieldCheck, tone: "green", description: "修改管理员密码，管理二步验证与登录会话。" }
];

function WorkspaceCard({ theme, version, onLogout }) {
  return (
    <Glass className="settings-card">
      <header className="settings-head">
        <div><h3>当前工作区</h3><p>版本与登录会话</p></div>
        <ShieldCheck size={19} />
      </header>
      <div className="setting-row"><div><strong>工作区</strong><span>{theme.workspace}</span></div></div>
      <div className="setting-row"><div><strong>版本</strong><span>SubHub {version || "—"}</span></div></div>
      <div className="settings-foot"><button type="button" className="btn" onClick={onLogout}><LogOut size={15} />退出管理员登录</button></div>
    </Glass>
  );
}

export default function SettingsPage({ theme, updateTheme, version, onLogout, data, onRefresh }) {
  useEffect(() => { syncAppearance(); }, []);
  const [sectionId, setSectionId] = useState(() => {
    const fragment = location.hash.slice(1);
    return SETTINGS_SECTIONS.some(s => s.id === fragment) ? fragment : "appearance";
  });
  useEffect(() => {
    const onHash = () => {
      const fragment = location.hash.slice(1);
      if (SETTINGS_SECTIONS.some(s => s.id === fragment)) setSectionId(fragment);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const section = SETTINGS_SECTIONS.find(s => s.id === sectionId);
  const SectionIcon = section.icon;
  const selectSection = id => {
    setSectionId(id);
    history.replaceState({}, "", `${location.pathname}${location.search}#${id}`);
  };
  const safeData = data || { servers: [], panels: [], komari: null };
  return (
    <div className="page settings-page">
      <div className="page-head">
        <div><h1>设置</h1><p className="page-sub">管理界面、服务与账户</p></div>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {SETTINGS_SECTIONS.map(s => {
            const Icon = s.icon;
            return <button key={s.id} id={`settings-tab-${s.id}`} type="button"
              className={`settings-nav-item ${sectionId === s.id ? "active" : ""}`} aria-current={sectionId === s.id ? "page" : undefined}
              aria-controls="settings-content" onClick={() => selectSection(s.id)}>
              <span className={`settings-nav-icon tone-${s.tone}`} aria-hidden="true"><Icon size={16} /></span><span>{s.title}</span><ChevronRight size={14} className="settings-nav-arrow" />
            </button>;
          })}
        </nav>
        <section className={`settings-content tone-${section.tone}`} id="settings-content" aria-labelledby={`settings-tab-${sectionId}`}>
          <div className="settings-section-intro"><span className="settings-section-mark" aria-hidden="true"><SectionIcon size={23} /></span><div><h2>{section.title}</h2><p>{section.description}</p></div></div>
          {sectionId === "appearance" && <AppearanceCard theme={theme} updateTheme={updateTheme} />}
          {sectionId === "public" && <PublicPageCard />}
          {sectionId === "connections" && <>
            <PanelsCard data={safeData} onRefresh={onRefresh} />
            <KomariCard data={safeData} onRefresh={onRefresh} />
          </>}
          {sectionId === "sync" && <SyncOpsCard data={safeData} onRefresh={onRefresh} />}
          {sectionId === "security" && <>
            <SecurityCard onLogout={onLogout} />
            <WorkspaceCard theme={theme} version={version} onLogout={onLogout} />
          </>}
        </section>
      </div>
    </div>
  );
}
