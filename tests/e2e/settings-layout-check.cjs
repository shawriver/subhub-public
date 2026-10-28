// Disposable settings acceptance. Input: {base,session,output,disposable:true}.
// Covers the shared visual styling too. No panel connection, credential changes
// or real synchronization is performed.
const {chromium} = require(process.env.SUBHUB_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input);
  assert.equal(config.disposable, true);
  fs.mkdirSync(config.output, {recursive: true});
  const browser = await chromium.launch({headless: true, ...(process.env.SUBHUB_CHROMIUM ? {executablePath: process.env.SUBHUB_CHROMIUM} : {})});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: "reduce"});
  await context.addCookies([{name: "subhub_session", value: config.session, url: config.base, httpOnly: true, sameSite: "Lax"}]);
  const page = await context.newPage();
  const errors = [], shots = [], checks = [];
  page.on("pageerror", error => errors.push(error.message));
  async function api(method, route, data) {
    const r = await context.request.fetch(config.base + route, {method, headers: {"X-SubHub-Request": "1"}, ...(data === undefined ? {} : {data})});
    assert(r.ok(), `Fixture request failed: ${r.status()}`);
    return r.json();
  }
  const theme = mode => ({appearance: mode, accent: "#3b82f6", background: "", surfaceOpacity: 70, brandName: "SubHub", brandSub: "PRIVATE NETWORK", workspace: "My Network", logoUrl: ""});
  const sections = [["appearance", "外观与品牌"], ["public", "公开页面"], ["connections", "服务接入"], ["sync", "面板同步"], ["security", "账户安全"]];
  async function visit(route) {
    await page.goto(config.base + route);
    await page.locator(".page, .pub-page").first().waitFor();
  }
  async function section(id, title) {
    await page.getByRole("navigation", {name: "设置分类"}).getByRole("button", {name: title, exact: true}).click();
    await page.locator(".settings-section-intro").getByRole("heading", {name: title, exact: true}).waitFor();
    assert.equal(new URL(page.url()).hash, "#" + id);
    assert.equal(await page.locator(".settings-nav-item[aria-current=page]").count(), 1);
  }
  async function layout(name, screenshot = false) {
    const sizes = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(d => ({width: d.getBoundingClientRect().width, scroll: d.scrollWidth}))}));
    assert(sizes.scroll <= sizes.width + 1, `Overflow: ${name}`);
    assert(sizes.dialogs.every(d => d.scroll <= d.width + 1), `Dialog overflow: ${name}`);
    if (screenshot) {
      const file = path.join(config.output, name + ".png");
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({path: file, fullPage: true});
      shots.push(file);
    }
  }
  try {
    for (const mode of ["light", "dark"]) {
      await api("POST", "/api/admin/appearance", theme(mode));
      for (const width of [1440, 1024, 768, 390, 360]) {
        await page.setViewportSize({width, height: 1000});
        for (const route of ["", "/servers", "/nodes", "/subscriptions", "/members", "/tasks"]) {
          await visit("/admin" + route);
          await layout(`${mode}-${width}-${route.slice(1) || "overview"}`, [1440, 390].includes(width));
          assert.equal(await page.getByRole("navigation", {name: "主导航"}).locator("[aria-current=page]").count(), 1);
          if (route === "/nodes") {
            assert.equal(await page.locator(".nd-table th").count(), 7);
            assert.equal(await page.locator(".nd-test-cell").count(), 0);
            assert.equal(await page.locator(".nd-table").getByText("最近测试", {exact: true}).count(), 0);
          }
          if (route === "/subscriptions") {
            for (const category of ["个人订阅", "分流模板", "订阅"]) {
              await page.getByRole("group", {name: "订阅分类", exact: true}).getByRole("button", {name: category, exact: true}).click();
              await layout(`${mode}-${width}-subscription-${category}`, [1440, 390].includes(width));
            }
          }
        }
        await visit("/status");
        await page.locator(".pub-page").waitFor();
        await layout(`${mode}-${width}-public-wall`, [1440, 390].includes(width));
        await visit("/admin/settings");
        assert.equal(await page.locator(".settings-nav-meta").count(), 0);
        assert.equal(await page.getByRole("group", {name: "外观模式"}).locator("[aria-pressed=true]").count(), 1);
        for (const [id, title] of sections) {
          await section(id, title);
          await layout(`${mode}-${width}-${id}`, [1440, 390].includes(width));
          if (id === "connections") {
            const expand = page.locator(".st-expand");
            assert.equal(await expand.getAttribute("open"), null);
            await expand.locator("summary").click();
            await page.getByLabel("面板名称", {exact: true}).waitFor();
            await layout(`${mode}-${width}-panel-form`, [1440, 390].includes(width));
            await expand.locator("summary").click();
          }
        }
      }
    }
    checks.push("seven admin pages, public wall and five settings sections in both themes at five widths without overflow; duplicate settings footer removed");

    // Exercise latency polling in the simplified table using synthetic results.
    const latencyOverview = await api("GET", "/api/admin/overview");
    const latencyNode = latencyOverview.nodes.find(n => n.enabled);
    let latencyState = null;
    const latencyResult = {nodeId: latencyNode.id, runId: "synthetic-layout-run", mode: "latency", state: "running", checkedAt: new Date().toISOString()};
    await page.route("**/api/admin/overview", route => route.fulfill({status: 200, contentType: "application/json",
      body: JSON.stringify({...latencyOverview, nodeTests: {...latencyOverview.nodeTests, ...(latencyState ? {[latencyNode.id]: {...latencyResult, ...latencyState}} : {})}})}));
    await page.route(`**/api/admin/nodes/${latencyNode.id}/test`, route => {
      if (route.request().method() === "POST") {
        assert.equal(route.request().postDataJSON().mode, "latency");
        latencyState = {state: "running"};
        return route.fulfill({status: 202, contentType: "application/json", body: JSON.stringify(latencyResult)});
      }
      latencyState = {state: "verified", latencyMs: 47, detail: "Synthetic latency acceptance"};
      return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({...latencyResult, ...latencyState})});
    });
    await visit("/admin/nodes");
    const latencyRow = page.locator(".nd-table tbody tr").filter({hasText: latencyNode.name});
    await latencyRow.getByRole("button", {name: `测试 ${latencyNode.name} 延迟`, exact: true}).click();
    await latencyRow.getByText("测试中", {exact: true}).waitFor();
    await latencyRow.getByText("47 ms", {exact: true}).waitFor();
    assert.equal(await latencyRow.getByRole("button", {name: `测试 ${latencyNode.name} 延迟`, exact: true}).isEnabled(), true);
    assert.equal(await page.locator(".nd-test-cell").count(), 0);
    await page.unroute(`**/api/admin/nodes/${latencyNode.id}/test`);
    await page.unroute("**/api/admin/overview");
    checks.push("simplified node table retains the latency button, progress and polled result without diagnostic text");

    await visit("/admin/settings#appearance");
    for (const [mode, title] of [["light", "浅色"], ["dark", "深色"], ["system", "跟随系统"]]) {
      const choice = page.getByRole("group", {name: "外观模式"}).getByRole("button", {name: title, exact: true});
      const saved = page.waitForResponse(r => r.url().endsWith("/api/admin/appearance") && r.request().method() === "POST");
      await choice.focus();
      await page.keyboard.press("Enter");
      assert.equal((await saved).status(), 200);
      await page.reload();
      assert.equal(await page.getByRole("group", {name: "外观模式"}).getByRole("button", {name: title, exact: true}).getAttribute("aria-pressed"), "true");
      assert.equal((await api("GET", "/api/admin/appearance")).appearance.appearance, mode);
    }
    // Check the actual rendered button colours against the 4.5:1 text target.
    for (const accent of ["#3b82f6", "#76e4c2", "#8b5cf6", "#06b6d4", "#f59e0b", "#ef4444", "#747474", "#777777", "#111111", "#ffffff"]) {
      await api("POST", "/api/admin/appearance", {...theme("dark"), accent});
      await visit("/admin/nodes");
      await page.getByRole("button", {name: "导入节点", exact: true}).waitFor();
      const contrast = await page.getByRole("button", {name: "导入节点", exact: true}).evaluate(button => {
        const css = getComputedStyle(button);
        const luminance = colour => {
          const c = colour.match(/[\d.]+/g).slice(0, 3).map(x => Number(x) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
          return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
        };
        const values = [luminance(css.color), luminance(css.backgroundColor)];
        return (Math.max(...values) + .05) / (Math.min(...values) + .05);
      });
      assert(contrast >= 4.5, `Primary button contrast below 4.5:1 for ${accent}`);
    }
    await api("POST", "/api/admin/appearance", theme("dark"));
    checks.push("keyboard-selectable theme previews persist; all preset and extreme custom colours keep primary button text readable");

    await page.setViewportSize({width: 390, height: 1000});
    await visit("/admin/settings#connections");
    assert.equal(await page.locator(".settings-nav-item.active").innerText(), "服务接入");
    const binding = page.locator(".st-bind-row").first();
    const picker = binding.getByRole("combobox");
    const original = await picker.inputValue();
    await picker.selectOption("");
    assert.equal(await binding.getByRole("button", {name: "保存关联", exact: true}).isEnabled(), true);
    await picker.selectOption(original);
    assert.equal(await binding.getByRole("button", {name: "保存关联", exact: true}).isDisabled(), true);
    checks.push("deep links restore category; Komari selector keeps its existing save behavior");

    await section("appearance", "外观与品牌");
    const saved = page.waitForResponse(r => r.url().endsWith("/api/admin/appearance") && r.request().method() === "POST");
    await page.getByLabel("工作区名称", {exact: true}).fill("设置布局预览");
    assert.equal((await saved).status(), 200);
    await visit("/admin/settings#appearance");
    assert.equal(await page.getByLabel("工作区名称", {exact: true}).inputValue(), "设置布局预览");
    assert.equal(await page.getByRole("slider").isDisabled(), true);
    await api("POST", "/api/admin/appearance", theme("dark"));
    await visit("/admin/settings#public");
    await page.getByRole("switch", {name: "公开状态页开关", exact: true}).waitFor();
    const before = (await api("GET", "/api/admin/public-settings")).enabled;
    await page.getByRole("switch", {name: "公开状态页开关", exact: true}).click();
    await page.getByRole("button", {name: "保存设置", exact: true}).click();
    await page.getByText("已保存", {exact: true}).waitFor();
    assert.equal((await api("GET", "/api/admin/public-settings")).enabled, !before);
    await page.getByRole("switch", {name: "公开状态页开关", exact: true}).click();
    await page.getByRole("button", {name: "保存设置", exact: true}).click();
    await page.getByText("已保存", {exact: true}).waitFor();
    assert.equal((await api("GET", "/api/admin/public-settings")).enabled, before);
    checks.push("appearance edits persist and public-page settings save and restore");

    await section("sync", "面板同步");
    const observe = page.getByRole("switch", {name: "观察模式开关", exact: true});
    await page.getByText("开启中：同步只回拉流量、记录将执行的动作，不动面板客户端", {exact: true}).waitFor();
    await observe.click();
    await page.getByRole("button", {name: "确认关闭，开始真实执行", exact: true}).waitFor();
    await layout("sync-confirm-mobile", true);
    await page.getByRole("button", {name: "再想想", exact: true}).click();
    assert.equal((await api("GET", "/api/admin/sync-settings")).observeMode, true);
    checks.push("sync confirmation can be cancelled without changing execution mode");

    await section("security", "账户安全");
    const passwordForm = page.getByRole("button", {name: "更新密码", exact: true}).locator("..");
    await passwordForm.getByLabel("当前密码", {exact: true}).fill("synthetic-preview-only");
    await passwordForm.getByLabel("新密码", {exact: true}).fill("short");
    await page.getByRole("button", {name: "更新密码", exact: true}).click();
    await page.getByText("新密码至少需要 14 个字符", {exact: true}).waitFor();
    await section("appearance", "外观与品牌");
    await section("security", "账户安全");
    await page.getByRole("button", {name: "更新密码", exact: true}).waitFor();
    assert.equal(await page.getByLabel("新密码", {exact: true}).inputValue(), "");
    assert.equal(await page.getByRole("button", {name: "开始设置", exact: true}).count(), 1);
    // Display the enabled TOTP branch using only synthetic metadata.
    await page.route("**/api/admin/security", route => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({totpEnabled: true, backupSchedule: "每日备份"})}));
    await visit("/admin/settings#security");
    await page.reload();
    await page.getByRole("button", {name: "关闭二步验证", exact: true}).waitFor();
    await layout("security-enabled-mobile", true);
    await page.unroute("**/api/admin/security");
    checks.push("password validation and both TOTP layouts remain available; section navigation clears unfinished secrets");

    const fixtureOverview = await api("GET", "/api/admin/overview");
    await page.route("**/api/admin/overview", route => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({...fixtureOverview, panels: [], servers: []})}));
    await visit("/admin/settings#connections");
    await page.reload();
    await page.getByLabel("面板名称", {exact: true}).waitFor();
    assert.notEqual(await page.locator(".st-expand").getAttribute("open"), null);
    assert.equal(await page.locator(".st-expand").getByRole("combobox").isDisabled(), true);
    assert.equal(await page.getByRole("button", {name: "接入面板", exact: true}).isDisabled(), true);
    await layout("connections-empty-mobile", true);
    await page.unroute("**/api/admin/overview");
    checks.push("empty connection settings open the first-panel form and disable submission without a server");

    await visit("/admin/subscriptions");
    assert.equal(await page.getByRole("heading", {name: "订阅", exact: true}).count() >= 1, true);
    // User-authored record names may still contain historical terminology.
    assert.equal(await page.locator("nav, .page-head, .sb-tabs, .sb-section-head, thead").getByText("套餐", {exact: false}).count(), 0);
    await page.getByRole("button", {name: "新建订阅", exact: true}).click();
    await page.getByRole("dialog", {name: "新建订阅", exact: true}).waitFor();
    await layout("subscription-name-mobile", true);
    await page.getByRole("button", {name: "关闭", exact: true}).click();
    await page.getByRole("article", {name: "订阅 亚洲节点", exact: true}).getByRole("button", {name: "分配用户", exact: true}).click();
    await page.getByRole("dialog", {name: "分配订阅 · 亚洲节点", exact: true}).waitFor();
    await page.getByRole("button", {name: "取消", exact: true}).click();
    const reviewName = "卡片验收-" + Date.now();
    await page.getByRole("button", {name: "新建订阅", exact: true}).click();
    let form = page.getByRole("dialog", {name: "新建订阅", exact: true});
    await form.getByLabel("名称", {exact: true}).fill(reviewName);
    await form.getByRole("button", {name: "选择全部节点", exact: true}).click();
    await form.getByRole("button", {name: "保存", exact: true}).click();
    const card = page.getByRole("article", {name: "订阅 " + reviewName, exact: true});
    await card.waitFor();
    await card.getByRole("button", {name: "编辑 " + reviewName, exact: true}).click();
    form = page.getByRole("dialog", {name: "编辑订阅", exact: true});
    await form.getByLabel("备注", {exact: true}).fill("节点组合卡片验收");
    await form.getByRole("button", {name: "保存", exact: true}).click();
    await card.getByText("节点组合卡片验收", {exact: true}).waitFor();
    await card.getByRole("button", {name: "删除 " + reviewName, exact: true}).click();
    await page.getByRole("dialog").getByRole("button", {name: "删除", exact: true}).click();
    await card.waitFor({state: "hidden"});
    assert.equal((await api("GET", "/api/admin/overview")).subscriptions.some(s => s.name === reviewName), false);
    checks.push("subscription cards retain create, edit, assignment-dialog and deletion actions");

    // Filtering and empty/long-name layouts use response-only fixtures.
    const longName = "订阅名称较长时仍然完整显示".repeat(7);
    await page.route("**/api/admin/overview", route => route.fulfill({status: 200, contentType: "application/json",
      body: JSON.stringify({...fixtureOverview, subscriptions: [...fixtureOverview.subscriptions, {id: "long-layout", name: longName, note: "备注内容可以换行显示".repeat(10), nodeIds: []}]})}));
    await visit("/admin/subscriptions");
    await page.reload();
    await page.getByRole("article", {name: "订阅 " + longName, exact: true}).waitFor();
    await layout("long-subscription-mobile");
    await page.getByLabel("搜索当前列表", {exact: true}).fill("没有匹配项-验收");
    await page.getByText("没有匹配的订阅", {exact: true}).waitFor();
    await page.getByRole("button", {name: "清除搜索", exact: true}).click();
    await page.getByRole("article", {name: "订阅 " + longName, exact: true}).waitFor();
    await page.unroute("**/api/admin/overview");

    await page.route("**/api/admin/overview", route => route.fulfill({status: 200, contentType: "application/json",
      body: JSON.stringify({...fixtureOverview, tasks: [{id: "task-layout", name: "布局验收任务", kind: "backup", status: "failed",
        detail: "合成任务记录".repeat(40), created: new Date().toISOString()}]})}));
    await visit("/admin/tasks");
    await page.locator(".tk-table").getByText("布局验收任务", {exact: true}).waitFor();
    await page.locator(".tk-table").getByRole("button", {name: "展开", exact: true}).click();
    await layout("populated-task-mobile");
    await page.unroute("**/api/admin/overview");
    checks.push("long subscription names wrap, search clears correctly, and populated task details stay within their panel");
    await visit("/admin/members");
    assert.equal(await page.locator("nav, .page-head").getByText("套餐", {exact: false}).count(), 0);
    checks.push("subscription terminology in navigation, lists, create and assignment dialogs");

    for (const width of [390, 360]) {
      await page.setViewportSize({width, height: 1000});
      for (const [route, button] of [["/nodes", "添加节点"], ["/members", "新建用户"], ["/tasks", "下载加密备份"]]) {
        await visit("/admin" + route);
        await page.getByRole("button", {name: button, exact: true}).click();
        await page.getByRole("dialog").waitFor();
        await layout(`mobile-${width}-${route.slice(1)}-dialog`);
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({state: "hidden"});
      }
    }
    checks.push("node, user and backup dialogs fit narrow screens and retain Escape dismissal");
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(JSON.stringify({checks, errors, screenshots: shots}, null, 2));
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
