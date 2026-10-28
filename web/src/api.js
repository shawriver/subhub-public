// Thin fetch wrapper matching the backend contract:
// - session cookie travels with every request (same-origin)
// - writes carry the X-SubHub-Request marker header the API expects
// - errors surface the server's {error} message; an expired admin session
//   is broadcast so the shell can drop back to the login screen.
export async function api(path, options = {}) {
  const init = { credentials: "same-origin", ...options };
  const headers = { ...(options.headers || {}) };
  if (options.body) headers["Content-Type"] = "application/json";
  if (options.method && options.method !== "GET") headers["X-SubHub-Request"] = "1";
  init.headers = headers;
  const response = await fetch(path, init);
  if (response.status === 401 && path.startsWith("/api/admin/")) {
    window.dispatchEvent(new Event("subhub-session-expired"));
  }
  if (!response.ok) {
    let message = "请求失败，请稍后重试";
    try { message = (await response.json()).error || message; } catch { /* keep default */ }
    throw new Error(message);
  }
  const type = response.headers.get("content-type") || "";
  return type.includes("json") ? response.json() : response.text();
}

export const getStatus = () => api("/api/status");
export const getSession = () => api("/api/session");
export const getOverview = () => api("/api/admin/overview");
export const login = body => api("/api/login", { method: "POST", body: JSON.stringify(body) });
export const logout = () => api("/api/logout", { method: "POST" });
export const setupAdmin = body => api("/api/setup", { method: "POST", body: JSON.stringify(body) });

/* ---- M2: records & feature endpoints (contracts verified against the
   Go handlers in server.go / protocol.go / templates.go / fetch_audit.go /
   account.go / backup.go / panel.go / komari.go / public.go). ---- */

export function newRecordId() {
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"[b % 64]).join("");
}

/* Generic record CRUD: PUT/DELETE /api/admin/<kind>/<id>.
   kinds: server | node | member | profile | subscription | task */
export const saveRecord = (kind, id, body) => api(`/api/admin/${kind}/${id}`, { method: "PUT", body: JSON.stringify(body) });
export const deleteRecord = (kind, id) => api(`/api/admin/${kind}/${id}`, { method: "DELETE" });
export const deleteTaskRecords = ids => api("/api/admin/tasks/batch-delete", { method: "POST", body: JSON.stringify({ ids }) });

/* Node latency tests use a bounded TCP/ICMP batch endpoint. */
export const testNodeLatencies = nodeIds => api("/api/admin/nodes/latency", { method: "POST", body: JSON.stringify({ nodeIds }) });
export const testNode = (id, body) => api(`/api/admin/nodes/${id}/test`, { method: "POST", body: JSON.stringify(body) });
export const getNodeTest = id => api(`/api/admin/nodes/${id}/test`);
export const cancelNodeTest = (id, runId) => api(`/api/admin/nodes/${id}/test`, { method: "DELETE", body: JSON.stringify({ runId }) });
export const getTestHistory = node => api(`/api/admin/node-test-history${node ? `?node=${encodeURIComponent(node)}` : ""}`);

/* Node import: {serverId, content} → {nodes[], errors[{line,message}], skipped} */
export const importPreview = body => api("/api/admin/nodes/import/preview", { method: "POST", body: JSON.stringify(body) });
export const importNodes = body => api("/api/admin/nodes/import", { method: "POST", body: JSON.stringify(body) });

/* Rule templates: GET list; PUT/DELETE /api/admin/rule-templates/<id> (custom only) */
export const getRuleTemplates = () => api("/api/admin/rule-templates");
export const saveRuleTemplate = (id, body) => api(`/api/admin/rule-templates/${id}`, { method: "PUT", body: JSON.stringify(body) });
export const deleteRuleTemplate = id => api(`/api/admin/rule-templates/${id}`, { method: "DELETE" });

/* Subscription profiles: preview renders config (contains the DNS section for
   clash formats); issue returns {url, portalUrl, warning} once; revoke kills tokens. */
export const previewProfile = (id, format) => api(`/api/admin/preview/${id}${format ? `?format=${encodeURIComponent(format)}` : ""}`);
export const issueSubscription = (id, body) => api(`/api/admin/subscriptions/${id}`, { method: "POST", body: JSON.stringify(body || {}) });
export const revokeSubscription = id => api(`/api/admin/subscriptions/${id}/revoke`, { method: "POST" });
export const assignPackageMembers = (id, memberIds) => api(`/api/admin/subscriptions/${id}/members`, { method: "POST", body: JSON.stringify({memberIds}) });

/* Fetch audit: list (30d, ≤100, flags[] may carry high_freq) and the devices
   view (recognized client families inside the billing window; proxy IP changes
   are summarized but do not identify additional devices). */
export const getFetches = member => api(`/api/admin/subscription-fetches${member ? `?member=${encodeURIComponent(member)}` : ""}`);
export const getDevices = member => api(`/api/admin/subscription-fetches?view=devices&member=${encodeURIComponent(member)}`);

/* Security & account: GET /api/admin/security → {totpEnabled, backupSchedule,
   backupFiles[], backups[{name, createdAt, size, status, detail, counts}]}.
   POST /api/admin/security/<password|totp/start|totp/enable|totp/disable>
   body {password, code?, newPassword?}; success may return {loginRequired:true}. */
export const getSecurity = () => api("/api/admin/security");
export const securityAction = (action, body) => api(`/api/admin/security/${action}`, { method: "POST", body: JSON.stringify(body) });

/* Backup: POST /api/admin/backup/<now|export|preview|restore>
   body {password, code?, passphrase?, content?, confirm?, digest?}.
   export → {content, filename}; preview → {created, counts, digest}. */
export const backupAction = (action, body) => api(`/api/admin/backup/${action}`, { method: "POST", body: JSON.stringify(body) });

export const getAudit = () => api("/api/admin/audit");

/* Sync: GET sync-settings → {observeMode, lastRound, lastRoundAt};
   POST sync-settings {observeMode}; POST sync → 202 {queued}. */
export const getSyncSettings = () => api("/api/admin/sync-settings");
export const setObserveMode = observeMode => api("/api/admin/sync-settings", { method: "POST", body: JSON.stringify({ observeMode }) });
export const triggerSync = () => api("/api/admin/sync", { method: "POST" });

/* Komari bind: POST /api/admin/komari/bind {serverId, uuid} (uuid "" unbinds). */
export const bindKomari = body => api("/api/admin/komari/bind", { method: "POST", body: JSON.stringify(body) });

/* Public member portal: GET /api/public/member/<token> → PublicMember
   {name, profile, status, usedGb, lifetimeUsedGb, limitGb, expires,
    resetDay, cycleEnd, availableNodes, connectionLimit, connectionLimitSource,
    updated}. Client-family estimates stay administrator-only. */
export const getPublicMember = token => api(`/api/public/member/${encodeURIComponent(token)}`);

/* Public status page: GET /api/public/status → {machines[], updatedAt,
   refreshSeconds, monitorAvailable, komariUrl, disabled} (404 with
   「已关闭」 when the owner disabled the page). Admin settings:
   GET/POST /api/admin/public-settings → {enabled, komariUrl}. */
export const getPublicStatus = () => api("/api/public/status");
export const getPublicSettings = () => api("/api/admin/public-settings");
export const savePublicSettings = body => api("/api/admin/public-settings", { method: "POST", body: JSON.stringify(body) });
