// Live, per-hub client deployment: every hub on every managed server has a connection profile
// derived from a template (plus optional per-hub overrides), and every user in the hub gets their
// own profile on demand. Packages (.vpn / MSI / branded setup.exe) are built on request.
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { config } from "../config.ts";
import { all, get, run } from "../db.ts";
import { executeRpc, HttpError, type RpcContext, type ServerRow } from "../servers.ts";
import { profileSchema, renderVpnFile, softEtherPasswordHash, type ProfileSettings } from "./vpnfile.ts";
import { buildMsi, msiOptionsSchema, type MsiOptions } from "./msi.ts";
import { applyStringOverrides, brandPe, CLIENT_NAME_KEYS, MANAGER_NAME_KEYS } from "./branding.ts";
import { defaultTemplate, fillPattern, getTemplate, loadTemplateSettings, type TemplateRow, type TemplateSettings } from "./templates.ts";

export interface HubProfileRow {
  server_id: number; hub: string; template_id: number | null; public_host: string | null; public_port: number | null;
  account_name: string | null; upgrade_code: string; enabled: number; updated_at: number;
}

export const STUB_DIR = path.resolve(import.meta.dirname, "../../assets");
const OUT_DIR = path.join(config.filesDir, "installers");

/** Per-hub row, created lazily (stable upgrade code) the first time it is needed. */
export function hubProfileRow(serverId: number, hub: string): HubProfileRow {
  let r = get<HubProfileRow>("SELECT * FROM hub_profiles WHERE server_id = ? AND hub = ?", serverId, hub);
  if (!r) {
    run("INSERT INTO hub_profiles (server_id, hub, upgrade_code, updated_at) VALUES (?, ?, ?, ?)", serverId, hub, randomUUID().toUpperCase(), Date.now());
    r = get<HubProfileRow>("SELECT * FROM hub_profiles WHERE server_id = ? AND hub = ?", serverId, hub)!;
  }
  return r;
}

export function peekHubProfile(serverId: number, hub: string): HubProfileRow | undefined {
  return get<HubProfileRow>("SELECT * FROM hub_profiles WHERE server_id = ? AND hub = ?", serverId, hub);
}

export function templateFor(row: { template_id: number | null } | undefined): TemplateRow {
  return (row?.template_id ? getTemplate(row.template_id) : undefined) ?? defaultTemplate();
}

export interface EffectiveHubProfile {
  serverId: number; serverName: string; hub: string;
  template: { id: number; name: string };
  host: string; port: number; accountName: string;
  overrides: { templateId: number | null; publicHost: string | null; publicPort: number | null; accountName: string | null };
  enabled: boolean;
}

export function effectiveHubProfile(server: ServerRow, hub: string): EffectiveHubProfile {
  const row = peekHubProfile(server.id, hub);
  const t = templateFor(row);
  const s = loadTemplateSettings(t.settings);
  return {
    serverId: server.id, serverName: server.name, hub,
    template: { id: t.id, name: t.name },
    host: row?.public_host || s.connection.publicHost || server.host,
    port: row?.public_port || s.connection.publicPort || server.port,
    accountName: row?.account_name || fillPattern(s.connection.accountNamePattern, { server: server.name, hub }),
    overrides: { templateId: row?.template_id ?? null, publicHost: row?.public_host ?? null, publicPort: row?.public_port ?? null, accountName: row?.account_name ?? null },
    enabled: row ? !!row.enabled : true,
  };
}

// SoftEther user auth types (Cedar.h AUTHTYPE_*)
const AUTH = { 0: "anonymous", 1: "password", 2: "user-certificate", 3: "root-certificate", 4: "radius", 5: "nt-domain" } as const;

export interface UserDeployability { deployable: boolean; credential: string; reason?: string }

/** What a package for this user would contain, given the template's credential policy. */
export function userDeployability(authType: number, s: TemplateSettings): UserDeployability {
  if (authType === 0) return { deployable: true, credential: "anonymous" };
  if (authType === 1) return { deployable: true, credential: s.credentials.passwordUsers };
  if (authType === 4 || authType === 5) {
    return { deployable: true, credential: s.credentials.passwordUsers === "install-time" ? "install-time" : "prompt" };
  }
  return { deployable: false, credential: "certificate", reason: "Certificate users need their own certificate and private key, which the server does not hold; create a manual profile with the user's certificate instead." };
}

function derToPem(b64: string) {
  return `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** Uniform random password containing lowercase, uppercase, digit and symbol (at random positions). */
function generatePassword(len: number) {
  const classes = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "-_.!@#%+="];
  const all = classes.join("");
  const pick = (set: string) => {
    const limit = 256 - (256 % set.length); // rejection sampling: no modulo bias
    for (;;) { const b = randomBytes(1)[0]; if (b < limit) return set[b % set.length]; }
  };
  const chars = Array.from({ length: len }, () => pick(all));
  const positions = new Set<number>();
  while (positions.size < classes.length) positions.add(randomBytes(4).readUInt32BE(0) % len);
  [...positions].forEach((pos, i) => { chars[pos] = pick(classes[i]); });
  return chars.join("");
}

export interface ResolvedPackage {
  profile: ProfileSettings;
  template: TemplateRow;
  settings: TemplateSettings;
  hubProfile: EffectiveHubProfile;
  credential: string;
  issuedPassword?: string;
  warnings: string[];
}

/**
 * Resolve the connection profile for a hub (user = null: generic hub profile, the user types their
 * name and password) or for one user. `mutate` must be true to allow the "rotate" policy to set a
 * new password on the server.
 */
export async function resolveProfile(ctx: RpcContext, server: ServerRow, hub: string, username: string | null, mutate: boolean): Promise<ResolvedPackage> {
  const hp = effectiveHubProfile(server, hub);
  const t = templateFor(peekHubProfile(server.id, hub));
  const s = loadTemplateSettings(t.settings);
  const warnings: string[] = [];
  const c = s.connection;
  let serverCertPem: string | undefined;
  if (c.pinServerCertificate) {
    try {
      const cert = await executeRpc(ctx, server, "GetServerCert", {});
      if (cert.Cert_bin) serverCertPem = derToPem(String(cert.Cert_bin));
    } catch (e) {
      warnings.push(`Server certificate not pinned: ${(e as Error).message}`);
    }
  }
  let authType: ProfileSettings["authType"] = "password";
  let credential = "prompt";
  let hashedPassword: string | undefined;
  let issuedPassword: string | undefined;
  if (username) {
    const u = await executeRpc(ctx, server, "GetUser", { HubName_str: hub, Name_str: username });
    const d = userDeployability(Number(u.AuthType_u32), s);
    if (!d.deployable) throw new HttpError(422, d.reason!);
    credential = d.credential;
    const at = Number(u.AuthType_u32);
    authType = at === 0 ? "anonymous" : at === 1 ? "password" : "radius";
    if (at === 1 && credential === "embed-hash") {
      if (!u.HashedKey_bin) throw new HttpError(403, "Embedding a user's password hash requires the admin role on this server (or choose another credential policy)");
      hashedPassword = String(u.HashedKey_bin);
    }
    if (at === 1 && credential === "rotate") {
      if (!mutate) {
        credential = "rotate (on build)";
      } else {
        issuedPassword = generatePassword(s.credentials.rotateLength);
        await executeRpc(ctx, server, "SetUser", { ...u, HubName_str: hub, Name_str: username, Auth_Password_str: issuedPassword }, { auditAction: "deploy.rotate_password" });
        hashedPassword = softEtherPasswordHash(username, issuedPassword).toString("base64");
      }
    }
  }
  const profile = profileSchema.parse({
    accountName: hp.accountName.replace(/\{user\}/g, username ?? ""),
    host: hp.host, port: hp.port, hub,
    authType, username: username ?? "", hashedPassword,
    serverCertPem, checkServerCert: c.checkServerCert || !!serverCertPem, addDefaultCa: c.addDefaultCa,
    deviceName: s.installer.nicName, startup: c.startup, maxConnection: c.maxConnection, useEncrypt: c.useEncrypt,
    useCompress: c.useCompress, halfConnection: c.halfConnection, noUdpAcceleration: c.noUdpAcceleration, disableQoS: c.disableQoS,
    noRoutingTracking: c.noRoutingTracking, additionalConnectionInterval: c.additionalConnectionInterval,
    connectionDisconnectSpan: c.connectionDisconnectSpan, numRetry: c.numRetry, retryInterval: c.retryInterval,
    hideStatusWindow: c.hideStatusWindow, hideNicInfoWindow: c.hideNicInfoWindow,
    proxyType: c.proxyType, proxyHost: c.proxyHost, proxyPort: c.proxyPort, proxyUsername: c.proxyUsername,
  });
  return { profile, template: t, settings: s, hubProfile: hp, credential, issuedPassword, warnings };
}

interface PackageRow { id: number; filename: string; arch: string; stored_path: string; source: string }

function pickPackage(s: TemplateSettings): PackageRow {
  const p = s.installer.packageId
    ? get<PackageRow>("SELECT * FROM client_packages WHERE id = ?", s.installer.packageId)
    : get<PackageRow>("SELECT * FROM client_packages WHERE arch = ? ORDER BY created_at DESC LIMIT 1", s.installer.arch);
  if (!p) throw new HttpError(409, `No ${s.installer.arch} client package uploaded yet (Client packages page)`);
  return p;
}

/** Next auto-incremented product version for this hub (major.minor from the template). */
function nextVersion(serverId: number, hub: string, base: string): string {
  const prefix = `${base}.`;
  const rows = all<{ product_version: string }>(
    "SELECT product_version FROM installer_builds WHERE server_id = ? AND hub = ? AND kind != 'vpn' AND product_version LIKE ?", serverId, hub, `${prefix}%`);
  const max = rows.reduce((m, r) => Math.max(m, Number(r.product_version.slice(prefix.length)) || 0), 0);
  if (max >= 65535) throw new HttpError(409, `Build numbers for ${base}.x are exhausted; raise the template's base version`);
  return `${prefix}${max + 1}`;
}

const safeName = (s: string) => s.replace(/[^\w.@-]+/g, "_").replace(/^_+|_+$/g, "") || "vpn";

export interface BuiltPackage {
  id: number; kind: "vpn" | "msi" | "exe"; fileName: string; size: number; sha256: string;
  productVersion: string | null; issuedPassword?: string; credential: string; warnings: string[]; log: string;
}

/** Build and store a package for a hub (user = null) or a user. */
export async function buildHubPackage(
  ctx: RpcContext, server: ServerRow, hub: string, username: string | null, kind: "vpn" | "msi" | "exe",
): Promise<BuiltPackage> {
  const r = await resolveProfile(ctx, server, hub, username, true);
  const s = r.settings;
  const vars = { server: server.name, hub, user: username ?? "" };
  const vpnText = renderVpnFile(r.profile);
  const by = ctx.principal.user.username;
  await mkdir(OUT_DIR, { recursive: true });
  const record = (fields: { fileName: string; path: string; data: Buffer; version: string | null; productCode?: string | null; log: string }) => {
    const sha = createHash("sha256").update(fields.data).digest("hex");
    const res = run(
      `INSERT INTO installer_builds (name, product_version, upgrade_code, package_id, profile_ids, options, stored_path, sha256, size, status, log,
         created_by, created_at, kind, server_id, hub, username, template_id, file_name, product_code)
       VALUES (?, ?, ?, NULL, '[]', ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `${server.name}/${hub}${username ? `/${username}` : ""}`, fields.version ?? "", hubProfileRow(server.id, hub).upgrade_code,
      JSON.stringify({ template: r.template.name, credential: r.credential }), fields.path, sha, fields.data.length, fields.log,
      by, Date.now(), kind, server.id, hub, username, r.template.id, fields.fileName, fields.productCode ?? null,
    );
    return { id: Number(res.lastInsertRowid), sha };
  };

  if (kind === "vpn") {
    const fileName = `${safeName(r.profile.accountName)}${username ? `-${safeName(username)}` : ""}.vpn`;
    const data = Buffer.from(vpnText, "utf8");
    const file = path.join(OUT_DIR, `${randomUUID()}.vpn`);
    await writeFile(file, data, { mode: 0o600 });
    const rec = record({ fileName, path: file, data, version: null, log: r.warnings.join("\n") });
    return { id: rec.id, kind, fileName, size: data.length, sha256: rec.sha, productVersion: null, issuedPassword: r.issuedPassword, credential: r.credential, warnings: r.warnings, log: "" };
  }

  // ---- MSI (and optionally the setup.exe wrapper) ----
  const pkg = pickPackage(s);
  const meta = JSON.parse(pkg.source) as { edition: "dev" | "stable"; files: { name: string }[] };
  const work = await mkdtemp(path.join(os.tmpdir(), "sem-pkg-"));
  const log: string[] = [...r.warnings.map((w) => `warning: ${w}`)];
  try {
    const icon = s.branding.iconIco ? Buffer.from(s.branding.iconIco, "base64") : null;
    const productName = fillPattern(s.installer.productName, vars);
    const version = nextVersion(server.id, hub, s.installer.baseVersion);
    // Client payload, branded where SoftEther allows it without a rebuild
    const payload: { name: string; path: string }[] = [];
    for (const f of meta.files) {
      let data: Buffer = await readFile(path.join(pkg.stored_path, f.name));
      if (f.name === "hamcore.se2") {
        const overrides: Record<string, string> = { ...s.client.stringOverrides };
        if (s.client.displayName) for (const k of CLIENT_NAME_KEYS) overrides[k] ??= s.client.displayName;
        if (s.client.managerName) for (const k of MANAGER_NAME_KEYS) overrides[k] ??= s.client.managerName;
        if (Object.keys(overrides).length) {
          try {
            const res = applyStringOverrides(data, overrides);
            data = res.hamcore;
            log.push(`client strings overridden: ${res.applied.join(", ") || "(none)"}`);
            if (res.missing.length) log.push(`warning: string keys not found in this client version: ${res.missing.join(", ")}`);
          } catch (e) {
            log.push(`warning: client string branding skipped (${(e as Error).message})`);
          }
        }
      }
      if (s.client.brandBinaries && (f.name === "vpnclient.exe" || f.name === "vpncmgr.exe")) {
        try {
          data = brandPe(data, {
            icon,
            strings: {
              CompanyName: s.installer.manufacturer,
              ProductName: s.client.displayName || productName,
              FileDescription: f.name === "vpncmgr.exe" ? (s.client.managerName || `${productName} Manager`) : (s.client.displayName || productName),
            },
          });
          log.push(`${f.name}: icon and version information branded`);
        } catch (e) {
          log.push(`warning: ${f.name} branding skipped (${(e as Error).message})`);
        }
      }
      const p = path.join(work, f.name);
      await writeFile(p, data);
      payload.push({ name: f.name, path: p });
    }
    const credentialMode: MsiOptions["credentialMode"] = r.credential === "install-time" ? "install-time"
      : (r.profile.hashedPassword ? "embedded" : "none");
    const options = msiOptionsSchema.parse({
      productName, manufacturer: s.installer.manufacturer, productVersion: version, upgradeCode: hubProfileRow(server.id, hub).upgrade_code,
      installFolder: s.installer.installFolder, connectAfterInstall: s.installer.connectAfterInstall,
      deleteProfileAfterImport: s.installer.deleteProfileAfterImport, startMenuShortcut: s.installer.startMenuShortcut,
      uiHelperAtLogon: s.installer.uiHelperAtLogon, credentialMode, clientConfigPassword: s.installer.clientConfigPassword,
      preserveOnUpgrade: s.installer.preserveOnUpgrade, configureTimeoutSec: s.installer.configureTimeoutSec, nicName: s.installer.nicName,
      arpHelpLink: s.branding.arpHelpLink, arpUrlInfoAbout: s.branding.arpUrlInfoAbout, arpContact: s.branding.arpContact,
      arpHelpTelephone: s.branding.arpHelpTelephone, arpComments: s.branding.arpComments,
      startMenuFolder: fillPattern(s.branding.startMenuFolder, vars), shortcutName: s.branding.shortcutName,
      serviceDisplayName: s.branding.serviceDisplayName, serviceDescription: s.branding.serviceDescription,
    });
    const base = safeName(fillPattern(s.setupExe.fileNamePattern, { ...vars, product: productName }) || productName);
    const msiName = `${base}-${version}.msi`;
    const built = await buildMsi({
      options, icon, edition: meta.edition, arch: s.installer.arch, payload,
      profiles: [{ accountName: r.profile.accountName, fileName: "profile1.vpn", content: vpnText, startup: r.profile.startup, authType: r.profile.authType === "radius" ? "radius" : "standard" }],
    }, OUT_DIR, `${randomUUID()}.msi`);
    log.push(built.log);
    if (kind === "msi") {
      const data = await readFile(built.msiPath);
      const rec = record({ fileName: msiName, path: built.msiPath, data, version, productCode: built.productCode, log: log.join("\n") });
      return { id: rec.id, kind, fileName: msiName, size: data.length, sha256: rec.sha, productVersion: version, issuedPassword: r.issuedPassword, credential: r.credential, warnings: r.warnings, log: log.join("\n") };
    }
    // Branded setup.exe: launcher stub + icon + version info + the MSI as a resource
    const stub = await readFile(path.join(STUB_DIR, `setup-stub-${s.installer.arch}.exe`));
    const cfg = [
      `title=${fillPattern(s.setupExe.productName, vars) || productName}`,
      `ui=${s.setupExe.ui}`,
      `msiName=${msiName}`,
      built.productCode ? `productCode=${built.productCode}` : "",
    ].filter(Boolean).join("\n") + "\n";
    const exe = brandPe(stub, {
      icon: icon ?? await readFile(path.join(STUB_DIR, "default.ico")),
      version: `${version}.0`,
      strings: {
        CompanyName: s.setupExe.companyName || s.installer.manufacturer,
        ProductName: fillPattern(s.setupExe.productName, vars) || productName,
        FileDescription: fillPattern(s.setupExe.fileDescription, vars) || `${productName} Setup`,
        LegalCopyright: s.setupExe.copyright,
        OriginalFilename: `${base}.exe`,
        InternalName: base,
      },
      rcdata: { PAYLOAD: await readFile(built.msiPath), CONFIG: Buffer.from(cfg, "utf8") },
    });
    await rm(built.msiPath, { force: true });
    const exePath = path.join(OUT_DIR, `${randomUUID()}.exe`);
    await writeFile(exePath, exe);
    const fileName = `${base}-${version}.exe`;
    log.push(`setup.exe: ${exe.length} bytes, launcher ${s.installer.arch}, UI ${s.setupExe.ui}`);
    const rec = record({ fileName, path: exePath, data: exe, version, productCode: built.productCode, log: log.join("\n") });
    return { id: rec.id, kind, fileName, size: exe.length, sha256: rec.sha, productVersion: version, issuedPassword: r.issuedPassword, credential: r.credential, warnings: r.warnings, log: log.join("\n") };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
