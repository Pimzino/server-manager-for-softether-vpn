// Minimal, dependency-free X.509 helpers: PEM <-> DER, a small DER walker to read certificates and private keys,
// and the digests SoftEther uses (SHA-256 fingerprints; MD5 and SHA-1 for CRL entries). Not a validator.
//
// Merged from apps/web components/hub-a/x509.ts (hub certificate / CRL pages) and components/server-b/x509.ts
// (server certificate page). Both parse functions are kept because their result shapes differ:
//   * parseCertificate(der) -> CertInfo      (server-b: strings, key algorithm, SANs, RSA modulus)
//   * parseCert(der)        -> CertSummary   (hub-a:   serial bytes, subject/issuer as DName lists)
// hub-a's type was also called CertInfo; it is CertSummary here.
import { b64ToBytes, bytesToB64, derB64ToPem, toHex } from "./util";
import { normFp } from "../../lib/format";

/** derB64ToPem(b64, label = "CERTIFICATE"): DER base64 -> PEM text (hub-a). Same as toPem(label, b64). */
export { b64ToBytes, bytesToB64, derB64ToPem, toHex };

/** DER bytes or base64 -> PEM text (server-b). */
export function toPem(label: string, der: Uint8Array | string): string {
  const b64 = typeof der === "string" ? der.replace(/\s+/g, "") : bytesToB64(der);
  return `-----BEGIN ${label}-----\n${(b64.match(/.{1,64}/g) ?? []).join("\n")}\n-----END ${label}-----\n`;
}

export interface PemBlock { label: string; der: Uint8Array; headers: string }

/** Extract every PEM block of a text. */
export function parsePem(text: string): PemBlock[] {
  const out: PemBlock[] = [];
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const body = m[2];
    const headers = body.includes(":") ? body.split(/\r?\n\r?\n/)[0] : "";
    const b64 = (headers ? body.slice(body.indexOf(headers) + headers.length) : body).replace(/[^A-Za-z0-9+/=]/g, "");
    const der = b64ToBytes(b64);
    if (der.length) out.push({ label: m[1], der, headers });
  }
  return out;
}

/**
 * Every certificate in file contents: PEM (one or many blocks) or raw DER. Returns base64 DER strings.
 * Get the bytes with openBytes() from files.ts (the web version read a File).
 */
export function certsFromFile(bytes: Uint8Array): string[] {
  const text = new TextDecoder("latin1").decode(bytes);
  const blocks = [...text.matchAll(/-----BEGIN (?:X509 |TRUSTED )?CERTIFICATE-----([\s\S]*?)-----END (?:X509 |TRUSTED )?CERTIFICATE-----/g)];
  if (blocks.length) return blocks.map((m) => m[1].replace(/\s+/g, ""));
  if (bytes[0] === 0x30) return [bytesToB64(bytes)];
  return [];
}

/**
 * Accept a certificate or key file (PEM text or binary DER) and return DER bytes.
 * `want` selects which PEM block to use. Encrypted keys are rejected with an explanation.
 */
export function readDerOrPem(data: Uint8Array, want: "cert" | "key"): { der: Uint8Array; note?: string } {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (text.includes("-----BEGIN")) {
    const blocks = parsePem(text);
    if (want === "cert") {
      const certs = blocks.filter((b) => b.label === "CERTIFICATE" || b.label === "X509 CERTIFICATE");
      if (!certs.length) throw new Error("The PEM file has no CERTIFICATE block.");
      return { der: certs[0].der, note: certs.length > 1 ? `The file contains ${certs.length} certificates. Only the first (the server’s own certificate) is used: SoftEther doesn’t serve intermediate certificates.` : undefined };
    }
    if (blocks.some((b) => b.label === "ENCRYPTED PRIVATE KEY" || /ENCRYPTED/.test(b.headers))) {
      throw new Error("The private key is encrypted. Decrypt it first, for example with “openssl pkey -in key.pem -out plain.pem”.");
    }
    const key = blocks.find((b) => /PRIVATE KEY$/.test(b.label));
    if (!key) throw new Error("The PEM file has no PRIVATE KEY block.");
    return { der: key.der };
  }
  if (data[0] !== 0x30) throw new Error("The file is neither PEM nor DER.");
  return { der: data };
}

// ---- DER TLV walker ------------------------------------------------------------------------

/** `start` is the TLV's first byte, `bytes` its content. */
export interface Tlv { tag: number; start: number; hdr: number; len: number; end: number; bytes: Uint8Array }

export function readTlv(b: Uint8Array, pos: number): Tlv {
  if (pos + 2 > b.length) throw new Error("Truncated DER");
  const tag = b[pos];
  let len = b[pos + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("Unsupported DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[pos + 2 + i];
    hdr += n;
  }
  const end = pos + hdr + len;
  if (end > b.length) throw new Error("Truncated DER");
  return { tag, start: pos, hdr, len, end, bytes: b.subarray(pos + hdr, end) };
}

export function children(b: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let p = t.start + t.hdr;
  while (p < t.end) { const c = readTlv(b, p); out.push(c); p = c.end; }
  return out;
}

function oid(bytes: Uint8Array): string {
  const parts: number[] = [];
  let v = 0;
  bytes.forEach((x) => {
    v = v * 128 + (x & 0x7f);
    if (!(x & 0x80)) {
      if (parts.length === 0) parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80);
      else parts.push(v);
      v = 0;
    }
  });
  return parts.join(".");
}

const OIDS: Record<string, string> = {
  "2.5.4.3": "CN", "2.5.4.6": "C", "2.5.4.7": "L", "2.5.4.8": "ST", "2.5.4.10": "O", "2.5.4.11": "OU", "2.5.4.5": "serialNumber",
  "2.5.4.12": "T", "1.2.840.113549.1.9.1": "E", "0.9.2342.19200300.100.1.25": "DC",
  "1.2.840.113549.1.1.1": "RSA", "1.2.840.10045.2.1": "EC", "1.3.101.112": "Ed25519", "1.3.101.113": "Ed448",
  "1.2.840.113549.1.1.4": "md5WithRSAEncryption", "1.2.840.113549.1.1.5": "sha1WithRSAEncryption",
  "1.2.840.113549.1.1.11": "sha256WithRSAEncryption", "1.2.840.113549.1.1.12": "sha384WithRSAEncryption", "1.2.840.113549.1.1.13": "sha512WithRSAEncryption",
  "1.2.840.113549.1.1.10": "RSASSA-PSS",
  "1.2.840.10045.4.3.2": "ecdsa-with-SHA256", "1.2.840.10045.4.3.3": "ecdsa-with-SHA384", "1.2.840.10045.4.3.4": "ecdsa-with-SHA512",
  "1.2.840.10045.3.1.7": "P-256", "1.3.132.0.34": "P-384", "1.3.132.0.35": "P-521",
};

/** Directory string: BMPString, UTF8String, else Latin-1 (Printable/IA5/Teletex). */
function str(t: Tlv): string {
  if (t.tag === 0x1e) {
    let s = "";
    for (let i = 0; i + 1 < t.bytes.length; i += 2) s += String.fromCharCode((t.bytes[i] << 8) | t.bytes[i + 1]);
    return s;
  }
  return new TextDecoder(t.tag === 0x0c ? "utf-8" : "latin1").decode(t.bytes);
}

/** UTCTime (0x17) / GeneralizedTime (0x18); null when malformed. */
function time(t: Tlv): Date | null {
  const s = new TextDecoder("latin1").decode(t.bytes);
  const m = t.tag === 0x17
    ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s)
    : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(s);
  if (!m) return null;
  let y = Number(m[1]);
  if (t.tag === 0x17) y += y < 50 ? 2000 : 1900;
  return new Date(Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
}

export type DName = { key: string; value: string }[];

function dname(b: Uint8Array, t: Tlv): DName {
  const out: DName = [];
  for (const rdn of children(b, t)) {
    for (const atv of children(b, rdn)) {
      const [o, v] = children(b, atv);
      if (o && v) { const id = oid(o.bytes); out.push({ key: OIDS[id] ?? id, value: str(v) }); }
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

function stripInt(b: Uint8Array) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
}

/** Fields of the TBSCertificate, located once for both parsers. */
function tbsFields(der: Uint8Array) {
  const cert = readTlv(der, 0);
  const [tbs, sigAlg] = children(der, cert);
  const f = children(der, tbs);
  let i = 0;
  let version = 1;
  if (f[0].tag === 0xa0) { version = children(der, f[0])[0].bytes[0] + 1; i++; }
  const serial = f[i++];
  i++; // inner signature algorithm
  const issuer = f[i++];
  const validity = children(der, f[i++]);
  const subject = f[i++];
  const spki = f[i++];
  return { sigAlg, version, serial, issuer, validity, subject, spki, rest: f.slice(i) };
}

// ---- hub-a: CertSummary --------------------------------------------------------------------

export interface CertSummary {
  /** Leading zeros stripped, as SoftEther stores serial numbers. */
  serial: Uint8Array;
  subject: DName;
  issuer: DName;
  notBefore: Date | null;
  notAfter: Date | null;
  selfSigned: boolean;
}

/** Serial, subject, issuer and validity (Trusted CAs, CRL entries, user certificates). */
export function parseCert(der: Uint8Array): CertSummary {
  const t = tbsFields(der);
  const subject = dname(der, t.subject);
  const issuer = dname(der, t.issuer);
  return {
    serial: stripInt(t.serial.bytes).slice(),
    subject, issuer,
    notBefore: t.validity[0] ? time(t.validity[0]) : null,
    notAfter: t.validity[1] ? time(t.validity[1]) : null,
    selfSigned: dnToString(subject) === dnToString(issuer),
  };
}

// ---- server-b: CertInfo --------------------------------------------------------------------

export interface CertInfo {
  version: number;
  /** Upper-case hex with ":" separators. */
  serial: string;
  signatureAlgorithm: string;
  issuer: string;
  subject: string;
  subjectParts: [string, string][];
  commonName: string;
  notBefore: Date;
  notAfter: Date;
  selfSigned: boolean;
  keyAlgorithm: string;
  keySize?: number;
  curve?: string;
  /** RSA modulus (hex, no separators) for key matching. */
  rsaModulus?: string;
  subjectAltNames: string[];
  isCA?: boolean;
}

/** Full details of a certificate (server certificate page). */
export function parseCertificate(der: Uint8Array): CertInfo {
  const t = tbsFields(der);
  const subject = dname(der, t.subject);
  const issuer = dname(der, t.issuer);
  const [keyAlgSeq, keyBits] = children(der, t.spki);
  const keyAlgParts = children(der, keyAlgSeq);
  const keyAlgOid = oid(keyAlgParts[0].bytes);
  const sigOid = oid(children(der, t.sigAlg)[0].bytes);
  const info: CertInfo = {
    version: t.version,
    serial: toHex(stripInt(t.serial.bytes)),
    signatureAlgorithm: OIDS[sigOid] ?? sigOid,
    issuer: dnToString(issuer), subject: dnToString(subject),
    subjectParts: subject.map((a) => [a.key, a.value]),
    commonName: dnGet(subject, "CN"),
    notBefore: (t.validity[0] && time(t.validity[0])) || new Date(0),
    notAfter: (t.validity[1] && time(t.validity[1])) || new Date(0),
    selfSigned: dnToString(issuer) === dnToString(subject),
    keyAlgorithm: OIDS[keyAlgOid] ?? keyAlgOid,
    subjectAltNames: [],
  };
  try {
    if (info.keyAlgorithm === "RSA") {
      // BIT STRING: first byte = unused bits, then RSAPublicKey SEQ(n, e)
      const inner = keyBits.bytes.subarray(1);
      const n = children(inner, readTlv(inner, 0))[0];
      const mod = stripInt(n.bytes);
      info.keySize = mod.length * 8;
      info.rsaModulus = toHex(mod, "");
    } else if (info.keyAlgorithm === "EC" && keyAlgParts[1]?.tag === 0x06) {
      const c = oid(keyAlgParts[1].bytes);
      info.curve = OIDS[c] ?? c;
    }
  } catch { /* unusual key encoding: leave key details empty */ }
  const ext = t.rest.find((x) => x.tag === 0xa3);
  if (ext) {
    try {
      for (const e of children(der, children(der, ext)[0])) {
        const parts = children(der, e);
        const id = oid(parts[0].bytes);
        const inner = parts[parts.length - 1].bytes;
        if (id === "2.5.29.17") {
          for (const g of children(inner, readTlv(inner, 0))) {
            if (g.tag === 0x82) info.subjectAltNames.push(`DNS:${new TextDecoder().decode(g.bytes)}`);
            else if (g.tag === 0x87) info.subjectAltNames.push(`IP:${g.bytes.length === 4 ? Array.from(g.bytes).join(".") : toHex(g.bytes)}`);
            else if (g.tag === 0x81) info.subjectAltNames.push(`email:${new TextDecoder().decode(g.bytes)}`);
            else if (g.tag === 0x86) info.subjectAltNames.push(`URI:${new TextDecoder().decode(g.bytes)}`);
          }
        } else if (id === "2.5.29.19") {
          const c = children(inner, readTlv(inner, 0));
          info.isCA = c[0]?.tag === 0x01 ? c[0].bytes[0] !== 0 : false;
        }
      }
    } catch { /* ignore malformed extensions */ }
  }
  return info;
}

export type KeyKind = "RSA (PKCS#1)" | "PKCS#8" | "EC (SEC1)" | "unknown";
export interface KeyInfo { kind: KeyKind; pemLabel: string; rsaModulus?: string }

/** Identify an unencrypted private key DER blob and extract the RSA modulus when possible. */
export function inspectPrivateKey(der: Uint8Array): KeyInfo {
  const seq = readTlv(der, 0);
  if (seq.tag !== 0x30) throw new Error("Not a DER private key");
  const c = children(der, seq);
  if (c[0]?.tag === 0x02 && c[1]?.tag === 0x02) {
    return { kind: "RSA (PKCS#1)", pemLabel: "RSA PRIVATE KEY", rsaModulus: toHex(stripInt(c[1].bytes), "") };
  }
  if (c[0]?.tag === 0x02 && c[1]?.tag === 0x30 && c[2]?.tag === 0x04) {
    const alg = oid(children(der, c[1])[0].bytes);
    let rsaModulus: string | undefined;
    if (OIDS[alg] === "RSA") {
      try {
        const inner = c[2].bytes;
        const k = children(inner, readTlv(inner, 0));
        rsaModulus = toHex(stripInt(k[1].bytes), "");
      } catch { /* not an RSAPrivateKey inside */ }
    }
    return { kind: "PKCS#8", pemLabel: "PRIVATE KEY", rsaModulus };
  }
  if (c[0]?.tag === 0x02 && c[1]?.tag === 0x04) return { kind: "EC (SEC1)", pemLabel: "EC PRIVATE KEY" };
  return { kind: "unknown", pemLabel: "PRIVATE KEY" };
}

// ---- Digests -------------------------------------------------------------------------------

/** SHA-1 / SHA-256 with WebCrypto (always available in the Electron renderer). */
export async function sha(alg: "SHA-1" | "SHA-256", data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(alg, data as BufferSource));
}

export const sha256 = (data: Uint8Array) => sha("SHA-256", data);

/** SHA-256 fingerprint as "AB:CD:…" (the form SoftEther's ServerCertGet and this app show). */
export async function fingerprint256(der: Uint8Array): Promise<string> {
  return toHex(await sha256(der));
}

/** Upper-case hex without separators (same as normFp in lib/format). */
export const normalizeFp = (fp: string | null | undefined) => normFp(fp);

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
