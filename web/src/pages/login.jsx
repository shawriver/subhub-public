import React, { useState } from "react";
import { ArrowRight, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { login, setupAdmin } from "../api.js";

export function LoginPage({ theme, message, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [show, setShow] = useState(false);
  const submit = async e => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    setBusy(true); setError("");
    try {
      await login({ username: f.get("username"), password: f.get("password"), code: f.get("code") || "", remember: f.get("remember") === "on" });
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <main className="auth-wrap">
      <section className="glass glass-strong auth-card" aria-labelledby="login-title">
        <span className="auth-symbol"><ShieldCheck size={25} /></span>
        <p className="kicker">ADMINISTRATOR</p>
        <h1 id="login-title">登录管理后台</h1>
        <p className="auth-desc">管理你的服务器、节点与订阅。</p>
        {message && <p className="auth-info">{message}</p>}
        <form className="auth-form" onSubmit={submit}>
          <label className="field"><span>用户名</span><input name="username" required autoComplete="username" autoFocus /></label>
          <label className="field"><span>管理员密码</span>
            <span className="password-input">
              <input name="password" type={show ? "text" : "password"} required autoComplete="current-password" />
              <button type="button" className="icon-btn" aria-label={show ? "隐藏密码" : "显示密码"} onClick={() => setShow(!show)}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </span>
          </label>
          <label className="field"><span>二步验证码（未启用可留空）</span><input name="code" inputMode="numeric" autoComplete="one-time-code" /></label>
          <label className="remember-line"><input type="checkbox" name="remember" />保持登录 30 天</label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? "正在登录…" : <>进入工作台 <ArrowRight size={15} /></>}</button>
        </form>
        <p className="auth-brand">{theme.brandName} · {theme.workspace}</p>
        <p className="auth-brand" style={{ marginTop: 6 }}>
          <a href="/status" style={{ color: "inherit" }}>查看服务器公开状态 →</a>
        </p>
      </section>
    </main>
  );
}

export function SetupPage({ theme, token, onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [show, setShow] = useState(false);
  const submit = async e => {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    if (f.get("password") !== f.get("confirm")) { setError("两次输入的密码不一致"); return; }
    setBusy(true); setError("");
    try {
      await setupAdmin({ token, username: f.get("username"), password: f.get("password") });
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <main className="auth-wrap">
      <section className="glass glass-strong auth-card" aria-labelledby="setup-title">
        <span className="auth-symbol"><ShieldCheck size={25} /></span>
        <p className="kicker">FIRST RUN</p>
        <h1 id="setup-title">创建管理员</h1>
        <p className="auth-desc">建立你的私人网络工作台。密码至少 14 个字符，设置链接使用后立即失效。</p>
        {!token && <p className="form-error" role="alert">缺少一次性设置令牌，请使用部署时生成的设置链接打开本页。</p>}
        <form className="auth-form" onSubmit={submit}>
          <label className="field"><span>用户名</span><input name="username" defaultValue="admin" required autoComplete="username" /></label>
          <label className="field"><span>管理员密码</span>
            <span className="password-input">
              <input name="password" type={show ? "text" : "password"} minLength={14} required autoComplete="new-password" autoFocus />
              <button type="button" className="icon-btn" aria-label={show ? "隐藏密码" : "显示密码"} onClick={() => setShow(!show)}>{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
            </span>
          </label>
          <label className="field"><span>再次输入</span><input name="confirm" type={show ? "text" : "password"} minLength={14} required autoComplete="new-password" /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || !token}>{busy ? "正在创建…" : <>完成设置 <ArrowRight size={15} /></>}</button>
        </form>
        <p className="auth-brand">{theme.brandName} · {theme.workspace}</p>
      </section>
    </main>
  );
}
