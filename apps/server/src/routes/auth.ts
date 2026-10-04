import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { get, getSetting, run } from "../db.ts";
import { config } from "../config.ts";
import { hashPassword, matchTotp, newTotpSecret, seal, sha256Hex, unseal, verifyPassword } from "../crypto.ts";
import {
  authenticate, createSession, destroySession, loadSessionForMfa, publicUser, SESSION_COOKIE, type UserRow,
} from "../auth.ts";
import { audit } from "../audit.ts";
import { validatePasswordPolicy } from "../policy.ts";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
/** Wrong TOTP codes accepted on one pending session before it is destroyed. */
const MAX_MFA_ATTEMPTS = 3;
const GENERIC_LOGIN_ERROR = "Invalid username or password";

/**
 * Count a failed authentication step atomically (parallel requests must not share a stale
 * count) and lock the account once the threshold is reached.
 */
function registerFailure(userId: number) {
  run(
    `UPDATE users SET
       failed_logins = CASE WHEN failed_logins + 1 >= ? THEN 0 ELSE failed_logins + 1 END,
       locked_until = CASE WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END
     WHERE id = ?`,
    MAX_FAILED, MAX_FAILED, Date.now() + LOCK_MINUTES * 60_000, userId,
  );
}

function isLocked(userId: number) {
  const r = get<{ locked_until: number | null }>("SELECT locked_until FROM users WHERE id = ?", userId);
  return !!r?.locked_until && r.locked_until > Date.now();
}

/** Account-security changes must come from an interactive session, never an API token. */
function requireInteractive(req: FastifyRequest, reply: FastifyReply) {
  if (req.principal?.via !== "session") {
    reply.code(403).send({ error: "This action requires an interactive session (API tokens are not accepted)" });
    return false;
  }
  return true;
}

export default async function authRoutes(app: FastifyInstance) {
  const cookieOpts = () => ({
    path: "/", httpOnly: true, sameSite: "strict" as const, secure: !config.plainHttp || !!config.trustProxy,
    maxAge: config.sessionTtlHours * 3600,
  });

  app.get("/api/auth/banner", async () => ({ loginBanner: getSetting("loginBanner", "") }));

  app.post("/api/auth/login", {
    config: { rateLimit: { max: config.loginRateLimit, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const body = z.object({ username: z.string().min(1).max(128), password: z.string().min(1).max(512) }).parse(req.body);
    const user = get<UserRow>("SELECT * FROM users WHERE username = ?", body.username);
    // Always run one scrypt so response time does not reveal which usernames exist.
    const passwordOk = user ? await verifyPassword(body.password, user.password_hash) : (await hashPassword(body.password), false);
    const fail = (reason: string) => {
      audit({ userId: user?.id, username: body.username, ip: req.ip, action: "auth.login", success: false, error: reason });
      // Same response for unknown, disabled, locked and wrong-password: no account enumeration.
      return reply.code(401).send({ error: GENERIC_LOGIN_ERROR });
    };
    if (!user) return fail("unknown user");
    if (user.disabled) return fail("disabled");
    if (isLocked(user.id)) return fail("locked");
    if (!passwordOk) {
      registerFailure(user.id);
      return fail("bad password");
    }
    // Re-check after the (slow) hash: a parallel failure may have locked the account meanwhile.
    if (isLocked(user.id)) return fail("locked");
    const mfa = !!user.totp_secret;
    const token = createSession(user.id, req.ip, String(req.headers["user-agent"] ?? ""), mfa);
    reply.setCookie(SESSION_COOKIE, token, cookieOpts());
    if (mfa) return { mfaRequired: true }; // failure counter is only reset once the second factor succeeds
    run("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?", Date.now(), user.id);
    audit({ userId: user.id, username: user.username, ip: req.ip, action: "auth.login", success: true });
    return { user: publicUser(user) };
  });

  app.post("/api/auth/mfa", { config: { rateLimit: { max: config.loginRateLimit, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const token = req.cookies[SESSION_COOKIE];
    const s = token ? loadSessionForMfa(token) : null;
    if (!s || !s.user.totp_secret) return reply.code(401).send({ error: "MFA session expired, sign in again" });
    if (isLocked(s.user.id) || s.user.disabled) {
      destroySession(s.hash);
      return reply.code(401).send({ error: "MFA session expired, sign in again" });
    }
    const step = matchTotp(unseal(s.user.totp_secret), code);
    // Replay protection (RFC 6238 §5.2): each time step is accepted at most once per user.
    const accepted = step !== null && run(
      "UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)",
      step, s.user.id, step,
    ).changes === 1;
    if (!accepted) {
      registerFailure(s.user.id);
      const attempts = get<{ n: number }>("UPDATE sessions SET mfa_attempts = mfa_attempts + 1 WHERE id_hash = ? RETURNING mfa_attempts AS n", s.hash)?.n ?? MAX_MFA_ATTEMPTS;
      if (attempts >= MAX_MFA_ATTEMPTS) destroySession(s.hash);
      audit({ userId: s.user.id, username: s.user.username, ip: req.ip, action: "auth.mfa", success: false, error: step === null ? "bad code" : "replayed code" });
      return reply.code(401).send({ error: attempts >= MAX_MFA_ATTEMPTS ? "Too many invalid codes, sign in again" : "Invalid authentication code" });
    }
    run("UPDATE sessions SET mfa_pending = 0 WHERE id_hash = ?", s.hash);
    run("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?", Date.now(), s.user.id);
    audit({ userId: s.user.id, username: s.user.username, ip: req.ip, action: "auth.login", success: true, details: { mfa: true } });
    return { user: publicUser(s.user) };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) destroySession(sha256Hex(token));
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: authenticate }, async (req) => ({ user: publicUser(req.principal!.user) }));

  app.post("/api/auth/password", { preHandler: authenticate }, async (req, reply) => {
    if (!requireInteractive(req, reply)) return;
    const body = z.object({ currentPassword: z.string(), newPassword: z.string() }).parse(req.body);
    const user = req.principal!.user;
    if (!(await verifyPassword(body.currentPassword, user.password_hash))) {
      return reply.code(400).send({ error: "Current password is incorrect" });
    }
    const policyError = validatePasswordPolicy(body.newPassword, user.username);
    if (policyError) return reply.code(400).send({ error: policyError });
    run("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?", await hashPassword(body.newPassword), user.id);
    // Invalidate other sessions
    run("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?", user.id, req.principal!.sessionHash ?? "");
    audit({ userId: user.id, username: user.username, ip: req.ip, action: "auth.password_change", success: true });
    return { ok: true };
  });

  /** Start enrolment: the new secret is kept (sealed) on this session, never trusted from the client. */
  app.post("/api/auth/mfa/setup", { preHandler: authenticate }, async (req, reply) => {
    if (!requireInteractive(req, reply)) return;
    const user = req.principal!.user;
    const secret = newTotpSecret();
    run("UPDATE sessions SET pending_totp = ? WHERE id_hash = ?", seal(secret), req.principal!.sessionHash!);
    const issuer = "SoftEther Manager";
    const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user.username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    return { secret, uri };
  });

  app.post("/api/auth/mfa/enable", { preHandler: authenticate }, async (req, reply) => {
    if (!requireInteractive(req, reply)) return;
    const body = z.object({
      code: z.string().regex(/^\d{6}$/),
      password: z.string().min(1),
      /** Required when replacing an existing enrolment */
      currentCode: z.string().regex(/^\d{6}$/).optional(),
    }).parse(req.body);
    const user = req.principal!.user;
    if (!(await verifyPassword(body.password, user.password_hash))) return reply.code(400).send({ error: "Password is incorrect" });
    if (user.totp_secret && (!body.currentCode || matchTotp(unseal(user.totp_secret), body.currentCode) === null)) {
      return reply.code(400).send({ error: "Enter a current code from your existing authenticator to replace it" });
    }
    const pending = get<{ pending_totp: string | null }>("SELECT pending_totp FROM sessions WHERE id_hash = ?", req.principal!.sessionHash!)?.pending_totp;
    if (!pending) return reply.code(400).send({ error: "Start MFA setup first" });
    const secret = unseal(pending);
    const step = matchTotp(secret, body.code);
    if (step === null) return reply.code(400).send({ error: "Code does not match; check the device clock" });
    run("UPDATE users SET totp_secret = ?, totp_last_step = ? WHERE id = ?", seal(secret), step, user.id);
    run("UPDATE sessions SET pending_totp = NULL WHERE id_hash = ?", req.principal!.sessionHash!);
    audit({ userId: user.id, username: user.username, ip: req.ip, action: user.totp_secret ? "auth.mfa_replace" : "auth.mfa_enable", success: true });
    return { ok: true };
  });

  app.post("/api/auth/mfa/disable", { preHandler: authenticate }, async (req, reply) => {
    if (!requireInteractive(req, reply)) return;
    const body = z.object({ password: z.string() }).parse(req.body);
    const user = req.principal!.user;
    if (!(await verifyPassword(body.password, user.password_hash))) return reply.code(400).send({ error: "Password is incorrect" });
    run("UPDATE users SET totp_secret = NULL, totp_last_step = NULL WHERE id = ?", user.id);
    audit({ userId: user.id, username: user.username, ip: req.ip, action: "auth.mfa_disable", success: true });
    return { ok: true };
  });
}
