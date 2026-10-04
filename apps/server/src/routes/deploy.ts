import type { FastifyInstance, FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { request } from "undici";
import { authenticate, requireRole, canSeeServer, effectiveRole, roleAtLeast } from "../auth.ts";
import { all, get, run } from "../db.ts";
import { audit } from "../audit.ts";
import { config } from "../config.ts";
import { seal, sha256Hex, unseal } from "../crypto.ts";
import { extractPayload } from "../deploy/payload.ts";
import { profileSchema, redactProfile, renderVpnFile, type ProfileSettings } from "../deploy/vpnfile.ts";
import { buildMsi, msiOptionsSchema, msitoolsAvailable } from "../deploy/msi.ts";
import { executeRpc, getServer, HttpError } from "../servers.ts";
import { ctxOf } from "./servers.ts";

const pkgDir = (id: number) => path.join(config.filesDir, "packages", String(id));
const buildDir = path.join(config.filesDir, "installers");

interface PackageRow {
  id: number; filename: string; version: string; arch: string; sha256: string; size: number; stored_path: string;
  source: string; uploaded_by: string; created_at: number;
}
interface ProfileRow { id: number; name: string; description: string; settings: string; created_by: string; created_at: number; updated_at: number }
interface BuildRow {
  id: number; name: string; product_version: string; upgrade_code: string; package_id: number | null; profile_ids: string; options: string;
  stored_path: string | null; sha256: string | null; size: number | null; status: string; log: string; created_by: string; created_at: number;
  kind: string; server_id: number | null; hub: string | null; username: string | null; template_id: number | null; file_name: string | null; product_code: string | null;
}

/** Profile secrets (password, hash, client key) are sealed at rest. */
function storeSettings(s: ProfileSettings): string {
  return JSON.stringify({
    ...s,
    password: s.password ? seal(s.password) : undefined,
    hashedPassword: s.hashedPassword ? seal(s.hashedPassword) : undefined,
    clientKeyPem: s.clientKeyPem ? seal(s.clientKeyPem) : undefined,
  });
}
function loadSettings(raw: string): ProfileSettings {
  const s = JSON.parse(raw);
  return profileSchema.parse({
    ...s,
    password: s.password ? unseal(s.password) : undefined,
    hashedPassword: s.hashedPassword ? unseal(s.hashedPassword) : undefined,
    clientKeyPem: s.clientKeyPem ? unseal(s.clientKeyPem) : undefined,
  });
}

function publicPackage(p: PackageRow) {
  const meta = JSON.parse(p.source.startsWith("{") ? p.source : `{"source":"${p.source}"}`);
  return { id: p.id, filename: p.filename, version: p.version, arch: p.arch, sha256: p.sha256, size: p.size, uploadedBy: p.uploaded_by, createdAt: p.created_at, ...meta };
}

function publicBuild(b: BuildRow) {
  return {
    id: b.id, name: b.name, productVersion: b.product_version, upgradeCode: b.upgrade_code, packageId: b.package_id,
    profileIds: JSON.parse(b.profile_ids), options: { ...JSON.parse(b.options), clientConfigPassword: undefined },
    sha256: b.sha256, size: b.size, status: b.status, log: b.log, createdBy: b.created_by, createdAt: b.created_at,
    kind: b.kind, serverId: b.server_id, hub: b.hub, username: b.username, templateId: b.template_id, fileName: b.file_name, productCode: b.product_code,
  };
}

function actor(req: FastifyRequest) {
  const u = req.principal!.user;
  return { userId: u.id, username: u.username, ip: req.ip };
}

async function savePackage(buf: Buffer, filename: string, arch: "x64" | "x86" | "arm64", source: Record<string, unknown>, by: string, editionOverride?: "dev" | "stable") {
  const payload = extractPayload(buf, arch);
  if (editionOverride) payload.edition = editionOverride;
  const r = run(
    "INSERT INTO client_packages (filename, version, arch, sha256, size, stored_path, source, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)",
    filename, payload.version, arch, sha256Hex(buf), buf.length,
    JSON.stringify({ ...source, edition: payload.edition, files: payload.files.map((f) => ({ name: f.name, size: f.data.length, sha256: sha256Hex(f.data) })) }),
    by, Date.now(),
  );
  const id = Number(r.lastInsertRowid);
  const dir = pkgDir(id);
  await mkdir(dir, { recursive: true });
  for (const f of payload.files) await writeFile(path.join(dir, f.name), f.data);
  run("UPDATE client_packages SET stored_path = ? WHERE id = ?", dir, id);
  return get<PackageRow>("SELECT * FROM client_packages WHERE id = ?", id)!;
}

export default async function deployRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticate);

  app.get("/api/deploy/status", async () => ({ msitools: await msitoolsAvailable() }));

  // ---------------- Client packages ----------------
  app.get("/api/deploy/packages", { preHandler: requireRole("viewer") }, async () =>
    all<PackageRow>("SELECT * FROM client_packages ORDER BY created_at DESC").map(publicPackage));

  app.post("/api/deploy/packages", { preHandler: requireRole("admin") }, async (req, reply) => {
    const part = await req.file();
    if (!part) throw new HttpError(400, "No file uploaded");
    const buf = await part.toBuffer();
    const fields = part.fields as Record<string, { value?: string } | undefined>;
    const arch = z.enum(["x64", "x86", "arm64"]).catch("x64").parse(fields.arch?.value);
    const edition = z.enum(["dev", "stable"]).optional().catch(undefined).parse(fields.edition?.value || undefined);
    let row: PackageRow;
    try {
      row = await savePackage(buf, part.filename, arch, { source: "upload" }, req.principal!.user.username, edition);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    audit({ ...actor(req), action: "package.upload", target: part.filename, details: { arch, sha256: row.sha256 }, success: true });
    reply.code(201);
    return publicPackage(row);
  });

  /** Official SoftEther VPN Client releases on GitHub (Developer Edition). */
  app.get("/api/deploy/releases", { preHandler: requireRole("admin") }, async () => {
    const res = await request("https://api.github.com/repos/SoftEtherVPN/SoftEtherVPN/releases?per_page=5", {
      headers: { "user-agent": "softether-manager", accept: "application/vnd.github+json" },
    });
    if (res.statusCode !== 200) throw new HttpError(502, `GitHub API returned ${res.statusCode}`);
    const releases = (await res.body.json()) as { tag_name: string; name: string; published_at: string; assets: { name: string; browser_download_url: string; size: number }[] }[];
    return releases.map((r) => ({
      tag: r.tag_name, name: r.name, publishedAt: r.published_at,
      assets: r.assets.filter((a) => /vpnclient.*\.(x64|x86|arm64)\.exe$/i.test(a.name)).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
    })).filter((r) => r.assets.length);
  });

  app.post("/api/deploy/packages/import", { preHandler: requireRole("admin") }, async (req, reply) => {
    const b = z.object({ url: z.string().url(), arch: z.enum(["x64", "x86", "arm64"]).default("x64") }).parse(req.body);
    const u = new URL(b.url);
    if (u.hostname !== "github.com" || !u.pathname.startsWith("/SoftEtherVPN/")) {
      throw new HttpError(400, "Only official SoftEtherVPN GitHub release assets can be imported");
    }
    let res = await request(b.url, { headers: { "user-agent": "softether-manager" } });
    for (let i = 0; i < 5 && res.statusCode >= 300 && res.statusCode < 400; i++) {
      await res.body.dump();
      const loc = String(res.headers.location ?? "");
      const lu = new URL(loc, b.url);
      if (!/(^|\.)github(usercontent)?\.com$/.test(lu.hostname)) throw new HttpError(502, `Unexpected redirect to ${lu.hostname}`);
      res = await request(lu, { headers: { "user-agent": "softether-manager" } });
    }
    if (res.statusCode !== 200) throw new HttpError(502, `Download failed with HTTP ${res.statusCode}`);
    const buf = Buffer.from(await res.body.arrayBuffer());
    const filename = decodeURIComponent(u.pathname.split("/").pop() ?? "client.exe");
    let row: PackageRow;
    try {
      row = await savePackage(buf, filename, b.arch, { source: "github", url: b.url }, req.principal!.user.username);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    audit({ ...actor(req), action: "package.import", target: filename, details: { url: b.url, sha256: row.sha256 }, success: true });
    reply.code(201);
    return publicPackage(row);
  });

  app.delete("/api/deploy/packages/:id", { preHandler: requireRole("admin") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const p = get<PackageRow>("SELECT * FROM client_packages WHERE id = ?", id);
    if (!p) throw new HttpError(404, "Package not found");
    run("DELETE FROM client_packages WHERE id = ?", id);
    await rm(pkgDir(id), { recursive: true, force: true });
    audit({ ...actor(req), action: "package.delete", target: p.filename, success: true });
    return { ok: true };
  });

  // ---------------- Connection profiles ----------------
  app.get("/api/deploy/profiles", { preHandler: requireRole("viewer") }, async () =>
    all<ProfileRow>("SELECT * FROM profiles ORDER BY name COLLATE NOCASE").map((p) => ({
      id: p.id, name: p.name, description: p.description, createdBy: p.created_by, createdAt: p.created_at, updatedAt: p.updated_at,
      settings: redactProfile(loadSettings(p.settings)),
    })));

  const profileBody = z.object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1000).default(""),
    settings: profileSchema,
  });

  app.post("/api/deploy/profiles", { preHandler: requireRole("operator") }, async (req, reply) => {
    const b = profileBody.parse(req.body);
    renderVpnFile(b.settings); // validate renderable
    if (get("SELECT 1 FROM profiles WHERE name = ?", b.name)) throw new HttpError(409, "A profile with that name exists");
    const now = Date.now();
    const r = run("INSERT INTO profiles (name, description, settings, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      b.name, b.description, storeSettings(b.settings), req.principal!.user.username, now, now);
    audit({ ...actor(req), action: "profile.create", target: b.name, details: b.settings, success: true });
    reply.code(201);
    return { id: Number(r.lastInsertRowid) };
  });

  app.put("/api/deploy/profiles/:id", { preHandler: requireRole("operator") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const cur = get<ProfileRow>("SELECT * FROM profiles WHERE id = ?", id);
    if (!cur) throw new HttpError(404, "Profile not found");
    const raw = req.body as { settings?: Record<string, unknown> };
    const old = loadSettings(cur.settings);
    // "********" placeholders mean "keep the stored secret"
    const s = { ...(raw.settings ?? {}) };
    for (const k of ["password", "hashedPassword", "clientKeyPem"] as const) {
      if (s[k] === "********") s[k] = old[k];
    }
    const b = profileBody.parse({ ...raw, settings: s });
    renderVpnFile(b.settings);
    run("UPDATE profiles SET name = ?, description = ?, settings = ?, updated_at = ? WHERE id = ?", b.name, b.description, storeSettings(b.settings), Date.now(), id);
    audit({ ...actor(req), action: "profile.update", target: b.name, details: b.settings, success: true });
    return { ok: true };
  });

  app.delete("/api/deploy/profiles/:id", { preHandler: requireRole("operator") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const cur = get<ProfileRow>("SELECT * FROM profiles WHERE id = ?", id);
    if (!cur) throw new HttpError(404, "Profile not found");
    run("DELETE FROM profiles WHERE id = ?", id);
    audit({ ...actor(req), action: "profile.delete", target: cur.name, success: true });
    return { ok: true };
  });

  /** Download the .vpn file (contains the password hash when embedded — audited). */
  app.get("/api/deploy/profiles/:id/vpn", { preHandler: requireRole("operator") }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const cur = get<ProfileRow>("SELECT * FROM profiles WHERE id = ?", id);
    if (!cur) throw new HttpError(404, "Profile not found");
    const s = loadSettings(cur.settings);
    audit({ ...actor(req), action: "profile.download", target: cur.name, success: true });
    reply.header("content-type", "application/x-softether-vpn; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${cur.name.replace(/[^\w.-]+/g, "_")}.vpn"`);
    return renderVpnFile(s);
  });

  /** Render a .vpn without saving (preview / one-off download). */
  app.post("/api/deploy/render", { preHandler: requireRole("operator") }, async (req) => {
    const s = profileSchema.parse(req.body);
    return { content: renderVpnFile(s) };
  });

  /**
   * Build connection settings from a managed server: host/port/hub pre-filled, the server
   * certificate pinned (GetServerCert), and — for password users — the user's stored hash
   * (GetUser HashedKey), so profiles can be issued without knowing the user's password.
   */
  app.post("/api/deploy/from-server", { preHandler: requireRole("operator") }, async (req) => {
    const b = z.object({
      serverId: z.number().int(),
      hub: z.string().min(1),
      username: z.string().optional(),
      host: z.string().optional(),
      port: z.number().int().optional(),
      pinCertificate: z.boolean().default(true),
      includeUserHash: z.boolean().default(false),
    }).parse(req.body);
    const s = getServer(b.serverId);
    if (!s || !canSeeServer(req.principal!.user, s.id)) throw new HttpError(404, "Server not found");
    const ctx = ctxOf(req);
    const out: Partial<ProfileSettings> & { warnings: string[] } = { host: b.host ?? s.host, port: b.port ?? s.port, hub: b.hub, warnings: [] };
    if (b.pinCertificate) {
      try {
        const c = await executeRpc(ctx, s, "GetServerCert", {});
        const der = Buffer.from(String(c.Cert_bin ?? ""), "base64");
        out.serverCertPem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
        out.checkServerCert = true;
      } catch (e) {
        out.warnings.push(`Could not read server certificate: ${(e as Error).message}`);
      }
    }
    if (b.username) {
      out.username = b.username;
      const u = await executeRpc(ctx, s, "GetUser", { HubName_str: b.hub, Name_str: b.username });
      const authType = Number(u.AuthType_u32);
      if (authType === 1) {
        out.authType = "password";
        if (b.includeUserHash && !u.HashedKey_bin) {
          out.warnings.push("Copying a user's password hash requires the admin role on this server");
        } else if (b.includeUserHash) {
          out.hashedPassword = String(u.HashedKey_bin);
          audit({ ...actor(req), action: "profile.user_hash_export", serverId: s.id, serverName: s.name, hub: b.hub, target: b.username, success: true });
        }
      } else if (authType === 4 || authType === 5) out.authType = "radius";
      else if (authType === 2 || authType === 3) out.authType = "certificate";
      else out.authType = "anonymous";
    }
    return out;
  });

  // ---------------- MSI installers ----------------
  app.get("/api/deploy/installers", { preHandler: requireRole("viewer") }, async () =>
    all<BuildRow>("SELECT * FROM installer_builds ORDER BY created_at DESC").map(publicBuild));

  app.post("/api/deploy/installers", { preHandler: requireRole("operator") }, async (req, reply) => {
    const b = z.object({
      name: z.string().trim().min(1).max(100),
      packageId: z.number().int(),
      profileIds: z.array(z.number().int()).min(1).max(16),
      options: msiOptionsSchema,
    }).parse(req.body);
    const tools = await msitoolsAvailable();
    if (!tools.ok) throw new HttpError(503, tools.error!);
    const pkg = get<PackageRow>("SELECT * FROM client_packages WHERE id = ?", b.packageId);
    if (!pkg) throw new HttpError(404, "Client package not found");
    const meta = JSON.parse(pkg.source) as { edition: "dev" | "stable"; files: { name: string }[] };
    const profiles = b.profileIds.map((id, i) => {
      const p = get<ProfileRow>("SELECT * FROM profiles WHERE id = ?", id);
      if (!p) throw new HttpError(404, `Profile ${id} not found`);
      const s = loadSettings(p.settings);
      // Only "embedded" mode ships a credential inside the MSI; otherwise it is set at install time or by the user.
      if (b.options.credentialMode !== "embedded" && (s.authType === "password" || s.authType === "radius")) { s.hashedPassword = undefined; s.password = ""; }
      return { accountName: s.accountName, fileName: `profile${i + 1}.vpn`, content: renderVpnFile({ ...s, deviceName: b.options.nicName }), startup: s.startup, authType: s.authType === "radius" ? "radius" : "standard" };
    });
    const dupe = profiles.map((p) => p.accountName.toLowerCase()).find((n, i, a) => a.indexOf(n) !== i);
    if (dupe) throw new HttpError(400, `Two profiles share the account name '${dupe}'`);
    // MajorUpgrade only replaces strictly lower versions: a same-version rebuild would install side by side
    if (get("SELECT 1 FROM installer_builds WHERE name = ? AND product_version = ? AND status = 'ready'", b.name, b.options.productVersion)) {
      throw new HttpError(409, `Installer '${b.name}' version ${b.options.productVersion} already exists; use a higher version`);
    }
    // Reuse the upgrade code of earlier builds with the same name so new versions upgrade in place
    const prev = get<{ upgrade_code: string }>("SELECT upgrade_code FROM installer_builds WHERE name = ? ORDER BY created_at DESC LIMIT 1", b.name);
    const upgradeCode = (b.options.upgradeCode ?? prev?.upgrade_code ?? randomUUID()).toUpperCase();
    const options = { ...b.options, upgradeCode };
    const r = run(
      `INSERT INTO installer_builds (name, product_version, upgrade_code, package_id, profile_ids, options, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'building', ?, ?)`,
      b.name, options.productVersion, upgradeCode, pkg.id, JSON.stringify(b.profileIds),
      JSON.stringify({ ...options, clientConfigPassword: options.clientConfigPassword ? seal(options.clientConfigPassword) : undefined }),
      req.principal!.user.username, Date.now(),
    );
    const id = Number(r.lastInsertRowid);
    const safe = b.name.replace(/[^\w.-]+/g, "_");
    try {
      const res = await buildMsi({
        options, edition: meta.edition, arch: pkg.arch as "x64",
        payload: meta.files.map((f) => ({ name: f.name, path: path.join(pkg.stored_path, f.name) })),
        profiles,
      }, buildDir, `${id}-${safe}-${options.productVersion}.msi`);
      const tableSummary = Object.entries(res.tables).map(([t, v]) => `== ${t}\n${v.trim()}`).join("\n\n");
      run("UPDATE installer_builds SET status = 'ready', stored_path = ?, sha256 = ?, size = ?, log = ? WHERE id = ?",
        res.msiPath, res.sha256, res.size, `${res.log}\n\n${tableSummary}`, id);
      audit({ ...actor(req), action: "installer.build", target: b.name, details: { id, version: options.productVersion, packageId: pkg.id, profileIds: b.profileIds, credentialMode: options.credentialMode }, success: true });
    } catch (e) {
      run("UPDATE installer_builds SET status = 'failed', log = ? WHERE id = ?", (e as Error).message, id);
      audit({ ...actor(req), action: "installer.build", target: b.name, success: false, error: (e as Error).message });
    }
    reply.code(201);
    return publicBuild(get<BuildRow>("SELECT * FROM installer_builds WHERE id = ?", id)!);
  });

  app.get("/api/deploy/installers/:id/download", async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const b = get<BuildRow>("SELECT * FROM installer_builds WHERE id = ?", id);
    if (!b?.stored_path || b.status !== "ready") throw new HttpError(404, "Installer not available");
    // Hub packages: operators of that hub may download; others need the global operator role
    const u = req.principal!.user;
    const allowed = b.server_id !== null && b.hub
      ? canSeeServer(u, b.server_id) && roleAtLeast(effectiveRole(u, b.server_id, b.hub), "operator")
      : roleAtLeast(u.role, "operator");
    if (!allowed) throw new HttpError(403, "Requires the operator role");
    audit({ ...actor(req), action: "installer.download", serverId: b.server_id, hub: b.hub, target: b.file_name ?? b.name, details: { id, kind: b.kind, user: b.username }, success: true });
    const fileName = b.file_name ?? `${b.name.replace(/[^\w.-]+/g, "_")}-${b.product_version}.msi`;
    const types: Record<string, string> = { msi: "application/x-msi", exe: "application/vnd.microsoft.portable-executable", vpn: "application/x-softether-vpn" };
    reply.header("content-type", types[b.kind] ?? "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`);
    return reply.send(createReadStream(b.stored_path));
  });

  /** The WiX source + scripts of a build, for review by security teams. */
  app.get("/api/deploy/installers/:id/source", { preHandler: requireRole("operator") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = get<BuildRow>("SELECT * FROM installer_builds WHERE id = ?", id);
    if (!b) throw new HttpError(404, "Installer not found");
    return { log: b.log };
  });

  app.delete("/api/deploy/installers/:id", { preHandler: requireRole("operator") }, async (req) => {
    const id = Number((req.params as { id: string }).id);
    const b = get<BuildRow>("SELECT * FROM installer_builds WHERE id = ?", id);
    if (!b) throw new HttpError(404, "Installer not found");
    run("DELETE FROM installer_builds WHERE id = ?", id);
    if (b.stored_path) await rm(b.stored_path, { force: true });
    audit({ ...actor(req), action: "installer.delete", target: b.name, success: true });
    return { ok: true };
  });

}
