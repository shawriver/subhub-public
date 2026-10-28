import React,{useState} from "react";
import {TrafficUsage} from "./access";
import {ExternalLink,Network} from "lucide-react";
import {formatBytes,formatTrafficGB} from "./format";

const origin="https://monitor.example.com";
const bytes=formatBytes;
const stamp=v=>v?new Date(v).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"尚未采集";
export const monitorURL=s=>s?.komariUuid?origin+"/instance/"+encodeURIComponent(s.komariUuid):origin;
export function KomariLink({server,children="在 Komari 查看"}){return <a className="button button-secondary komari-link" href={monitorURL(server)} target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()}><ExternalLink size={15}/><span>{children}</span></a>}
export const serverUsage=(data,sid)=>(data.grants||[]).reduce((sum,g)=>{const p=(data.panels||[]).find(p=>p.id===g.panelId);return sum+(p?.serverId===sid?Number(g.used||0):0)},0);
export function SubscriptionUsage({data,server}){return <div className="usage-cell"><strong>{bytes(serverUsage(data,server.id))}</strong><small>SubHub 用户累计</small></div>}
export function KomariStatus({data,server}){
 const m=data.komari?.metrics?.[server.komariUuid];
 const status=m?.status;
 return <span className={"badge badge-"+(status==="online"?"green":status==="stale"?"amber":"neutral")}>{!server.komariUuid?"未关联":status==="online"?"探针在线":status==="stale"?"数据已过期":m?.error?"采集异常":"等待采集"}</span>
}
export function KomariTraffic({data,server,compact=false}){
 const m=data.komari?.metrics?.[server.komariUuid];
 return <div className={compact?"komari-compact":"komari-detail"}>
 {!compact&&<div className="operation-row"><div><strong>整机流量 · Komari</strong><small>与订阅用户流量分别统计</small></div><KomariStatus data={data} server={server}/></div>}
 {m?.updated?<><div className="komari-counters"><span>↑ {bytes(m.totalUp)}</span><span>↓ {bytes(m.totalDown)}</span></div>{!compact&&<><TrafficUsage machine={m}/><p>实时速率：{m.status==="online"?`↑ ${bytes(m.up)}/s · ↓ ${bytes(m.down)}/s`:"暂无新数据"}</p><small>探针上报累计值，可能因重启或重置变化，不作为用户扣费依据。更新于 {stamp(m.updated)}</small></>}</>:<small>{server.komariUuid?(m?.error||data.komari?.error||"等待 Komari 数据"):"在设置中关联 Komari 探针"}</small>}
 {compact&&m?.status!=="online"&&<small>{m?.status==="stale"?"上次数据，已过期":"暂无新数据"}</small>}
 {!compact&&<KomariLink server={server}>打开流量历史与监控详情</KomariLink>}
 </div>
}
export function SubscriptionSummary({data}){
 const total=data.members.reduce((n,m)=>n+Number(m.used||0),0);
 const active=(data.grants||[]).filter(g=>g.state==="active").length;
 return <section className="panel subscription-summary"><header className="panel-heading"><div><p className="eyebrow">SUBSCRIPTION TRAFFIC</p><h3>订阅流量</h3></div><Network size={20}/></header><strong className="subscription-total">{formatTrafficGB(total)}</strong><p>当前用户累计用量 · 每 60 秒同步</p><div className="operation-row"><span>{data.members.filter(m=>m.enabled).length} 位启用用户</span><span>{active} 个有效节点授权</span></div><small>来自 3x-ui 的独立用户计数。服务器的系统流量和其他应用流量可在 Komari 查看。</small><KomariLink>打开 Komari 监控</KomariLink></section>
}
export function KomariSettings({data,demo,onRefresh,ui}){
 const {Button}=ui;const [error,setError]=useState(""),[busy,setBusy]=useState("");
 const nodes=data.komari?.nodes||[];
 const bind=async(s,uuid)=>{setBusy(s.id);setError("");try{const r=await fetch("/api/admin/komari/bind",{method:"POST",headers:{"Content-Type":"application/json","X-SubHub-Request":"1"},body:JSON.stringify({serverId:s.id,uuid})});const d=await r.json();if(!r.ok)throw Error(d.error||"关联失败");await onRefresh()}catch(e){setError(e.message)}finally{setBusy("")}};
 return <section className="panel settings-section operation-panel"><header><div><h3>Komari 关联</h3><p>VPS 监控由现有 Komari 提供，SubHub 管理订阅与用户用量</p></div><KomariLink>打开 Komari</KomariLink></header><p className="form-intro">关联后自动读取配置、到期、续费价格与整机流量，资产信息只需在 Komari 维护。无需再安装 SubHub Agent。</p>{data.komari?.error&&<p role="alert" className="form-error">{data.komari.error}</p>}
 {data.servers.map(s=><div className="operation-row komari-binding" key={s.id}><div><strong>{s.name}</strong><small>{nodes.find(n=>n.uuid===s.komariUuid)?.name|| (s.komariUuid?"已关联探针":"未关联探针")}</small></div><div className="operation-actions"><select aria-label={"Komari 探针："+s.name} value={s.komariUuid||""} disabled={demo||Boolean(busy)} onChange={e=>bind(s,e.target.value)}><option value="">不关联</option>{s.komariUuid&&!nodes.some(n=>n.uuid===s.komariUuid)&&<option value={s.komariUuid}>当前探针（列表暂不可用）</option>}{nodes.map(n=><option key={n.uuid} value={n.uuid}>{n.name}</option>)}</select><KomariLink server={s}>监控详情</KomariLink></div></div>)}
 <small>整机流量采用 Komari 探针上报值；订阅额度仍按独立用户流量计算。监控暂不可用不会停止订阅同步。</small>{error&&<p className="form-error" role="alert">{error}</p>}<div className="operation-actions"><Button disabled={demo||Boolean(busy)} onClick={onRefresh}>刷新关联状态</Button></div></section>
}
