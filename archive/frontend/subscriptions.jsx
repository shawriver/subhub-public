import React, {useState} from "react";
import {Network, Plus, Pencil, Trash2, Users, Search, CalendarDays} from "lucide-react";
import {NodeChecklist} from "./node-picker";

export const assignedSubscriptions = (data, member) => data.subscriptions.filter(s=>(member.subscriptionIds||[]).includes(s.id));
export const assignedNodes = (data, ids) => [...new Set(data.subscriptions.filter(s=>ids.includes(s.id)).flatMap(s=>s.nodeIds))];
const shanghaiToday = () => new Date(Date.now()+8*3600000).toISOString().slice(0,10);
export function memberAccessState(member){
  if(!member.enabled)return {label:"已停用",tone:"neutral"};
  if(member.expires&&member.expires<shanghaiToday())return {label:"已到期",tone:"red"};
  if(member.limit>0&&(member.quotaUsed??member.used)>=member.limit)return {label:"额度用尽",tone:"amber"};
  return {label:"可用",tone:"green"};
}

export function ExpiryField({initial=""}) {
  const [mode,setMode]=useState(initial?"date":"unlimited");
  const [date,setDate]=useState(initial);
  function extend(days){
    const base=date&&date>shanghaiToday()?date:shanghaiToday();
    const next=new Date(base+"T00:00:00Z");
    if(days==="year"){
      const month=next.getUTCMonth();next.setUTCFullYear(next.getUTCFullYear()+1);
      if(next.getUTCMonth()!==month)next.setUTCDate(0);
    }else next.setUTCDate(next.getUTCDate()+days);
    setDate(next.toISOString().slice(0,10));setMode("date");
  }
  return <fieldset className="expiry-field span-2"><legend>订阅有效期</legend>
    <div className="expiry-options">
      <label><input type="radio" name="expiryMode" value="unlimited" checked={mode==="unlimited"} onChange={()=>setMode("unlimited")}/>无期限</label>
      <label><input type="radio" name="expiryMode" value="date" checked={mode==="date"} onChange={()=>setMode("date")}/>指定到期日期</label>
    </div>
    {mode==="unlimited"?<><input type="hidden" name="expires" value=""/><p>不因时间到期；仍受启用状态和流量额度控制。</p></>:<div className="expiry-date-row"><label>到期日期<input name="expires" aria-label="到期日期" type="date" required value={date} onChange={e=>setDate(e.target.value)}/></label><span>北京时间，当天结束后到期。</span></div>}
    <div className="expiry-shortcuts"><CalendarDays size={15}/><span>快捷设置</span>{[[7,"+7 天"],[30,"+30 天"],[90,"+90 天"],["year","+1 年"]].map(([days,label])=><button type="button" key={days} onClick={()=>extend(days)}>{label}</button>)}</div>
    {mode==="date"&&<p>{date&&date<shanghaiToday()?"该日期已过期，保存后将无法下载订阅。":"快捷设置从今天或已有的较晚到期日延长。"}</p>}
  </fieldset>;
}

export function SubscriptionPicker({data,selected,onChange}) {
  const [search,setSearch]=useState("");
  const visible=data.subscriptions.filter(s=>s.name.toLowerCase().includes(search.toLowerCase()));
  const nodes=assignedNodes(data,selected);
  return <section className="subscription-picker span-2" aria-label="分配订阅">
    <div className="node-picker-heading"><h3>分配订阅</h3><span>{selected.length} 个订阅 · {nodes.length} 个节点</span></div>
    <p className="form-intro">可选择多个订阅，重复节点会自动合并。修改订阅节点后，已分配用户会同步更新。</p>
    {data.subscriptions.length>0?<>
      <label className="node-picker-search"><Search size={16}/><input type="search" aria-label="搜索订阅" placeholder="搜索订阅…" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")e.preventDefault()}}/></label>
      <div className="subscription-picker-actions"><button type="button" onClick={()=>onChange([...new Set([...selected,...visible.map(s=>s.id)])])}>{search?"全选筛选结果":"全选订阅"}</button><button type="button" onClick={()=>onChange([])}>清空选择</button></div>
      <div className="subscription-choices">{visible.map(s=><label className={selected.includes(s.id)?"subscription-choice selected":"subscription-choice"} key={s.id}><input type="checkbox" checked={selected.includes(s.id)} onChange={e=>onChange(e.target.checked?[...selected,s.id]:selected.filter(id=>id!==s.id))}/><span><strong>{s.name}</strong><small>{s.nodeIds.length} 个节点{ s.note?" · "+s.note:""}</small></span></label>)}</div>
      {!visible.length&&<p className="form-intro">没有匹配的订阅，已选内容仍然保留。</p>}
    </>:<p className="form-intro">还没有订阅。请先在“订阅”页面建立订阅并选择节点，再到这里分配。</p>}
    {selected.map(id=><input key={id} type="hidden" name="subscription" value={id}/>)}
  </section>;
}

export function SubscriptionModal({data,subscription,onSave,onClose,ui}) {
  const {Modal,RecordForm,Field}=ui;
  const [selected,setSelected]=useState(subscription?.nodeIds||[]);
  const users=data.members.filter(m=>(m.subscriptionIds||[]).includes(subscription?.id)).length;
  return <Modal title={subscription?"编辑订阅":"新建订阅"} kicker="SUBSCRIPTION" onClose={onClose} wide record>
    <RecordForm onClose={onClose} label={subscription?"保存订阅":"创建订阅"} summary={`已选 ${selected.length} 个节点${users?` · ${users} 位用户将同步更新`:""}`} hint="先建立订阅，再到用户中分配。已有用户链接保持有效。" onSave={f=>onSave({...subscription,name:f.get("name"),note:f.get("note"),nodeIds:f.getAll("node")})}>
      <Field label="订阅名称" className="span-2"><input name="name" required data-dialog-autofocus defaultValue={subscription?.name||""} placeholder="例如：亚洲节点、全部节点"/></Field>
      <NodeChecklist nodes={data.nodes} servers={data.servers} selected={selected} onChange={setSelected}/>
      <details className="optional-fields span-2"><summary>说明（选填）</summary><Field label="订阅说明"><textarea name="note" defaultValue={subscription?.note||""}/></Field></details>
    </RecordForm>
  </Modal>;
}

export function SubscriptionsPage({data,search,onAdd,onEdit,onDelete,onMembers,ui}) {
  const {Button,IconButton,EmptyState,Badge}=ui;
  const subscriptions=data.subscriptions.filter(s=>!search||`${s.name} ${s.note}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="page-stack">
    <section className="page-heading"><div><p className="eyebrow">SUBSCRIPTIONS</p><h2>订阅</h2><p>先整理节点为订阅，再为用户分配。每位用户拥有独立链接和有效期。</p></div><div className="heading-actions"><Button icon={Users} onClick={()=>onMembers()}>管理用户</Button><Button variant="primary" icon={Plus} onClick={onAdd}>新建订阅</Button></div></section>
    <div className="subscription-steps"><span>1. 建立订阅，选择节点</span><span>2. 用户中分配订阅、设置有效期</span><span>3. 生成用户专属链接</span></div>
    {!subscriptions.length?<section className="panel"><EmptyState icon={Network} title={data.subscriptions.length?"没有匹配的订阅":"先建立第一个订阅"} body="无需先添加用户。选好节点、保存订阅后，就可以分配给不同用户。" action={<Button icon={Plus} onClick={onAdd}>新建订阅</Button>}/></section>:<div className="subscription-grid">{subscriptions.map(s=>{
      const members=data.members.filter(m=>(m.subscriptionIds||[]).includes(s.id));
      const nodes=data.nodes.filter(n=>s.nodeIds.includes(n.id));
      return <article className="panel subscription-card" key={s.id}>
        <header><span className="profile-icon"><Network size={20}/></span><div><h3>{s.name}</h3><p>{s.note||"共享节点集合，用户链接各自独立"}</p></div></header>
        <div className="subscription-card-meta"><Badge tone="teal">{nodes.length} 个节点</Badge><span>{nodes.filter(n=>n.enabled).length} 个启用</span><span>{members.length} 位用户</span></div>
        <details className="subscription-card-nodes"><summary>查看节点与分配</summary><div className="tags">{nodes.map(n=><span key={n.id}>{n.name}{n.enabled?"":"（停用）"}</span>)}</div><p>{members.length?"已分配："+members.map(m=>m.name).join("、"):"尚未分配给用户"}</p></details>
        <footer><Button icon={Pencil} onClick={()=>onEdit(s)}>编辑订阅</Button><div><Button icon={Users} onClick={()=>onMembers(s.name)}>查看用户</Button><IconButton label="删除订阅" icon={Trash2} onClick={()=>onDelete(s)}/></div></footer>
      </article>;
    })}</div>}
  </div>;
}
