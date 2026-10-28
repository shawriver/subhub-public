// Read-only production acceptance for subscription connection policies.
const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const {session}=JSON.parse(fs.readFileSync(0,'utf8')); const base=process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440';
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
 try{
  const ctx=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  await ctx.addCookies([{name:'subhub_session',value:session,url:base,httpOnly:true,secure:true,sameSite:'Strict'}]);
  const page=await ctx.newPage(),errors=[],serverErrors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon')&&!m.text().includes('status of 401'))errors.push(m.text())});
  page.on('response',r=>{if(r.status()>=500)serverErrors.push(r.status()+' '+r.url())});
  const status=await(await ctx.request.get(base+'/api/status')).json();
  assert.equal(typeof status.version,'string');
  await page.goto(base+'/admin/subscriptions',{waitUntil:'networkidle'});await page.locator('.subscriptions-page').waitFor();
  const overview=await(await ctx.request.get(base+'/api/admin/overview')).json();
  assert.equal(overview.capabilities.connectionLimitPolicy,true);
  assert.equal(overview.capabilities.nativeConnectionEnforcement,false);
  assert.ok(Array.isArray(overview.subscriptions));assert.ok(Array.isArray(overview.members));
  for(const s of overview.subscriptions){const limit=s.connectionLimit??0;assert.ok(Number.isInteger(limit)&&limit>=0&&limit<=10000)}
  for(const m of overview.members){assert.ok(Number.isInteger(m.connectionLimit)&&m.connectionLimit>=0&&m.connectionLimit<=10000);assert.ok(['override','subscription','unlimited','unavailable'].includes(m.connectionLimitSource))}
  await page.getByRole('button',{name:'新建订阅',exact:true}).click();
  const subDialog=page.locator('.modal');await subDialog.getByText('新分配用户的默认并发连接上限',{exact:true}).waitFor();await page.keyboard.press('Escape');await subDialog.waitFor({state:'hidden'});
  await page.goto(base+'/admin/members',{waitUntil:'networkidle'});await page.locator('.members-page').waitFor();
  await page.getByRole('button',{name:'新建用户',exact:true}).first().click();
  const memberDialog=page.locator('.modal');await memberDialog.getByText('为此用户单独覆盖',{exact:true}).waitFor();const help=await memberDialog.innerText();assert.match(help,/多个订阅合并时取最宽松值/);assert.match(help,/当前 3x-ui 不提供通用的每用户 TCP 并发计数接口/);await page.keyboard.press('Escape');await memberDialog.waitFor({state:'hidden'});
  for(const path of ['/admin/subscriptions','/admin/members']){await page.goto(base+path,{waitUntil:'networkidle'});await page.setViewportSize({width:390,height:900});await page.waitForTimeout(300);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile overflow '+path);await page.setViewportSize({width:1440,height:1000});await page.waitForTimeout(300)}
  const publicStatus=await(await ctx.request.get(base+'/api/public/status')).json();assert.equal(typeof publicStatus.monitorAvailable,'boolean');
  const publicPage=await ctx.newPage();publicPage.on('pageerror',e=>errors.push(e.message));await publicPage.goto(base+'/status',{waitUntil:'domcontentloaded'});await publicPage.locator('.pub-page-wall').waitFor();assert.match(await publicPage.locator('body').innerText(),/服务器状态/);await publicPage.close();
  const portal=await ctx.newPage();portal.on('pageerror',e=>errors.push(e.message));await portal.goto(base+'/me/connection-policy-probe-invalid',{waitUntil:'domcontentloaded'});await portal.getByText('链接无效或已撤销',{exact:true}).waitFor();assert.match(await portal.locator('body').innerText(),/重新尝试/);await portal.close();
  assert.equal(serverErrors.length,0,serverErrors.join('\n'));assert.equal(errors.length,0,errors.join('\n'));
  console.log(JSON.stringify({version:status.version,capabilities:overview.capabilities,subscriptions:overview.subscriptions.length,members:overview.members.length,publicStatus:'ok',portalRoute:'ok',mobileFits:true,serverErrors:0,pageErrors:0}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
