// Read-only production acceptance. Only unsaved UI drafts, no business writes.
const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const fs=require('node:fs'),assert=require('node:assert/strict');
const executable='C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
(async()=>{
 let browser,phase='start';const {session}=JSON.parse(fs.readFileSync(0,'utf8')),base='${process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440'}';
 try{
  browser=await chromium.launch({headless:true,executablePath:executable});const ctx=await browser.newContext({viewport:{width:1440,height:1000}});
  await ctx.addCookies([{name:'subhub_session',value:session,url:base,httpOnly:true,secure:true,sameSite:'Lax'}]);
  const page=await ctx.newPage(),errors=[];let writes=0;page.on('pageerror',e=>errors.push(e.name));page.on('request',r=>{if(r.url().includes('/api/admin/')&&!['GET','HEAD'].includes(r.method()))writes++});page.setDefaultTimeout(15000);
  const status=await(await ctx.request.get(base+'/api/status')).json();assert.equal(status.version,'0.2.7');
  const before=await(await ctx.request.get(base+'/api/admin/overview')).json();const owner=before.members.find(m=>m.id==='fixture-owner');assert.ok(owner);assert.equal(owner.nodeIds.length,9);assert.equal(owner.expires,process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440');assert.ok(owner.subscriptionIds.length);
  phase='subscriptions';await page.goto(base+'/admin/subscriptions',{waitUntil:'networkidle'});await page.locator('.subscription-card').first().waitFor();
  await page.getByRole('button',{name:'新建订阅',exact:true}).first().click();let dialog=page.getByRole('dialog',{name:'新建订阅'});assert.equal(await dialog.locator('select').count(),1);
  await dialog.getByRole('checkbox',{name:'全选',exact:true}).check();assert.equal(await dialog.locator('input[type=hidden][name=node]').count(),before.nodes.filter(n=>n.enabled).length);await dialog.getByRole('button',{name:'取消',exact:true}).click();
  phase='owner-unlimited';await page.goto(base+'/admin/members');await page.locator('.member-card').filter({hasText:owner.name}).getByRole('button',{name:'用户详情'}).click();await page.getByRole('button',{name:'编辑用户',exact:true}).click();dialog=page.getByRole('dialog',{name:'编辑用户'});
  assert.ok(await dialog.getByRole('radio',{name:'无期限',exact:true}).isChecked());assert.equal(await dialog.locator('input[type=hidden][name=subscription]').count(),owner.subscriptionIds.length);
  await dialog.getByRole('radio',{name:'指定到期日期'}).check();await dialog.getByRole('button',{name:'+30 天',exact:true}).click();assert.match(await dialog.locator('input[name=expires]').inputValue(),/^\d{4}-\d{2}-\d{2}$/);await dialog.getByRole('radio',{name:'无期限',exact:true}).check();
  await page.waitForTimeout(5600);assert.ok(await dialog.getByRole('radio',{name:'无期限',exact:true}).isChecked());
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:1000});await dialog.locator('.expiry-field').scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
   const footer=await dialog.locator('.record-footer').boundingBox();assert.ok(footer.y>=0&&footer.y+footer.height<=1000);
   if(width===390||width===1440)await dialog.screenshot({path:'docs/assets/subhub/027-live-member-'+(width===390?'mobile':'desktop')+'.png'});
  }
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  phase='privacy';const anonymous=await browser.newContext();assert.equal((await anonymous.request.get(base+'/api/admin/overview')).status(),401);assert.equal((await anonymous.request.get(base+'/demo')).status(),404);
  const publicData=JSON.stringify(await(await anonymous.request.get(base+'/api/public/status')).json());for(const s of before.servers)if(s.address)assert.ok(!publicData.includes(s.address));assert.ok(!publicData.includes('subscriptionIds'));
  const after=await(await ctx.request.get(base+'/api/admin/overview')).json();assert.deepEqual(after.subscriptions,before.subscriptions);assert.deepEqual(after.profiles,before.profiles);assert.deepEqual(after.members.map(m=>[m.id,m.subscriptionIds,m.nodeIds,m.expires]),before.members.map(m=>[m.id,m.subscriptionIds,m.nodeIds,m.expires]));assert.equal(writes,0);assert.equal(errors.length,0);
  console.log(JSON.stringify({version:status.version,subscriptionFirst:true,ownerNodes:9,ownerUnlimited:true,assignmentPreserved:true,dateControls:true,draftPreserved:true,mobileFits:true,publicPrivacy:true,productionBusinessWrites:0,pageErrors:0}));
 }catch(e){console.error('Production subscription check failed at '+phase+': '+e.name+' '+String(e.message).split('\n')[0].replace(/https?:\/\/[^ ]+/g,'[URL omitted]'));process.exitCode=1}
 finally{if(browser)await browser.close()}
})();
