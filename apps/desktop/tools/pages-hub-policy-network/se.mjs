// Throwaway SoftEther VPN Server for the hub-policy-network page E2E (same recipe as e2e/global-setup.ts):
// copies the binaries from ~/se-build/src/build into its own run dir, writes a one-listener config,
// starts "./vpnserver execsvc" detached (own process group) and talks JSON-RPC to it.
//   node se.mjs start | stop       (run.mjs imports startServer/stopServer/seRpc)
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

export const PORT = Number(process.env.SE_PORT ?? 15916);
export const RUN = process.env.SE_RUN ?? path.join(os.homedir(), "se-desk-pages-hub-policy-network");
export const ADMIN_PW = "hpnpass";
const SE = path.join(os.homedir(), "se-build/src/build");
const PID = path.join(RUN, "vpnserver.pgid");

export function seRpc(method, params = {}, password = ADMIN_PW) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method, params });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "127.0.0.1", port: PORT, path: "/api/", method: "POST", rejectUnauthorized: false, timeout: 15_000,
      headers: { authorization: `Basic ${Buffer.from(`administrator:${password}`).toString("base64")}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { const j = JSON.parse(d); j.error ? reject(Object.assign(new Error(`${method}: ${j.error.code} ${j.error.message}`), { code: j.error.code })) : resolve(j.result); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`${method}: timeout`)));
    req.end(body);
  });
}

export function stopServer() {
  if (!existsSync(PID)) return false;
  const pgid = Number(readFileSync(PID, "utf8"));
  try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
  rmSync(PID, { force: true });
  return true;
}

export async function startServer() {
  stopServer();
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
  const child = spawn("./vpnserver", ["execsvc"], { cwd: RUN, env: { ...process.env, DYLD_LIBRARY_PATH: "." }, stdio: ["ignore", log, log], detached: true });
  child.unref();
  writeFileSync(PID, String(child.pid));
  for (let i = 0; ; i++) {
    try { await seRpc("Test", { IntValue_u32: 1 }, ""); break; } catch (e) { if (i > 100) throw e; await new Promise((r) => setTimeout(r, 300)); }
  }
  await seRpc("SetServerPassword", { PlainTextPassword_str: ADMIN_PW }, "");
  return child.pid;
}

if (process.argv[1] === import.meta.filename) {
  const cmd = process.argv[2];
  if (cmd === "start") { const pid = await startServer(); console.log(`vpnserver pgid ${pid} on ${PORT}, run dir ${RUN}`); }
  else if (cmd === "stop") console.log(stopServer() ? "stopped" : "not running");
  else console.log("usage: node se.mjs start|stop");
}
