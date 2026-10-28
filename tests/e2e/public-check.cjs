// Read-only public/admin acceptance; a disposable legacy session is supplied
// through stdin, upgraded and revoked during the check. Never save cookies.
const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const {session}=JSON.parse(fs.readFileSync(0,'utf8'));const base='${process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440'}';let phase='public';
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
 try{
  const ctx=await browser.newContext({viewport:{width:1440,height:1080},reducedMotion:'reduce'});const page=await ctx.newPage();const errors=[];page.on('pageerror',()=>errors.push('pageerror'));
  await page.goto(base,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'服务器状态',exact:true}).waitFor();
  let data=await(await ctx.request.get(base+'/api/public/status')).json();assert.equal(data.machines.length,7);
  const allowed=['name','region','flag','status','updated','cpu','memory','disk','up','down','totalUp','totalDown'];
  assert.ok(data.machines.every(m=>Object.keys(m).every(k=>allowed.includes(k))));
  assert.equal(await page.locator('.public-machine').count(),7);assert.equal(await page.locator('.sidebar').count(),0);assert.equal(await page.locator('.notice-demo').count(),0);assert.equal((await ctx.request.get(base+'/api/admin/overview')).status(),401);
  // Wait only for the existing monitoring cache; never trigger machine probes.
  for(let i=0;i<12&&!data.machines.some(m=>m.status==='online'&&m.cpu!==null);i++){await page.waitForTimeout(2500);data=await(await ctx.request.get(base+'/api/public/status')).json()}
  assert.ok(data.machines.some(m=>m.status==='online'&&m.cpu!==null));await page.getByRole('button',{name:'刷新状态'}).click();await page.getByRole('button',{name:'刷新状态'}).waitFor({state:'visible'});await page.waitForTimeout(800);
  await page.screenshot({path:'docs/assets/subhub/024-public-home.png',fullPage:true});
  for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));if(width===390)await page.screenshot({path:'docs/assets/subhub/024-public-mobile.png',fullPage:true})}
  phase='anonymous-login';await page.goto(base+'/admin/nodes',{waitUntil:'networkidle'});await page.getByRole('heading',{name:'登录管理后台'}).waitFor();assert.equal(new URL(page.url()).searchParams.get('next'),'/admin/nodes');assert.ok(await page.locator('input[name=remember]').isChecked());await page.screenshot({path:'docs/assets/subhub/024-login.png',fullPage:true});
  await page.setViewportSize({width:390,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'docs/assets/subhub/024-login-mobile.png',fullPage:true});await page.setViewportSize({width:1440,height:1080});
  phase='legacy-session';await ctx.addCookies([{name:'subhub_session',value:session,url:base,httpOnly:true,secure:true,sameSite:'Strict',expires:Math.floor(Date.now()/1000)+3600}]);await page.reload({waitUntil:'networkidle'});await page.locator('.sidebar').waitFor();assert.equal(new URL(page.url()).pathname,'/admin/nodes');assert.equal(await page.locator('tbody tr').count(),15);
  const cookie=(await ctx.cookies()).find(c=>c.name==='subhub_session');assert.equal(cookie.value,session);assert.equal(cookie.sameSite,'Lax');assert.ok(cookie.secure&&cookie.httpOnly&&cookie.expires>Date.now()/1000+29*86400);
  phase='header-navigation';await page.getByRole('button',{name:'管理后台',exact:true}).click();await page.getByRole('heading',{name:'服务器状态',exact:true}).waitFor();assert.ok((await(await ctx.request.get(base+'/api/session')).json()).authenticated);
  await page.locator('.access-header').getByRole('link',{name:'管理后台',exact:true}).click();await page.locator('.sidebar').waitFor();await page.reload({waitUntil:'networkidle'});await page.locator('.sidebar').waitFor();
  phase='logout';await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('heading',{name:'登录管理后台'}).waitFor();assert.ok(!(await(await ctx.request.get(base+'/api/session')).json()).authenticated);
  phase='demo';await page.goto(base+'/demo',{waitUntil:'networkidle'});await page.locator('.notice-demo').waitFor();assert.equal(errors.length,0);
  const result={publicMachines:data.machines.length,liveResources:data.machines.filter(m=>m.status==='online'&&m.cpu!==null).length,publicAllowlist:true,anonymousAdminDenied:true,homepageNotDemo:true,dedicatedLogin:true,rememberChecked:true,legacySessionUpgraded:true,sessionPreservedOnNavigation:true,explicitLogout:true,mobileFits:true,pageErrors:0};
  console.log(JSON.stringify(result));
 }catch(e){console.error('Public acceptance failed at '+phase+': '+e.name);process.exitCode=1}finally{await browser.close()}
})();
