// Read-only production acceptance. Session arrives on stdin and is revoked by
// scripts/lib/subhub-production-028.py after this process exits.
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
    assert.equal(status.version,'0.2.8');
    let publicData=await(await anonymous.request.get(base+'/api/public/status')).json();
    const allowed=['name','region','flag','status','updated','cpu','memory','disk','up','down'];
    assert.equal(publicData.machines.length,7);
    assert.ok(publicData.machines.every(machine=>Object.keys(machine).every(key=>allowed.includes(key))));
    await publicPage.goto(base+'/',{waitUntil:'networkidle'});
    await publicPage.getByRole('heading',{name:'服务器状态',exact:true}).waitFor();
    assert.equal(await publicPage.locator('.machine-traffic').count(),0);
    await publicPage.screenshot({path:path.join(screenshots,'028-production-public.png'),fullPage:true});
    await publicPage.setViewportSize({width:390,height:900});
    assert.ok(await publicPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.equal(publicErrors.length,0);

    const ctx=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    await ctx.addCookies([{name:'subhub_session',value:session,url:base,httpOnly:true,secure:true,sameSite:'Strict'}]);
    const page=await ctx.newPage();const errors=[];page.on('pageerror',()=>errors.push('pageerror'));
    await page.goto(base+'/admin/nodes',{waitUntil:'networkidle'});
    await page.locator('.sidebar').waitFor();
    assert.ok(await page.getByText('SubHub 0.2.8',{exact:true}).count()>0);
    const data=await(await ctx.request.get(base+'/api/admin/overview')).json();
    assert.equal(data.servers.length,7);
    assert.equal(data.nodes.length,15);
    assert.equal(Object.keys(data.nodeHealth||{}).length,15);
    await page.locator('tbody tr').first().waitFor();
    assert.equal(await page.locator('th').filter({hasText:'连通性'}).count(),1);
    assert.equal(await page.locator('th').filter({hasText:'订阅流量'}).count(),1);
    assert.equal(await page.locator('tbody .node-health .badge').count(),15);
    assert.ok(await page.locator('tbody').getByText('未统计',{exact:true}).count()>=1);
    await page.waitForFunction(()=>document.querySelectorAll('tbody .node-health .badge').length===15);
    assert.equal(errors.length,0);
    console.log(JSON.stringify({version:status.version,publicMachines:7,publicTrafficFieldsHidden:true,nodes:15,nodeHealth:15,sidebarVersion:'0.2.8',publicPageErrors:0,adminPageErrors:0}));
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
