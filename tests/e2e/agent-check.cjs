const {chromium}=require(process.env.SUBHUB_PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.SUBHUB_CHROMIUM ? {executablePath:process.env.SUBHUB_CHROMIUM} : {})});
 try{
  assert.ok(process.env.SUBHUB_REVIEW_SESSION);
  const ctx=await browser.newContext({viewport:{width:1440,height:1100}});
  await ctx.addCookies([{name:'subhub_session',value:process.env.SUBHUB_REVIEW_SESSION,url:'http://127.0.0.1:18441',httpOnly:true,sameSite:'Strict'}]);
  const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:18441',{waitUntil:'networkidle'});
  await page.locator('.sidebar nav button').filter({hasText:'设置'}).click();
  const existing=await page.evaluate(async()=>{const d=await(await fetch('/api/admin/overview')).json();return d.tasks.map(t=>t.id)});
  await page.getByRole('button',{name:'检查系统更新',exact:true}).waitFor();
  await page.getByRole('button',{name:'检查系统更新',exact:true}).click();
  await page.waitForFunction(async old=>{const d=await(await fetch('/api/admin/overview')).json();return d.tasks.some(t=>!old.includes(t.id)&&t.kind==='check-updates'&&t.status==='done')},existing,{timeout:90000,polling:1500});
  await page.getByRole('button',{name:'主机操作',exact:true}).click();await page.getByRole('button',{name:'确认执行主机操作',exact:true}).click();
  assert.ok(await page.locator('.modal input[name=confirm]').evaluate(el=>!el.validity.valid));
  await page.keyboard.press('Escape');await page.locator('.sidebar nav button').filter({hasText:'任务'}).click();
  await page.getByRole('button',{name:'刷新',exact:true}).click();await page.getByText('检查系统更新',{exact:true}).first().waitFor();
  await page.screenshot({path:'docs/assets/subhub/020-host-tasks.png',fullPage:true});
  await page.setViewportSize({width:390,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.equal(errors.length,0);
  console.log(JSON.stringify({agentHeartbeat:true,readOnlyUpdateCheckCompleted:true,hostConfirmationRequired:true,mobileFits:true,errors}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
