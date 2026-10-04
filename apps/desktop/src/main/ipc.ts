// IPC handlers behind the preload bridge (src/shared/ipc.ts). Every call is checked to come from
// our own window and our own renderer document; API calls go to the in-process Fastify instance
// through app.inject() (no network listener).
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CH, type ApiRequest, type ApiResponse, type AppInfo, type FileFilter, type SaveResult } from "../shared/ipc.ts";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const MAX_OPEN_FILE = 64 * 1024 * 1024;
const MAX_UPLOAD = 512 * 1024 * 1024;

export interface IpcOptions {
  api: FastifyInstance;
  dataDir: string;
  /** True for the webContents of windows we created. */
  isOurWebContents: (id: number) => boolean;
  /** True for a URL of our renderer (file:// under dist/renderer, or the dev server origin). */
  isRendererUrl: (url: string) => boolean;
}

type Inject = Awaited<ReturnType<FastifyInstance["inject"]>>;

function assertTrusted(o: IpcOptions, e: IpcMainInvokeEvent) {
  const frame = e.senderFrame;
  if (!o.isOurWebContents(e.sender.id) || !frame || frame.parent !== null || !o.isRendererUrl(frame.url)) {
    throw new Error("IPC call rejected: untrusted sender");
  }
}

function windowOf(e: IpcMainInvokeEvent): BrowserWindow | undefined {
  return BrowserWindow.fromWebContents(e.sender) ?? undefined;
}

function checkPath(p: unknown): string {
  if (typeof p !== "string" || !p.startsWith("/api/") || p.includes("\\") || /[\r\n]/.test(p)) {
    throw new Error(`Invalid API path: ${String(p).slice(0, 200)}`);
  }
  return p;
}

function checkFilters(f: unknown): FileFilter[] | undefined {
  if (!Array.isArray(f)) return undefined;
  return f.filter((x): x is FileFilter => !!x && typeof x.name === "string" && Array.isArray(x.extensions)
    && x.extensions.every((ext: unknown) => typeof ext === "string")).slice(0, 20);
}

function parseBody(res: Inject): unknown {
  if (res.statusCode === 204 || res.rawPayload.length === 0) return null;
  const type = String(res.headers["content-type"] ?? "");
  if (type.includes("application/json")) {
    try { return JSON.parse(res.payload); } catch { return res.payload; }
  }
  if (type.startsWith("text/") || type.includes("charset=")) return res.payload;
  return { contentType: type || "application/octet-stream", base64: res.rawPayload.toString("base64") };
}

function errorMessage(res: Inject): string {
  const b = parseBody(res) as { error?: string } | string | null;
  const msg = typeof b === "string" ? b : b?.error;
  return msg || `Request failed with HTTP ${res.statusCode}`;
}

/** RFC 6266 filename from Content-Disposition (filename* preferred), reduced to a safe basename. */
export function dispositionFilename(header: unknown): string | null {
  const h = Array.isArray(header) ? String(header[0]) : typeof header === "string" ? header : "";
  let name: string | null = null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(h);
  if (star) { try { name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")); } catch { name = null; } }
  if (!name) {
    const q = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(h) ?? /filename\s*=\s*([^;]+)/.exec(h);
    if (q) name = q[1].trim().replace(/\\(.)/g, "$1");
  }
  if (!name) return null;
  const base = path.basename(name.replace(/\\/g, "/")).replace(/[\x00-\x1f<>:"|?*]/g, "_").trim();
  return base && base !== "." && base !== ".." ? base : null;
}

function filtersForName(name: string): FileFilter[] | undefined {
  const ext = path.extname(name).slice(1);
  return ext ? [{ name: ext.toUpperCase(), extensions: [ext] }, { name: "All files", extensions: ["*"] }] : undefined;
}

/** multipart/form-data body: fields first (@fastify/multipart only exposes fields that precede the file), then "file". */
export function buildMultipart(fields: Record<string, string>, file: { name: string; data: Buffer; type?: string }) {
  const boundary = `----SemBoundary${randomBytes(12).toString("hex")}`;
  const q = (s: string) => s.replace(/[\r\n]/g, " ").replace(/"/g, "%22");
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${q(k)}"\r\n\r\n${String(v)}\r\n`, "utf8"));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${q(file.name)}"\r\nContent-Type: ${file.type ?? "application/octet-stream"}\r\n\r\n`, "utf8"));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * revealPath only accepts the data directory (and what is inside it) or a file the user picked in a
 * native Save/Open dialog during this session. An arbitrary path from the renderer would otherwise
 * be an existence oracle for the whole disk and, on Windows, a UNC path (\\host\share) would make
 * the OS authenticate to that host (NTLM hash leak).
 */
function createRevealPolicy(dataDir: string) {
  const isWin = process.platform === "win32";
  const fold = (p: string) => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
  const picked = new Set<string>();
  const root = fold(dataDir);
  return {
    remember(p: string) { picked.add(fold(p)); },
    allowed(p: string) {
      const f = fold(p);
      return f === root || f.startsWith(root + path.sep) || picked.has(f);
    },
  };
}

export function registerIpc(o: IpcOptions) {
  const reveal = createRevealPolicy(o.dataDir);
  const handle = <A extends unknown[], R>(channel: string, fn: (e: IpcMainInvokeEvent, ...args: A) => Promise<R> | R) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (e, ...args) => {
      assertTrusted(o, e);
      return fn(e, ...(args as A));
    });
  };

  handle(CH.api, async (_e, req: ApiRequest): Promise<ApiResponse> => {
    if (!req || typeof req !== "object" || !METHODS.has(req.method)) throw new Error("Invalid API request");
    const url = checkPath(req.path);
    const hasBody = req.body !== undefined && req.method !== "GET";
    const res = await o.api.inject({
      method: req.method, url,
      ...(hasBody ? { payload: JSON.stringify(req.body), headers: { "content-type": "application/json" } } : {}),
    });
    return { status: res.statusCode, body: parseBody(res) };
  });

  handle(CH.download, async (e, p: string, opts?: { suggestedName?: string }): Promise<SaveResult> => {
    const res = await o.api.inject({ method: "GET", url: checkPath(p) });
    if (res.statusCode >= 400) throw new Error(errorMessage(res));
    const name = dispositionFilename(res.headers["content-disposition"])
      ?? (typeof opts?.suggestedName === "string" ? path.basename(opts.suggestedName) : null)
      ?? "download";
    const win = windowOf(e);
    const dlg = { defaultPath: path.join(app.getPath("downloads"), name), filters: filtersForName(name) };
    const r = win ? await dialog.showSaveDialog(win, dlg) : await dialog.showSaveDialog(dlg);
    if (r.canceled || !r.filePath) return { saved: false };
    await writeFile(r.filePath, res.rawPayload);
    reveal.remember(r.filePath);
    return { saved: true, filePath: r.filePath };
  });

  handle(CH.upload, async (e, p: string, opts?: { fields?: Record<string, string>; filters?: FileFilter[]; title?: string }): Promise<ApiResponse | null> => {
    const url = checkPath(p);
    const win = windowOf(e);
    const dlg = { title: typeof opts?.title === "string" ? opts.title : undefined, filters: checkFilters(opts?.filters), properties: ["openFile" as const] };
    const r = win ? await dialog.showOpenDialog(win, dlg) : await dialog.showOpenDialog(dlg);
    const file = r.filePaths[0];
    if (r.canceled || !file) return null;
    if (statSync(file).size > MAX_UPLOAD) throw new Error("The file is too large (limit 512 MB)");
    reveal.remember(file);
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts?.fields ?? {})) if (typeof v === "string") fields[k] = v;
    const mp = buildMultipart(fields, { name: path.basename(file), data: await readFile(file) });
    const res = await o.api.inject({ method: "POST", url, payload: mp.body, headers: { "content-type": mp.contentType } });
    return { status: res.statusCode, body: parseBody(res) };
  });

  handle(CH.saveFile, async (e, opts: { suggestedName: string; content: string; encoding?: "utf8" | "base64"; filters?: FileFilter[] }): Promise<SaveResult> => {
    if (!opts || typeof opts.content !== "string") throw new Error("Invalid saveFile request");
    const name = path.basename(String(opts.suggestedName || "file"));
    const win = windowOf(e);
    const dlg = { defaultPath: path.join(app.getPath("downloads"), name), filters: checkFilters(opts.filters) ?? filtersForName(name) };
    const r = win ? await dialog.showSaveDialog(win, dlg) : await dialog.showSaveDialog(dlg);
    if (r.canceled || !r.filePath) return { saved: false };
    await writeFile(r.filePath, opts.encoding === "base64" ? Buffer.from(opts.content, "base64") : Buffer.from(opts.content, "utf8"));
    reveal.remember(r.filePath);
    return { saved: true, filePath: r.filePath };
  });

  handle(CH.openFile, async (e, opts?: { filters?: FileFilter[]; title?: string; encoding?: "utf8" | "base64" }) => {
    const win = windowOf(e);
    const dlg = { title: typeof opts?.title === "string" ? opts.title : undefined, filters: checkFilters(opts?.filters), properties: ["openFile" as const] };
    const r = win ? await dialog.showOpenDialog(win, dlg) : await dialog.showOpenDialog(dlg);
    const file = r.filePaths[0];
    if (r.canceled || !file) return null;
    if (statSync(file).size > MAX_OPEN_FILE) throw new Error("The file is too large (limit 64 MB)");
    reveal.remember(file);
    const data = await readFile(file);
    return { name: path.basename(file), content: opts?.encoding === "base64" ? data.toString("base64") : data.toString("utf8") };
  });

  handle(CH.openExternal, async (_e, url: string) => {
    let u: URL;
    try { u = new URL(String(url)); } catch { throw new Error("Invalid URL"); }
    if (!["https:", "http:", "mailto:"].includes(u.protocol)) throw new Error(`Refusing to open ${u.protocol} URLs`);
    await shell.openExternal(u.toString());
  });

  handle(CH.revealPath, async (_e, p: string) => {
    if (typeof p !== "string" || !path.isAbsolute(p) || /[\x00\r\n]/.test(p)) throw new Error("Invalid path");
    if (!reveal.allowed(p)) throw new Error("Only the data folder or a file saved or opened in this session can be revealed");
    if (!existsSync(p)) throw new Error("No such file");
    shell.showItemInFolder(p);
  });

  handle(CH.info, async (): Promise<AppInfo> => ({
    version: app.getVersion(), platform: process.platform, arch: process.arch,
    electron: process.versions.electron, node: process.versions.node, dataDir: o.dataDir,
  }));
}
