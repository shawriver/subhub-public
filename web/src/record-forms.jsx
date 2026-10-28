import React, { useState } from "react";
import { Loader2, Save, Server, Trash2 } from "lucide-react";
import { Modal } from "./ui.jsx";
import { api, bindKomari, deleteRecord, newRecordId, saveRecord } from "./api.js";
import { REGION_NAMES } from "./format.js";

function Actions({ busy, onClose, children }) {
  return <div className="form-actions">
    <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
    <button type="submit" className="btn btn-primary" disabled={busy}>
      {busy ? <Loader2 size={15} className="nd-spin" /> : <Save size={15} />}{children || "保存"}
    </button>
  </div>;
}

export function ServerEditor({ server, onClose, onSaved }) {
  const [value, setValue] = useState(() => ({ name: "", address: "", region: "", provider: "", role: "", note: "", ...server }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recordId] = useState(() => server?.id || newRecordId());
  const field = (key, label, required = false) => <label className="field"><span>{label}</span>
    <input type="text" required={required} value={value[key]} onChange={e => setValue(v => ({ ...v, [key]: e.target.value }))} />
  </label>;
  const submit = async e => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      await saveRecord("server", recordId, { ...value, id: recordId, name: value.name.trim(), address: value.address.trim() });
      onSaved(recordId);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <Modal title={server ? "编辑服务器" : "添加服务器"} onClose={() => !busy && onClose()}>
    <form onSubmit={submit}>
      {field("name", "服务器名称", true)}
      {field("address", "地址（IP 或域名）", true)}
      <div className="field-grid">
        <label className="field"><span>地区</span>
          <input list="server-regions" type="text" value={value.region} onChange={e => setValue(v => ({ ...v, region: e.target.value, flag: "" }))} />
          <datalist id="server-regions">{Object.entries(REGION_NAMES).map(([code, name]) => <option key={code} value={name} />)}</datalist>
        </label>
        {field("provider", "服务商")}
      </div>
      {field("role", "用途")}
      <label className="field"><span>备注</span><textarea rows={3} value={value.note} onChange={e => setValue(v => ({ ...v, note: e.target.value }))} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <Actions busy={busy} onClose={onClose} />
    </form>
  </Modal>;
}

export function KomariBinding({ server, data, onClose, onSaved }) {
  const [uuid, setUuid] = useState(server.komariUuid || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nodes = data.komari?.nodes || [];
  const otherBindings = new Set(data.servers.filter(s => s.id !== server.id).map(s => s.komariUuid).filter(Boolean));
  const submit = async e => {
    e.preventDefault();
    setBusy(true); setError("");
    try { await bindKomari({ serverId: server.id, uuid }); onSaved(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <Modal title={`关联 Komari · ${server.name}`} onClose={() => !busy && onClose()}>
    <form onSubmit={submit}>
      <label className="field"><span>Komari 探针</span>
        <select aria-label="Komari 探针" value={uuid} onChange={e => setUuid(e.target.value)}>
          <option value="">不关联探针</option>
          {uuid && !nodes.some(n => n.uuid === uuid) && <option value={uuid}>当前探针（暂未读到）</option>}
          {nodes.map(n => <option key={n.uuid} value={n.uuid} disabled={otherBindings.has(n.uuid)}>{n.name}{otherBindings.has(n.uuid) ? "（已关联其他服务器）" : ""}</option>)}
        </select>
      </label>
      {data.komari?.error && <p className="form-error" role="alert">{data.komari.error}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <Actions busy={busy} onClose={onClose}>保存关联</Actions>
    </form>
  </Modal>;
}

export function PanelEditor({ server, panel, onClose, onSaved }) {
  const [name, setName] = useState(panel?.name || `${server.name} · 3x-ui`);
  const [url, setUrl] = useState(panel?.url || "");
  const [token, setToken] = useState("");
  const [recordId] = useState(() => panel?.id || newRecordId());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async e => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await api("/api/admin/panels", { method: "POST", body: JSON.stringify({ id: recordId, name: name.trim(), serverId: server.id, url: url.trim(), token }) });
      setToken("");
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <Modal title={panel ? "更新面板连接" : "接入 3x-ui 面板"} onClose={() => !busy && onClose()}>
    <form onSubmit={submit}>
      <label className="field"><span>面板名称</span><input type="text" value={name} onChange={e => setName(e.target.value)} required /></label>
      <label className="field"><span>所属服务器</span><input type="text" value={server.name} readOnly /></label>
      <label className="field"><span>面板地址</span><input type="url" value={url} onChange={e => setUrl(e.target.value)} required readOnly={!!panel} placeholder="https://panel.example.com" /></label>
      <label className="field"><span>API 令牌{panel ? "（留空保留原令牌）" : ""}</span>
        <input type="password" value={token} onChange={e => setToken(e.target.value)} required={!panel} autoComplete="off" />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <Actions busy={busy} onClose={onClose}>{panel ? "验证并保存" : "验证并接入"}</Actions>
    </form>
  </Modal>;
}

export function DeleteServer({ server, onClose, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const remove = async () => {
    setBusy(true); setError("");
    try { await deleteRecord("server", server.id); onSaved(); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <Modal title="删除服务器记录" onClose={() => !busy && onClose()}>
    <p className="confirm-text">删除「{server.name}」的 SubHub 记录？关联的节点和面板需要先解除；此操作不会删除 VPS 或 Komari 探针。</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions"><button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}><Trash2 size={15} />删除记录</button></div>
  </Modal>;
}

export function NodeEditor({ node, data, onClose, onSaved }) {
  const [value, setValue] = useState(() => ({
    name: "", serverId: data.servers?.[0]?.id || "", protocol: "VLESS", host: "", port: 443,
    enabled: true, transport: "tcp", security: "reality", sni: "", flow: "", path: "", wsHost: "",
    publicKey: "", shortId: "", fingerprint: "chrome", alpn: "", tags: [], ...node, credential: ""
  }));
  const [tags, setTags] = useState(() => (node?.tags || []).join(", "));
  const [recordId] = useState(() => node?.id || newRecordId());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const managed = !!node?.panelId;
  const tlsOnly = ["Trojan", "Hysteria2", "AnyTLS"].includes(value.protocol);
  const set = (key, v) => setValue(old => ({ ...old, [key]: v }));
  const changeProtocol = protocol => setValue(old => ({
    ...old, protocol, security: ["Trojan", "Hysteria2", "AnyTLS"].includes(protocol) ? "tls" : protocol === "VMess" ? "tls" : "reality",
    transport: protocol === "Hysteria2" ? "udp" : "tcp", flow: "", path: "", wsHost: "", publicKey: "", shortId: "", credential: ""
  }));
  const field = (key, label, required = false) => <label className="field"><span>{label}</span>
    <input type="text" value={value[key]} required={required} onChange={e => set(key, e.target.value)} />
  </label>;
  const submit = async e => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    const payload = { ...value, id: recordId, name: value.name.trim(), host: value.host.trim(),
      port: Number(value.port), tags: tags.split(/[,，\n]/).map(t => t.trim()).filter(Boolean) };
    if (payload.security !== "reality") { payload.publicKey = ""; payload.shortId = ""; }
    if (payload.transport !== "ws") { payload.path = ""; payload.wsHost = ""; }
    if (payload.protocol !== "VLESS" || payload.transport === "ws" || !["tls", "reality"].includes(payload.security)) payload.flow = "";
    try { await saveRecord("node", recordId, payload); set("credential", ""); onSaved(recordId); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <Modal title={node ? "编辑节点" : "添加节点"} onClose={() => !busy && onClose()}>
    <form onSubmit={submit}>
      {managed && <p className="form-note"><Server size={15} />3x-ui 受管节点 · 协议和凭据由面板管理</p>}
      {field("name", "节点名称", true)}
      <div className="field-grid">
        <label className="field"><span>所属服务器</span>
          <select aria-label="所属服务器" value={value.serverId} onChange={e => set("serverId", e.target.value)} disabled={managed}>
            <option value="">不关联服务器</option>{data.servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="field"><span>协议</span><select aria-label="协议" value={value.protocol} disabled={managed} onChange={e => changeProtocol(e.target.value)}>
          {["VLESS", "VMess", "Trojan", "Hysteria2", "AnyTLS"].map(p => <option key={p}>{p}</option>)}
        </select></label>
      </div>
      <div className="field-grid">
        {field("host", "地址（IP 或域名）", true)}
        <label className="field"><span>端口</span><input type="number" min="1" max="65535" required value={value.port} onChange={e => set("port", e.target.value)} /></label>
        <label className="field"><span>传输</span><select aria-label="传输" value={value.transport} disabled={managed || ["AnyTLS", "Hysteria2"].includes(value.protocol)} onChange={e => set("transport", e.target.value)}>
          {(value.protocol === "Hysteria2" ? ["udp"] : value.protocol === "AnyTLS" || value.security === "reality" ? ["tcp"] : ["tcp", "ws"]).map(p => <option key={p}>{p}</option>)}
        </select></label>
        <label className="field"><span>安全方式</span><select aria-label="安全方式" value={value.security || "none"} disabled={managed || tlsOnly} onChange={e => {
          setValue(v => ({ ...v, security: e.target.value, ...(e.target.value === "reality" ? { transport: "tcp" } : {}) }));
        }}>
          {(tlsOnly ? ["tls"] : value.protocol === "VLESS" ? ["none", "tls", "reality"] : ["none", "tls"]).map(p => <option key={p} value={p}>{p === "none" ? "无 TLS" : p.toUpperCase()}</option>)}
        </select></label>
      </div>
      {!managed && <label className="field"><span>{["VLESS", "VMess"].includes(value.protocol) ? "UUID" : "密码"}{node ? "（留空保留原凭据）" : ""}</span>
        <input type="password" value={value.credential} onChange={e => set("credential", e.target.value)} autoComplete="off" required={!node} />
      </label>}
      {value.security !== "none" && value.security !== "" && <div className="field-grid">
        {field("sni", "SNI")}{field("alpn", "ALPN（逗号分隔）")}
        {field("fingerprint", "客户端指纹")}
        {value.protocol === "VLESS" && value.transport === "tcp" && <label className="field"><span>Flow</span><select aria-label="Flow" value={value.flow} onChange={e => set("flow", e.target.value)}>
          <option value="">无</option><option value="xtls-rprx-vision">xtls-rprx-vision</option>
        </select></label>}
      </div>}
      {value.security === "reality" && <div className="field-grid">{field("publicKey", "REALITY 公钥", true)}{field("shortId", "Short ID")}</div>}
      {value.transport === "ws" && <div className="field-grid">{field("path", "WebSocket 路径")}{field("wsHost", "WebSocket Host")}</div>}
      <label className="field"><span>标签（逗号分隔）</span><input type="text" value={tags} onChange={e => setTags(e.target.value)} /></label>
      <label className="check-line"><input type="checkbox" checked={value.enabled} onChange={e => set("enabled", e.target.checked)} />启用节点</label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <Actions busy={busy} onClose={onClose} />
    </form>
  </Modal>;
}
