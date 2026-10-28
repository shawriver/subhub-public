import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight, ExternalLink, LayoutDashboard, ListChecks, LogOut, Menu, Network,
  RefreshCw, Search, Server, Settings, Users, Waypoints, X
} from "lucide-react";
import { getOverview, getSession, getStatus, logout as apiLogout } from "./api.js";
import { useTheme } from "./theme.js";
import OverviewPage from "./pages/overview.jsx";
import ServersPage from "./pages/servers.jsx";
import NodesPage from "./pages/nodes.jsx";
import SubscriptionsPage from "./pages/subscriptions.jsx";
import MembersPage from "./pages/members.jsx";
import TasksPage from "./pages/tasks.jsx";
import SettingsPage from "./pages/settings.jsx";
import { AppearanceToggle, IconChip } from "./ui.jsx";
import PortalPage from "./pages/portal.jsx";
import PublicStatusPage from "./pages/public.jsx";
import { LoginPage, SetupPage } from "./pages/login.jsx";

const PAGES = {
  overview: { title: "总览", icon: LayoutDashboard, tone: "blue" },
  servers: { title: "服务器", icon: Server, tone: "cyan" },
  nodes: { title: "节点", icon: Waypoints, tone: "purple" },
  subscriptions: { title: "订阅", icon: Network, tone: "green" },
  members: { title: "用户", icon: Users, tone: "pink" },
  tasks: { title: "任务", icon: ListChecks, tone: "amber" },
  settings: { title: "设置", icon: Settings, tone: "gray" }
};
const NAV_MAIN = ["overview", "servers", "nodes", "subscriptions", "members", "tasks"];
const SEARCHABLE = ["servers", "nodes", "members", "subscriptions", "tasks"];
const EMPTY = { servers: [], nodes: [], nodeHealth: {}, nodeTests: {}, ruleTemplates: [], members: [], subscriptions: [], profiles: [], tasks: [], panels: [], grants: [], komari: null, generatedAt: "" };

function pageFromPath() {
  const seg = location.pathname.split("/").filter(Boolean);
  if (seg[0] === "admin" && seg[1] === "tests") return "nodes";
  if (seg[0] === "admin" && PAGES[seg[1]]) return seg[1];
  return "overview";
}

function BrandMark({ theme, size = 30 }) {
  if (theme.logoUrl) return <img className="brand-logo" src={theme.logoUrl} alt="" width={size} height={size} />;
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 40 40" width={size * 0.72} height={size * 0.72}><path d="M11 13.5h18v5H17v3h12v5H11v-5h12v-3H11z" fill="white" /></svg>
    </span>
  );
}

function SideNav({ page, navigate, open, close, theme, data, version }) {
  const connected = (data.panels || []).filter(p => p.status === "connected").length;
  return (
    <>
      {open && <button type="button" className="sidenav-scrim" aria-label="关闭菜单" onClick={close} />}
      <aside className={`sidenav glass ${open ? "open" : ""}`}>
        <div className="brand">
          <BrandMark theme={theme} />
          <div className="brand-text"><strong>{theme.brandName}</strong><small>{theme.brandSub}</small></div>
        </div>
        <div className="workspace-chip">
          <span className="workspace-avatar">{String(theme.workspace || "S").charAt(0).toUpperCase()}</span>
          <div><small>工作区</small><strong>{theme.workspace}</strong></div>
        </div>
        <nav className="nav" aria-label="主导航">
          <p className="nav-label">工作台</p>
          {NAV_MAIN.map(key => {
            const Icon = PAGES[key].icon;
            return (
              <button key={key} type="button" className={`nav-item ${page === key ? "active" : ""}`} aria-current={page === key ? "page" : undefined}
                onClick={() => { navigate(key); close(); }}>
                <span className={`nav-ico tone-${PAGES[key].tone}`}><Icon size={16} strokeWidth={2} /></span><span>{PAGES[key].title}</span>
                {key === "tasks" && data.tasks.some(t => t.status === "failed") && <span className="nav-dot" />}
              </button>
            );
          })}
          <p className="nav-label nav-spacer">系统</p>
          <button type="button" className={`nav-item ${page === "settings" ? "active" : ""}`} aria-current={page === "settings" ? "page" : undefined} onClick={() => { navigate("settings"); close(); }}>
            <span className={`nav-ico tone-${PAGES.settings.tone}`}><Settings size={16} strokeWidth={2} /></span><span>设置</span>
          </button>
        </nav>
        <div className="sidenav-foot">
          <div className="panel-mini">
            <span className={`pulse ${connected ? "on" : ""}`} />
            <div><small>节点服务</small><strong>{data.panels?.length ? `${connected} / ${data.panels.length} 个面板已连接` : "等待接入面板"}</strong></div>
          </div>
          <div className="version-row"><span>{theme.brandName} {version || ""}</span></div>
        </div>
      </aside>
    </>
  );
}

function TopBar({ page, theme, search, setSearch, onRefresh, onLogout, onMenu }) {
  return (
    <header className="topbar glass">
      <div className="topbar-title">
        <button type="button" className="icon-btn mobile-only" aria-label="打开菜单" onClick={onMenu}><Menu size={18} /></button>
        <span className="topbar-page-icon"><IconChip icon={PAGES[page]?.icon} tone={PAGES[page]?.tone} size={36} /></span>
        <div>
          <span className="crumb">{theme.workspace} <ChevronRight size={12} /></span>
          <h1>{PAGES[page]?.title || "总览"}</h1>
        </div>
      </div>
      <div className="topbar-actions">
        {SEARCHABLE.includes(page) && (
          <label className="search-box">
            <Search size={15} />
            <input aria-label="搜索当前列表" placeholder="搜索服务器 / 节点 / 用户 / 任务…" value={search} onChange={e => setSearch(e.target.value)} />
            {search && <button type="button" aria-label="清除搜索" onClick={() => setSearch("")}><X size={13} /></button>}
          </label>
        )}
        <a className="icon-btn" href="/status" aria-label="查看公开状态页" title="查看公开状态页">
          <ExternalLink size={16} />
        </a>
        <button type="button" className="icon-btn" aria-label="刷新数据" title="刷新数据" onClick={onRefresh}><RefreshCw size={16} /></button>
        <AppearanceToggle theme={theme} />
        <button type="button" className="icon-btn" aria-label="退出登录" title="退出登录" onClick={onLogout}><LogOut size={16} /></button>
        <span className="avatar" aria-hidden="true">{String(theme.workspace || "S").charAt(0).toUpperCase()}</span>
      </div>
    </header>
  );
}

export default function App() {
  const [theme, updateTheme] = useTheme();
  const [view, setView] = useState("boot"); // boot | setup | login | admin | portal
  const [page, setPage] = useState(pageFromPath);
  const [data, setData] = useState(EMPTY);
  const [version, setVersion] = useState("");
  const [search, setSearch] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [loginMessage, setLoginMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const generation = useRef(0);

  const showLogin = useCallback(message => {
    generation.current++;
    setLoginMessage(message || "");
    setView("login");
  }, []);

  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const d = await getOverview();
      if (gen !== generation.current) return;
      setData({ ...EMPTY, ...d });
      setLoadError("");
    } catch (e) {
      if (gen === generation.current) setLoadError(e.message || "数据加载失败");
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const setupToken = new URLSearchParams(location.search).get("setup");
      if (location.pathname.startsWith("/me/")) { if (alive) setView("portal"); return; }
      if (location.pathname === "/status") { if (alive) setView("public"); return; }
      try {
        const status = await getStatus();
        if (!alive) return;
        setVersion(status.version || "");
        if (status.setupRequired) { setView("setup"); return; }
        const session = await getSession();
        if (!alive) return;
        if (session.authenticated) { setView("admin"); load(); }
        else setView(setupToken ? "setup" : "login");
      } catch {
        if (alive) setView("login");
      }
    })();
    return () => { alive = false; };
  }, [load]);

  useEffect(() => {
    const onExpired = () => showLogin("登录已过期，请重新登录后继续。");
    window.addEventListener("subhub-session-expired", onExpired);
    return () => window.removeEventListener("subhub-session-expired", onExpired);
  }, [showLogin]);

  useEffect(() => {
    if (view !== "admin") return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, 60000);
    const onPop = () => setPage(pageFromPath());
    window.addEventListener("popstate", onPop);
    return () => { clearInterval(timer); window.removeEventListener("popstate", onPop); };
  }, [view, load]);

  const navigate = useCallback(next => {
    setPage(next);
    setSearch("");
    history.pushState({}, "", next === "overview" ? "/admin" : `/admin/${next}`);
  }, []);

  const doLogout = useCallback(async () => {
    try { await apiLogout(); } catch { /* session already gone */ }
    setData(EMPTY);
    showLogin("你已退出登录。");
    history.replaceState({}, "", "/login");
  }, [showLogin]);

  if (view === "boot") {
    return <main className="auth-wrap"><section className="glass auth-card boot-card"><p>正在打开工作台…</p></section></main>;
  }
  if (view === "setup") {
    return <SetupPage theme={theme} token={new URLSearchParams(location.search).get("setup") || ""}
      onDone={() => { setView("login"); setLoginMessage("管理员已创建，请登录。"); history.replaceState({}, "", "/login"); }} />;
  }
  if (view === "login") {
    return <LoginPage theme={theme} message={loginMessage}
      onDone={() => { setLoginMessage(""); setView("admin"); history.replaceState({}, "", "/admin"); load(); }} />;
  }
  if (view === "public") {
    return (
      <main className="portal-wrap">
        <PublicStatusPage theme={theme} />
      </main>
    );
  }
  if (view === "portal") {
    return (
      <main className="portal-wrap">
        <PortalPage theme={theme} />
      </main>
    );
  }

  return (
    <div className="shell">
      <SideNav page={page} navigate={navigate} open={navOpen} close={() => setNavOpen(false)} theme={theme} data={data} version={version} />
      <div className="main-col">
        <TopBar page={page} theme={theme} search={search} setSearch={setSearch}
          onRefresh={load} onLogout={doLogout} onMenu={() => setNavOpen(true)} />
        <div className="content">
          {loadError && <div className="notice-error" role="alert">数据加载失败：{loadError}（可点右上角刷新重试）</div>}
          {page === "overview" && <OverviewPage data={data} theme={theme} onNavigate={navigate} onRefresh={load} />}
          {page === "servers" && <ServersPage data={data} search={search} onRefresh={load} />}
          {page === "nodes" && <NodesPage data={data} search={search} onRefresh={load} />}
          {page === "subscriptions" && <SubscriptionsPage data={data} search={search} onRefresh={load} />}
          {page === "members" && <MembersPage data={data} search={search} onRefresh={load} />}
          {page === "tasks" && <TasksPage data={data} search={search} onRefresh={load} />}
          {page === "settings" && <SettingsPage theme={theme} updateTheme={updateTheme} version={version} onLogout={doLogout} data={data} onRefresh={load} />}
        </div>
      </div>
    </div>
  );
}
