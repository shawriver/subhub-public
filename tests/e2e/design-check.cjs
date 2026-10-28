const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{
  const base=process.env.SUBHUB_BASE_URL||'http://127.0.0.1:18441';
  const browser=await chromium.launch({headless:true,executablePath:'C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
  const errors=[],results={layouts:[],checks:[]};
  try {
    const page=await browser.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
    async function navigate(label){
      const toggle=page.getByRole('button',{name:'打开菜单',exact:true});
      if(await toggle.isVisible())await toggle.click();
      await page.locator('.sidebar nav button').filter({hasText:label}).click();
    }
    async function fits(label,width){
      const size=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));
      assert.ok(size.scroll<=size.width,label+' overflows at '+width);
      results.layouts.push(label+':'+width);
    }
    await page.goto(base,{waitUntil:'networkidle'});
    for(const width of [320,390,768,1024,1440]){
      await page.setViewportSize({width,height:900});
      for(const label of ['总览','服务器','节点','用户','订阅','任务','设置']){
        await navigate(label);await fits(label,width);
      }
      await navigate('服务器');
      await page.getByRole('button',{name:'添加服务器',exact:true}).first().click();
      const dialog=page.getByRole('dialog');
      await fits('server-modal',width);
      assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),'dialog overflow at '+width);
      await dialog.locator('button').last().focus();
      await page.keyboard.press('Tab');
      assert.ok(await dialog.evaluate(el=>el.contains(document.activeElement)),'focus escaped modal');
      await page.keyboard.press('Escape');
      assert.equal(await dialog.count(),0);
      if(width===390){
        await navigate('用户');
        await page.screenshot({path:'docs/assets/subhub/mobile-members.png',fullPage:true});
        await navigate('节点');
        await page.screenshot({path:'docs/assets/subhub/mobile-nodes.png',fullPage:true});
      }
    }
    await navigate('节点');
    await page.getByRole('textbox',{name:'搜索',exact:true}).fill('no-match-fixture');
    await page.getByText('没有匹配的记录',{exact:true}).waitFor();
    await page.getByRole('button',{name:'清除搜索'}).click();
    assert.ok(await page.locator('tbody tr').count()>0);
    results.checks.push('search empty state and clear');
    await page.getByRole('button',{name:'添加节点',exact:true}).first().click();
    await page.locator('select[name=protocol]').selectOption('Trojan');
    assert.equal(await page.locator('select[name=security]').inputValue(),'tls');
    await page.locator('select[name=transport]').selectOption('ws');
    await page.locator('input[name=wsHost]').waitFor();
    await page.setViewportSize({width:390,height:900});
    await fits('node-modal',390);
    await page.screenshot({path:'docs/assets/subhub/mobile-node-form.png'});
    await page.keyboard.press('Escape');
    results.checks.push('protocol form and focus trap');

    // Deliberately mocked, non-sensitive records test reminder boundaries and empty states.
    const timezone='Asia/Shanghai';
    const today=new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const dateAt=days=>new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.parse(today+'T00:00:00+08:00')+days*86400000));
    const mock={servers:[{id:'past',name:'已到期样例',expires:dateAt(-1),region:'示例',status:'pending'},{id:'today',name:'今天到期样例',expires:dateAt(0),region:'示例',status:'pending'},{id:'thirty',name:'三十天样例',expires:dateAt(30),region:'示例',status:'pending'},{id:'future',name:'三十一天样例',expires:dateAt(31),region:'示例',status:'pending'}],members:[{id:'disabled',name:'停用样例',enabled:false,expires:dateAt(0),nodeIds:[]}],nodes:[],profiles:[],tasks:[]};
    const mockContext=await browser.newContext({viewport:{width:1440,height:1000}});
    mock.servers.push({id:'next',name:'明天到期样例',expires:dateAt(1),region:'示例',status:'pending'},{id:'nextweek',name:'七天到期样例',expires:dateAt(7),region:'示例',status:'pending'});
    const mockPage=await mockContext.newPage();
    mockPage.on('pageerror',e=>errors.push(e.message));
    await mockPage.route('**/api/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      const body=path==='/api/status'?{setupRequired:false}:path==='/api/session'?{authenticated:true}:path==='/api/admin/audit'?[]:mock;
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await mockPage.goto(base,{waitUntil:'networkidle'});
    const reminder=mockPage.locator('.renewal-panel');
    assert.equal(await reminder.getByText('今天到期',{exact:true}).count(),1);
    assert.equal(await reminder.getByText('30 天后',{exact:true}).count(),1);
    assert.equal(await reminder.getByText('已到期',{exact:true}).count(),1);
    assert.equal(await reminder.getByText('三十一天样例',{exact:true}).count(),0);
    assert.equal(await reminder.getByText('停用样例',{exact:true}).count(),0);
    assert.equal(await reminder.locator('.renewal-list button').count(),5);
    assert.equal(await mockPage.locator('.traffic-graph').count(),0);
    await mockPage.screenshot({path:'docs/assets/subhub/admin-reminders-fixture.png',fullPage:true});
    results.checks.push('Beijing date boundaries, disabled members and honest admin metrics');
    mock.servers=[];mock.members=[];
    await mockPage.reload({waitUntil:'networkidle'});
    await mockPage.getByText('近期没有到期事项',{exact:true}).waitFor();
    await mockPage.setViewportSize({width:390,height:844});
    await mockPage.screenshot({path:'docs/assets/subhub/mobile-admin-empty.png',fullPage:true});
    assert.ok(await mockPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await mockPage.getByRole('button',{name:'打开菜单',exact:true}).click();
    await mockPage.locator('.sidebar nav button').filter({hasText:'设置'}).click();
    await mockPage.getByRole('button',{name:'查看操作记录'}).click();
    await mockPage.getByText('还没有操作记录',{exact:true}).waitFor();
    await mockPage.keyboard.press('Escape');
    await mockPage.route('**/api/admin/audit',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'服务暂时不可用'})}));
    await mockPage.getByRole('button',{name:'查看操作记录'}).click();
    await mockPage.getByRole('alert').filter({hasText:'服务暂时不可用'}).waitFor();
    results.checks.push('empty administrator workspace and audit loading/error states');
    assert.equal(errors.length,0,errors.join('\n'));
    console.log(JSON.stringify({...results,errors},null,2));
  } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
