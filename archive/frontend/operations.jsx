import React,{useState,useEffect} from "react";
import {KomariSettings} from "./komari";

const api=async(path,body)=>{
 const r=await fetch("/api/admin/"+path,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json","X-SubHub-Request":"1"},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await r.json();if(!r.ok)throw Error(data.error||"操作失败");return data;
};
const stamp=v=>v?new Date(v).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"尚未同步";
const stateName={active:"授权已下发",revoked:"授权已撤销",error:"同步失败",pending:"等待同步"};
const backupState={verified:"完整性通过",empty:"空快照",invalid:"校验失败",unreadable:"无法读取",unchecked:"未校验"};
const backupKinds={server:"服务器",node:"节点",member:"用户",profile:"链接配置",subscription:"订阅",panel:"面板",grant:"授权",rule_template:"分流模板"};
const backupSize=n=>n<1024?`${n} B`:n<1024*1024?`${(n/1024).toFixed(1)} KiB`:`${(n/1024/1024).toFixed(1)} MiB`;
export function GrantList({grants=[],memberId}){
 const rows=grants.filter(g=>g.memberId===memberId);
 return <div className="drawer-section"><h3>节点授权同步</h3>{rows.length?rows.map(g=><div className="operation-row" key={g.id}><strong>{stateName[g.state]||g.state}</strong><small>{g.error||stamp(g.lastSync)}</small></div>):<p>分配受管节点后，系统会创建独立授权。手动导入的节点仍使用共享凭据。</p>}</div>;
}
export function OperationsSettings({data,demo,onRefresh,onLogout,ui}){
 const {Button,Modal,Field}=ui;
 const [dialog,setDialog]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[security,setSecurity]=useState(null),[selected,setSelected]=useState(null),[discovered,setDiscovered]=useState(null),[message,setMessage]=useState("");
 const [otp,setOTP]=useState(null),[backup,setBackup]=useState(""),[preview,setPreview]=useState(null),[passphrase,setPassphrase]=useState("");
 useEffect(()=>{if(!demo)api("security").then(setSecurity).catch(e=>setError(e.message))},[demo,dialog]);
 const panels=data.panels||[];
 async function run(fn){if(busy)return;setBusy(true);setError("");try{await fn()}catch(e){setError(e.message)}finally{setBusy(false)}}
 const open=(name,panel=null)=>{setError("");setMessage("");setSelected(panel);setDialog(name);setOTP(null);setPreview(null);setBackup("");setPassphrase("");setDiscovered(null)};
 const close=()=>{if(!busy){setDialog("");setOTP(null);setBackup("");setPassphrase("");setPreview(null)}};
 const proof=f=>({password:f.get("password"),code:f.get("code")||""});
 const requireLogin=()=>{if(demo)throw Error("请先进入管理空间")};
 async function sync(){requireLogin();await api("sync",{});setMessage("同步已排队；状态会自动刷新");setTimeout(onRefresh,2500)}
 function authFields(){return <><Field label="当前管理员密码"><input name="password" type="password" required autoComplete="current-password"/></Field><Field label="验证器验证码（已启用时必填）"><input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6}/></Field></>}
 return <>
 <section className="panel settings-section operation-panel"><header><div><h3>3x-ui 接入与授权</h3><p>每 60 秒同步用户授权与订阅流量</p></div></header>
 <p className="form-intro">受管节点为每位用户下发独立凭据。停用或移除分配会撤销节点授权；同步中断时，授权最长约 3 分钟后到期。手动导入节点的共享凭据需另行管理。</p>
 <div className="operation-actions"><Button onClick={()=>open("panel")}>接入面板</Button><Button disabled={busy||demo} onClick={()=>run(sync)}>立即同步</Button><Button disabled={busy||demo} onClick={onRefresh}>刷新状态</Button></div>
 {panels.map(p=><div className="operation-row" key={p.id}><div><strong>{p.name}</strong><small>{p.status==="connected"?"已连接":"连接异常"} · {stamp(p.lastSync)}</small>{p.error&&<small className="form-error">{p.error}</small>}</div><div className="operation-actions"><Button onClick={()=>run(async()=>{open("discover",p);setDiscovered(await api("panels/"+p.id+"/discover"))})}>发现节点</Button><Button onClick={()=>open("panel",p)}>更新令牌</Button><Button onClick={()=>open("restart",p)}>重启 Xray</Button></div></div>)}
 {!panels.length&&<p className="form-intro">尚未接入面板。需要 HTTPS 地址与 3x-ui v3 API 令牌。</p>}
 </section>
 <KomariSettings data={data} demo={demo} onRefresh={onRefresh} ui={ui}/>
 <section className="panel settings-section"><header><div><h3>安全与备份</h3><p>管理员账户和可恢复的数据</p></div></header>
 <div className="setting-row"><div><strong>验证器二步验证</strong><span>{security?.totpEnabled?"已启用":"尚未启用"}</span></div><Button onClick={()=>open("security")}>安全设置</Button></div>
 <div className="setting-row"><div><strong>每日加密备份</strong><span>保留最近 7 份；本机恢复需要原主密钥</span></div><Button onClick={()=>open("backup")}>备份与恢复</Button></div>
 <p className="form-intro">下载使用独立密码加密的备份，可恢复到新安装。备份不包含管理员密码和二步密钥；恢复保留当前管理员并撤销旧订阅链接。</p>
 </section>
 {message&&!dialog&&<p className="form-intro">{message}</p>}{error&&!dialog&&<p role="alert" className="form-error">{error}</p>}
 {dialog&&<Modal title={{panel:selected?"更新面板令牌":"接入 3x-ui 面板",discover:"发现现有入站",restart:"重启 Xray",security:"管理员安全",backup:"加密备份与恢复"}[dialog]} kicker="WORKSPACE OPERATIONS" onClose={close} wide>
 {dialog==="panel"&&<form className="form-grid" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);run(async()=>{requireLogin();await api("panels",{id:selected?.id||"",name:f.get("name"),serverId:f.get("serverId"),url:f.get("url"),token:f.get("token")});await onRefresh();setDialog("");setMessage("面板已连接，令牌已加密保存")})}}>
 <Field label="面板名称"><input name="name" required defaultValue={selected?.name||""}/></Field><Field label="所属服务器"><select name="serverId" required defaultValue={selected?.serverId||data.servers[0]?.id||""}>{data.servers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
 <Field label="面板基础地址" className="span-2"><input name="url" type="url" required defaultValue={selected?.url||""} placeholder="https://panel.example.com/your-path/" readOnly={Boolean(selected)}/><small>远程使用 HTTPS；同机允许回环 IP 的 HTTP 地址。</small></Field>
 <Field label="API 令牌" className="span-2"><input name="token" type="password" autoComplete="new-password" required={!selected} placeholder={selected?"留空保留原令牌":""}/></Field><Button type="submit" disabled={busy||demo}>{busy?"连接中…":"测试并保存连接"}</Button>
 </form>}
 {dialog==="discover"&&<div className="login-form"><p>接入会创建 SubHub 节点记录，现有节点用户保持原样。为家人朋友分配后才创建新的独立授权。</p>{discovered===null?<p>读取中…</p>:discovered.map(v=><div className="operation-row" key={v.id}><div><strong>{v.name||"入站 "+v.id}</strong><small>{v.reason||(v.node.protocol+" · "+v.node.host+":"+v.node.port)}</small></div><Button disabled={busy||!v.supported||data.nodes.some(n=>n.panelId===selected.id&&n.inboundId===v.id)} onClick={()=>run(async()=>{await api("panels/"+selected.id+"/attach",{inboundId:v.id});await onRefresh();setMessage("已接入，可以在用户编辑中分配")})}>{data.nodes.some(n=>n.panelId===selected.id&&n.inboundId===v.id)?"已接入":"接入"}</Button></div>)}</div>}
 {dialog==="restart"&&<form className="login-form" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);run(async()=>{requireLogin();await api("panels/"+selected.id+"/restart",{confirm:f.get("confirm")});setDialog("");setMessage("Xray 重启请求成功");await onRefresh()})}}><p>会中断此服务器上所有代理连接。输入面板名称 <strong>{selected.name}</strong> 确认。</p><input name="confirm" required autoComplete="off"/><Button type="submit" variant="danger" disabled={busy}>确认重启 Xray</Button></form>}
 {dialog==="security"&&<form className="login-form" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget),action=e.nativeEvent.submitter?.value;run(async()=>{requireLogin();const p=proof(f);
 if(action==="start"){const r=await api("security/totp/start",p);setOTP(r);setMessage("将下方密钥添加到验证器，然后输入其当前验证码并确认启用");return}
 await api("security/"+action,{...p,...(action==="password"?{newPassword:f.get("newPassword")}:{})});setDialog("");await onLogout();})}}>
 {authFields()}<Field label="新密码（修改密码时填写）"><input name="newPassword" type="password" minLength={14} autoComplete="new-password"/></Field>
 {otp&&<div className="secret-box"><strong>验证器设置密钥</strong><input readOnly value={otp.secret} aria-label="验证器设置密钥"/><small>在验证器中添加时间型 TOTP，6 位，每 30 秒更新。关闭窗口后不再显示。</small></div>}
 <div className="operation-actions"><button className="button" name="action" value="password" disabled={busy||demo}>修改密码</button>{security?.totpEnabled?<button className="button button-danger" name="action" value="totp/disable" disabled={busy}>关闭二步验证</button>:otp?<button className="button button-primary" name="action" value="totp/enable" disabled={busy}>确认启用二步验证</button>:<button className="button" name="action" value="start" disabled={busy||demo}>设置二步验证</button>}</div><p className="form-intro">修改成功会注销全部登录会话。启用二步验证后，登录需填写密码与验证码。</p>
 </form>}
 {dialog==="backup"&&<form className="login-form" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget),action=e.nativeEvent.submitter?.value;run(async()=>{requireLogin();const p={...proof(f),passphrase};
 if(action==="now"){await api("backup/now",p);setSecurity(await api("security"));setMessage("本机加密备份已创建");return}
 if(action==="export"){const r=await api("backup/export",p);const url=URL.createObjectURL(new Blob([r.content],{type:"application/octet-stream"}));const link=document.createElement("a");link.href=url;link.download=r.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setMessage("加密备份已下载，请单独保管备份密码");return}
 if(action==="preview"){setPreview(await api("backup/preview",{...p,content:backup}));return}
 await api("backup/restore",{...p,content:backup,digest:preview?.digest,confirm:f.get("confirm")});setDialog("");await onLogout();
 })}}>
 <section className="backup-list" aria-label="本机备份列表"><h3>本机备份 · {security?.backupFiles?.length||0} 份</h3><p>时间为北京时间；校验只检查加密完整性与格式，不代表已完成恢复演练。</p>{!security?<p>正在读取备份…</p>:security.backups?.length?security.backups.map(b=><article className="backup-item" key={b.name}><div><strong>{b.createdAt?stamp(b.createdAt):"创建时间未知"}</strong><span className={"backup-status backup-"+b.status}>{backupState[b.status]||"未知"}</span></div><small>{b.name} · {backupSize(b.size)}</small><small>{Object.entries(b.counts||{}).map(([kind,count])=>`${backupKinds[kind]||kind} ${count}`).join(" · ")||b.detail}</small><small>{b.status!=="verified"&&b.status!=="empty"?b.detail:""}</small></article>):<p>暂无本机备份</p>}</section>
 {authFields()}<Field label="独立备份密码"><input type="password" value={passphrase} autoComplete="new-password" onChange={e=>{setPassphrase(e.target.value);setPreview(null)}}/><small>仅下载或恢复便携备份时需要，至少 14 字节。本机备份只需当前管理员验证。</small></Field>
 <div className="operation-actions"><button className="button" value="now" disabled={busy||demo}>立即本机备份</button><button className="button button-primary" value="export" disabled={busy||demo||passphrase.length<14}>下载加密备份</button></div>
 <Field label="选择备份文件"><input type="file" accept=".shb" onChange={async e=>{const file=e.target.files?.[0];setPreview(null);if(!file)return;if(file.size>12*1024*1024){setError("备份文件不能超过 12 MB");return}setBackup(await file.text())}}/></Field>
 <button className="button" value="preview" disabled={busy||!backup||!passphrase}>预览恢复内容</button>
 {preview&&<div className="secret-box"><strong>备份时间：{stamp(preview.created)}</strong><p>{Object.entries(preview.counts).map(([k,n])=>({server:"服务器",node:"节点",member:"用户",profile:"订阅",panel:"面板",grant:"授权",rule_template:"分流模板"}[k]||k)+" "+n).join(" · ")}</p><p>恢复会覆盖管理记录、注销登录并撤销全部订阅链接；将先自动保存当前数据。节点授权会重新同步，需重新生成分发链接。</p><Field label="输入“恢复”确认"><input name="confirm" autoComplete="off"/></Field><button className="button button-danger" value="restore" disabled={busy}>确认恢复</button></div>}
 <small>本机备份：{security?.backupFiles?.length||0} 份。建议定期下载一份独立密码备份并保管到其他设备。</small>
 </form>}
 {message&&<p className="form-intro">{message}</p>}{error&&<p className="form-error" role="alert">{error}</p>}
 </Modal>}
 </>;
}
