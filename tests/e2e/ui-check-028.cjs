const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const screenshots=path.resolve(__dirname,'../../docs/assets/subhub');

(async()=>{
  const base='http://127.0.0.1:18441';
  const portalToken=process.env.SUBHUB_PORTAL_TOKEN;
  const adminPassword=process.env.SUBHUB_TEST_ADMIN_PASSWORD;
  if(!portalToken||!adminPassword)throw new Error('SUBHUB_PORTAL_TOKEN and SUBHUB_TEST_ADMIN_PASSWORD are required');
  const browser=await chromium.launch({headless:true,executablePath:'C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
  try{
    const ctx=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    const page=await ctx.newPage();
    const errors=[];
    page.on('pageerror',()=>errors.push('pageerror'));

    await page.goto(base+'/',{waitUntil:'networkidle'});
    await page.getByRole('heading',{name:'服务器状态',exact:true}).waitFor();
    assert.equal(await page.locator('.machine-traffic').count(),0);
    assert.equal(await page.getByText('整机流量',{exact:true}).count(),0);
    await page.screenshot({path:path.join(screenshots,'028-public-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(screenshots,'028-public-mobile.png'),fullPage:true});

    const portal=await ctx.newPage();
    await portal.goto(base+'/me/'+encodeURIComponent(portalToken),{waitUntil:'networkidle'});
    await portal.getByRole('heading',{name:'Family Member',exact:true}).waitFor();
    assert.ok(await portal.getByText('261.00 KB',{exact:true}).count()>0);
    assert.ok(await portal.getByText(/20\.00 GB/).count()>0);
    await portal.setViewportSize({width:390,height:900});
    assert.ok(await portal.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));

    await page.setViewportSize({width:1440,height:1000});
    await page.goto(base+'/login',{waitUntil:'networkidle'});
    await page.locator('input[name=username]').fill('admin');
    await page.locator('input[name=password]').fill(adminPassword);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.locator('.sidebar').waitFor();
    assert.ok(await page.getByText('SubHub 0.2.8',{exact:true}).count()>0);

    await page.locator('.sidebar nav button').filter({hasText:'节点'}).click();
    await page.locator('tbody tr').first().waitFor();
    assert.equal(await page.locator('th').filter({hasText:'连通性'}).count(),1);
    assert.equal(await page.locator('th').filter({hasText:'订阅流量'}).count(),1);
    const rows=page.locator('tbody tr');
    assert.equal(await rows.count(),2);
    await rows.filter({hasText:'Local TCP'}).getByText('端口可达',{exact:true}).waitFor();
    await rows.filter({hasText:'Local TCP'}).getByText('未统计',{exact:true}).waitFor();
    await rows.filter({hasText:'H2 Test'}).getByText('需客户端验证',{exact:true}).waitFor();
    await rows.filter({hasText:'H2 Test'}).getByText('未统计',{exact:true}).waitFor();
    await page.screenshot({path:path.join(screenshots,'028-nodes-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:900});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));

    await page.setViewportSize({width:1440,height:1000});
    await page.locator('.sidebar nav button').filter({hasText:'用户'}).click();
    const member=page.locator('.member-card').filter({hasText:'Family Member'});
    await member.getByText('261.00 KB',{exact:true}).first().waitFor();
    assert.equal(await member.getByText('0.0 GB',{exact:true}).count(),0);
    await member.getByRole('button',{name:'订阅',exact:true}).click();
    await page.getByRole('dialog').waitFor();
    await page.getByLabel('我已了解旧订阅链接会失效').check();
    await page.getByRole('button',{name:'生成新链接',exact:true}).click();
    await page.locator('.subscription-qr img').waitFor();
    assert.ok((await page.locator('.subscription-qr img').getAttribute('src')).startsWith('data:image/png'));
    const scheme=await page.getByRole('link',{name:'一键导入 Clash'}).getAttribute('href');
    assert.ok(scheme.startsWith('clash://install-config?url='));
    assert.equal(await page.getByRole('link',{name:'打开我的用量'}).count(),1);
    assert.equal(errors.length,0);
    console.log(JSON.stringify({publicTrafficHidden:true,portalUsage:true,versionFromApi:true,nodeHealth:true,nodeUsage:true,unifiedUnits:true,qr:true,oneClickImport:true,portalLink:true,pageErrors:errors.length}));
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
