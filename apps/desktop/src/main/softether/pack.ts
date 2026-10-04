// SoftEther PACK: binary codec + JSON <-> PACK conversion.
// Port of Mayaqua/Pack.c (ReadPack/WritePack, JsonToPack, PackToJson) and the helpers it relies on
// (Mayaqua/Str.c ToInt/ToInt64/ToBool, Mayaqua/Network.c IPToStr/StrToIP, Mayaqua/Kernel.c time
// conversion). Reference: vendor/SoftEtherVPN/src.
//
// Wire format (all integers big-endian):
//   PACK    = u32 element_count, ELEMENT*
//   ELEMENT = u32 (name_len + 1), name bytes (no NUL), u32 type, u32 value_count, VALUE*
//   VALUE   = INT: u32 | INT64: u64 | DATA: u32 size, bytes | STR: u32 len, bytes (no NUL)
//             | UNISTR: u32 (utf8_len + 1), UTF-8 bytes, NUL
// Element names are unique and compared case-insensitively (StrCmpi).
//
// JSON: the JSON-RPC API converts the server's in-memory PACK with PackToJson(), which uses hints
// (bool / datetime / array / group) that are set while the PACK is built and are NOT serialized. The
// native transport re-creates them from RESULT_HINTS, extracted from the C source by
// tools/verify-native/gen-hints.py, so both transports return the same JSON.

export const VALUE_INT = 0;
export const VALUE_DATA = 1;
export const VALUE_STR = 2;
export const VALUE_UNISTR = 3;
export const VALUE_INT64 = 4;
export type ValueType = 0 | 1 | 2 | 3 | 4;

// Mayaqua/Pack.h (CPU_64)
export const MAX_VALUE_SIZE = 384 * 1024 * 1024;
export const MAX_VALUE_NUM = 262144;
export const MAX_ELEMENT_NAME_LEN = 63;
export const MAX_ELEMENT_NUM = 262144;
export const MAX_PACK_SIZE = 512 * 1024 * 1024;

/**
 * INT: number (uint32) | INT64: bigint | DATA: Buffer | STR: Buffer (raw bytes, as C keeps them) |
 * UNISTR: string. `null` = a value slot that was never set (C: NULL VALUE pointer).
 */
export type PackValue = number | bigint | Buffer | string | null;

export interface PackElement {
  name: string;
  type: ValueType;
  values: PackValue[];
}

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackError";
  }
}

/** StrCmpi-style key (ASCII case folding only). */
function ikey(name: string): string {
  return name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** StrCpy(e->name, 64, name): at most 63 bytes. */
function clampName(name: string): string {
  const b = Buffer.from(name, "utf8");
  if (b.length <= MAX_ELEMENT_NAME_LEN) return name;
  return b.subarray(0, MAX_ELEMENT_NAME_LEN).toString("utf8");
}

export class Pack {
  readonly elements: PackElement[] = [];
  private readonly index = new Map<string, PackElement>();

  get(name: string, type?: ValueType): PackElement | undefined {
    const e = this.index.get(ikey(clampName(name)));
    if (!e) return undefined;
    if (type !== undefined && e.type !== type) return undefined;
    return e;
  }

  /** AddElement(): refuses duplicates (case-insensitive) and empty elements. */
  add(e: PackElement): boolean {
    if (this.elements.length >= MAX_ELEMENT_NUM) return false;
    const k = ikey(e.name);
    if (this.index.has(k) || e.values.length === 0) return false;
    this.elements.push(e);
    this.index.set(k, e);
    return true;
  }

  /** DelElement(): removes the element of that name (any type). */
  remove(name: string): void {
    const k = ikey(clampName(name));
    const e = this.index.get(k);
    if (!e) return;
    this.index.delete(k);
    this.elements.splice(this.elements.indexOf(e), 1);
  }

  // PackAdd* (single value)
  addInt(name: string, v: number): boolean { return this.add({ name: clampName(name), type: VALUE_INT, values: [v >>> 0] }); }
  addBool(name: string, v: boolean): boolean { return this.addInt(name, v ? 1 : 0); }
  addInt64(name: string, v: bigint): boolean { return this.add({ name: clampName(name), type: VALUE_INT64, values: [BigInt.asUintN(64, v)] }); }
  addStr(name: string, v: string | Buffer): boolean { return this.add({ name: clampName(name), type: VALUE_STR, values: [cStrBytes(v)] }); }
  addUniStr(name: string, v: string): boolean { return this.add({ name: clampName(name), type: VALUE_UNISTR, values: [cStr(v)] }); }
  addData(name: string, v: Buffer): boolean { return this.add({ name: clampName(name), type: VALUE_DATA, values: [Buffer.from(v)] }); }

  /** PackAdd*Ex(): set value `index` of an array element of `total` values (creating it if needed). */
  addEx(name: string, type: ValueType, v: PackValue, index: number, total: number): PackElement | null {
    if (total === 0) return null;
    const nm = clampName(name);
    const existing = this.index.get(ikey(nm));
    if (existing) {
      if (existing.type !== type) return null; // GetElement(type) misses, AddElement then fails (duplicate)
      if (existing.values.length >= total) existing.values[index] = v;
      return existing;
    }
    const e: PackElement = { name: nm, type, values: new Array<PackValue>(total).fill(null) };
    e.values[index] = v;
    return this.add(e) ? e : null;
  }

  getInt(name: string, index = 0): number {
    const v = this.get(name, VALUE_INT)?.values[index];
    return typeof v === "number" ? v : 0;
  }
  getInt64(name: string, index = 0): bigint {
    const v = this.get(name, VALUE_INT64)?.values[index];
    return typeof v === "bigint" ? v : 0n;
  }
  getBool(name: string, index = 0): boolean { return this.getInt(name, index) !== 0; }
  getData(name: string, index = 0): Buffer | null {
    const v = this.get(name, VALUE_DATA)?.values[index];
    return Buffer.isBuffer(v) ? v : null;
  }
  /** PackGetStr(): false/null when missing. */
  getStr(name: string, index = 0): string | null {
    const v = this.get(name, VALUE_STR)?.values[index];
    return Buffer.isBuffer(v) ? v.toString("utf8") : null;
  }
}

/** C strings end at the first NUL. */
function cStr(s: string): string {
  const i = s.indexOf("\0");
  return i < 0 ? s : s.slice(0, i);
}
function cStrBytes(v: string | Buffer): Buffer {
  const b = typeof v === "string" ? Buffer.from(cStr(v), "utf8") : v;
  const i = b.indexOf(0);
  return i < 0 ? b : b.subarray(0, i);
}

// ---------------------------------------------------------------------------------------------------
// Binary codec (WritePack / ReadPack)

export function encodePack(p: Pack): Buffer {
  const chunks: Buffer[] = [];
  const u32 = (n: number) => { const b = Buffer.allocUnsafe(4); b.writeUInt32BE(n >>> 0); chunks.push(b); };
  u32(p.elements.length);
  for (const e of p.elements) {
    const name = Buffer.from(e.name, "utf8");
    u32(name.length + 1);
    chunks.push(name);
    u32(e.type);
    u32(e.values.length);
    for (const v of e.values) {
      // WriteValue() on a NULL VALUE writes nothing, which would corrupt the stream: a slot that was
      // never set is sent as the type's zero value instead (what the receiver's getters return for NULL).
      switch (e.type) {
        case VALUE_INT: u32(typeof v === "number" ? v : 0); break;
        case VALUE_INT64: {
          const b = Buffer.allocUnsafe(8);
          b.writeBigUInt64BE(BigInt.asUintN(64, typeof v === "bigint" ? v : 0n));
          chunks.push(b);
          break;
        }
        case VALUE_DATA: {
          const d = Buffer.isBuffer(v) ? v : Buffer.alloc(0);
          u32(d.length); chunks.push(d);
          break;
        }
        case VALUE_STR: {
          const d = Buffer.isBuffer(v) ? cStrBytes(v) : Buffer.alloc(0);
          u32(d.length); chunks.push(d);
          break;
        }
        case VALUE_UNISTR: {
          const d = Buffer.from(typeof v === "string" ? cStr(v) : "", "utf8");
          u32(d.length + 1); chunks.push(d, Buffer.from([0]));
          break;
        }
        default: throw new PackError(`unknown value type ${e.type}`);
      }
    }
  }
  return Buffer.concat(chunks);
}

export function decodePack(buf: Buffer): Pack {
  if (buf.length > MAX_PACK_SIZE) throw new PackError("PACK too large");
  let off = 0;
  const need = (n: number) => { if (off + n > buf.length) throw new PackError("truncated PACK"); };
  const u32 = () => { need(4); const v = buf.readUInt32BE(off); off += 4; return v; };
  const p = new Pack();
  const num = u32();
  if (num > MAX_ELEMENT_NUM) throw new PackError("too many elements");
  for (let i = 0; i < num; i++) {
    // ReadBufStr: length includes the (unsent) NUL; names longer than 63 bytes are truncated
    const len = u32();
    if (len === 0) throw new PackError("invalid element name");
    need(len - 1);
    let nameBytes = buf.subarray(off, off + len - 1);
    off += len - 1;
    if (nameBytes.length > MAX_ELEMENT_NAME_LEN) nameBytes = nameBytes.subarray(0, MAX_ELEMENT_NAME_LEN);
    const z = nameBytes.indexOf(0);
    const name = (z < 0 ? nameBytes : nameBytes.subarray(0, z)).toString("utf8");
    const type = u32();
    const count = u32();
    if (count > MAX_VALUE_NUM) throw new PackError("too many values");
    const values: PackValue[] = [];
    for (let j = 0; j < count; j++) {
      switch (type) {
        case VALUE_INT: values.push(u32()); break;
        case VALUE_INT64: need(8); values.push(buf.readBigUInt64BE(off)); off += 8; break;
        case VALUE_DATA: {
          const size = u32();
          if (size > MAX_VALUE_SIZE) throw new PackError("value too large");
          need(size); values.push(Buffer.from(buf.subarray(off, off + size))); off += size;
          break;
        }
        case VALUE_STR: {
          const size = u32();
          if (size > MAX_VALUE_SIZE - 1) throw new PackError("value too large");
          need(size); values.push(cStrBytes(Buffer.from(buf.subarray(off, off + size)))); off += size;
          break;
        }
        case VALUE_UNISTR: {
          const size = u32();
          if (size > MAX_VALUE_SIZE) throw new PackError("value too large");
          need(size);
          const raw = buf.subarray(off, off + size);
          off += size;
          const zz = raw.indexOf(0);
          values.push((zz < 0 ? raw : raw.subarray(0, zz)).toString("utf8"));
          break;
        }
        default: throw new PackError(`unknown value type ${type}`);
      }
    }
    if (!p.add({ name, type: type as ValueType, values })) throw new PackError(`invalid or duplicate element "${name}"`);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------
// Str.c helpers

/** ToInt(): strtoul(str, NULL, 0) after skipping leading zeros that are not a "0x" prefix, cast to UINT. */
export function cToInt(str: string): number {
  let s = str;
  while (s.startsWith("0") && s[1] !== "x" && s[1] !== "X") s = s.slice(1);
  // strtoul: optional whitespace, sign, base prefix
  const m = /^[\t\n\v\f\r ]*([+-]?)(0[xX](?=[0-9a-fA-F])|0(?=[0-7])|)([0-9a-fA-F]*)/.exec(s);
  if (!m) return 0;
  const neg = m[1] === "-";
  let base = 10;
  if (/^0[xX]/.test(m[2])) base = 16;
  else if (m[2] === "0") base = 8;
  const digitRe = base === 16 ? /^[0-9a-fA-F]+/ : base === 8 ? /^[0-7]+/ : /^[0-9]+/;
  const d = digitRe.exec(m[3])?.[0] ?? "";
  if (!d) return 0;
  let v = 0n;
  const B = BigInt(base);
  const MAXUL = (1n << 64n) - 1n;
  for (const c of d) {
    v = v * B + BigInt(parseInt(c, 16));
    if (v > MAXUL) { v = MAXUL; break; } // ERANGE -> ULONG_MAX
  }
  if (neg) v = BigInt.asUintN(64, -v);
  return Number(BigInt.asUintN(32, v));
}

/** ToInt64(): decimal digits, commas ignored, stops at the first other character. */
export function cToInt64(str: string): bigint {
  let v = 0n;
  for (const c of str) {
    if (c === ",") continue;
    if (c >= "0" && c <= "9") v = BigInt.asUintN(64, v * 10n + BigInt(c.charCodeAt(0) - 48));
    else break;
  }
  return v;
}

/** StartWith(): case-insensitive; false for empty strings. */
function startWith(str: string, key: string): boolean {
  if (str.length < key.length || str.length === 0 || key.length === 0) return false;
  return ikey(str.slice(0, key.length)) === ikey(key);
}

/** Trim(): spaces and tabs. */
function cTrim(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, "");
}

export function cToBool(str: string): boolean {
  const t = cTrim(str);
  if (t === "") return false;
  if (cToInt(t) !== 0) return true;
  return startWith("true", t) || startWith("yes", t) || startWith(t, "true") || startWith(t, "yes");
}

/** TrimEndWith(): case-insensitive suffix strip. */
function trimEndWith(str: string, key: string): string | null {
  if (str.length < key.length) return null;
  if (ikey(str.slice(str.length - key.length)) !== ikey(key)) return null;
  return str.slice(0, str.length - key.length);
}

// ---------------------------------------------------------------------------------------------------
// IP addresses (Network.c). PackAddIp stores 4 elements: name@ipv6_bool, name@ipv6_array (16 bytes),
// name@ipv6_scope_id and name (the IPv4 address as a UINT in host memory order, i.e. a.b.c.d -> the
// little-endian integer a | b<<8 | c<<16 | d<<24, sent big-endian).

export interface IpAddr { address: Buffer /* 16 bytes, IPv4 = ::ffff:a.b.c.d */; scopeId: number }

function isIp4(ip: IpAddr): boolean {
  for (let i = 0; i < 10; i++) if (ip.address[i] !== 0) return false;
  return ip.address[10] === 0xff && ip.address[11] === 0xff;
}

function uintToIp(v: number): IpAddr {
  const address = Buffer.alloc(16);
  address[10] = 0xff; address[11] = 0xff;
  address[12] = v & 0xff; address[13] = (v >>> 8) & 0xff; address[14] = (v >>> 16) & 0xff; address[15] = (v >>> 24) & 0xff;
  return { address, scopeId: 0 };
}

function ipToUint(ip: IpAddr): number {
  if (!isIp4(ip)) return 0;
  return (ip.address[12] | (ip.address[13] << 8) | (ip.address[14] << 16) | (ip.address[15] << 24)) >>> 0;
}

/** IPToStr() / IPToStr6Inner(). */
export function ipToStr(ip: IpAddr): string {
  if (isIp4(ip)) return `${ip.address[12]}.${ip.address[13]}.${ip.address[14]}.${ip.address[15]}`;
  const values: number[] = [];
  for (let i = 0; i < 8; i++) values.push(ip.address.readUInt16BE(i * 2));
  let zeroStarted = -1, maxZeroLen = 0, maxZeroStart = -1;
  for (let i = 0; i < 9; i++) {
    const v = i !== 8 ? values[i] : 1;
    if (v === 0) {
      if (zeroStarted < 0) zeroStarted = i;
    } else if (zeroStarted >= 0) {
      const len = i - zeroStarted;
      if (len >= 2 && maxZeroLen < len) { maxZeroStart = zeroStarted; maxZeroLen = len; }
      zeroStarted = -1;
    }
  }
  let s = "";
  for (let i = 0; i < 8; i++) {
    if (i === maxZeroStart) {
      s += i === 0 ? "::" : ":";
      i += maxZeroLen - 1;
    } else {
      s += values[i].toString(16);
      if (i !== 7) s += ":";
    }
  }
  if (ip.scopeId !== 0) s += `%${ip.scopeId}`;
  return s;
}

/** StrToIP(): IPv6 first, then dotted IPv4. */
export function strToIp(str: string): IpAddr | null {
  const v6 = strToIp6(str);
  if (v6) return v6;
  const toks = cTrim(str).split(".").filter((t) => t !== ""); // ParseToken drops empty tokens
  if (toks.length !== 4) return null;
  for (const t of toks) {
    if (t[0] < "0" || t[0] > "9" || cToInt(t) >= 256) return null;
  }
  const address = Buffer.alloc(16);
  address[10] = 0xff; address[11] = 0xff;
  toks.forEach((t, i) => { address[12 + i] = cToInt(t) & 0xff; });
  return { address, scopeId: 0 };
}

function strToIp6(str: string): IpAddr | null {
  let tmp = cTrim(str);
  if (tmp.startsWith("[") && tmp.endsWith("]")) tmp = tmp.slice(1, tmp.length - 1);
  let scopeId = 0;
  const pct = tmp.indexOf("%");
  if (pct >= 0) {
    scopeId = cToInt(cTrim(tmp.slice(pct + 1)));
    tmp = cTrim(tmp.slice(0, pct));
  }
  const t = tmp.split(":"); // ParseTokenWithNullStr keeps empty tokens
  if (t.length < 3 || t.length > 8) return null;
  const address = Buffer.alloc(16);
  let n = 0, k = 0;
  for (let i = 0; i < t.length; i++) {
    const s = t[i];
    if (i !== 0 && i !== t.length - 1 && s.length === 0) {
      n++;
      if (n === 1) k += 2 * (8 - t.length + 1);
      else return null;
    } else {
      if (s.length >= 5 || !/^[0-9a-fA-F]*$/.test(s)) return null;
      const v = s.length === 0 ? 0 : parseInt(s, 16);
      if (k + 2 > 16) return null;
      address[k++] = (v >> 8) & 0xff;
      address[k++] = v & 0xff;
    }
  }
  if (n !== 0 && n !== 1) return null;
  if (n === 0 && t.length !== 8) return null;
  return { address, scopeId };
}

/** PackAddIpEx2() */
export function packAddIp(p: Pack, name: string, ip: IpAddr, index: number, total: number): void {
  p.addEx(`${name}@ipv6_bool`, VALUE_INT, isIp4(ip) ? 0 : 1, index, total);
  p.addEx(`${name}@ipv6_array`, VALUE_DATA, Buffer.from(ip.address), index, total);
  p.addEx(`${name}@ipv6_scope_id`, VALUE_INT, ip.scopeId >>> 0, index, total);
  p.addEx(name, VALUE_INT, ipToUint(ip), index, total);
}

/** PackGetIpEx() */
export function packGetIp(p: Pack, name: string, index: number): IpAddr | null {
  if (p.getBool(`${name}@ipv6_bool`, index)) {
    const d = p.getData(`${name}@ipv6_array`, index);
    const address = d && d.length === 16 ? Buffer.from(d) : Buffer.alloc(16);
    return { address, scopeId: p.getInt(`${name}@ipv6_scope_id`, index) };
  }
  if (!p.get(name, VALUE_INT)) return null;
  return uintToIp(p.getInt(name, index));
}

// ---------------------------------------------------------------------------------------------------
// Date/time. SoftEther's SYSTEMTIME64 is "UTC milliseconds since 1970 minus 9 hours" (Kernel.c
// SystemToUINT64 / UINT64ToSystem); JSON uses RFC 3339 strings.

const NINE_HOURS = 32400000;
const SAFE_TIME64_MAX = 4102243323123;

/** SystemTime64ToJsonStr(): UINT64ToSystem() then "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ". 0 -> 1970-01-01T09:00:00.000Z. */
export function systemTime64ToJsonStr(t: bigint): string {
  let v = BigInt.asUintN(64, t + BigInt(NINE_HOURS));
  if (v > BigInt(SAFE_TIME64_MAX)) v = BigInt(SAFE_TIME64_MAX);
  return new Date(Number(v)).toISOString();
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * SystemToUINT64(): SystemToTime() clamps every field first (SystemToTm: MAKESURE year 1970..2099, month
 * 1..12, day 1..31, hour 0..23, minute/second 0..59), then c_mkgmtime() rolls day overflow into the next
 * month (Feb 31 -> Mar 3), as Date.UTC does for in-range fields. Milliseconds are added unclamped.
 */
function systemToUint64(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number): number {
  const time = Date.UTC(clamp(y, 1970, 2099), clamp(mo, 1, 12) - 1, clamp(d, 1, 31),
    clamp(h, 0, 23), clamp(mi, 0, 59), clamp(s, 0, 59)) / 1000;
  if (time < NINE_HOURS) return 0; // (sic) seconds compared with 32400000
  return time * 1000 + ms - NINE_HOURS;
}

/** DateTimeStrRFC3339ToSystemTime64(): the time zone suffix is ignored (value taken as UTC). */
export function dateTimeStrRFC3339ToSystemTime64(str: string): bigint {
  let tmp = str;
  const plus = tmp.indexOf("+");
  if (plus >= 0) tmp = tmp.slice(0, plus);
  if (tmp.length < 19) return 0n;
  if (!(tmp[4] === "-" && tmp[7] === "-" && tmp[10] === "T" && tmp[13] === ":" && tmp[16] === ":")) return 0n;
  let msec = "";
  if (tmp.length >= 21 && tmp[19] === ".") {
    msec = tmp.slice(20, 20 + Math.max(0, tmp.length - 21));
    while (msec.length < 3) msec += "0";
    msec = msec.slice(0, 3);
  }
  const f = (a: number, b: number) => cToInt(tmp.slice(a, b)) & 0xffff; // WORD fields
  const ms = cToInt(msec) & 0xffff;
  // NormalizeSystem(): SystemToUINT64 then UINT64ToSystem (clamped), then SystemToUINT64 again
  const v1 = systemToUint64(f(0, 4), f(5, 7), f(8, 10), f(11, 13), f(14, 16), f(17, 19), ms);
  const t = Math.min(Math.max(v1 + NINE_HOURS, 0), SAFE_TIME64_MAX);
  const dt = new Date(t);
  const v2 = systemToUint64(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), dt.getUTCHours(),
    dt.getUTCMinutes(), dt.getUTCSeconds(), dt.getUTCMilliseconds());
  return BigInt(v2);
}

// ---------------------------------------------------------------------------------------------------
// JSON -> PACK (JsonToPack / JsonTryParseValueAddToPack)

/** Thrown for parameters the JSON-RPC server's JSON parser would reject (negative or fractional numbers...). */
export class JsonParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonParamError";
  }
}

type JVal = { t: "num"; v: bigint } | { t: "bool"; v: boolean } | { t: "str"; v: string } | { t: "null" }
  | { t: "arr"; v: unknown[] } | { t: "obj"; v: Record<string, unknown> };

/**
 * What the server's JSON parser (Str.c parse_number_value: unsigned decimal digits only) makes of the
 * JSON.stringify() text of a JS value.
 */
function jval(x: unknown, path: string): JVal | undefined {
  if (x === null) return { t: "null" };
  if (x === undefined || typeof x === "function" || typeof x === "symbol") return undefined; // dropped by JSON.stringify
  if (typeof x === "boolean") return { t: "bool", v: x };
  if (typeof x === "string") return { t: "str", v: x };
  if (typeof x === "bigint") {
    if (x < 0n) throw new JsonParamError(`${path}: negative numbers are not accepted`);
    return { t: "num", v: BigInt.asUintN(64, x) };
  }
  if (typeof x === "number") {
    if (!Number.isFinite(x)) return { t: "null" }; // JSON.stringify -> null
    const text = JSON.stringify(x);
    if (!/^\d+$/.test(text)) throw new JsonParamError(`${path}: only non-negative integers are accepted (got ${text})`);
    return { t: "num", v: BigInt.asUintN(64, BigInt(text)) };
  }
  if (Array.isArray(x)) return { t: "arr", v: x };
  if (typeof x === "object") {
    const toJSON = (x as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === "function") return jval(toJSON.call(x), path);
    return { t: "obj", v: x as Record<string, unknown> };
  }
  return undefined;
}

function tryParseValueAddToPack(p: Pack, v: JVal, vName: string, index: number, total: number): void {
  let name: string | null;
  if ((name = trimEndWith(vName, "_bool")) !== null) {
    if (v.t === "bool") p.addEx(name, VALUE_INT, v.v ? 1 : 0, index, total);
    else if (v.t === "num") p.addEx(name, VALUE_INT, v.v !== 0n ? 1 : 0, index, total);
    else if (v.t === "str") p.addEx(name, VALUE_INT, cToBool(v.v) ? 1 : 0, index, total);
  } else if ((name = trimEndWith(vName, "_u32")) !== null) {
    if (v.t === "bool") p.addEx(name, VALUE_INT, v.v ? 1 : 0, index, total);
    else if (v.t === "num") p.addEx(name, VALUE_INT, Number(BigInt.asUintN(32, v.v)), index, total);
    else if (v.t === "str") p.addEx(name, VALUE_INT, cToInt(v.v), index, total);
  } else if ((name = trimEndWith(vName, "_u64")) !== null) {
    if (v.t === "bool") p.addEx(name, VALUE_INT64, v.v ? 1n : 0n, index, total);
    else if (v.t === "num") p.addEx(name, VALUE_INT64, v.v, index, total);
    else if (v.t === "str") p.addEx(name, VALUE_INT64, cToInt64(v.v), index, total);
  } else if ((name = trimEndWith(vName, "_str")) !== null) {
    if (v.t === "bool") p.addEx(name, VALUE_STR, Buffer.from(v.v ? "true" : "false"), index, total);
    else if (v.t === "num") p.addEx(name, VALUE_STR, Buffer.from(v.v.toString()), index, total);
    else if (v.t === "str") p.addEx(name, VALUE_STR, cStrBytes(v.v), index, total);
  } else if ((name = trimEndWith(vName, "_utf")) !== null) {
    if (v.t === "bool") p.addEx(name, VALUE_UNISTR, v.v ? "true" : "false", index, total);
    else if (v.t === "num") p.addEx(name, VALUE_UNISTR, v.v.toString(), index, total);
    else if (v.t === "str") p.addEx(name, VALUE_UNISTR, cStr(v.v), index, total);
  } else if ((name = trimEndWith(vName, "_bin")) !== null) {
    if (v.t === "str") {
      const data = base64ToBin(v.v);
      if (data) p.addEx(name, VALUE_DATA, data, index, total); // Base64ToBin() NULL -> PackAddDataEx() adds nothing
    }
  } else if ((name = trimEndWith(vName, "_dt")) !== null) {
    if (v.t === "num") p.addEx(name, VALUE_INT64, v.v, index, total);
    else if (v.t === "str") p.addEx(name, VALUE_INT64, dateTimeStrRFC3339ToSystemTime64(v.v), index, total);
  } else if ((name = trimEndWith(vName, "_ip")) !== null) {
    if (v.t === "str") {
      const ip = strToIp(v.v);
      if (ip) packAddIp(p, name, ip, index, total);
    }
  }
}

// OpenSSL crypto/evp/encode.c conv_ascii2bin() classes
const B64_WS = 0xe0, B64_EOLN = 0xf0, B64_CR = 0xf1, B64_EOF = 0xf2, B64_ERROR = 0xff;
function b64Class(c: number): number {
  if (c & 0x80) return B64_ERROR;
  if (c >= 0x41 && c <= 0x5a) return c - 0x41;
  if (c >= 0x61 && c <= 0x7a) return c - 0x61 + 26;
  if (c >= 0x30 && c <= 0x39) return c - 0x30 + 52;
  switch (c) {
    case 0x2b: return 62; // +
    case 0x2f: return 63; // /
    case 0x3d: return 0; // = (saved like a data character; counted as padding)
    case 0x09: case 0x20: return B64_WS;
    case 0x0a: return B64_EOLN;
    case 0x0d: return B64_CR;
    case 0x2d: return B64_EOF; // -
    default: return B64_ERROR;
  }
}
const b64IsData = (v: number) => (v | 0x13) !== 0xf3; // B64_BASE64()

/**
 * Base64ToBin() (Mayaqua/Memory.c) = Base64Decode() (Mayaqua/Encoding.c): EVP_DecodeUpdate() then
 * EVP_DecodeFinal() over the C string's bytes, ported from OpenSSL's encode.c so that malformed input gives
 * what the server makes of it: spaces/tabs/CR/LF are skipped, "-" ends the input, and an invalid character
 * fails the update but keeps the complete 64-character lines already decoded (the update's error return
 * skips DecodeFinal). Inputs shorter than 4 bytes and empty results -> null (nothing is added).
 */
function base64ToBin(s: string): Buffer | null {
  const src = Buffer.from(cStr(s), "utf8");
  if (Math.floor(src.length / 4) * 3 === 0) return null; // Base64Decode(NULL, ...) sizing
  const out: number[] = [];
  let d: number[] = [];
  let eof = 0;
  let seof = false;
  let failed = false;
  const flush = (): boolean => { // evp_decodeblock_int() on the saved characters
    if (d.length % 4 !== 0) return false;
    const bytes: number[] = [];
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] << 18) | (d[i + 1] << 12) | (d[i + 2] << 6) | d[i + 3];
      bytes.push((l >>> 16) & 0xff, (l >>> 8) & 0xff, l & 0xff);
    }
    d = [];
    if (eof > bytes.length) return false;
    out.push(...bytes.slice(0, bytes.length - eof));
    return true;
  };
  for (const c of src) {
    const v = b64Class(c);
    if (v === B64_ERROR) { failed = true; break; }
    if (c === 0x3d) eof++;
    else if (eof > 0 && b64IsData(v)) { failed = true; break; } // data after padding
    if (eof > 2) { failed = true; break; }
    if (v === B64_EOF) { seof = true; break; }
    if (b64IsData(v)) d.push(v);
    if (d.length === 64 && !flush()) { failed = true; break; }
  }
  // A failed update keeps what was decoded so far; so does a "-" in the middle of a group
  if (!failed && d.length > 0) {
    if (d.length % 4 === 0) flush();
    else if (!seof) return null; // EVP_DecodeFinal() fails on a partial group -> Base64Decode() returns 0
  }
  return out.length ? Buffer.from(out) : null;
}

/**
 * The JSON-RPC server parses the whole JSON.stringify() text of `params` before JsonToPack() runs, so values
 * that JsonToPack() later ignores (nested objects, arrays in arrays) still fail the request. Its parser
 * (Str.c, a parson fork) rejects numbers that are not plain unsigned decimal digits (Json_ToInt64Ex) and
 * \u escapes of unpaired surrogates (parse_utf16), which is how JSON.stringify() writes lone surrogates.
 */
function assertServerParsable(params: unknown): void {
  let text: string | undefined;
  try {
    // BigInts are not JSON (the JSON-RPC client could not send them); only their sign matters here
    text = JSON.stringify(params, (_k, v) => (typeof v === "bigint" ? (v < 0n ? -1 : 0) : v));
  } catch {
    return; // cyclic structures etc.: the per-value checks of jsonToPack() apply
  }
  if (text === undefined) return;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\"") {
      for (i++; i < text.length && text[i] !== "\""; i++) {
        if (text[i] !== "\\") continue;
        i++;
        if (text[i] === "u") {
          const cp = parseInt(text.slice(i + 1, i + 5), 16);
          if (cp >= 0xd800 && cp <= 0xdfff) throw new JsonParamError("strings must not contain unpaired surrogates");
          i += 4;
        }
      }
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      const m = /^-?\d*(?:\.\d*)?(?:[eE][+-]?\d+)?/.exec(text.slice(i))![0];
      if (!/^\d+$/.test(m)) throw new JsonParamError(`only non-negative integers are accepted (got ${m})`);
      i += m.length - 1;
    }
  }
}

/** JsonToPack(): the params object of a JSON-RPC request -> PACK. */
export function jsonToPack(params: Record<string, unknown> | null | undefined): Pack {
  const p = new Pack();
  if (!params || typeof params !== "object" || Array.isArray(params)) return p;
  assertServerParsable(params);
  for (const [name, raw] of Object.entries(params)) {
    const value = jval(raw, name);
    if (!value) continue;
    if (value.t === "arr") {
      const items = value.v;
      for (let j = 0; j < items.length; j++) {
        let item = jval(items[j], `${name}[${j}]`);
        if (item === undefined) item = { t: "null" }; // JSON.stringify turns array holes/undefined into null
        if (item.t !== "obj") {
          tryParseValueAddToPack(p, item, name, j, items.length);
        } else {
          for (const [name2, raw2] of Object.entries(item.v)) {
            const v2 = jval(raw2, `${name}[${j}].${name2}`);
            if (v2) tryParseValueAddToPack(p, v2, name2, j, items.length);
          }
        }
      }
    } else {
      tryParseValueAddToPack(p, value, name, 0, 1);
    }
  }
  return p;
}

// ---------------------------------------------------------------------------------------------------
// PACK -> JSON (PackToJson)

export interface ResultHint {
  /** PackAddBool* element names (JsonHint_IsBool) */
  b?: string[];
  /** PackAddTime64* element names (JsonHint_IsDateTime) */
  d?: string[];
  /** PackAdd*Ex element names (JsonHint_IsArray) -> JSON group name ("" = plain array) */
  a?: Record<string, string>;
  /** PackSetCurrentJsonGroupName() names (json_subitem_names), in call order */
  g?: string[];
}

interface ElemInfo {
  e: PackElement;
  isIp: boolean;   // JsonHint_IsIP
  isBool: boolean;
  isDt: boolean;
  isArray: boolean;
  group: string;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

/** JsonNewStr(): NULL for invalid UTF-8 (the key / array item is then dropped). */
function strBytesToJson(b: Buffer): string | undefined {
  try {
    return utf8Strict.decode(b);
  } catch {
    return undefined;
  }
}

function suffixFor(x: ElemInfo): string | null {
  const { e } = x;
  switch (e.type) {
    case VALUE_INT:
      if (x.isIp) return e.name.includes("@") ? null : "_ip";
      return x.isBool ? "_bool" : "_u32";
    case VALUE_INT64:
      if (x.isIp) return null;
      return x.isDt ? "_dt" : "_u64";
    case VALUE_DATA: return x.isIp ? null : "_bin";
    case VALUE_STR: return x.isIp ? null : "_str";
    case VALUE_UNISTR: return x.isIp ? null : "_utf";
  }
  return null;
}

/** The JSON value of one value of an element, or undefined when PackToJson would emit nothing. */
function jsonValueOf(p: Pack, x: ElemInfo, index: number): unknown {
  const { e } = x;
  const v = e.values[index];
  switch (e.type) {
    case VALUE_INT:
      if (x.isIp) {
        if (e.name.includes("@")) return undefined;
        const ip = packGetIp(p, e.name, index);
        return ip ? ipToStr(ip) : undefined;
      }
      if (x.isBool) return (typeof v === "number" ? v : 0) !== 0;
      return typeof v === "number" ? v : 0;
    case VALUE_INT64: {
      if (x.isIp) return undefined;
      const n = typeof v === "bigint" ? v : 0n;
      return x.isDt ? systemTime64ToJsonStr(n) : Number(n);
    }
    case VALUE_DATA: {
      if (x.isIp) return undefined;
      const d = Buffer.isBuffer(v) ? v : null;
      // JsonSetData(): base64 of an empty buffer is NULL -> no key
      return d && d.length > 0 ? d.toString("base64") : undefined;
    }
    case VALUE_STR:
      if (x.isIp) return undefined;
      return Buffer.isBuffer(v) ? strBytesToJson(v) : "";
    case VALUE_UNISTR:
      if (x.isIp) return undefined;
      return typeof v === "string" ? v : "";
  }
  return undefined;
}

let hintIndex: Map<string, ResultHint> | null = null;

/** The server dispatches RPC names case-insensitively (StrCmpi), so the hints are looked up the same way. */
export function hintsFor(method: string): ResultHint | undefined {
  hintIndex ??= new Map(Object.entries(RESULT_HINTS).map(([k, v]) => [ikey(k), v]));
  return hintIndex.get(ikey(method));
}

/** PackToJson() with the hints of `method` (RESULT_HINTS); unknown methods/elements get the defaults. */
export function packToJson(p: Pack, method?: string, hint: ResultHint | undefined = method ? hintsFor(method) : undefined): Record<string, unknown> {
  const bools = new Set((hint?.b ?? []).map(ikey));
  const dts = new Set((hint?.d ?? []).map(ikey));
  const arrays = new Map(Object.entries(hint?.a ?? {}).map(([k, g]) => [ikey(k), g]));

  // IP addresses are recognised structurally: name + name@ipv6_bool/_array/_scope_id
  const ipBases = new Set<string>();
  for (const e of p.elements) {
    const m = /^(.*)@ipv6_(bool|array|scope_id)$/i.exec(e.name);
    if (m && p.get(m[1], VALUE_INT)) ipBases.add(ikey(m[1]));
  }
  const infos: ElemInfo[] = p.elements.map((e) => {
    const k = ikey(e.name);
    const m = /^(.*)@ipv6_(bool|array|scope_id)$/i.exec(e.name);
    const base = m && ipBases.has(ikey(m[1])) ? ikey(m[1]) : null;
    const isIp = ipBases.has(k) || base !== null;
    const ak = base ?? k; // the @ companions share the IP's array/group hint
    return {
      e,
      isIp,
      isBool: bools.has(k),
      isDt: dts.has(k),
      isArray: arrays.has(ak),
      group: arrays.get(ak) ?? "",
    };
  });
  const isArr = (x: ElemInfo) => x.e.values.length >= 2 || x.isArray;

  const groups: string[] = [];
  const addGroup = (g: string) => { if (g && !groups.some((x) => ikey(x) === ikey(g))) groups.push(g); };
  for (const x of infos) if (isArr(x)) addGroup(x.group);
  for (const g of hint?.g ?? []) addGroup(g);

  const out: Record<string, unknown> = {};
  for (const g of groups) {
    const members = infos.filter((x) => isArr(x) && ikey(x.group) === ikey(g));
    let count = -1;
    let ok = true;
    for (const x of members) {
      if (count < 0) count = x.e.values.length;
      else if (count !== x.e.values.length) ok = false;
    }
    if (count < 0) count = 0;
    if (!ok) continue;
    const objs: Record<string, unknown>[] = Array.from({ length: count }, () => ({}));
    out[g] = objs;
    for (const x of members) {
      const suffix = suffixFor(x);
      if (suffix === null) continue;
      for (let j = 0; j < x.e.values.length; j++) {
        const v = jsonValueOf(p, x, j);
        if (v !== undefined) objs[j][x.e.name + suffix] = v;
      }
    }
  }
  for (const x of infos) {
    if (isArr(x)) {
      if (x.group) continue;
      const suffix = suffixFor(x);
      if (suffix === null) continue;
      const arr: unknown[] = [];
      for (let j = 0; j < x.e.values.length; j++) {
        const v = jsonValueOf(p, x, j);
        if (v !== undefined) arr.push(v);
      }
      out[x.e.name + suffix] = arr;
    } else if (x.e.values.length === 1) {
      const suffix = suffixFor(x);
      if (suffix === null) continue;
      const v = jsonValueOf(p, x, 0);
      if (v !== undefined) out[x.e.name + suffix] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------
// BEGIN GENERATED HINTS (tools/verify-native/gen-hints.py; do not edit by hand)
export const RESULT_HINTS: Record<string, ResultHint> = {
  "AddAccess": {"b":["Active","CheckDstMac","CheckSrcMac","CheckTcpState","Discard","Established","IsIPv6"],"a":{"Active":"","CheckDstMac":"","CheckSrcMac":"","CheckTcpState":"","Delay":"","DestIpAddress":"","DestIpAddress6":"","DestPortEnd":"","DestPortStart":"","DestSubnetMask":"","DestSubnetMask6":"","DestUsername":"","Discard":"","DstMacAddress":"","DstMacMask":"","Established":"","Id":"","IsIPv6":"","Jitter":"","Loss":"","Note":"","Priority":"","Protocol":"","RedirectUrl":"","SrcIpAddress":"","SrcIpAddress6":"","SrcMacAddress":"","SrcMacMask":"","SrcPortEnd":"","SrcPortStart":"","SrcSubnetMask":"","SrcSubnetMask6":"","SrcUsername":"","UniqueId":""}},
  "AddCa": {},
  "AddCrl": {},
  "AddEtherIpId": {},
  "AddL3If": {},
  "AddL3Switch": {},
  "AddL3Table": {},
  "AddLicenseKey": {},
  "AddLocalBridge": {"b":["TapMode"]},
  "AddWgk": {"a":{"Hub":"","Key":"","User":""}},
  "ChangeDDnsClientHostname": {},
  "Crash": {},
  "CreateGroup": {"b":["UsePolicy","policy:Access","policy:ArpDhcpOnly","policy:CheckIP","policy:CheckIPv6","policy:CheckMac","policy:DHCPFilter","policy:DHCPForce","policy:DHCPNoServer","policy:DHCPv6Filter","policy:DHCPv6NoServer","policy:FilterIPv4","policy:FilterIPv6","policy:FilterNonIP","policy:FixPassword","policy:MonitorPort","policy:NoBridge","policy:NoBroadcastLimiter","policy:NoIPv6DefaultRouterInRA","policy:NoIPv6DefaultRouterInRAWhenIPv6","policy:NoQoS","policy:NoRouting","policy:NoRoutingV6","policy:NoSavePassword","policy:NoServer","policy:NoServerV6","policy:PrivacyFilter","policy:RAFilter","policy:RSandRAFilter","policy:Ver3"]},
  "CreateHub": {"b":["NoEnum","Online"]},
  "CreateLink": {"b":["AddDefaultCA","CheckServerCert","DisableQoS","FromAdminPack","HalfConnection","HideNicInfoWindow","HideStatusWindow","NoRoutingTracking","NoUdpAcceleration","Online","RequireBridgeRoutingMode","RequireMonitorMode","UseCompress","UseEncrypt","policy:Access","policy:ArpDhcpOnly","policy:CheckIP","policy:CheckIPv6","policy:CheckMac","policy:DHCPFilter","policy:DHCPForce","policy:DHCPNoServer","policy:DHCPv6Filter","policy:DHCPv6NoServer","policy:FilterIPv4","policy:FilterIPv6","policy:FilterNonIP","policy:FixPassword","policy:MonitorPort","policy:NoBridge","policy:NoBroadcastLimiter","policy:NoIPv6DefaultRouterInRA","policy:NoIPv6DefaultRouterInRAWhenIPv6","policy:NoQoS","policy:NoRouting","policy:NoRoutingV6","policy:NoSavePassword","policy:NoServer","policy:NoServerV6","policy:PrivacyFilter","policy:RAFilter","policy:RSandRAFilter","policy:Ver3"]},
  "CreateListener": {"b":["Enable"]},
  "CreateUser": {"b":["UsePolicy","policy:Access","policy:ArpDhcpOnly","policy:CheckIP","policy:CheckIPv6","policy:CheckMac","policy:DHCPFilter","policy:DHCPForce","policy:DHCPNoServer","policy:DHCPv6Filter","policy:DHCPv6NoServer","policy:FilterIPv4","policy:FilterIPv6","policy:FilterNonIP","policy:FixPassword","policy:MonitorPort","policy:NoBridge","policy:NoBroadcastLimiter","policy:NoIPv6DefaultRouterInRA","policy:NoIPv6DefaultRouterInRAWhenIPv6","policy:NoQoS","policy:NoRouting","policy:NoRoutingV6","policy:NoSavePassword","policy:NoServer","policy:NoServerV6","policy:PrivacyFilter","policy:RAFilter","policy:RSandRAFilter","policy:Ver3"],"d":["CreatedTime","ExpireTime","UpdatedTime"]},
  "Debug": {},
  "DelCrl": {},
  "DelL3If": {},
  "DelL3Switch": {},
  "DelL3Table": {},
  "DelLicenseKey": {},
  "DeleteAccess": {},
  "DeleteCa": {},
  "DeleteEtherIpId": {},
  "DeleteGroup": {},
  "DeleteHub": {},
  "DeleteIpTable": {},
  "DeleteLink": {},
  "DeleteListener": {"b":["Enable"]},
  "DeleteLocalBridge": {"b":["TapMode"]},
  "DeleteMacTable": {},
  "DeleteSession": {},
  "DeleteUser": {},
  "DeleteWgk": {"a":{"Hub":"","Key":"","User":""}},
  "DisableSecureNAT": {},
  "DisconnectConnection": {},
  "EnableListener": {"b":["Enable"]},
  "EnableSecureNAT": {},
  "EnumAccess": {"b":["Active","CheckDstMac","CheckSrcMac","CheckTcpState","Discard","Established","IsIPv6"],"a":{"Active":"AccessList","CheckDstMac":"AccessList","CheckSrcMac":"AccessList","CheckTcpState":"AccessList","Delay":"AccessList","DestIpAddress":"AccessList","DestIpAddress6":"AccessList","DestPortEnd":"AccessList","DestPortStart":"AccessList","DestSubnetMask":"AccessList","DestSubnetMask6":"AccessList","DestUsername":"AccessList","Discard":"AccessList","DstMacAddress":"AccessList","DstMacMask":"AccessList","Established":"AccessList","Id":"AccessList","IsIPv6":"AccessList","Jitter":"AccessList","Loss":"AccessList","Note":"AccessList","Priority":"AccessList","Protocol":"AccessList","RedirectUrl":"AccessList","SrcIpAddress":"AccessList","SrcIpAddress6":"AccessList","SrcMacAddress":"AccessList","SrcMacMask":"AccessList","SrcPortEnd":"AccessList","SrcPortStart":"AccessList","SrcSubnetMask":"AccessList","SrcSubnetMask6":"AccessList","SrcUsername":"AccessList","UniqueId":"AccessList"},"g":["AccessList"]},
  "EnumCa": {"d":["Expires"],"a":{"Expires":"CAList","IssuerName":"CAList","Key":"CAList","SubjectName":"CAList"},"g":["CAList"]},
  "EnumConnection": {"d":["ConnectedTime"],"a":{"ConnectedTime":"ConnectionList","Hostname":"ConnectionList","Ip":"ConnectionList","Name":"ConnectionList","Port":"ConnectionList","Type":"ConnectionList"},"g":["ConnectionList"]},
  "EnumCrl": {"a":{"CrlInfo":"CRLList","Key":"CRLList"},"g":["CRLList"]},
  "EnumDHCP": {"d":["ExpireTime","LeasedTime"],"a":{"ExpireTime":"DhcpTable","Hostname":"DhcpTable","Id":"DhcpTable","IpAddress":"DhcpTable","LeasedTime":"DhcpTable","MacAddress":"DhcpTable","Mask":"DhcpTable"},"g":["DhcpTable"]},
  "EnumEthVLan": {"b":["Enabled","Support"],"a":{"DeviceInstanceId":"Devices","DeviceName":"Devices","DriverName":"Devices","DriverType":"Devices","Enabled":"Devices","Guid":"Devices","Support":"Devices"},"g":["Devices"]},
  "EnumEtherIpId": {"a":{"HubName":"Settings","Id":"Settings","Password":"Settings","UserName":"Settings"},"g":["Settings"]},
  "EnumEthernet": {"a":{"DeviceName":"EthList","NetworkConnectionName":"EthList"},"g":["EthList"]},
  "EnumFarmMember": {"b":["Controller"],"d":["ConnectedTime"],"a":{"AssignedBridgeLicense":"FarmMemberList","AssignedClientLicense":"FarmMemberList","ConnectedTime":"FarmMemberList","Controller":"FarmMemberList","Hostname":"FarmMemberList","Id":"FarmMemberList","Ip":"FarmMemberList","NumHubs":"FarmMemberList","NumSessions":"FarmMemberList","NumTcpConnections":"FarmMemberList","Point":"FarmMemberList"},"g":["FarmMemberList"]},
  "EnumGroup": {"b":["DenyAccess"],"a":{"DenyAccess":"GroupList","Name":"GroupList","Note":"GroupList","NumUsers":"GroupList","Realname":"GroupList"},"g":["GroupList"]},
  "EnumHub": {"b":["IsTrafficFilled","Online"],"d":["CreatedTime","LastCommTime","LastLoginTime"],"a":{"CreatedTime":"HubList","Ex.Recv.BroadcastBytes":"HubList","Ex.Recv.BroadcastCount":"HubList","Ex.Recv.UnicastBytes":"HubList","Ex.Recv.UnicastCount":"HubList","Ex.Send.BroadcastBytes":"HubList","Ex.Send.BroadcastCount":"HubList","Ex.Send.UnicastBytes":"HubList","Ex.Send.UnicastCount":"HubList","HubName":"HubList","HubType":"HubList","IsTrafficFilled":"HubList","LastCommTime":"HubList","LastLoginTime":"HubList","NumGroups":"HubList","NumIpTables":"HubList","NumLogin":"HubList","NumMacTables":"HubList","NumSessions":"HubList","NumUsers":"HubList","Online":"HubList"},"g":["HubList"]},
  "EnumIpTable": {"b":["DhcpAllocated","RemoteItem"],"d":["CreatedTime","UpdatedTime"],"a":{"CreatedTime":"IpTable","DhcpAllocated":"IpTable","Ip":"IpTable","IpAddress":"IpTable","IpV6":"IpTable","Key":"IpTable","RemoteHostname":"IpTable","RemoteItem":"IpTable","SessionName":"IpTable","UpdatedTime":"IpTable"},"g":["IpTable"]},
  "EnumL3If": {"a":{"HubName":"L3IFList","IpAddress":"L3IFList","SubnetMask":"L3IFList"},"g":["L3IFList"]},
  "EnumL3Switch": {"b":["Active","Online"],"a":{"Active":"L3SWList","Name":"L3SWList","NumInterfaces":"L3SWList","NumTables":"L3SWList","Online":"L3SWList"},"g":["L3SWList"]},
  "EnumL3Table": {"a":{"GatewayAddress":"L3Table","Metric":"L3Table","NetworkAddress":"L3Table","SubnetMask":"L3Table"},"g":["L3Table"]},
  "EnumLicenseKey": {"d":["Expires"],"a":{"Expires":"LicenseKeyList","Id":"LicenseKeyList","LicenseId":"LicenseKeyList","LicenseKey":"LicenseKeyList","LicenseName":"LicenseKeyList","ProductId":"LicenseKeyList","SerialId":"LicenseKeyList","Status":"LicenseKeyList","SystemId":"LicenseKeyList"},"g":["LicenseKeyList"]},
  "EnumLink": {"b":["Connected","Online"],"d":["ConnectedTime"],"a":{"AccountName":"LinkList","Connected":"LinkList","ConnectedHubName":"LinkList","ConnectedTime":"LinkList","Hostname":"LinkList","LastError":"LinkList","Online":"LinkList","TargetHubName":"LinkList"},"g":["LinkList"]},
  "EnumListener": {"b":["Enables","Errors"],"a":{"Enables":"ListenerList","Errors":"ListenerList","Ports":"ListenerList"},"g":["ListenerList"]},
  "EnumLocalBridge": {"b":["Active","Online","TapMode"],"a":{"Active":"LocalBridgeList","DeviceName":"LocalBridgeList","HubNameLB":"LocalBridgeList","Online":"LocalBridgeList","TapMode":"LocalBridgeList"},"g":["LocalBridgeList"]},
  "EnumLogFile": {"d":["UpdatedTime"],"a":{"FilePath":"LogFiles","FileSize":"LogFiles","ServerName":"LogFiles","UpdatedTime":"LogFiles"},"g":["LogFiles"]},
  "EnumMacTable": {"b":["RemoteItem"],"d":["CreatedTime","UpdatedTime"],"a":{"CreatedTime":"MacTable","Key":"MacTable","MacAddress":"MacTable","RemoteHostname":"MacTable","RemoteItem":"MacTable","SessionName":"MacTable","UpdatedTime":"MacTable","VlanId":"MacTable"},"g":["MacTable"]},
  "EnumNAT": {"d":["CreatedTime","LastCommTime"],"a":{"CreatedTime":"NatTable","DestHost":"NatTable","DestIp":"NatTable","DestPort":"NatTable","Id":"NatTable","LastCommTime":"NatTable","Protocol":"NatTable","RecvSize":"NatTable","SendSize":"NatTable","SrcHost":"NatTable","SrcIp":"NatTable","SrcPort":"NatTable","TcpStatus":"NatTable"},"g":["NatTable"]},
  "EnumSession": {"b":["BridgeMode","Client_BridgeMode","Client_MonitorMode","IsDormant","IsDormantEnabled","Layer3Mode","LinkMode","RemoteSession","SecureNATMode"],"d":["CreatedTime","LastCommDormant","LastCommTime"],"a":{"BridgeMode":"SessionList","ClientIP":"SessionList","Client_BridgeMode":"SessionList","Client_MonitorMode":"SessionList","CreatedTime":"SessionList","CurrentNumTcp":"SessionList","Hostname":"SessionList","Ip":"SessionList","IsDormant":"SessionList","IsDormantEnabled":"SessionList","LastCommDormant":"SessionList","LastCommTime":"SessionList","Layer3Mode":"SessionList","LinkMode":"SessionList","MaxNumTcp":"SessionList","Name":"SessionList","PacketNum":"SessionList","PacketSize":"SessionList","RemoteHostname":"SessionList","RemoteSession":"SessionList","SecureNATMode":"SessionList","UniqueId":"SessionList","Username":"SessionList","VLanId":"SessionList"},"g":["SessionList"]},
  "EnumUser": {"b":["DenyAccess","IsExpiresFilled","IsTrafficFilled"],"d":["Expires","LastLoginTime"],"a":{"AuthType":"UserList","DenyAccess":"UserList","Ex.Recv.BroadcastBytes":"UserList","Ex.Recv.BroadcastCount":"UserList","Ex.Recv.UnicastBytes":"UserList","Ex.Recv.UnicastCount":"UserList","Ex.Send.BroadcastBytes":"UserList","Ex.Send.BroadcastCount":"UserList","Ex.Send.UnicastBytes":"UserList","Ex.Send.UnicastCount":"UserList","Expires":"UserList","GroupName":"UserList","IsExpiresFilled":"UserList","IsTrafficFilled":"UserList","LastLoginTime":"UserList","Name":"UserList","Note":"UserList","NumLogin":"UserList","Realname":"UserList"},"g":["UserList"]},
  "EnumWgk": {"a":{"Hub":"","Key":"","User":""}},
  "Flush": {},
  "GetAcList": {"b":["Deny","Masked"],"a":{"Deny":"ACList","Id":"ACList","IpAddress":"ACList","Masked":"ACList","Priority":"ACList","SubnetMask":"ACList"},"g":["ACList"]},
  "GetAdminMsg": {},
  "GetAzureStatus": {"b":["IsConnected","IsEnabled"]},
  "GetBridgeSupport": {"b":["IsBridgeSupportedOs","IsWinPcapNeeded"]},
  "GetCa": {},
  "GetCaps": {"a":{"CapsDescrption":"CapsList","CapsName":"CapsList","CapsValue":"CapsList"},"g":["CapsList"]},
  "GetConfig": {},
  "GetConnectionInfo": {"d":["ConnectedTime"]},
  "GetCrl": {},
  "GetDDnsClientStatus": {},
  "GetDDnsInternetSetting": {},
  "GetDefaultHubAdminOptions": {"a":{"Descrption":"AdminOptionList","Name":"AdminOptionList","Value":"AdminOptionList"},"g":["AdminOptionList"]},
  "GetEtherIpId": {},
  "GetFarmConnectionStatus": {"b":["Online"],"d":["CurrentConnectedTime","FirstConnectedTime","StartedTime"]},
  "GetFarmInfo": {"b":["Controller","DynamicHub"],"d":["ConnectedTime"],"a":{"DynamicHub":"HubsList","HubName":"HubsList","Ports":""},"g":["HubsList"]},
  "GetFarmSetting": {"b":["ControllerOnly"],"a":{"Ports":""}},
  "GetGroup": {"b":["UsePolicy","policy:Access","policy:ArpDhcpOnly","policy:CheckIP","policy:CheckIPv6","policy:CheckMac","policy:DHCPFilter","policy:DHCPForce","policy:DHCPNoServer","policy:DHCPv6Filter","policy:DHCPv6NoServer","policy:FilterIPv4","policy:FilterIPv6","policy:FilterNonIP","policy:FixPassword","policy:MonitorPort","policy:NoBridge","policy:NoBroadcastLimiter","policy:NoIPv6DefaultRouterInRA","policy:NoIPv6DefaultRouterInRAWhenIPv6","policy:NoQoS","policy:NoRouting","policy:NoRoutingV6","policy:NoSavePassword","policy:NoServer","policy:NoServerV6","policy:PrivacyFilter","policy:RAFilter","policy:RSandRAFilter","policy:Ver3"]},
  "GetHub": {"b":["NoEnum","Online"]},
  "GetHubAdminOptions": {"a":{"Descrption":"AdminOptionList","Name":"AdminOptionList","Value":"AdminOptionList"},"g":["AdminOptionList"]},
  "GetHubExtOptions": {"a":{"Descrption":"AdminOptionList","Name":"AdminOptionList","Value":"AdminOptionList"},"g":["AdminOptionList"]},
  "GetHubLog": {"b":["SavePacketLog","SaveSecurityLog"],"a":{"PacketLogConfig":""}},
  "GetHubMsg": {},
  "GetHubRadius": {},
  "GetHubStatus": {"b":["Online","SecureNATEnabled"],"d":["CreatedTime","LastCommTime","LastLoginTime"]},
  "GetIPsecServices": {"b":["EtherIP_IPsec","L2TP_IPsec","L2TP_Raw"]},
  "GetKeep": {"b":["UseKeepConnect"]},
  "GetLicenseStatus": {"b":["AllowEnterpriseFunction","IsSubscriptionExpired","NeedSubscription"],"d":["ReleaseDate","SubscriptionExpires","SystemExpires"]},
  "GetLink": {"b":["AddDefaultCA","CheckServerCert","DisableQoS","FromAdminPack","HalfConnection","HideNicInfoWindow","HideStatusWindow","NoRoutingTracking","NoUdpAcceleration","Online","RequireBridgeRoutingMode","RequireMonitorMode","UseCompress","UseEncrypt","policy:Access","policy:ArpDhcpOnly","policy:CheckIP","policy:CheckIPv6","policy:CheckMac","policy:DHCPFilter","policy:DHCPForce","policy:DHCPNoServer","policy:DHCPv6Filter","policy:DHCPv6NoServer","policy:FilterIPv4","policy:FilterIPv6","policy:FilterNonIP","policy:FixPassword","policy:MonitorPort","policy:NoBridge","policy:NoBroadcastLimiter","policy:NoIPv6DefaultRouterInRA","policy:NoIPv6DefaultRouterInRAWhenIPv6","policy:NoQoS","policy:NoRouting","policy:NoRoutingV6","policy:NoSavePassword","policy:NoServer","policy:NoServerV6","policy:PrivacyFilter","policy:RAFilter","policy:RSandRAFilter","policy:Ver3"]},
  "GetLinkStatus": {"b":["Active","Connected","HalfConnection","IsBridgeMode","IsMonitorMode","IsRUDPSession","IsUdpAccelerationEnabled","IsUsingUdpAcceleration","QoS","UseCompress","UseEncrypt","policy:Access","policy:ArpDhcpOnly","policy:CheckIP","policy:CheckIPv6","policy:CheckMac","policy:DHCPFilter","policy:DHCPForce","policy:DHCPNoServer","policy:DHCPv6Filter","policy:DHCPv6NoServer","policy:FilterIPv4","policy:FilterIPv6","policy:FilterNonIP","policy:FixPassword","policy:MonitorPort","policy:NoBridge","policy:NoBroadcastLimiter","policy:NoIPv6DefaultRouterInRA","policy:NoIPv6DefaultRouterInRAWhenIPv6","policy:NoQoS","policy:NoRouting","policy:NoRoutingV6","policy:NoSavePassword","policy:NoServer","policy:NoServerV6","policy:PrivacyFilter","policy:RAFilter","policy:RSandRAFilter","policy:Ver3"],"d":["CurrentConnectionEstablishTime","FirstConnectionEstablisiedTime","StartTime"]},
  "GetOpenVpnSstpConfig": {"b":["EnableOpenVPN","EnableSSTP"]},
  "GetPortsUDP": {"a":{"Ports":""}},
  "GetProtoOptions": {"a":{"Name":"","Type":"","Value":""}},
  "GetSecureNATOption": {"b":["ApplyDhcpPushRoutes","SaveLog","UseDhcp","UseNat"]},
  "GetSecureNATStatus": {"b":["IsKernelMode","IsRawIpMode"]},
  "GetServerCert": {"a":{"Chain":""}},
  "GetServerCipher": {},
  "GetServerCipherList": {},
  "GetServerInfo": {"d":["ServerBuildDate"]},
  "GetServerStatus": {"d":["CurrentTime","StartTime"]},
  "GetSessionStatus": {"b":["Active","Connected","HalfConnection","IsBridgeMode","IsMonitorMode","IsRUDPSession","IsUdpAccelerationEnabled","IsUsingUdpAcceleration","QoS","UseCompress","UseEncrypt","policy:Access","policy:ArpDhcpOnly","policy:CheckIP","policy:CheckIPv6","policy:CheckMac","policy:DHCPFilter","policy:DHCPForce","policy:DHCPNoServer","policy:DHCPv6Filter","policy:DHCPv6NoServer","policy:FilterIPv4","policy:FilterIPv6","policy:FilterNonIP","policy:FixPassword","policy:MonitorPort","policy:NoBridge","policy:NoBroadcastLimiter","policy:NoIPv6DefaultRouterInRA","policy:NoIPv6DefaultRouterInRAWhenIPv6","policy:NoQoS","policy:NoRouting","policy:NoRoutingV6","policy:NoSavePassword","policy:NoServer","policy:NoServerV6","policy:PrivacyFilter","policy:RAFilter","policy:RSandRAFilter","policy:Ver3"],"d":["CurrentConnectionEstablishTime","FirstConnectionEstablisiedTime","StartTime"]},
  "GetSpecialListener": {"b":["VpnOverDnsListener","VpnOverIcmpListener"]},
  "GetSysLog": {},
  "GetUser": {"b":["UsePolicy","policy:Access","policy:ArpDhcpOnly","policy:CheckIP","policy:CheckIPv6","policy:CheckMac","policy:DHCPFilter","policy:DHCPForce","policy:DHCPNoServer","policy:DHCPv6Filter","policy:DHCPv6NoServer","policy:FilterIPv4","policy:FilterIPv6","policy:FilterNonIP","policy:FixPassword","policy:MonitorPort","policy:NoBridge","policy:NoBroadcastLimiter","policy:NoIPv6DefaultRouterInRA","policy:NoIPv6DefaultRouterInRAWhenIPv6","policy:NoQoS","policy:NoRouting","policy:NoRoutingV6","policy:NoSavePassword","policy:NoServer","policy:NoServerV6","policy:PrivacyFilter","policy:RAFilter","policy:RSandRAFilter","policy:Ver3"],"d":["CreatedTime","ExpireTime","UpdatedTime"]},
  "MakeOpenVpnConfigFile": {},
  "ReadLogFile": {},
  "RebootServer": {},
  "RegenerateServerCert": {},
  "RenameLink": {},
  "SetAcList": {"b":["Deny","Masked"],"a":{"Deny":"ACList","Id":"ACList","IpAddress":"ACList","Masked":"ACList","Priority":"ACList","SubnetMask":"ACList"},"g":["ACList"]},
  "SetAccessList": {"b":["Active","CheckDstMac","CheckSrcMac","CheckTcpState","Discard","Established","IsIPv6"],"a":{"Active":"AccessList","CheckDstMac":"AccessList","CheckSrcMac":"AccessList","CheckTcpState":"AccessList","Delay":"AccessList","DestIpAddress":"AccessList","DestIpAddress6":"AccessList","DestPortEnd":"AccessList","DestPortStart":"AccessList","DestSubnetMask":"AccessList","DestSubnetMask6":"AccessList","DestUsername":"AccessList","Discard":"AccessList","DstMacAddress":"AccessList","DstMacMask":"AccessList","Established":"AccessList","Id":"AccessList","IsIPv6":"AccessList","Jitter":"AccessList","Loss":"AccessList","Note":"AccessList","Priority":"AccessList","Protocol":"AccessList","RedirectUrl":"AccessList","SrcIpAddress":"AccessList","SrcIpAddress6":"AccessList","SrcMacAddress":"AccessList","SrcMacMask":"AccessList","SrcPortEnd":"AccessList","SrcPortStart":"AccessList","SrcSubnetMask":"AccessList","SrcSubnetMask6":"AccessList","SrcUsername":"AccessList","UniqueId":"AccessList"},"g":["AccessList"]},
  "SetAzureStatus": {"b":["IsConnected","IsEnabled"]},
  "SetConfig": {},
  "SetCrl": {},
  "SetDDnsInternetSetting": {},
  "SetEnableEthVLan": {},
  "SetFarmSetting": {"b":["ControllerOnly"],"a":{"Ports":""}},
  "SetGroup": {"b":["UsePolicy","policy:Access","policy:ArpDhcpOnly","policy:CheckIP","policy:CheckIPv6","policy:CheckMac","policy:DHCPFilter","policy:DHCPForce","policy:DHCPNoServer","policy:DHCPv6Filter","policy:DHCPv6NoServer","policy:FilterIPv4","policy:FilterIPv6","policy:FilterNonIP","policy:FixPassword","policy:MonitorPort","policy:NoBridge","policy:NoBroadcastLimiter","policy:NoIPv6DefaultRouterInRA","policy:NoIPv6DefaultRouterInRAWhenIPv6","policy:NoQoS","policy:NoRouting","policy:NoRoutingV6","policy:NoSavePassword","policy:NoServer","policy:NoServerV6","policy:PrivacyFilter","policy:RAFilter","policy:RSandRAFilter","policy:Ver3"]},
  "SetHub": {"b":["NoEnum","Online"]},
  "SetHubAdminOptions": {"a":{"Descrption":"AdminOptionList","Name":"AdminOptionList","Value":"AdminOptionList"},"g":["AdminOptionList"]},
  "SetHubExtOptions": {"a":{"Descrption":"AdminOptionList","Name":"AdminOptionList","Value":"AdminOptionList"},"g":["AdminOptionList"]},
  "SetHubLog": {"b":["SavePacketLog","SaveSecurityLog"],"a":{"PacketLogConfig":""}},
  "SetHubMsg": {},
  "SetHubOnline": {"b":["Online"]},
  "SetHubRadius": {},
  "SetIPsecServices": {"b":["EtherIP_IPsec","L2TP_IPsec","L2TP_Raw"]},
  "SetKeep": {"b":["UseKeepConnect"]},
  "SetLink": {"b":["AddDefaultCA","CheckServerCert","DisableQoS","FromAdminPack","HalfConnection","HideNicInfoWindow","HideStatusWindow","NoRoutingTracking","NoUdpAcceleration","Online","RequireBridgeRoutingMode","RequireMonitorMode","UseCompress","UseEncrypt","policy:Access","policy:ArpDhcpOnly","policy:CheckIP","policy:CheckIPv6","policy:CheckMac","policy:DHCPFilter","policy:DHCPForce","policy:DHCPNoServer","policy:DHCPv6Filter","policy:DHCPv6NoServer","policy:FilterIPv4","policy:FilterIPv6","policy:FilterNonIP","policy:FixPassword","policy:MonitorPort","policy:NoBridge","policy:NoBroadcastLimiter","policy:NoIPv6DefaultRouterInRA","policy:NoIPv6DefaultRouterInRAWhenIPv6","policy:NoQoS","policy:NoRouting","policy:NoRoutingV6","policy:NoSavePassword","policy:NoServer","policy:NoServerV6","policy:PrivacyFilter","policy:RAFilter","policy:RSandRAFilter","policy:Ver3"]},
  "SetLinkOffline": {},
  "SetLinkOnline": {},
  "SetOpenVpnSstpConfig": {"b":["EnableOpenVPN","EnableSSTP"]},
  "SetPortsUDP": {"a":{"Ports":""}},
  "SetProtoOptions": {"a":{"Name":"","Type":"","Value":""}},
  "SetSecureNATOption": {"b":["ApplyDhcpPushRoutes","SaveLog","UseDhcp","UseNat"]},
  "SetServerCert": {"a":{"Chain":""}},
  "SetServerCipher": {},
  "SetServerPassword": {},
  "SetSpecialListener": {"b":["VpnOverDnsListener","VpnOverIcmpListener"]},
  "SetSysLog": {},
  "SetUser": {"b":["UsePolicy","policy:Access","policy:ArpDhcpOnly","policy:CheckIP","policy:CheckIPv6","policy:CheckMac","policy:DHCPFilter","policy:DHCPForce","policy:DHCPNoServer","policy:DHCPv6Filter","policy:DHCPv6NoServer","policy:FilterIPv4","policy:FilterIPv6","policy:FilterNonIP","policy:FixPassword","policy:MonitorPort","policy:NoBridge","policy:NoBroadcastLimiter","policy:NoIPv6DefaultRouterInRA","policy:NoIPv6DefaultRouterInRAWhenIPv6","policy:NoQoS","policy:NoRouting","policy:NoRoutingV6","policy:NoSavePassword","policy:NoServer","policy:NoServerV6","policy:PrivacyFilter","policy:RAFilter","policy:RSandRAFilter","policy:Ver3"],"d":["CreatedTime","ExpireTime","UpdatedTime"]},
  "StartL3Switch": {},
  "StopL3Switch": {},
  "Test": {},
};
// END GENERATED HINTS
