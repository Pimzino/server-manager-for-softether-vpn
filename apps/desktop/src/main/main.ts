// Electron main process: app lifecycle, the window, the native menu, the in-process API and the
// background scheduler. See docs/desktop-architecture.md.
import { app, BrowserWindow, dialog, Menu, nativeTheme, powerMonitor, session, shell, type MenuItemConstructorOptions } from "electron";
import type { FastifyInstance } from "fastify";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CH } from "../shared/ipc.ts";
import { initKeystore, initPaths } from "./core/config.ts";
import { closeDb, initDb } from "./core/db.ts";
import { buildApi } from "./core/api.ts";
import { startScheduler, stopScheduler } from "./core/scheduler.ts";
import { resetAgents } from "./softether/client.ts";
import { closeNativeSessions } from "./softether/native.ts";
import { registerIpc } from "./ipc.ts";

const APP_NAME = "Server Manager for SoftEther VPN";
const DOCS_URL = "https://www.softether.org/4-docs";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const devServer = process.env.SEM_DEV_SERVER || null;
const rendererDir = path.resolve(import.meta.dirname, "../renderer");
const preloadPath = path.resolve(import.meta.dirname, "../preload/preload.cjs");

app.setName(APP_NAME);
if (isWin) app.setAppUserModelId("com.softethermanager.desktop");
// Must precede requestSingleInstanceLock: with SEM_DATA_DIR the lock (and Chromium's profile) live there.
const paths = initPaths();

let mainWindow: BrowserWindow | null = null;
let api: FastifyInstance | null = null;
let shuttingDown = false;

function isRendererUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (devServer) return u.origin === new URL(devServer).origin;
    if (u.protocol !== "file:") return false;
    // Windows paths are case-insensitive (drive letter / folder casing can differ between the
    // URL Electron builds and import.meta.dirname).
    const fold = (p: string) => (isWin ? p.toLowerCase() : p);
    const file = fold(fileURLToPath(`${u.protocol}//${u.host}${u.pathname}`));
    const dir = fold(rendererDir);
    return file === dir || file.startsWith(dir + path.sep);
  } catch {
    return false;
  }
}

function isOurWebContents(id: number): boolean {
  return BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.id === id);
}

/** Strict CSP for the renderer (dev adds the Vite HMR socket and its inline React-refresh preamble). */
function contentSecurityPolicy(): string {
  const dev = devServer ? new URL(devServer) : null;
  return [
    "default-src 'self'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    dev ? `connect-src 'self' ws://${dev.host} ${dev.origin}` : "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function hardenSession() {
  const ses = session.defaultSession;
  const csp = contentSecurityPolicy();
  ses.webRequest.onHeadersReceived((details, cb) => {
    if (!isRendererUrl(details.url)) return cb({ responseHeaders: details.responseHeaders });
    const headers = { ...(details.responseHeaders ?? {}) };
    for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-security-policy") delete headers[k];
    headers["Content-Security-Policy"] = [csp];
    headers["X-Content-Type-Options"] = ["nosniff"];
    cb({ responseHeaders: headers });
  });
  // No camera, microphone, notifications, geolocation...: only sanitized clipboard writes.
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "clipboard-sanitized-write"));
  ses.setPermissionCheckHandler((_wc, permission) => permission === "clipboard-sanitized-write");
}

function openExternalSafe(url: string) {
  try {
    const u = new URL(url);
    if (["https:", "http:", "mailto:"].includes(u.protocol)) void shell.openExternal(u.toString());
  } catch { /* ignore malformed */ }
}

function sendMenu(action: string) {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow();
  const send = () => win.webContents.send(CH.menu, action);
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send); else send();
  if (win.isMinimized()) win.restore();
  win.focus();
}

function overlaySymbolColor() {
  return nativeTheme.shouldUseDarkColors ? "#e6e6e9" : "#1d1d22";
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    title: APP_NAME,
    show: false,
    backgroundColor: "#00000000",
    ...(isMac ? {
      titleBarStyle: "hiddenInset" as const,
      trafficLightPosition: { x: 18, y: 18 },
      vibrancy: "sidebar" as const,
      visualEffectState: "followWindow" as const,
    } : {}),
    ...(isWin ? {
      titleBarStyle: "hidden" as const,
      titleBarOverlay: { color: "#00000000", symbolColor: overlaySymbolColor(), height: 44 },
      backgroundMaterial: "mica" as const,
    } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  mainWindow = win;

  win.once("ready-to-show", () => win.show());
  // Only our own document may be shown; everything else opens in the browser.
  win.webContents.on("will-navigate", (e, url) => {
    if (!isRendererUrl(url)) {
      e.preventDefault();
      openExternalSafe(url);
    }
  });
  win.webContents.on("will-redirect", (e, url) => { if (!isRendererUrl(url)) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: "deny" };
  });
  win.on("closed", () => { if (mainWindow === win) mainWindow = null; });
  // Windows log-off / shutdown / restart does not emit before-quit: close the store here.
  if (isWin) win.on("session-end", shutdown);

  if (devServer) void win.loadURL(devServer);
  else void win.loadFile(path.join(rendererDir, "index.html"));
  return win;
}

function buildMenu() {
  const nav = (label: string, route: string, accelerator?: string): MenuItemConstructorOptions =>
    ({ label, accelerator, click: () => sendMenu(`navigate:${route}`) });
  const prefs: MenuItemConstructorOptions = { label: isMac ? "Settings…" : "Settings", accelerator: "CmdOrCtrl+,", click: () => sendMenu("preferences") };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: APP_NAME,
      submenu: [
        { role: "about" as const },
        { type: "separator" as const },
        prefs,
        { type: "separator" as const },
        { role: "services" as const },
        { type: "separator" as const },
        { role: "hide" as const },
        { role: "hideOthers" as const },
        { role: "unhide" as const },
        { type: "separator" as const },
        { role: "quit" as const },
      ],
    }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Server Connection…", accelerator: "CmdOrCtrl+N", click: () => sendMenu("new-server") },
        { type: "separator" },
        // Refresh the data in the renderer — never reload the page.
        { label: "Refresh", accelerator: "CmdOrCtrl+R", click: () => sendMenu("refresh") },
        { type: "separator" },
        ...(isMac ? [{ role: "close" as const }] : [prefs, { type: "separator" as const }, { role: "quit" as const, label: "Exit" }]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" },
        ...(isMac ? [{ role: "pasteAndMatchStyle" as const }] : []),
        { role: "delete" }, { type: "separator" }, { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        nav("Servers", "/", "CmdOrCtrl+1"),
        nav("Client Deployment", "/deploy", "CmdOrCtrl+2"),
        // The renderer's app settings page is /preferences (there is no /settings route).
        nav("Settings", "/preferences", "CmdOrCtrl+3"),
        { type: "separator" },
        ...(!app.isPackaged ? [{ role: "toggleDevTools" as const }, { type: "separator" as const }] : []),
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" }, { role: "zoom" },
        ...(isMac ? [{ type: "separator" as const }, { role: "front" as const }] : [{ role: "close" as const }]),
      ],
    },
    {
      role: "help",
      submenu: [
        { label: "SoftEther VPN Documentation", click: () => openExternalSafe(DOCS_URL) },
        { label: "SoftEther VPN on GitHub", click: () => openExternalSafe("https://github.com/SoftEtherVPN/SoftEtherVPN") },
        ...(!isMac ? [{ type: "separator" as const }, { role: "about" as const, label: `About ${APP_NAME}` }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopScheduler();
  try { resetAgents(); } catch { /* ignore */ }
  try { closeNativeSessions(); } catch { /* ignore */ }
  const a = api;
  api = null;
  if (a) void a.close().catch(() => undefined);
  closeDb();
}

async function start() {
  try {
    initKeystore();
    initDb();
  } catch (e) {
    dialog.showErrorBox(APP_NAME, `Cannot open the data store in ${paths.dataDir}:\n\n${(e as Error).message}`);
    app.exit(1);
    return;
  }
  api = await buildApi();
  const theApi = api;
  registerIpc({ api: theApi, dataDir: paths.dataDir, isOurWebContents, isRendererUrl });
  hardenSession();
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: "Manages SoftEther VPN Servers. SoftEther VPN is a trademark of its respective owners.",
    website: DOCS_URL,
  });
  buildMenu();
  if (isWin) {
    nativeTheme.on("updated", () => {
      for (const w of BrowserWindow.getAllWindows()) {
        try { w.setTitleBarOverlay({ color: "#00000000", symbolColor: overlaySymbolColor(), height: 44 }); } catch { /* not overlaid */ }
      }
    });
  }
  // macOS/Linux system shutdown does not emit before-quit either.
  if (!isWin) powerMonitor.on("shutdown", shutdown);
  const win = createWindow();
  win.webContents.once("did-finish-load", () => startScheduler());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    if (w) {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
    } else if (api) {
      createWindow();
    }
  });
  // No <webview> and no other windows than ours.
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (e) => e.preventDefault());
  });
  app.on("activate", () => {
    if (api && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });
  app.on("before-quit", shutdown);
  app.on("will-quit", shutdown);
  app.whenReady().then(start).catch((e) => {
    dialog.showErrorBox(APP_NAME, `Startup failed: ${(e as Error)?.stack ?? e}`);
    app.exit(1);
  });
}
