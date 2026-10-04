import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { methods, types, enums, errors } from "@sem/api-catalog";
import { run } from "../db.ts";
import { callRpc, normalizeFingerprint, probeCertificate, resetAgents, stripBrackets, type Endpoint } from "../../softether/client.ts";
import {
  describeError, executeRpc, forgetServer, getServer, HttpError, insertServer, isAuthFailure, listServers, lockedError, lockServer,
  passwordOf, publicServer, refreshState, rpcErrorToHttp, setSessionPassword, updateServer, type ServerRow,
} from "../servers.ts";

const transport = z.enum(["native", "jsonrpc"]);
const tlsMode = z.enum(["pin", "ca", "insecure"]);

/** vpnsmgr-style connection setting. `tlsFingerprint` is accepted as an alias of `fingerprint`. */
const serverFields = {
  name: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1).max(255).transform(stripBrackets),
  port: z.coerce.number().int().min(1).max(65535).default(443),
  hub: z.string().trim().max(255).nullish(),
  password: z.string().max(255).optional(),
  savePassword: z.boolean().default(true),
  transport: transport.default("native"),
  tlsMode: tlsMode.default("pin"),
  fingerprint: z.string().max(200).nullish(),
  tlsFingerprint: z.string().max(200).nullish(),
  caPem: z.string().max(20000).nullish(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  notes: z.string().max(5000).optional(),
  enabled: z.boolean().optional(),
};
const createBody = z.object(serverFields);
const updateBody = z.object({
  ...serverFields,
  port: z.coerce.number().int().min(1).max(65535),
  savePassword: z.boolean(),
  transport,
  tlsMode,
}).partial();

function fingerprintOf(b: { fingerprint?: string | null; tlsFingerprint?: string | null }): string | null | undefined {
  const fp = b.fingerprint !== undefined ? b.fingerprint : b.tlsFingerprint;
  if (fp === undefined) return undefined;
  return fp ? normalizeFingerprint(fp) : null;
}

export function loadServer(req: FastifyRequest): ServerRow {
  const id = Number((req.params as { id: string }).id);
  const s = Number.isInteger(id) ? getServer(id) : undefined;
  if (!s) throw new HttpError(404, "Server not found");
  return s;
}

function uniqueName(name: string, exceptId?: number) {
  const dup = listServers().find((s) => s.name.toLowerCase() === name.toLowerCase() && s.id !== exceptId);
  if (dup) throw new HttpError(409, `A connection named '${name}' already exists`);
}

export default async function serverRoutes(app: FastifyInstance) {
  app.get("/api/catalog", async () => ({ methods, types, enums, errors }));

  app.get("/api/servers", async () => listServers().map(publicServer));

  app.get("/api/servers/:id", async (req) => publicServer(loadServer(req)));

  /** Fetch the certificate a host presents, so the user can confirm the fingerprint before pinning. */
  app.post("/api/servers/probe", async (req) => {
    const b = z.object({ host: z.string().trim().min(1).transform(stripBrackets), port: z.coerce.number().int().min(1).max(65535).default(443) }).parse(req.body);
    try {
      return await probeCertificate(b.host, b.port);
    } catch (e) {
      throw rpcErrorToHttp(e);
    }
  });

  /**
   * Test connection settings without saving. Failures are reported in the body
   * ({ ok: false, error, kind, softEtherCode?, presentedFingerprint? }), not as HTTP errors.
   * `id` lets an edit dialog test with the saved/session password when none is typed.
   */
  app.post("/api/servers/test", async (req) => {
    const b = z.object({
      id: z.number().int().optional(),
      host: z.string().trim().min(1).max(255).transform(stripBrackets),
      port: z.coerce.number().int().min(1).max(65535).default(443),
      hub: z.string().trim().max(255).nullish(),
      password: z.string().max(255).optional(),
      transport: transport.default("native"),
      tlsMode: tlsMode.default("pin"),
      fingerprint: z.string().max(200).nullish(),
      tlsFingerprint: z.string().max(200).nullish(),
      caPem: z.string().max(20000).nullish(),
    }).parse(req.body);
    let password = b.password;
    if (password === undefined && b.id !== undefined) {
      const s = getServer(b.id);
      // The stored password is only ever sent to the host it was saved for: a test against another
      // host/port (an edit that moves the server) needs the password typed again, so saved
      // credentials cannot be sent to an arbitrary endpoint (JSON-RPC sends it in clear inside TLS).
      if (s && (s.host.toLowerCase() !== b.host.toLowerCase() || s.port !== b.port)) {
        return { ok: false, error: "Enter the password to test a different host or port", kind: "password-required", transport: b.transport };
      }
      password = s ? passwordOf(s) ?? undefined : undefined;
      if (s && password === undefined) return { ok: false, ...describeError(lockedError(s)), kind: "locked", transport: b.transport };
    }
    const ep: Endpoint = {
      host: b.host, port: b.port, hub: b.hub || null, password: password ?? "", tlsMode: b.tlsMode,
      fingerprint: fingerprintOf(b) ?? null, caPem: b.caPem ?? null, transport: b.transport,
    };
    if (ep.tlsMode === "pin" && !ep.fingerprint) return { ok: false, error: "Confirm the server certificate first (no fingerprint to pin)", kind: "tls" };
    const t0 = Date.now();
    try {
      const info = await callRpc(ep, "GetServerInfo", {}, 10_000, { ephemeral: true });
      const caps = await callRpc<{ CapsList?: unknown[] }>(ep, "GetCaps", {}, 10_000, { ephemeral: true }).catch(() => null);
      return { ok: true, info, capsCount: caps?.CapsList?.length ?? null, latencyMs: Date.now() - t0, transport: ep.transport };
    } catch (e) {
      return { ok: false, ...describeError(e), transport: ep.transport };
    }
  });

  app.post("/api/servers", async (req, reply) => {
    const b = createBody.parse(req.body);
    const fingerprint = fingerprintOf(b) ?? null;
    if (b.tlsMode === "pin" && !fingerprint) throw new HttpError(400, "A certificate fingerprint is required in pin mode");
    if (b.tlsMode === "ca" && !b.caPem) throw new HttpError(400, "A CA certificate is required in CA mode");
    uniqueName(b.name);
    const id = insertServer({ ...b, hub: b.hub || null, fingerprint });
    resetAgents();
    await refreshState(getServer(id)!);
    reply.code(201);
    return publicServer(getServer(id)!);
  });

  app.put("/api/servers/:id", async (req) => {
    const s = loadServer(req);
    const b = updateBody.parse(req.body);
    if (b.name) uniqueName(b.name, s.id);
    const fingerprint = fingerprintOf(b);
    const mode = b.tlsMode ?? s.tls_mode;
    if (mode === "pin" && !(fingerprint === undefined ? s.tls_fingerprint : fingerprint)) throw new HttpError(400, "A certificate fingerprint is required in pin mode");
    updateServer(s.id, {
      ...b,
      password: b.password === "" ? undefined : b.password,
      fingerprint,
    });
    resetAgents();
    await refreshState(getServer(s.id)!, { force: true });
    return publicServer(getServer(s.id)!);
  });

  app.delete("/api/servers/:id", async (req) => {
    const s = loadServer(req);
    run("DELETE FROM servers WHERE id = ?", s.id);
    forgetServer(s.id);
    resetAgents();
    return { ok: true };
  });

  /**
   * Provide the password of a server whose password is not saved (kept in memory until quit or
   * lock). A password SoftEther rejects is not kept; any other failure (server down) keeps it and
   * reports the problem so the user can still retry later.
   */
  app.post("/api/servers/:id/unlock", async (req) => {
    const s = loadServer(req);
    const b = z.object({ password: z.string().max(255) }).parse(req.body);
    const ep: Endpoint = {
      host: s.host, port: s.port, hub: s.hub, password: b.password, tlsMode: s.tls_mode,
      fingerprint: s.tls_fingerprint, caPem: s.ca_pem, transport: s.transport,
    };
    let verified = false;
    let problem: ReturnType<typeof describeError> | null = null;
    try {
      await callRpc(ep, "GetServerInfo", {}, 10_000, { ephemeral: true });
      verified = true;
    } catch (e) {
      if (isAuthFailure(e)) throw new HttpError(403, "Wrong password", { ...describeError(e), locked: true });
      problem = describeError(e);
    }
    if (s.password_saved) {
      // Saved-password servers are always unlocked: a typed password replaces the saved one only via PUT.
      return { ok: true, verified, ...(problem ? { warning: problem } : {}), server: publicServer(getServer(s.id)!) };
    }
    setSessionPassword(s.id, b.password);
    resetAgents();
    await refreshState(getServer(s.id)!, { force: true });
    return { ok: true, verified, ...(problem ? { warning: problem } : {}), server: publicServer(getServer(s.id)!) };
  });

  /** Forget the session password (no effect on saved passwords). */
  app.post("/api/servers/:id/lock", async (req) => {
    const s = loadServer(req);
    lockServer(s.id);
    if (!s.password_saved) await refreshState(getServer(s.id)!, { force: true });
    return publicServer(getServer(s.id)!);
  });

  app.post("/api/servers/:id/refresh", async (req) => {
    const s = loadServer(req);
    await refreshState(s, { force: true });
    return publicServer(getServer(s.id)!);
  });

  /** Generic RPC gateway: any catalog method (either transport). */
  app.post("/api/servers/:id/rpc/:method", async (req) => {
    const s = loadServer(req);
    const { method } = req.params as { method: string };
    const params = (req.body ?? {}) as Record<string, unknown>;
    if (typeof params !== "object" || Array.isArray(params)) throw new HttpError(400, "Body must be a JSON object");
    return executeRpc(s, method, params);
  });
}
