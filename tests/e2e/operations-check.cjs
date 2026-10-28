const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const assert=require('node:assert/strict');
const {createHmac,randomUUID}=require('node:crypto');
function otp(secret){
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits=process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440';for(const c of secret)bits+=alphabet.indexOf(c).toString(2).padStart(5,'0');
 const key=Buffer.from((bits.match(/.{8}/g)||[]).map(s=>parseInt(s,2)));
 const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const h=createHmac('sha1',key).update(b).digest(),o=h[19]&15;return ((h.readUInt32BE(o)&0x7fffffff)%1000000).toString().padStart(6,'0');
}
(async()=>{
 const base=process.env.SUBHUB_BASE_URL||'http://127.0.0.1:18441',password=process.env.SUBHUB_TEST_PASSWORD,setup=process.env.SUBHUB_SETUP_TOKEN;
 assert.ok(password&&setup);
 const browser=await chromium.launch({headless:true,executablePath:'C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
 const checks=[],errors=[];let page;
 try{
  page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>errors.push(e.message));
  async function api(path,body){
   return page.evaluate(async({path,body})=>{const r=await fetch('/api/admin/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-SubHub-Request':'1'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()}},{path,body});
  }
  const overview=async()=>(await api('overview')).data;
  const nav=async label=>{await page.locator('.sidebar nav button').filter({hasText:label}).click()};
  const close=async()=>{await page.locator('.modal header').getByRole('button',{name:'关闭',exact:true}).click()};
  async function login(code=process.env.SUBHUB_TEST_BASE||'http://127.0.0.1:18440'){
   await page.getByRole('button',{name:'进入管理',exact:true}).click();
   await page.locator('input[name=password]').fill(password);await page.locator('input[name=code]').fill(code);
   await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.modal').waitFor({state:'hidden'});
  }
  await page.goto(base+'/setup?setup='+encodeURIComponent(setup),{waitUntil:'networkidle'});
  await page.locator('input[name=password]').fill(password);await page.locator('input[name=confirm]').fill(password);await page.getByRole('button',{name:'完成设置',exact:true}).click();
  await page.locator('.modal input[name=password]').fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.modal').waitFor({state:'hidden'});
  let data=await overview();assert.ok(data.panels.length&&data.nodes.some(n=>n.panelId));
  const node=data.nodes.find(n=>n.panelId);checks.push('dedicated API connection and managed Reality discovery');
  await nav('设置');await page.getByRole('button',{name:'发现节点',exact:true}).click();await page.getByRole('button',{name:'已接入',exact:true}).waitFor();await close();
  await page.screenshot({path:'docs/assets/subhub/020-settings.png',fullPage:true});
  await page.setViewportSize({width:390,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:1440,height:1050});
  // Exercise the ordinary user creation UI against the live 3x-ui integration.
  await nav('用户');await page.getByRole('button',{name:'添加用户',exact:true}).first().click();
  await page.locator('input[name=name]').fill('SubHub 临时验收');await page.locator('input[name=node][value="'+node.id+'"]').check();
  await page.locator('.modal').getByRole('button',{name:'添加用户',exact:true}).click();await page.locator('.modal').waitFor({state:'hidden'});
  await page.waitForFunction(async()=>{const d=await(await fetch('/api/admin/overview')).json();return d.grants?.some(g=>g.state==='active')},{},{timeout:90000,polling:1500});
  data=await overview();const member=data.members.find(m=>m.name==='SubHub 临时验收');
  assert.equal(member.provision,'ready');assert.ok(data.servers.find(s=>s.id===node.serverId).agent);checks.push('live independent grant creation and host metrics');
  await nav('用户');await page.locator('.member-card').filter({hasText:member.name}).getByRole('button',{name:'订阅',exact:true}).click();
  await page.getByRole('checkbox',{name:'我已了解旧订阅链接会失效'}).check();await page.getByRole('button',{name:'生成新链接',exact:true}).click();await page.locator('.modal input[readonly]').waitFor();
  const subscription=await page.locator('.modal input[readonly]').inputValue();const substatus=await page.evaluate(async link=>(await fetch(link)).status,subscription);assert.equal(substatus,200);await close();
  // Export/decrypt/preview remains in browser/process memory, no credential files.
  await nav('设置');await page.getByRole('button',{name:'备份与恢复',exact:true}).click();
  await page.locator('.modal input[name=password]').fill(password);await page.locator('.modal input[type=password]').nth(1).fill(randomUUID()+randomUUID());
  const exportWait=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/backup/export');
  await page.getByRole('button',{name:'下载加密备份',exact:true}).click();
  const exportResponse=await exportWait;assert.equal(exportResponse.status(),200);const exported=await exportResponse.json();
  await page.locator('.modal input[type=file]').setInputFiles({name:'test.shb',mimeType:'application/octet-stream',buffer:Buffer.from(exported.content)});
  await page.getByRole('button',{name:'预览恢复内容',exact:true}).click();await page.getByText('输入“恢复”确认',{exact:true}).waitFor();
  assert.ok((await page.locator('.secret-box').innerText()).includes('授权 1'));await close();checks.push('encrypted export and restore preview UI');
  // Disable through UI and wait for actual remote deletion. The separate VPS
  // traffic probe is run while the acceptance user is re-enabled below.
  async function setEnabled(enabled){
   await nav('用户');await page.locator('.member-card').filter({hasText:member.name}).getByRole('button',{name:'用户详情',exact:true}).click();await page.getByRole('button',{name:'编辑用户',exact:true}).click();
   await page.locator('input[name=enabled]').setChecked(enabled);await page.getByRole('button',{name:'保存用户',exact:true}).click();await page.locator('.modal').waitFor({state:'hidden'});
   await page.waitForFunction(async({id,state})=>{const d=await(await fetch('/api/admin/overview')).json();return d.grants?.find(g=>g.memberId===id)?.state===state},{id:member.id,state:enabled?'active':'revoked'},{timeout:90000,polling:1500});
  }
  await setEnabled(false);assert.equal(await page.evaluate(async link=>(await fetch(link)).status,subscription),404);
  await setEnabled(true);checks.push('live disable/revoke and re-enable lifecycle');
  // Leave user active briefly for the separately run end-to-end traffic probe.
  console.log(JSON.stringify({checks,trafficProbeReady:true,errors}));
  await nav('设置');await page.getByRole('button',{name:'安全设置',exact:true}).click();
  await page.locator('.modal input[name=password]').fill(password);await page.getByRole('button',{name:'设置二步验证',exact:true}).click();await page.getByRole('textbox',{name:'验证器设置密钥',exact:true}).waitFor();
  const secret=await page.getByRole('textbox',{name:'验证器设置密钥',exact:true}).inputValue();
  await page.locator('.modal input[name=code]').fill(otp(secret));await page.getByRole('button',{name:'确认启用二步验证',exact:true}).click();await page.locator('.modal').waitFor({state:'hidden'});
  await login(otp(secret));checks.push('TOTP enrollment, logout and fresh login');
  // Do not persist this test secret. Disable/revoke the temporary user before
  // finishing; the traffic probe uses another dedicated disposable grant.
  await setEnabled(false);checks.push('final temporary user authorization revoked');
  assert.equal(errors.length,0);console.log(JSON.stringify({checks,errors},null,2));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
