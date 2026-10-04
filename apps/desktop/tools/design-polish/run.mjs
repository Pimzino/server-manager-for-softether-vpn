// Design-polish E2E: captures every major screen of the REAL app (built into a scratch dir, launched with Playwright
// _electron) against a real SoftEther VPN Server with realistic data, in light and dark, and checks the cross-cutting
// design-system fixes. Writes apps/desktop/design-screenshots/final/*.png + final/report.json.
//
//   node "apps/desktop/tools/design-polish/run.mjs"           (ROUND=2 also copies the PNGs to final/round-2/;
//                                                                ONLY=regex limits the page captures; POLISH_BUILD=<dir>)
//
// 1. Builds main + preload (production esbuild options) and the renderer (Vite) into $TMPDIR/sem-polish-build.
// 2. Starts a throwaway vpnserver (se.mjs: port 16011, run dir ~/se-desk-polish), creates hubs, users, groups,
//    access lists, source-IP rules, a listener, a hub message, SecureNAT and two live cascades (so the hubs have real
//    cascade + SecureNAT sessions) plus a cascade that can't connect.
// 3. Adds four connections (online, hub-admin, locked, unreachable), captures every page and the main sheets,
//    dialogs and inspectors in light and dark (page.screenshot; the sidebar material is painted because Chromium
//    screenshots can't see the window's vibrancy).
// 4. Checks: Inspector Esc after a confirmation dialog, disabled button styling, sheet top spacing, byte-swapped
//    session node info, and captures the real window (screencapture -l) to measure the sidebar material in dark mode,
//    including the Preferences appearance override. 5. Kills the vpnserver process group.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ADMIN_PW, PORT, RUN, seRpc, startServer, stopServer } from "./se.mjs";

const HERE = import.meta.dirname;
const DESK = path.resolve(HERE, "../..");
const REPO = path.resolve(DESK, "../..");
const OUT = process.env.POLISH_BUILD ?? path.join(os.tmpdir(), "sem-polish-build");
const SHOTS = path.join(DESK, "design-screenshots/final");
const ROUND = process.env.ROUND ?? "";
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const require = createRequire(path.join(REPO, "package.json"));
const { _electron: electron } = require("@playwright/test");

mkdirSync(SHOTS, { recursive: true });
for (const f of readdirSync(SHOTS)) if (f.endsWith(".png") && !f.startsWith("._") && !ONLY) rmSync(path.join(SHOTS, f));
const results = [];
const shots = [];
const audit = [];
const a11y = []; // per screenshot: text below WCAG 1.4.3 contrast, unnamed controls (4.1.2), unlabeled fields (3.3.2), images without alt
const check = (step, ok, detail = "") => {
  results.push({ step, ok: !!ok, detail: typeof detail === "string" ? detail.slice(0, 800) : detail });
  console.log(`${ok ? "  ok  " : "  FAIL"} ${step}${detail ? ` — ${String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 200)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15_000, step = 250) {
  const t = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t > ms) return null;
    await sleep(step);
  }
}

// ---------------------------------------------------------------- build
const t0 = Date.now();
execFileSync("node", [path.join(DESK, "tools/smoke-core/build.mjs"), OUT], { stdio: "inherit" });
execFileSync(path.join(REPO, "node_modules/.bin/vite"), ["build", "--config", path.join(DESK, "vite.config.ts"), "--outDir", path.join(OUT, "renderer"), "--emptyOutDir", "--logLevel", "warn"], { stdio: "inherit", cwd: REPO });
console.log(`build: ${Date.now() - t0} ms → ${OUT}`);

// ---------------------------------------------------------------- server + fixtures
process.on("exit", () => stopServer());
process.on("SIGINT", () => { stopServer(); process.exit(130); });
await startServer();
const info = await seRpc("GetServerInfo");
check("SoftEther VPN Server started", true, `${info.ServerVersionString_str} on ${PORT}, run dir ${RUN}`);

const mkHub = (n, extra = {}) => seRpc("CreateHub", { HubName_str: n, Online_bool: true, AdminPasswordPlainText_str: "", HubType_u32: 0, MaxSession_u32: 0, NoEnum_bool: false, ...extra });
await mkHub("HQ");
await mkHub("SALES", { AdminPasswordPlainText_str: "salespw" });
await mkHub("BRANCH");
await mkHub("LAB");
await seRpc("SetHubOnline", { HubName_str: "LAB", Online_bool: false });
const H = { HubName_str: "HQ" };
await seRpc("CreateGroup", { ...H, Name_str: "staff", Realname_utf: "Staff", Note_utf: "Office employees" });
await seRpc("CreateGroup", { ...H, Name_str: "contractors", Realname_utf: "Contractors", Note_utf: "Limited access", UsePolicy_bool: true, "policy:Ver3_bool": true, "policy:MaxConnection_u32": 2, "policy:TimeOut_u32": 20 });
await seRpc("CreateGroup", { ...H, Name_str: "sites", Realname_utf: "Site gateways", Note_utf: "Cascades from branch offices" });
const cert = await seRpc("GetServerCert");
const user = (p) => seRpc("CreateUser", { ...H, GroupName_str: "", Realname_utf: "", Note_utf: "", ExpireTime_dt: "1970-01-01T00:00:00.000Z", ...p });
await user({ Name_str: "alice", Realname_utf: "Alice Martin", Note_utf: "MacBook Pro", GroupName_str: "staff", AuthType_u32: 1, Auth_Password_str: "Alice#Pass1" });
await user({ Name_str: "bob", Realname_utf: "Bob Stone", GroupName_str: "staff", AuthType_u32: 2, UserX_bin: cert.Cert_bin });
await user({ Name_str: "carol", Realname_utf: "Carol Diaz", GroupName_str: "staff", AuthType_u32: 3, CommonName_utf: "carol.example", Serial_bin: Buffer.from([1, 2, 3]).toString("base64") });
await user({ Name_str: "dave", Realname_utf: "Dave Kim", AuthType_u32: 4, RadiusUsername_utf: "dave@corp" });
await user({ Name_str: "erin", Realname_utf: "Erin Walsh", GroupName_str: "contractors", AuthType_u32: 5, NtUsername_utf: "CORP\\erin" });
await user({ Name_str: "frank", Realname_utf: "Frank Miller", Note_utf: "Contract ended", GroupName_str: "contractors", AuthType_u32: 1, Auth_Password_str: "Frank#Pass1", ExpireTime_dt: new Date(Date.now() - 3 * 86400_000).toISOString() });
// Cascades sign in anonymously (JSON-RPC CreateLink with a plain password fails with error 9 on this build).
await user({ Name_str: "branch-gw", Realname_utf: "Branch office gateway", GroupName_str: "sites", AuthType_u32: 0 });
await user({ Name_str: "sales-gw", Realname_utf: "Sales office gateway", GroupName_str: "sites", AuthType_u32: 0 });
await seRpc("CreateUser", { HubName_str: "SALES", Name_str: "sam", Realname_utf: "Sam Lee", Note_utf: "", GroupName_str: "", AuthType_u32: 1, Auth_Password_str: "Sam#Pass1", ExpireTime_dt: "1970-01-01T00:00:00.000Z" });
await seRpc("EnableSecureNAT", H);
await seRpc("SetHubMsg", { ...H, Msg_bin: Buffer.from("Welcome to the Head Office VPN.\nAuthorised use only. Contact it@example.com for help.").toString("base64") });
const acc = (r) => seRpc("AddAccess", { ...H, AccessListSingle: [{ Active_bool: true, IsIPv6_bool: false, DestIpAddress_ip: "0.0.0.0", DestSubnetMask_ip: "0.0.0.0", SrcIpAddress_ip: "0.0.0.0", SrcSubnetMask_ip: "0.0.0.0", ...r }] });
await acc({ Note_utf: "Block SSH from contractors", Priority_u32: 10, Discard_bool: true, Protocol_u32: 6, SrcUsername_str: "erin", DestPortStart_u32: 22, DestPortEnd_u32: 22 });
await acc({ Note_utf: "Allow DNS", Priority_u32: 20, Discard_bool: false, Protocol_u32: 17, DestIpAddress_ip: "192.168.30.1", DestSubnetMask_ip: "255.255.255.255", DestPortStart_u32: 53, DestPortEnd_u32: 53 });
await acc({ Note_utf: "Isolate lab subnet", Priority_u32: 30, Discard_bool: true, Protocol_u32: 0, DestIpAddress_ip: "10.50.0.0", DestSubnetMask_ip: "255.255.0.0", Active_bool: false });
await seRpc("SetAcList", { ...H, ACList: [
  { Id_u32: 0, Priority_u32: 10, Deny_bool: false, Masked_bool: true, IpAddress_ip: "192.168.1.0", SubnetMask_ip: "255.255.255.0" },
  { Id_u32: 0, Priority_u32: 20, Deny_bool: true, Masked_bool: false, IpAddress_ip: "203.0.113.5", SubnetMask_ip: "0.0.0.0" },
] });
await seRpc("CreateListener", { Port_u32: PORT + 1, Enable_bool: true });
const link = (hub, name, user) => seRpc("CreateLink", {
  HubName_Ex_str: hub, AccountName_utf: name, Hostname_str: "127.0.0.1", Port_u32: PORT, HubName_str: "HQ",
  AuthType_u32: 0, Username_str: user, CheckServerCert_bool: false, MaxConnection_u32: 2, UseEncrypt_bool: true, Online_bool: false, ProxyType_u32: 0,
});
await link("BRANCH", "to-head-office", "branch-gw");
await link("SALES", "to-head-office", "sales-gw");
await seRpc("SetLinkOnline", { HubName_str: "BRANCH", AccountName_utf: "to-head-office" });
await seRpc("SetLinkOnline", { HubName_str: "SALES", AccountName_utf: "to-head-office" });
await seRpc("CreateLink", { HubName_Ex_str: "HQ", AccountName_utf: "old-datacenter", Hostname_str: "127.0.0.1", Port_u32: 1, HubName_str: "DC", Online_bool: false,
  AuthType_u32: 0, Username_str: "hq", MaxConnection_u32: 1, UseEncrypt_bool: true, ProxyType_u32: 0 });
await seRpc("SetLinkOnline", { HubName_str: "HQ", AccountName_utf: "old-datacenter" });
const sessions = await until(async () => {
  const l = (await seRpc("EnumSession", H)).SessionList ?? [];
  return l.filter((s) => s.Username_str === "branch-gw" || s.Username_str === "sales-gw").length === 2 ? l : null;
}, 40_000);
check("fixtures: 4 hubs, 8 users, 3 groups, access lists, SecureNAT and two live cascades", !!sessions,
  sessions ? sessions.map((s) => `${s.Name_str} (${s.Username_str})`).join(", ") : "cascade sessions did not appear");

// ---------------------------------------------------------------- app
let app;
const DATA = mkdtempSync(path.join(os.tmpdir(), "sem-polish-"));
const problems = [];
try {
  app = await electron.launch({ executablePath: require("electron"), args: [OUT], env: { ...process.env, SEM_DATA_DIR: DATA, SEM_INSECURE_KEYSTORE: "1" }, timeout: 60_000 });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow, nativeTheme }) => { nativeTheme.themeSource = "light"; const w = BrowserWindow.getAllWindows()[0]; w?.setSize(1360, 880); w?.setPosition(40, 40); });
  page.on("console", (m) => { if (m.type() === "error" || /Content Security Policy|Refused to/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.waitForLoadState("load");

  const ids = await page.evaluate(async ({ port, pw }) => {
    const probe = await window.sem.api({ method: "POST", path: "/api/servers/probe", body: { host: "127.0.0.1", port } });
    const fp = probe.body.fingerprint;
    const add = (b) => window.sem.api({ method: "POST", path: "/api/servers", body: { transport: "native", tlsMode: "pin", fingerprint: fp, host: "127.0.0.1", port, savePassword: true, ...b } });
    const hq = await add({ name: "Head Office", password: pw, tags: ["production", "eu"] });
    const sales = await add({ name: "Sales (hub admin)", hub: "SALES", password: "salespw", tags: ["sales"] });
    const locked = await add({ name: "Branch Office", password: pw, savePassword: false, tags: ["branch"] });
    const edge = await add({ name: "Frankfurt Edge", host: "127.0.0.1", port: 1, password: "x", tlsMode: "insecure", fingerprint: undefined, tags: ["production"] });
    return { hq: hq.body.id, sales: sales.body.id, locked: locked.body.id, edge: edge.body.id, statuses: [hq.status, sales.status, locked.status, edge.status], ok: hq.body.state?.ok };
  }, { port: PORT, pw: ADMIN_PW });
  check("connections added: online, hub-admin, locked (password not saved), unreachable", ids.ok && ids.statuses.every((s) => s === 201), JSON.stringify(ids));
  const sid = ids.hq;
  await page.reload();
  await page.waitForLoadState("load");
  // Chromium screenshots can't see the window's vibrancy (the sidebar is transparent over it): paint the sidebar with
  // the no-vibrancy fallback, exactly as html[data-material="none"] does. The real window is captured separately below.
  const PAINT = ".sem-sidebar { background: linear-gradient(var(--sem-bg-sidebar), var(--sem-bg-sidebar)), var(--sem-bg-window) !important; } .sem-sb-status { background: var(--sem-bg-sidebar) !important; }";
  await page.addStyleTag({ content: PAINT });

  const theme = async (t) => {
    await app.evaluate(({ nativeTheme }, v) => { nativeTheme.themeSource = v; }, t);
    await page.emulateMedia({ colorScheme: t });
    await sleep(350);
  };
  const dismissToasts = async () => {
    await page.evaluate(() => document.querySelectorAll(".mantine-Notification-closeButton").forEach((b) => b.click()));
    await sleep(150);
  };
  const settle = async () => {
    await until(async () => (await page.locator(".sem-skeleton-row, .sem-skeleton-prop, .sem-loading, .sem-page .mantine-Loader-root").count()) === 0, 10_000, 200);
    await sleep(450);
  };
  const digest = (f) => createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16);
  const shot = async (name, { keepToasts = false } = {}) => {
    if (ONLY && !ONLY.test(name)) return;
    if (!keepToasts) await dismissToasts();
    await page.mouse.move(1350, 870);
    for (const t of ["light", "dark"]) {
      await theme(t);
      const f = path.join(SHOTS, `${name}-${t}.png`);
      await page.screenshot({ path: f, scale: "css" });
      shots.push({ name: `${name}-${t}.png`, sha256_16: digest(f) });
      a11y.push({ shot: `${name}-${t}`, ...(await scanA11y()) });
    }
    await theme("light");
  };
  // Automated WCAG 2.1 AA scan of what is on screen: contrast of every visible text run against its composited
  // background (1.4.3; disabled controls and placeholders are exempt), buttons/links without an accessible name
  // (4.1.2), form fields without a label (1.3.1/3.3.2), images without alt (1.1.1).
  const scanA11y = () => page.evaluate(() => {
    const parse = (c) => {
      let m = c.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
      m = c.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.]+))?\)/);
      if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] === undefined ? 1 : +m[4]];
      return null;
    };
    const over = (top, under) => { const a = top[3]; return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1]; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const dark = document.documentElement.getAttribute("data-mantine-color-scheme") === "dark";
    const base = dark ? [30, 30, 32, 1] : [255, 255, 255, 1];
    const bgOf = (el) => {
      const layers = [];
      for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
        const cs = getComputedStyle(e);
        const c = parse(cs.backgroundColor);
        if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
      }
      let bg = base;
      for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
      return bg;
    };
    const lowContrast = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent.trim();
      if (!text || text.length < 2) continue;
      const el = n.parentElement;
      if (!el || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      if (el.closest("[aria-hidden='true'], :disabled, [data-disabled], [aria-disabled='true'], .mantine-Tooltip-tooltip, [inert]")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      const cs = getComputedStyle(el);
      let fg = parse(cs.color);
      if (!fg) continue;
      let op = 1;
      for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity;
      const bg = bgOf(el);
      fg = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
      const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      const cr = ratio(fg, bg);
      if (cr + 0.005 < need) {
        const key = `${text.slice(0, 40)}|${el.className}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lowContrast.push({ text: text.slice(0, 50), ratio: +cr.toFixed(2), need, cls: String(el.className).slice(0, 60), fg: fg.slice(0, 3).map(Math.round).join(","), bg: bg.slice(0, 3).map(Math.round).join(",") });
      }
    }
    const nameOf = (e) => (e.getAttribute("aria-label") || e.getAttribute("aria-labelledby") || e.getAttribute("title") || e.textContent || "").trim()
      || [...e.querySelectorAll("img[alt], svg title")].map((x) => x.getAttribute?.("alt") ?? x.textContent).join("").trim();
    const vis = (e) => e.checkVisibility?.({ visibilityProperty: true }) ?? true;
    const unnamed = [...document.querySelectorAll("button, a[href], [role='button'], [role='link'], [role='menuitem'], [role='tab']")]
      .filter((e) => vis(e) && !e.closest("[aria-hidden='true']") && !nameOf(e))
      .map((e) => e.outerHTML.slice(0, 120));
    const unlabeled = [...document.querySelectorAll("input:not([type=hidden]), textarea, select")]
      .filter((e) => vis(e) && e.type !== "hidden" && !e.closest("[aria-hidden='true']") && !(e.getAttribute("aria-label") || e.getAttribute("aria-labelledby") || e.labels?.length || e.getAttribute("title")))
      .map((e) => e.outerHTML.slice(0, 120));
    const noAlt = [...document.querySelectorAll("img:not([alt])")].filter(vis).map((e) => e.outerHTML.slice(0, 120));
    return { lowContrast, unnamed, unlabeled, noAlt };
  });

  const go = async (hash) => { await page.evaluate((h) => { location.hash = h; }, hash); await sleep(300); };
  const title = () => page.locator(".sem-page-title").first().innerText().catch(() => "");

  // Per-page DOM audit for the consistency sweep: one PageHeader, title = nav label, button casing, raw Mantine
  // alerts/cards, table row height, empty states.
  const auditPage = async (name, label) => {
    const a = await page.evaluate(() => {
      const q = (s) => [...document.querySelectorAll(s)];
      const vis = (e) => e.checkVisibility?.() ?? true;
      const content = document.querySelector(".sem-content");
      const buttons = q(".sem-content button.mantine-Button-root").filter(vis).map((b) => b.innerText.trim()).filter(Boolean);
      const titles = q(".sem-content .sem-page-title").map((e) => e.innerText.trim());
      const rows = q(".sem-content .sem-table tbody tr").filter(vis).slice(0, 3).map((r) => Math.round(r.getBoundingClientRect().height));
      const sectionTitles = q(".sem-content .sem-section-title, .sem-content .sem-form-section-title").map((e) => e.innerText.trim());
      return {
        titles, buttons, rows, sectionTitles,
        rawAlerts: q(".sem-content .mantine-Alert-root").length,
        borderedCards: q(".sem-content .mantine-Paper-root[data-with-border], .sem-content .mantine-Card-root").length,
        badges: q(".sem-content .mantine-Badge-root").length,
        errors: q(".sem-content .sem-error").map((e) => e.innerText.replace(/\s+/g, " ").slice(0, 160)),
        headerActionSizes: q(".sem-page-actions .mantine-Button-root").map((b) => `${b.dataset.size ?? "?"}/${b.dataset.variant ?? "?"}`),
        scrollW: content ? content.scrollWidth - content.clientWidth : 0,
        // Single-line controls should all be 26 px (sm) or 22 px (xs); anything else is a height outlier.
        controlHeights: [...new Set(q(".sem-content .mantine-Input-input:not(textarea), .sem-content .mantine-Button-root, .sem-content .mantine-SegmentedControl-root")
          .filter(vis).map((e) => `${e.className.match(/mantine-(\w+)-(input|root)/)?.[1] ?? "?"}:${Math.round(e.getBoundingClientRect().height)}`))].sort(),
      };
    });
    const titleCase = (s) => s.replace(/[…]/g, "").split(/\s+/).filter((w) => /^[a-z]/.test(w) && !/^(a|an|and|as|at|by|for|in|of|on|or|the|to|via|with|from)$/.test(w));
    const casing = a.buttons.filter((b) => titleCase(b).length).map((b) => b);
    audit.push({ page: name, label, ...a, casingSuspects: casing, titleMatches: label ? a.titles[0] === label : undefined });
  };

  // ============================================================== global
  await go("#/");
  await page.locator(".sem-page-title", { hasText: "Overview" }).waitFor({ timeout: 20_000 });
  await until(async () => (await page.locator('[data-testid^="fleet-row-"]').count()) === 4, 20_000);
  await settle();
  await shot("01-fleet");
  await auditPage("fleet", "Overview");

  const sections = await page.evaluate(() => null);
  void sections;
  // Server pages, in navigation order (labels from the scope navigation).
  await go(`#/servers/${sid}`);
  await page.locator(".sem-page-title").first().waitFor({ timeout: 20_000 });
  const serverNav = await page.locator('[data-testid="scope-nav"] a').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute("href"), label: a.innerText.trim() })));
  check("server scope navigation lists the server pages", serverNav.length >= 15, serverNav.map((n) => n.label).join(", "));
  let i = 0;
  for (const n of serverNav) {
    i++;
    const slug = `02-server-${String(i).padStart(2, "0")}-${(n.href.split("/").pop() || "overview").replace(/[^a-z0-9]+/gi, "-")}`;
    if (ONLY && !ONLY.test(slug)) continue;
    await go(n.href.replace(/^#?/, "#"));
    await until(async () => (await title()) === n.label, 12_000);
    await settle();
    await shot(slug);
    await auditPage(slug, n.label);
  }

  // Hub pages of HQ.
  await go(`#/servers/${sid}/hubs/HQ`);
  await page.locator(".sem-page-title").first().waitFor({ timeout: 20_000 });
  const hubNav = await page.locator('[data-testid="scope-nav"] a').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute("href"), label: a.innerText.trim() })));
  i = 0;
  for (const n of hubNav) {
    i++;
    const slug = `03-hub-${String(i).padStart(2, "0")}-${(n.href.split("/").pop() || "status").replace(/[^a-z0-9]+/gi, "-")}`;
    if (ONLY && !ONLY.test(slug)) continue;
    await go(n.href.replace(/^#?/, "#"));
    await until(async () => (await title()) === n.label, 12_000);
    await settle();
    await shot(slug);
    await auditPage(slug, n.label);
  }

  // Client deployment pages.
  await go("#/deploy");
  await page.locator(".sem-page-title").first().waitFor({ timeout: 20_000 });
  const depNav = await page.locator('[data-testid="scope-nav"] a').evaluateAll((as) => as.map((a) => ({ href: a.getAttribute("href"), label: a.innerText.trim() })));
  i = 0;
  for (const n of depNav) {
    i++;
    const slug = `04-deploy-${String(i).padStart(2, "0")}-${(n.href.split("/").pop() || "deploy").replace(/[^a-z0-9]+/gi, "-")}`;
    if (ONLY && !ONLY.test(slug)) continue;
    await go(n.href.replace(/^#?/, "#"));
    await until(async () => (await title()) === n.label, 12_000);
    await settle();
    await shot(slug);
    await auditPage(slug, n.label);
  }

  // Other connection states.
  // Forget the session password (what "Lock" in the sidebar menu does), then reload so every view sees it.
  await page.evaluate((id) => window.sem.api({ method: "POST", path: `/api/servers/${id}/lock` }), ids.locked);
  await go(`#/servers/${ids.locked}`);
  await page.reload();
  await page.waitForLoadState("load");
  await page.addStyleTag({ content: PAINT });
  await settle(); await shot("05-server-locked"); await auditPage("server-locked");
  await go(`#/servers/${ids.edge}`); await settle(); await sleep(800); await shot("05-server-unreachable"); await auditPage("server-unreachable");
  await go(`#/servers/${ids.sales}/hubs/SALES`); await settle(); await shot("05-hub-admin-status"); await auditPage("hub-admin-status");
  await go("#/preferences"); await settle(); await shot("06-preferences"); await auditPage("preferences", "Preferences");

  // ============================================================== overlays
  // Add Connection sheet
  await go("#/");
  await settle();
  await page.getByTestId("fleet-add").click();
  await page.getByTestId("conn-host").waitFor();
  await sleep(350);
  await shot("07-sheet-add-connection");
  const sheetGap = async (label) => {
    const g = await page.evaluate(() => {
      const body = [...document.querySelectorAll(".sem-sheet-body")].pop();
      if (!body) return null;
      const first = [...body.querySelectorAll("*")].find((e) => e.getBoundingClientRect().height > 0 && e.children.length === 0 || e.classList.contains("sem-form-box"));
      const box = body.querySelector(".sem-form-box");
      const top = body.getBoundingClientRect().top;
      return { firstContent: first ? Math.round(first.getBoundingClientRect().top - top) : null, firstBox: box ? Math.round(box.getBoundingClientRect().top - top) : null, hasTitle: !!body.querySelector(".sem-form-section-title") };
    });
    results.push({ step: `sheet top spacing: ${label}`, ok: g ? (g.firstContent ?? 99) <= 12 : false, detail: g });
    console.log(`  ${g && (g.firstContent ?? 99) <= 12 ? "ok  " : "FAIL"} sheet top spacing: ${label} — ${JSON.stringify(g)}`);
  };
  await sheetGap("Add Connection");
  await page.keyboard.press("Escape");
  await sleep(300);

  // Create Hub sheet
  await go(`#/servers/${sid}/hubs`);
  await settle();
  await page.getByTestId("hub-create").click();
  await sleep(450);
  await shot("07-sheet-new-hub");
  await sheetGap("New Virtual Hub");
  await page.keyboard.press("Escape");
  await sleep(300);

  // Delete-hub confirmation (typed)
  await page.getByTestId("hub-row-LAB").click({ button: "right" });
  await page.getByText("Delete Hub…", { exact: false }).click();
  await page.getByTestId("confirm-type").waitFor();
  await sleep(300);
  await shot("08-confirm-delete-hub");
  await page.keyboard.press("Escape");
  await sleep(400);

  // Users: new-user sheet + disabled toolbar buttons
  await go(`#/servers/${sid}/hubs/HQ/users`);
  await settle();
  await page.getByTestId("create-user").click();
  await page.getByTestId("user-sheet").waitFor().catch(() => {});
  await sleep(450);
  await shot("07-sheet-new-user");
  await sheetGap("New User");
  await page.keyboard.press("Escape");
  await sleep(300);

  // Access list rule sheet, cascade sheet
  await go(`#/servers/${sid}/hubs/HQ/access`);
  await settle();
  await page.getByTestId("create-access").click();
  await sleep(450);
  await shot("07-sheet-new-access-rule");
  await sheetGap("New Access Rule");
  await page.keyboard.press("Escape");
  await sleep(300);
  await go(`#/servers/${sid}/hubs/HQ/cascades`);
  await settle();
  await page.getByTestId("create-link").click();
  await sleep(450);
  await shot("07-sheet-new-cascade");
  await sheetGap("New Cascade Connection");
  await page.keyboard.press("Escape");
  await sleep(300);

  // Disabled vs enabled default buttons (Connections: Get Info / Disconnect need a selection)
  await go(`#/servers/${sid}/connections`);
  await settle();
  const btn = await page.evaluate(() => {
    const get = (id) => document.querySelector(`[data-testid="${id}"]`);
    const cs = (e) => e && getComputedStyle(e);
    const dis = get("connection-info");
    const en = [...document.querySelectorAll(".sem-content .mantine-Button-root[data-variant='default']:not(:disabled)")][0];
    const probe = document.createElement("span");
    probe.style.color = "var(--sem-text-3)";
    document.body.appendChild(probe);
    const t3 = getComputedStyle(probe).color;
    probe.remove();
    return { disabled: dis?.disabled, disabledColor: cs(dis)?.color, disabledBg: cs(dis)?.backgroundColor, enabledColor: cs(en)?.color, enabledBg: cs(en)?.backgroundColor, text3: t3,
      redDisabledColor: cs(get("connection-disconnect"))?.color };
  });
  check("disabled default buttons use the disabled text colour (also over an inline c= colour)",
    btn.disabled && btn.disabledColor === btn.text3 && btn.redDisabledColor === btn.text3 && btn.disabledColor !== btn.enabledColor, btn);

  // Connections inspector: Esc after a confirmation dialog (the page's local workaround was removed)
  const firstConn = page.locator('[data-testid^="connection-row-"]').first();
  await firstConn.dblclick();
  await page.getByTestId("connection-drawer").locator(".sem-inspector-title").waitFor();
  await page.getByTestId("connection-drawer-disconnect").click();
  await page.getByTestId("connection-disconnect-cancel").waitFor();
  await page.keyboard.press("Escape");
  await sleep(500);
  const stillOpen = await page.locator('[data-testid="connection-drawer"][data-open]').count();
  await page.keyboard.press("Escape");
  await sleep(400);
  const closed = await page.locator('[data-testid="connection-drawer"][data-open]').count();
  const lingering = await page.locator(".mantine-Modal-root").count();
  check("Inspector: Esc closes the confirmation first, then the Inspector (closed modal roots linger in the DOM)", stillOpen === 1 && closed === 0 && lingering > 0,
    `after 1st Esc open=${stillOpen}, after 2nd Esc open=${closed}, .mantine-Modal-root in DOM=${lingering}`);

  // Sessions: inspector of a cascade user session (node info) and a server-created session
  await go(`#/servers/${sid}/hubs/HQ/sessions`);
  await settle();
  const hqSessions = (await seRpc("EnumSession", H)).SessionList;
  const gw = hqSessions.find((s) => s.Username_str === "sales-gw");
  await page.getByTestId(`session-row-${gw.Name_str}`).dblclick();
  await page.getByTestId("session-status").waitFor({ timeout: 15_000 });
  await sleep(500);
  await shot("09-inspector-session-cascade-user");
  const raw = await seRpc("GetSessionStatus", { ...H, Name_str: gw.Name_str });
  const props = await page.getByTestId("session-status").evaluate((el) => Object.fromEntries([...el.querySelectorAll(".sem-props-row")].map((r) => [r.querySelector("dt")?.innerText.trim(), r.querySelector("dd")?.innerText.trim()])));
  const port = Number(props.Port);
  check("session details: reported client port and version are byte-swapped like Server Manager",
    port > 0 && port < 65536 && /^\d\.\d\d build \d+$/.test(props.Version ?? ""),
    { raw: { ClientPort_u32: raw.ClientPort_u32, ClientProductVer_u32: raw.ClientProductVer_u32, ClientProductBuild_u32: raw.ClientProductBuild_u32, ServerPort2_u32: raw.ServerPort2_u32 },
      shown: { Port: props.Port, Version: props.Version, "Server port": props["Server port"], Product: props.Product } });
  // Esc with the Inspector open after a confirmation
  await page.getByTestId("session-disconnect").click();
  await page.getByTestId("disconnect-session-cancel").waitFor();
  await page.keyboard.press("Escape");
  await sleep(500);
  const sOpen = await page.locator('[data-testid="session-inspector"][data-open]').count();
  await page.keyboard.press("Escape");
  await sleep(400);
  check("Sessions Inspector: Esc after cancelling a confirmation closes it", sOpen === 1 && (await page.locator('[data-testid="session-inspector"][data-open]').count()) === 0);

  const nat = hqSessions.find((s) => s.SecureNATMode_bool);
  if (nat) {
    await page.getByTestId(`session-row-${nat.Name_str}`).dblclick();
    await page.getByTestId("session-status").waitFor({ timeout: 15_000 });
    await sleep(500);
    const txt = await page.getByTestId("session-inspector").innerText();
    check("SecureNAT session hides client-reported node info (as Server Manager does)", !/Reported by the client|Authenticated as/.test(txt), txt.slice(0, 200).replace(/\s+/g, " "));
    await shot("09-inspector-session-securenat");
    await page.keyboard.press("Escape");
    await sleep(300);
  }
  const salesSide = (await seRpc("EnumSession", { HubName_str: "BRANCH" })).SessionList?.find((s) => s.LinkMode_bool);
  if (salesSide) {
    await go(`#/servers/${sid}/hubs/BRANCH/sessions`);
    await settle();
    await page.getByTestId(`session-row-${salesSide.Name_str}`).dblclick();
    await page.getByTestId("session-status").waitFor({ timeout: 15_000 });
    await sleep(500);
    const txt = await page.getByTestId("session-inspector").innerText();
    const rawC = await seRpc("GetSessionStatus", { HubName_str: "BRANCH", Name_str: salesSide.Name_str });
    check("Cascade session (link side) hides client-reported node info", !/Reported by the client/.test(txt),
      { username: rawC.Username_str, ClientPort_u32: rawC.ClientPort_u32, ClientProductVer_u32: rawC.ClientProductVer_u32 });
    await shot("09-inspector-session-cascade");
    await page.keyboard.press("Escape");
    await sleep(300);
  }

  // Cascade status inspector
  await go(`#/servers/${sid}/hubs/SALES/cascades`);
  await settle();
  await page.locator('[data-testid^="link-row-"], .sem-table tbody tr').first().dblclick().catch(() => {});
  await sleep(1200);
  await shot("09-inspector-cascade-status");
  await page.keyboard.press("Escape");
  await sleep(300);

  // Quick switcher, context menu
  await go(`#/servers/${sid}/hubs/HQ/users`);
  await settle();
  await page.getByTestId("user-row-alice").click({ button: "right" });
  await sleep(250);
  await shot("10-context-menu-user");
  await page.keyboard.press("Escape");
  await sleep(200);
  await page.keyboard.press("Meta+k");
  await page.getByTestId("quick-input").waitFor();
  await page.getByTestId("quick-input").fill("sess");
  await sleep(300);
  await shot("10-quick-switcher");
  await page.keyboard.press("Escape");
  await sleep(300);

  // ============================================================== real window (vibrancy)
  // Remove the painted sidebar and capture the actual window with screencapture -l (needs Screen Recording).
  await page.evaluate(() => document.querySelectorAll("style").forEach((s) => { if (s.textContent?.includes("linear-gradient(var(--sem-bg-sidebar)")) s.remove(); }));
  const winInfo = async () => app.evaluate(({ BrowserWindow, app: a }) => {
    const w = BrowserWindow.getAllWindows()[0];
    a.focus({ steal: true }); w.show(); w.focus();
    return { id: w.getMediaSourceId().split(":")[1], bounds: w.getBounds(), scale: 0 };
  });
  const measure = async (file, bounds) => app.evaluate(({ nativeImage }, { file, bounds }) => {
    const img = nativeImage.createFromPath(file);
    const { width, height } = img.getSize();
    const sx = width / bounds.width, sy = height / bounds.height;
    const region = (x0, y0, x1, y1) => {
      const bmp = img.crop({ x: Math.round(x0 * sx), y: Math.round(y0 * sy), width: Math.round((x1 - x0) * sx), height: Math.round((y1 - y0) * sy) }).toBitmap();
      let sum = 0, n = 0;
      for (let i = 0; i + 3 < bmp.length; i += 4) { sum += 0.0722 * bmp[i] + 0.7152 * bmp[i + 1] + 0.2126 * bmp[i + 2]; n++; } // BGRA
      return Math.round(sum / n);
    };
    return { size: [width, height], sidebar: region(30, 560, 220, 780), content: region(700, 820, 1300, 860) };
  }, { file, bounds });
  const realShot = async (name, schemeNative, schemeApp) => {
    await app.evaluate(({ nativeTheme }, v) => { nativeTheme.themeSource = v; }, schemeNative);
    await page.emulateMedia({ colorScheme: schemeNative });
    await page.evaluate((s) => { localStorage.setItem("mantine-color-scheme-value", s); }, schemeApp);
    await page.reload();
    await page.waitForLoadState("load");
    await page.locator(".sem-page-title").first().waitFor({ timeout: 20_000 });
    await settle();
    await sleep(900);
    const w = await winInfo();
    await sleep(600);
    const f = path.join(SHOTS, `11-real-window-${name}.png`);
    try {
      execFileSync("screencapture", ["-x", "-o", "-l", w.id, f]);
    } catch (e) { return { error: String(e.message).slice(0, 200) }; }
    if (!existsSync(f)) return { error: "screencapture wrote nothing (Screen Recording permission?)" };
    shots.push({ name: path.basename(f), sha256_16: digest(f) });
    const m = await measure(f, w.bounds);
    return { ...m, material: await page.evaluate(() => document.documentElement.dataset.material ?? "window") };
  };
  await go("#/");
  const real = {};
  real["fleet-light"] = await realShot("fleet-light", "light", "auto");
  real["fleet-dark"] = await realShot("fleet-dark", "dark", "auto");
  await go(`#/servers/${sid}/hubs/HQ/users`);
  real["users-dark"] = await realShot("users-dark", "dark", "auto");
  await go("#/preferences");
  real["prefs-app-dark-system-light"] = await realShot("prefs-app-dark-system-light", "light", "dark");
  real["prefs-app-light-system-dark"] = await realShot("prefs-app-light-system-dark", "dark", "light");
  await page.evaluate(() => localStorage.setItem("mantine-color-scheme-value", "auto"));
  const r = real;
  const captured = Object.values(r).every((x) => !x.error);
  check("real window captured with screencapture -l (vibrancy included)", captured, r);
  if (captured) {
    check("real window, dark: the sidebar material is dark (vibrancy follows the system appearance)", r["fleet-dark"].sidebar < 90 && r["users-dark"].sidebar < 90,
      `sidebar luminance fleet ${r["fleet-dark"].sidebar}, users ${r["users-dark"].sidebar} (0–255)`);
    check("real window, light: the sidebar material is light", r["fleet-light"].sidebar > 170, `sidebar luminance ${r["fleet-light"].sidebar}`);
    check("appearance override (app Dark, system Light): sidebar painted dark instead of the light material",
      r["prefs-app-dark-system-light"].sidebar < 90 && r["prefs-app-dark-system-light"].material === "none", r["prefs-app-dark-system-light"]);
    check("appearance override (app Light, system Dark): sidebar painted light", r["prefs-app-light-system-dark"].sidebar > 170 && r["prefs-app-light-system-dark"].material === "none", r["prefs-app-light-system-dark"]);
  }
} catch (e) {
  check("run completed", false, e.stack ?? String(e));
} finally {
  try { await app?.close(); } catch { /* ignore */ }
  stopServer();
  rmSync(DATA, { recursive: true, force: true });
}

check("no console errors, CSP violations or page errors", problems.length === 0, problems.slice(0, 8).join(" | "));
{
  const lc = new Map(), un = new Map(), ul = new Map(), na = new Map();
  for (const x of a11y) {
    for (const c of x.lowContrast) { const k = `${c.text} (${c.ratio}:1 < ${c.need}, ${c.cls})`; lc.set(k, [...(lc.get(k) ?? []), x.shot]); }
    for (const c of x.unnamed) un.set(c, [...(un.get(c) ?? []), x.shot]);
    for (const c of x.unlabeled) ul.set(c, [...(ul.get(c) ?? []), x.shot]);
    for (const c of x.noAlt) na.set(c, [...(na.get(c) ?? []), x.shot]);
  }
  const top = (m) => [...m.entries()].map(([k, v]) => `${k} ×${v.length} [${v.slice(0, 3).join(", ")}]`);
  results.push({ step: "a11y scan: text contrast (WCAG 1.4.3) across all captured screens", ok: lc.size === 0, detail: top(lc) });
  results.push({ step: "a11y scan: buttons and links have an accessible name (WCAG 4.1.2)", ok: un.size === 0, detail: top(un) });
  results.push({ step: "a11y scan: form fields are labelled (WCAG 1.3.1 / 3.3.2)", ok: ul.size === 0, detail: top(ul) });
  results.push({ step: "a11y scan: images have alt text (WCAG 1.1.1)", ok: na.size === 0, detail: top(na) });
  for (const r of results.slice(-4)) console.log(`${r.ok ? "  ok  " : "  FAIL"} ${r.step} — ${r.detail.length} distinct`);
}
if (ROUND) {
  const dir = path.join(SHOTS, `round-${ROUND}`);
  mkdirSync(dir, { recursive: true });
  for (const s of shots) copyFileSync(path.join(SHOTS, s.name), path.join(dir, s.name));
}
const report = {
  when: new Date().toISOString(), round: ROUND || null, server: { port: PORT, run: RUN }, build: OUT,
  passed: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length,
  results, screenshots: shots, audit, a11y,
};
writeFileSync(path.join(SHOTS, ROUND ? `report-round-${ROUND}.json` : "report.json"), JSON.stringify(report, null, 2));
console.log(`\n${report.passed} passed, ${report.failed} failed, ${shots.length} screenshots → ${SHOTS}`);
process.exit(report.failed ? 1 : 0);
