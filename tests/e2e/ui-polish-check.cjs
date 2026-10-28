// Run against disposable data only. Read {base,session,output} from stdin;
// the session stays in memory and screenshots never contain credentials.
const {chromium} = require(process.env.SUBHUB_PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input);
  assert.equal(config.disposable, true, "This check writes disposable records");
  fs.mkdirSync(config.output, {recursive: true});
  const browser = await chromium.launch({headless: true, ...(process.env.SUBHUB_CHROMIUM ? {executablePath: process.env.SUBHUB_CHROMIUM} : {})});
  const errors = [], overflows = [], checks = [], shots = [];
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: "reduce"});
  await context.addCookies([{name: "subhub_session", value: config.session, url: config.base, httpOnly: true, sameSite: "Lax"}]);
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  async function visit(route) {
    await page.goto(config.base + route);
    await page.locator(".page, .pub-page").first().waitFor();
    await page.waitForTimeout(200);
  }
  async function checkLayout(name) {
    const result = await page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(d => ({width: d.getBoundingClientRect().width, scroll: d.scrollWidth}))
    }));
    if (result.width > result.viewport + 1 || result.dialogs.some(d => d.scroll > d.width + 1)) overflows.push({name, ...result});
  }
  async function shot(name) {
    await checkLayout(name);
    const file = path.join(config.output, name + ".png");
    await page.screenshot({path: file, fullPage: true});
    shots.push(file);
  }
  const dialog = () => page.getByRole("dialog");
  const field = label => dialog().getByLabel(label, {exact: true});
  const close = async () => { await dialog().getByRole("button", {name: "关闭", exact: true}).click(); await dialog().waitFor({state: "hidden"}); };
  try {
    for (const mode of ["dark", "light"]) {
      await context.request.post(config.base + "/api/admin/appearance", {headers: {"X-SubHub-Request": "1"},
        data: {appearance: mode, accent: "#3b82f6", background: "", surfaceOpacity: 70, brandName: "SubHub", brandSub: "PRIVATE NETWORK", workspace: "My Network", logoUrl: ""}});
      for (const width of [1440, 768, 390, 360]) {
        await page.setViewportSize({width, height: 900});
        for (const route of ["", "/servers", "/nodes", "/subscriptions", "/members", "/tasks", "/settings"]) {
          await visit("/admin" + route);
          await checkLayout(`${mode}-${width}-${route || "overview"}`);
          if ([1440, 390].includes(width) && ["", "/servers", "/nodes"].includes(route)) await shot(`${mode}-${width}-${route.slice(1) || "overview"}`);
        }
        await visit("/status");
        await shot(`${mode}-${width}-public`);
        assert.equal(await page.getByText("LO ·", {exact: false}).count(), 0);
        assert.equal(await page.getByText("连接数", {exact: true}).count(), 0);
        assert.equal(await page.getByText("在线时长", {exact: true}).count(), 0);
        assert.equal(await page.getByRole("link", {name: "后台管理"}).getAttribute("href"), "/admin");
      }
    }
    checks.push("seven pages and public status in two themes at four widths");
    await page.setViewportSize({width: 390, height: 900});
    await visit("/admin/servers");
    assert.equal(await page.getByText("103600.00 PB", {exact: false}).count(), 0);
    assert(await page.getByText("103.60 GB", {exact: true}).count() > 0);
    await page.getByRole("button", {name: "添加服务器", exact: true}).click();
    await field("服务器名称").fill("UI acceptance server");
    await field("地址（IP 或域名）").fill("203.0.113.99");
    await field("地区").fill("Taipei");
    assert.equal(await dialog().getByText("续费价格", {exact: true}).count(), 0);
    await shot("server-create-mobile");
    await dialog().getByRole("button", {name: "保存", exact: true}).click();
    await page.getByRole("dialog", {name: "UI acceptance server", exact: true}).waitFor();
    await dialog().getByRole("button", {name: "编辑", exact: true}).click();
    await field("服务器名称").fill("UI acceptance server edited");
    await dialog().getByRole("button", {name: "保存", exact: true}).click();
    await page.getByRole("dialog", {name: "UI acceptance server edited", exact: true}).waitFor();
    await dialog().getByRole("button", {name: "关联 Komari", exact: true}).click();
    await shot("komari-binding-mobile");
    await close();
    await page.getByText("UI acceptance server edited", {exact: true}).click();
    await dialog().getByRole("button", {name: "接入面板", exact: true}).click();
    await shot("panel-connect-mobile");
    await close();
    checks.push("server creation and editing; Komari and panel entry points");

    await visit("/admin/nodes");
    await page.getByRole("button", {name: "添加节点", exact: true}).click();
    await field("节点名称").fill("UI acceptance AnyTLS");
    await field("协议").selectOption("AnyTLS");
    await field("地址（IP 或域名）").fill("node.example.test");
    await field("密码").fill("synthetic-disposable-credential");
    await field("SNI").fill("node.example.test");
    await shot("node-create-mobile");
    await dialog().getByRole("button", {name: "保存", exact: true}).click();
    await page.getByRole("dialog", {name: "UI acceptance AnyTLS", exact: true}).waitFor();
    await dialog().getByRole("button", {name: "编辑节点", exact: true}).click();
    await field("节点名称").fill("UI acceptance AnyTLS edited");
    await dialog().getByRole("button", {name: "保存", exact: true}).click();
    await page.getByRole("dialog", {name: "UI acceptance AnyTLS edited", exact: true}).waitFor();
    await close();
    const managedRow = page.locator("tr").filter({hasText: "HK Reality"});
    await managedRow.getByRole("button", {name: "编辑 HK Reality", exact: true}).click();
    assert(await field("协议").isDisabled());
    assert(await field("安全方式").isDisabled());
    assert.equal(await dialog().locator('input[type="password"]').count(), 0);
    await shot("node-managed-mobile");
    await close();
    checks.push("manual node creation and editing; managed protocol and credential locks");

    await visit("/admin/nodes");
    assert.equal(await page.getByRole("button", {name: "测速", exact: true}).count(), 0);
    assert.equal(await page.getByText("下载速度", {exact: true}).count(), 0);
    const testRow = page.locator("tr").filter({hasText: "UI acceptance AnyTLS edited"});
    await testRow.getByRole("button", {name: "测试 UI acceptance AnyTLS edited 延迟", exact: true}).click();
    await testRow.getByText("测试中", {exact: true}).waitFor();
    await shot("node-latency-mobile");
    await testRow.getByText("已验证", {exact: true}).first().waitFor({timeout: 15000});
    checks.push("one-click per-node latency without download testing");

    assert.equal(errors.length, 0, errors.join("\n"));
    assert.equal(overflows.length, 0, JSON.stringify(overflows));
    console.log(JSON.stringify({checks, errors, overflows, screenshots: shots}, null, 2));
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
