// Read-only production acceptance. The session arrives on stdin and is revoked
// by scripts/lib/subhub-device-estimate-production.py after this script exits.
const {chromium}=require(process.env.SUBHUB_PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');

(async()=>{
  const {session}=JSON.parse(fs.readFileSync(0,'utf8'));
  const base=process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440';
  const browser=await chromium.launch({headless:true,...(process.env.SUBHUB_CHROMIUM ? {executablePath:process.env.SUBHUB_CHROMIUM} : {})});
  try{
    const ctx=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce'});
    await ctx.addCookies([{name:'subhub_session',value:session,url:base,httpOnly:true,secure:true,sameSite:'Strict'}]);
    const page=await ctx.newPage();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+'/admin/members',{waitUntil:'networkidle'});
    await page.locator('.members-page').waitFor();

    const status=await(await ctx.request.get(base+'/api/status')).json();
    const overview=await(await ctx.request.get(base+'/api/admin/overview')).json();
    const owner=overview.members.find(member=>member.id==='fixture-owner');
    assert.ok(owner,'owner member missing');
    const other=overview.members.find(member=>member.id!=='fixture-owner');
    assert.ok(other,'second member missing');
    assert.equal(owner.devicesUsed,2);
    assert.equal(owner.deviceOverLimit,false);
    assert.equal(owner.hasAnomaly,false);
    assert.equal(other.devicesUsed,1);
    assert.equal(other.deviceOverLimit,false);
    assert.equal(other.hasAnomaly,false);

    const ownerDevices=await(await ctx.request.get(base+'/api/admin/subscription-fetches?view=devices&member=fixture-owner')).json();
    const otherDevices=await(await ctx.request.get(base+'/api/admin/subscription-fetches?view=devices&member='+encodeURIComponent(other.id))).json();
    assert.deepEqual(ownerDevices.groups.map(group=>group.client).sort(),['Clash Meta for Android','Clash Verge']);
    assert.equal(otherDevices.groups.length,1);
    assert.equal(otherDevices.groups[0].client,'Clash Verge');

    const ownerCard=page.getByRole('button',{name:`用户 ${owner.name}`});
    await ownerCard.waitFor();
    await ownerCard.click();
    await page.locator('.mb-gauge').waitFor();
    assert.equal((await page.locator('.mb-gauge').innerText()).trim(),'2');
    const section=page.locator('.mb-section').filter({has:page.locator('.mb-section-title').filter({hasText:'设备'})});
    await section.locator('tbody tr').first().waitFor();
    assert.equal(await section.locator('tbody tr').count(),2);
    const text=await section.innerText();
    assert.match(text,/订阅客户端/);
    assert.match(text,/来源 IP 数/);
    assert.match(text,/Clash Meta for Android/);
    assert.match(text,/Clash Verge/);
    assert.doesNotMatch(text,/多 IP/);
    assert.equal(errors.length,0,errors.join('\n'));

    console.log(JSON.stringify({version:status.version,ownerDevices:owner.devicesUsed,ownerClients:ownerDevices.groups.map(group=>group.client).sort(),secondMemberDevices:other.devicesUsed,secondMemberClient:otherDevices.groups[0].client,ownerAnomaly:owner.hasAnomaly,secondMemberAnomaly:other.hasAnomaly,pageErrors:errors.length}));
  }finally{await browser.close()}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1});
