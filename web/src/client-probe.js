const SAMPLE_COUNT = 3;
const SAMPLE_TIMEOUT_MS = 2200;

function isUDP(node) {
  return String(node?.protocol || "").toLowerCase() === "hysteria2" || String(node?.transport || "").toLowerCase() === "udp";
}
function endpointFor(node, nodes) {
  if (!isUDP(node)) return { endpoint: node, via: "direct" };
  const endpoint = (nodes || []).find(candidate => candidate.enabled && candidate.serverId === node.serverId && !isUDP(candidate));
  return endpoint ? { endpoint, via: "server-tcp" } : null;
}

function probeURL(endpoint) {
  const host = endpoint.host || "";
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = Number(endpoint.externalPort || endpoint.port || 443);
  return `https://${normalizedHost}:${port}/?__subhub_client_probe=${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function oneSample(url) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SAMPLE_TIMEOUT_MS);
  try {
    await fetch(url, {
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: controller.signal
    });
    return Math.max(1, Math.round(performance.now() - started));
  } catch (error) {
    if (controller.signal.aborted) throw new Error("连接超时");
    const elapsed = Math.round(performance.now() - started);
    if (elapsed < 2) throw new Error(error?.message || "浏览器无法发起连接");
    return elapsed;
  } finally {
    clearTimeout(timer);
  }
}

export async function measureClientLatency(node, nodes) {
  const target = endpointFor(node, nodes);
  if (!target) throw new Error("该 UDP 节点没有可用于浏览器测速的同服务器 TCP 入口");
  if (!target.endpoint.host || !target.endpoint.port) throw new Error("节点缺少可测速的服务器地址或端口");
  const url = probeURL(target.endpoint);
  const samples = [];
  for (let i = 0; i < SAMPLE_COUNT; i += 1) samples.push(await oneSample(url + `&sample=${i + 1}`));
  samples.sort((a, b) => a - b);
  return {
    latencyMs: samples[Math.floor(samples.length / 2)],
    measuresMs: samples,
    method: target.via,
    checkedAt: new Date().toISOString(),
    sampleCount: samples.length
  };
}
