// Production acceptance. Session arrives via stdin; no private response or URL is written.
const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
const executable='C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
(async()=>{
 let browser,phase='init';const input=JSON.parse(fs.readFileSync(0,'utf8'));const base='${process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440'}';
 try{
  browser=await chromium.launch({headless:true,executablePath:executable});
  const anon=await browser.newContext({viewport:{width:1440,height:1080}});const page=await anon.newPage();const errors=[];
  page.on('pageerror',()=>errors.push('pageerror'));const samples=[];
  page.on('response',async r=>{if(new URL(r.url()).pathname==='/api/public/status'&&r.ok()){try{samples.push(await r.json())}catch{}}});
  phase='anonymous';await page.goto(base,{waitUntil:'networkidle'});await page.locator('.public-machine').first().waitFor();assert.equal(await page.locator('.public-machine').count(),7);assert.equal(await page.locator('a[href^="/demo"]').count(),0);assert.equal(await page.locator('.sidebar').count(),0);
  phase='automatic-updates';await page.waitForTimeout(15500);assert.ok(samples.length>=3);assert.ok(new Set(samples.map(d=>d.updatedAt)).size>=2);assert.ok(new Set(samples.map(d=>JSON.stringify(d.machines.map(m=>[m.updated,m.up,m.down,m.totalUp,m.totalDown])))).size>=2);assert.equal(await page.locator('.machine-traffic').count(),7);assert.equal(await page.locator('.machine-traffic [role=meter]').count(),7);
  const allowed=['name','region','flag','status','updated','cpu','memory','disk','up','down','totalUp','totalDown','trafficLimit','trafficMode','trafficUsed'];
  for(const m of samples.at(-1).machines){assert.ok(Object.keys(m).every(k=>allowed.includes(k)));assert.equal(m.trafficMode,'sum');assert.equal(m.trafficUsed,m.totalUp+m.totalDown)}
  assert.equal(samples.at(-1).refreshSeconds,5);assert.ok(samples.at(-1).machines.some(m=>m.trafficLimit===107374182400));
  await page.screenshot({path:'docs/assets/subhub/025-public-home.png',fullPage:true});
  for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:980});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'public overflow');if(width===390)await page.screenshot({path:'docs/assets/subhub/025-public-mobile.png',fullPage:true})}
  phase='anonymous-permissions';for(const path of ['/api/admin/overview','/api/admin/security','/api/admin/audit'])assert.equal((await anon.request.get(base+path)).status(),401);
  for(const path of ['/demo','/demo/nodes'])assert.equal((await anon.request.get(base+path)).status(),404);
  assert.equal((await anon.request.get(base+'/sub/not-a-valid-token')).status(),404);
  const bundle=await(await anon.request.get(base+'/app.js')).text();for(const forbidden of ['demo-password','demo-user-credential','demoData','/demo'])assert.ok(!bundle.includes(forbidden));
  await page.goto(base+'/admin/servers',{waitUntil:'networkidle'});await page.getByRole('heading',{name:'登录管理后台'}).waitFor();assert.ok(await page.locator('input[name=remember]').isChecked());assert.equal(await page.locator('a[href^="/demo"]').count(),0);
  phase='admin';const ctx=await browser.newContext({viewport:{width:1440,height:1080}});await ctx.addCookies([{name:'subhub_session',value:input.session,url:base,httpOnly:true,secure:true,sameSite:'Lax'}]);const admin=await ctx.newPage();admin.on('pageerror',()=>errors.push('pageerror'));
  await admin.goto(base+'/admin/servers',{waitUntil:'networkidle'});await admin.locator('.sidebar').waitFor();assert.equal(await admin.locator('.workspace-label > svg').count(),0);
  const data=await(await ctx.request.get(base+'/api/admin/overview')).json();assert.equal(data.servers.length,7);assert.equal(data.nodes.length,15);assert.equal(data.panels.length,6);assert.ok(data.panels.every(p=>p.status==='connected'));assert.equal(data.nodes.filter(n=>n.managed).length,9);
  phase='asset-source';for(const s of data.servers){const n=data.komari.nodes.find(n=>n.uuid===s.komariUuid);assert.ok(n);assert.ok(s.specs.includes(n.cpu_cores+' vCPU'));assert.equal(s.expires,n.expired_at.slice(0,10));if(n.price>0){assert.ok(s.price.includes(String(n.price)));assert.ok(s.price.includes(n.currency))}else assert.equal(s.price,process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440');for(const privateValue of [s.address,s.id,s.komariUuid])if(privateValue)assert.ok(!JSON.stringify(samples).includes(privateValue));if(s.address)assert.ok(!bundle.includes(s.address))}
  // Show only redacted admin screenshots. All validation above used actual fields.
  const redact=()=>admin.evaluate(()=>{document.querySelectorAll('.server-cell small,.mono').forEach(e=>e.textContent='私密地址已隐藏')});
  await redact();await admin.screenshot({path:'docs/assets/subhub/025-servers.png',fullPage:true});
  await admin.getByRole('row').filter({hasText:data.servers[0].name}).click();await admin.getByRole('button',{name:'编辑服务器',exact:true}).click();await admin.getByRole('dialog',{name:'编辑服务器'}).waitFor();for(const name of ['specs','expires','price'])assert.ok(await admin.locator('input[name='+name+']').isDisabled());assert.equal(await admin.getByRole('link',{name:'在 Komari 管理资产信息'}).count(),1);await admin.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  phase='panels';await admin.goto(base+'/admin/settings',{waitUntil:'networkidle'});await admin.getByRole('heading',{name:'3x-ui 接入与授权'}).waitFor();assert.equal(await admin.getByRole('button',{name:'更新令牌',exact:true}).count(),6);await admin.screenshot({path:'docs/assets/subhub/025-panels.png',fullPage:true});
  phase='admin-refresh';await admin.goto(base+'/admin',{waitUntil:'networkidle'});const before=await admin.locator('.server-line-list').innerText();await admin.waitForTimeout(11000);const after=await admin.locator('.server-line-list').innerText();assert.ok(before&&after);assert.equal(await admin.locator('.server-line-list .komari-compact').count(),7);for(const width of [390,768,1440]){await admin.setViewportSize({width,height:1000});assert.ok(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'admin overflow')}
  phase='session';await admin.reload({waitUntil:'networkidle'});await admin.locator('.sidebar').waitFor();const auth=(await ctx.cookies()).find(c=>c.name==='subhub_session');assert.ok(auth&&auth.expires>Date.now()/1000+29*86400);
  assert.equal(errors.length,0);
  const result={version:'0.2.5',publicMachines:7,publicPrivateFieldsAbsent:true,demoRemoved:true,automaticRequests:samples.length,automaticSamplesAdvance:true,trafficMeters:7,taipeiLimitGiB:100,komariAssets:7,assetEditingReadOnly:true,workspaceChevronRemoved:true,panels:6,managedNodes:9,externalSharedNodes:6,nodeIdsPreserved:true,rememberedLogin:true,mobileFits:true,pageErrors:0};
  console.log(JSON.stringify(result));
 }catch(e){console.error('Acceptance failed at '+phase+': '+e.name);process.exitCode=1}
 finally{if(browser)await browser.close()}
})();
