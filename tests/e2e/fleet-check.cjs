// Read-only production acceptance. Session arrives on stdin; never persist it.
const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
 const {session}=JSON.parse(fs.readFileSync(0,'utf8'));
 const base=process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440';
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
 try{
  const ctx=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'});
  await ctx.addCookies([{name:'subhub_session',value:session,url:base,httpOnly:true,secure:true,sameSite:'Strict'}]);
  const page=await ctx.newPage();const errors=[];page.on('pageerror',()=>errors.push('pageerror'));
  await page.goto(base+'/admin',{waitUntil:'networkidle'});
  const data=await page.evaluate(async()=>await(await fetch('/api/admin/overview')).json());
  assert.equal(data.servers.length,7);assert.equal(data.nodes.length,15);
  assert.ok(data.servers.every(s=>!['itcdog-hk','dgn-hk'].includes(s.id)));
  assert.equal(data.nodes.filter(n=>n.panelId).length,6);
  assert.equal(data.nodes.filter(n=>!n.panelId).length,9);
  const aws=data.nodes.filter(n=>['lightsail-jp','lightsail-sg','aws-ec2-tpe'].includes(n.serverId));
  assert.equal(aws.length,9);assert.equal(aws.filter(n=>n.protocol==='AnyTLS').length,3);assert.ok(!aws.some(n=>n.protocol==='VMess'));
  assert.ok(aws.filter(n=>n.protocol==='AnyTLS').every(n=>n.transport==='tcp'&&n.security==='tls'&&n.port===18445));
  assert.ok(aws.filter(n=>n.protocol==='AnyTLS').every(n=>n.name===aws.find(p=>p.serverId===n.serverId&&p.protocol==='VLESS').name.replace('Reality','AnyTLS')));
  assert.equal(data.servers.filter(s=>s.komariUuid).length,7);
  assert.ok(data.panels.every(p=>p.status==='connected'));
  assert.ok(!data.nodes.some(n=>n.credential));
  await page.screenshot({path:'docs/assets/subhub/024-fleet-overview.png',fullPage:true});
  const nav=async name=>page.locator('.sidebar nav button').filter({hasText:name}).click();
  await nav('服务器');assert.equal(await page.locator('tbody tr').count(),7);
  assert.ok(await page.getByText('待确认',{exact:true}).count()>0);
  await page.screenshot({path:'docs/assets/subhub/024-fleet-servers.png',fullPage:true});
  await nav('节点');assert.equal(await page.locator('tbody tr').count(),15);
  assert.equal(await page.locator('tbody').getByText('共享凭据',{exact:true}).count(),9);
  assert.equal(await page.locator('tbody').getByText('独立授权',{exact:true}).count(),6);
  await page.screenshot({path:'docs/assets/subhub/024-fleet-nodes.png',fullPage:true});
  await page.locator('.node-protocols button').filter({hasText:'AnyTLS'}).click();
  assert.equal(await page.locator('tbody tr').count(),3);
  await page.locator('tbody tr').first().click();
  await page.getByText('此节点使用既有共享凭据，可用于订阅分发；SubHub 无法按用户统计流量或撤销共享凭据。',{exact:true}).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.node-protocols button').filter({hasText:'全部节点'}).click();
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:1000});
   if(width<=900)await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().right<=1);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflow');
   if(width===390)await page.screenshot({path:'docs/assets/subhub/024-fleet-mobile.png',fullPage:true});
  }
  const anonymous=await browser.newContext();
  const response=await anonymous.request.get(base+'/api/admin/overview');assert.equal(response.status(),401);
  const demoPage=await anonymous.newPage();await demoPage.goto(base+'/demo',{waitUntil:'networkidle'});
  await demoPage.getByText('这里展示虚构示例，不连接你的机器、不消耗节点流量。登录管理空间查看真实数据。',{exact:true}).waitFor();
  assert.equal(errors.length,0);
  console.log(JSON.stringify({servers:7,nodes:15,managed:6,shared:9,komariMapped:7,removedMachinesAbsent:true,anytlsFilter:true,sharedLabel:true,mobileFits:true,anonymousAdminDenied:true,pageErrors:errors.length}));
 }finally{await browser.close()}
})().catch(e=>{console.error('Fleet UI verification failed: '+e.name);process.exitCode=1});
