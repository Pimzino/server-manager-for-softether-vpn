import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { methods, types, enums, errors } from "@sem/api-catalog";
import { authenticate, canSeeServer, effectiveRole, hubRoles, requireRole, visibleHubs } from "../auth.ts";
import { audit } from "../audit.ts";
import { run } from "../db.ts";
import { callRpc, normalizeFingerprint, probeCertificate, resetAgents, stripBrackets, type Endpoint } from "../softether/client.ts";
import {
  executeRpc, getServer, HttpError, insertServer, listServers, publicServer, refreshState, rpcErrorToHttp,
  updateServer, type ServerRow,
} from "../servers.ts";

const serverBody = z.object({
  name: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1).max(255).transform(stripBrackets),
  port: z.coerce.number().int().min(1).max(65535),
  hub: z.string().trim().max(255).nullish(),
  password: z.string().max(255).optional(),
  tlsMode: z.enum(["pin", "ca", "insecure"]),
  tlsFingerprint: z.string().max(200).nullish(),
  caPem: z.string().max(20000).nullish(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  notes: z.string().max(5000).optional(),
  enabled: z.boolean().optional(),
});

export function ctxOf(req: FastifyRequest) {
  return { principal: req.principal!, ip: req.ip };
}

export function loadVisibleServer(req: FastifyRequest): ServerRow {
  const id = Number((req.params as { id: string }).id);
  const s = getServer(id);
  if (!s || !canSeeServer(req.principal!.user, s.id)) throw new HttpError(404, "Server not found");
  return s;
}

export default async function serverRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/api/catalog", async () => ({ methods, types, enums, errors }));

  app.get("/api/servers", async (req) => {
    const u = req.principal!.user;
    return listServers().filter((s) => canSeeServer(u, s.id)).map((s) => ({
      ...publicServer(s, u), myRole: effectiveRole(u, s.id), visibleHubs: visibleHubs(u, s.id), hubRoles: hubRoles(u, s.id),
    }));
  });

  app.get("/api/servers/:id", async (req) => {
    const s = loadVisibleServer(req);
    const u = req.principal!.user;
    return { ...publicServer(s, u), myRole: effectiveRole(u, s.id), visibleHubs: visibleHubs(u, s.id), hubRoles: hubRoles(u, s.id) };
  });

  /** Fetch the certificate a host presents, so the admin can confirm the fingerprint before pinning. */
  app.post("/api/servers/probe", { preHandler: requireRole("admin") }, async (req) => {
    const b = z.object({ host: z.string().min(1), port: z.coerce.number().int().min(1).max(65535) }).parse(req.body);
    try {
      return await probeCertificate(b.host, b.port);
    } catch (e) {
      throw rpcErrorToHttp(e);
    }
  });

  /** Test credentials + TLS settings without saving. */
  app.post("/api/servers/test", { preHandler: requireRole("admin") }, async (req) => {
    const b = serverBody.parse(req.body);
    const ep: Endpoint = {
      host: b.host, port: b.port, hub: b.hub || null, password: b.password ?? "", tlsMode: b.tlsMode,
      fingerprint: b.tlsFingerprint ? normalizeFingerprint(b.tlsFingerprint) : null, caPem: b.caPem ?? null,
    };
    try {
      const info = await callRpc(ep, "GetServerInfo", {}, 10_000, { ephemeral: true });
      const caps = await callRpc<{ CapsList?: { CapsName_str: string; CapsValue_u32: number }[] }>(ep, "GetCaps", {}, 10_000, { ephemeral: true }).catch(() => null);
      return { ok: true, info, capsCount: caps?.CapsList?.length ?? null };
    } catch (e) {
      throw rpcErrorToHttp(e);
    }
  });

  app.post("/api/servers", { preHandler: requireRole("admin") }, async (req, reply) => {
    const b = serverBody.parse(req.body);
    if (b.tlsMode === "pin" && !b.tlsFingerprint) throw new HttpError(400, "A certificate fingerprint is required in pin mode");
    const id = insertServer({ ...b, tlsFingerprint: b.tlsFingerprint ? normalizeFingerprint(b.tlsFingerprint) : null });
    resetAgents();
    const u = req.principal!.user;
    audit({ userId: u.id, username: u.username, ip: req.ip, action: "server.create", serverId: id, serverName: b.name,
      details: { host: b.host, port: b.port, hub: b.hub, tlsMode: b.tlsMode }, success: true });
    const s = getServer(id)!;
    await refreshState(s);
    reply.code(201);
    return publicServer(getServer(id)!, req.principal!.user);
  });

  app.put("/api/servers/:id", { preHandler: requireRole("admin") }, async (req) => {
    const s = loadVisibleServer(req);
    const b = serverBody.partial().parse(req.body);
    updateServer(s.id, {
      ...b,
      password: b.password === undefined || b.password === "" ? undefined : b.password,
      tlsFingerprint: b.tlsFingerprint === undefined ? undefined : (b.tlsFingerprint ? normalizeFingerprint(b.tlsFingerprint) : null),
    });
    resetAgents();
    const u = req.principal!.user;
    audit({ userId: u.id, username: u.username, ip: req.ip, action: "server.update", serverId: s.id, serverName: s.name,
      details: { ...b, password: b.password ? "[changed]" : undefined }, success: true });
    const updated = getServer(s.id)!;
    await refreshState(updated, { force: true });
    return publicServer(getServer(s.id)!, req.principal!.user);
  });

  app.delete("/api/servers/:id", { preHandler: requireRole("admin") }, async (req) => {
    const s = loadVisibleServer(req);
    run("DELETE FROM servers WHERE id = ?", s.id);
    resetAgents();
    const u = req.principal!.user;
    audit({ userId: u.id, username: u.username, ip: req.ip, action: "server.delete", serverId: s.id, serverName: s.name, success: true });
    return { ok: true };
  });

  app.post("/api/servers/:id/refresh", async (req) => {
    const s = loadVisibleServer(req);
    await refreshState(s);
    return publicServer(getServer(s.id)!, req.principal!.user);
  });

  /** Generic RPC gateway: any catalog method, subject to RBAC + audit. */
  app.post("/api/servers/:id/rpc/:method", async (req) => {
    const s = loadVisibleServer(req);
    const { method } = req.params as { method: string };
    const params = (req.body ?? {}) as Record<string, unknown>;
    if (typeof params !== "object" || Array.isArray(params)) throw new HttpError(400, "Body must be a JSON object");
    // Hub scoping, EnumHub filtering, RBAC and audit are all enforced inside executeRpc
    const result = await executeRpc(ctxOf(req), s, method, params);
    return result;
  });
}
