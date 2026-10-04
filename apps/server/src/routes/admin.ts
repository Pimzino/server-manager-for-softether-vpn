import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { all, get, run, getSetting, setSetting, type SQLInputValue } from "../db.ts";
import { authenticate, publicUser, requireRole, type UserRow } from "../auth.ts";
import { audit } from "../audit.ts";
import { hashPassword, randomToken, sha256Hex } from "../crypto.ts";
import { passwordPolicy, validatePasswordPolicy } from "../policy.ts";
import { HttpError } from "../servers.ts";
import { backupSettings } from "../backups.ts";
import { config } from "../config.ts";

const roleEnum = z.enum(["admin", "operator", "viewer", "none"]);

function actor(req: FastifyRequest) {
  const u = req.principal!.user;
  return { userId: u.id, username: u.username, ip: req.ip };
}

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  // ---------------- Users ----------------
  app.get("/api/users", { preHandler: requireRole("admin") }, async () => {
    const users = all<UserRow>("SELECT * FROM users ORDER BY username COLLATE NOCASE");
    const grants = all<{ id: number; user_id: number; server_id: number | null; hub: string | null; role: string; server_name: string | null }>(
      "SELECT g.*, s.name AS server_name FROM grants g LEFT JOIN servers s ON s.id = g.server_id");
    return users.map((u) => ({
      ...publicUser(u),
      grants: grants.filter((g) => g.user_id === u.id).map((g) => ({ id: g.id, serverId: g.server_id, serverName: g.server_name, hub: g.hub, role: g.role })),
    }));
  });

  app.post("/api/users", { preHandler: requireRole("admin") }, async (req, reply) => {
    const b = z.object({
      username: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._@-]+$/),
      displayName: z.string().max(128).default(""),
      email: z.string().max(256).default(""),
      role: roleEnum,
      password: z.string(),
      mustChangePassword: z.boolean().default(true),
    }).parse(req.body);
    const err = validatePasswordPolicy(b.password, b.username);
    if (err) throw new HttpError(400, err);
    if (get("SELECT 1 FROM users WHERE username = ?", b.username)) throw new HttpError(409, "Username already exists");
    const r = run(
      "INSERT INTO users (username, display_name, email, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      b.username, b.displayName, b.email, await hashPassword(b.password), b.role, b.mustChangePassword ? 1 : 0, Date.now());
    audit({ ...actor(req), action: "user.create", target: b.username, details: { role: b.role }, success: true });
    reply.code(201);
    return publicUser(get<UserRow>("SELECT * FROM users WHERE id = ?", Number(r.lastInsertRowid))!);
  });

  app.put("/api/users/:id", { preHandler: requireRole("admin") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const u = get<UserRow>("SELECT * FROM users WHERE id = ?", id);
    if (!u) throw new HttpError(404, "User not found");
    const b = z.object({
      displayName: z.string().max(128).optional(),
      email: z.string().max(256).optional(),
      role: roleEnum.optional(),
      disabled: z.boolean().optional(),
      password: z.string().optional(),
      mustChangePassword: z.boolean().optional(),
      resetMfa: z.boolean().optional(),
      unlock: z.boolean().optional(),
    }).parse(req.body);
    if (id === req.principal!.user.id && (b.role && b.role !== "admin" || b.disabled)) {
      throw new HttpError(400, "You cannot demote or disable your own account");
    }
    if ((b.role && b.role !== "admin") || b.disabled) {
      const admins = get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?", id)!.n;
      if (u.role === "admin" && admins === 0) throw new HttpError(400, "At least one active admin must remain");
    }
    if (b.password) {
      const err = validatePasswordPolicy(b.password, u.username);
      if (err) throw new HttpError(400, err);
      run("UPDATE users SET password_hash = ? WHERE id = ?", await hashPassword(b.password), id);
      // A reset is typically a response to compromise: revoke every credential derived from the old password
      run("DELETE FROM sessions WHERE user_id = ?", id);
      run("DELETE FROM api_tokens WHERE user_id = ?", id);
    }
    run(`UPDATE users SET display_name = ?, email = ?, role = ?, disabled = ?, must_change_password = ?,
         totp_secret = CASE WHEN ? THEN NULL ELSE totp_secret END,
         locked_until = CASE WHEN ? THEN NULL ELSE locked_until END,
         failed_logins = CASE WHEN ? THEN 0 ELSE failed_logins END WHERE id = ?`,
      b.displayName ?? u.display_name, b.email ?? u.email, b.role ?? u.role, b.disabled === undefined ? u.disabled : (b.disabled ? 1 : 0),
      b.mustChangePassword === undefined ? u.must_change_password : (b.mustChangePassword ? 1 : 0),
      b.resetMfa ? 1 : 0, b.unlock ? 1 : 0, b.unlock ? 1 : 0, id);
    if (b.disabled) run("DELETE FROM sessions WHERE user_id = ?", id);
    if (b.resetMfa) run("UPDATE users SET totp_last_step = NULL WHERE id = ?", id);
    audit({ ...actor(req), action: "user.update", target: u.username, details: { ...b, password: b.password ? "[changed]" : undefined }, success: true });
    return publicUser(get<UserRow>("SELECT * FROM users WHERE id = ?", id)!);
  });

  app.delete("/api/users/:id", { preHandler: requireRole("admin") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (id === req.principal!.user.id) throw new HttpError(400, "You cannot delete your own account");
    const u = get<UserRow>("SELECT * FROM users WHERE id = ?", id);
    if (!u) throw new HttpError(404, "User not found");
    if (u.role === "admin" && get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?", id)!.n === 0) {
      throw new HttpError(400, "At least one active admin must remain");
    }
    run("DELETE FROM users WHERE id = ?", id);
    audit({ ...actor(req), action: "user.delete", target: u.username, success: true });
    return { ok: true };
  });

  app.post("/api/users/:id/grants", { preHandler: requireRole("admin") }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const u = get<UserRow>("SELECT * FROM users WHERE id = ?", id);
    if (!u) throw new HttpError(404, "User not found");
    const b = z.object({
      serverId: z.number().int().nullable(),
      hub: z.string().trim().max(255).nullable(),
      role: z.enum(["admin", "operator", "viewer"]),
    }).parse(req.body);
    if (b.hub && b.serverId === null) throw new HttpError(400, "Hub grants must name a server");
    const r = run("INSERT INTO grants (user_id, server_id, hub, role) VALUES (?, ?, ?, ?)", id, b.serverId, b.hub || null, b.role);
    audit({ ...actor(req), action: "user.grant_add", target: u.username, serverId: b.serverId, hub: b.hub, details: b, success: true });
    reply.code(201);
    return { id: Number(r.lastInsertRowid) };
  });

  app.delete("/api/users/:id/grants/:gid", { preHandler: requireRole("admin") }, async (req) => {
    const { id, gid } = req.params as { id: string; gid: string };
    const g = get<{ server_id: number | null; hub: string | null; role: string }>("SELECT * FROM grants WHERE id = ? AND user_id = ?", Number(gid), Number(id));
    if (!g) throw new HttpError(404, "Grant not found");
    run("DELETE FROM grants WHERE id = ?", Number(gid));
    const u = get<UserRow>("SELECT * FROM users WHERE id = ?", Number(id));
    audit({ ...actor(req), action: "user.grant_remove", target: u?.username, serverId: g.server_id, hub: g.hub, details: g, success: true });
    return { ok: true };
  });

  // ---------------- Sessions (own) ----------------
  app.get("/api/me/sessions", async (req) => {
    return all<{ id_hash: string; created_at: number; last_seen_at: number; ip: string; user_agent: string }>(
      "SELECT id_hash, created_at, last_seen_at, ip, user_agent FROM sessions WHERE user_id = ? AND mfa_pending = 0 ORDER BY last_seen_at DESC",
      req.principal!.user.id,
    ).map((s) => ({ id: s.id_hash.slice(0, 16), createdAt: s.created_at, lastSeenAt: s.last_seen_at, ip: s.ip, userAgent: s.user_agent, current: s.id_hash === req.principal!.sessionHash }));
  });

  app.delete("/api/me/sessions/:id", async (req) => {
    const { id } = req.params as { id: string };
    run("DELETE FROM sessions WHERE user_id = ? AND substr(id_hash, 1, 16) = ?", req.principal!.user.id, id);
    return { ok: true };
  });

  // ---------------- API tokens (own) ----------------
  app.get("/api/me/tokens", async (req) => {
    return all<{ id: number; name: string; prefix: string; created_at: number; expires_at: number | null; last_used_at: number | null }>(
      "SELECT id, name, prefix, created_at, expires_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC", req.principal!.user.id,
    ).map((t) => ({ id: t.id, name: t.name, prefix: t.prefix, createdAt: t.created_at, expiresAt: t.expires_at, lastUsedAt: t.last_used_at }));
  });

  app.post("/api/me/tokens", async (req, reply) => {
    if (req.principal!.via === "token") throw new HttpError(403, "API tokens cannot mint new tokens");
    const b = z.object({ name: z.string().trim().min(1).max(100), expiresInDays: z.number().int().min(1).max(3650).nullable() }).parse(req.body);
    const raw = `sem_${randomToken(32)}`;
    const r = run("INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      req.principal!.user.id, b.name, sha256Hex(raw), raw.slice(0, 12), Date.now(), b.expiresInDays ? Date.now() + b.expiresInDays * 86400_000 : null);
    audit({ ...actor(req), action: "token.create", target: b.name, success: true });
    reply.code(201);
    return { id: Number(r.lastInsertRowid), token: raw };
  });

  app.delete("/api/me/tokens/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    run("DELETE FROM api_tokens WHERE id = ? AND user_id = ?", id, req.principal!.user.id);
    audit({ ...actor(req), action: "token.delete", target: String(id), success: true });
    return { ok: true };
  });

  // ---------------- Audit log ----------------
  const auditQuery = z.object({
    q: z.string().optional(),
    user: z.string().optional(),
    action: z.string().optional(),
    serverId: z.coerce.number().int().optional(),
    success: z.enum(["true", "false"]).optional(),
    from: z.coerce.number().optional(),
    to: z.coerce.number().optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(100),
    offset: z.coerce.number().int().min(0).default(0),
    format: z.enum(["json", "csv"]).default("json"),
  });

  app.get("/api/audit", { preHandler: requireRole("operator") }, async (req, reply) => {
    const q = auditQuery.parse(req.query);
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.user) { where.push("username = ?"); params.push(q.user); }
    if (q.action) { where.push("action LIKE ?"); params.push(`${q.action}%`); }
    if (q.serverId) { where.push("server_id = ?"); params.push(q.serverId); }
    if (q.success) { where.push("success = ?"); params.push(q.success === "true" ? 1 : 0); }
    if (q.from) { where.push("ts >= ?"); params.push(q.from); }
    if (q.to) { where.push("ts <= ?"); params.push(q.to); }
    if (q.q) {
      where.push("(action LIKE ? OR target LIKE ? OR details LIKE ? OR error LIKE ? OR hub LIKE ? OR server_name LIKE ?)");
      for (let i = 0; i < 6; i++) params.push(`%${q.q}%`);
    }
    const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log ${w}`, ...params)!.n;
    const rows = all<Record<string, unknown>>(`SELECT * FROM audit_log ${w} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`, ...params, q.limit, q.offset);
    if (q.format === "csv") {
      const cols = ["id", "ts", "username", "ip", "action", "server_name", "hub", "target", "success", "error", "details"];
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? "" : k(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const k = (v: unknown) => (typeof v === "number" && v > 1e12 ? new Date(v).toISOString() : String(v));
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="audit-${new Date().toISOString().slice(0, 10)}.csv"`);
      return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
    }
    return { total, rows: rows.map((r) => ({ ...r, success: !!r.success, details: r.details ? JSON.parse(r.details as string) : null })) };
  });

  // ---------------- Settings ----------------
  app.get("/api/settings", { preHandler: requireRole("admin") }, async () => ({
    passwordPolicy: passwordPolicy(),
    backup: backupSettings(),
    poll: getSetting("poll", { intervalSec: config.pollIntervalSec }),
    loginBanner: getSetting("loginBanner", ""),
    alerts: getSetting("alerts", { enabled: false, webhookUrl: "" }),
    deploy: { packageRetentionDays: 14, ...getSetting<{ packageRetentionDays?: number }>("deploy", {}) },
  }));

  app.put("/api/settings", { preHandler: requireRole("admin") }, async (req) => {
    const b = z.object({
      passwordPolicy: z.object({ minLength: z.number().int().min(8).max(128), requireMixed: z.boolean() }).optional(),
      backup: z.object({ enabled: z.boolean(), intervalHours: z.number().int().min(1).max(24 * 30), retention: z.number().int().min(1).max(1000) }).optional(),
      poll: z.object({ intervalSec: z.number().int().min(10).max(3600) }).optional(),
      loginBanner: z.string().max(2000).optional(),
      alerts: z.object({ enabled: z.boolean(), webhookUrl: z.string().url().or(z.literal("")) }).optional(),
      deploy: z.object({ packageRetentionDays: z.number().int().min(1).max(365) }).optional(),
    }).parse(req.body);
    for (const [k, v] of Object.entries(b)) if (v !== undefined) setSetting(k, v);
    audit({ ...actor(req), action: "settings.update", details: b, success: true });
    return { ok: true };
  });
}
