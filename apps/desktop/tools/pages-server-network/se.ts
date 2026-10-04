// Throwaway SoftEther VPN Server for the server-network page E2E run (same recipe as e2e/global-setup.ts):
// copies the binaries built from source into its own run dir, writes a minimal config with ONE listener,
// starts `vpnserver execsvc` detached (its own process group) and talks JSON-RPC to it directly.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Agent, request } from "undici";

export const SE_BUILD = process.env.SE_BUILD_DIR ?? path.join(os.homedir(), "se-build/src/build");
// Overridable so several agents/runs can each use their own server (e.g. SEM_NET_PORT=16011).
export const RUN_DIR = process.env.SEM_NET_RUN_DIR ?? path.join(os.homedir(), "se-desk-pages-server-network");
export const PORT = Number(process.env.SEM_NET_PORT ?? 15911);
export const ADMIN_PW = "Net-Pages-Adm1n!";
/**
 * Offline by default. A vpnserver started with SoftEther's defaults contacts SoftEther's cloud on its own: it registers a
 * public vpnNNN.softether.net Dynamic DNS name (over IPv4 AND IPv6, where a proxy setting doesn't apply), sends NAT
 * traversal keep-alives, and VPN Azure opens a relay tunnel to vpnazure.net. On a managed laptop that traffic can raise
 * endpoint-security alerts, and it has nothing to do with the pages under test. So the config disables the DDNS client
 * (which also removes VPN Azure) and NAT traversal. SEM_NET_CLOUD=1 restores SoftEther's defaults for a deliberate
 * full DDNS / VPN Azure run on a machine where that is acceptable.
 */
export const CLOUD = process.env.SEM_NET_CLOUD === "1";
const PID_FILE = path.join(RUN_DIR, "pid");
const insecure = new Agent({ connect: { rejectUnauthorized: false } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Direct JSON-RPC call to the server (independent of the app: used to set up fixtures and verify writes). */
export async function seRpc<T = Record<string, any>>(method: string, params: Record<string, unknown> = {}, password = ADMIN_PW): Promise<T> {
  const res = await request(`https://127.0.0.1:${PORT}/api/`, {
    method: "POST", dispatcher: insecure,
    headers: { authorization: `Basic ${Buffer.from(`administrator:${password}`).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
  });
  const json = (await res.body.json()) as { result?: T; error?: { code: number; message: string } };
  if (json.error) throw new Error(`SoftEther ${method} error ${json.error.code}: ${json.error.message}`);
  return json.result!;
}

/** Sockets of the vpnserver process group that talk to anything other than this machine (lsof, by process group). */
export function remoteSockets(): string[] {
  if (!existsSync(PID_FILE)) return [];
  const pgid = readFileSync(PID_FILE, "utf8").trim();
  let out = "";
  try { out = execFileSync("lsof", ["-a", "-g", pgid, "-i", "-n", "-P"], { encoding: "utf8" }); } catch { return []; /* lsof exits 1 when nothing matches */ }
  return out.split("\n").filter((l) => l.includes("->")).filter((l) => {
    const remote = l.split("->")[1] ?? "";
    return !/^(127\.|\[::1\]|localhost)/.test(remote.trim());
  });
}

export function killServer() {
  if (!existsSync(PID_FILE)) return false;
  const pid = Number(readFileSync(PID_FILE, "utf8"));
  let killed = false;
  try { process.kill(-pid, "SIGKILL"); killed = true; } catch { /* already gone */ }
  rmSync(PID_FILE, { force: true });
  return killed;
}

export async function startServer() {
  if (killServer()) await sleep(1000);
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  for (const f of ["vpnserver", "hamcore.se2", "libcedar.dylib", "libmayaqua.dylib"]) copyFileSync(path.join(SE_BUILD, f), path.join(RUN_DIR, f));
  writeFileSync(path.join(RUN_DIR, "vpn_server.config"), [
    "# Software Configuration File", "declare root", "{",
    "\tdeclare ListenerList", "\t{", "\t\tdeclare Listener0", "\t\t{",
    "\t\t\tbool DisableDos false", "\t\t\tbool Enabled true", `\t\t\tuint Port ${PORT}`, "\t\t}", "\t}",
    "\tdeclare ServerConfiguration", "\t{", "\t\tstring PortsUDP $", ...(CLOUD ? [] : ["\t\tbool DisableNatTraversal true"]), "\t}",
    ...(CLOUD ? [] : ["\tdeclare DDnsClient", "\t{", "\t\tbool Disabled true", "\t}"]),
    "}", "",
  ].join("\n"));
  const log = openSync(path.join(RUN_DIR, "vpnserver.log"), "a");
  const child = spawn("./vpnserver", ["execsvc"], {
    cwd: RUN_DIR, env: { ...process.env, DYLD_LIBRARY_PATH: ".", LD_LIBRARY_PATH: "." }, stdio: ["ignore", log, log], detached: true,
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  const t0 = Date.now();
  for (;;) {
    try { await seRpc("Test", { IntValue_u32: 1 }, ""); break; } catch { /* not up yet */ }
    if (Date.now() - t0 > 30_000) throw new Error("vpnserver did not answer JSON-RPC within 30 s");
    await sleep(300);
  }
  await seRpc("SetServerPassword", { PlainTextPassword_str: ADMIN_PW }, "");
  return child.pid!;
}

// CLI: node se.ts start | stop | rpc <Method> '<json>'
if (import.meta.filename === path.resolve(process.argv[1] ?? "")) {
  const [cmd, method, json] = process.argv.slice(2);
  if (cmd === "start") console.log(`vpnserver pgid ${await startServer()} on ${PORT}`);
  else if (cmd === "stop") console.log(killServer() ? "killed" : "not running");
  else if (cmd === "rpc") console.log(JSON.stringify(await seRpc(method, json ? JSON.parse(json) : {}), null, 2));
  process.exit(0);
}
