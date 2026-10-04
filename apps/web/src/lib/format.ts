import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

dayjs.extend(relativeTime);

export function bytes(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return "–";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function num(n: number | undefined | null): string {
  return n === undefined || n === null ? "–" : n.toLocaleString();
}

/** SoftEther datetimes are ISO strings; the zero date (1970) means "never". */
export function dt(v: string | number | undefined | null): string {
  if (v === undefined || v === null || v === "") return "–";
  const d = dayjs(v);
  if (!d.isValid() || d.year() <= 1970) return "Never";
  return d.format("YYYY-MM-DD HH:mm:ss");
}

export function ago(v: string | number | undefined | null): string {
  if (v === undefined || v === null || v === "") return "–";
  const d = dayjs(v);
  if (!d.isValid() || d.year() <= 1970) return "Never";
  return d.fromNow();
}

export function isNever(v: string | undefined | null) {
  return !v || dayjs(v).year() <= 1970;
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

export async function fileToB64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function downloadText(filename: string, content: string, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadB64(filename: string, b64: string, mime = "application/octet-stream") {
  const bin = atob(b64);
  const arr = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([arr], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Convert a /24-style prefix or dotted mask. */
export function isIPv4(s: string) {
  return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(s);
}
