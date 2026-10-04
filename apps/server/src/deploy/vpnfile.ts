// Generator for SoftEther VPN Client connection setting files (.vpn, "AccountExport" format).
// Format: Mayaqua/Cfg.c text mode; fields: Cedar/Client.c CiWriteAccountData/CiWriteClientOption/CiWriteClientAuth.
import { z } from "zod";

// ---- SHA-0 (SoftEther's password hash primitive, Mayaqua/Encrypt.c Internal_Sha0) ----
export function sha0(data: Buffer): Buffer {
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const ml = data.length * 8;
  const padLen = (55 - data.length) % 64;
  const padded = Buffer.alloc(data.length + 1 + (padLen < 0 ? padLen + 64 : padLen) + 8);
  data.copy(padded);
  padded[data.length] = 0x80;
  padded.writeBigUInt64BE(BigInt(ml), padded.length - 8);
  const rol = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
  const w = new Uint32Array(80);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = padded.readUInt32BE(i + t * 4);
    for (let t = 16; t < 80; t++) w[t] = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]; // no rotate: SHA-0
    let [a, b, c, d, e] = h;
    for (let t = 0; t < 80; t++) {
      let f: number, k: number;
      if (t < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (t < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const tmp = (rol(a, 5) + (f >>> 0) + e + k + w[t]) >>> 0;
      e = d; d = c; c = rol(b, 30); b = a; a = tmp;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0;
  }
  const out = Buffer.alloc(20);
  h.forEach((v, i) => out.writeUInt32BE(v, i * 4));
  return out;
}

/** Cedar/Account.c HashPassword: SHA0(password || ASCII-uppercase(username)). Same value the server stores as HashedKey. */
export function softEtherPasswordHash(username: string, password: string): Buffer {
  const upper = username.replace(/[a-z]/g, (c) => c.toUpperCase());
  return sha0(Buffer.concat([Buffer.from(password, "utf8"), Buffer.from(upper, "utf8")]));
}

// ---- Cfg text escaping (Mayaqua/Cfg.c CfgEscape) ----
export function cfgEscape(s: string): string {
  if (s === "") return "$";
  let out = "";
  for (const byte of Buffer.from(s, "utf8")) {
    if (byte <= 0x20 || byte === 0x24 /* $ */ || byte === 0x7f) out += "$" + byte.toString(16).toUpperCase().padStart(2, "0");
    else out += String.fromCharCode(byte);
  }
  // re-decode multibyte UTF-8 sequences we passed through byte-wise
  return Buffer.from(out, "latin1").toString("utf8");
}

export const profileSchema = z.object({
  // Passed to vpncmd and embedded in scripts: no quotes, backticks or control characters
  accountName: z.string().trim().min(1).max(255).regex(/^[^"`\x00-\x1f\u2018-\u201b]+$/, "Account name must not contain quotes, backticks or control characters")
    .refine((v) => !v.startsWith("/"), "Account name must not start with '/'"),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(443),
  hub: z.string().trim().min(1).max(255),
  authType: z.enum(["anonymous", "password", "radius", "certificate"]).default("password"),
  username: z.string().max(255).default(""),
  /** Password (plain) — hashed for standard auth; for RADIUS/NT it is applied at install time via vpncmd. */
  password: z.string().max(255).optional(),
  /** Base64 SHA-0 hash (e.g. copied from an existing hub user's HashedKey), alternative to password. */
  hashedPassword: z.string().max(64).optional(),
  clientCertPem: z.string().max(20000).optional(),
  clientKeyPem: z.string().max(20000).optional(),
  /** Pin the server certificate (PEM). If set, CheckServerCert is enabled. */
  serverCertPem: z.string().max(20000).optional(),
  checkServerCert: z.boolean().default(true),
  addDefaultCa: z.boolean().default(false),
  deviceName: z.string().regex(/^VPN([1-9]|[1-9]\d|1[01]\d|12[0-7])?$/, "NIC name must be VPN, VPN2 … VPN127").default("VPN"),
  startup: z.boolean().default(true),
  maxConnection: z.number().int().min(1).max(32).default(1),
  useEncrypt: z.boolean().default(true),
  useCompress: z.boolean().default(false),
  halfConnection: z.boolean().default(false),
  noUdpAcceleration: z.boolean().default(false),
  disableQoS: z.boolean().default(false),
  noRoutingTracking: z.boolean().default(false),
  requireBridgeRoutingMode: z.boolean().default(false),
  requireMonitorMode: z.boolean().default(false),
  additionalConnectionInterval: z.number().int().min(1).max(3600).default(1),
  connectionDisconnectSpan: z.number().int().min(0).default(0),
  numRetry: z.number().int().min(0).max(4294967295).default(4294967295),
  retryInterval: z.number().int().min(5).max(3600).default(15),
  hideStatusWindow: z.boolean().default(false),
  hideNicInfoWindow: z.boolean().default(false),
  proxyType: z.enum(["direct", "http", "socks4", "socks5"]).default("direct"),
  proxyHost: z.string().max(255).default(""),
  proxyPort: z.number().int().min(0).max(65535).default(0),
  proxyUsername: z.string().max(255).default(""),
});
export type ProfileSettings = z.infer<typeof profileSchema>;

export function pemToDer(pem: string): Buffer {
  const b64 = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  return Buffer.from(b64, "base64");
}

const AUTH_TYPE = { anonymous: 0, password: 1, radius: 2, certificate: 3 } as const;
const PROXY_TYPE = { direct: 0, http: 1, socks4: 2, socks5: 3 } as const;

/**
 * Render a .vpn file. Returns the text (UTF-8, no BOM, begins with a comment line so the
 * first token is never glued to a BOM).
 */
export function renderVpnFile(p: ProfileSettings): string {
  const lines: string[] = [];
  const item = (indent: number, type: string, name: string, value: string | number | boolean) => {
    const v = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
    lines.push(`${"\t".repeat(indent)}${type} ${name} ${v}`);
  };
  lines.push("# VPN Client VPN Connection Setting File", "# ", "# Generated by SoftEther Manager.", "# ", "");
  lines.push("declare root", "{");
  const serverCert = p.serverCertPem ? pemToDer(p.serverCertPem) : null;
  item(1, "bool", "AddDefaultCA", p.addDefaultCa);
  item(1, "bool", "CheckServerCert", p.checkServerCert || !!serverCert);
  item(1, "uint64", "CreateDateTime", 0);
  item(1, "uint64", "LastConnectDateTime", 0);
  item(1, "bool", "RetryOnServerCert", false);
  if (serverCert) item(1, "byte", "ServerCert", serverCert.toString("base64"));
  item(1, "bool", "StartupAccount", p.startup);
  item(1, "uint64", "UpdateDateTime", 0);
  lines.push("");

  lines.push("\tdeclare ClientAuth", "\t{");
  item(2, "uint", "AuthType", AUTH_TYPE[p.authType]);
  if (p.authType === "password") {
    // No credential: leave the hash empty so the client asks for / is given the password later
    // (AccountPasswordSet at install time), instead of shipping a hash of an empty password.
    const hash = p.hashedPassword
      ? Buffer.from(p.hashedPassword, "base64")
      : p.password ? softEtherPasswordHash(p.username, p.password) : null;
    item(2, "byte", "HashedPassword", hash ? hash.toString("base64") : "$");
  }
  if (p.authType === "radius") {
    // Encrypted with a build-dependent RC4 key; the installer applies it with AccountPasswordSet instead.
    item(2, "byte", "EncryptedPassword", "$");
  }
  if (p.authType === "certificate") {
    if (!p.clientCertPem || !p.clientKeyPem) throw new Error("Certificate authentication needs a client certificate and private key");
    item(2, "byte", "ClientCert", pemToDer(p.clientCertPem).toString("base64"));
    item(2, "byte", "ClientKey", pemToDer(p.clientKeyPem).toString("base64"));
  }
  item(2, "string", "Username", cfgEscape(p.username));
  lines.push("\t}");

  lines.push("\tdeclare ClientOption", "\t{");
  item(2, "string", "AccountName", cfgEscape(p.accountName));
  item(2, "uint", "AdditionalConnectionInterval", p.additionalConnectionInterval);
  item(2, "uint", "ConnectionDisconnectSpan", p.connectionDisconnectSpan);
  item(2, "string", "DeviceName", p.deviceName);
  item(2, "bool", "DisableQoS", p.disableQoS);
  item(2, "bool", "HalfConnection", p.halfConnection);
  item(2, "bool", "HideNicInfoWindow", p.hideNicInfoWindow);
  item(2, "bool", "HideStatusWindow", p.hideStatusWindow);
  item(2, "string", "Hostname", cfgEscape(p.host));
  item(2, "string", "HubName", cfgEscape(p.hub));
  item(2, "uint", "MaxConnection", p.maxConnection);
  item(2, "bool", "NoRoutingTracking", p.noRoutingTracking);
  item(2, "bool", "NoUdpAcceleration", p.noUdpAcceleration);
  item(2, "uint", "NumRetry", p.numRetry);
  item(2, "uint", "Port", p.port);
  item(2, "uint", "PortUDP", 0);
  item(2, "string", "ProxyName", cfgEscape(p.proxyHost));
  item(2, "byte", "ProxyPassword", "$");
  item(2, "uint", "ProxyPort", p.proxyPort);
  item(2, "uint", "ProxyType", PROXY_TYPE[p.proxyType]);
  item(2, "string", "ProxyUsername", cfgEscape(p.proxyUsername));
  item(2, "bool", "RequireBridgeRoutingMode", p.requireBridgeRoutingMode);
  item(2, "bool", "RequireMonitorMode", p.requireMonitorMode);
  item(2, "uint", "RetryInterval", p.retryInterval);
  item(2, "bool", "UseCompress", p.useCompress);
  item(2, "bool", "UseEncrypt", p.useEncrypt);
  lines.push("\t}", "}", "");
  return lines.join("\r\n");
}

/** Remove secrets before returning a stored profile to the browser. */
export function redactProfile(p: ProfileSettings) {
  return {
    ...p,
    password: p.password ? "********" : undefined,
    hashedPassword: p.hashedPassword ? "********" : undefined,
    clientKeyPem: p.clientKeyPem ? "********" : undefined,
    hasPassword: !!(p.password || p.hashedPassword),
    hasClientKey: !!p.clientKeyPem,
  };
}
