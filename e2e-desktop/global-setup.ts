// Global setup: builds the real desktop app into e2e-desktop/.build, starts two throwaway SoftEther VPN Servers
// (A: JSON-RPC API disabled, B: admin password) and a SoftEther VPN Client, each in its own process group, and
// hands Playwright a teardown that kills every process group again.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { ARTIFACTS, CLIENT_DIR, CLIENT_PORT, E2E_DIR, OUTPUTS, RUN_DIR, SCREENSHOTS, SE_BUILD, SERVER_A, SERVER_B, WIN, exe } from "./env.ts";
import { seRpc, vpncmd, writeState } from "./helpers.ts";

const procs: ChildProcess[] = [];
const PID_FILE = path.join(RUN_DIR, "..", ".se-desk-e2e.pids.json");

function copyBins(dir: string, bins: string[]) {
  mkdirSync(dir, { recursive: true });
  for (const f of [...bins.map(exe), "hamcore.se2", "libcedar.dylib", "libmayaqua.dylib", "libcedar.so", "libmayaqua.so"]) {
    const src = path.join(SE_BUILD, f);
    if (existsSync(src)) copyFileSync(src, path.join(dir, f));
  }
}

function start(cmd: string, args: string[], cwd: string, logName: string) {
  const out = openSync(path.join(RUN_DIR, `${logName}.log`), "a");
  const p = spawn(cmd, args, { cwd, env: { ...process.env, DYLD_LIBRARY_PATH: ".", LD_LIBRARY_PATH: "." }, stdio: ["ignore", out, out], detached: true });
  procs.push(p);
  writeFileSync(PID_FILE, JSON.stringify(procs.map((x) => x.pid)));
  return p;
}

// ---- Windows: SoftEther's binaries run as Windows services (there is no foreground "execsvc" mode) ----
const winServices: string[] = [];
const WIN_SERVICES = { A: "SEME2E_SERVER_A", B: "SEME2E_SERVER_B", client: "SEME2E_CLIENT" };

function sc(args: string[]) {
  try { return execFileSync("sc.exe", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return String((e as { stdout?: string }).stdout ?? e); }
}

function removeWinService(name: string) {
  sc(["stop", name]);
  for (let i = 0; i < 20 && /RUNNING|STOP_PENDING/.test(sc(["query", name])); i++) execFileSync("powershell.exe", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 500"]);
  sc(["delete", name]);
}

/** Register `<dir>/<binary>.exe /service` as an on-demand service and start it. */
function startWinService(name: string, dir: string, binary: string) {
  const created = sc(["create", name, "binPath=", `"${path.join(dir, `${binary}.exe`)}" /service`, "start=", "demand", "DisplayName=", `Server Manager for SoftEther VPN E2E ${name}`]);
  if (!/SUCCESS/.test(created)) throw new Error(`sc create ${name} failed: ${created}`);
  winServices.push(name);
  const started = sc(["start", name]);
  if (!/START_PENDING|RUNNING/.test(started)) throw new Error(`sc start ${name} failed: ${started}`);
}

function stopEverything(sig: NodeJS.Signals) {
  if (WIN) { for (const n of winServices.splice(0)) removeWinService(n); return; }
  for (const p of procs) killGroup(p.pid, sig);
}

async function waitFor(fn: () => Promise<boolean>, what: string, timeoutMs = 30_000) {
  const t0 = Date.now();
  let last: unknown;
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return; } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(1000, () => { s.destroy(); resolve(false); });
  });
}

// vpnserver/vpnclient "execsvc" fork a supervisor and a worker: signal the whole process group.
function killGroup(pid: number | undefined, sig: NodeJS.Signals) {
  try { if (pid) process.kill(-pid, sig); } catch { /* gone */ }
}

function serverConfig(port: number, disableJsonRpc: boolean) {
  return [
    "# Software Configuration File", "declare root", "{",
    "\tdeclare ListenerList", "\t{", "\t\tdeclare Listener0", "\t\t{",
    "\t\t\tbool DisableDos false", "\t\t\tbool Enabled true", `\t\t\tuint Port ${port}`, "\t\t}", "\t}",
    "\tdeclare ServerConfiguration", "\t{",
    "\t\tstring PortsUDP $",
    // Cedar/Server.c SiLoadServerCfg: CfgGetBool(f, "DisableJsonRpcWebApi") in folder ServerConfiguration
    ...(disableJsonRpc ? ["\t\tbool DisableJsonRpcWebApi true"] : []),
    "\t}", "}", "",
  ].join("\n");
}

export default async function globalSetup() {
  try {
    return await setup();
  } catch (e) {
    stopEverything("SIGKILL");
    throw e;
  }
}

async function setup() {
  if (!existsSync(path.join(SE_BUILD, exe("vpnserver")))) throw new Error(`SoftEther binaries not found in ${SE_BUILD}`);
  // Leftovers of an interrupted earlier run of this suite
  if (WIN) for (const n of Object.values(WIN_SERVICES)) removeWinService(n);
  if (!WIN && existsSync(PID_FILE)) {
    for (const pid of JSON.parse(readFileSync(PID_FILE, "utf8")) as number[]) killGroup(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 1500));
  }
  for (const port of [SERVER_A.port, SERVER_B.port, CLIENT_PORT]) {
    if (await portInUse(port)) {
      throw new Error(`Port ${port} is already in use by another process (another SoftEther instance?). Stop it first; this suite never kills processes it did not start.`);
    }
  }
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  rmSync(ARTIFACTS, { recursive: true, force: true });
  for (const d of [ARTIFACTS, SCREENSHOTS, OUTPUTS]) mkdirSync(d, { recursive: true });

  // 1. The real app, built exactly like apps/desktop/scripts/build.mjs, into e2e-desktop/.build
  execFileSync(process.execPath, [path.join(E2E_DIR, "build.mjs")], { stdio: "inherit" });

  // 2. Two SoftEther VPN Servers with one listener each.
  for (const s of [SERVER_A, SERVER_B]) {
    copyBins(s.dir, ["vpnserver"]);
    writeFileSync(path.join(s.dir, "vpn_server.config"), serverConfig(s.port, s === SERVER_A));
    if (WIN) startWinService(WIN_SERVICES[s.key as "A" | "B"], s.dir, "vpnserver");
    else start("./vpnserver", ["execsvc"], s.dir, `server-${s.key}`);
  }
  // B: JSON-RPC. A: its JSON-RPC API is disabled, so it is checked with vpncmd (native admin protocol).
  await waitFor(async () => !!(await seRpc(SERVER_B.port, "", "Test", { IntValue_u32: 1 })), "server B JSON-RPC");
  await seRpc(SERVER_B.port, "", "SetServerPassword", { PlainTextPassword_str: SERVER_B.password });
  copyBins(CLIENT_DIR, ["vpnclient", "vpncmd"]);
  await waitFor(async () => (await vpncmd(SERVER_A.port, "", "", ["ServerInfoGet"])).code === 0, "server A native admin (vpncmd)");
  // Proof that A's JSON-RPC API really is off: /api/ must not answer.
  let jsonRpcAnswered = false;
  try { await seRpc(SERVER_A.port, "", "Test", { IntValue_u32: 1 }); jsonRpcAnswered = true; } catch { /* expected */ }
  if (jsonRpcAnswered) throw new Error("Server A still answers JSON-RPC although DisableJsonRpcWebApi is true");

  // 3. SoftEther VPN Client (management port 9931 is fixed) for .vpn import checks.
  if (WIN) startWinService(WIN_SERVICES.client, CLIENT_DIR, "vpnclient");
  else start("./vpnclient", ["execsvc"], CLIENT_DIR, "vpnclient");
  await waitFor(async () => await portInUse(CLIENT_PORT), "vpnclient on 9931");

  writeState({ bPassword: SERVER_B.password, servers: {} });
  writeFileSync(PID_FILE, JSON.stringify(procs.map((p) => p.pid)));
  return async () => {
    if (WIN) { stopEverything("SIGTERM"); return; }
    for (const p of procs) killGroup(p.pid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    for (const p of procs) killGroup(p.pid, "SIGKILL");
    rmSync(PID_FILE, { force: true });
  };
}
