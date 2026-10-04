// Runs last: freezes a real SoftEther server to verify down/up detection, audit and webhook alerts.
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { adminApi, eventually } from "../helpers.ts";
import { RUN_DIR, SERVERS } from "../env.ts";

test("server down/up is detected, audited and sent to the alert webhook", async () => {
  test.setTimeout(150_000);
  const received: any[] = [];
  const hook = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => { try { received.push(JSON.parse(body)); } catch { /* not ours */ } res.end("ok"); });
  });
  await new Promise<void>((r) => hook.listen(18097, "127.0.0.1", r));
  try {
    const api = await adminApi();
    await api.put("/api/settings", { alerts: { enabled: true, webhookUrl: "http://127.0.0.1:18097/hook" } });
    // Process groups: [alpha, beta, client, backend] in start order
    const pids = JSON.parse(readFileSync(path.join(RUN_DIR, "pids.json"), "utf8")) as number[];
    const betaPgid = pids[1];
    process.kill(-betaPgid, "SIGSTOP");
    try {
      await eventually(async () => received.find((e) => e.event === "server.down" && e.server.name === SERVERS[1].name), 90_000, 1000);
    } finally {
      process.kill(-betaPgid, "SIGCONT");
    }
    await eventually(async () => received.find((e) => e.event === "server.up" && e.server.name === SERVERS[1].name), 60_000, 1000);
    const audit = await api.get(`/api/audit?action=server.`);
    expect(audit.rows.some((r: any) => r.action === "server.down" && r.server_name === SERVERS[1].name)).toBe(true);
    expect(audit.rows.some((r: any) => r.action === "server.up" && r.server_name === SERVERS[1].name)).toBe(true);
    expect(received.find((e) => e.event === "server.down").text).toContain("is DOWN");
  } finally {
    hook.close();
  }
});
