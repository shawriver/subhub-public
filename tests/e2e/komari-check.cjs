const {chromium}=require(process.env.SUBHUB_PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const base=process.env.SUBHUB_BASE_URL||'http://127.0.0.1:18441';
 const browser=await chromium.launch({headless:true,...(process.env.SUBHUB_CHROMIUM ? {executablePath:process.env.SUBHUB_CHROMIUM} : {})});
 try{
  const ctx=await browser.newContext({viewport:{width:1440,height:1100}});
  await ctx.addCookies([{name:'subhub_session',value:process.env.SUBHUB_ACCEPT_SESSION,url:base,httpOnly:true,sameSite:'Strict',secure:base.startsWith('https:')}]);
  const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base,{waitUntil:'networkidle'});
  await page.waitForFunction(async()=>{const d=await(await fetch('/api/admin/overview')).json();return d.servers.length===3&&Object.keys(d.komari.metrics).length===3},null,{timeout:45000});
  const data=await page.evaluate(async()=>await(await fetch('/api/admin/overview')).json());
  assert.ok(data.servers.every(s=>s.komariUuid));
  assert.ok(Object.values(data.komari.metrics).every(m=>m.updated&&m.totalUp>=0&&m.totalDown>=0));
  await page.getByRole('heading',{name:'订阅流量',exact:true}).waitFor();
  await page.screenshot({path:'docs/assets/subhub/021-overview.png',fullPage:true});
  await page.locator('.sidebar nav button').filter({hasText:'服务器'}).click();
  await page.getByRole('columnheader',{name:'整机累计流量'}).waitFor();
  await page.getByRole('columnheader',{name:'订阅累计流量'}).waitFor();
  await page.locator('tbody tr').first().click();
  const link=page.getByRole('link',{name:'打开流量历史与监控详情'});
  assert.equal(await link.getAttribute('href'),'https://monitor.example.com/instance/'+data.servers[0].komariUuid);
  const detail=await ctx.newPage();await detail.goto(await link.getAttribute('href'),{waitUntil:'domcontentloaded'});
  await detail.getByText(data.komari.metrics[data.servers[0].komariUuid].name+' 信息',{exact:true}).first().waitFor({timeout:20000});await detail.close();
  await page.keyboard.press('Escape');await page.locator('.sidebar nav button').filter({hasText:'设置'}).click();
  await page.getByRole('heading',{name:'Komari 关联'}).waitFor();
  assert.equal(await page.locator('select[aria-label^="Komari 探针："]').count(),3);
  assert.equal(await page.getByRole('button',{name:'主机操作',exact:true}).count(),0);
  if(base.startsWith('http://127.0.0.1')){
   const select=page.locator('select[aria-label^="Komari 探针："]').first();
   const chosen=await select.inputValue();await select.selectOption(process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440');
   await page.waitForFunction(async sid=>{const d=await(await fetch('/api/admin/overview')).json();return !d.servers.find(s=>s.id===sid).komariUuid},data.servers[0].id);
   await select.selectOption(chosen);await page.waitForFunction(async sid=>{const d=await(await fetch('/api/admin/overview')).json();return !!d.servers.find(s=>s.id===sid).komariUuid},data.servers[0].id);
   await page.waitForFunction(uuid=>{const el=document.querySelector('select[aria-label^="Komari 探针："]');return el&&!el.disabled&&el.value===uuid},chosen);
  }
  await page.screenshot({path:'docs/assets/subhub/021-komari-settings.png',fullPage:true});
  for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow '+width)}
  assert.equal(errors.length,0);console.log(JSON.stringify({komariLinked:3,trafficSourcesSeparated:true,detailLinkVerified:true,hostControlsRemoved:true,mobileFits:true,errors}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
