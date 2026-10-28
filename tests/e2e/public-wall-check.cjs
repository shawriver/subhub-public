// Disposable public-wall acceptance. Input: {base,session,output,disposable:true,
// previewAssets?:true,wallpaperFile?:path}. Synthetic status payload only; no
// panel or probe action.
const {chromium} = require(process.env.SUBHUB_PLAYWRIGHT_MODULE || "C:/Users/15241/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function machine(name, region, flag, status, cpu, memory, disk, up, down, totalUp, totalDown, limit, used) {
  return {name, region, flag, status, updated: new Date().toISOString(), cpu, memory, disk, up, down, totalUp, totalDown, trafficLimit: limit, trafficUsed: used};
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input);
  assert.equal(config.disposable, true);
  fs.mkdirSync(config.output, {recursive: true});
  const browser = await chromium.launch({headless: true, ...(process.env.SUBHUB_CHROMIUM ? {executablePath: process.env.SUBHUB_CHROMIUM} : {})});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, reducedMotion: "reduce"});
  await context.addCookies([{name: "subhub_session", value: config.session, url: config.base, httpOnly: true, sameSite: "Lax"}]);
  if (config.previewAssets) {
    for (const name of ["app.js", "app.css"]) {
      await context.route("**/" + name + "*", route => route.fulfill({
        path: path.join(__dirname, "..", "..", "web/dist", name),
        contentType: name.endsWith(".js") ? "text/javascript" : "text/css"
      }));
    }
  }
  const machines = [
    machine("Fremont", "US", "", "online", 18, 40, 30, 168_000, 71_000, 223e9, 231e9, 2e12, 342e9),
    machine("Hong Kong", "HK", "", "online", 48, 73, 55, 91_000, 55_000, 118e9, 96e9, 700e9, 396e9),
    machine("Tokyo", "JP", "", "online", 75, 30, 41, 45_000, 122_000, 76e9, 65e9, 4e12, 3.83e12),
    machine("Singapore", "SG", "", "stale", 22, 51, 44, null, null, null, null, 1.98e12, 24.1e9),
    machine("Taipei", "TW", "", "online", 9, 24, 19, 12_000, 33_000, 41e9, 38e9, 900e9, 120e9),
    machine("Frankfurt", "DE", "", "unknown", null, null, null, null, null, null, null, 0, null)
  ];
  const page = await context.newPage();
  const errors = [], checks = [];
  page.on("pageerror", e => errors.push(e.message));
  const forbidden = ["连接", "在线时长", "到期", "价格", "资产"];
  async function layout(name, screenshot = false) {
    const sizes = await page.evaluate(() => ({width: innerWidth, scroll: document.documentElement.scrollWidth,
      cards: [...document.querySelectorAll(".pub-wall-card")].map(card => ({width: card.getBoundingClientRect().width, scroll: card.scrollWidth}))}));
    assert(sizes.scroll <= sizes.width + 1, `Overflow: ${name}`);
    assert(sizes.cards.every(card => card.scroll <= card.width + 2), `Card overflow: ${name}`);
    if (screenshot) await page.screenshot({path: path.join(config.output, name + ".png"), fullPage: true});
  }
  async function settings(mode) {
    const current = await (await context.request.get(config.base + "/api/admin/appearance")).json();
    const next = {...current.appearance, appearance: mode};
    const saved = await context.request.post(config.base + "/api/admin/appearance", {headers: {"X-SubHub-Request": "1"}, data: next});
    assert.equal(saved.status(), 200);
    return current.appearance;
  }
  const original = (await (await context.request.get(config.base + "/api/admin/appearance")).json()).appearance || {
    appearance: "dark",
    accent: "#3b82f6",
    background: "/wallpaper.jpg",
    surfaceOpacity: 45,
    brandName: "SubHub",
    brandSub: "PRIVATE NETWORK",
    workspace: "My Network",
    logoUrl: ""
  };
  const wallpaper = config.wallpaperFile
    ? "data:image/svg+xml;base64," + fs.readFileSync(config.wallpaperFile).toString("base64")
    : "/wallpaper.jpg";
  try {
    const wallpaperSaved = await context.request.post(config.base + "/api/admin/appearance", {
      headers: {"X-SubHub-Request": "1"},
      data: {...original, background: wallpaper}
    });
    assert.equal(wallpaperSaved.status(), 200);
    for (const mode of ["light", "dark"]) {
      await settings(mode);
      for (const width of [1440, 1024, 768, 390, 360]) {
        await page.setViewportSize({width, height: 1000});
        await page.route("**/api/public/status", route => route.fulfill({status: 200, contentType: "application/json",
          body: JSON.stringify({machines, updatedAt: new Date().toISOString(), refreshSeconds: 5, monitorAvailable: true,
            komariUrl: "https://komari.example.test", disabled: false})}));
        await page.goto(config.base + "/status");
        await page.locator(".pub-band").waitFor();
        await layout(`${mode}-${width}-public-wall`, [1440, 390].includes(width));
        assert.equal(await page.locator(".pub-band-cell").count(), 4);
        assert.equal(await page.locator(".pub-wall-card").count(), 6);
        assert.equal(await page.getByRole("group", {name: "地区筛选"}).getByRole("button").count(), 7);
        const text = await page.locator(".pub-page").innerText();
        for (const word of forbidden) assert(!text.includes(word), `Public wall must not render "${word}"`);
        const quota = page.locator(".pub-wall-card").filter({hasText: "Fremont"}).locator(".pub-wall-quota");
        assert.match(await quota.innerText(), /已用流量\s+342\.00 GB \/ 2\.00 TB/);
        assert.doesNotMatch(await quota.innerText(), /剩余流量/);
        await page.getByRole("group", {name: "地区筛选"}).getByRole("button", {name: /JP/}).click();
        await page.waitForFunction(() => document.querySelectorAll(".pub-wall-card").length === 1);
        assert.equal(await page.locator(".pub-wall-card").getAttribute("aria-label"), "服务器 Tokyo");
        await layout(`${mode}-${width}-public-wall-filtered`);
        await page.getByRole("group", {name: "地区筛选"}).getByRole("button", {name: /全部/}).click();
        await page.waitForFunction(() => document.querySelectorAll(".pub-wall-card").length === 6);
        assert.equal(await page.locator(".pub-live-chart").count(), 1);
        assert.equal(await page.locator(".pub-band-value").first().innerText(), "4 / 6");
      }
    }
    checks.push("public wall keeps four summary cells, six region buttons and per-region filtering in both themes at five widths");

    // Bandwidth history accumulates from real polls only.
    await page.setViewportSize({width: 1440, height: 1000});
    await page.goto(config.base + "/status");
    await page.locator(".pub-live-chart").waitFor();
    const first = await page.locator(".pub-live-line-down").getAttribute("d");
    await page.getByRole("button", {name: "刷新"}).count();
    await page.waitForTimeout(5200);
    const second = await page.locator(".pub-live-line-down").getAttribute("d");
    assert.notEqual(first, second, "The live chart must grow as polls arrive");
    checks.push("live bandwidth chart draws a real polled series rather than decorative art");

    await page.route("**/api/public/status", route => route.fulfill({status: 200, contentType: "application/json",
      body: JSON.stringify({machines, updatedAt: new Date().toISOString(), refreshSeconds: 5, monitorAvailable: true,
        komariUrl: "https://komari.example.test", disabled: false})}));
    for (const mode of ["dark", "light"]) {
      const current = await (await context.request.get(config.base + "/api/admin/appearance")).json();
      const saved = await context.request.post(config.base + "/api/admin/appearance", {headers: {"X-SubHub-Request": "1"},
        data: {...current.appearance, appearance: mode, background: wallpaper}});
      assert.equal(saved.status(), 200);
      for (const width of [1440, 390]) {
        await page.setViewportSize({width, height: 1000});
        await page.goto(config.base + "/status");
        await page.locator(".pub-band").waitFor();
        if (wallpaper) {
          await page.waitForFunction(() => document.documentElement.dataset.wallpaper === "on");
          await page.evaluate(async () => {
            const image = new Image();
            image.src = JSON.parse(localStorage.getItem("subhub-appearance-v3")).background;
            await image.decode();
          });
        }
        await layout(`${mode}-${width}-public-wall-wallpaper`, true);
        const publicGlass = await page.evaluate(() => [...document.querySelectorAll(".pub-band, .pub-wall-card, .pub-filters")]
          .map(element => ({filter: getComputedStyle(element).backdropFilter, alpha: getComputedStyle(element).backgroundColor})));
        assert(publicGlass.every(surface => surface.filter === "none"), "Public cards must preserve the wallpaper texture");
        assert(publicGlass.every(surface => /^rgba?\(/.test(surface.alpha) && Number(surface.alpha.match(/[\d.]+/g)[3]) < .8),
          "Public cards must use the saved translucent surface");
        const cardShadow = await page.locator(".pub-wall-card").first().evaluate(element => getComputedStyle(element).boxShadow);
        assert(cardShadow.includes("inset") && !/0px 6px 24px/.test(cardShadow),
          "Public cards should use the LuminaPlus inset highlight without an outer shadow");
        if (wallpaper && mode === "light" && width === 1440) {
          const contrast = await page.locator(".pub-page-wall .pub-band-label").first().evaluate(element => {
            const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
            const luminance = value => rgb(value).map(v => v / 255)
              .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
              .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
            const fg = luminance(getComputedStyle(element).color);
            const bg = luminance(getComputedStyle(document.querySelector(".pub-band")).backgroundColor);
            return (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05);
          });
          assert(contrast >= 4.5, `Public wall light-theme labels below 4.5:1: ${contrast}`);
        }
      }
    }
    checks.push("public wall renders in both themes with the selected wallpaper on desktop and mobile");

    await settings("dark");
    await page.route("**/api/public/status", route => route.fulfill({status: 200, contentType: "application/json",
      body: JSON.stringify({machines: machines.map(m => ({...m, status: "stale", cpu: null, memory: null, disk: null,
        up: null, down: null, totalUp: null, totalDown: null, trafficUsed: null})), refreshSeconds: 5, komariUrl: "", disabled: false})}));
    await page.goto(config.base + "/status");
    await page.locator(".pub-band").waitFor();
    await page.waitForTimeout(5200);
    await page.locator(".pub-band").waitFor();
    assert.equal(await page.locator(".pub-wall-card").count(), 6);
    checks.push("stale machines with no metrics keep the public wall stable across polls");

    await page.route("**/api/public/status", route => route.fulfill({status: 200, contentType: "application/json",
      body: JSON.stringify({machines: [], refreshSeconds: 5, komariUrl: "", disabled: false})}));
    await page.goto(config.base + "/status");
    await page.getByText("暂无服务器记录。", {exact: true}).waitFor();
    await layout("public-wall-empty");
    checks.push("empty status payload shows the empty state without breaking the summary band");
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(JSON.stringify({checks, errors, output: config.output}, null, 2));
  } finally {
    await context.request.post(config.base + "/api/admin/appearance", {headers: {"X-SubHub-Request": "1"}, data: original});
    await browser.close();
  }
}
main().catch(e => {console.error(e); process.exitCode = 1;});
