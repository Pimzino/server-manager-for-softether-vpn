// Client for the in-process API, over the preload bridge (window.sem).
// Same exports as the web product's lib/api.ts so ported pages keep their data logic.
// Differences (documented in docs/desktop-design.md, "Porting guide"):
//   * upload(path, opts)  opens the native Open dialog itself; resolves null when cancelled.
//   * download(path, opts) shows the native Save dialog; resolves { saved, filePath }.
import type { FileFilter, HttpMethod, SaveResult } from "../../shared/ipc";
import type { ConnectionKind } from "./types";

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(ApiError.describe(status, body));
    this.status = status;
    this.body = body ?? {};
    this.name = "ApiError";
  }
  /** Error text, including backend validation details (`issues: [{path, message}]`) when present. */
  static describe(status: number, body: Record<string, unknown>): string {
    const base = typeof body?.error === "string" ? body.error : `HTTP ${status}`;
    const issues = Array.isArray(body?.issues) ? (body.issues as { path?: unknown; message?: unknown }[]) : [];
    if (!issues.length) return base;
    const detail = issues.slice(0, 5).map((i) => {
      const path = Array.isArray(i.path) ? i.path.join(".") : typeof i.path === "string" ? i.path : "";
      return path ? `${path}: ${String(i.message ?? "invalid")}` : String(i.message ?? "invalid");
    }).join("; ");
    return `${base}: ${detail}${issues.length > 5 ? ` (+${issues.length - 5} more)` : ""}`;
  }
  /** SoftEther error code (ERR_*), when the VPN Server rejected the call. */
  get softEtherCode(): number | undefined {
    return typeof this.body.softEtherCode === "number" ? this.body.softEtherCode : undefined;
  }
  /** Transport-level failure kind (network, tls-mismatch, auth, ...). */
  get kind(): ConnectionKind | undefined {
    const k = this.body.kind ?? this.body.connection;
    return typeof k === "string" ? (k as ConnectionKind) : undefined;
  }
  get presentedFingerprint(): string | undefined {
    return typeof this.body.presentedFingerprint === "string" ? this.body.presentedFingerprint : undefined;
  }
  /** The server has no password for this session: the user must unlock it. */
  get locked(): boolean {
    return this.status === 423 || this.body.locked === true;
  }
}

type LockListener = (serverId: number) => void;
const lockListeners = new Set<LockListener>();
/** Subscribe to 423 "locked" responses (the shell shows the unlock prompt). */
export function onLocked(l: LockListener) {
  lockListeners.add(l);
  return () => { lockListeners.delete(l); };
}

function bridge() {
  if (!window.sem) throw new Error("The desktop bridge (window.sem) is not available");
  return window.sem;
}

function toError(status: number, body: unknown, path: string): ApiError {
  const b = (body && typeof body === "object" ? body : { error: typeof body === "string" && body ? body : undefined }) as Record<string, unknown>;
  const err = new ApiError(status, b);
  if (err.locked) {
    const id = Number(path.match(/^\/api\/servers\/(\d+)/)?.[1]);
    if (Number.isFinite(id)) lockListeners.forEach((l) => l(id));
  }
  return err;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
  const method = (opts.method ?? (opts.body !== undefined ? "POST" : "GET")).toUpperCase() as HttpMethod;
  const res = await bridge().api({ method, path, body: opts.body });
  if (res.status >= 400) throw toError(res.status, res.body, path);
  if (opts.raw) return (typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2)) as T;
  return res.body as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

/** Call a SoftEther admin RPC on a saved server (native or JSON-RPC transport, same JSON shapes). */
export function rpc<T = Record<string, any>>(serverId: number | string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return post<T>(`/api/servers/${serverId}/rpc/${method}`, params);
}

export interface UploadOptions {
  /** Extra multipart fields sent with the file. */
  fields?: Record<string, string>;
  /** Native dialog filters, e.g. [{ name: "Certificates", extensions: ["cer", "pem"] }]. */
  filters?: FileFilter[];
  /** Native dialog title. */
  title?: string;
}

/**
 * Pick a file with the native Open dialog and POST it as multipart (field "file") to `path`.
 * Resolves `null` when the user cancels. Throws ApiError on HTTP errors.
 * (Web version took a File from an <input type=file>; the desktop app never uses file inputs.)
 */
export async function upload<T>(path: string, opts: UploadOptions = {}): Promise<T | null> {
  const res = await bridge().upload(path, opts);
  if (!res) return null;
  if (res.status >= 400) throw toError(res.status, res.body, path);
  return res.body as T;
}

/**
 * GET `path` and save it through the native Save dialog (file name from Content-Disposition,
 * or `suggestedName`). Resolves `{ saved: false }` when the user cancels.
 */
export async function download(path: string, opts: { suggestedName?: string } = {}): Promise<SaveResult> {
  return bridge().download(path, opts);
}

/** Save text or base64 content produced in the renderer through the native Save dialog. */
export async function saveFile(opts: { suggestedName: string; content: string; encoding?: "utf8" | "base64"; filters?: FileFilter[] }): Promise<SaveResult> {
  return bridge().saveFile(opts);
}

/** Native Open dialog returning a file's content (utf8 by default). null = cancelled. */
export async function openFile(opts: { filters?: FileFilter[]; title?: string; encoding?: "utf8" | "base64" } = {}) {
  return bridge().openFile(opts);
}

export function openExternal(url: string) {
  return bridge().openExternal(url);
}

export function revealPath(filePath: string) {
  return bridge().revealPath(filePath);
}
