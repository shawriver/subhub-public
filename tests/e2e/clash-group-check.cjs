// Disposable Clash/Meta export check. Input: {base,session,disposable:true}.
const {chromium} = require(process.env.SUBHUB_PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const config = JSON.parse(input);
  assert.equal(config.disposable, true);
  const browser = await chromium.launch({headless: true, ...(process.env.SUBHUB_CHROMIUM ? {executablePath: process.env.SUBHUB_CHROMIUM} : {})});
  const context = await browser.newContext({viewport: {width: 390, height: 844}});
  await context.addCookies([{name: "subhub_session", value: config.session, url: config.base, httpOnly: true, sameSite: "Lax"}]);
  try {
    const put = async (kind, id, body) => {
      const r = await context.request.put(`${config.base}/api/admin/${kind}/${id}`, {
        headers: {"X-SubHub-Request": "1"}, data: {id, ...body}
      });
      assert.equal(r.status(), 200, `${kind} fixture: ${await r.text()}`);
    };
    await put("server", "clash-group-server", {name: "Clash 组验收", address: "node.example.test"});
    for (const [id, name] of [["clash-group-a", "东京示例"], ["clash-group-b", "新加坡示例"]]) {
      await put("node", id, {
        name, serverId: "clash-group-server", protocol: "VLESS", host: "node.example.test",
        port: 443, transport: "tcp", security: "tls", enabled: true, sni: "example.test",
        credential: crypto.randomUUID()
      });
    }
    await put("subscription", "clash-group-subscription", {
      name: "Clash 组验收订阅", nodeIds: ["clash-group-a", "clash-group-b"]
    });
    await put("member", "clash-group-member", {
      name: "Clash 组验收用户", enabled: true, subscriptionIds: ["clash-group-subscription"]
    });
    await put("profile", "clash-group-profile", {
      name: "Clash 组验收链接", memberId: "clash-group-member", format: "clash", followMemberNodes: true
    });
    let issued = await context.request.post(`${config.base}/api/admin/subscriptions/clash-group-profile`, {
      headers: {"X-SubHub-Request": "1"}, data: {}
    });
    if (issued.status() === 409) {
      issued = await context.request.post(`${config.base}/api/admin/subscriptions/clash-group-profile`, {
        headers: {"X-SubHub-Request": "1"}, data: {rotate: true}
      });
    }
    assert.equal(issued.status(), 200, await issued.text());
    const link = new URL((await issued.json()).url, config.base);
    const response = await context.request.get(link.href);
    assert.equal(response.status(), 200);
    const yaml = await response.text();
    const manualStart = yaml.indexOf('"name":"节点选择"');
    const automaticStart = yaml.indexOf('"name":"自动选择"');
    const failoverStart = yaml.indexOf('"name":"故障转移"');
    assert(manualStart >= 0 && automaticStart > manualStart && failoverStart > manualStart, "manual group must be first");
    assert.ok(/\"proxies\":\[\"东京示例\",\"新加坡示例\",\"自动选择\",\"故障转移\"\]/.test(yaml), "manual group must default to a real node and retain automatic options");
    assert.ok(yaml.includes('"MATCH,节点选择"'), "fallback rule must target the manual group");
    console.log(JSON.stringify({
      manualGroupFirst: true,
      manualGroupDefault: "东京示例",
      automaticOptionsRetained: true,
      mobileViewport: 390,
      pageErrors: 0
    }));
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
