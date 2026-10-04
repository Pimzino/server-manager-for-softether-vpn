// Throwaway SoftEther VPN Server for the server-protocols-security page E2E (same recipe as e2e/global-setup.ts).
//   import { startServer, seRpc } from "./se.mjs"
//   node se.mjs start | stop     (manual use while developing)
// Env: SEM_PAGES_PORT (default 15912), SEM_PAGES_RUN (default ~/se-desk-pages-server-protocols-security).
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PORT = Number(process.env.SEM_PAGES_PORT ?? 15912);
export const RUN = process.env.SEM_PAGES_RUN ?? path.join(os.homedir(), "se-desk-pages-server-protocols-security");
export const SE = process.env.SE_BUILD_DIR ?? path.join(os.homedir(), "se-build/src/build");
const PID_FILE = path.join(RUN, "..", `.${path.basename(RUN)}.pid`);

/** JSON-RPC straight to the server (independent of the app), HTTP Basic auth like apps/server's client. */
export function seRpc(method, params = {}, password = process.env.SEM_ADMIN_PW ?? "adminpw") {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method, params });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "127.0.0.1", port: PORT, path: "/api/", method: "POST", rejectUnauthorized: false, timeout: 20_000,
      headers: {
        authorization: `Basic ${Buffer.from(`administrator:${password}`).toString("base64")}`,
        "content-type": "application/json", "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          const j = JSON.parse(d);
          if (j.error) { const e = new Error(`${method}: ${j.error.code} ${j.error.message}`); e.code = j.error.code; reject(e); } else resolve(j.result);
        } catch (e) { reject(new Error(`${method}: HTTP ${res.statusCode} ${d.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`${method}: timeout`)));
    req.end(body);
  });
}

export function stopServer() {
  if (!existsSync(PID_FILE)) return false;
  const pid = Number(readFileSync(PID_FILE, "utf8"));
  try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
  rmSync(PID_FILE, { force: true });
  return true;
}

/** Fresh run dir, one listener on PORT, empty admin password; returns { pid, stop }. */
export async function startServer() {
  if (stopServer()) await new Promise((r) => setTimeout(r, 1200));
  rmSync(RUN, { recursive: true, force: true });
  mkdirSync(RUN, { recursive: true });
  for (const f of ["vpnserver", "hamcore.se2", "libcedar.dylib", "libmayaqua.dylib"]) copyFileSync(path.join(SE, f), path.join(RUN, f));
  writeFileSync(path.join(RUN, "vpn_server.config"), [
    "# Software Configuration File", "declare root", "{",
    "\tdeclare ListenerList", "\t{", "\t\tdeclare Listener0", "\t\t{",
    "\t\t\tbool DisableDos false", "\t\t\tbool Enabled true", `\t\t\tuint Port ${PORT}`, "\t\t}", "\t}",
    "\tdeclare ServerConfiguration", "\t{", "\t\tstring PortsUDP $", "\t}", "}", "",
  ].join("\n"));
  const log = openSync(path.join(RUN, "vpnserver.log"), "a");
  const p = spawn("./vpnserver", ["execsvc"], { cwd: RUN, env: { ...process.env, DYLD_LIBRARY_PATH: "." }, stdio: ["ignore", log, log], detached: true });
  p.unref();
  writeFileSync(PID_FILE, String(p.pid));
  for (let i = 0; ; i++) {
    try { await seRpc("Test", { IntValue_u32: 1 }, ""); break; } catch (e) { if (i > 120) throw e; await new Promise((r) => setTimeout(r, 300)); }
  }
  return { pid: p.pid, stop: stopServer };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (cmd === "start") {
    const s = await startServer();
    await seRpc("SetServerPassword", { PlainTextPassword_str: "adminpw" }, "");
    console.log(`vpnserver pid ${s.pid} on ${PORT}`);
  } else if (cmd === "stop") {
    console.log(stopServer() ? "stopped" : "not running");
  } else if (cmd === "rpc") {
    console.log(JSON.stringify(await seRpc(process.argv[3], JSON.parse(process.argv[4] ?? "{}")), null, 1));
  }
}
