// Deployment templates: stored, reusable connection defaults, credential policy, installer
// behaviour and branding (MSI, setup.exe launcher and the SoftEther client itself).
import { z } from "zod";
import { all, get, run } from "../db.ts";
import { seal, unseal } from "../crypto.ts";

const text = (max: number) => z.string().max(max);
const optUrl = z.string().max(500).refine((v) => v === "" || /^(https?:\/\/|mailto:)/i.test(v), "Must be an http(s) or mailto: URL").default("");
/** Values embedded in Windows Installer tables / PE resources: no control characters. */
const plain = (max: number, dflt = "") => z.string().max(max).refine((v) => !/[\x00-\x1f]/.test(v), "No control characters").default(dflt);
const pattern = (max: number, dflt: string) => plain(max, dflt);

export const templateSettingsSchema = z.object({
  connection: z.object({
    /** Name shown in the client. Placeholders: {server} {hub} {user} */
    accountNamePattern: pattern(200, "{hub} VPN"),
    /** Hostname/port clients connect to (defaults to the management address of the server) */
    publicHost: text(255).default(""),
    publicPort: z.number().int().min(0).max(65535).default(0),
    pinServerCertificate: z.boolean().default(true),
    checkServerCert: z.boolean().default(true),
    addDefaultCa: z.boolean().default(false),
    startup: z.boolean().default(true),
    maxConnection: z.number().int().min(1).max(32).default(1),
    useEncrypt: z.boolean().default(true),
    useCompress: z.boolean().default(false),
    halfConnection: z.boolean().default(false),
    noUdpAcceleration: z.boolean().default(false),
    disableQoS: z.boolean().default(false),
    noRoutingTracking: z.boolean().default(false),
    additionalConnectionInterval: z.number().int().min(1).max(3600).default(1),
    connectionDisconnectSpan: z.number().int().min(0).default(0),
    numRetry: z.number().int().min(0).max(4294967295).default(4294967295),
    retryInterval: z.number().int().min(5).max(3600).default(15),
    hideStatusWindow: z.boolean().default(false),
    hideNicInfoWindow: z.boolean().default(false),
    proxyType: z.enum(["direct", "http", "socks4", "socks5"]).default("direct"),
    proxyHost: text(255).default(""),
    proxyPort: z.number().int().min(0).max(65535).default(0),
    proxyUsername: text(255).default(""),
  }).prefault({}),
  credentials: z.object({
    /**
     * Password users:
     *  embed-hash    the user's current password hash is embedded (connects immediately; file is password-equivalent)
     *  rotate        a new random password is set on the server and embedded; shown once to the admin
     *  install-time  nothing embedded; pass VPNPASSWORD=… to msiexec / setup.exe
     *  prompt        nothing embedded; the user enters the password in the VPN client
     */
    passwordUsers: z.enum(["embed-hash", "rotate", "install-time", "prompt"]).default("embed-hash"),
    rotateLength: z.number().int().min(12).max(64).default(20),
  }).prefault({}),
  installer: z.object({
    /** Placeholders: {server} {hub} {user} */
    productName: pattern(100, "{hub} VPN"),
    manufacturer: plain(100, "IT Department"),
    /** major.minor; the build number is incremented automatically per hub */
    baseVersion: z.string().regex(/^(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)$/, "major.minor, each 0-255").default("1.0"),
    installFolder: z.string().trim().min(1).max(100).regex(/^[^\\/:*?"<>|\x00-\x1f]+$/, "Not a valid folder name").default("VPN Client"),
    connectAfterInstall: z.boolean().default(true),
    deleteProfileAfterImport: z.boolean().default(true),
    startMenuShortcut: z.boolean().default(true),
    uiHelperAtLogon: z.boolean().default(true),
    preserveOnUpgrade: z.boolean().default(true),
    configureTimeoutSec: z.number().int().min(30).max(1800).default(300),
    nicName: z.string().regex(/^VPN([1-9]|[1-9]\d|1[01]\d|12[0-7])?$/).default("VPN"),
    /** Lock the local client configuration (sealed at rest) */
    clientConfigPassword: z.string().max(255).optional(),
    /** Client package to use (null = newest uploaded package matching the architecture) */
    packageId: z.number().int().nullable().default(null),
    arch: z.enum(["x64", "x86"]).default("x64"),
  }).prefault({}),
  branding: z.object({
    /** .ico (base64); used for Add/Remove Programs, shortcuts, setup.exe and (optionally) the client */
    iconIco: z.string().max(2_000_000).nullable().default(null),
    arpHelpLink: optUrl,
    arpUrlInfoAbout: optUrl,
    arpContact: plain(200),
    arpHelpTelephone: plain(50),
    arpComments: plain(500),
    startMenuFolder: plain(100),
    shortcutName: plain(100, "VPN Client Manager"),
    serviceDisplayName: plain(200),
    serviceDescription: plain(500),
  }).prefault({}),
  setupExe: z.object({
    companyName: plain(200),
    productName: pattern(200, "{hub} VPN"),
    fileDescription: pattern(200, "{hub} VPN Setup"),
    copyright: plain(200),
    ui: z.enum(["basic", "full"]).default("basic"),
    fileNamePattern: pattern(150, "{hub}-{user}-setup"),
  }).prefault({}),
  client: z.object({
    /** Patch icon + version strings of vpnclient.exe / vpncmgr.exe (voids any code signature) */
    brandBinaries: z.boolean().default(false),
    /** Replaces the client product name in window titles, tray and service names (hamcore string tables) */
    displayName: plain(100),
    managerName: plain(100),
    /** Advanced: raw string-table overrides, KEY -> text */
    stringOverrides: z.record(z.string().regex(/^[A-Z0-9_]{2,80}$/), z.string().max(2000)).default({}),
  }).prefault({}),
});
export type TemplateSettings = z.infer<typeof templateSettingsSchema>;

export const templateBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).default(""),
  isDefault: z.boolean().default(false),
  settings: templateSettingsSchema,
});

export interface TemplateRow {
  id: number; name: string; description: string; settings: string; is_default: number;
  created_by: string; created_at: number; updated_at: number;
}

export function sealTemplate(s: TemplateSettings): string {
  return JSON.stringify({
    ...s,
    installer: { ...s.installer, clientConfigPassword: s.installer.clientConfigPassword ? seal(s.installer.clientConfigPassword) : undefined },
  });
}

export function loadTemplateSettings(raw: string): TemplateSettings {
  const s = JSON.parse(raw);
  if (s.installer?.clientConfigPassword) s.installer.clientConfigPassword = unseal(s.installer.clientConfigPassword);
  return templateSettingsSchema.parse(s);
}

export function publicTemplate(t: TemplateRow) {
  const s = loadTemplateSettings(t.settings);
  return {
    id: t.id, name: t.name, description: t.description, isDefault: !!t.is_default,
    createdBy: t.created_by, createdAt: t.created_at, updatedAt: t.updated_at,
    settings: { ...s, installer: { ...s.installer, clientConfigPassword: s.installer.clientConfigPassword ? "********" : undefined } },
  };
}

export function listTemplates(): TemplateRow[] {
  return all<TemplateRow>("SELECT * FROM deploy_templates ORDER BY is_default DESC, name COLLATE NOCASE");
}

export function getTemplate(id: number): TemplateRow | undefined {
  return get<TemplateRow>("SELECT * FROM deploy_templates WHERE id = ?", id);
}

/** The default template, created on first use so every hub always has a working profile. */
export function defaultTemplate(): TemplateRow {
  let t = get<TemplateRow>("SELECT * FROM deploy_templates WHERE is_default = 1 LIMIT 1")
    ?? get<TemplateRow>("SELECT * FROM deploy_templates ORDER BY id LIMIT 1");
  if (!t) {
    const now = Date.now();
    run("INSERT INTO deploy_templates (name, description, settings, is_default, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, 'system', ?, ?)",
      "Default", "Built-in defaults: embeds the user's existing password hash, pins the server certificate, connects at startup.",
      sealTemplate(templateSettingsSchema.parse({})), now, now);
    t = get<TemplateRow>("SELECT * FROM deploy_templates WHERE is_default = 1 LIMIT 1")!;
  }
  return t;
}

export function fillPattern(p: string, vars: { server?: string; hub?: string; user?: string; product?: string }) {
  return p
    .replace(/\{server\}/g, vars.server ?? "")
    .replace(/\{hub\}/g, vars.hub ?? "")
    .replace(/\{user\}/g, vars.user ?? "")
    .replace(/\{product\}/g, vars.product ?? "")
    .replace(/\s+-\s+$|[-_\s]+$/g, "")
    .replace(/--+/g, "-")
    .trim();
}
