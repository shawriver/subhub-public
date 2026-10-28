import React,{useEffect,useRef,useState} from "react";
import {Search,X,Server} from "lucide-react";

function SelectionCheckbox({checked,mixed=false,...props}) {
  const ref=useRef(null);
  useEffect(()=>{if(ref.current)ref.current.indeterminate=mixed},[mixed]);
  return <input ref={ref} type="checkbox" checked={checked} aria-checked={mixed?"mixed":checked} {...props}/>;
}

// The selected IDs live in the form, independently of search, grouping and
// polling. Hidden inputs serialize every selection, including filtered rows.
export function NodeChecklist({nodes,servers=[],selected=[],onChange,disabled=false}) {
  const [query,setQuery]=useState(""),[protocol,setProtocol]=useState("all");
  const selectedSet=new Set(selected);
  const ids=nodes.filter(n=>selectedSet.has(n.id)).map(n=>n.id);
  const serverName=id=>servers.find(s=>s.id===id)?.name||"未关联服务器";
  const term=query.trim().toLocaleLowerCase();
  const protocols=[...new Set(nodes.map(n=>n.protocol))];
  const visible=nodes.filter(n=>(protocol==="all"||n.protocol===protocol)&&(!term||`${n.name} ${n.host} ${n.protocol} ${serverName(n.serverId)}`.toLocaleLowerCase().includes(term)));
  const eligible=visible.filter(n=>n.enabled);
  const count=eligible.filter(n=>selectedSet.has(n.id)).length;
  const filtered=Boolean(term)||protocol!=="all";
  const groups=[...new Set(visible.map(n=>n.serverId))].map(id=>({id,name:serverName(id),nodes:visible.filter(n=>n.serverId===id)}));
  const change=next=>onChange?.([...new Set(next)]);
  const selectBatch=(batch,checked)=>{const values=new Set(batch.map(n=>n.id));change(checked?[...ids,...values]:ids.filter(id=>!values.has(id)))};
  const invert=()=>{const values=new Set(eligible.map(n=>n.id));change([...ids.filter(id=>!values.has(id)),...eligible.filter(n=>!selectedSet.has(n.id)).map(n=>n.id)])};
  return <section className="node-picker span-2" aria-label="节点分配">
    {ids.map(id=><input key={id} type="hidden" name="node" value={id} disabled={disabled}/>)}
    <header className="node-picker-heading"><h3>可用节点</h3><span role="status" className="node-selection-count">已选 <strong>{ids.length}</strong> / {nodes.length}</span></header>
    {nodes.length>0&&<>
      <div className="node-picker-filters"><label className="node-picker-search"><Search size={16}/><input type="search" aria-label="搜索节点" placeholder="搜索节点或服务器…" value={query} disabled={disabled} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")e.preventDefault()}}/>{query&&<button type="button" aria-label="清除节点搜索" disabled={disabled} onClick={()=>setQuery("")}><X size={15}/></button>}</label><select aria-label="筛选节点协议" value={protocol} disabled={disabled} onChange={e=>setProtocol(e.target.value)}><option value="all">全部协议</option>{[...new Set([...protocols,...(protocol!=="all"?[protocol]:[])])].map(p=><option key={p}>{p}</option>)}</select></div>
      <div className="node-picker-toolbar"><label className="node-bulk-select"><SelectionCheckbox checked={eligible.length>0&&count===eligible.length} mixed={count>0&&count<eligible.length} disabled={disabled||!eligible.length} onChange={e=>selectBatch(eligible,e.target.checked)}/><span>{filtered?"全选筛选结果":"全选"}</span></label><div><button type="button" disabled={disabled||!eligible.length} onClick={invert}>{filtered?"反选筛选结果":"反选"}</button><button type="button" disabled={disabled||!ids.length} onClick={()=>change([])}>清空已选</button></div></div>
      {filtered&&<p className="node-filter-summary">显示 {visible.length} 个节点 · 筛选不会清除已选节点<button type="button" disabled={disabled} onClick={()=>{setQuery("");setProtocol("all")}}>重置筛选</button></p>}
    </>}
    <div className="node-picker-groups">{groups.map(group=>{
      const enabled=group.nodes.filter(n=>n.enabled),checked=enabled.filter(n=>selectedSet.has(n.id)).length;
      return <section className="node-picker-group" key={group.id||"unassigned"} aria-label={group.name}>
        <header><label><SelectionCheckbox aria-label={`全选 ${group.name}${filtered?" 的筛选结果":""}`} checked={enabled.length>0&&checked===enabled.length} mixed={checked>0&&checked<enabled.length} disabled={disabled||!enabled.length} onChange={e=>selectBatch(enabled,e.target.checked)}/><Server size={14}/><strong>{group.name}</strong></label><span>{group.nodes.filter(n=>selectedSet.has(n.id)).length} / {group.nodes.length}</span></header>
        <div className="node-choice-grid">{group.nodes.map(n=><label key={n.id} className={"node-choice"+(selectedSet.has(n.id)?" is-selected":"")+(!n.enabled?" is-inactive":"")}><input type="checkbox" aria-label={n.name} checked={selectedSet.has(n.id)} disabled={disabled||(!n.enabled&&!selectedSet.has(n.id))} onChange={e=>change(e.target.checked?[...ids,n.id]:ids.filter(id=>id!==n.id))}/><span className={"protocol-mark "+String(n.protocol).toLowerCase().replace(/[^a-z0-9]/g,"")}>{n.protocol[0]}</span><span className="node-choice-copy"><strong title={n.name}>{n.name}</strong><small>{n.protocol}{n.security==="reality"?" · Reality":""} · {n.panelId?"独立授权":"共享凭据"}{!n.enabled?" · 已停用":""}</small></span></label>)}</div>
      </section>;
    })}</div>
    {!visible.length&&<p className="node-picker-empty">{nodes.length?"没有匹配的节点，试试其他关键词或重置筛选。":"暂无可分配节点，请先添加节点或为用户分配节点。"}</p>}
    {nodes.some(n=>!n.enabled)&&<p className="node-picker-note">已停用节点不参与全选；此前已选的节点可取消。</p>}
  </section>;
}
