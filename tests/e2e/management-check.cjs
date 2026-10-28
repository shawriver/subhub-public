const {chromium}=require(process.env.SUBHUB_PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
(async()=>{
  const base=process.env.SUBHUB_BASE_URL||'http://127.0.0.1:18441';
  assert.ok(process.env.SUBHUB_TEST_PASSWORD,'test password required');
  const browser=await chromium.launch({headless:true,...(process.env.SUBHUB_CHROMIUM ? {executablePath:process.env.SUBHUB_CHROMIUM} : {})});
  const results=[],errors=[];
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',e=>errors.push(e.message));
    async function nav(label){await page.locator('.sidebar nav button').filter({hasText:label}).click()}
    async function close(){await page.locator('.modal header').getByRole('button',{name:'关闭',exact:true}).click()}
    async function saved(label){await page.locator('.modal').getByRole('button',{name:label,exact:true}).click();await page.locator('.modal').waitFor({state:'hidden'})}
    async function api(path,method='GET',body){
      return page.evaluate(async ({path,method,body})=>{
        const r=await fetch(path,{method,headers:{'X-SubHub-Request':'1','Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
        const text=await r.text();let data;try{data=JSON.parse(text)}catch{}
        return {status:r.status,data};
      },{path,method,body});
    }
    const overview=async()=>(await api('/api/admin/overview')).data;
    const row=name=>page.locator('.profile-row').filter({has:page.getByText(name,{exact:true})});
    async function memberEdit(){
      await nav('用户');await page.locator('.member-card').filter({hasText:'验收用户'}).getByRole('button',{name:'用户详情',exact:true}).click();
      await page.getByRole('button',{name:'编辑用户',exact:true}).click();
    }
    async function issue(name){
      await row(name).getByRole('button',{name:'生成订阅链接',exact:true}).click();
      await page.getByRole('checkbox',{name:'我已了解旧订阅链接会失效'}).check();
      await page.getByRole('button',{name:'生成新链接',exact:true}).click();
      await page.locator('.modal input[readonly]').waitFor();
      const link=await page.locator('.modal input[readonly]').inputValue();await close();return link;
    }
    const status=link=>page.evaluate(async link=>(await fetch(link)).status,link);
    const initial=await (await page.request.get(base+'/api/status')).json();
    if(initial.setupRequired){
      assert.ok(process.env.SUBHUB_SETUP_TOKEN);
      const setup=await page.request.post(base+'/api/setup',{data:{token:process.env.SUBHUB_SETUP_TOKEN,username:'admin',password:process.env.SUBHUB_TEST_PASSWORD}});
      assert.equal(setup.status(),200);
    }
    await page.goto(base,{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'进入管理',exact:true}).click();
    await page.locator('.modal input[name=password]').fill(process.env.SUBHUB_TEST_PASSWORD);
    await page.locator('.modal').getByRole('button',{name:'登录',exact:true}).click();
    await page.getByText('节点控制待接入').waitFor();
    let d=await overview();
    if(d.servers.length===0){
      for(const [kind,record] of [
        ['server',{id:'acceptance-server',name:'验收服务器',address:'192.0.2.44',status:'pending'}],
        ['node',{id:'acceptance-node',name:'验收 VLESS',serverId:'acceptance-server',protocol:'VLESS',host:'node.example.test',port:443,transport:'tcp',security:'tls',credential:randomUUID(),enabled:true}],
        ['member',{id:'acceptance-member',name:'验收用户',enabled:true,nodeIds:['acceptance-node'],limit:20}],
        ['profile',{id:'acceptance-profile',name:'验收用户 的订阅',memberId:'acceptance-member',nodeIds:['acceptance-node'],followMemberNodes:true,format:'clash',rules:['MATCH,节点选择']}]
      ])assert.equal((await api('/api/admin/'+kind+'/'+record.id,'PUT',record)).status,200);
      d=await overview();await page.reload({waitUntil:'networkidle'});
    }
    const server=d.servers[0];
    assert.equal((await api('/api/admin/server/'+server.id,'PUT',{...server,status:'warning',cpu:37,connectAllowed:false,agent:true})).status,200);
    await page.reload({waitUntil:'networkidle'});await nav('服务器');
    await page.getByText('验收服务器',{exact:true}).first().click();
    await page.getByRole('button',{name:'编辑服务器',exact:true}).click();
    await page.locator('input[name=provider]').fill('功能验收');
    await page.locator('textarea[name=note]').fill('编辑保留运行字段');
    await saved('保存服务器');
    const updated=(await overview()).servers[0];
    assert.ok(updated.cpu===37&&updated.status==='warning'&&updated.agent&&!updated.connectAllowed);
    results.push('server edit preserves runtime metadata');
    await nav('节点');await page.getByRole('button',{name:'批量导入',exact:true}).click();
    const uri='trojan://'+encodeURIComponent(randomUUID()+':@/?')+'@[2001:db8::6]:443?security=tls&type=ws&path=%2Ftest&host=ws.example.test&sni=example.test#'+encodeURIComponent('批量验收节点');
    await page.locator('textarea[name=importContent]').fill(Buffer.from(uri).toString('base64'));
    await page.getByRole('button',{name:'检查并预览',exact:true}).click();
    await page.locator('.import-results').getByText('批量验收节点',{exact:true}).waitFor();
    assert.ok(!(await page.locator('.import-results').innerText()).includes(uri));
    await saved('确认导入');
    let imported=(await overview()).nodes.find(n=>n.name==='批量验收节点');assert.ok(imported);
    await page.getByRole('button',{name:'批量导入',exact:true}).click();
    await page.locator('textarea[name=importContent]').fill(uri+'\n'+uri);
    await page.getByRole('button',{name:'检查并预览',exact:true}).click();
    await page.getByText('0 个可导入 · 2 个重复已跳过 · 0 个问题',{exact:true}).waitFor();
    assert.ok(await page.getByRole('button',{name:'确认导入',exact:true}).isDisabled());await close();
    results.push('base64 preview, atomic import, repeat deduplication');
    await memberEdit();
    await page.locator('input[name=node][value="'+imported.id+'"]').check();
    await page.locator('input[name=limit]').fill('42.5');
    await page.locator('input[name=expires]').fill('2099-12-31');
    await page.setViewportSize({width:390,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.ok(await page.locator('.modal').evaluate(el=>el.scrollWidth<=el.clientWidth));
    await page.screenshot({path:'docs/assets/subhub/mobile-member-edit.png'});
    await page.setViewportSize({width:1440,height:1000});
    await saved('保存用户');
    d=await overview();assert.equal(d.members[0].limit,42.5);assert.equal(d.profiles[0].nodeIds.length,2);
    await nav('订阅');await page.getByRole('button',{name:'新建订阅',exact:true}).click();
    await page.locator('input[name=name]').fill('手选验收订阅');
    await page.getByRole('checkbox',{name:'跟随用户节点分配，自动同步新增和移除'}).uncheck();
    await page.locator('input[name=node][value="'+imported.id+'"]').check();
    await saved('创建订阅');
    const link=await issue('手选验收订阅');assert.equal(await status(link),200);
    await row('手选验收订阅').getByRole('button',{name:'编辑订阅',exact:true}).click();
    await page.locator('input[name=name]').fill('改名验收订阅');
    await page.locator('textarea[name=rules]').fill('DOMAIN-SUFFIX,example.test,DIRECT\nMATCH,节点选择');
    await page.screenshot({path:'docs/assets/subhub/desktop-profile-edit.png'});
    await saved('保存订阅');assert.equal(await status(link),200);
    await memberEdit();await page.locator('input[name=node][value="'+imported.id+'"]').uncheck();await saved('保存用户');
    d=await overview();assert.equal(d.profiles.find(p=>p.name==='改名验收订阅').nodeIds.length,0);
    await memberEdit();await page.locator('input[name=node][value="'+imported.id+'"]').check();await saved('保存用户');
    d=await overview();assert.equal(d.profiles.find(p=>p.name==='改名验收订阅').nodeIds.length,0);assert.equal(d.profiles.find(p=>p.followMemberNodes).nodeIds.length,2);
    results.push('member expiry/quota, follow vs manual reconciliation, stable URL after edits');
    await nav('订阅');await row('改名验收订阅').getByRole('button',{name:'编辑订阅',exact:true}).click();
    await page.getByRole('checkbox',{name:'跟随用户节点分配，自动同步新增和移除'}).check();await saved('保存订阅');
    assert.equal(await status(link),200);
    await memberEdit();await page.locator('input[name=enabled]').uncheck();await saved('保存用户');assert.equal(await status(link),404);
    await memberEdit();await page.locator('input[name=enabled]').check();await saved('保存用户');assert.equal(await status(link),200);
    await nav('订阅');await row('改名验收订阅').getByRole('button',{name:'撤销订阅链接',exact:true}).click();
    await saved('确认撤销');assert.equal(await status(link),404);
    assert.ok((await overview()).profiles.some(p=>p.name==='改名验收订阅'));
    const newLink=await issue('改名验收订阅');assert.equal(await status(newLink),200);
    await page.reload({waitUntil:'networkidle'});d=await overview();assert.equal(d.profiles.find(p=>p.name==='改名验收订阅').nodeIds.length,2);
    results.push('disable/re-enable, revoke/reissue and reload persistence');
    await nav('服务器');await page.getByText('验收服务器',{exact:true}).first().click();
    await page.getByRole('button',{name:'删除服务器',exact:true}).click();await page.getByRole('button',{name:'确认删除',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'服务器仍有关联节点'}).waitFor();await close();
    await nav('订阅');
    for(const p of d.profiles){await row(p.name).getByRole('button',{name:'删除订阅',exact:true}).click();await saved('确认删除')}
    assert.equal(await status(newLink),404);
    await nav('用户');await page.locator('.member-card').filter({hasText:'验收用户'}).getByRole('button',{name:'用户详情',exact:true}).click();await page.getByRole('button',{name:'删除用户',exact:true}).click();await saved('确认删除');
    await nav('节点');
    for(const n of d.nodes){await page.getByText(n.name,{exact:true}).first().click();await page.getByRole('button',{name:'删除节点',exact:true}).click();await saved('确认删除')}
    await nav('服务器');await page.getByText('验收服务器',{exact:true}).first().click();await page.getByRole('button',{name:'删除服务器',exact:true}).click();await saved('确认删除');
    d=await overview();for(const key of ['servers','nodes','members','profiles'])assert.equal(d[key].length,0);
    results.push('referential deletion protection and full cleanup through UI');
    assert.equal(errors.length,0);console.log(JSON.stringify({checks:results,errors},null,2));
  } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
