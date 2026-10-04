// Saved server connections (vpnsmgr-style "connection settings"), passwords, RPC execution and
// health polling. Single user: whoever runs the app is the administrator, so there are no roles,
// grants or audit records.
import { methods, types, hubFieldOf } from "@sem/api-catalog";
import { all, get, getSetting, run } from "./db.ts";
import { seal, unseal } from "./crypto.ts";
import {
  callRpc, ConnectionError, resetAgents, SoftEtherError, type Endpoint, type TlsMode, type Transport,
} from "../softether/client.ts";

export interface ServerRow {
  id: number;
  name: string;
  host: string;
  port: number;
  hub: string | null;
  transport: Transport;
  password_saved: number;
  password_sealed: string | null;
  tls_mode: TlsMode;
  tls_fingerprint: string | null;
  ca_pem: string | null;
  tags: string;
  notes: string;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export class HttpError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = { error: message, ...extra };
  }
}

// ---------------------------------------------------------------- passwords

/** Passwords of servers whose password is not saved: held in memory for this app session only. */
const sessionPasswords = new Map<number, string>();

export function getServer(id: number): ServerRow | undefined {
  return get<ServerRow>("SELECT * FROM servers WHERE id = ?", id);
}

export function listServers(): ServerRow[] {
  return all<ServerRow>("SELECT * FROM servers ORDER BY name COLLATE NOCASE");
}

/** The admin password for a server, or null when it is not saved and not entered this session. */
export function passwordOf(s: ServerRow): string | null {
  if (s.password_saved && s.password_sealed !== null) return unseal(s.password_sealed);
  return sessionPasswords.get(s.id) ?? null;
}

export function isUnlocked(s: ServerRow): boolean {
  return (!!s.password_saved && s.password_sealed !== null) || sessionPasswords.has(s.id);
}

export function lockedError(s: ServerRow) {
  return new HttpError(423, `The password for '${s.name}' is not saved: enter it to connect`, { locked: true, serverId: s.id });
}

export function endpointOf(s: ServerRow): Endpoint {
  const password = passwordOf(s);
  if (password === null) throw lockedError(s);
  return {
    host: s.host, port: s.port, hub: s.hub, password, tlsMode: s.tls_mode,
    fingerprint: s.tls_fingerprint, caPem: s.ca_pem, transport: s.transport,
  };
}

export function setSessionPassword(id: number, password: string) {
  sessionPasswords.set(id, password);
}

/** Forget a session-only password (lock). Pooled connections are dropped. */
export function lockServer(id: number) {
  sessionPasswords.delete(id);
  resetAgents();
}

export function forgetServer(id: number) {
  sessionPasswords.delete(id);
}

// ---------------------------------------------------------------- inventory

/** The server record returned to the renderer (never contains the password). */
export function publicServer(s: ServerRow) {
  const state = get<{ checked_at: number | null; ok: number | null; error: string | null; latency_ms: number | null; info: string | null; status: string | null; hubs: string | null }>(
    "SELECT * FROM server_state WHERE server_id = ?", s.id);
  const unlocked = isUnlocked(s);
  // The stored state can predate a restart (session passwords are not kept): a locked server has
  // not been checked with a password since, so it is never reported as online from that record.
  const ok = !unlocked ? null : state?.ok == null ? null : !!state.ok;
  return {
    id: s.id, name: s.name, host: s.host, port: s.port, hub: s.hub, transport: s.transport, tlsMode: s.tls_mode,
    fingerprint: s.tls_fingerprint,
    /** @deprecated alias of `fingerprint` (web API name) */
    tlsFingerprint: s.tls_fingerprint,
    hasCa: !!s.ca_pem, passwordSaved: !!s.password_saved, unlocked,
    tags: JSON.parse(s.tags) as string[], notes: s.notes, enabled: !!s.enabled, createdAt: s.created_at, updatedAt: s.updated_at,
    state: state ? {
      checkedAt: state.checked_at, ok, error: unlocked ? state.error : "Locked: password not saved",
      latencyMs: state.latency_ms,
      info: state.info ? JSON.parse(state.info) : null,
      status: state.status ? JSON.parse(state.status) : null,
      hubs: state.hubs ? JSON.parse(state.hubs) : null,
    } : null,
  };
}

export interface ServerInput {
  name: string; host: string; port: number; hub?: string | null; transport: Transport;
  password?: string; savePassword: boolean;
  tlsMode: TlsMode; fingerprint?: string | null; caPem?: string | null; tags?: string[]; notes?: string; enabled?: boolean;
}

export function insertServer(i: ServerInput): number {
  const now = Date.now();
  const save = i.savePassword;
  const r = run(
    `INSERT INTO servers (name, host, port, hub, transport, password_saved, password_sealed, tls_mode, tls_fingerprint, ca_pem, tags, notes, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    i.name, i.host, i.port, i.hub || null, i.transport, save ? 1 : 0, save ? seal(i.password ?? "") : null,
    i.tlsMode, i.fingerprint ?? null, i.caPem ?? null,
    JSON.stringify(i.tags ?? []), i.notes ?? "", i.enabled === false ? 0 : 1, now, now,
  );
  const id = Number(r.lastInsertRowid);
  if (!save && i.password !== undefined) sessionPasswords.set(id, i.password);
  return id;
}

/**
 * Update a connection. Password rules:
 *  * savePassword true + password: store it (sealed).
 *  * savePassword true, no password: keep the stored one, or promote this session's password.
 *  * savePassword false: forget the stored one (it stays usable for this session); a given
 *    password becomes the session password.
 *  * savePassword omitted: a given password replaces the current one where it lives.
 */
export function updateServer(id: number, i: Partial<ServerInput>) {
  const cur = getServer(id);
  if (!cur) throw new HttpError(404, "Server not found");
  const current = passwordOf(cur);
  const newPw = i.password !== undefined && i.password !== "" ? i.password : undefined;
  const save = i.savePassword ?? !!cur.password_saved;
  let sealed: string | null = cur.password_sealed;
  if (save) {
    const pw = newPw ?? current;
    if (pw === null) throw new HttpError(400, "Enter the password to save it");
    sealed = seal(pw);
    sessionPasswords.delete(id);
  } else {
    sealed = null;
    const pw = newPw ?? current;
    if (pw !== null) sessionPasswords.set(id, pw);
  }
  run(
    `UPDATE servers SET name = ?, host = ?, port = ?, hub = ?, transport = ?, password_saved = ?, password_sealed = ?, tls_mode = ?,
       tls_fingerprint = ?, ca_pem = ?, tags = ?, notes = ?, enabled = ?, updated_at = ? WHERE id = ?`,
    i.name ?? cur.name, i.host ?? cur.host, i.port ?? cur.port, i.hub === undefined ? cur.hub : (i.hub || null),
    i.transport ?? cur.transport, save ? 1 : 0, sealed,
    i.tlsMode ?? cur.tls_mode, i.fingerprint === undefined ? cur.tls_fingerprint : i.fingerprint,
    i.caPem === undefined ? cur.ca_pem : i.caPem,
    i.tags ? JSON.stringify(i.tags) : cur.tags, i.notes ?? cur.notes,
    i.enabled === undefined ? cur.enabled : (i.enabled ? 1 : 0), Date.now(), id,
  );
}

// ---------------------------------------------------------------- secrets / correctness guards

/**
 * Password-equivalent material SoftEther returns from Get* calls (user/hub password hashes, link
 * credentials, PSKs, RADIUS secrets, the server private key...). The desktop user is the server
 * administrator and receives them (client deployment embeds HashedKey); stripSecrets is kept for
 * callers that export data outside the app.
 */
const SECRET_FIELDS = new Set([
  "HashedKey_bin", "NtLmSecureHash_bin", "HashedPassword_bin", "SecurePassword_bin", "ClientK_bin",
  "IPsec_Secret_str", "MemberPasswordPlaintext_str", "PlainPassword_str", "ProxyPassword_str",
  "RadiusSecret_str", "SessionKey_bin", "Password_str",
]);
const SECRET_FIELDS_BY_METHOD: Record<string, string[]> = { GetServerCert: ["Key_bin"] };
export const SECRET_PROTO_OPTIONS = /key|secret|password|psk|mask/i;

/** Blank secret-named values in GetProtoOptions/SetProtoOptions parallel arrays (in place). */
export function blankProtoSecrets(o: { Name_str?: unknown; Value_bin?: unknown }) {
  if (!Array.isArray(o.Name_str) || !Array.isArray(o.Value_bin)) return;
  const values = o.Value_bin as unknown[];
  (o.Name_str as unknown[]).forEach((n, i) => { if (typeof n === "string" && SECRET_PROTO_OPTIONS.test(n)) values[i] = ""; });
}

export function stripSecrets(method: string, value: unknown): void {
  const extra = SECRET_FIELDS_BY_METHOD[method] ?? [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (SECRET_FIELDS.has(k) || extra.includes(k)) delete o[k];
        else walk(o[k]);
      }
    }
  };
  walk(value);
  if (method === "GetProtoOptions" && value && typeof value === "object") blankProtoSecrets(value as object);
}

/**
 * SoftEther (Admin.c InRpcSetUser) uses HashedKey when it is non-zero and only otherwise hashes
 * Auth_Password — even an empty one. So: a new password must be sent without the old hash, and an
 * edit that leaves the password blank must carry the current hash, or the password becomes "".
 */
async function normalizeUserPassword(ep: Endpoint, method: string, params: Record<string, unknown>) {
  const p = { ...params };
  const newPw = typeof p.Auth_Password_str === "string" && p.Auth_Password_str !== "";
  if (newPw) {
    delete p.HashedKey_bin;
    delete p.NtLmSecureHash_bin;
    return p;
  }
  if (method === "SetUser" && Number(p.AuthType_u32) === 1 && !p.HashedKey_bin) {
    const cur = await callRpc(ep, "GetUser", { HubName_str: p.HubName_str, Name_str: p.Name_str });
    if (Number(cur.AuthType_u32) === 1 && cur.HashedKey_bin) {
      p.HashedKey_bin = cur.HashedKey_bin;
      p.NtLmSecureHash_bin = cur.NtLmSecureHash_bin;
      delete p.Auth_Password_str;
    }
  }
  return p;
}

/**
 * Set* calls replace whole structs, so a secret the UI omitted (it hides them in forms) would be
 * wiped. For these methods, fill omitted secret fields from the current server-side values.
 */
const PRESERVE_SECRETS: Record<string, { get: string; keys: string[]; fields: string[] }> = {
  SetIPsecServices: { get: "GetIPsecServices", keys: [], fields: ["IPsec_Secret_str"] },
  SetHubRadius: { get: "GetHubRadius", keys: ["HubName_str"], fields: ["RadiusSecret_str"] },
  SetLink: { get: "GetLink", keys: ["HubName_Ex_str", "AccountName_utf"], fields: ["PlainPassword_str", "ProxyPassword_str", "HashedPassword_bin", "ClientK_bin"] },
  SetDDnsInternetSetting: { get: "GetDDnsInternetSetting", keys: [], fields: ["ProxyPassword_str"] },
  SetFarmSetting: { get: "GetFarmSetting", keys: [], fields: ["MemberPasswordPlaintext_str"] },
};

async function preserveSecrets(ep: Endpoint, method: string, params: Record<string, unknown>) {
  if (method === "SetUser" || method === "CreateUser") return normalizeUserPassword(ep, method, params);
  if (method === "SetProtoOptions") return preserveProtoSecrets(ep, params);
  const rule = PRESERVE_SECRETS[method];
  if (!rule || rule.fields.every((f) => f in params)) return params;
  const current = await callRpc(ep, rule.get, Object.fromEntries(rule.keys.map((k) => [k, params[k]])));
  const merged = { ...params };
  for (const f of rule.fields) if (!(f in merged) && f in current) merged[f] = current[f];
  return merged;
}

/** SetProtoOptions resends every option; restore secret values the caller left empty. */
async function preserveProtoSecrets(ep: Endpoint, params: Record<string, unknown>) {
  const names = params.Name_str, values = params.Value_bin;
  if (!Array.isArray(names) || !Array.isArray(values)) return params;
  const current = await callRpc<{ Name_str?: string[]; Value_bin?: string[] }>(ep, "GetProtoOptions", { Protocol_str: params.Protocol_str });
  const merged = [...values];
  names.forEach((n, i) => {
    if (typeof n !== "string" || !SECRET_PROTO_OPTIONS.test(n)) return;
    const v = merged[i];
    const empty = v === undefined || v === "" || v === "AA==";
    const j = current.Name_str?.indexOf(n) ?? -1;
    if (empty && j >= 0) merged[i] = current.Value_bin![j];
  });
  return { ...params, Value_bin: merged };
}

/**
 * SoftEther maps JSON keys to PACK element names case-insensitively and strips the type suffix, and
 * the last duplicate wins. So {"HubName_str":"A","hubname_str":"B"} would run on hub B while the UI
 * shows hub A. Reject any key that aliases another key or a hub-name field under that mapping.
 */
const HUB_NAME_FIELDS = ["HubName_str", "HubName_Ex_str", "RpcHubName_str"];
const TYPE_SUFFIX = /_(str|utf|u32|u64|bool|ip|dt|bin|int|int64|data)$/i;
export function assertCanonicalKeys(method: string, params: Record<string, unknown>) {
  const input = methods[method]?.input;
  const fields = input ? (types[input]?.fields ?? []).map((f) => f.name).filter((f) => HUB_NAME_FIELDS.includes(f)) : [];
  const canonical = new Map(fields.map((f) => [f.replace(TYPE_SUFFIX, "").toLowerCase(), f]));
  const seen = new Map<string, string>();
  for (const k of Object.keys(params)) {
    const base = k.replace(TYPE_SUFFIX, "").toLowerCase();
    const other = seen.get(base);
    if (other !== undefined) throw new HttpError(400, `Parameters '${other}' and '${k}' refer to the same field`);
    seen.set(base, k);
    const canon = canonical.get(base);
    if (canon !== undefined && canon !== k) throw new HttpError(400, `Parameter '${k}' must be spelled '${canon}'`);
  }
}

export function hubFor(method: string, params: Record<string, unknown>): string | null {
  const f = hubFieldOf(method);
  const v = f ? params[f] : undefined;
  return typeof v === "string" && v ? v : null;
}

/** Execute a catalog RPC against a saved server (locked → 423, SoftEther error → 422, connection → 502). */
export async function executeRpc(server: ServerRow, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const info = methods[method];
  if (!info) throw new HttpError(404, `Unknown RPC method '${method}'`);
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new HttpError(400, "Parameters must be a JSON object");
  assertCanonicalKeys(method, params);
  if (info.hubScoped && !hubFor(method, params)) throw new HttpError(400, `${method} requires a Virtual Hub name`);
  if (!server.enabled) throw new HttpError(409, "This connection is disabled");
  const ep = endpointOf(server);
  try {
    return await callRpc(ep, method, await preserveSecrets(ep, method, params));
  } catch (e) {
    throw rpcErrorToHttp(e);
  }
}

export function rpcErrorToHttp(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof SoftEtherError) return new HttpError(422, e.message, { softEtherCode: e.code, kind: "softether" });
  if (e instanceof ConnectionError) {
    return new HttpError(502, e.message, { kind: e.kind, connection: e.kind, presentedFingerprint: e.presentedFingerprint });
  }
  return new HttpError(500, (e as Error)?.message ?? "Internal error");
}

/** Structured error for test/unlock results that report failures in the body. */
export function describeError(e: unknown) {
  if (e instanceof SoftEtherError) return { error: e.message, kind: "softether", softEtherCode: e.code };
  if (e instanceof ConnectionError) return { error: e.message, kind: e.kind, presentedFingerprint: e.presentedFingerprint };
  if (e instanceof HttpError) return { error: e.message, ...e.body };
  return { error: (e as Error)?.message ?? String(e), kind: "internal" };
}

/** SoftEther's "access denied" (ERR_ACCESS_DENIED = 9) and HTTP auth failures mean a wrong password. */
export function isAuthFailure(e: unknown) {
  return (e instanceof SoftEtherError && e.code === 9) || (e instanceof ConnectionError && e.kind === "auth");
}

// ---------------------------------------------------------------- health polling

type StateListener = (serverId: number, ok: boolean, error: string | null) => void;
const stateListeners = new Set<StateListener>();
/** Reachability transitions (used by main to refresh the renderer; alerts webhook below). */
export function onStateChange(fn: StateListener) { stateListeners.add(fn); return () => stateListeners.delete(fn); }

async function stateChanged(server: ServerRow, ok: boolean, error: string | null) {
  for (const l of stateListeners) { try { l(server.id, ok, error); } catch { /* listener errors never break polling */ } }
  const alerts = getSetting<{ webhookUrl?: string; enabled?: boolean }>("alerts", {});
  if (!alerts.enabled || !alerts.webhookUrl) return;
  const text = ok ? `SoftEther server ${server.name} (${server.host}:${server.port}) is reachable again`
    : `SoftEther server ${server.name} (${server.host}:${server.port}) is DOWN: ${error}`;
  try {
    await fetch(alerts.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, event: ok ? "server.up" : "server.down", server: { id: server.id, name: server.name, host: server.host, port: server.port }, error, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch { /* alerting must never break polling */ }
}

const inflight = new Map<number, Promise<void>>();

/**
 * Poll one server and record its state. Single-flight per server (scheduler, manual refresh and
 * edits can overlap) and never rejects, so one bad server cannot abort a polling batch.
 */
export function refreshState(server: ServerRow, opts: { force?: boolean } = {}): Promise<void> {
  const running = inflight.get(server.id);
  // After an edit, a poll that started before it may use stale settings: queue a fresh one
  if (running) return opts.force ? running.then(() => refreshState(server)) : running;
  const p = doRefresh(server).catch(() => undefined).finally(() => inflight.delete(server.id));
  inflight.set(server.id, p);
  return p;
}

async function doRefresh(stale: ServerRow) {
  // Re-read the row: the caller may hold a copy from before an edit (new password, new pin)
  const server = getServer(stale.id);
  if (!server) return;
  const prev = get<{ ok: number | null }>("SELECT ok FROM server_state WHERE server_id = ?", server.id);
  const report = (ok: boolean, error: string | null) => {
    if (prev && prev.ok !== null && !!prev.ok !== ok) void stateChanged(server, ok, error);
  };
  if (!isUnlocked(server)) {
    // Nothing to poll with: record "unknown" (ok = NULL) rather than "down".
    run(
      `INSERT INTO server_state (server_id, checked_at, ok, error, latency_ms) VALUES (?, ?, NULL, ?, NULL)
       ON CONFLICT(server_id) DO UPDATE SET checked_at = excluded.checked_at, ok = NULL, error = excluded.error, latency_ms = NULL`,
      server.id, Date.now(), "Locked: password not saved",
    );
    return;
  }
  const t0 = Date.now();
  try {
    const ep = endpointOf(server);
    const info = await callRpc(ep, "GetServerInfo", {}, 10_000);
    const status = server.hub ? null : await callRpc(ep, "GetServerStatus", {}, 10_000);
    const hubs = await callRpc(ep, "EnumHub", {}, 10_000).catch(() => null);
    if (!getServer(server.id)) return; // deleted meanwhile
    run(
      `INSERT INTO server_state (server_id, checked_at, ok, error, latency_ms, info, status, hubs) VALUES (?, ?, 1, NULL, ?, ?, ?, ?)
       ON CONFLICT(server_id) DO UPDATE SET checked_at = excluded.checked_at, ok = 1, error = NULL, latency_ms = excluded.latency_ms,
       info = excluded.info, status = excluded.status, hubs = excluded.hubs`,
      server.id, Date.now(), Date.now() - t0, JSON.stringify(info), JSON.stringify(status), JSON.stringify(hubs),
    );
    report(true, null);
  } catch (e) {
    if (!getServer(server.id)) return;
    const message = (e as Error).message;
    try {
      run(
        `INSERT INTO server_state (server_id, checked_at, ok, error, latency_ms) VALUES (?, ?, 0, ?, NULL)
         ON CONFLICT(server_id) DO UPDATE SET checked_at = excluded.checked_at, ok = 0, error = excluded.error, latency_ms = NULL`,
        server.id, Date.now(), message,
      );
    } catch { /* row vanished between the check and the write */ }
    report(false, message);
  }
}
