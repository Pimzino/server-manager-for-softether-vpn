import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, get } from "../db.ts";
import { config } from "../config.ts";
import { hashPassword } from "../crypto.ts";
import { createSession, publicUser, SESSION_COOKIE, type UserRow } from "../auth.ts";
import { audit } from "../audit.ts";
import { passwordPolicy, validatePasswordPolicy } from "../policy.ts";
import { checkSetupToken, markSetupCompleted, setupCompleted } from "../setup.ts";

export default async function setupRoutes(app: FastifyInstance) {
  /** Public: whether first-run setup is still open (a single boolean, nothing else). */
  app.get("/api/setup/status", async () => {
    const open = !setupCompleted();
    return open ? { setupRequired: true, passwordPolicy: passwordPolicy() } : { setupRequired: false };
  });

  /**
   * Create the first administrator. Only works while no admin has ever existed and with the
   * setup token from the server log / data directory. Afterwards the route answers 404, exactly
   * like a route that does not exist.
   */
  app.post("/api/setup", {
    config: { rateLimit: { max: Math.min(config.loginRateLimit, 20), timeWindow: "1 minute" } },
  }, async (req, reply) => {
    if (setupCompleted()) return reply.code(404).send({ error: "Not found" });
    const b = z.object({
      setupToken: z.string().min(1).max(200),
      username: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._@-]+$/, "Letters, digits and . _ @ - only"),
      displayName: z.string().trim().max(128).default(""),
      email: z.string().trim().max(256).default(""),
      password: z.string().max(512),
    }).parse(req.body);
    if (!checkSetupToken(b.setupToken)) {
      audit({ username: b.username, ip: req.ip, action: "setup.bootstrap", success: false, error: "invalid setup token" });
      return reply.code(403).send({ error: "Invalid setup token" });
    }
    const policyError = validatePasswordPolicy(b.password, b.username);
    if (policyError) return reply.code(400).send({ error: policyError });
    const hash = await hashPassword(b.password);

    // Check-and-create atomically (node:sqlite is synchronous, so nothing interleaves inside
    // this block): two concurrent setup requests cannot both create an administrator.
    let userId: number | null = null;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!setupCompleted()) {
        const r = db.prepare(
          "INSERT INTO users (username, display_name, email, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, 'admin', 0, ?)",
        ).run(b.username, b.displayName, b.email, hash, Date.now());
        userId = Number(r.lastInsertRowid);
        markSetupCompleted(`setup:${b.username}`);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    if (userId === null) return reply.code(404).send({ error: "Not found" });

    const user = get<UserRow>("SELECT * FROM users WHERE id = ?", userId)!;
    audit({ userId, username: user.username, ip: req.ip, action: "setup.bootstrap", success: true, details: { username: user.username } });
    // Sign the new administrator straight in
    const token = createSession(userId, req.ip, String(req.headers["user-agent"] ?? ""), false);
    reply.setCookie(SESSION_COOKIE, token, {
      path: "/", httpOnly: true, sameSite: "strict", secure: !config.plainHttp || !!config.trustProxy,
      maxAge: config.sessionTtlHours * 3600,
    });
    reply.code(201);
    return { user: publicUser(user) };
  });
}
