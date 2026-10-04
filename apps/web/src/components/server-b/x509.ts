// Minimal DER / X.509 helpers — enough to display a certificate, convert PEM <-> DER,
// and sanity-check that a key matches a certificate. Not a validator.

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function bytesToB64(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function toPem(label: string, der: Uint8Array | string): string {
  const b64 = typeof der === "string" ? der : bytesToB64(der);
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
    try { out.push({ label: m[1], der: b64ToBytes(b64), headers }); } catch { /* skip */ }
  }
  return out;
}

// ---- DER TLV parsing ----

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
  bytes.forEach((x, i) => {
    v = v * 128 + (x & 0x7f);
    if (!(x & 0x80)) {
      if (parts.length === 0 && i >= 0) { parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80); } else parts.push(v);
      v = 0;
    }
  });
  return parts.join(".");
}

const OIDS: Record<string, string> = {
  "2.5.4.3": "CN", "2.5.4.6": "C", "2.5.4.7": "L", "2.5.4.8": "ST", "2.5.4.10": "O", "2.5.4.11": "OU", "2.5.4.5": "serialNumber",
  "1.2.840.113549.1.9.1": "E", "0.9.2342.19200300.100.1.25": "DC",
  "1.2.840.113549.1.1.1": "RSA", "1.2.840.10045.2.1": "EC", "1.3.101.112": "Ed25519", "1.3.101.113": "Ed448",
  "1.2.840.113549.1.1.4": "md5WithRSAEncryption", "1.2.840.113549.1.1.5": "sha1WithRSAEncryption",
  "1.2.840.113549.1.1.11": "sha256WithRSAEncryption", "1.2.840.113549.1.1.12": "sha384WithRSAEncryption", "1.2.840.113549.1.1.13": "sha512WithRSAEncryption",
  "1.2.840.113549.1.1.10": "RSASSA-PSS",
  "1.2.840.10045.4.3.2": "ecdsa-with-SHA256", "1.2.840.10045.4.3.3": "ecdsa-with-SHA384", "1.2.840.10045.4.3.4": "ecdsa-with-SHA512",
  "1.2.840.10045.3.1.7": "P-256", "1.3.132.0.34": "P-384", "1.3.132.0.35": "P-521",
};

function str(t: Tlv): string {
  if (t.tag === 0x1e) { // BMPString
    let s = "";
    for (let i = 0; i + 1 < t.bytes.length; i += 2) s += String.fromCharCode((t.bytes[i] << 8) | t.bytes[i + 1]);
    return s;
  }
  return new TextDecoder().decode(t.bytes);
}

function name(b: Uint8Array, t: Tlv): { text: string; parts: [string, string][] } {
  const parts: [string, string][] = [];
  for (const set of children(b, t)) {
    for (const atv of children(b, set)) {
      const [o, v] = children(b, atv);
      if (o && v) { const id = oid(o.bytes); parts.push([OIDS[id] ?? id, str(v)]); }
    }
  }
  return { parts, text: parts.map(([k, v]) => `${k}=${v}`).join(", ") };
}

function time(t: Tlv): Date {
  const s = new TextDecoder().decode(t.bytes);
  let y: number, rest: string;
  if (t.tag === 0x17) { const yy = Number(s.slice(0, 2)); y = yy >= 50 ? 1900 + yy : 2000 + yy; rest = s.slice(2); }
  else { y = Number(s.slice(0, 4)); rest = s.slice(4); }
  const [mo, d, h, mi, se] = [0, 2, 4, 6, 8].map((i) => Number(rest.slice(i, i + 2) || 0));
  return new Date(Date.UTC(y, mo - 1, d, h, mi, se));
}

function hex(b: Uint8Array, sep = ":") {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0").toUpperCase()).join(sep);
}

function stripInt(b: Uint8Array) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
}

export interface CertInfo {
  version: number;
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
  /** RSA modulus (hex, no separators) for key matching */
  rsaModulus?: string;
  subjectAltNames: string[];
  isCA?: boolean;
}

export function parseCertificate(der: Uint8Array): CertInfo {
  const cert = readTlv(der, 0);
  const [tbs, sigAlg] = children(der, cert);
  const f = children(der, tbs);
  let i = 0;
  let version = 1;
  if (f[0].tag === 0xa0) { version = children(der, f[0])[0].bytes[0] + 1; i++; }
  const serial = hex(stripInt(f[i++].bytes));
  i++; // inner signature algorithm
  const issuer = name(der, f[i++]);
  const [nb, na] = children(der, f[i++]);
  const subject = name(der, f[i++]);
  const spki = f[i++];
  const [keyAlgSeq, keyBits] = children(der, spki);
  const keyAlgParts = children(der, keyAlgSeq);
  const keyAlgOid = oid(keyAlgParts[0].bytes);
  const info: CertInfo = {
    version, serial,
    signatureAlgorithm: (() => { const o = oid(children(der, sigAlg)[0].bytes); return OIDS[o] ?? o; })(),
    issuer: issuer.text, subject: subject.text, subjectParts: subject.parts,
    commonName: subject.parts.find(([k]) => k === "CN")?.[1] ?? "",
    notBefore: time(nb), notAfter: time(na),
    selfSigned: issuer.text === subject.text,
    keyAlgorithm: OIDS[keyAlgOid] ?? keyAlgOid,
    subjectAltNames: [],
  };
  try {
    if (info.keyAlgorithm === "RSA") {
      // BIT STRING: first byte = unused bits, then RSAPublicKey SEQ(n, e)
      const inner = keyBits.bytes.subarray(1);
      const seq = readTlv(inner, 0);
      const n = children(inner, seq)[0];
      const mod = stripInt(n.bytes);
      info.keySize = mod.length * 8;
      info.rsaModulus = hex(mod, "");
    } else if (info.keyAlgorithm === "EC" && keyAlgParts[1]?.tag === 0x06) {
      const c = oid(keyAlgParts[1].bytes);
      info.curve = OIDS[c] ?? c;
    }
  } catch { /* ignore */ }
  // Extensions
  const ext = f.slice(i).find((t) => t.tag === 0xa3);
  if (ext) {
    try {
      for (const e of children(der, children(der, ext)[0])) {
        const parts = children(der, e);
        const id = oid(parts[0].bytes);
        const val = parts[parts.length - 1];
        const inner = val.bytes;
        if (id === "2.5.29.17") {
          const seq = readTlv(inner, 0);
          for (const g of children(inner, seq)) {
            if (g.tag === 0x82) info.subjectAltNames.push(`DNS:${new TextDecoder().decode(g.bytes)}`);
            else if (g.tag === 0x87) info.subjectAltNames.push(`IP:${g.bytes.length === 4 ? Array.from(g.bytes).join(".") : hex(g.bytes)}`);
            else if (g.tag === 0x81) info.subjectAltNames.push(`email:${new TextDecoder().decode(g.bytes)}`);
            else if (g.tag === 0x86) info.subjectAltNames.push(`URI:${new TextDecoder().decode(g.bytes)}`);
          }
        } else if (id === "2.5.29.19") {
          const seq = readTlv(inner, 0);
          const c = children(inner, seq);
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
    return { kind: "RSA (PKCS#1)", pemLabel: "RSA PRIVATE KEY", rsaModulus: hex(stripInt(c[1].bytes), "") };
  }
  if (c[0]?.tag === 0x02 && c[1]?.tag === 0x30 && c[2]?.tag === 0x04) {
    const alg = oid(children(der, c[1])[0].bytes);
    let rsaModulus: string | undefined;
    if (OIDS[alg] === "RSA") {
      try {
        const inner = c[2].bytes;
        const k = children(inner, readTlv(inner, 0));
        rsaModulus = hex(stripInt(k[1].bytes), "");
      } catch { /* ignore */ }
    }
    return { kind: "PKCS#8", pemLabel: "PRIVATE KEY", rsaModulus };
  }
  if (c[0]?.tag === 0x02 && c[1]?.tag === 0x04) return { kind: "EC (SEC1)", pemLabel: "EC PRIVATE KEY" };
  return { kind: "unknown", pemLabel: "PRIVATE KEY" };
}

// ---- Fingerprints ----

/** SHA-256 with WebCrypto when available (secure contexts), else a small JS fallback. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  if (globalThis.crypto?.subtle) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  }
  return sha256Js(data);
}

function sha256Js(msg: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const l = msg.length;
  const padded = new Uint8Array(((l + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[l] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, (l * 8) >>> 0);
  dv.setUint32(padded.length - 8, Math.floor((l * 8) / 2 ** 32));
  const W = new Uint32Array(64);
  const r = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < padded.length; o += 64) {
    for (let t = 0; t < 16; t++) W[t] = dv.getUint32(o + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = r(W[t - 15], 7) ^ r(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = r(W[t - 2], 17) ^ r(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) >>> 0;
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  H.forEach((v, i) => odv.setUint32(i * 4, v));
  return out;
}

export async function fingerprint256(der: Uint8Array): Promise<string> {
  return hex(await sha256(der));
}

export function normalizeFp(fp: string | null | undefined) {
  return (fp ?? "").replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

/**
 * Accept a certificate or key file (PEM text or binary DER) and return DER bytes.
 * `want` selects which PEM block to use.
 */
export function readDerOrPem(data: Uint8Array, want: "cert" | "key"): { der: Uint8Array; note?: string } {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
  if (text.includes("-----BEGIN")) {
    const blocks = parsePem(text);
    if (want === "cert") {
      const certs = blocks.filter((b) => b.label === "CERTIFICATE" || b.label === "X509 CERTIFICATE");
      if (!certs.length) throw new Error("No CERTIFICATE block found in the PEM file");
      return { der: certs[0].der, note: certs.length > 1 ? `The file contains ${certs.length} certificates; only the first (leaf) is used. SoftEther does not serve intermediate chains.` : undefined };
    }
    if (blocks.some((b) => b.label === "ENCRYPTED PRIVATE KEY" || /ENCRYPTED/.test(b.headers))) {
      throw new Error("The private key is encrypted. Decrypt it first (e.g. openssl pkey -in key.pem -out plain.pem).");
    }
    const key = blocks.find((b) => /PRIVATE KEY$/.test(b.label));
    if (!key) throw new Error("No PRIVATE KEY block found in the PEM file");
    return { der: key.der };
  }
  if (data[0] !== 0x30) throw new Error("The file is neither PEM nor DER");
  return { der: data };
}
