// Disposable browser acceptance. Input: {base,session,output,disposable:true}.
// Credentials and generated subscription URLs stay in memory, never screenshots.
const {chromium} = require(process.env.SUBHUB_PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input);
  assert.equal(config.disposable, true, "This check changes disposable records");
  fs.mkdirSync(config.output, {recursive: true});
  const browser = await chromium.launch({headless: true, ...(process.env.SUBHUB_CHROMIUM ? {executablePath: process.env.SUBHUB_CHROMIUM} : {})});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: "reduce"});
  await context.addCookies([{name: "subhub_session", value: config.session, url: config.base, httpOnly: true, sameSite: "Lax"}]);
  const page = await context.newPage();
  const errors = [], checks = [], shots = [];
  page.on("pageerror", error => errors.push(error.message));
  const api = async (method, route, data) => {
    const response = await context.request.fetch(config.base + route, {method, headers: {"X-SubHub-Request": "1"}, ...(data === undefined ? {} : {data})});
    assert(response.ok(), `API check failed: ${route}, status ${response.status()}`);
    return response.json();
  };
  const overview = () => api("GET", "/api/admin/overview");
  const dialog = () => page.getByRole("dialog");
  const close = async () => { await dialog().getByRole("button", {name: "关闭", exact: true}).click(); };
  async function visit(route) {
    await page.goto(config.base + route);
    await page.locator(".page, .pub-page").first().waitFor();
  }
  async function layout(name, screenshot = false) {
    const result = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth, viewport: innerWidth,
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(d => ({width: d.getBoundingClientRect().width, scroll: d.scrollWidth}))
    }));
    assert(result.width <= result.viewport + 1 && result.dialogs.every(d => d.scroll <= d.width + 1), `Layout overflow: ${name}`);
    assert.equal(await page.getByRole("dialog").count() <= 1, true, "Dialogs must not stack");
    if (screenshot) {
      const file = path.join(config.output, name.replaceAll("/", "") + ".png");
      await page.screenshot({path: file, fullPage: await page.getByRole("dialog").count() === 0});
      shots.push(file);
    }
  }
  const openLinks = async name => {
    await visit("/admin/members");
    await page.locator(".mb-card").filter({has: page.locator(".m-name", {hasText: name})}).getByRole("button", {name: /个人订阅/}).click();
    await page.getByRole("dialog", {name: `${name} · 个人订阅`, exact: true}).waitFor();
  };
  async function issue(name, profileName) {
    await openLinks(name);
    await dialog().locator(".mb-profile-row").filter({hasText: profileName}).getByRole("button", {name: "生成链接", exact: true}).click();
    await dialog().getByLabel("订阅链接（只显示这一次）", {exact: true}).waitFor();
    const url = await dialog().getByLabel("订阅链接（只显示这一次）", {exact: true}).inputValue();
    assert.equal((await context.request.get(url)).status(), 200, "Personal download failed");
    await dialog().getByRole("button", {name: "我已保存", exact: true}).click();
    return url;
  }
  try {
    if (!config.workflowOnly) {
    for (const mode of ["light", "dark"]) {
      await api("POST", "/api/admin/appearance", {appearance: mode, accent: "#3b82f6", background: "", surfaceOpacity: 70, brandName: "SubHub", brandSub: "PRIVATE NETWORK", workspace: "My Network", logoUrl: ""});
      for (const width of [1440, 768, 390, 360]) {
        await page.setViewportSize({width, height: 1000});
        for (const route of ["", "/servers", "/nodes", "/subscriptions", "/members", "/tasks", "/settings"]) {
          await visit("/admin" + route);
          await layout(`${mode}-${width}-${route || "overview"}`, [1440, 390].includes(width) && ["/subscriptions", "/members"].includes(route));
          if (route === "/subscriptions") {
            for (const category of ["订阅", "分流模板", "个人订阅"]) {
              await page.getByRole("group", {name: "订阅分类", exact: true}).getByRole("button", {name: category, exact: true}).click();
              await layout(`${mode}-${width}-${category}`);
            }
          }
        }
        await visit("/status");
        await page.locator(".pub-machine").first().waitFor();
        assert.equal(await page.getByText("连接数", {exact: true}).count(), 0);
        assert.equal(await page.getByText("在线时长", {exact: true}).count(), 0);
        assert.equal(await page.getByRole("link", {name: "后台管理"}).getAttribute("href"), "/admin");
        await layout(`${mode}-${width}-public`, [1440, 390].includes(width));
      }
    }
    checks.push("seven admin pages, package categories and public status in two themes at four widths");
    const publicStatus = await (await context.request.get(config.base + "/api/public/status")).json();
    assert(publicStatus.machines.every(m => !("connectionsTcp" in m) && !("connectionsUdp" in m) && !("uptimeSeconds" in m)));
    const anon = await browser.newContext();
    const publicPage = await anon.newPage();
    for (const state of ["closed", "failed", "empty", "loading"]) {
      await publicPage.route("**/api/public/status", async route => {
        if (state === "loading") {
          await new Promise(resolve => setTimeout(resolve, 1000));
          return route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify({machines: [], refreshSeconds: 5})}).catch(() => {});
        }
        await route.fulfill({status: state === "closed" ? 404 : state === "failed" ? 503 : 200, contentType: "application/json",
          body: JSON.stringify(state === "closed" ? {error: "公开状态页已关闭"} : state === "failed" ? {error: "状态暂不可用"} : {machines: [], refreshSeconds: 5})});
      });
      await publicPage.goto(config.base + "/status");
      await publicPage.getByRole("link", {name: "后台管理"}).waitFor();
      if (state !== "loading") await publicPage.getByText(state === "closed" ? "公开状态页已关闭" : state === "failed" ? "状态暂不可用" : "暂无服务器记录。", {exact: true}).waitFor();
      await publicPage.unroute("**/api/public/status");
    }
    await publicPage.getByRole("link", {name: "后台管理"}).click();
    await publicPage.getByRole("button", {name: "进入工作台", exact: true}).waitFor();
    await anon.close();
    checks.push("public API trims internal metrics; admin entry works in every page state and requires login");
    }

    await page.setViewportSize({width: 390, height: 1000});
    await openLinks("家人");
    await layout("member-personal-empty-mobile", true);
    await dialog().getByRole("button", {name: "新建个人订阅", exact: true}).click();
    assert.equal(await dialog().getByLabel("所属用户", {exact: true}).isDisabled(), true);
    assert.equal(await dialog().getByLabel("跟随订阅分配", {exact: false}).isChecked(), true);
    await dialog().getByLabel("名称", {exact: true}).fill("家人 · 手机订阅");
    await dialog().getByLabel("规则模板", {exact: true}).selectOption("basic-v1");
    assert.equal(await dialog().getByLabel("自定义规则（每行一条）", {exact: true}).isDisabled(), false);
    await layout("personal-create-mobile", true);
    await dialog().getByRole("button", {name: "保存", exact: true}).click();
    await dialog().getByText("家人 · 手机订阅", {exact: true}).waitFor();
    await layout("member-personal-list-mobile", true);
    const familyLink = await issue("家人", "家人 · 手机订阅");
    const firstLink = await issue("小明", "小明 · 个人订阅");
    const secondLink = await issue("小雨", "小雨 · 个人订阅");
    assert(firstLink !== secondLink, "Users sharing a collection must have distinct URLs");
    // Existing links require deliberate rotation; cancelling preserves access.
    await dialog().locator(".mb-profile-row").filter({hasText: "小雨 · 个人订阅"}).getByRole("button", {name: "生成链接", exact: true}).click();
    await dialog().getByText("已有链接，重新生成将使旧链接立即失效。", {exact: true}).waitFor();
    await layout("personal-rotation-confirm-mobile", true);
    await dialog().getByRole("button", {name: "取消", exact: true}).click();
    assert.equal((await context.request.get(secondLink)).status(), 200);
    await dialog().locator(".mb-profile-row").filter({hasText: "小雨 · 个人订阅"}).getByRole("button", {name: "生成链接", exact: true}).click();
    await dialog().getByRole("button", {name: "重新生成", exact: true}).click();
    const newField = dialog().getByLabel("订阅链接（只显示这一次）", {exact: true});
    await newField.waitFor();
    const rotatedLink = await newField.inputValue();
    assert(rotatedLink !== secondLink, "Rotation must issue a new URL");
    assert.equal((await context.request.get(secondLink)).status(), 404);
    assert.equal((await context.request.get(rotatedLink)).status(), 200);
    await dialog().getByRole("button", {name: "我已保存", exact: true}).click();
    await dialog().getByRole("button", {name: "撤销 小雨 · 个人订阅 的链接", exact: true}).click();
    await dialog().getByRole("button", {name: "撤销链接", exact: true}).click();
    await page.getByRole("dialog", {name: "小雨 · 个人订阅", exact: true}).waitFor();
    assert.equal((await context.request.get(rotatedLink)).status(), 404);
    assert.equal((await context.request.get(firstLink)).status(), 200);
    checks.push("member-page create, one-time personal URLs, independent links, explicit rotation and revocation");

    await openLinks("家人");
    await dialog().getByRole("button", {name: "调整分配", exact: true}).click();
    await dialog().getByRole("button", {name: "单独节点", exact: true}).click();
    while (await dialog().locator(".mb-check-item input:checked").count()) await dialog().locator(".mb-check-item input:checked").first().uncheck();
    await dialog().getByLabel("Tokyo Direct", {exact: false}).check();
    await layout("member-manual-allocation-mobile", true);
    await dialog().getByRole("button", {name: "保存修改", exact: true}).click();
    await page.getByRole("dialog", {name: "家人 · 个人订阅", exact: true}).waitFor();
    let data = await overview();
    let family = data.members.find(m => m.name === "家人");
    assert.equal(family.assignmentMode, "nodes");
    assert.equal(family.subscriptionIds, null);
    assert.equal(family.nodeIds.length, 1);
    assert.equal(data.profiles.find(p => p.memberId === family.id).nodeIds.length, 1);
    assert.equal((await context.request.get(familyLink)).status(), 200);
    // Edit personal rules from the member page.
    await dialog().getByRole("button", {name: "编辑 家人 · 手机订阅", exact: true}).click();
    await dialog().getByLabel("名称", {exact: true}).fill("家人 · 常用订阅");
    await dialog().getByRole("button", {name: "保存", exact: true}).click();
    await dialog().getByText("家人 · 常用订阅", {exact: true}).waitFor();
    await dialog().getByRole("button", {name: "调整分配", exact: true}).click();
    await dialog().getByRole("button", {name: "订阅", exact: true}).click();
    while (await dialog().locator(".mb-check-item input:checked").count()) await dialog().locator(".mb-check-item input:checked").first().uncheck();
    await dialog().getByLabel("亚洲节点", {exact: false}).check();
    await dialog().getByRole("button", {name: "保存修改", exact: true}).click();
    await page.getByRole("dialog", {name: "家人 · 个人订阅", exact: true}).waitFor();
    data = await overview();
    family = data.members.find(m => m.name === "家人");
    assert.equal(family.assignmentMode, "subscriptions");
    assert.equal(family.nodeIds.length, 4);
    assert.equal((await context.request.get(familyLink)).status(), 200);
    await close();
    await page.locator(".mb-card").filter({hasText: "小明"}).getByRole("switch").click();
    await page.locator(".mb-card").filter({hasText: "小明"}).getByText("已停用", {exact: true}).first().waitFor();
    assert.notEqual((await context.request.get(firstLink)).status(), 200);
    assert.equal((await context.request.get(familyLink)).status(), 200);
    await page.locator(".mb-card").filter({hasText: "小明"}).getByRole("switch").click();
    await page.locator(".mb-card").filter({hasText: "小明"}).getByText("启用中", {exact: true}).waitFor();
    await page.locator(".mb-card").filter({hasText: "小明"}).click();
    await dialog().getByRole("button", {name: "编辑用户", exact: true}).click();
    await layout("member-edit-single-modal-mobile", true);
    await close();
    checks.push("manual/collection allocation, profile auto-follow, edit without stacked dialogs and isolated disable");

    await visit("/admin/nodes");
    assert.equal(await page.getByRole("button", {name: "测速", exact: true}).count(), 0);
    assert.equal(await page.getByText("下载速度", {exact: true}).count(), 0);
    const nodeRow = page.locator("tr").filter({hasText: "Tokyo Direct"});
    await nodeRow.getByRole("button", {name: "测试 Tokyo Direct 延迟", exact: true}).click();
    await nodeRow.getByText("测试中", {exact: true}).waitFor();
    await layout("node-latency-progress-mobile", true);
    await nodeRow.getByText("已验证", {exact: true}).first().waitFor({timeout: 15000});
    await nodeRow.getByText("43 ms", {exact: true}).waitFor();
    const latest = (await overview()).nodeTests["node-3"];
    assert.equal(latest.mode, "latency");
    assert.equal(latest.bytes, 0);
    assert.equal(latest.downMbps ?? 0, 0);
    assert.equal((await context.request.post(config.base + "/api/admin/nodes/node-3/test", {headers: {"X-SubHub-Request": "1"}, data: {mode: "download"}})).status(), 400);
    await visit("/admin/tests");
    await page.getByRole("heading", {name: "节点", exact: true}).last().waitFor();
    checks.push("one per-node latency button, live result, no download mode and old test route opens nodes");

    await visit("/admin/subscriptions");
    await page.getByRole("heading", {name: "订阅", exact: true}).last().waitFor();
    await page.getByRole("button", {name: "新建订阅", exact: true}).click();
    await dialog().getByLabel("名称", {exact: true}).fill("全节点订阅");
    await dialog().getByRole("button", {name: "选择全部节点", exact: true}).click();
    await layout("package-create-all-nodes-mobile", true);
    await dialog().getByRole("button", {name: "保存", exact: true}).click();
    await page.getByRole("article", {name: "订阅 全节点订阅", exact: true}).waitFor();
    const packageRow = page.getByRole("article", {name: "订阅 全节点订阅", exact: true});
    await packageRow.getByRole("button", {name: "分配用户", exact: true}).click();
    await dialog().getByLabel("家人", {exact: false}).check();
    await dialog().getByLabel("备用用户", {exact: false}).check();
    await layout("package-assign-users-mobile", true);
    await dialog().getByRole("button", {name: "保存分配", exact: true}).click();
    await packageRow.getByText("2 位用户", {exact: true}).waitFor();
    data = await overview();
    const plan = data.subscriptions.find(s => s.name === "全节点订阅");
    assert.equal(plan.nodeIds.length, 6);
    assert(data.members.filter(m => m.subscriptionIds?.includes(plan.id)).length === 2);
    checks.push("create full-node package and assign it to multiple users");

    await openLinks("小明");
    await dialog().getByRole("button", {name: "定制订阅", exact: true}).click();
    await dialog().getByLabel("名称", {exact: true}).fill("小明 · 工作定制");
    while (await dialog().locator('.sb-node-row input:checked').count()) await dialog().locator('.sb-node-row input:checked').first().uncheck();
    await dialog().getByLabel("Frankfurt Direct", {exact: false}).check();
    await layout("custom-subscription-mobile", true);
    await dialog().getByRole("button", {name: "保存", exact: true}).click();
    await dialog().getByText("小明 · 工作定制", {exact: true}).waitFor();
    const customLink = await issue("小明", "小明 · 工作定制");
    data = await overview();
    const customMember = data.members.find(m => m.name === "小明");
    assert.equal(customMember.allocationNodeIds.length, 4);
    assert.equal(customMember.nodeIds.length, 5);
    const customProfile = data.profiles.find(p => p.name === "小明 · 工作定制");
    assert.equal(customProfile.customNodes, true);
    assert.deepEqual(customProfile.nodeIds, ["node-6"]);
    let content = await (await context.request.get(customLink)).text();
    assert(content.includes("Frankfurt Direct") && !content.includes("Hong Kong Direct"), "Custom link must carry only its selected nodes");
    content = await (await context.request.get(firstLink)).text();
    assert(content.includes("Hong Kong Direct") && !content.includes("Frankfurt Direct"), "Package subscription must keep its own nodes");
    await dialog().getByRole("button", {name: "编辑 小明 · 工作定制", exact: true}).click();
    await dialog().getByLabel("Frankfurt Direct", {exact: false}).uncheck();
    await dialog().getByLabel("Fremont Direct", {exact: false}).check();
    await dialog().getByRole("button", {name: "保存", exact: true}).click();
    await page.getByRole("dialog", {name: "小明 · 个人订阅", exact: true}).waitFor();
    content = await (await context.request.get(customLink)).text();
    assert(content.includes("Fremont Direct") && !content.includes("Frankfurt Direct"), "Custom edit should keep its URL");
    await dialog().getByRole("button", {name: "删除 小明 · 工作定制", exact: true}).click();
    await dialog().getByRole("button", {name: "删除订阅", exact: true}).click();
    await page.getByRole("dialog", {name: "小明 · 个人订阅", exact: true}).waitFor();
    data = await overview();
    assert.equal(data.members.find(m => m.name === "小明").nodeIds.length, 4);
    assert.equal((await context.request.get(customLink)).status(), 404);
    assert.equal((await context.request.get(firstLink)).status(), 200);
    checks.push("custom nodes outside the package, isolated export, edit with stable URL and deletion removes only custom access");

    await close();
    const before = await page.locator("html").getAttribute("data-appearance");
    const themePush = page.waitForResponse(r => r.url().endsWith("/api/admin/appearance") && r.request().method() === "POST");
    await page.getByRole("button", {name: before === "dark" ? "切换浅色" : "切换深色", exact: true}).click();
    const after = before === "dark" ? "light" : "dark";
    await page.waitForFunction(mode => document.documentElement.dataset.appearance === mode, after);
    assert.equal((await themePush).status(), 200);
    await visit("/admin/subscriptions");
    assert.equal(await page.locator("html").getAttribute("data-appearance"), after);
    await visit("/status");
    await page.getByRole("button", {name: after === "dark" ? "切换浅色" : "切换深色", exact: true}).click();
    await page.waitForFunction(mode => document.documentElement.dataset.appearance === mode, before);
    await layout("public-theme-toggle-mobile", true);
    checks.push("admin and public appearance buttons switch both themes and persist the choice");
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(JSON.stringify({checks, errors, screenshots: shots}, null, 2));
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
