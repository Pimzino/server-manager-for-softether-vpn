import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync } from "node:fs";
import path from "node:path";
import {
  ADMIN, ARTIFACTS, BACKEND_DATA, BACKEND_PORT, CLIENT_DIR, ROOT, RUN_DIR, SE_BUILD, SERVERS, BETA_ADMIN_PASSWORD,
} from "./env.ts";
import { seRpc } from "./helpers.ts";

const procs: ChildProcess[] = [];

function copyBins(dir: string, bins: string[]) {
  mkdirSync(dir, { recursive: true });
  for (const f of [...bins, "hamcore.se2", "libcedar.dylib", "libmayaqua.dylib", "libcedar.so", "libmayaqua.so"]) {
    const src = path.join(SE_BUILD, f);
    if (existsSync(src)) copyFileSync(src, path.join(dir, f));
  }
}

function start(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, logName: string) {
  const out = openSync(path.join(RUN_DIR, `${logName}.log`), "a");
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", out, out], detached: true });
  procs.push(p);
  writeFileSync(path.join(RUN_DIR, "pids.json"), JSON.stringify(procs.map((x) => x.pid)));
  return p;
}

async function waitFor(fn: () => Promise<boolean>, what: string, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (await fn()) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// Each child runs in its own process group: vpnserver/vpnclient "execsvc" fork a supervisor and a
// worker, so signalling only the spawned PID would orphan the worker (and its listening port).
function killGroup(p: ChildProcess, sig: NodeJS.Signals) {
  try { if (p.pid) process.kill(-p.pid, sig); } catch { /* gone */ }
}
function killAll() {
  for (const p of procs) killGroup(p, "SIGKILL");
}

export default async function globalSetup() {
  try {
    return await setup();
  } catch (e) {
    killAll();
    throw e;
  }
}

async function setup() {
  if (!existsSync(path.join(SE_BUILD, "vpnserver"))) {
    throw new Error(`SoftEther binaries not found in ${SE_BUILD}; build SoftEtherVPN and set SE_BUILD_DIR`);
  }
  // Leftovers from an interrupted earlier run would hold the ports
  const pidFile = path.join(RUN_DIR, "pids.json");
  if (existsSync(pidFile)) {
    for (const pid of JSON.parse(readFileSync(pidFile, "utf8")) as number[]) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
    await new Promise((r) => setTimeout(r, 1500));
  }
  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(ARTIFACTS, { recursive: true });
  const libEnv = { DYLD_LIBRARY_PATH: ".", LD_LIBRARY_PATH: "." };

  // Two SoftEther VPN Servers with a single listener each (no clash with other instances).
  for (const s of SERVERS) {
    copyBins(s.dir, ["vpnserver"]);
    writeFileSync(path.join(s.dir, "vpn_server.config"), [
      "# Software Configuration File", "declare root", "{",
      "\tdeclare ListenerList", "\t{", "\t\tdeclare Listener0", "\t\t{",
      "\t\t\tbool DisableDos false", "\t\t\tbool Enabled true", `\t\t\tuint Port ${s.port}`, "\t\t}", "\t}",
      "\tdeclare ServerConfiguration", "\t{", "\t\tstring PortsUDP $", "\t}", "}", "",
    ].join("\n"));
    start("./vpnserver", ["execsvc"], s.dir, libEnv, s.name);
  }
  for (const s of SERVERS) {
    await waitFor(async () => !!(await seRpc(s.port, "", "Test", { IntValue_u32: 1 })), `${s.name} JSON-RPC`);
  }
  // e2e-beta gets an admin password so password-authenticated management is exercised.
  await seRpc(SERVERS[1].port, "", "SetServerPassword", { PlainTextPassword_str: BETA_ADMIN_PASSWORD });

  // SoftEther VPN Client (localhost:9931) used to import generated .vpn files.
  copyBins(CLIENT_DIR, ["vpnclient", "vpncmd"]);
  start("./vpnclient", ["execsvc"], CLIENT_DIR, libEnv, "vpnclient");
  writeFileSync(pidFile, JSON.stringify(procs.map((p) => p.pid)));

  // Fresh management backend serving the built web UI.
  if (!existsSync(path.join(ROOT, "apps/web/dist/index.html"))) {
    execFileSync("pnpm", ["exec", "vite", "build"], { cwd: path.join(ROOT, "apps/web"), stdio: "inherit" });
  }
  start("node", ["src/main.ts"], path.join(ROOT, "apps/server"), {
    SEM_DATA_DIR: BACKEND_DATA, SEM_HTTP: "1", SEM_PORT: String(BACKEND_PORT), SEM_HOST: "127.0.0.1",
    SEM_POLL_INTERVAL_SEC: "5", SEM_LOG_LEVEL: "warn", SEM_LOGIN_RATE_LIMIT: "1000",
  }, "backend");
  await waitFor(async () => (await fetch(`http://127.0.0.1:${BACKEND_PORT}/healthz`)).ok, "backend");
  // The manager never creates an admin by itself: complete first-run setup with the one-time token
  const setupToken = readFileSync(path.join(BACKEND_DATA, "setup-token.txt"), "utf8").trim();
  const setup = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/setup`, {
    method: "POST", headers: { "content-type": "application/json", "x-sem-csrf": "1" },
    body: JSON.stringify({ setupToken, username: ADMIN.username, displayName: "Administrator", password: ADMIN.password }),
  });
  if (setup.status !== 201) throw new Error(`first-run setup failed: ${setup.status} ${await setup.text()}`);

  writeFileSync(path.join(RUN_DIR, "pids.json"), JSON.stringify(procs.map((p) => p.pid)));
  return async () => {
    for (const p of procs) killGroup(p, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    killAll();
  };
}
