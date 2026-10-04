import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, effectiveRole, roleAtLeast } from "../auth.ts";
import { all, get } from "../db.ts";
import { audit } from "../audit.ts";
import { diffLines, normalizeConfigForDiff, takeBackup, type BackupRow } from "../backups.ts";
import { executeRpc, HttpError, rpcErrorToHttp } from "../servers.ts";
import { ctxOf, loadVisibleServer } from "./servers.ts";

export default async function backupRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  const needAdmin = (req: Parameters<typeof loadVisibleServer>[0]) => {
    const s = loadVisibleServer(req);
    if (!roleAtLeast(effectiveRole(req.principal!.user, s.id), "admin")) throw new HttpError(403, "Configuration backups require the admin role");
    return s;
  };

  app.get("/api/servers/:id/backups", async (req) => {
    const s = needAdmin(req);
    return all<Omit<BackupRow, "content">>(
      "SELECT id, server_id, created_at, created_by, sha256, size, note FROM config_backups WHERE server_id = ? ORDER BY created_at DESC", s.id,
    ).map((b) => ({ id: b.id, createdAt: b.created_at, createdBy: b.created_by, sha256: b.sha256, size: b.size, note: b.note }));
  });

  app.post("/api/servers/:id/backups", async (req, reply) => {
    const s = needAdmin(req);
    const b = z.object({ note: z.string().max(500).default("") }).parse(req.body ?? {});
    try {
      const r = await takeBackup(s, req.principal!.user.username, b.note, true);
      audit({ userId: req.principal!.user.id, username: req.principal!.user.username, ip: req.ip, action: "backup.create", serverId: s.id, serverName: s.name, success: true });
      reply.code(201);
      return r;
    } catch (e) {
      throw rpcErrorToHttp(e);
    }
  });

  const loadBackup = (serverId: number, id: number) => {
    const b = get<BackupRow>("SELECT * FROM config_backups WHERE id = ? AND server_id = ?", id, serverId);
    if (!b) throw new HttpError(404, "Backup not found");
    return b;
  };

  app.get("/api/servers/:id/backups/:bid", async (req, reply) => {
    const s = needAdmin(req);
    const b = loadBackup(s.id, Number((req.params as { bid: string }).bid));
    if ((req.query as { download?: string }).download) {
      reply.header("content-type", "text/plain; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="${s.name.replace(/[^\w.-]/g, "_")}-${new Date(b.created_at).toISOString().replace(/[:.]/g, "-")}.config"`);
      return b.content;
    }
    return { id: b.id, createdAt: b.created_at, createdBy: b.created_by, sha256: b.sha256, size: b.size, note: b.note, content: b.content };
  });

  /** Diff two backups, or a backup against the live configuration (other=live). */
  app.get("/api/servers/:id/backups/:bid/diff", async (req) => {
    const s = needAdmin(req);
    const a = loadBackup(s.id, Number((req.params as { bid: string }).bid));
    const q = z.object({ other: z.string().default("live"), raw: z.string().optional() }).parse(req.query);
    let other: string;
    if (q.other === "live") {
      const r = await executeRpc(ctxOf(req), s, "GetConfig", {});
      other = Buffer.from(String(r.FileData_bin ?? ""), "base64").toString("utf8");
    } else {
      other = loadBackup(s.id, Number(q.other)).content;
    }
    const norm = q.raw ? (x: string) => x : normalizeConfigForDiff;
    const lines = diffLines(norm(a.content), norm(other));
    const changed = lines.filter((l) => l.type !== "same").length;
    // Collapse unchanged context to 3 lines around changes
    const keep = new Set<number>();
    lines.forEach((l, i) => { if (l.type !== "same") for (let k = i - 3; k <= i + 3; k++) keep.add(k); });
    const hunks: (typeof lines[number] | { type: "skip"; count: number })[] = [];
    let skipped = 0;
    lines.forEach((l, i) => {
      if (keep.has(i)) {
        if (skipped) { hunks.push({ type: "skip", count: skipped }); skipped = 0; }
        hunks.push(l);
      } else skipped++;
    });
    if (skipped) hunks.push({ type: "skip", count: skipped });
    return { changed, lines: hunks };
  });

  /** Restore: uploads the stored config via SetConfig (the VPN server restarts). */
  app.post("/api/servers/:id/backups/:bid/restore", async (req) => {
    const s = needAdmin(req);
    const b = loadBackup(s.id, Number((req.params as { bid: string }).bid));
    const confirm = z.object({ confirm: z.literal(s.name) }).safeParse(req.body);
    if (!confirm.success) throw new HttpError(400, `Type the server name '${s.name}' to confirm`);
    // Safety net: snapshot the current config first; never overwrite a config we could not save
    try {
      await takeBackup(s, req.principal!.user.username, `Automatic snapshot before restoring backup #${b.id}`, false, b.id);
    } catch (e) {
      throw new HttpError(502, `Restore aborted: could not snapshot the current configuration first (${(e as Error).message})`);
    }
    await executeRpc(ctxOf(req), s, "SetConfig", { FileData_bin: Buffer.from(b.content, "utf8").toString("base64") }, { auditAction: "backup.restore" });
    return { ok: true };
  });

  /** Upload a vpn_server.config file and apply it (SetConfig). */
  app.post("/api/servers/:id/config/upload", async (req) => {
    const s = needAdmin(req);
    const b = z.object({ content: z.string().min(1), confirm: z.string() }).parse(req.body);
    if (b.confirm !== s.name) throw new HttpError(400, `Type the server name '${s.name}' to confirm`);
    try {
      await takeBackup(s, req.principal!.user.username, "Automatic snapshot before config upload", false);
    } catch (e) {
      throw new HttpError(502, `Upload aborted: could not snapshot the current configuration first (${(e as Error).message})`);
    }
    await executeRpc(ctxOf(req), s, "SetConfig", { FileData_bin: Buffer.from(b.content, "utf8").toString("base64") }, { auditAction: "config.upload" });
    return { ok: true };
  });
}
