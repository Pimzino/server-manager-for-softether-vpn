// Native Open-dialog helpers for files the renderer parses itself (certificates, keys, CSV, binary *_bin values).
// They replace the web product's <FileInput>/<FileButton> + File.arrayBuffer() pattern: nothing here uses
// <input type=file>. Every helper resolves null when the user cancels the dialog.
import type { FileFilter } from "../../../shared/ipc";
import { openFile } from "../../lib/api";
import { b64ToBytes, bytesToB64, certBytesToDerB64 } from "./util";

export const CERT_FILTERS: FileFilter[] = [{ name: "Certificates", extensions: ["cer", "crt", "pem", "der"] }, { name: "All Files", extensions: ["*"] }];
export const KEY_FILTERS: FileFilter[] = [{ name: "Private Keys", extensions: ["key", "pem", "der"] }, { name: "All Files", extensions: ["*"] }];
export const CSV_FILTERS: FileFilter[] = [{ name: "CSV", extensions: ["csv", "txt"] }, { name: "All Files", extensions: ["*"] }];

/** Pick any file and return its raw bytes. */
export async function openBytes(opts: { filters?: FileFilter[]; title?: string } = {}): Promise<{ name: string; bytes: Uint8Array } | null> {
  const f = await openFile({ ...opts, encoding: "base64" });
  return f ? { name: f.name, bytes: b64ToBytes(f.content) } : null;
}

/** Pick a file and return it as base64 (the web product's fileToB64(File)). */
export async function openB64(opts: { filters?: FileFilter[]; title?: string } = {}): Promise<{ name: string; b64: string } | null> {
  const f = await openFile({ ...opts, encoding: "base64" });
  return f ? { name: f.name, b64: f.content.replace(/\s+/g, "") } : null;
}

/** Pick a text file (CSV imports, PEM text). */
export async function openText(opts: { filters?: FileFilter[]; title?: string } = {}): Promise<{ name: string; text: string } | null> {
  const f = await openFile({ ...opts, encoding: "utf8" });
  return f ? { name: f.name, text: f.content } : null;
}

/**
 * Pick a certificate or private key and return the DER base64 SoftEther expects (PEM is unwrapped).
 * Throws with a readable message for encrypted keys or files without the right PEM block.
 * Replaces the web's `await certFileToDerB64(file, kind)`.
 */
export async function pickCertDerB64(kind: "cert" | "key", title?: string): Promise<{ name: string; derB64: string } | null> {
  const f = await openBytes({ filters: kind === "cert" ? CERT_FILTERS : KEY_FILTERS, title: title ?? (kind === "cert" ? "Choose a Certificate" : "Choose a Private Key") });
  return f ? { name: f.name, derB64: certBytesToDerB64(f.bytes, kind) } : null;
}

/**
 * Certificate / key bytes as PEM text. Binary DER (.cer/.der) is wrapped in a PEM envelope so PEM parsers
 * (the deployment backend) accept it. Replaces deploy/shared's fileToPem(File, kind).
 */
export function bytesToPem(bytes: Uint8Array, kind: "CERTIFICATE" | "PRIVATE KEY"): string {
  const text = new TextDecoder().decode(bytes);
  if (text.includes("-----BEGIN")) return text.trim() + "\n";
  const b64 = bytesToB64(bytes).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${kind}-----\n${b64}\n-----END ${kind}-----\n`;
}

/** Pick a certificate or key file and return it as PEM text. */
export async function pickPemFile(kind: "CERTIFICATE" | "PRIVATE KEY", title?: string): Promise<{ name: string; pem: string } | null> {
  const f = await openBytes({ filters: kind === "CERTIFICATE" ? CERT_FILTERS : KEY_FILTERS, title: title ?? (kind === "CERTIFICATE" ? "Choose a Certificate" : "Choose a Private Key") });
  return f ? { name: f.name, pem: bytesToPem(f.bytes, kind) } : null;
}
