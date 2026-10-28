// Synthetic acceptance for subscription defaults and per-member overrides.
const {chromium}=require(process.env.SUBHUB_PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const executable=process.env.SUBHUB_CHROMIUM;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'subhub-connection-policy-'));let app,browser,phase='setup';
 try{
  const port=await freePort(),base='http://127.0.0.1:'+port,binary=path.resolve('subhub.exe');
  const args=['-data',dir,'-listen','127.0.0.1:'+port,'-origin',base];
  const setup=execFileSync(binary,[...args,'-issue-setup'],{encoding:'utf8',windowsHide:true}).trim(),password=crypto.randomBytes(24).toString('base64url');
  app=spawn(binary,args,{stdio:'ignore',windowsHide:true});
  for(let i=0;i<60;i++){try{if((await fetch(base+'/api/status')).ok)break}catch{}await sleep(100)}
  assert.equal((await fetch(base+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:setup,username:'admin',password})})).status,200);
  browser=await chromium.launch({headless:true,...(executable ? {executablePath:executable} : {})});
  const ctx=await browser.newContext({viewport:{width:1440,height:1000}}),page=await ctx.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('favicon')&&!m.text().includes('status of 401'))errors.push(m.text())});page.setDefaultTimeout(12000);
  await page.goto(base+'/admin/subscriptions');await page.locator('input[name=username]').fill('admin');await page.locator('input[name=password]').fill(password);await page.getByRole('button',{name:/进入工作台|登录/,exact:false}).click();await page.locator('.sidenav').waitFor();
  const headers={'X-SubHub-Request':'1'};
  const put=async(kind,id,data)=>{const r=await ctx.request.put(base+'/api/admin/'+kind+'/'+id,{headers,data:{id,...data}});assert.equal(r.status(),200,'fixture save '+kind+' '+await r.text())};
  const overview=async()=>await(await ctx.request.get(base+'/api/admin/overview')).json();
  await put('server','srv-family',{name:'家庭示例服务器',address:'node.example.test',region:'Singapore'});
  await put('node','node-family',{name:'家庭示例节点',serverId:'srv-family',protocol:'VLESS',host:'node.example.test',port:443,transport:'tcp',security:'tls',enabled:true,tags:[],sni:'node.example.test',credential:crypto.randomUUID()});
  await put('subscription','sub-family',{name:'家庭订阅',note:'共享给家人，使用统一默认上限',nodeIds:['node-family'],connectionLimit:240});
  await page.goto(base+'/admin/subscriptions');await page.locator('.subscription-card').filter({hasText:'家庭订阅'}).waitFor();
  const card=page.locator('.subscription-card').filter({hasText:'家庭订阅'});assert.ok((await card.innerText()).includes('240'));assert.ok((await card.innerText()).includes('并发上限'));phase='subscription-default';
  await card.getByRole('button',{name:'编辑 家庭订阅'}).click();let dialog=page.locator('.modal');const subLimit=dialog.getByLabel('新分配用户的默认并发连接上限');assert.equal(await subLimit.inputValue(),'240');await subLimit.fill('260');await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
  phase='member-create';await page.goto(base+'/admin/members');await page.getByRole('button',{name:'新建用户',exact:true}).first().click();dialog=page.locator('.modal');await dialog.getByLabel('姓名').fill('家庭成员');
  const subChoice=dialog.locator('.mb-check-item').filter({hasText:'家庭订阅'}).locator('input[type=checkbox]');await subChoice.check();await dialog.getByText('跟随订阅默认，当前 260 条',{exact:true}).waitFor();
  const override=dialog.getByRole('checkbox',{name:/为此用户单独覆盖/});await override.check();await dialog.getByLabel('用户并发连接上限').fill('180');await dialog.getByRole('button',{name:'创建用户',exact:true}).click();await dialog.waitFor({state:'hidden'});
  let data=await overview();let member=data.members.find(m=>m.name==='家庭成员');assert.equal(member.connectionLimitOverride,180);assert.equal(member.connectionLimit,180);assert.equal(member.connectionLimitSource,'override');
  const memberCard=page.locator('.mb-card').filter({hasText:'家庭成员'});await memberCard.getByText('并发 ≤ 180',{exact:true}).waitFor();assert.ok((await memberCard.innerText()).includes('180 条 · 用户覆盖'));
  phase='override-remove';await memberCard.click();await page.getByRole('button',{name:'编辑用户',exact:true}).click();dialog=page.locator('.modal');assert.ok(await dialog.getByRole('checkbox',{name:/为此用户单独覆盖/}).isChecked());await dialog.getByRole('checkbox',{name:/为此用户单独覆盖/}).uncheck();await dialog.getByText('跟随订阅默认，当前 260 条',{exact:true}).waitFor();await dialog.getByRole('button',{name:'保存修改',exact:true}).click();await dialog.waitFor({state:'hidden'});
  data=await overview();member=data.members.find(m=>m.name==='家庭成员');assert.equal(member.connectionLimitOverride,null);assert.equal(member.connectionLimit,260);assert.equal(member.connectionLimitSource,'subscription');await page.locator('.mb-card').filter({hasText:'家庭成员'}).getByText('260 条 · 订阅默认',{exact:true}).waitFor();
  assert.equal(await page.getByText('设备超限',{exact:true}).count(),0);assert.ok(await page.getByText('客户端估算',{exact:true}).count()>0);phase='layouts';
  for(const width of [390,768,1440]){await page.setViewportSize({width,height:1000});await page.waitForTimeout(300);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'member page overflow at '+width);assert.ok(await page.locator('.mb-card').first().evaluate(e=>e.scrollWidth<=e.clientWidth+1),'member card overflow at '+width);if(width===390)await page.screenshot({path:'docs/assets/subhub/connection-policy-mobile.png',fullPage:true})}
  await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:'docs/assets/subhub/connection-policy-desktop.png',fullPage:true});
  assert.equal(errors.length,0,errors.join('\n'));
  const result={subscriptionDefault:260,subscriptionCardShowsLimit:true,memberInheritsDefault:true,memberOverride:180,overrideRemovalRestoresDefault:true,clientEstimateIsAdvisory:true,mobileFits:true,pageErrors:0};
  fs.writeFileSync('docs/SUBHUB-CONNECTION-POLICY-20261027.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }catch(e){console.error('Connection policy UI check failed at '+phase+': '+e.name+' '+String(e.message).split('\n')[0].replace(/https?:\/\/[^ ]+/g,'[URL omitted]'));process.exitCode=1}
 finally{if(browser)await browser.close();if(app&&app.exitCode===null){app.kill();await new Promise(r=>app.once('exit',r))}const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('subhub-connection-policy-'));fs.rmSync(resolved,{recursive:true,force:true})}
})();
