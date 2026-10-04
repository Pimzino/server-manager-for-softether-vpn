import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import type { FileFilter } from "../../shared/ipc";
import { saveFile } from "./api";

dayjs.extend(relativeTime);

export const DASH = "–";

export function bytes(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return DASH;
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function num(n: number | undefined | null): string {
  return n === undefined || n === null || Number.isNaN(n) ? DASH : n.toLocaleString();
}

/** SoftEther datetimes are ISO strings; the zero date (1970) means "never". */
export function dt(v: string | number | undefined | null): string {
  if (v === undefined || v === null || v === "") return DASH;
  const d = dayjs(v);
  if (!d.isValid() || d.year() <= 1970) return "Never";
  return d.format("YYYY-MM-DD HH:mm:ss");
}

export function ago(v: string | number | undefined | null): string {
  if (v === undefined || v === null || v === "") return DASH;
  const d = dayjs(v);
  if (!d.isValid() || d.year() <= 1970) return "Never";
  return d.fromNow();
}

/** Compact relative time for tables: "just now", "5 min ago", "3 h ago", "2 d ago". */
export function agoShort(v: string | number | undefined | null): string {
  if (v === undefined || v === null || v === "") return DASH;
  const d = dayjs(v);
  if (!d.isValid() || d.year() <= 1970) return "Never";
  const s = Math.max(0, Math.round((Date.now() - d.valueOf()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 60) return `${Math.round(s / 86400)} d ago`;
  return d.format("D MMM YYYY");
}

/** "4 Sep 2026" */
export function dateShort(v: string | number | undefined | null): string {
  if (v === undefined || v === null || v === "") return DASH;
  const d = dayjs(v);
  return !d.isValid() || d.year() <= 1970 ? "Never" : d.format("D MMM YYYY");
}

export function isNever(v: string | undefined | null) {
  return !v || dayjs(v).year() <= 1970;
}

/** Human duration from milliseconds: "3d 4h 12m", "5m 10s". */
export function duration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return DASH;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** "4.38 Build 9760" style version from GetServerInfo. */
export function serverVersion(info: Record<string, any> | null | undefined): string | null {
  if (!info) return null;
  const v = String(info.ServerVersionString_str ?? "").replace(/\s*\(.*\)\s*$/, "");
  if (v) return v;
  const n = Number(info.ServerVerInt_u32 ?? 0);
  return n ? `${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")} Build ${info.ServerBuildInt_u32 ?? "?"}` : null;
}

/** Compact "4.44 (9807)" version for tables. */
export function serverVersionShort(info: Record<string, any> | null | undefined): string | null {
  if (!info) return null;
  const n = Number(info.ServerVerInt_u32 ?? 0);
  if (n) return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")} (${info.ServerBuildInt_u32 ?? "?"})`;
  const m = String(info.ServerVersionString_str ?? "").match(/Version\s+([\d.]+)\s+Build\s+(\d+)/i);
  return m ? `${m[1]} (${m[2]})` : serverVersion(info);
}

/** Total unicast+broadcast bytes of a GetServerStatus / hub status object. */
export function trafficOf(st: Record<string, any> | null | undefined, prefix = ""): { recv: number; send: number } {
  if (!st) return { recv: 0, send: 0 };
  const n = (k: string) => Number(st[`${prefix}${k}`] ?? 0);
  return {
    recv: n("Recv.UnicastBytes_u64") + n("Recv.BroadcastBytes_u64"),
    send: n("Send.UnicastBytes_u64") + n("Send.BroadcastBytes_u64"),
  };
}

/** Plural helper: plural(3, "hub") -> "3 hubs". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Base64 helpers for *_bin fields. */
export function b64ToText(b64: string | undefined): string {
  if (!b64) return "";
  const bin = atob(b64);
  const bytesArr = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytesArr).replace(/\0+$/, "");
}

export function textToB64(text: string): string {
  const bytesArr = new TextEncoder().encode(text);
  let bin = "";
  bytesArr.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

export async function fileToB64(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

const extOf = (name: string) => name.includes(".") ? name.split(".").pop()! : "";
const filterFor = (name: string): FileFilter[] | undefined => extOf(name) ? [{ name: extOf(name).toUpperCase(), extensions: [extOf(name)] }] : undefined;

/** Save text through the native Save dialog. (Web version triggered a browser download.) */
export function downloadText(filename: string, content: string, _mime = "text/plain") {
  return saveFile({ suggestedName: filename, content, encoding: "utf8", filters: filterFor(filename) });
}

/** Save base64 bytes through the native Save dialog. */
export function downloadB64(filename: string, b64: string, _mime = "application/octet-stream") {
  return saveFile({ suggestedName: filename, content: b64, encoding: "base64", filters: filterFor(filename) });
}

export function isIPv4(s: string) {
  return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s);
}

/** Uppercase hex without separators. */
export function normFp(fp: string | null | undefined): string {
  return (fp ?? "").replace(/[^0-9a-f]/gi, "").toUpperCase();
}

/** "AB:CD:…:EF" colon form of a fingerprint. */
export function colonFp(fp: string | null | undefined): string {
  return normFp(fp).match(/.{2}/g)?.join(":") ?? "";
}

/** Short "AB:CD:EF:01…12:34" form. */
export function shortFp(fp: string | null | undefined): string {
  const parts = colonFp(fp).split(":").filter(Boolean);
  if (!parts.length) return DASH;
  return parts.length <= 6 ? parts.join(":") : `${parts.slice(0, 4).join(":")}…${parts.slice(-2).join(":")}`;
}
