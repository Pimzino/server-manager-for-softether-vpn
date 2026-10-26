// Branding of Windows binaries without rebuilding SoftEther:
//  * PE resources (icon, version info, extra RCDATA) via resedit — used for the setup.exe launcher
//    and, optionally, for vpnclient.exe / vpncmgr.exe (this invalidates any Authenticode signature;
//    SoftEther's own release binaries are unsigned).
//  * hamcore.se2 string tables — SoftEther reads its UI texts (window titles, product names,
//    service names) from strtable_<lang>.stb inside this archive, so they can be overridden.
import { deflateSync, inflateSync } from "node:zlib";
import * as PELibrary from "pe-library";
import * as ResEdit from "resedit";

const RT_RCDATA = 10;
const LANG_EN_US = 1033;
const CODEPAGE_UNICODE = 1200;

export interface VersionStrings {
  CompanyName?: string;
  FileDescription?: string;
  ProductName?: string;
  LegalCopyright?: string;
  OriginalFilename?: string;
  InternalName?: string;
  Comments?: string;
}

export interface PeBrandingOptions {
  /** .ico file contents: replaces the first (application) icon group, or adds one */
  icon?: Buffer | null;
  strings?: VersionStrings;
  /** a.b.c.d file/product version */
  version?: string;
  /** RCDATA resources to add/replace (name -> bytes) */
  rcdata?: Record<string, Buffer>;
}

function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function versionParts(v: string): [number, number, number, number] {
  const p = v.split(".").map((x) => Math.min(65535, Math.max(0, parseInt(x, 10) || 0)));
  while (p.length < 4) p.push(0);
  return [p[0], p[1], p[2], p[3]];
}

/** Apply icon / version info / RCDATA to a PE executable and return the new bytes. */
export function brandPe(exe: Buffer, o: PeBrandingOptions): Buffer {
  const nt = PELibrary.NtExecutable.from(exe, { ignoreCert: true });
  const res = PELibrary.NtExecutableResource.from(nt);

  if (o.icon && o.icon.length) {
    const ico = ResEdit.Data.IconFile.from(toArrayBuffer(o.icon));
    const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
    const target = groups.length
      ? [...groups].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }))[0]
      : null;
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries, target ? target.id : 1, target ? target.lang : LANG_EN_US, ico.icons.map((i) => i.data),
    );
  }

  if (o.strings || o.version) {
    const list = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
    const vi = list[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
    const langs = vi.getAllLanguagesForStringValues();
    const lang = langs[0] ?? { lang: LANG_EN_US, codepage: CODEPAGE_UNICODE };
    if (o.version) {
      const [a, b, c, d] = versionParts(o.version);
      vi.setFileVersion(a, b, c, d, lang.lang);
      vi.setProductVersion(a, b, c, d, lang.lang);
    }
    if (o.strings) {
      const clean = Object.fromEntries(Object.entries(o.strings).filter(([, v]) => typeof v === "string" && v !== ""));
      vi.setStringValues(lang, clean as Record<string, string>);
    }
    if (!list.length) vi.lang = lang.lang;
    vi.outputToResourceEntries(res.entries);
  }

  for (const [name, data] of Object.entries(o.rcdata ?? {})) {
    const id = name.toUpperCase();
    const idx = res.entries.findIndex((e) => e.type === RT_RCDATA && String(e.id).toUpperCase() === id);
    const entry = { type: RT_RCDATA, id, lang: LANG_EN_US, codepage: CODEPAGE_UNICODE, bin: toArrayBuffer(data) };
    if (idx >= 0) res.entries[idx] = entry; else res.entries.push(entry);
  }

  res.outputResource(nt);
  return Buffer.from(nt.generate());
}

export interface PeInfo {
  strings: Record<string, string>;
  fileVersion: string | null;
  iconGroups: number;
  rcdata: Record<string, number>;
}

/** Read back branding-relevant resources (for verification and previews). */
export function readPeInfo(exe: Buffer): PeInfo {
  const nt = PELibrary.NtExecutable.from(exe, { ignoreCert: true });
  const res = PELibrary.NtExecutableResource.from(nt);
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
  const lang = vi?.getAllLanguagesForStringValues()[0];
  const fi = vi?.fixedInfo;
  return {
    strings: vi && lang ? vi.getStringValues(lang) : {},
    fileVersion: fi ? `${fi.fileVersionMS >>> 16}.${fi.fileVersionMS & 0xffff}.${fi.fileVersionLS >>> 16}.${fi.fileVersionLS & 0xffff}` : null,
    iconGroups: ResEdit.Resource.IconGroupEntry.fromEntries(res.entries).length,
    rcdata: Object.fromEntries(res.entries.filter((e) => e.type === RT_RCDATA).map((e) => [String(e.id), e.bin.byteLength])),
  };
}

export function readRcdata(exe: Buffer, name: string): Buffer | null {
  const nt = PELibrary.NtExecutable.from(exe, { ignoreCert: true });
  const res = PELibrary.NtExecutableResource.from(nt);
  const e = res.entries.find((x) => x.type === RT_RCDATA && String(x.id).toUpperCase() === name.toUpperCase());
  return e ? Buffer.from(e.bin) : null;
}

// ---------------------------------------------------------------- hamcore.se2

export interface HamcoreEntry { path: string; data: Buffer }

/** Parse hamcore.se2 (libhamcore/Hamcore.c): "HamCore", u32be count, {u32be len+1, path, u32be orig, u32be size, u32be offset}[], zlib data. */
export function readHamcore(buf: Buffer): HamcoreEntry[] {
  if (buf.length < 11 || buf.toString("latin1", 0, 7) !== "HamCore") throw new Error("Not a hamcore.se2 archive");
  const count = buf.readUInt32BE(7);
  if (count > 100_000) throw new Error("hamcore.se2: implausible file count");
  let p = 11;
  const out: HamcoreEntry[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt32BE(p) - 1; p += 4;
    const path = buf.toString("utf8", p, p + nameLen); p += nameLen;
    const orig = buf.readUInt32BE(p); p += 4;
    const size = buf.readUInt32BE(p); p += 4;
    const offset = buf.readUInt32BE(p); p += 4;
    if (orig > 256 * 1024 * 1024 || offset + size > buf.length) throw new Error(`hamcore.se2: bad entry ${path}`);
    const data = inflateSync(buf.subarray(offset, offset + size), { maxOutputLength: Math.max(orig, 1) });
    out.push({ path, data });
  }
  return out;
}

export function writeHamcore(entries: HamcoreEntry[]): Buffer {
  const compressed = entries.map((e) => ({ path: Buffer.from(e.path, "utf8"), orig: e.data.length, z: deflateSync(e.data) }));
  const headerSize = 7 + 4 + compressed.reduce((n, e) => n + 4 + e.path.length + 12, 0);
  const total = headerSize + compressed.reduce((n, e) => n + e.z.length, 0);
  const out = Buffer.alloc(total);
  out.write("HamCore", 0, "latin1");
  out.writeUInt32BE(compressed.length, 7);
  let p = 11;
  let offset = headerSize;
  for (const e of compressed) {
    out.writeUInt32BE(e.path.length + 1, p); p += 4;
    e.path.copy(out, p); p += e.path.length;
    out.writeUInt32BE(e.orig, p); p += 4;
    out.writeUInt32BE(e.z.length, p); p += 4;
    out.writeUInt32BE(offset, p); p += 4;
    offset += e.z.length;
  }
  let q = headerSize;
  for (const e of compressed) { e.z.copy(out, q); q += e.z.length; }
  return out;
}

/** Keys whose values carry the client's product name (window titles, tray, services, logs). */
export const CLIENT_NAME_KEYS = [
  "PRODUCT_NAME_VPN_CLI", "CN_TITLE", "SVC_VPNCLIENT_TITLE", "SVC_SEVPNCLIENTDEV_TITLE", "SW_LONG_VPNCLIENT", "SW_COMPONENT_VPNCLIENT_TITLE",
];
export const MANAGER_NAME_KEYS = ["PRODUCT_NAME_VPN_CMGR", "CM_TITLE", "SW_LONG_VPNCMGR", "SW_LINK_NAME_VPNCMGR_SHORT", "SW_LINK_NAME_VPNCMGR_FULL"];

/** Escape a value for the .stb format (backslash escapes for CR/LF/TAB as SoftEther writes them). */
function stbValue(v: string) {
  return v.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

/**
 * Override string-table entries in every strtable_*.stb inside hamcore.se2. Returns the new
 * archive and the keys that were actually found (unknown keys are reported, not added).
 */
export function applyStringOverrides(hamcore: Buffer, overrides: Record<string, string>): { hamcore: Buffer; applied: string[]; missing: string[] } {
  const keys = Object.keys(overrides).filter((k) => /^[A-Z0-9_]+$/.test(k));
  if (!keys.length) return { hamcore, applied: [], missing: [] };
  const entries = readHamcore(hamcore);
  const found = new Set<string>();
  for (const e of entries) {
    if (!/(^|\/)strtable_[a-z_]+\.stb$/i.test(e.path)) continue;
    const text = e.data.toString("utf8");
    const lines = text.split(/(\r?\n)/);
    for (let i = 0; i < lines.length; i += 2) {
      const m = /^([A-Z0-9_]+)([\t ]+)(.*)$/.exec(lines[i]);
      if (m && keys.includes(m[1])) {
        lines[i] = `${m[1]}${m[2]}${stbValue(overrides[m[1]])}`;
        found.add(m[1]);
      }
    }
    e.data = Buffer.from(lines.join(""), "utf8");
  }
  return { hamcore: writeHamcore(entries), applied: [...found], missing: keys.filter((k) => !found.has(k)) };
}

/** Look up a string in a hamcore archive's English string table (for previews/tests). */
export function hamcoreString(hamcore: Buffer, key: string, lang = "en"): string | null {
  const e = readHamcore(hamcore).find((x) => x.path.toLowerCase().endsWith(`strtable_${lang}.stb`));
  if (!e) return null;
  const m = new RegExp(`^${key}[\\t ]+(.*)$`, "m").exec(e.data.toString("utf8"));
  return m ? m[1].trim() : null;
}
