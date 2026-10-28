// Use an ephemeral session supplied on stdin. Edit only unsaved UI drafts;
// no real members, assignments, node records or subscriptions are mutated.
const {chromium}=require(process.env.SUBHUB_PLAYWRIGHT_MODULE || 'playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
const executable=process.env.SUBHUB_CHROMIUM;
(async()=>{
 let browser,phase='setup';const {session}=JSON.parse(fs.readFileSync(0,'utf8')),base=(process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440');
 try{
  browser=await chromium.launch({headless:true,...(executable ? {executablePath:executable} : {})});const ctx=await browser.newContext({viewport:{width:1440,height:940}});
  await ctx.addCookies([{name:'subhub_session',value:session,url:base,httpOnly:true,secure:true,sameSite:'Lax'}]);
  const page=await ctx.newPage(),errors=[];let writes=0;page.on('pageerror',e=>errors.push(e.name));page.on('request',r=>{if(r.url().includes('/api/admin/')&&!['GET','HEAD'].includes(r.method()))writes++});
  page.setDefaultTimeout(15000);await page.goto(base+'/admin/members',{waitUntil:'networkidle'});await page.locator('.sidebar').waitFor();
  const status=await(await ctx.request.get(base+'/api/status')).json();assert.equal(status.version,'0.2.6');
  const data=await(await ctx.request.get(base+'/api/admin/overview')).json();const eligible=data.nodes.filter(n=>n.enabled);
  phase='member';await page.getByRole('button',{name:'添加用户',exact:true}).first().click();const dialog=page.getByRole('dialog',{name:'添加用户'});await dialog.waitFor();
  const selected=async()=>await dialog.locator('input[type=hidden][name=node]').evaluateAll(es=>es.map(e=>e.value));
  await dialog.getByRole('checkbox',{name:'全选',exact:true}).check();assert.equal((await selected()).length,eligible.length);
  await dialog.getByRole('button',{name:'反选',exact:true}).click();assert.equal((await selected()).length,0);
  const group=data.servers.find(s=>eligible.filter(n=>n.serverId===s.id).length>=2);assert.ok(group);
  await dialog.getByRole('checkbox',{name:'全选 '+group.name,exact:true}).check();const groupIDs=await selected();assert.equal(groupIDs.length,eligible.filter(n=>n.serverId===group.id).length);
  await dialog.getByRole('searchbox',{name:'搜索节点'}).fill('no matches');assert.equal((await selected()).length,groupIDs.length);assert.equal(await dialog.locator('.node-choice').count(),0);
  await dialog.getByRole('button',{name:'重置筛选',exact:true}).click();await dialog.getByRole('combobox',{name:'筛选节点协议'}).selectOption('AnyTLS');await dialog.getByRole('checkbox',{name:'全选筛选结果',exact:true}).check();
  const draft=await selected();await page.waitForTimeout(5600);assert.deepEqual(await selected(),draft);await dialog.getByRole('button',{name:'重置筛选',exact:true}).click();
  phase='layout';
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:940});
   await dialog.locator('.record-scroll').evaluate(e=>{const h=e.querySelector('.node-picker-heading');e.scrollTop=h.getBoundingClientRect().top-e.getBoundingClientRect().top+e.scrollTop-12});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
   for(const selector of [':scope > header','.record-footer']){const b=await dialog.locator(selector).boundingBox();assert.ok(b.y>=0&&b.y+b.height<=940)}
   if(width===390||width===1440){await dialog.screenshot({path:'docs/assets/subhub/026-live-member-'+(width===390?'mobile':'desktop')+'.png'});}
  }
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  phase='managed-edit';await page.goto(base+'/admin/nodes',{waitUntil:'networkidle'});assert.equal(await page.getByRole('button',{name:'更多',exact:true}).count(),0);assert.equal(await page.locator('.node-protocols').getByRole('button',{name:/VMess/}).count(),0);
  const managed=data.nodes.find(n=>n.panelId);assert.ok(managed);await page.getByRole('row').filter({has:page.getByText(managed.name,{exact:true})}).click();await page.getByRole('button',{name:'编辑配置',exact:true}).click();const edit=page.getByRole('dialog',{name:'编辑节点'});await edit.waitFor();for(const name of ['protocol','transport','security','serverId'])assert.ok(await edit.locator('select[name='+name+']').isDisabled());assert.equal(await edit.locator('input[name=credential]').count(),0);await edit.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'查看接入状态'}).click();await page.waitForURL('**/admin/settings');await page.getByRole('heading',{name:'3x-ui 接入与授权'}).waitFor();
  phase='private-boundary';const anonymous=await browser.newContext();assert.equal((await anonymous.request.get(base+'/api/admin/overview')).status(),401);assert.equal((await anonymous.request.get(base+'/demo')).status(),404);const publicData=await(await anonymous.request.get(base+'/api/public/status')).json();assert.equal(publicData.refreshSeconds,5);for(const server of data.servers)if(server.address)assert.ok(!JSON.stringify(publicData).includes(server.address));
  const after=await(await ctx.request.get(base+'/api/admin/overview')).json();assert.deepEqual(after.nodes,data.nodes);assert.deepEqual(after.members.map(m=>[m.id,m.nodeIds]),data.members.map(m=>[m.id,m.nodeIds]));assert.deepEqual(after.profiles,data.profiles);assert.equal(writes,0);assert.equal(errors.length,0);
  console.log(JSON.stringify({version:status.version,allSelect:eligible.length,groupSelect:true,filterPreservesSelection:true,pollingPreservesDraft:true,fixedActionsAllWidths:true,managedFieldsProtected:true,settingsNavigation:true,privateBoundaryPreserved:true,productionWrites:0,userAssignmentsPreserved:true,nodesPreserved:true,pageErrors:0}));
 }catch(e){console.error('Production selection check failed at '+phase+': '+e.name+' '+String(e.message).split('\n')[0].replace(/https?:\/\/[^ ]+/g,'[URL omitted]'));process.exitCode=1}
 finally{if(browser)await browser.close()}
})();
