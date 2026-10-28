const {chromium}=require('C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
(async()=>{
  const token=process.env.SUBHUB_SETUP_TOKEN;
  const baseURL=process.env.SUBHUB_BASE_URL||'http://127.0.0.1:18440';
  if(!token)throw new Error('SUBHUB_SETUP_TOKEN is required');
  const browser=await chromium.launch({headless:true,executablePath:'C:/Users/15241/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe'});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(`${baseURL}/setup?setup=${encodeURIComponent(token)}`,{waitUntil:'networkidle'});
  const heading=await page.getByRole('heading',{name:'创建管理员'}).isVisible();
  const password=await page.locator('input[name=password]').isVisible();
  const status=await page.evaluate(async()=>await (await fetch('/api/status')).json());
  console.log(JSON.stringify({heading,password,setupRequired:status.setupRequired,errors},null,2));
  await browser.close();
})();
