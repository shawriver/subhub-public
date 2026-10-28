import React, {useState,useEffect,useRef} from "react";
import {ArrowRight, ArrowUpRight, Eye, EyeOff, House, LoaderCircle, ShieldCheck, Server, RefreshCw, ArrowUp, ArrowDown, Activity} from "lucide-react";
import {formatTrafficGB} from "./format";

export function AccessHeader({IconMark,authenticated=false}) {
  return <header className="access-header"><a className="brand access-brand" href="/" aria-label="SubHub 首页"><IconMark size={28}/><div><strong>SUBHUB</strong><small>PRIVATE NETWORK</small></div></a><a className="access-nav" href="/admin">{authenticated?"管理后台":"后台登录"}<ArrowUpRight size={15}/></a></header>;
}

const bytes=n=>{if(n==null)return "—";const u=["B","KiB","MiB","GiB","TiB"];let i=0;while(n>=1024&&i<4){n/=1024;i++}return `${n.toFixed(i?1:0)} ${u[i]}`};
const percent=n=>n==null?"—":`${n.toFixed(1)}%`;
const timeLabel=s=>s?new Date(s).toLocaleTimeString("zh-CN",{hour12:false}):"等待采集";
export function TrafficUsage({machine:m}) {
  const modes={sum:"双向合计",up:"仅上行",down:"仅下行",max:"较大方向",min:"较小方向"};
  const ratio=m.trafficLimit>0&&m.trafficUsed!=null?m.trafficUsed/m.trafficLimit*100:null;
  return <div className={"machine-traffic"+(ratio>=85?" traffic-warning":"")}><div className="traffic-title"><span>整机流量</span><small>{modes[m.trafficMode]||"探针累计"}</small></div><div className="traffic-amount"><strong>{bytes(m.trafficUsed??(m.totalUp!=null&&m.totalDown!=null?m.totalUp+m.totalDown:null))}</strong><span>{m.trafficLimit>0?"/ "+bytes(m.trafficLimit):"未设置额度"}</span></div>{ratio!=null&&<div className="resource-track" role="meter" aria-label="整机流量额度使用率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100,ratio)}><i style={{width:Math.max(0,Math.min(100,ratio))+"%"}}/></div>}<div className="traffic-directions"><span>↑ {bytes(m.totalUp)}</span><span>↓ {bytes(m.totalDown)}</span>{ratio!=null&&<span>{ratio.toFixed(1)}%</span>}</div></div>;
}
export function HomePage({IconMark,authenticated=false,api}) {
  const [data,setData]=useState(null),[error,setError]=useState(false),[busy,setBusy]=useState(true),[filter,setFilter]=useState("all");
  const refreshRef=useRef(()=>{});
  useEffect(()=>{let active=true,inflight=false,controller;
    const refresh=async()=>{if(inflight||document.visibilityState==="hidden")return;inflight=true;controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8000);if(active)setBusy(true);try{const d=await api("/api/public/status",{signal:controller.signal});if(active){setData(d);setError(false)}}catch{if(active)setError(true)}finally{clearTimeout(timeout);inflight=false;if(active)setBusy(false)}};
    refreshRef.current=refresh;refresh();const timer=setInterval(refresh,5000);window.addEventListener("focus",refresh);window.addEventListener("online",refresh);document.addEventListener("visibilitychange",refresh);
    return()=>{active=false;controller?.abort();clearInterval(timer);window.removeEventListener("focus",refresh);window.removeEventListener("online",refresh);document.removeEventListener("visibilitychange",refresh)}},[api]);
  const refresh=()=>refreshRef.current();
  const machines=data?.machines||[];
  const online=error?0:machines.filter(m=>m.status==="online").length;
  const rate=key=>error||online===0?null:machines.filter(m=>m.status==="online").reduce((n,m)=>n+(m[key]||0),0);
  const visible=machines.filter(m=>filter==="all"||(filter==="online"?m.status==="online":m.status!=="online"));
  const stamp=data?.updatedAt;
  return <div className="access-page public-status-page"><AccessHeader IconMark={IconMark} authenticated={authenticated}/><main className="public-main">
    <section className="public-heading"><div><p className="eyebrow">PRIVATE NETWORK</p><h1>服务器状态</h1><p><span className="live-indicator"/>自动更新中 · 每 5 秒读取 Komari 状态</p></div><button className="button button-secondary" onClick={refresh} disabled={busy}><RefreshCw size={15} className={busy?"spin":""}/><span>刷新状态</span></button></section>
    <section className="public-summary" aria-label="运行概览"><article><Server size={19}/><span>在线机器</span><strong>{busy&&!data?"—":error?"—":online}<small> / {machines.length}</small></strong></article><article><ArrowUp size={19}/><span>实时上行</span><strong>{data?bytes(rate("up")):"—"}<small>{online>0&&!error?"/s":""}</small></strong></article><article><ArrowDown size={19}/><span>实时下行</span><strong>{data?bytes(rate("down")):"—"}<small>{online>0&&!error?"/s":""}</small></strong></article><article><Activity size={19}/><span>最近采集</span><strong className="summary-time">{timeLabel(stamp)}</strong><small>{error?"连接暂不可用":data?.monitorAvailable?"Komari 探针":"等待监控数据"}</small></article></section>
    <div className="public-toolbar"><div className="public-filters">{[["all","全部机器"],["online","在线"],["attention","待确认"]].map(([key,label])=><button key={key} onClick={()=>setFilter(key)} className={filter===key?"active":""}>{label}</button>)}</div><span><ShieldCheck size={14}/>只读状态</span></div>
    {error&&<p className="public-alert" role="alert">暂时无法更新状态，以下为上次读取的记录。请稍后重试。</p>}
    {busy&&!data?<div className="public-empty"><LoaderCircle className="spin" size={23}/><p>正在读取机器状态…</p></div>:<section className="public-grid" aria-label="机器状态列表">{visible.map((m,index)=>{const live=!error&&m.status==="online";return <article className="public-machine" key={m.name+index}><header><span className="machine-flag">{m.flag||<Server size={23}/>}</span><div><h2>{m.name}</h2><p>{m.region||"地区待确认"}</p></div><span className={"public-badge "+(live?"online":"unknown")}><i/>{error?"待更新":live?"在线":m.status==="stale"?"上报过期":"等待采集"}</span></header><div className="public-resources">{[["CPU",m.cpu],["内存",m.memory],["磁盘",m.disk]].map(([label,value])=><div key={label}><span>{label}<strong>{live?percent(value):"—"}</strong></span><div className="resource-track"><i style={{width:live&&value!=null?`${Math.max(0,Math.min(100,value))}%`:"0%"}}/></div></div>)}</div><div className="public-network"><span><ArrowUp size={13}/>上行<strong>{live?bytes(m.up)+"/s":"—"}</strong></span><span><ArrowDown size={13}/>下行<strong>{live?bytes(m.down)+"/s":"—"}</strong></span></div><footer><span>{live?"探针已更新":"上次上报"}</span><time>{timeLabel(m.updated)}</time></footer></article>})}</section>}
    {!busy&&!error&&visible.length===0&&<div className="public-empty"><Server size={23}/><p>{machines.length?"当前筛选没有机器":"暂无已接入的机器"}</p></div>}
    <p className="public-source">在线状态、资源占用和实时速率读取 Komari。公开页不显示整机累计流量、套餐额度或订阅用户数据。</p>
  </main><footer className="access-footer"><span>SubHub · My Network</span><div><a href="/admin">管理后台 <ArrowRight size={13}/></a></div></footer></div>;
}

export function MemberPortal({IconMark,Button,token}) {
  const [data,setData]=useState(null),[busy,setBusy]=useState(true),[error,setError]=useState("");
  async function load(){
    setBusy(true);setError("");
    try{
      const response=await fetch(`/api/public/member/${encodeURIComponent(token)}`,{credentials:"same-origin"});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw Error(body.error||"订阅信息暂不可用");
      setData(body);
    }catch(value){setError(value.message||"订阅信息暂不可用")}
    finally{setBusy(false)}
  }
  useEffect(()=>{load()},[token]);
  const status=data?.status==="active"?"正常":data?.status==="exhausted"?"额度用尽":data?.status==="expired"?"已到期":data?.status==="disabled"?"已停用":"状态异常";
  const ratio=data?.limitGb>0?Math.min(100,data.usedGb/data.limitGb*100):0;
  const expiryDate=data?.expires?new Date(`${data.expires}T12:00:00`):null;
  const expiry=expiryDate&&!Number.isNaN(expiryDate.getTime())?new Intl.DateTimeFormat("zh-CN",{dateStyle:"long"}).format(expiryDate):"无期限";
  return <div className="access-page"><AccessHeader IconMark={IconMark}/><main className="member-portal"><section className="member-portal-card">
    <a className="back-home" href="/"><House size={15}/>返回首页</a>
    <div className="portal-mark"><Activity size={24}/></div><p className="eyebrow">MY SUBSCRIPTION</p><h1>{data?.name||"我的订阅"}</h1><p>{data?.profile||"正在读取订阅信息"}</p>
    {busy&&!data&&<div className="portal-loading"><LoaderCircle className="spin" size={22}/><span>正在读取用量</span></div>}
    {error&&<div className="portal-error"><p role="alert">{error}</p><Button icon={RefreshCw} onClick={load}>重新读取</Button></div>}
    {data&&<><div className="portal-status"><span className={"badge badge-"+(data.status==="active"?"green":"amber")}><i/>{status}</span><small>每 60 秒由 SubHub 同步用量</small></div><div className="portal-usage"><span>{data.resetDay?"本期用量":"累计用量"}</span><strong>{formatTrafficGB(data.usedGb)}</strong><small>{data.limitGb>0?`共 ${formatTrafficGB(data.limitGb)}`:"不限额"}</small><div className="resource-track"><i style={{width:`${ratio}%`}}/></div></div>{data.resetDay>0&&<p>累计 {formatTrafficGB(data.lifetimeUsedGb)} · 下次重置 {data.cycleEnd?new Date(data.cycleEnd).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"待同步"}（北京时间）</p>}<div className="portal-facts"><div><span>到期时间</span><strong>{expiry}</strong></div><div><span>可用节点</span><strong>{data.availableNodes}</strong></div><div><span>剩余额度</span><strong>{data.limitGb>0?formatTrafficGB(Math.max(0,data.limitGb-data.usedGb)):"不限额"}</strong></div></div></>}
  </section></main><footer className="access-footer"><span>SubHub · My Network</span></footer></div>;
}

export function LoginPage({IconMark,Button,Field,IconButton,api,onLogin,setupRequired,message}) {
  const [show,setShow]=useState(false),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  return <div className="access-page"><AccessHeader IconMark={IconMark}/><main className="login-main"><a className="back-home" href="/"><House size={15}/>返回首页</a><section className="login-card" aria-labelledby="login-title"><span className="login-symbol"><ShieldCheck size={25}/></span><p className="eyebrow">ADMINISTRATOR</p><h1 id="login-title">登录管理后台</h1><p className="login-description">管理你的服务器、节点与订阅。</p>{setupRequired?<p className="login-setup-info">管理员尚未初始化，请使用部署时生成的一次性设置链接。</p>:<form className="login-form" onSubmit={async e=>{e.preventDefault();if(busy)return;const f=new FormData(e.currentTarget);setBusy(true);setError("");try{await api("/api/login",{method:"POST",body:JSON.stringify({username:f.get("username"),password:f.get("password"),code:f.get("code")||"",remember:f.get("remember")==="on"})});await onLogin()}catch(e){setError(e.message)}finally{setBusy(false)}}}>
    <Field label="用户名"><input name="username" defaultValue="admin" required autoComplete="username" autoCapitalize="none" spellCheck={false}/></Field>
    <Field label="密码"><span className="password-input"><input name="password" type={show?"text":"password"} required autoComplete="current-password"/><IconButton label={show?"隐藏密码":"显示密码"} icon={show?EyeOff:Eye} type="button" onClick={()=>setShow(!show)}/></span></Field>
    <details className="login-otp"><summary>已启用二步验证？</summary><Field label="验证器验证码"><input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}"/></Field></details>
    <label className="remember-login"><input name="remember" type="checkbox" defaultChecked/><span>保持登录 30 天<small>在此浏览器记住登录状态，使用时自动延长。</small></span></label>
    {(error||message)&&<p className={error?"form-error":"login-message"} role={error?"alert":"status"}>{error||message}</p>}
    <Button variant="primary" type="submit" icon={busy?LoaderCircle:ArrowRight} disabled={busy}>{busy?"正在登录…":"登录"}</Button>
  </form>}</section><p className="login-footnote">公共设备可取消保持登录；使用后请退出。</p></main><footer className="access-footer"><span>SubHub · My Network</span></footer></div>;
}

export function AccessError({IconMark,Button,onRetry,busy}) {
  return <div className="access-page"><AccessHeader IconMark={IconMark}/><main className="access-error"><ShieldCheck size={30}/><h1>暂时无法打开后台</h1><p>未能确认登录状态或读取数据。请重试，已保存的登录状态会继续保留。</p><Button variant="primary" onClick={onRetry} disabled={busy} icon={LoaderCircle}>{busy?"正在重试…":"重新连接"}</Button><a href="/">返回首页</a></main></div>;
}
