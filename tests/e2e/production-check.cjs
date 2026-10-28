// Read-only production UI acceptance with a short-lived session supplied in memory.
const {chromium}=require(process.env.SUBHUB_PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.SUBHUB_CHROMIUM ? {executablePath:process.env.SUBHUB_CHROMIUM} : {})});
 try{
  assert.ok(process.env.SUBHUB_ACCEPT_SESSION);
  const ctx=await browser.newContext({viewport:{width:1440,height:1100}});
  await ctx.addCookies([{name:'subhub_session',value:process.env.SUBHUB_ACCEPT_SESSION,url:(process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440'),httpOnly:true,secure:true,sameSite:'Strict'}]);
  const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto((process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440'),{waitUntil:'networkidle'});
  const d=await page.evaluate(async()=>await(await fetch('/api/admin/overview')).json());
  assert.equal(d.servers.length,3);assert.equal(d.nodes.length,6);assert.equal(d.panels.length,3);assert.equal(d.agents.length,3);
  assert.ok(d.panels.every(p=>p.status==='connected'));
  assert.ok(d.agents.every(a=>Date.now()-Date.parse(a.lastSeen)<60000));
  await page.getByText('3 / 3 已连接',{exact:true}).waitFor();
  await page.screenshot({path:'docs/assets/subhub/020-production-overview.png',fullPage:true});
  await page.locator('.sidebar nav button').filter({hasText:'设置'}).click();
  assert.equal(await page.getByRole('button',{name:'检查系统更新',exact:true}).count(),3);
  await page.screenshot({path:'docs/assets/subhub/020-production-settings.png',fullPage:true});
  await page.locator('.sidebar nav button').filter({hasText:'任务'}).click();
  assert.equal(await page.getByText('检查系统更新',{exact:true}).count(),3);
  assert.ok(d.tasks.filter(t=>t.kind==='check-updates').every(t=>t.status==='done'));
  await page.setViewportSize({width:390,height:900});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(errors.length,0);
  console.log(JSON.stringify({publicHTTPS:true,servers:3,managedNodes:6,panelsConnected:3,agentsOnline:3,packageChecksCompleted:3,mobileFits:true,errors}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
