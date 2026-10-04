// Throwaway SoftEther VPN Server for the native-transport verification (own run dir, single listener).
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

export const SE_BUILD = process.env.SE_BUILD_DIR ?? path.join(os.homedir(), "se-build/src/build");
export const RUN_DIR = process.env.VERIFY_NATIVE_RUN_DIR ?? path.join(os.homedir(), "se-desk-native");
export const PORT = Number(process.env.VERIFY_NATIVE_PORT ?? 15701);
const PID_FILE = path.join(RUN_DIR, "pids.json");

let pgid: number | null = null;

function killGroup(pid: number) {
  try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
}

/** Kill leftovers of an interrupted earlier run (they would hold the port). */
export function killLeftovers() {
  if (!existsSync(PID_FILE)) return;
  for (const pid of JSON.parse(readFileSync(PID_FILE, "utf8")) as number[]) killGroup(pid);
}

export function prepareRunDir() {
  killLeftovers();
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  for (const f of ["vpnserver", "hamcore.se2", "libcedar.dylib", "libmayaqua.dylib", "libcedar.so", "libmayaqua.so"]) {
    const src = path.join(SE_BUILD, f);
    if (existsSync(src)) copyFileSync(src, path.join(RUN_DIR, f));
  }
  if (!existsSync(path.join(RUN_DIR, "vpnserver"))) throw new Error(`vpnserver not found in ${SE_BUILD}`);
  // The minimal config of e2e/global-setup.ts: one listener on our port, no UDP ports
  writeFileSync(path.join(RUN_DIR, "vpn_server.config"), [
    "# Software Configuration File", "declare root", "{",
    "\tdeclare ListenerList", "\t{", "\t\tdeclare Listener0", "\t\t{",
    "\t\t\tbool DisableDos false", "\t\t\tbool Enabled true", `\t\t\tuint Port ${PORT}`, "\t\t}", "\t}",
    "\tdeclare ServerConfiguration", "\t{", "\t\tstring PortsUDP $", "\t}", "}", "",
  ].join("\n"));
}

/** `./vpnserver execsvc` in its own process group (it forks a supervisor + worker). */
export function startServer() {
  const out = openSync(path.join(RUN_DIR, "vpnserver.log"), "a");
  const p = spawn("./vpnserver", ["execsvc"], {
    cwd: RUN_DIR, env: { ...process.env, DYLD_LIBRARY_PATH: ".", LD_LIBRARY_PATH: "." },
    stdio: ["ignore", out, out], detached: true,
  });
  p.unref();
  pgid = p.pid!;
  writeFileSync(PID_FILE, JSON.stringify([pgid]));
}

export function stopServer() {
  if (pgid) killGroup(pgid);
  pgid = null;
}

export async function waitFor(fn: () => Promise<boolean>, what: string, timeoutMs = 30_000) {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${what}: ${String((last as Error)?.message ?? last)}`);
}

export async function waitGone(timeoutMs = 15_000) {
  await waitFor(async () => {
    try { await jsonRpc("", "", "Test", { IntValue_u32: 1 }, 1500); return false; } catch (e) { return !(e instanceof JsonRpcError); }
  }, "server to stop", timeoutMs);
}

export class JsonRpcError extends Error {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
export class JsonRpcHttpError extends Error {
  status: number;
  constructor(status: number) { super(`HTTP ${status}`); this.status = status; }
}

/** Minimal JSON-RPC client (independent of the app's transports): POST /api/ with HTTP Basic auth. */
export function jsonRpc(hub: string, password: string, method: string, params: Record<string, unknown> = {},
  timeoutMs = 60_000, host = "127.0.0.1"): Promise<Record<string, unknown>> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method, params });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, port: PORT, path: "/api/", method: "POST", rejectUnauthorized: false, agent: false,
      headers: {
        "content-type": "application/json", "content-length": Buffer.byteLength(body),
        authorization: `Basic ${Buffer.from(`${hub || "administrator"}:${password}`).toString("base64")}`,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new JsonRpcHttpError(res.statusCode ?? 0));
        const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (j.error) return reject(new JsonRpcError(j.error.code, j.error.message));
        resolve(j.result ?? {});
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}
