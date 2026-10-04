// Extract the SoftEther VPN Client payload (vpnclient.exe, vpncmd.exe, vpncmgr.exe, hamcore.se2)
// from either:
//  * the official SFX installer (softether-vpnclient-*.exe): PE resources of type "DATAFILE"
//    (Cedar/SW.c SwSfxExtractFile). Names prefixed RAW_ are stored as-is; others are
//    Mayaqua UncompressBuf format = 4-byte big-endian original size + zlib stream.
//  * a ZIP archive containing the files (e.g. from a Windows build of the source tree).
import { inflateRawSync, inflateSync } from "node:zlib";

export interface PayloadFile { name: string; data: Buffer }

/** Upper bound for any single extracted file (hamcore.se2 is ~30 MB); guards against decompression bombs. */
const MAX_FILE = 256 * 1024 * 1024;

// ---------------- PE resources ----------------

interface Section { va: number; vsize: number; raw: number; rawSize: number }

function rvaToOffset(sections: Section[], rva: number): number {
  for (const s of sections) {
    if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw;
  }
  throw new Error(`RVA 0x${rva.toString(16)} outside sections`);
}

export function isPe(buf: Buffer) {
  return buf.length > 0x40 && buf.readUInt16LE(0) === 0x5a4d && buf.readUInt32LE(buf.readUInt32LE(0x3c)) === 0x00004550;
}

/** List resources of a given type name (e.g. "DATAFILE") as name -> raw bytes. */
export function readPeResources(buf: Buffer, typeName: string): Map<string, Buffer> {
  if (!isPe(buf)) throw new Error("Not a Windows PE executable");
  const pe = buf.readUInt32LE(0x3c);
  const numSections = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const dataDirs = opt + (magic === 0x20b ? 112 : 96);
  const resRva = buf.readUInt32LE(dataDirs + 2 * 8);
  if (!resRva) throw new Error("Executable has no resources");
  const sections: Section[] = [];
  const secTable = opt + optSize;
  for (let i = 0; i < numSections; i++) {
    const s = secTable + i * 40;
    sections.push({ vsize: buf.readUInt32LE(s + 8), va: buf.readUInt32LE(s + 12), rawSize: buf.readUInt32LE(s + 16), raw: buf.readUInt32LE(s + 20) });
  }
  const resBase = rvaToOffset(sections, resRva);

  const readName = (off: number) => {
    const len = buf.readUInt16LE(resBase + off);
    return buf.subarray(resBase + off + 2, resBase + off + 2 + len * 2).toString("utf16le");
  };
  const entries = (dirOff: number) => {
    const named = buf.readUInt16LE(resBase + dirOff + 12);
    const ids = buf.readUInt16LE(resBase + dirOff + 14);
    const out: { name: string | number; off: number; isDir: boolean }[] = [];
    for (let i = 0; i < named + ids; i++) {
      const e = resBase + dirOff + 16 + i * 8;
      const nameField = buf.readUInt32LE(e);
      const dataField = buf.readUInt32LE(e + 4);
      out.push({
        name: nameField & 0x80000000 ? readName(nameField & 0x7fffffff) : nameField,
        off: dataField & 0x7fffffff,
        isDir: (dataField & 0x80000000) !== 0,
      });
    }
    return out;
  };

  const result = new Map<string, Buffer>();
  const typeEntry = entries(0).find((e) => typeof e.name === "string" && e.name.toUpperCase() === typeName.toUpperCase());
  if (!typeEntry?.isDir) return result;
  for (const nameEntry of entries(typeEntry.off)) {
    if (!nameEntry.isDir) continue;
    const lang = entries(nameEntry.off)[0];
    if (!lang || lang.isDir) continue;
    const dataEntry = resBase + lang.off;
    const dataRva = buf.readUInt32LE(dataEntry);
    const size = buf.readUInt32LE(dataEntry + 4);
    const off = rvaToOffset(sections, dataRva);
    result.set(String(nameEntry.name), buf.subarray(off, off + size));
  }
  return result;
}

/** Extract files from a SoftEther SFX installer. */
export function extractSfx(buf: Buffer): PayloadFile[] {
  const res = readPeResources(buf, "DATAFILE");
  if (res.size === 0) throw new Error("This executable has no SoftEther DATAFILE resources (is it the official SoftEther VPN Client installer?)");
  const files: PayloadFile[] = [];
  for (const [rawName, data] of res) {
    let name = rawName.toLowerCase();
    let content: Buffer;
    if (name.startsWith("raw_")) {
      name = name.slice(4);
      content = Buffer.from(data);
    } else {
      const size = data.readUInt32BE(0);
      if (size > MAX_FILE) throw new Error(`${name} declares ${size} bytes, above the ${MAX_FILE}-byte limit`);
      content = inflateSync(data.subarray(4), { maxOutputLength: Math.max(size, 1) });
      if (content.length !== size) throw new Error(`Size mismatch extracting ${name}: ${content.length} != ${size}`);
    }
    files.push({ name, data: content });
  }
  return files;
}

// ---------------- ZIP (store + deflate) ----------------

export function isZip(buf: Buffer) {
  return buf.length > 22 && buf.readUInt32LE(0) === 0x04034b50;
}

export function readZip(buf: Buffer): PayloadFile[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Invalid ZIP: end of central directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files: PayloadFile[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Invalid ZIP central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      if (rawSize > MAX_FILE) throw new Error(`${name} is ${rawSize} bytes, above the ${MAX_FILE}-byte limit`);
      data = inflateRawSync(raw, { maxOutputLength: Math.max(rawSize, 1) });
    }
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    files.push({ name: name.split("/").pop()!.toLowerCase(), data });
  }
  return files;
}

// ---------------- Normalisation ----------------

export interface ClientPayload {
  edition: "dev" | "stable";
  arch: "x64" | "x86" | "arm64";
  version: string;
  files: PayloadFile[];   // normalised names: vpnclient.exe, vpncmd.exe, vpncmgr.exe (optional), hamcore.se2
}

function peMachine(buf: Buffer): "x64" | "x86" | "arm64" | "unknown" {
  if (!isPe(buf)) return "unknown";
  const m = buf.readUInt16LE(buf.readUInt32LE(0x3c) + 4);
  return m === 0x8664 ? "x64" : m === 0x14c ? "x86" : m === 0xaa64 ? "arm64" : "unknown";
}

/** Read VS_VERSION_INFO FileVersion (fixed part) if present. */
export function peVersion(buf: Buffer): string {
  try {
    const res = readPeResourcesById(buf, 16);
    const data = res[0];
    if (!data) return "";
    const sig = data.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe]));
    if (sig < 0) return "";
    const ms = data.readUInt32LE(sig + 8), ls = data.readUInt32LE(sig + 12);
    return `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
  } catch {
    return "";
  }
}

function readPeResourcesById(buf: Buffer, typeId: number): Buffer[] {
  // Minimal: reuse the directory walker by temporarily mapping numeric type ids.
  const pe = buf.readUInt32LE(0x3c);
  const numSections = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const resRva = buf.readUInt32LE(opt + (magic === 0x20b ? 112 : 96) + 16);
  const sections: Section[] = [];
  for (let i = 0; i < numSections; i++) {
    const s = opt + optSize + i * 40;
    sections.push({ vsize: buf.readUInt32LE(s + 8), va: buf.readUInt32LE(s + 12), rawSize: buf.readUInt32LE(s + 16), raw: buf.readUInt32LE(s + 20) });
  }
  const base = rvaToOffset(sections, resRva);
  const walk = (dirOff: number) => {
    const n = buf.readUInt16LE(base + dirOff + 12) + buf.readUInt16LE(base + dirOff + 14);
    return Array.from({ length: n }, (_, i) => {
      const e = base + dirOff + 16 + i * 8;
      return { id: buf.readUInt32LE(e), data: buf.readUInt32LE(e + 4) };
    });
  };
  const t = walk(0).find((e) => e.id === typeId);
  if (!t) return [];
  const out: Buffer[] = [];
  for (const n of walk(t.data & 0x7fffffff)) {
    const l = walk(n.data & 0x7fffffff)[0];
    if (!l) continue;
    const de = base + (l.data & 0x7fffffff);
    const off = rvaToOffset(sections, buf.readUInt32LE(de));
    out.push(buf.subarray(off, off + buf.readUInt32LE(de + 4)));
  }
  return out;
}

/**
 * Pick the right binaries for the requested architecture. Stable 4.x ships vpnclient.exe (x86)
 * and vpnclient_x64.exe side by side; Developer 5.x ships per-arch installers with plain names.
 */
export function normalizePayload(input: PayloadFile[], wantArch: "x64" | "x86" | "arm64" = "x64"): ClientPayload {
  const byName = new Map(input.map((f) => [f.name.toLowerCase(), f.data]));
  const pick = (base: string) => {
    const candidates = wantArch === "x64" ? [`${base}_x64.exe`, `${base}.exe`] : wantArch === "arm64" ? [`${base}_arm64.exe`, `${base}.exe`] : [`${base}.exe`];
    for (const c of candidates) {
      const d = byName.get(c);
      if (d && (peMachine(d) === wantArch || peMachine(d) === "unknown")) return d;
    }
    return undefined;
  };
  const vpnclient = pick("vpnclient");
  const vpncmd = pick("vpncmd");
  const vpncmgr = pick("vpncmgr");
  const hamcore = byName.get("hamcore.se2");
  const missing = [!vpnclient && "vpnclient.exe", !vpncmd && "vpncmd.exe", !hamcore && "hamcore.se2"].filter(Boolean);
  if (missing.length) {
    const found = [...byName.keys()].join(", ") || "nothing";
    throw new Error(`Package is missing ${missing.join(", ")} for ${wantArch} (found: ${found})`);
  }
  const utf16 = (s: string) => Buffer.from(s, "utf16le");
  const edition: ClientPayload["edition"] =
    vpnclient!.includes(utf16("Developer Edition")) || vpnclient!.includes(Buffer.from("Developer Edition")) || !byName.has("vpnclient_x64.exe") ? "dev" : "stable";
  const files: PayloadFile[] = [
    { name: "vpnclient.exe", data: vpnclient! },
    { name: "vpncmd.exe", data: vpncmd! },
    { name: "hamcore.se2", data: hamcore! },
  ];
  if (vpncmgr) files.push({ name: "vpncmgr.exe", data: vpncmgr });
  return { edition, arch: wantArch, version: peVersion(vpnclient!), files };
}

export function extractPayload(buf: Buffer, arch: "x64" | "x86" | "arm64" = "x64"): ClientPayload {
  if (isZip(buf)) return normalizePayload(readZip(buf), arch);
  if (isPe(buf)) return normalizePayload(extractSfx(buf), arch);
  throw new Error("Unrecognised file: upload the official SoftEther VPN Client installer (.exe) or a ZIP of the client files");
}
