// Minimal, dependency-free X.509 helpers for the certificate pages: PEM/DER conversion,
// a tiny DER walker to read serial / subject / issuer / validity, and MD5/SHA digests
// (SoftEther CRL entries match on MD5 and SHA-1 of the certificate's DER encoding).

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function toHex(bytes: Uint8Array, sep = ":"): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(sep);
}

/** DER base64 -> PEM text. */
export function derB64ToPem(b64: string, label = "CERTIFICATE"): string {
  const lines = b64.replace(/\s+/g, "").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * Extract every certificate from file contents: PEM (one or many blocks) or raw DER.
 * Returns base64 DER strings.
 */
export function certsFromFile(bytes: Uint8Array): string[] {
  const text = new TextDecoder("latin1").decode(bytes);
  const blocks = [...text.matchAll(/-----BEGIN (?:X509 |TRUSTED )?CERTIFICATE-----([\s\S]*?)-----END (?:X509 |TRUSTED )?CERTIFICATE-----/g)];
  if (blocks.length) return blocks.map((m) => m[1].replace(/\s+/g, ""));
  if (bytes[0] === 0x30) return [bytesToB64(bytes)];
  return [];
}

// ---- DER walker ---------------------------------------------------------------------------

interface Tlv { tag: number; start: number; len: number; hdr: number; end: number }

function readTlv(b: Uint8Array, pos: number): Tlv {
  const tag = b[pos];
  let len = b[pos + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("Unsupported DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[pos + 2 + i];
    hdr = 2 + n;
  }
  const start = pos + hdr;
  if (start + len > b.length) throw new Error("Truncated DER");
  return { tag, start, len, hdr, end: start + len };
}

function children(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let p = t.start;
  while (p < t.end) { const c = readTlv(b, p); out.push(c); p = c.end; }
  return out;
}

function oid(b: Uint8Array, t: Tlv): string {
  const v = b.subarray(t.start, t.end);
  const parts = [Math.floor(v[0] / 40), v[0] % 40];
  let acc = 0;
  for (let i = 1; i < v.length; i++) {
    acc = acc * 128 + (v[i] & 0x7f);
    if (!(v[i] & 0x80)) { parts.push(acc); acc = 0; }
  }
  return parts.join(".");
}

function str(b: Uint8Array, t: Tlv): string {
  const v = b.subarray(t.start, t.end);
  if (t.tag === 0x1e) { // BMPString
    let s = "";
    for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode((v[i] << 8) | v[i + 1]);
    return s;
  }
  return new TextDecoder(t.tag === 0x0c ? "utf-8" : "latin1").decode(v);
}

function time(b: Uint8Array, t: Tlv): Date | null {
  const s = str(b, t);
  const m = t.tag === 0x17
    ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s)
    : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(s);
  if (!m) return null;
  let y = Number(m[1]);
  if (t.tag === 0x17) y += y < 50 ? 2000 : 1900;
  return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
}

const ATTR: Record<string, string> = {
  "2.5.4.3": "CN", "2.5.4.10": "O", "2.5.4.11": "OU", "2.5.4.6": "C", "2.5.4.8": "ST", "2.5.4.7": "L",
  "2.5.4.5": "serialNumber", "1.2.840.113549.1.9.1": "E", "0.9.2342.19200300.100.1.25": "DC", "2.5.4.12": "T",
};

export type DName = { key: string; value: string }[];

function dname(b: Uint8Array, t: Tlv): DName {
  const out: DName = [];
  for (const rdn of children(b, t)) {
    for (const atv of children(b, rdn)) {
      const [o, v] = children(b, atv);
      const id = oid(b, o);
      out.push({ key: ATTR[id] ?? id, value: str(b, v) });
    }
  }
  return out;
}

export function dnToString(dn: DName): string {
  return dn.map((a) => `${a.key}=${a.value}`).join(", ");
}

export function dnGet(dn: DName, key: string): string {
  return dn.find((a) => a.key === key)?.value ?? "";
}

export interface CertInfo {
  serial: Uint8Array; // leading zeros stripped, as SoftEther stores it
  subject: DName;
  issuer: DName;
  notBefore: Date | null;
  notAfter: Date | null;
  selfSigned: boolean;
}

export function parseCert(der: Uint8Array): CertInfo {
  const cert = readTlv(der, 0);
  const tbs = children(der, cert)[0];
  const f = children(der, tbs);
  let i = 0;
  if (f[0].tag === 0xa0) i++; // explicit version
  const serialTlv = f[i++];
  i++; // signature algorithm
  const issuer = dname(der, f[i++]);
  const validity = children(der, f[i++]);
  const subject = dname(der, f[i++]);
  let serial = der.slice(serialTlv.start, serialTlv.end);
  let z = 0;
  while (z < serial.length - 1 && serial[z] === 0) z++;
  serial = serial.slice(z);
  return {
    serial, subject, issuer,
    notBefore: validity[0] ? time(der, validity[0]) : null,
    notAfter: validity[1] ? time(der, validity[1]) : null,
    selfSigned: dnToString(subject) === dnToString(issuer),
  };
}

// ---- Digests --------------------------------------------------------------------------------

export async function sha(alg: "SHA-1" | "SHA-256", data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(alg, data as unknown as ArrayBuffer));
}

/** MD5 (RFC 1321). WebCrypto has no MD5, and SoftEther CRL entries use it. */
export function md5(data: Uint8Array): Uint8Array {
  const s = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const len = data.length;
  const padded = new Uint8Array(((len + 8) >> 6) * 64 + 64);
  padded.set(data);
  padded[len] = 0x80;
  const bitLen = len * 8;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < padded.length; off += 64) {
    const M = Array.from({ length: 16 }, (_, j) => dv.getUint32(off + j * 4, true));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return out;
}
