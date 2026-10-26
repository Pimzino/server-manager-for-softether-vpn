import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { all, get, run } from "../db.ts";
import { localActor } from "../config.ts";
import { executeRpc, getServer, HttpError, listServers, type ServerRow } from "../servers.ts";
import {
  buildHubPackage, effectiveHubProfile, hubProfileRow, peekHubProfile, resolveProfile, templateFor, userDeployability,
} from "../deploy/hubdeploy.ts";
import { renderVpnFile } from "../deploy/vpnfile.ts";
import {
  defaultTemplate, getTemplate, listTemplates, loadTemplateSettings, publicTemplate, sealTemplate, templateBodySchema,
} from "../deploy/templates.ts";

function loadHub(req: FastifyRequest): { server: ServerRow; hub: string } {
  const { serverId, hub } = req.params as { serverId: string; hub: string };
  const server = getServer(Number(serverId));
  if (!server) throw new HttpError(404, "Server not found");
  if (!hub) throw new HttpError(404, "Virtual Hub not found");
  return { server, hub };
}

const AUTH_LABEL: Record<number, string> = { 0: "Anonymous", 1: "Password", 2: "User certificate", 3: "Root certificate", 4: "RADIUS", 5: "NT domain" };

export default async function hubDeployRoutes(app: FastifyInstance) {
  // ---------------- Templates ----------------
  app.get("/api/deploy/templates", async () => {
    defaultTemplate();
    return listTemplates().map(publicTemplate);
  });

  const saveTemplate = (req: FastifyRequest, id: number | null) => {
    const raw = req.body as { settings?: { installer?: { clientConfigPassword?: string } } };
    // "********" keeps the stored client configuration password
    if (id && raw?.settings?.installer?.clientConfigPassword === "********") {
      const cur = loadTemplateSettings(getTemplate(id)!.settings);
      raw.settings.installer.clientConfigPassword = cur.installer.clientConfigPassword;
    }
    const b = templateBodySchema.parse(raw);
    if (b.settings.branding.iconIco) {
      const ico = Buffer.from(b.settings.branding.iconIco, "base64");
      if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new HttpError(400, "The icon must be a Windows .ico file");
    }
    const dup = get<{ id: number }>("SELECT id FROM deploy_templates WHERE name = ?", b.name);
    if (dup && dup.id !== id) throw new HttpError(409, "A template with that name exists");
    const now = Date.now();
    let tid = id;
    if (id) {
      run("UPDATE deploy_templates SET name = ?, description = ?, settings = ?, updated_at = ? WHERE id = ?", b.name, b.description, sealTemplate(b.settings), now, id);
    } else {
      tid = Number(run("INSERT INTO deploy_templates (name, description, settings, is_default, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
        b.name, b.description, sealTemplate(b.settings), localActor(), now, now).lastInsertRowid);
    }
    if (b.isDefault) {
      run("UPDATE deploy_templates SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END", tid!);
    }
    return publicTemplate(getTemplate(tid!)!);
  };

  app.post("/api/deploy/templates", async (req, reply) => {
    defaultTemplate();
    reply.code(201);
    return saveTemplate(req, null);
  });

  app.put("/api/deploy/templates/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!getTemplate(id)) throw new HttpError(404, "Template not found");
    return saveTemplate(req, id);
  });

  app.delete("/api/deploy/templates/:id", async (req) => {
    const id = Number((req.params as { id: string }).id);
    const t = getTemplate(id);
    if (!t) throw new HttpError(404, "Template not found");
    if (t.is_default) throw new HttpError(400, "Make another template the default before deleting this one");
    const inUse = get<{ n: number }>("SELECT COUNT(*) AS n FROM hub_profiles WHERE template_id = ?", id)!.n;
    run("DELETE FROM deploy_templates WHERE id = ?", id);
    return { ok: true, hubsFallingBackToDefault: inUse };
  });

  // ---------------- Hub profiles (always live) ----------------
  app.get("/api/deploy/hubs", async () => {
    const servers = listServers().filter((x) => x.enabled);
    // Servers are queried in parallel: one slow or locked server must not stall the page
    const perServer = await Promise.all(servers.map(async (s) => {
      try {
        const r = await executeRpc(s, "EnumHub", {});
        return ((r.HubList as { HubName_str: string; NumUsers_u32: number; Online_bool: boolean }[]) ?? []).map((h) => (
          { ...effectiveHubProfile(s, h.HubName_str), numUsers: h.NumUsers_u32, online: h.Online_bool }));
      } catch (e) {
        const locked = e instanceof HttpError && e.status === 423;
        return [{ serverId: s.id, serverName: s.name, error: (e as Error).message, ...(locked ? { locked: true } : {}) }];
      }
    }));
    return perServer.flat();
  });

  app.get("/api/deploy/hubs/:serverId/:hub", async (req) => {
    const { server, hub } = loadHub(req);
    const profile = effectiveHubProfile(server, hub);
    const settings = loadTemplateSettings(templateFor(peekHubProfile(server.id, hub)).settings);
    const users = await executeRpc(server, "EnumUser", { HubName_str: hub });
    const builds = all<Record<string, unknown>>(
      "SELECT id, kind, username, file_name, product_version, size, sha256, created_by, created_at FROM installer_builds WHERE server_id = ? AND hub = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 200",
      server.id, hub);
    const pub = (b: Record<string, unknown>) => ({ id: b.id, kind: b.kind, username: b.username, fileName: b.file_name, productVersion: b.product_version, size: b.size, sha256: b.sha256, createdBy: b.created_by, createdAt: b.created_at });
    return {
      profile,
      credentialPolicy: settings.credentials.passwordUsers,
      users: ((users.UserList as { Name_str: string; Realname_utf: string; GroupName_str: string; AuthType_u32: number; Expires_dt?: string; DenyAccess_bool?: boolean }[]) ?? []).map((x) => ({
        name: x.Name_str, realName: x.Realname_utf, group: x.GroupName_str, authType: x.AuthType_u32, authLabel: AUTH_LABEL[x.AuthType_u32] ?? String(x.AuthType_u32),
        disabled: !!x.DenyAccess_bool, ...userDeployability(x.AuthType_u32, settings),
        lastBuild: (() => { const b = builds.find((y) => y.username === x.Name_str); return b ? pub(b) : null; })(),
      })),
      builds: builds.map(pub),
    };
  });

  app.put("/api/deploy/hubs/:serverId/:hub", async (req) => {
    const { server, hub } = loadHub(req);
    const b = z.object({
      templateId: z.number().int().nullable(),
      publicHost: z.string().trim().max(255).nullable(),
      publicPort: z.number().int().min(1).max(65535).nullable(),
      accountName: z.string().trim().max(200).regex(/^[^"`\x00-\x1f‘-‛]*$/).nullable(),
      enabled: z.boolean().default(true),
    }).parse(req.body);
    if (b.templateId !== null && !getTemplate(b.templateId)) throw new HttpError(404, "Template not found");
    hubProfileRow(server.id, hub);
    run("UPDATE hub_profiles SET template_id = ?, public_host = ?, public_port = ?, account_name = ?, enabled = ?, updated_at = ? WHERE server_id = ? AND hub = ?",
      b.templateId, b.publicHost || null, b.publicPort, b.accountName || null, b.enabled ? 1 : 0, Date.now(), server.id, hub);
    return effectiveHubProfile(server, hub);
  });

  /** Preview the .vpn a user (or the hub) would get; never rotates or reveals password hashes. */
  app.get("/api/deploy/hubs/:serverId/:hub/preview", async (req) => {
    const { server, hub } = loadHub(req);
    const user = z.object({ user: z.string().max(255).optional() }).parse(req.query).user || null;
    const r = await resolveProfile(server, hub, user, false);
    const text = renderVpnFile(r.profile).replace(/(byte HashedPassword )\S+/, (_, p) => (r.profile.hashedPassword ? `${p}<password hash embedded at build time>` : `${p}$`));
    return { content: text, credential: r.credential, warnings: r.warnings, accountName: r.profile.accountName, template: r.template.name };
  });

  app.post("/api/deploy/hubs/:serverId/:hub/packages", async (req, reply) => {
    const { server, hub } = loadHub(req);
    const b = z.object({ user: z.string().min(1).max(255).nullable(), kind: z.enum(["vpn", "msi", "exe"]) }).parse(req.body);
    if (!effectiveHubProfile(server, hub).enabled) throw new HttpError(409, "Client deployment is disabled for this hub");
    const built = await buildHubPackage(server, hub, b.user, b.kind);
    reply.code(201);
    return built;
  });
}
