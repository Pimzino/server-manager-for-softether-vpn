import type { FastifyReply, FastifyRequest } from "fastify";
import { all, get, run } from "./db.ts";
import { config } from "./config.ts";
import { hashPassword, randomToken, sha256Hex } from "./crypto.ts";

export type Role = "admin" | "operator" | "viewer" | "none";
const RANK: Record<Role, number> = { none: 0, viewer: 1, operator: 2, admin: 3 };

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  email: string;
  password_hash: string;
  role: Role;
  disabled: number;
  totp_secret: string | null;
  totp_last_step?: number | null;
  must_change_password: number;
  failed_logins: number;
  locked_until: number | null;
  last_login_at: number | null;
  created_at: number;
}

export interface Principal {
  user: UserRow;
  via: "session" | "token";
  sessionHash?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export const SESSION_COOKIE = "sem_session";

export function roleAtLeast(role: Role, min: Role) {
  return RANK[role] >= RANK[min];
}

interface GrantRow { server_id: number | null; hub: string | null; role: Exclude<Role, "none"> }

/**
 * Effective role of a user on a server (and optionally a hub).
 * Global role applies everywhere; grants add scoped elevation (server-wide or a single hub).
 */
export function effectiveRole(user: UserRow, serverId: number | null, hub?: string | null): Role {
  let best: Role = user.role;
  const grants = all<GrantRow>("SELECT server_id, hub, role FROM grants WHERE user_id = ?", user.id);
  for (const g of grants) {
    if (g.server_id !== null && g.server_id !== serverId) continue;
    if (g.hub !== null && (hub == null || g.hub.toLowerCase() !== hub.toLowerCase())) continue;
    if (RANK[g.role] > RANK[best]) best = g.role;
  }
  return best;
}

/** Can the user see a server at all (any role on the server or on one of its hubs)? */
export function canSeeServer(user: UserRow, serverId: number): boolean {
  if (user.role !== "none") return true;
  return !!get("SELECT 1 FROM grants WHERE user_id = ? AND (server_id IS NULL OR server_id = ?)", user.id, serverId);
}

/** Roles from hub-level grants on a server (hub name -> role), for exact UI gating. */
export function hubRoles(user: UserRow, serverId: number): Record<string, Role> {
  const out: Record<string, Role> = {};
  for (const g of all<GrantRow>("SELECT server_id, hub, role FROM grants WHERE user_id = ? AND hub IS NOT NULL AND (server_id IS NULL OR server_id = ?)", user.id, serverId)) {
    const r = effectiveRole(user, serverId, g.hub);
    out[g.hub!] = r;
  }
  return out;
}

/** Hubs a hub-scoped-only user may access on a server; null = all hubs. */
export function visibleHubs(user: UserRow, serverId: number): string[] | null {
  if (user.role !== "none") return null;
  const grants = all<GrantRow>("SELECT server_id, hub, role FROM grants WHERE user_id = ? AND (server_id IS NULL OR server_id = ?)", user.id, serverId);
  if (grants.some((g) => g.hub === null)) return null;
  return grants.map((g) => g.hub!).filter(Boolean);
}

export function createSession(userId: number, ip: string, ua: string, mfaPending: boolean): string {
  const token = randomToken(32);
  const now = Date.now();
  run(
    "INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent, mfa_pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    sha256Hex(token), userId, now, now, now + config.sessionTtlHours * 3600_000, ip, ua.slice(0, 300), mfaPending ? 1 : 0,
  );
  return token;
}

export function destroySession(hash: string) {
  run("DELETE FROM sessions WHERE id_hash = ?", hash);
}

function loadSession(token: string): { user: UserRow; hash: string; mfaPending: boolean } | null {
  const hash = sha256Hex(token);
  const s = get<{ user_id: number; expires_at: number; last_seen_at: number; mfa_pending: number }>(
    "SELECT user_id, expires_at, last_seen_at, mfa_pending FROM sessions WHERE id_hash = ?", hash);
  if (!s) return null;
  const now = Date.now();
  if (s.expires_at < now || s.last_seen_at + config.sessionIdleMinutes * 60_000 < now) {
    destroySession(hash);
    return null;
  }
  const user = get<UserRow>("SELECT * FROM users WHERE id = ?", s.user_id);
  if (!user || user.disabled) return null;
  if (now - s.last_seen_at > 30_000) run("UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?", now, hash);
  return { user, hash, mfaPending: !!s.mfa_pending };
}

function loadToken(raw: string): UserRow | null {
  const t = get<{ id: number; user_id: number; expires_at: number | null }>(
    "SELECT id, user_id, expires_at FROM api_tokens WHERE token_hash = ?", sha256Hex(raw));
  if (!t || (t.expires_at && t.expires_at < Date.now())) return null;
  const user = get<UserRow>("SELECT * FROM users WHERE id = ?", t.user_id);
  if (!user || user.disabled) return null;
  run("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", Date.now(), t.id);
  return user;
}

/** Fastify preHandler: resolves the principal from a session cookie or bearer token. */
export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const authz = req.headers.authorization;
  if (authz?.startsWith("Bearer ")) {
    const user = loadToken(authz.slice(7).trim());
    if (!user) return reply.code(401).send({ error: "Invalid API token" });
    if (user.must_change_password) return reply.code(403).send({ error: "Password change required", mustChangePassword: true });
    req.principal = { user, via: "token" };
    return;
  }
  const cookie = req.cookies?.[SESSION_COOKIE];
  const s = cookie ? loadSession(cookie) : null;
  if (!s) return reply.code(401).send({ error: "Not authenticated" });
  if (s.mfaPending) return reply.code(401).send({ error: "MFA required", mfaRequired: true });
  // CSRF defence for cookie-authenticated state-changing requests: require a custom header
  // (cannot be set cross-origin without CORS preflight, which we never allow).
  if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-sem-csrf"] !== "1") {
    return reply.code(403).send({ error: "Missing CSRF header" });
  }
  if (s.user.must_change_password && !req.url.startsWith("/api/auth/")) {
    return reply.code(403).send({ error: "Password change required", mustChangePassword: true });
  }
  req.principal = { user: s.user, via: "session", sessionHash: s.hash };
}

export function requireRole(min: Role) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.principal || !roleAtLeast(req.principal.user.role, min)) {
      return reply.code(403).send({ error: `Requires ${min} role` });
    }
  };
}

export function loadSessionForMfa(token: string) {
  const hash = sha256Hex(token);
  const s = get<{ user_id: number; expires_at: number; mfa_pending: number; created_at: number }>(
    "SELECT user_id, expires_at, mfa_pending, created_at FROM sessions WHERE id_hash = ?", hash);
  if (!s || !s.mfa_pending || s.created_at + 5 * 60_000 < Date.now()) return null;
  const user = get<UserRow>("SELECT * FROM users WHERE id = ?", s.user_id);
  return user ? { user, hash } : null;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id, username: u.username, displayName: u.display_name, email: u.email, role: u.role,
    disabled: !!u.disabled, mfaEnabled: !!u.totp_secret, mustChangePassword: !!u.must_change_password,
    lastLoginAt: u.last_login_at, createdAt: u.created_at, lockedUntil: u.locked_until,
  };
}
