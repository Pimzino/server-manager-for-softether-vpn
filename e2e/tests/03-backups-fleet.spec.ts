import { test, expect } from "@playwright/test";
import { Api, adminApi, eventually, seRpc } from "../helpers.ts";
import { SERVERS } from "../env.ts";

test.describe.configure({ mode: "serial" });
const [ALPHA] = SERVERS;

test("config backup, diff against live, restore via SetConfig", async () => {
  const api = await adminApi();
  const alpha = (await api.get("/api/servers")).find((s: any) => s.name === ALPHA.name).id;
  const b1 = await api.post(`/api/servers/${alpha}/backups`, { note: "before change" }, 201);
  await api.rpc(alpha, "CreateHub", { HubName_str: "TEMP_AFTER_BACKUP", Online_bool: true });

  const diff = await api.get(`/api/servers/${alpha}/backups/${b1.id}/diff?other=live`);
  expect(diff.changed).toBeGreaterThan(0);
  expect(diff.lines.some((l: any) => l.type === "add" && l.text.includes("TEMP_AFTER_BACKUP"))).toBe(true);

  const wrongConfirm = await api.call("POST", `/api/servers/${alpha}/backups/${b1.id}/restore`, { confirm: "nope" });
  expect(wrongConfirm.status).toBe(400);
  await api.post(`/api/servers/${alpha}/backups/${b1.id}/restore`, { confirm: ALPHA.name });
  // Server restarts with the old config: the hub created after the backup is gone
  await eventually(async () => {
    const hubs = await seRpc(ALPHA.port, "", "EnumHub");
    return !hubs.HubList.some((h: any) => h.HubName_str === "TEMP_AFTER_BACKUP") && hubs.HubList.some((h: any) => h.HubName_str === "HQ");
  }, 60_000, 1000);
  const list = await api.get(`/api/servers/${alpha}/backups`);
  expect(list.some((b: any) => /Automatic snapshot before restoring/.test(b.note))).toBe(true);
  const dl = await api.call("GET", `/api/servers/${alpha}/backups/${b1.id}?download=1`);
  expect(dl.headers["content-disposition"]).toContain(".config");
  expect(dl.text).toContain("declare root");
});

test("fleet: summary, bulk RPC across servers, Prometheus metrics with API token", async () => {
  const api = await adminApi();
  const servers = await api.get("/api/servers");
  await eventually(async () => {
    const s = await api.get("/api/fleet/summary");
    return s.totals.online === 2 ? s : null;
  }, 30_000);
  const summary = await api.get("/api/fleet/summary");
  expect(summary.totals.servers).toBe(2);

  // Same hub + user on every server in one call
  const all = servers.map((s: any) => s.id);
  const hubRes = await api.post("/api/fleet/rpc", { method: "CreateHub", params: { HubName_str: "FLEET", Online_bool: true }, serverIds: all });
  expect(hubRes.results.every((r: any) => r.ok)).toBe(true);
  const userRes = await api.post("/api/fleet/rpc", { method: "CreateUser", params: { HubName_str: "FLEET", Name_str: "roaming", AuthType_u32: 1, Auth_Password_str: "Roam-Passw0rd!" }, serverIds: all });
  expect(userRes.results.every((r: any) => r.ok)).toBe(true);
  const audit = await api.get("/api/audit?action=bulk.CreateUser");
  expect(audit.total).toBe(2);

  const tok = await api.post("/api/me/tokens", { name: "prometheus", expiresInDays: 30 }, 201);
  const bearer = new Api();
  bearer.bearer = tok.token;
  // metrics are served from the poller's cache (5 s interval in E2E)
  const metrics = await eventually(async () => {
    const m = await bearer.call("GET", "/metrics");
    return m.status === 200 && m.text.includes('hub="FLEET"') ? m : null;
  }, 30_000);
  expect(metrics.text).toContain('softether_up{server="e2e-alpha"} 1');
  expect(metrics.text).toMatch(/softether_hub_online\{server="e2e-beta",hub="FLEET"\} 1/);
  // Tokens can't mint tokens
  expect((await bearer.call("POST", "/api/me/tokens", { name: "x", expiresInDays: 1 })).status).toBe(403);
  await api.del(`/api/me/tokens/${tok.id}`);
  expect((await bearer.call("GET", "/metrics")).status).toBe(401);
});
