// Isolated browser acceptance with generated credentials and synthetic records.
const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const executable='C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'subhub-selection-026-'));let app,browser,phase='setup';
 try{
  const port=await freePort(),base='http://127.0.0.1:'+port,binary=path.resolve('subhub.exe');
  const args=['-data',dir,'-listen','127.0.0.1:'+port,'-origin',base];
  const setup=execFileSync(binary,[...args,'-issue-setup'],{encoding:'utf8',windowsHide:true}).trim(),password=crypto.randomBytes(24).toString('base64url');
  app=spawn(binary,args,{stdio:'ignore',windowsHide:true});
  for(let i=0;i<60;i++){try{if((await fetch(base+'/api/status')).ok)break}catch{}await sleep(100)}
  assert.equal((await fetch(base+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:setup,username:'admin',password})})).status,200);
  browser=await chromium.launch({headless:true,executablePath:executable});
  const ctx=await browser.newContext({viewport:{width:1440,height:1000}}),page=await ctx.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.name));page.setDefaultTimeout(12000);
  await page.goto(base+'/admin/members');await page.locator('input[name=password]').fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.sidebar').waitFor();
  const put=async(kind,id,data)=>{const r=await ctx.request.put(base+'/api/admin/'+kind+'/'+id,{headers:{'X-SubHub-Request':'1'},data:{id,...data}});assert.equal(r.status(),200,'fixture save '+kind)};
  const overview=async()=>await(await ctx.request.get(base+'/api/admin/overview')).json();
  const locations=['东京 · 示例','新加坡 · 示例','欧洲 · 示例','美西 · 示例','香港 · 示例'];
  const nodes=[];
  for(let i=0;i<5;i++){
   await put('server','s'+i,{name:locations[i],address:'node'+i+'.example.test'});
   for(const [j,protocol] of ['VLESS','AnyTLS','Hysteria2'].entries()){
    const n={id:'n'+i+'-'+j,name:locations[i]+' · '+protocol,serverId:'s'+i,protocol,host:'node'+i+'.example.test',port:18440+j,transport:protocol==='Hysteria2'?'udp':'tcp',security:'tls',enabled:!(i===4&&j===2),tags:[],sni:'example.test',credential:crypto.randomUUID()};nodes.push(n);await put('node',n.id,n);
   }
  }
  await page.reload();await page.locator('.sidebar').waitFor();
  phase='all-and-groups';await page.getByRole('button',{name:'添加用户',exact:true}).first().click();let dialog=page.getByRole('dialog',{name:'添加用户'});await dialog.waitFor();assert.equal(await page.evaluate(()=>document.activeElement.name),'name');await dialog.locator('input[name=name]').fill('界面验收用户');
  const selected=async()=>await dialog.locator('input[type=hidden][name=node]').evaluateAll(es=>es.map(e=>e.value));
  const all=dialog.getByRole('checkbox',{name:'全选',exact:true});await all.check();assert.equal((await selected()).length,14);assert.ok(!((await selected()).includes('n4-2')));assert.equal(await all.getAttribute('aria-checked'),'true');
  await dialog.getByRole('checkbox',{name:nodes[0].name,exact:true}).uncheck();assert.equal(await all.getAttribute('aria-checked'),'mixed');
  await dialog.getByRole('button',{name:'清空已选',exact:true}).click();assert.equal((await selected()).length,0);
  await dialog.getByRole('checkbox',{name:'全选 '+locations[0],exact:true}).check();assert.deepEqual((await selected()).sort(),['n0-0','n0-1','n0-2']);
  phase='filtered-selection';await dialog.getByRole('searchbox',{name:'搜索节点'}).fill('新加坡');await dialog.getByRole('checkbox',{name:'全选筛选结果',exact:true}).check();assert.equal((await selected()).length,6);
  await dialog.getByRole('combobox',{name:'筛选节点协议'}).selectOption('AnyTLS');await dialog.getByRole('button',{name:'反选筛选结果',exact:true}).click();assert.equal((await selected()).length,5);assert.ok(!(await selected()).includes('n1-1'));assert.ok((await selected()).includes('n0-1'));
  await dialog.getByRole('searchbox',{name:'搜索节点'}).fill('no matches');assert.equal(await dialog.locator('.node-choice').count(),0);assert.equal((await selected()).length,5);assert.ok(await dialog.getByRole('checkbox',{name:'全选筛选结果',exact:true}).isDisabled());
  await dialog.getByRole('searchbox',{name:'搜索节点'}).press('Enter');assert.equal((await overview()).members.length,0);assert.equal(await dialog.count(),1);
  phase='polling-preserves-draft';const prior=await selected();await page.waitForTimeout(5400);assert.deepEqual(await selected(),prior);assert.equal(await dialog.locator('input[name=name]').inputValue(),'界面验收用户');
  phase='layout';await dialog.getByRole('button',{name:'重置筛选',exact:true}).click();
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:800});
   for(const bottom of [false,true]){
    await dialog.locator('.record-scroll').evaluate((e,bottom)=>{e.scrollTop=bottom?e.scrollHeight:0},bottom);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflow');assert.ok(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'dialog overflow');
    for(const sel of [':scope > header','.record-footer']){const box=await dialog.locator(sel).boundingBox();assert.ok(box.y>=0&&box.y+box.height<=800,'fixed action/header outside viewport')}
   }
   await dialog.locator('.record-scroll').evaluate(e=>{const picker=e.querySelector('.node-picker');e.scrollTop=picker.offsetTop-e.offsetTop});
   if(width===390||width===1440)await page.screenshot({path:'docs/assets/subhub/026-member-'+(width===390?'mobile':'desktop')+'.png'});
  }
  phase='save-filtered-hidden-selection';await dialog.getByRole('searchbox',{name:'搜索节点'}).fill('新加坡');await dialog.getByRole('button',{name:'添加用户',exact:true}).click();await dialog.waitFor({state:'hidden'});
  let member=(await overview()).members.find(m=>m.name==='界面验收用户');assert.deepEqual(member.nodeIds.sort(),prior.sort());
  phase='edit-roundtrip-and-error';await page.locator('.member-card').filter({hasText:member.name}).getByRole('button',{name:'用户详情'}).click();await page.getByRole('button',{name:'编辑用户',exact:true}).click();dialog=page.getByRole('dialog',{name:'编辑用户'});await dialog.waitFor();assert.deepEqual((await selected()).sort(),prior.sort());
  // A failed save retains every field and cannot be dismissed while in flight.
  let writes=0,release;const held=new Promise(r=>release=r);
  await page.route('**/api/admin/member/*',async r=>{if(r.request().method()!=='PUT')return r.continue();writes++;await held;await r.fulfill({status:503,contentType:'application/json',body:'{"error":"暂时无法保存，请重试"}'})});
  await dialog.getByRole('checkbox',{name:'全选',exact:true}).check();await dialog.getByRole('button',{name:'保存用户',exact:true}).click();await page.waitForFunction(()=>document.querySelector('form[aria-busy=true]'));
  assert.ok(await dialog.getByRole('button',{name:'正在保存…'}).isDisabled());await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.keyboard.press('Escape');assert.equal(await dialog.count(),1);assert.ok(await dialog.getByRole('searchbox').isDisabled());release();await dialog.getByRole('alert').waitFor();assert.equal(writes,1);assert.equal((await selected()).length,14);assert.equal(await dialog.locator('input[name=name]').inputValue(),member.name);
  await page.unroute('**/api/admin/member/*');await dialog.getByRole('button',{name:'保存用户',exact:true}).click();await dialog.waitFor({state:'hidden'});member=(await overview()).members.find(m=>m.id===member.id);assert.equal(member.nodeIds.length,14);
  phase='profile-drafts';await put('member','second-member',{name:'第二位示例用户',enabled:true,nodeIds:['n0-0','n1-0']});
  await page.goto(base+'/admin/subscriptions');await page.getByRole('button',{name:'新建订阅',exact:true}).click();dialog=page.getByRole('dialog',{name:'新建订阅'});await dialog.locator('input[name=name]').fill('验收订阅');await dialog.getByRole('combobox',{name:'所属用户'}).selectOption(member.id);
  const follow=dialog.getByRole('checkbox',{name:'跟随用户节点分配，自动同步新增和移除'});await follow.uncheck();assert.equal((await selected()).length,14);await dialog.getByRole('button',{name:'清空已选',exact:true}).click();await dialog.getByRole('checkbox',{name:'全选 '+locations[0],exact:true}).check();const draft=await selected();
  await follow.check();await follow.uncheck();assert.deepEqual(await selected(),draft);
  await dialog.getByRole('combobox',{name:'所属用户'}).selectOption('second-member');assert.deepEqual((await selected()).sort(),['n0-0','n1-0']);await dialog.getByRole('button',{name:'清空已选',exact:true}).click();
  await dialog.getByRole('combobox',{name:'所属用户'}).selectOption(member.id);assert.deepEqual(await selected(),draft);await dialog.getByRole('combobox',{name:'所属用户'}).selectOption('second-member');assert.equal((await selected()).length,0);await dialog.getByRole('combobox',{name:'所属用户'}).selectOption(member.id);
  await dialog.getByRole('searchbox').fill('no matches');await dialog.getByRole('button',{name:'创建订阅',exact:true}).click();await dialog.waitFor({state:'hidden'});const profile=(await overview()).profiles.find(p=>p.name==='验收订阅');assert.deepEqual(profile.nodeIds.sort(),draft.sort());assert.equal(profile.followMemberNodes,false);
  phase='node-edit-saving';await page.goto(base+'/admin/nodes');assert.equal(await page.getByRole('button',{name:'更多',exact:true}).count(),0);assert.equal(await page.locator('.node-protocols').getByRole('button',{name:/VMess/}).count(),0);
  await page.getByRole('button',{name:'查看接入状态'}).click();await page.waitForURL('**/admin/settings');await page.getByRole('heading',{name:'3x-ui 接入与授权'}).waitFor();
  await page.goto(base+'/admin/nodes');await page.getByRole('button',{name:'添加节点',exact:true}).first().click();dialog=page.getByRole('dialog',{name:'添加节点'});await dialog.locator('input[name=name]').fill('Standalone test');await dialog.locator('input[name=host]').fill('example.test');await dialog.locator('input[name=port]').fill('443');await dialog.locator('select[name=protocol]').selectOption('AnyTLS');await dialog.locator('input[name=credential]').fill(crypto.randomUUID());
  await page.route('**/api/admin/node/*',r=>r.request().method()==='PUT'?r.fulfill({status:503,contentType:'application/json',body:'{"error":"节点保存失败，请重试"}'}):r.continue());
  await dialog.getByRole('button',{name:'保存节点',exact:true}).click();await dialog.getByRole('alert').waitFor();assert.equal(await dialog.locator('input[name=name]').inputValue(),'Standalone test');await page.unroute('**/api/admin/node/*');await dialog.getByRole('button',{name:'保存节点',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.ok((await overview()).nodes.some(n=>n.name==='Standalone test'));
  phase='existing-disabled-selection';member.nodeIds=[...member.nodeIds,'n4-2'];await put('member',member.id,member);await page.goto(base+'/admin/members');await page.locator('.member-card').filter({hasText:member.name}).getByRole('button',{name:'用户详情'}).click();await page.getByRole('button',{name:'编辑用户',exact:true}).click();dialog=page.getByRole('dialog',{name:'编辑用户'});const inactive=dialog.getByRole('checkbox',{name:nodes.at(-1).name,exact:true});assert.ok(await inactive.isChecked());assert.ok(!await inactive.isDisabled());await inactive.uncheck();assert.ok(await inactive.isDisabled());await dialog.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(errors.length,0);
  const result={allSelect:true,groupSelect:true,filteredSelectAndInvert:true,clearAll:true,halfSelectedState:true,disabledNodesExcluded:true,existingDisabledCanDeselect:true,hiddenSelectionsSaved:true,pollingPreservesDraft:true,profileFollowTogglePreservesDraft:true,memberSwitchPreservesDraft:true,failedSavePreservesFields:true,savingBlocksDismissal:true,nodeSaveErrorInline:true,noInertMoreButton:true,settingsNavigation:true,emptyProtocolTabsRemoved:true,desktopAndMobileFixedActions:true,pageErrors:0};
  fs.writeFileSync('docs/SUBHUB-026-SELECTION-CHECK-20261019.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }catch(e){console.error('Selection acceptance failed at '+phase+': '+e.name+' '+String(e.message).slice(0,200));process.exitCode=1}
 finally{if(browser)await browser.close();if(app&&app.exitCode===null){app.kill();await new Promise(r=>app.once('exit',r))}fs.rmSync(dir,{recursive:true,force:true})}
})();
