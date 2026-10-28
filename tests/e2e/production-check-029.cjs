// Read-only production acceptance for SubHub 0.2.9. Session arrives on stdin
// and is revoked by scripts/lib/subhub-production-029.py after this exits.
const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const screenshots=path.resolve(__dirname,'../../docs/assets/subhub');

(async()=>{
  const {session}=JSON.parse(fs.readFileSync(0,'utf8'));
  const base='${process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440'}';
  const browser=await chromium.launch({headless:true,executablePath:'C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
  try{
    const anonymous=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const publicPage=await anonymous.newPage();const publicErrors=[];publicPage.on('pageerror',()=>publicErrors.push('pageerror'));
    const status=await(await anonymous.request.get(base+'/api/status')).json();
    assert.equal(status.version,'0.2.9');
    const publicData=await(await anonymous.request.get(base+'/api/public/status')).json();
    const allowed=['name','region','flag','status','updated','cpu','memory','disk','up','down'];
    assert.equal(publicData.machines.length,7);
    assert.ok(publicData.machines.every(machine=>Object.keys(machine).every(key=>allowed.includes(key))));
    await publicPage.goto(base+'/',{waitUntil:'networkidle'});
    await publicPage.getByRole('heading',{name:'服务器状态',exact:true}).waitFor();
    assert.equal(await publicPage.locator('.machine-traffic').count(),0);
    await publicPage.screenshot({path:path.join(screenshots,'029-production-public.png'),fullPage:true});
    await publicPage.setViewportSize({width:390,height:900});
    assert.ok(await publicPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.equal(publicErrors.length,0);

    const ctx=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    await ctx.addCookies([{name:'subhub_session',value:session,url:base,httpOnly:true,secure:true,sameSite:'Strict'}]);
    const page=await ctx.newPage();const errors=[];page.on('pageerror',()=>errors.push('pageerror'));
    await page.goto(base+'/admin/nodes',{waitUntil:'networkidle'});
    await page.locator('.sidebar').waitFor();
    assert.ok(await page.getByText('SubHub 0.2.9',{exact:true}).count()>0);
    const data=await(await ctx.request.get(base+'/api/admin/overview')).json();
    assert.equal(data.servers.length,7);
    assert.equal(data.nodes.length,15);
    assert.equal(Object.keys(data.nodeHealth||{}).length,15);
    await page.locator('tbody tr').first().waitFor();
    assert.equal(await page.locator('th').filter({hasText:'连通性'}).count(),1);
    assert.equal(await page.locator('th').filter({hasText:'订阅流量'}).count(),1);
    assert.equal(await page.locator('tbody .node-health .badge').count(),15);
    await page.screenshot({path:path.join(screenshots,'029-nodes-desktop.png'),fullPage:true});
    await page.goto(base+'/admin/tasks',{waitUntil:'networkidle'});
    await page.getByRole('heading',{name:'任务与变更'}).waitFor();
    await page.screenshot({path:path.join(screenshots,'029-tasks-desktop.png'),fullPage:true});
    assert.equal(errors.length,0);

    const states=Object.values(data.nodeHealth).reduce((acc,h)=>{acc[h.state]=(acc[h.state]||0)+1;return acc},{});
    console.log(JSON.stringify({version:status.version,publicMachines:7,publicTrafficFieldsHidden:true,nodes:15,nodeHealth:15,sidebarVersion:'0.2.9',nodeStates:states,publicPageErrors:0,adminPageErrors:0}));
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
