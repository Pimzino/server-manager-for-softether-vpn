// End-to-end smoke test of the PACKAGED macOS app (not the dev build), against a real SoftEther VPN Server.
//
//   node scripts/smoke-packaged.mjs [--arch=arm64|x64] [--port=16201]      (pnpm run smoke:packaged)
//
// 1. Extracts release/SoftEther-Manager-<v>-mac-<arch>.zip with ditto (the shipped artifact, not the staging copy).
// 2. Starts a throwaway vpnserver from ~/se-build/src/build (SE_BUILD_DIR) in its own run dir (~/se-desk-release) and
//    process group, listening on --port only, and sets an administrator password over JSON-RPC.
// 3. Starts the app like a user would (`open -n`), on an empty data directory, with a Chromium remote-debugging port.
//    The packaged app has the RunAsNode and --inspect fuses off, so Playwright's _electron.launch cannot drive it;
//    Chromium's --remote-debugging-port still works, and Playwright attaches over CDP (connectOverCDP).
// 4. Through the UI: Welcome > Add Connection (Native transport, the default), checks the certificate fingerprint the
//    app shows against an independent TLS handshake, trusts it, waits for "Online", and checks that the overview shows
//    the product name the server reports over JSON-RPC (an independent oracle). Then adds a second connection over
//    JSON-RPC to the same server, and checks the sidebar reads "2 of 2 online".
// 5. Saves screenshots (renderer via CDP, and the real window via `screencapture -l` when this terminal has the
//    Screen Recording permission) and result.json to release/verification/packaged-smoke/.
// 6. Always kills the app and the vpnserver process group, and removes the temporary directories.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const PRODUCT = pkg.productName;
const argv = process.argv.slice(2);
const opt = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const arch = opt("arch", process.arch === "arm64" ? "arm64" : "x64");
const PORT = Number(opt("port", "16201"));
const PASSWORD = "Packaged-Smoke-Pw-1";
const SE_BUILD = process.env.SE_BUILD_DIR ?? path.join(os.homedir(), "se-build/src/build");
const RUN_DIR = path.join(os.homedir(), "se-desk-release");
const OUT = path.join(root, "release/verification/packaged-smoke");
const zip = path.join(root, `release/SoftEther-Manager-${pkg.version}-mac-${arch}.zip`);

const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const steps = [];
const step = (s) => { steps.push(s); console.log(`  - ${s}`); };
function assert(c, m) { if (!c) throw new Error(m); }

function rpc(method, params = {}, password = "") {
  const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method, params });
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: "127.0.0.1", port: PORT, path: "/api/", method: "POST", rejectUnauthorized: false, timeout: 10_000,
      headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`administrator:${password}`).toString("base64")}` },
    }, (res) => {
      let t = "";
      res.on("data", (d) => { t += d; });
      res.on("end", () => {
        try { const j = JSON.parse(t); j.error ? reject(new Error(`${method}: ${j.error.message}`)) : resolve(j.result); }
        catch { reject(new Error(`${method}: HTTP ${res.statusCode}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}

function fingerprint() {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port: PORT, rejectUnauthorized: false }, () => {
      const fp = s.getPeerCertificate().fingerprint256.replace(/:/g, "").toLowerCase();
      s.end();
      resolve(fp);
    });
    s.on("error", reject);
  });
}

async function until(fn, what, ms = 30_000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

const result = { arch, zip: path.basename(zip), port: PORT, startedAt: new Date().toISOString(), steps, screenshots: [], ok: false };
let server, appPid, browser, appPath;
const tmp = mkdtempSync(path.join(os.tmpdir(), "sem-smoke-"));

try {
  assert(existsSync(zip), `${zip} not found: run pnpm run dist first`);
  assert(existsSync(path.join(SE_BUILD, "vpnserver")), `SoftEther binaries not found in ${SE_BUILD}`);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // 1. the shipped zip
  assert(sh("ditto", ["-x", "-k", zip, path.join(tmp, "app")]).code === 0, "ditto failed");
  appPath = path.join(tmp, "app", `${PRODUCT}.app`);
  const exe = path.join(appPath, "Contents/MacOS", PRODUCT);
  const cs = sh("codesign", ["--verify", "--deep", "--strict", appPath]);
  assert(cs.code === 0, `codesign: ${cs.out}`);
  result.executable = sh("file", [exe]).out.split(": ").pop();
  step(`extracted ${path.basename(zip)} with ditto; codesign --verify --deep --strict OK; ${result.executable}`);

  // 2. a real SoftEther VPN Server
  const busy = await new Promise((res) => { const s = tls.connect({ host: "127.0.0.1", port: PORT, rejectUnauthorized: false }, () => { s.destroy(); res(true); }); s.on("error", () => res(false)); });
  assert(!busy, `port ${PORT} is already in use (not ours: not touching it)`);
  rmSync(RUN_DIR, { recursive: true, force: true });
  const sdir = path.join(RUN_DIR, "server");
  mkdirSync(sdir, { recursive: true });
  for (const f of ["vpnserver", "hamcore.se2", "libcedar.dylib", "libmayaqua.dylib"]) if (existsSync(path.join(SE_BUILD, f))) copyFileSync(path.join(SE_BUILD, f), path.join(sdir, f));
  writeFileSync(path.join(sdir, "vpn_server.config"), ["# Software Configuration File", "declare root", "{", "\tdeclare ListenerList", "\t{",
    "\t\tdeclare Listener0", "\t\t{", "\t\t\tbool DisableDos false", "\t\t\tbool Enabled true", `\t\t\tuint Port ${PORT}`, "\t\t}", "\t}",
    "\tdeclare ServerConfiguration", "\t{", "\t\tstring PortsUDP $", "\t}", "}", ""].join("\n"));
  const log = openSync(path.join(RUN_DIR, "vpnserver.log"), "a");
  server = spawn("./vpnserver", ["execsvc"], { cwd: sdir, env: { ...process.env, DYLD_LIBRARY_PATH: "." }, stdio: ["ignore", log, log], detached: true });
  writeFileSync(path.join(RUN_DIR, "pgid"), String(server.pid));
  await until(() => rpc("Test", { IntValue_u32: 1 }), "vpnserver JSON-RPC");
  await rpc("SetServerPassword", { PlainTextPassword_str: PASSWORD });
  const info = await rpc("GetServerInfo", {}, PASSWORD);
  result.server = { product: info.ServerProductName_str, version: info.ServerVersionString_str, build: info.ServerBuildInfoString_str };
  step(`vpnserver (process group ${server.pid}) on 127.0.0.1:${PORT}: ${result.server.product} ${result.server.version}; admin password set`);

  // 3. the packaged app, started like a user would
  const cdp = 19700 + Math.floor(Math.random() * 200);
  const r = sh("open", ["-n", "--env", `SEM_DATA_DIR=${path.join(tmp, "data")}`, "--env", "SEM_INSECURE_KEYSTORE=1", appPath, "--args",
    `--remote-debugging-port=${cdp}`, `--user-data-dir=${path.join(tmp, "chromium")}`]);
  assert(r.code === 0, `open: ${r.out}`);
  appPid = await until(() => Number(sh("pgrep", ["-f", "-n", `${exe} --remote-debugging-port=${cdp}`]).out.split("\n")[0]) || 0, "app process");
  const { chromium, expect } = await import("@playwright/test");
  browser = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${cdp}`, { timeout: 2000 }), "CDP endpoint");
  const page = await until(() => browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file:")), "app window");
  result.url = page.url().replace(/^.*\/app\.asar/, "…/app.asar");
  step(`open -n started pid ${appPid}; attached over CDP port ${cdp}; page ${result.url}`);
  const shot = async (name) => { const f = path.join(OUT, `${String(result.screenshots.length + 1).padStart(2, "0")}-${name}.png`); await page.screenshot({ path: f }); result.screenshots.push(path.basename(f)); return f; };

  // 4. add connections through the UI
  await expect(page.getByTestId("welcome")).toBeVisible({ timeout: 30_000 });
  await shot("welcome");
  const expectedFp = await fingerprint();
  async function addConnection(name, transport) {
    const sheet = page.getByTestId("connection-sheet").locator(".mantine-Modal-content");
    await expect(sheet).toBeVisible();
    await page.getByTestId("conn-name").fill(name);
    await page.getByTestId("conn-host").fill("127.0.0.1");
    await page.getByTestId("conn-port").fill(String(PORT));
    await page.getByTestId("conn-password").fill(PASSWORD);
    const save = page.getByTestId("conn-save-password");
    if (!(await save.isChecked())) await save.dispatchEvent("click");
    if (transport === "JSON-RPC") {
      const adv = page.getByTestId("conn-advanced");
      if ((await adv.getAttribute("aria-expanded")) !== "true") await adv.click();
      await page.getByTestId("conn-transport").locator("label").filter({ hasText: "JSON-RPC" }).first().click();
    }
    await page.getByTestId("conn-continue").click();
    const trust = page.getByTestId("connection-trust");
    await expect(trust).toBeVisible({ timeout: 30_000 });
    const shown = ((await trust.locator(".sem-fp-grid").getAttribute("aria-label")) ?? "").replace(/^Fingerprint\s*/, "").replace(/[^0-9a-f]/gi, "").toLowerCase();
    assert(shown === expectedFp, `fingerprint shown by the app (${shown}) differs from the TLS handshake (${expectedFp})`);
    await shot(`${transport === "JSON-RPC" ? "jsonrpc" : "native"}-certificate-trust`);
    await page.getByTestId("connection-trust-confirm").click();
    await expect(sheet).toBeHidden({ timeout: 30_000 });
    const route = await until(async () => { const h = await page.evaluate(() => decodeURIComponent(location.hash.slice(1))); return /^\/servers\/\d+$/.test(h) && h; }, "server route");
    const id = Number(route.split("/")[2]);
    await expect(page.getByTestId(`sidebar-server-${id}`).locator(".sem-dot[data-status=ok]")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("overview-status")).toHaveText(/Online/, { timeout: 30_000 });
    await expect(page.getByTestId("overview-poll")).toContainText(transport === "JSON-RPC" ? "JSON-RPC" : "Native admin protocol");
    await expect(page.getByTestId("overview-info")).toContainText(result.server.product);
    await page.waitForTimeout(800);
    await shot(`${transport === "JSON-RPC" ? "jsonrpc" : "native"}-connected-overview`);
    step(`UI: added "${name}" (${transport}), certificate ${shown.slice(0, 16)}… matches the TLS handshake, sidebar dot ok, overview Online, shows "${result.server.product}"`);
    return id;
  }
  await page.getByTestId("welcome-add").click();
  const a = await addConnection("HQ (packaged, native)", "Native");
  await page.getByTestId("sidebar-add").click();
  const b = await addConnection("HQ (packaged, JSON-RPC)", "JSON-RPC");
  await expect(page.locator(".sem-sidebar-summary")).toHaveText("2 of 2 online", { timeout: 30_000 });
  await page.getByTestId(`sidebar-server-${a}`).click();
  await expect(page.getByTestId("overview-status")).toHaveText(/Online/, { timeout: 30_000 });
  await page.waitForTimeout(800);
  const final = await shot("final-two-connections-online");
  step(`sidebar reads "2 of 2 online" (connections ${a} native, ${b} JSON-RPC)`);

  // 5. the real window, title bar included (needs the Screen Recording permission for this terminal)
  const win = sh("swift", [path.join(root, "build/verify/window-of-pid.swift"), String(appPid)]).out;
  if (win.startsWith("{")) {
    const w = JSON.parse(win);
    const cap = path.join(OUT, "native-window.png");
    const c = sh("screencapture", ["-x", "-o", `-l${w.id}`, cap]);
    if (c.code === 0 && existsSync(cap)) { result.screenshots.push("native-window.png"); step(`native window #${w.id} "${w.owner}" ${w.width}x${w.height} captured with screencapture -l`); }
    else step(`native window #${w.id} "${w.owner}" ${w.width}x${w.height} found; screencapture -l skipped (no Screen Recording permission)`);
  } else step("native window not found in CGWindowList");
  result.ok = true;
  result.finalScreenshot = path.basename(final);
} catch (e) {
  result.error = String(e?.stack ?? e);
  console.error(result.error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (appPid) { try { process.kill(appPid, "SIGTERM"); } catch {} await sleep(1500); try { process.kill(appPid, "SIGKILL"); } catch {} }
  if (appPath) sh("pkill", ["-f", appPath]);
  if (server?.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch {} await sleep(1500); try { process.kill(-server.pid, "SIGKILL"); } catch {} }
  await sleep(500);
  result.cleanup = {
    appRunning: appPath ? sh("pgrep", ["-f", appPath]).code === 0 : false,
    vpnserverRunning: server?.pid ? sh("pgrep", ["-g", String(server.pid)]).code === 0 : false,
  };
  rmSync(tmp, { recursive: true, force: true });
  if (existsSync(RUN_DIR)) for (const f of readdirSync(RUN_DIR)) if (f !== "vpnserver.log") rmSync(path.join(RUN_DIR, f), { recursive: true, force: true });
  result.finishedAt = new Date().toISOString();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(`${result.ok ? "PASS" : "FAIL"}: packaged ${arch} app smoke test; ${path.relative(root, OUT)}/result.json; cleanup ${JSON.stringify(result.cleanup)}`);
}
