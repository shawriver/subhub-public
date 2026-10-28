// Disposable wallpaper acceptance. Input: {base,session,output,disposable:true,
// wallpaperFile?:path, previewAssets?:true}. No operational actions are taken.
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
  const svg = config.wallpaperFile ? fs.readFileSync(config.wallpaperFile) : Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#587eaf"/><stop offset=".5" stop-color="#a58ba9"/><stop offset="1" stop-color="#1d4a68"/></linearGradient></defs><path fill="url(#g)" d="M0 0h1600v1000H0z"/><path fill="#244361" d="M0 700l400-300 500 400 300-400 400 300v300H0z"/></svg>');
  const wallpaper = "data:image/svg+xml;base64," + svg.toString("base64");
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
  const page = await context.newPage();
  const errors = [], checks = [];
  page.on("pageerror", e => errors.push(e.message));
  async function api(method, route, data) {
    const response = await context.request.fetch(config.base + route, {method, headers: {"X-SubHub-Request": "1"}, ...(data === undefined ? {} : {data})});
    assert(response.ok(), `Fixture request failed: ${response.status()}`);
    return response.json();
  }
  const original = (await api("GET", "/api/admin/appearance")).appearance;
  assert(original, "The disposable preview must have appearance settings");
  async function visit(route, mode, opacity) {
    await page.goto(config.base + route);
    await page.locator(".page, .pub-page").first().waitFor();
    await page.waitForFunction(({mode, opacity}) => document.documentElement.dataset.appearance === mode
      && document.documentElement.dataset.wallpaper === "on"
      && Number(getComputedStyle(document.documentElement).getPropertyValue("--surface-alpha")) === opacity, {mode, opacity});
    await page.evaluate(async () => {
      const image = new Image();
      image.src = JSON.parse(localStorage.getItem("subhub-appearance-v3")).background;
      await image.decode();
    });
  }
  async function checkSurfaces(name, opacity) {
    const values = await page.evaluate(() => {
      const alpha = colour => {
        if (colour === "transparent") return 0;
        const match = colour.match(/^rgba?\(([^)]+)\)$/);
        if (!match) throw new Error("Unexpected computed colour: " + colour);
        const channels = match[1].split(",").map(Number);
        return channels.length === 4 ? channels[3] : 1;
      };
      const visible = element => element.getClientRects().length > 0;
      const query = selector => [...document.querySelectorAll(selector)].filter(visible).map(element => ({
        element: element.className || element.tagName,
        alpha: alpha(getComputedStyle(element).backgroundColor),
        filter: getComputedStyle(element).backdropFilter
      }));
      return {
        width: innerWidth, scroll: document.documentElement.scrollWidth,
        main: query(".page .ribbon > div, .page .glass:not(.ribbon):not(.glass-strong), .pub-machine"),
        wrapper: query(".page .glass.ribbon"),
        table: query(".srv-table, .sv2-table tbody tr, .nd-table tbody tr"),
        inset: query(".subscription-card, .mini-meters, .mb-quota, .srv-table th"),
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(d => ({width: d.getBoundingClientRect().width, scroll: d.scrollWidth}))
      };
    });
    assert(values.scroll <= values.width + 1, name + " page overflows");
    assert(values.dialogs.every(d => d.scroll <= d.width + 1), name + " dialog overflows");
    for (const surface of values.main) assert(Math.abs(surface.alpha - opacity / 100) < .005, `${name}: ${surface.element} ignores opacity (${surface.alpha})`);
    for (const surface of values.main) assert.equal(surface.filter, "none", `${name}: ${surface.element} blurs the wallpaper`);
    for (const surface of values.wrapper) assert.equal(surface.alpha, 0, `${name}: the summary wrapper adds a second surface`);
    for (const surface of values.table) assert.equal(surface.alpha, 0, `${name}: table adds an opaque background`);
    for (const surface of values.inset) assert(surface.alpha <= opacity / 100 * .31, `${name}: inset panel obscures wallpaper (${surface.alpha})`);
  }
  try {
    for (const mode of ["dark", "light"]) {
      for (const opacity of [30, 70, 100]) {
        await api("POST", "/api/admin/appearance", {...original, appearance: mode, background: wallpaper, surfaceOpacity: opacity});
        for (const width of [1440, 390, 360]) {
          await page.setViewportSize({width, height: 1000});
          for (const route of ["", "/servers", "/nodes", "/subscriptions", "/members", "/tasks", "/settings#appearance"]) {
            const name = `${mode}-${opacity}-${width}-${route.replace(/[\/#]/g, "-") || "overview"}`;
            await visit("/admin" + route, mode, opacity);
            await checkSurfaces(name, opacity);
            if (width === 1440 || (width === 390 && opacity === 30)) {
              await page.screenshot({path: path.join(config.output, name + ".png"), fullPage: true});
            }
            if (route === "/subscriptions") {
              for (const category of ["个人订阅", "分流模板", "订阅"]) {
                await page.getByRole("group", {name: "订阅分类", exact: true}).getByRole("button", {name: category, exact: true}).click();
                await checkSurfaces(name + "-" + category, opacity);
              }
            }
            if (route === "/settings#appearance") {
              for (const title of ["公开页面", "服务接入", "面板同步", "账户安全", "外观与品牌"]) {
                await page.getByRole("navigation", {name: "设置分类"}).getByRole("button", {name: title, exact: true}).click();
                await page.locator(".settings-section-intro").getByRole("heading", {name: title, exact: true}).waitFor();
                await checkSurfaces(name + "-" + title, opacity);
              }
            }
          }
          await visit("/status", mode, opacity);
          await checkSurfaces(`${mode}-${opacity}-${width}-public`, opacity);
        }
      }
    }
    checks.push("seven admin pages, all subscription/settings categories and public page use 30/70/100% wallpaper surfaces in both themes at three widths");
    checks.push("summary wrapper and tables do not stack extra backgrounds; inset surfaces stay translucent");
    await page.setViewportSize({width: 390, height: 1000});
    await visit("/admin/settings#appearance", "light", 100);
    const saved = page.waitForResponse(r => r.url().endsWith("/api/admin/appearance") && r.request().method() === "POST");
    await page.getByRole("slider").fill("30");
    assert.equal((await saved).status(), 200);
    await page.reload();
    assert.equal(await page.getByRole("slider").inputValue(), "30");
    await checkSurfaces("settings-slider-reload", 30);
    const clear = page.waitForResponse(r => r.url().endsWith("/api/admin/appearance") && r.request().method() === "POST");
    await page.getByPlaceholder("留空使用纯色背景", {exact: true}).fill("");
    assert.equal((await clear).status(), 200);
    await page.waitForFunction(() => !document.documentElement.dataset.wallpaper);
    assert.equal(await page.getByRole("slider").isDisabled(), true);
    await page.setViewportSize({width: 1440, height: 1000});
    await page.goto(config.base + "/admin/servers");
    await page.locator(".sv2-table").waitFor();
    await page.waitForFunction(() => !document.documentElement.dataset.wallpaper);
    const solid = await page.locator(".sv2-table").evaluate(table => getComputedStyle(table).backgroundColor);
    assert(!solid.startsWith("rgba") && solid !== "transparent", "Removing wallpaper must restore the solid table");
    checks.push("slider saves and reloads; clearing wallpaper restores the solid layout");
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(JSON.stringify({checks, errors, output: config.output}, null, 2));
  } finally {
    await api("POST", "/api/admin/appearance", original);
    await browser.close();
  }
}
main().catch(e => {console.error(e); process.exitCode = 1;});
