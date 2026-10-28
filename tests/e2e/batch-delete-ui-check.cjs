// Disposable browser acceptance. Input: {base,session,output,disposable:true}.
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
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(config.base + "/admin/tasks");
    await page.locator(".page").waitFor();
    const publicLink = page.getByRole("link", {name: "查看公开状态页", exact: true});
    await publicLink.waitFor();
    assert.equal(await publicLink.getAttribute("href"), "/status");
    await page.screenshot({path: path.join(config.output, "tasks-with-public-link.png"), fullPage: true});

    const overview = await context.request.get(config.base + "/api/admin/overview");
    assert.equal(overview.status(), 200);
    const existing = (await overview.json()).tasks.map(task => task.id);
    for (const id of existing) {
      const deleted = await context.request.delete(config.base + "/api/admin/task/" + encodeURIComponent(id), {headers: {"X-SubHub-Request": "1"}});
      if (deleted.status() !== 200 && deleted.status() !== 409) assert.fail(`Fixture task cleanup failed: ${deleted.status()}`);
    }
    const tasks = [
      {id: "ui-delete-a", name: "可清理 A", kind: "sync", status: "success", detail: "A", created: new Date().toISOString()},
      {id: "ui-delete-b", name: "可清理 B", kind: "backup", status: "failed", detail: "B", created: new Date().toISOString()},
    ];
    for (const task of tasks) {
      const saved = await context.request.put(config.base + "/api/admin/task/" + task.id, {headers: {"X-SubHub-Request": "1"}, data: task});
      assert.equal(saved.status(), 200);
    }
    await page.reload();
    await page.getByText("可清理 A", {exact: true}).waitFor();
    assert.equal(await page.getByRole("checkbox", {name: "选择任务 受保护任务", exact: true}).isDisabled(), true);
    await page.getByRole("checkbox", {name: "选择当前可删除任务", exact: true}).check();
    await page.getByRole("button", {name: "批量删除", exact: true}).click();
    const dialog = page.getByRole("dialog", {name: "批量删除任务记录", exact: true});
    await dialog.waitFor();
    assert.equal(await dialog.getByText(/已选择|确定删除已选择的 2 条/).count() > 0, true);
    await page.screenshot({path: path.join(config.output, "batch-delete-dialog.png"), fullPage: true});
    await dialog.getByRole("button", {name: "删除 2 条", exact: true}).click();
    await page.getByText("已删除 2 条任务记录", {exact: false}).waitFor();
    assert.equal(await page.getByText("可清理 A", {exact: true}).count(), 0);
    assert.equal(await page.getByText("受保护任务", {exact: true}).count(), 1);

    await page.setViewportSize({width: 390, height: 1000});
    await page.goto(config.base + "/admin/tasks");
    await page.getByRole("link", {name: "查看公开状态页", exact: true}).waitFor();
    const width = await page.evaluate(() => ({page: document.documentElement.scrollWidth, view: innerWidth}));
    assert(width.page <= width.view + 1, "mobile page overflow");
    await page.screenshot({path: path.join(config.output, "tasks-mobile-public-link.png"), fullPage: true});
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(JSON.stringify({checks: ["public link", "protected selection", "batch delete", "mobile layout"], errors, output: config.output}, null, 2));
  } finally {
    await browser.close();
  }
}
main().catch(error => {console.error(error.message); process.exitCode = 1;});
