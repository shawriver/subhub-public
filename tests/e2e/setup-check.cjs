const {chromium}=require(process.env.SUBHUB_PLAYWRIGHT_MODULE || 'playwright');
(async()=>{
  const token=process.env.SUBHUB_SETUP_TOKEN;
  const baseURL=process.env.SUBHUB_BASE_URL||'http://127.0.0.1:18440';
  if(!token)throw new Error('SUBHUB_SETUP_TOKEN is required');
  const browser=await chromium.launch({headless:true,...(process.env.SUBHUB_CHROMIUM ? {executablePath:process.env.SUBHUB_CHROMIUM} : {})});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(`${baseURL}/setup?setup=${encodeURIComponent(token)}`,{waitUntil:'networkidle'});
  const heading=await page.getByRole('heading',{name:'创建管理员'}).isVisible();
  const password=await page.locator('input[name=password]').isVisible();
  const status=await page.evaluate(async()=>await (await fetch('/api/status')).json());
  console.log(JSON.stringify({heading,password,setupRequired:status.setupRequired,errors},null,2));
  await browser.close();
})();
