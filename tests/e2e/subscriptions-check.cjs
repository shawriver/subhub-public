// Synthetic, isolated acceptance of subscription-first setup and expiry controls.
const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const {spawn,execFileSync}=require('node:child_process');
const executable='C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})});
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'subhub-subscriptions-027-'));let app,browser,phase='setup';
 try{
  const port=await freePort(),base='http://127.0.0.1:'+port,binary=path.resolve('subhub.exe');
  const args=['-data',dir,'-listen','127.0.0.1:'+port,'-origin',base];
  const setup=execFileSync(binary,[...args,'-issue-setup'],{encoding:'utf8',windowsHide:true}).trim(),password=crypto.randomBytes(24).toString('base64url');
  app=spawn(binary,args,{stdio:'ignore',windowsHide:true});
  for(let i=0;i<60;i++){try{if((await fetch(base+'/api/status')).ok)break}catch{}await sleep(100)}
  assert.equal((await fetch(base+'/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:setup,username:'admin',password})})).status,200);
  browser=await chromium.launch({headless:true,executablePath:executable});
  const ctx=await browser.newContext({viewport:{width:1440,height:1000}}),page=await ctx.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.name));page.setDefaultTimeout(12000);
  await page.goto(base+'/admin/subscriptions');await page.locator('input[name=password]').fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.sidebar').waitFor();
  const put=async(kind,id,data)=>{const r=await ctx.request.put(base+'/api/admin/'+kind+'/'+id,{headers:{'X-SubHub-Request':'1'},data:{id,...data}});assert.equal(r.status(),200,'fixture save '+kind)};
  const overview=async()=>await(await ctx.request.get(base+'/api/admin/overview')).json();
  for(let i=0;i<5;i++){
   await put('server','s'+i,{name:['日本示例','新加坡示例','台湾示例','香港示例','美西示例'][i],address:'node'+i+'.example.test'});
   for(const [j,protocol] of ['VLESS','AnyTLS','Hysteria2'].entries())await put('node','n'+i+'-'+j,{name:'示例 '+i+' '+protocol,serverId:'s'+i,protocol,host:'node'+i+'.example.test',port:18440+j,transport:protocol==='Hysteria2'?'udp':'tcp',security:'tls',enabled:!(i===4&&j===2),tags:[],sni:'example.test',credential:crypto.randomUUID()});
  }
  await page.reload();await page.locator('.sidebar').waitFor();
  phase='subscription-first';await page.getByRole('button',{name:'新建订阅',exact:true}).first().click();let dialog=page.getByRole('dialog',{name:'新建订阅'});
  assert.equal(await dialog.locator('select').count(),1); // Only node protocol filter, no owner prerequisite.
  await dialog.locator('input[name=name]').fill('亚洲与备用');await dialog.getByRole('checkbox',{name:'全选',exact:true}).check();
  assert.equal(await dialog.locator('input[type=hidden][name=node]').count(),14);
  await dialog.getByRole('button',{name:'反选',exact:true}).click();assert.equal(await dialog.locator('input[type=hidden][name=node]').count(),0);
  await dialog.getByRole('checkbox',{name:'全选 日本示例',exact:true}).check();
  await dialog.getByRole('searchbox',{name:'搜索节点'}).fill('no results');assert.equal(await dialog.locator('input[type=hidden][name=node]').count(),3);
  await dialog.getByRole('button',{name:'重置筛选',exact:true}).click();await dialog.getByRole('checkbox',{name:'全选',exact:true}).check();
  await dialog.getByRole('button',{name:'创建订阅',exact:true}).click();await dialog.waitFor({state:'hidden'});
  let data=await overview();assert.equal(data.members.length,0);assert.equal(data.subscriptions.length,1);const subscription=data.subscriptions[0];assert.equal(subscription.nodeIds.length,14);
  for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'subscription page overflow')}
  await page.screenshot({path:'docs/assets/subhub/027-subscriptions-desktop.png',fullPage:true});
  await put('subscription','sg-only',{name:'新加坡专用',nodeIds:['n1-0','n1-1','n1-2']});
  phase='member-assignment';await page.goto(base+'/admin/members');await page.getByRole('button',{name:'添加用户',exact:true}).first().click();dialog=page.getByRole('dialog',{name:'添加用户'});
  await dialog.locator('input[name=name]').fill('测试用户甲');assert.equal(await dialog.locator('.node-picker').count(),0);
  await dialog.getByRole('radio',{name:'无期限',exact:true}).check();assert.equal(await dialog.locator('input[name=expires][type=hidden]').inputValue(),process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440');
  await dialog.getByRole('checkbox',{name:/亚洲与备用/}).check();await dialog.getByRole('checkbox',{name:/新加坡专用/}).check();
  await dialog.getByRole('searchbox',{name:'搜索订阅'}).fill('新加坡');assert.equal(await dialog.locator('input[type=hidden][name=subscription]').count(),2);
  await dialog.getByRole('searchbox',{name:'搜索订阅'}).fill(process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440');await page.waitForTimeout(5500);assert.equal(await dialog.locator('input[type=hidden][name=subscription]').count(),2);
  phase='expiry';await dialog.getByRole('radio',{name:'指定到期日期'}).check();await dialog.getByRole('button',{name:'+30 天',exact:true}).click();const first=await dialog.locator('input[name=expires]').inputValue();assert.match(first,/^\d{4}-\d{2}-\d{2}$/);
  await dialog.getByRole('button',{name:'+7 天',exact:true}).click();const extended=await dialog.locator('input[name=expires]').inputValue();assert.equal((new Date(extended)-new Date(first))/86400000,7);
  await dialog.getByRole('radio',{name:'无期限',exact:true}).check();assert.equal(await dialog.locator('input[name=expires]').inputValue(),process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440');
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:1000});await dialog.locator('.expiry-field').scrollIntoViewIfNeeded();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'member page overflow');assert.ok(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'member dialog overflow');
   const footer=await dialog.locator('.record-footer').boundingBox();assert.ok(footer.y>=0&&footer.y+footer.height<=1000);
   if(width===390||width===1440)await dialog.screenshot({path:'docs/assets/subhub/027-member-'+(width===390?'mobile':'desktop')+'.png'});
  }
  phase='save-error';await page.route('**/api/admin/member/*',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"模拟保存失败"}'}));
  await dialog.getByRole('button',{name:'添加用户',exact:true}).click();await dialog.getByRole('alert').waitFor();assert.equal(await dialog.locator('input[name=name]').inputValue(),'测试用户甲');assert.equal(await dialog.locator('input[type=hidden][name=subscription]').count(),2);await page.unroute('**/api/admin/member/*');
  await dialog.getByRole('button',{name:'添加用户',exact:true}).click();await dialog.waitFor({state:'hidden'});data=await overview();let member=data.members[0];assert.equal(member.expires,process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440');assert.equal(member.nodeIds.length,14);assert.equal(member.subscriptionIds.length,2);
  const editMember=async()=>{await page.locator('.member-card').filter({hasText:'测试用户甲'}).getByRole('button',{name:'用户详情'}).click();await page.getByRole('button',{name:'编辑用户',exact:true}).click();return page.getByRole('dialog',{name:'编辑用户'})};
  phase='expiry-roundtrip';dialog=await editMember();assert.ok(await dialog.getByRole('radio',{name:'无期限',exact:true}).isChecked());await dialog.getByRole('radio',{name:'指定到期日期'}).check();await dialog.locator('input[name=expires]').fill('2030-02-28');await dialog.getByRole('button',{name:'保存用户'}).click();await dialog.waitFor({state:'hidden'});
  dialog=await editMember();assert.equal(await dialog.locator('input[name=expires]').inputValue(),'2030-02-28');await dialog.getByRole('radio',{name:'无期限',exact:true}).check();await dialog.getByRole('button',{name:'保存用户'}).click();await dialog.waitFor({state:'hidden'});assert.equal((await overview()).members[0].expires,process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440');
  phase='personal-link';await page.locator('.member-card').first().getByRole('button',{name:'订阅',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'生成新链接',exact:true}).click();const link=await dialog.locator('input[readonly]').inputValue();assert.equal((await ctx.request.get(link)).status(),200);await page.keyboard.press('Escape');
  phase='update-subscription';await page.goto(base+'/admin/subscriptions');await page.locator('.subscription-card').filter({hasText:'亚洲与备用'}).getByRole('button',{name:'编辑订阅'}).click();dialog=page.getByRole('dialog',{name:'编辑订阅'});await dialog.getByRole('button',{name:'清空已选',exact:true}).click();await dialog.getByRole('checkbox',{name:'全选 日本示例',exact:true}).check();await dialog.getByRole('button',{name:'保存订阅'}).click();await dialog.waitFor({state:'hidden'});
  data=await overview();member=data.members[0];assert.equal(member.nodeIds.length,6);const download=await ctx.request.get(link);assert.equal(download.status(),200);assert.ok(!(await download.text()).includes('示例 2'));
  phase='delete-reference';const deletion=await ctx.request.delete(base+'/api/admin/subscription/'+subscription.id,{headers:{'X-SubHub-Request':'1'}});assert.equal(deletion.status(),409);
  phase='view-assignees';await page.locator('.subscription-card').filter({hasText:'亚洲与备用'}).getByRole('button',{name:'查看用户'}).click();await page.waitForURL('**/admin/members');assert.equal(await page.locator('.member-card').count(),1);await page.getByRole('searchbox').count();
  assert.equal(errors.length,0);
  const result={subscriptionBeforeUsers:true,nodeBulkSelection:true,multipleSubscriptions:true,overlapDeduplicated:true,pollingPreservesDraft:true,explicitUnlimited:true,dateExtension:true,expiryRoundTrip:true,saveFailurePreservesDraft:true,originalLinkSurvivesEdits:true,referenceDeletionGuard:true,assignedUserNavigation:true,mobileFits:true,pageErrors:0};
  fs.writeFileSync('docs/SUBHUB-027-UI-CHECK-20261019.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }catch(e){console.error('Subscription UI check failed at '+phase+': '+e.name+' '+String(e.message).split('\n')[0].replace(/https?:\/\/[^ ]+/g,'[URL omitted]'));process.exitCode=1}
 finally{if(browser)await browser.close();if(app&&app.exitCode===null){app.kill();await new Promise(r=>app.once('exit',r))}const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('subhub-subscriptions-027-'));fs.rmSync(resolved,{recursive:true,force:true})}
})();
