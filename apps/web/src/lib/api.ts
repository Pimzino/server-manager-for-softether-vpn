// Thin client for the management server REST API.

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(ApiError.describe(status, body));
    this.status = status;
    this.body = body;
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
  get softEtherCode(): number | undefined {
    return typeof this.body.softEtherCode === "number" ? this.body.softEtherCode : undefined;
  }
}

type Listener = (e: ApiError) => void;
const authListeners = new Set<Listener>();
/** Subscribe to 401 / password-change-required responses (used by the auth provider). */
export function onAuthError(l: Listener) {
  authListeners.add(l);
  return () => { authListeners.delete(l); };
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; raw?: boolean } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      "x-sem-csrf": "1",
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (opts.raw && res.ok) return (await res.text()) as T;
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!res.ok) {
    const err = new ApiError(res.status, (body as Record<string, unknown>) ?? {});
    if ((res.status === 401 && !path.startsWith("/api/auth/login") && !path.startsWith("/api/auth/mfa")) ||
        (res.status === 403 && err.body.mustChangePassword)) {
      authListeners.forEach((l) => l(err));
    }
    throw err;
  }
  return body as T;
}

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

/** Call a SoftEther JSON-RPC method on a managed server via the gateway. */
export function rpc<T = Record<string, any>>(serverId: number | string, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return post<T>(`/api/servers/${serverId}/rpc/${method}`, params);
}

export async function upload<T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", file);
  const res = await fetch(path, { method: "POST", body: fd, credentials: "same-origin", headers: { "x-sem-csrf": "1" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

/** Trigger a browser download of a GET endpoint. */
export function download(path: string) {
  const a = document.createElement("a");
  a.href = path;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
