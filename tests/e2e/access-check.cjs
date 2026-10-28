// Isolated synthetic-account acceptance. All credentials/cookies stay in memory.
const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const executable='C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'subhub-access-025-'));let app,browser;let phase='setup';
 try{
  const p=await port(),base='http://127.0.0.1:'+p;
  const binary=path.resolve('subhub.exe');
  const args=['-data',dir,'-listen','127.0.0.1:'+p,'-origin',base];
  const setup=execFileSync(binary,[...args,'-issue-setup'],{encoding:'utf8',windowsHide:true}).trim();
  const password=crypto.randomBytes(24).toString('base64url');
  app=spawn(binary,args,{stdio:'ignore',windowsHide:true});
  for(let i=0;i<50;i++){try{if((await fetch(base+'/api/status')).ok)break}catch{}await sleep(100)}
  const init=await fetch(base+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:setup,username:'admin',password})});assert.equal(init.status,200);
  browser=await chromium.launch({headless:true,executablePath:executable});
  let ctx=await browser.newContext({viewport:{width:1440,height:1000}}),page=await ctx.newPage();const errors=[];page.on('pageerror',()=>errors.push('pageerror'));
  phase='public-entry';await page.goto(base,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'服务器状态',exact:true}).waitFor();assert.equal(await page.locator('.sidebar').count(),0);assert.equal((await ctx.request.get(base+'/api/admin/overview')).status(),401);
  phase='login-page';await page.goto(base+'/admin/nodes',{waitUntil:'networkidle'});await page.getByRole('heading',{name:'登录管理后台'}).waitFor();assert.equal(new URL(page.url()).pathname,'/login');assert.equal(new URL(page.url()).searchParams.get('next'),'/admin/nodes');assert.equal(await page.locator('.modal').count(),0);assert.ok(await page.locator('input[name=remember]').isChecked());
  for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'login overflow')}
  await page.screenshot({path:'docs/assets/subhub/025-login-local.png',fullPage:true});
  phase='real-login';await page.locator('input[name=password]').fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.sidebar').waitFor();assert.equal(new URL(page.url()).pathname,'/admin/nodes');
  let cookies=await ctx.cookies();let auth=cookies.find(c=>c.name==='subhub_session');assert.ok(auth&&auth.httpOnly&&auth.sameSite==='Lax'&&auth.expires>Date.now()/1000+29*86400);
  phase='public-redaction';const fixture={id:'acceptance-only',name:'Acceptance machine',region:'Japan',address:'private-address.example',note:'private-note-never-public',price:'private-price'};
  const saved=await ctx.request.put(base+'/api/admin/server/'+fixture.id,{headers:{'X-SubHub-Request':'1'},data:fixture});assert.equal(saved.status(),200);
  const publicData=await(await ctx.request.get(base+'/api/public/status')).json();assert.equal(publicData.machines.length,1);const text=JSON.stringify(publicData);for(const denied of ['private-address','private-note','private-price','acceptance-only'])assert.ok(!text.includes(denied));
  phase='automatic-traffic-updates';let samples=0;
  await page.route('**/api/public/status',r=>{samples++;return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({updatedAt:new Date(Date.now()+samples*1000).toISOString(),monitorAvailable:true,refreshSeconds:5,machines:[{name:'Synthetic status fixture',region:'Japan',status:'online',updated:new Date().toISOString(),cpu:22,memory:44,disk:11,up:1024,down:2048,totalUp:samples*1073741824,totalDown:2147483648,trafficLimit:107374182400,trafficUsed:(samples+2)*1073741824,trafficMode:'sum'}]})})});
  await page.goto(base,{waitUntil:'networkidle'});await page.locator('.machine-traffic').waitFor();const firstAmount=await page.locator('.traffic-amount').innerText();await page.waitForTimeout(10800);assert.ok(samples>=3);assert.notEqual(await page.locator('.traffic-amount').innerText(),firstAmount);
  for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'traffic home overflow')}
  await page.screenshot({path:'docs/assets/subhub/025-public-local.png',fullPage:true});await page.unroute('**/api/public/status');await page.goto(base+'/admin',{waitUntil:'networkidle'});await page.locator('.sidebar').waitFor();assert.equal(await page.locator('.workspace-label > svg').count(),0);
  phase='header-does-not-logout';await page.getByRole('button',{name:'管理后台',exact:true}).click();await page.getByRole('heading',{name:'服务器状态',exact:true}).waitFor();assert.equal((await ctx.request.get(base+'/api/session')).status(),200);assert.ok((await(await ctx.request.get(base+'/api/session')).json()).authenticated);await page.locator('.access-header').getByRole('link',{name:'管理后台',exact:true}).click();await page.locator('.sidebar').waitFor();
  phase='refresh-restores';await page.reload({waitUntil:'networkidle'});await page.locator('.sidebar').waitFor();
  phase='browser-reopen';cookies=(await ctx.cookies()).filter(c=>c.expires>Date.now()/1000);await browser.close();browser=await chromium.launch({headless:true,executablePath:executable});ctx=await browser.newContext({viewport:{width:1440,height:1000}});await ctx.addCookies(cookies);page=await ctx.newPage();page.on('pageerror',()=>errors.push('pageerror'));await page.goto(base+'/admin',{waitUntil:'networkidle'});await page.locator('.sidebar').waitFor();
  phase='app-restart';app.kill();await new Promise(r=>app.once('exit',r));app=spawn(binary,args,{stdio:'ignore',windowsHide:true});for(let i=0;i<50;i++){try{if((await fetch(base+'/api/status')).ok)break}catch{}await sleep(100)}await page.reload({waitUntil:'networkidle'});await page.locator('.sidebar').waitFor();
  phase='temporary-network-error';await page.route('**/api/session',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"temporary failure"}'}));await page.reload({waitUntil:'networkidle'});await page.getByRole('heading',{name:'暂时无法打开后台'}).waitFor();assert.ok((await ctx.cookies()).some(c=>c.name==='subhub_session'));assert.equal(await page.locator('.notice-demo').count(),0);await page.unroute('**/api/session');await page.getByRole('button',{name:'重新连接',exact:true}).click();await page.locator('.sidebar').waitFor();
  phase='demo-removed';assert.equal((await page.goto(base+'/demo',{waitUntil:'networkidle'})).status(),404);assert.ok((await(await ctx.request.get(base+'/api/session')).json()).authenticated);await page.goto(base+'/admin',{waitUntil:'networkidle'});await page.locator('.sidebar').waitFor();
  phase='explicit-logout';const oldCookie=(await ctx.cookies()).find(c=>c.name==='subhub_session');await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('heading',{name:'登录管理后台'}).waitFor();assert.ok(!(await(await ctx.request.get(base+'/api/session')).json()).authenticated);const replay=await fetch(base+'/api/admin/overview',{headers:{Cookie:'subhub_session='+oldCookie.value}});assert.equal(replay.status,401);
  phase='temporary-login';await page.locator('input[name=password]').fill(password);await page.locator('input[name=remember]').uncheck();await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.sidebar').waitFor();auth=(await ctx.cookies()).find(c=>c.name==='subhub_session');assert.equal(auth.expires,-1);assert.ok(auth.value.startsWith('s.'));
  phase='expiry-recovery';await page.route('**/api/admin/overview',r=>r.fulfill({status:401,contentType:'application/json',body:'{"error":"expired"}'}));await page.reload({waitUntil:'networkidle'});await page.getByRole('heading',{name:'登录管理后台'}).waitFor();assert.equal(await page.locator('.sidebar').count(),0);assert.equal(await page.locator('.notice-demo').count(),0);
  assert.equal(errors.length,0);
  const result={publicStatus:true,automaticTrafficUpdates:true,workspaceChevronRemoved:true,privateFieldsHidden:true,dedicatedLogin:true,deepLinkPreserved:true,remember30Days:true,reloadRestored:true,browserReopenRestored:true,appRestartRestored:true,networkFailureKeepsSession:true,explicitLogoutRevokes:true,temporaryLogin:true,expiredLoginClearsPrivateUI:true,mobileFits:true,pageErrors:0};
  fs.writeFileSync('docs/SUBHUB-025-ACCESS-CHECK-20261019.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }catch(e){console.error('Access acceptance failed at '+phase+': '+e.name);process.exitCode=1}
 finally{if(browser)await browser.close();if(app&&app.exitCode===null){app.kill();await new Promise(r=>app.once('exit',r))}fs.rmSync(dir,{recursive:true,force:true})}
})();
