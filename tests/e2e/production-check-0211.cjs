// Production reads only. --preview-assets substitutes local web assets and
// synthetic backup metadata in the browser before deployment. No business POSTs.
const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const preview=process.argv.includes('--preview-assets');
const base='${process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440'}';
const screenshots=path.resolve(__dirname,'../../docs/assets/subhub');
const prefix=preview?'0211-preview':'0211-production';
(async()=>{
 const {session}=JSON.parse(fs.readFileSync(0,'utf8'));
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
 let phase='start';
 try{
  const ctx=await browser.newContext({viewport:{width:390,height:900},reducedMotion:'reduce'});
  await ctx.addCookies([{name:'subhub_session',value:session,url:base,httpOnly:true,secure:true,sameSite:'Strict'}]);
  const blocked=[];
  await ctx.route('**/api/**',async route=>{
   const req=route.request(),p=new URL(req.url()).pathname;
   if(req.method()!=='GET'&&p!=='/api/session'){blocked.push(p);await route.abort();return}
   if(preview&&p==='/api/admin/security'){
    const response=await route.fetch(),data=await response.json();
    data.backups=[{name:'daily-20261021.sealed',createdAt:'2026-10-21T00:00:24Z',size:16990,status:'verified',counts:{server:6,node:13,member:1,panel:5,grant:3},detail:'加密完整性与格式校验通过；未执行恢复演练'},{name:'daily-20261017.sealed',createdAt:'2026-10-17T12:22:00Z',size:100,status:'empty',counts:{},detail:'完整性通过，但不含业务记录'}];
    await route.fulfill({response,json:data});return
   }
   await route.continue();
  });
  if(preview){for(const name of ['app.js','app.css'])await ctx.route('**/'+name+'*',route=>route.fulfill({path:path.join(__dirname,'../../web/dist',name),contentType:name.endsWith('.js')?'text/javascript':'text/css'}))}
  const page=await ctx.newPage(),errors=[];
  page.on('pageerror',()=>errors.push('pageerror'));
  const data=await(await ctx.request.get(base+'/api/admin/overview')).json();
  assert.equal(data.servers.length,6);assert.equal(data.nodes.length,13);assert.equal(data.panels.length,5);
  assert.ok(!data.servers.some(s=>s.id==='matrixsjc'));
  const pages=['overview','servers','nodes','members','subscriptions','tasks','settings'],checked=[];
  async function fits(label){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label+' document overflow')}
  async function close(){await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()}
  async function dialog(label){await page.getByRole('dialog').waitFor();await fits(label);assert.ok(await page.getByRole('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1),label+' dialog overflow');checked.push(label)}
  for(const name of pages){
   phase='mobile-'+name;
   await page.goto(base+'/admin/'+(name==='overview'?process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440':name),{waitUntil:'networkidle'});
   await page.locator('.sidebar').waitFor({state:'attached'});await fits(name);checked.push(name);
   if(name==='servers'){await page.getByRole('button',{name:'添加服务器',exact:true}).click();await dialog('add-server');await close()}
   if(name==='nodes'){
    const node=data.nodes.find(n=>data.nodeHealth[n.id]?.state==='reachable'),health=data.nodeHealth[node.id];
    const row=page.locator('tbody tr').filter({hasText:node.name});
    assert.ok((await row.innerText()).includes(health.latencyMs+' ms'),'list latency missing');
    await row.click();await dialog('node-detail');assert.ok(await page.getByRole('button',{name:'验证协议',exact:true}).count());assert.ok((await page.getByRole('dialog').innerText()).includes(health.latencyMs+' ms'),'detail latency differs');
    await page.getByRole('button',{name:'编辑配置',exact:true}).click();await dialog('node-edit');await close();
   }
   if(name==='members'){
    await page.getByRole('button',{name:'添加用户',exact:true}).click();await dialog('add-member');assert.equal(await page.locator('select[name=resetDay] option').count(),32);await close();
    await page.getByRole('button',{name:'用户详情',exact:true}).first().click();await dialog('member-detail');
    if(await page.getByRole('button',{name:'编辑链接配置',exact:true}).count()){
     await page.getByRole('button',{name:'编辑链接配置',exact:true}).first().click();await dialog('profile-rules');await close();
    }else await close();
   }
   if(name==='subscriptions'){await page.getByRole('button',{name:'新建订阅',exact:true}).click();await dialog('add-subscription');await close()}
   if(name==='settings'){
    await page.locator('.template-row').filter({hasText:'日常分流'}).getByRole('button',{name:'复制',exact:true}).click();await dialog('template-copy');await close();
    for(const [button,label] of [['接入面板','panel-connect'],['安全设置','security'],['备份与恢复','backup']]){
     await page.getByRole('button',{name:button,exact:true}).click();await dialog(label);
     if(label==='backup'){
      await page.locator('.backup-item').first().waitFor();
      assert.ok(await page.getByText('完整性通过',{exact:true}).count()>0);
      assert.ok(await page.getByText('空快照',{exact:true}).count()>0);
      await page.screenshot({path:path.join(screenshots,prefix+'-backup-mobile.png')});
      await page.setViewportSize({width:1440,height:1050});await fits('backup-desktop');
      await page.screenshot({path:path.join(screenshots,prefix+'-backup-desktop.png')});
      await page.setViewportSize({width:390,height:900});
     }
     await close();
    }
   }
  }
  phase='public';const anon=await browser.newContext({viewport:{width:390,height:900}}),pub=await anon.newPage();
  const status=await(await anon.request.get(base+'/api/status')).json();assert.equal(status.version,preview?'0.2.10':'0.2.11');
  const publicData=await(await anon.request.get(base+'/api/public/status')).json();assert.equal(publicData.machines.length,6);
  const allowed=['name','region','flag','status','updated','cpu','memory','disk','up','down'];
  assert.ok(publicData.machines.every(m=>Object.keys(m).every(k=>allowed.includes(k))));
  await pub.goto(base+'/',{waitUntil:'networkidle'});assert.ok(await pub.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal((await anon.request.get(base+'/api/admin/security')).status(),401);
  assert.equal(errors.length,0);assert.equal(blocked.length,0);
  const security=await(await ctx.request.get(base+'/api/admin/security')).json();
  if(!preview){assert.equal(security.backups.length,security.backupFiles.length);assert.ok(security.backups.some(b=>b.status==='verified'));assert.ok(security.backups.some(b=>b.status==='empty'))}
  console.log(JSON.stringify({version:status.version,previewAssets:preview,servers:6,nodes:13,panels:5,mobileWidth:390,pages:checked,nodeListDetailLatencyMatches:true,pageErrors:0,businessWrites:0,backups:preview?undefined:security.backups,publicFieldsRestricted:true}));
 }catch(e){console.error('Acceptance failed at '+phase+': '+e.message.replace(/https?:\/\/\S+/g,'[url]'));process.exitCode=1}
 finally{await browser.close()}
})();
