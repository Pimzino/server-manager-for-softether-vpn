import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHmac } from "node:crypto";
import { Agent, request } from "undici";
import { expect, type Page } from "@playwright/test";
import { ADMIN, BASE_URL, CLIENT_DIR } from "./env.ts";

const run = promisify(execFile);
const insecure = new Agent({ connect: { rejectUnauthorized: false } });

/**
 * Talk to a SoftEther server directly (independent oracle, bypassing the manager).
 * Returns the result object, or throws with the SoftEther error.
 */
export async function seRpc(port: number, password: string, method: string, params: Record<string, unknown> = {}, hub = "") {
  const res = await request(`https://127.0.0.1:${port}/api/`, {
    method: "POST",
    dispatcher: insecure,
    headers: { authorization: `Basic ${Buffer.from(`${hub || "administrator"}:${password}`).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
  });
  const json = (await res.body.json()) as { result?: Record<string, any>; error?: { code: number; message: string } };
  if (json.error) throw new Error(`SoftEther ${method} error ${json.error.code}: ${json.error.message}`);
  return json.result!;
}

/** Minimal REST client for the manager backend with cookie session. */
export class Api {
  cookie = "";
  bearer = "";
  async call<T = any>(method: string, path: string, body?: unknown, expectStatus?: number): Promise<{ status: number; body: T; text: string; headers: Record<string, string> }> {
    const res = await fetch(BASE_URL + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
        "x-sem-csrf": "1",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* text body */ }
    if (expectStatus !== undefined && res.status !== expectStatus) {
      throw new Error(`${method} ${path} -> ${res.status} (expected ${expectStatus}): ${text.slice(0, 500)}`);
    }
    return { status: res.status, body: parsed as T, text, headers: Object.fromEntries(res.headers) };
  }
  get<T = any>(p: string, s = 200) { return this.call<T>("GET", p, undefined, s).then((r) => r.body); }
  post<T = any>(p: string, b: unknown = {}, s = 200) { return this.call<T>("POST", p, b, s).then((r) => r.body); }
  put<T = any>(p: string, b: unknown, s = 200) { return this.call<T>("PUT", p, b, s).then((r) => r.body); }
  del<T = any>(p: string, s = 200) { return this.call<T>("DELETE", p, undefined, s).then((r) => r.body); }
  rpc<T = any>(serverId: number, method: string, params: Record<string, unknown> = {}, s = 200) {
    return this.post<T>(`/api/servers/${serverId}/rpc/${method}`, params, s);
  }
  async login(username = ADMIN.username, password = ADMIN.password) {
    await this.post("/api/auth/login", { username, password });
    return this;
  }
}

export async function adminApi() {
  return new Api().login();
}

export async function uiLogin(page: Page, username = ADMIN.username, password = ADMIN.password) {
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.locator("input[autocomplete=current-password]").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("user-menu")).toBeVisible();
}

/** Run vpncmd against the local SoftEther VPN Client. */
export async function vpncmdClient(...args: string[]) {
  try {
    const r = await run("./vpncmd", ["localhost", "/CLIENT", "/CMD", ...args], {
      cwd: CLIENT_DIR, env: { ...process.env, DYLD_LIBRARY_PATH: ".", LD_LIBRARY_PATH: "." }, timeout: 30_000,
    });
    return { code: 0, out: r.stdout };
  } catch (e) {
    const err = e as { code?: number; stdout?: string };
    return { code: err.code ?? -1, out: err.stdout ?? "" };
  }
}

export async function sh(cmd: string, args: string[], cwd?: string) {
  const r = await run(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return r.stdout;
}

export function totp(secretB32: string, t = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of secretB32.replace(/=+$/, "")) {
    value = (value << 5) | alphabet.indexOf(ch); bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac("sha1", Buffer.from(bytes)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0");
}

/** Poll until fn returns truthy. */
export async function eventually<T>(fn: () => Promise<T>, timeoutMs = 20_000, intervalMs = 500): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`eventually() timed out${last ? `: ${(last as Error).message}` : ""}`);
}
