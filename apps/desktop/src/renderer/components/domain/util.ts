// Pure SoftEther domain helpers shared by server and hub pages: binary (*_bin) encoding, MAC / IPv4 / IPv6
// parsing and masks, dates, CSV, passwords, user auth types. No React, no I/O.
//
// Ported from apps/web: components/hub/util.ts (all of it), the hex helpers and HUB_TYPE_LABELS of
// components/hub-a/shared.tsx, and the IPv4 mask helpers of components/server-a/shared.tsx.
// The web product had two diverging copies of the hex helpers; they are merged here (see README.md):
//   * hexToB64() returns null for invalid input (hub-a's version never failed; validate with isHex() or use `?? ""`).
//   * b64ToHex() separator defaults to "" (hub-a's version defaulted to " ": pass it explicitly).
//   * b64ToBytes() accepts null/undefined and whitespace and returns an empty array for invalid base64.
import type { TagColor } from "../../design";

/* ------------------------------------------------------------------ binary helpers */

export function b64ToBytes(b64: string | undefined | null): Uint8Array {
  if (!b64) return new Uint8Array();
  try {
    const bin = atob(b64.replace(/\s+/g, ""));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Upper-case hex of bytes, e.g. toHex(b, ":") -> "0A:1B". */
export function toHex(bytes: Uint8Array, sep = ":"): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(sep);
}

export function b64ToHex(b64: string | undefined | null, sep = ""): string {
  return toHex(b64ToBytes(b64), sep);
}

/** Accepts "0A1B2C", "0a:1b:2c", "0A 1B 2C", "0a-1b". Returns "" for empty input and null when invalid. */
export function hexToB64(hex: string): string | null {
  const clean = hex.replace(/[\s:-]/g, "");
  if (clean === "") return "";
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytesToB64(out);
}

/** Whether `s` is hex bytes (separators allowed); with `bytes`, also that it is exactly that long (or empty). */
export function isHex(s: string, bytes?: number): boolean {
  const clean = s.replace(/[\s:-]/g, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) return false;
  return bytes === undefined || clean.length === 0 || clean.length === bytes * 2;
}

/* ------------------------------------------------------------------ MAC addresses */

export function macFromB64(b64: string | undefined | null): string {
  const b = b64ToBytes(b64);
  if (b.length === 0) return "";
  return toHex(b, "-");
}

/** "00-11-22-33-44-55", "00:11:22:33:44:55", "0011.2233.4455", "001122334455" -> base64 of 6 bytes. */
export function macToB64(mac: string): string | null {
  const clean = mac.trim().replace(/[\s:.-]/g, "");
  if (!/^[0-9a-fA-F]{12}$/.test(clean)) return null;
  return hexToB64(clean);
}

export const isMac = (s: string) => macToB64(s) !== null;

/* ------------------------------------------------------------------ IPv4 */

/** Dotted IPv4 (surrounding spaces allowed). */
export function isIPv4(s: string) {
  return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s.trim());
}

export function ipToInt(s: string): number {
  return s.trim().split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

export function intToIp(n: number): string {
  return [24, 16, 8, 0].map((sh) => (n >>> sh) & 255).join(".");
}

export function prefixToMask4(prefix: number) {
  if (prefix <= 0) return "0.0.0.0";
  return intToIp((0xffffffff << (32 - Math.min(prefix, 32))) >>> 0);
}

/** Prefix length of a contiguous dotted mask ("255.255.255.0" -> 24), else null. */
export function mask4ToPrefix(mask: string): number | null {
  if (!isIPv4(mask)) return null;
  const n = ipToInt(mask);
  const inv = ~n >>> 0;
  if ((inv & (inv + 1)) !== 0) return null;
  let c = 0;
  for (let i = 31; i >= 0; i--) if ((n >>> i) & 1) c++;
  return c;
}

/** Normalises "24", "/24" or "255.255.255.0" to a dotted mask; null when invalid. */
export function normalizeMask4(input: string): string | null {
  const s = input.trim().replace(/^\//, "");
  if (/^\d{1,2}$/.test(s) && Number(s) <= 32) return prefixToMask4(Number(s));
  if (isIPv4(s) && mask4ToPrefix(s) !== null) return s;
  return null;
}

/** Validate a dotted IPv4 subnet mask (contiguous ones). (server-a/shared) */
export const isMask = (s: string): boolean => mask4ToPrefix(s) !== null;
/** Prefix length of a dotted mask ("255.255.255.0" -> 24). (server-a/shared) */
export const maskBits = (mask: string): number | null => mask4ToPrefix(mask);
/** Dotted mask of a prefix length (24 -> "255.255.255.0"). (server-a/shared) */
export const bitsToMask = (bits: number): string => prefixToMask4(bits);

/** Subnet mask choices for Select / Autocomplete inputs: "255.255.255.0 (/24)". */
export const MASK_OPTIONS = Array.from({ length: 33 }, (_, i) => 32 - i).map((b) => ({ value: prefixToMask4(b), label: `${prefixToMask4(b)} (/${b})` }));

/* ------------------------------------------------------------------ IPv6 */

/** Parse textual IPv6 (with :: compression, optional [brackets], %zone and dotted IPv4 tail) into 16 bytes. */
export function parseIPv6(input: string): Uint8Array | null {
  let s = input.trim();
  if (s === "") return null;
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    if (!isIPv4(maybeV4)) return null;
    const n = ipToInt(maybeV4);
    tail = [(n >>> 16) & 0xffff, n & 0xffff];
    s = s.slice(0, lastColon + 1); // "::ffff:" or "::"
    if (!s.endsWith("::")) s = s.slice(0, -1);
  }
  const dbl = s.split("::");
  if (dbl.length > 2) return null;
  const parseGroups = (p: string) => (p === "" ? [] : p.split(":"));
  const head = parseGroups(dbl[0]);
  const rest = dbl.length === 2 ? parseGroups(dbl[1]) : [];
  const valid = (g: string) => /^[0-9a-fA-F]{1,4}$/.test(g);
  if (![...head, ...rest].every(valid)) return null;
  const total = head.length + rest.length + tail.length;
  let groups: number[];
  if (dbl.length === 2) {
    if (total > 7) return null;
    groups = [...head.map((g) => parseInt(g, 16)), ...Array(8 - total).fill(0), ...rest.map((g) => parseInt(g, 16)), ...tail];
  } else {
    if (total !== 8) return null;
    groups = [...head.map((g) => parseInt(g, 16)), ...tail];
  }
  const out = new Uint8Array(16);
  groups.forEach((g, i) => { out[i * 2] = g >> 8; out[i * 2 + 1] = g & 255; });
  return out;
}

export function isIPv6(s: string) {
  return parseIPv6(s) !== null;
}

/** Format 16 bytes as RFC 5952 compressed IPv6 text. */
export function formatIPv6(bytes: Uint8Array): string {
  if (bytes.length !== 16) return "";
  const g: number[] = [];
  for (let i = 0; i < 8; i++) g.push((bytes[i * 2] << 8) | bytes[i * 2 + 1]);
  let bestStart = -1, bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (bestStart < 0) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}

export const ipv6FromB64 = (b64: string | undefined | null) => formatIPv6(b64ToBytes(b64));
export function ipv6ToB64(text: string): string | null {
  const b = parseIPv6(text);
  return b ? bytesToB64(b) : null;
}

export function prefixToMask6(prefix: number): Uint8Array {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    const bits = Math.max(0, Math.min(8, prefix - i * 8));
    out[i] = bits === 0 ? 0 : (0xff << (8 - bits)) & 0xff;
  }
  return out;
}

/** Prefix length of a contiguous 16-byte mask, else null. */
export function mask6ToPrefix(bytes: Uint8Array): number | null {
  if (bytes.length !== 16) return null;
  let c = 0, ended = false;
  for (const b of bytes) {
    for (let i = 7; i >= 0; i--) {
      const bit = (b >> i) & 1;
      if (bit && ended) return null;
      if (bit) c++; else ended = true;
    }
  }
  return c;
}

/** "64", "/64" or full mask text -> base64 of 16 bytes. */
export function normalizeMask6(input: string): string | null {
  const s = input.trim().replace(/^\//, "");
  if (/^\d{1,3}$/.test(s) && Number(s) <= 128) return bytesToB64(prefixToMask6(Number(s)));
  const b = parseIPv6(s);
  return b && mask6ToPrefix(b) !== null ? bytesToB64(b) : null;
}

/* ------------------------------------------------------------------ certificates (see x509.ts for parsing) */

/**
 * Convert certificate or private key file bytes to the DER base64 SoftEther expects. PEM input is unwrapped
 * (the live server silently ignores PEM private keys); DER passes through. Encrypted PEM keys are rejected.
 * Desktop replacement of the web's certFileToDerB64(File): get the bytes with pickCertDerB64() (files.ts)
 * or openBytes().
 */
export function certBytesToDerB64(bytes: Uint8Array, kind: "cert" | "key"): string {
  const head = new TextDecoder().decode(bytes.subarray(0, 64 * 1024));
  if (!head.includes("-----BEGIN")) return bytesToB64(bytes);
  const text = new TextDecoder().decode(bytes);
  if (/ENCRYPTED/.test(text)) throw new Error("Encrypted private keys aren’t supported. Export the key without a passphrase.");
  const re = kind === "cert"
    ? /-----BEGIN (?:X509 |TRUSTED )?CERTIFICATE-----([\s\S]+?)-----END/
    : /-----BEGIN (?:RSA |EC |)PRIVATE KEY-----([\s\S]+?)-----END/;
  const m = re.exec(text);
  if (!m) throw new Error(kind === "cert" ? "The file has no PEM certificate block." : "The file has no PEM private key block.");
  return m[1].replace(/\s+/g, "");
}

/** Wrap DER base64 as PEM text. */
export function derB64ToPem(b64: string, label = "CERTIFICATE") {
  const lines = b64.replace(/\s+/g, "").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/* ------------------------------------------------------------------ misc */

export function generatePassword(len = 16) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+-=?@_";
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return [...buf].map((n) => alphabet[n % alphabet.length]).join("");
}

/** The SoftEther "zero" datetime used to mean never / unset. */
export const ZERO_DT = "1970-01-01T00:00:00.000Z";

/** ISO -> value for <input type="datetime-local"> (local time); "" for SoftEther's zero date. */
export function isoToLocalInput(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() <= 1970) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function localInputToIso(v: string): string {
  if (!v) return ZERO_DT;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? ZERO_DT : d.toISOString();
}

/* ------------------------------------------------------------------ CSV */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

export function toCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  const esc = (v: string | number | boolean | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}

/** Run async tasks one after another, collecting per-item results (bulk user import, bulk deletes…). */
export async function runSequential<T, R>(items: T[], fn: (item: T) => Promise<R>, onProgress?: (done: number) => void) {
  const results: { item: T; ok: boolean; result?: R; error?: string }[] = [];
  let done = 0;
  for (const item of items) {
    try {
      results.push({ item, ok: true, result: await fn(item) });
    } catch (e) {
      results.push({ item, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    onProgress?.(++done);
  }
  return results;
}

export const yesNo = (b: unknown) => (b ? "Yes" : "No");

/* ------------------------------------------------------------------ hubs and users */

export const HUB_TYPE_LABELS: Record<number, string> = {
  0: "Standalone",
  1: "Static (cluster)",
  2: "Dynamic (cluster)",
};

/** SoftEther user authentication types (AuthType_u32). `color` is a design-system Tag colour (see AuthTag in ui.tsx). */
export const AUTH_TYPES: { value: number; label: string; short: string; color: TagColor; description: string }[] = [
  { value: 0, label: "Anonymous", short: "Anonymous", color: "gray", description: "Anyone who knows the user name can connect. Use it only for testing or public hubs." },
  { value: 1, label: "Password", short: "Password", color: "accent", description: "Standard password authentication, checked by the Virtual Hub." },
  { value: 2, label: "Individual certificate", short: "User cert", color: "purple", description: "The client must present exactly this X.509 certificate and hold its private key." },
  { value: 3, label: "Signed certificate", short: "Signed cert", color: "purple", description: "Any client certificate signed by a CA this hub trusts (Trusted CAs), optionally limited by common name or serial number." },
  { value: 4, label: "RADIUS", short: "RADIUS", color: "teal", description: "The password is checked by the RADIUS server configured for this hub." },
  { value: 5, label: "NT Domain / Active Directory", short: "NT domain", color: "teal", description: "The password is checked against the Windows NT domain or Active Directory the VPN Server belongs to (Windows servers only)." },
];
export const authLabel = (t: number) => AUTH_TYPES.find((a) => a.value === t);
