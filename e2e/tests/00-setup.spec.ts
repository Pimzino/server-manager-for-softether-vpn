// First-run setup: runs its own fresh management backends so the
// interactive bootstrap path is exercised end to end, then proves it is closed for good.
import { test, expect } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { ARTIFACTS, ROOT, RUN_DIR } from "../env.ts";

test.describe.configure({ mode: "serial" });

const PORT = 18093;
const URL = `http://127.0.0.1:${PORT}`;
const DATA = path.join(RUN_DIR, "setup-data");
const TOKEN_FILE = path.join(DATA, "setup-token.txt");
const SHOTS = path.join(ARTIFACTS, "screenshots");
let proc: ChildProcess | null = null;

async function startBackend(dataDir: string, port: number, extraEnv: Record<string, string> = {}) {
  const p = spawn("node", ["src/main.ts"], {
    cwd: path.join(ROOT, "apps/server"),
    env: { ...process.env, SEM_DATA_DIR: dataDir, SEM_HTTP: "1", SEM_PORT: String(port), SEM_HOST: "127.0.0.1", SEM_LOG_LEVEL: "warn", SEM_LOGIN_RATE_LIMIT: "1000", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  p.stdout!.on("data", (d) => (log += d));
  p.stderr!.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return { p, log: () => log }; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  p.kill("SIGKILL");
  throw new Error(`backend did not start: ${log}`);
}

async function stop(p: ChildProcess | null) {
  if (!p || p.exitCode !== null) return;
  p.kill("SIGTERM");
  await new Promise((r) => { p.once("exit", r); setTimeout(r, 3000); });
}

const post = (base: string, body: unknown) => fetch(`${base}/api/setup`, {
  method: "POST", headers: { "content-type": "application/json", "x-sem-csrf": "1" }, body: JSON.stringify(body),
});

test.afterAll(async () => { await stop(proc); });

test("fresh install: setup required, token logged and stored, wrong token rejected", async () => {
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  const b = await startBackend(DATA, PORT);
  proc = b.p;
  const status = await (await fetch(`${URL}/api/setup/status`)).json();
  expect(status.setupRequired).toBe(true);
  expect(existsSync(TOKEN_FILE)).toBe(true);
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  expect(b.log()).toContain(token);
  // Nothing else works yet: there is no account to sign in with
  const wrong = await post(URL, { setupToken: "not-the-token", username: "root", password: "Str0ng-Passw0rd!x" });
  expect(wrong.status).toBe(403);
  const weak = await post(URL, { setupToken: token, username: "root", password: "short" });
  expect(weak.status).toBe(400);
  expect((await (await fetch(`${URL}/api/setup/status`)).json()).setupRequired).toBe(true);
});

test("setup page creates the first admin and signs them in", async ({ page }) => {
  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  await page.goto(URL);
  await expect(page.getByTestId("setup-page")).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "00-setup.png") });
  await page.getByTestId("setup-token").fill(token);
  await page.getByTestId("setup-username").fill("root");
  await page.getByTestId("setup-display-name").fill("Root Admin");
  await page.getByTestId("setup-password").fill("Setup-Admin-Passw0rd!");
  await page.getByTestId("setup-confirm").fill("Setup-Admin-Passw0rd!");
  await page.getByTestId("setup-submit").click();
  await expect(page.getByTestId("user-menu")).toContainText("Root Admin");
  await expect(page.getByText("Dashboard").first()).toBeVisible();
});

test("after bootstrap: setup is closed for good (API 404, token deleted, UI shows sign-in, survives restart)", async ({ page }) => {
  expect(existsSync(TOKEN_FILE)).toBe(false);
  expect(await (await fetch(`${URL}/api/setup/status`)).json()).toEqual({ setupRequired: false });
  const again = await post(URL, { setupToken: "anything", username: "evil", password: "Evil-Passw0rd!123" });
  expect(again.status).toBe(404);
  // Restart: setup must not reopen and no new token may be generated
  await stop(proc);
  const b = await startBackend(DATA, PORT);
  proc = b.p;
  expect(existsSync(TOKEN_FILE)).toBe(false);
  expect(b.log()).not.toContain("Setup token");
  expect((await post(URL, { setupToken: "anything", username: "evil", password: "Evil-Passw0rd!123" })).status).toBe(404);
  await page.goto(URL);
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.getByTestId("setup-page")).toHaveCount(0);
  // The admin created by setup works
  const login = await fetch(`${URL}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "root", password: "Setup-Admin-Passw0rd!" }),
  });
  expect(login.status).toBe(200);
  const audit = await fetch(`${URL}/api/audit?action=setup.bootstrap`, { headers: { cookie: login.headers.get("set-cookie")!.split(";")[0] } });
  const rows = (await audit.json()).rows;
  expect(rows.some((r: any) => r.success && r.username === "root")).toBe(true);
  expect(rows.some((r: any) => !r.success && r.error === "invalid setup token")).toBe(true);
});

test("concurrent setup requests create exactly one administrator", async () => {
  const dir = path.join(RUN_DIR, "setup-race");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const b = await startBackend(dir, PORT + 1);
  try {
    const token = readFileSync(path.join(dir, "setup-token.txt"), "utf8").trim();
    const base = `http://127.0.0.1:${PORT + 1}`;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      post(base, { setupToken: token, username: `admin${i}`, password: "Race-Admin-Passw0rd!" }).then((r) => r.status)));
    expect(results.filter((s) => s === 201)).toHaveLength(1);
    expect(results.filter((s) => s !== 201).every((s) => s === 404)).toBe(true);
  } finally {
    await stop(b.p);
  }
});

test("no automatic admin: legacy SEM_ADMIN_* variables create nothing", async () => {
  const dir = path.join(RUN_DIR, "setup-noauto");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const port = PORT + 2;
  const b = await startBackend(dir, port, { SEM_ADMIN_USER: "admin", SEM_ADMIN_PASSWORD: "Env-Admin-Passw0rd!" });
  try {
    const base = `http://127.0.0.1:${port}`;
    expect((await (await fetch(`${base}/api/setup/status`)).json()).setupRequired).toBe(true);
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "Env-Admin-Passw0rd!" }),
    });
    expect(login.status).toBe(401);
    expect(b.log()).not.toContain("Env-Admin-Passw0rd!");
  } finally {
    await stop(b.p);
  }
});

test("break-glass CLI: resets existing admins only, never creates accounts", async () => {
  const env = { ...process.env, SEM_DATA_DIR: DATA };
  const cli = (...a: string[]) => execFileSync("node", ["src/cli.ts", ...a], { cwd: path.join(ROOT, "apps/server"), env, encoding: "utf8" });
  expect(cli("status")).toContain("Setup completed.");
  // Unknown user: refused, nothing created
  expect(() => execFileSync("node", ["src/cli.ts", "reset-admin", "nobody"], { cwd: path.join(ROOT, "apps/server"), env, encoding: "utf8", stdio: "pipe" })).toThrow();
  const nobody = await fetch(`${URL}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "nobody", password: "x" }),
  });
  expect(nobody.status).toBe(401);
  // Existing admin from setup: reset works and forces a password change
  const out = cli("reset-admin", "root");
  const pw = out.trim().split("\n").pop()!.trim();
  const login = await fetch(`${URL}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "root", password: pw }),
  });
  expect(login.status).toBe(200);
  expect((await login.json()).user.mustChangePassword).toBe(true);
  expect(await (await fetch(`${URL}/api/setup/status`)).json()).toEqual({ setupRequired: false });
});
