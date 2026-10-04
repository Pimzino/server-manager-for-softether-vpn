// Errors shared by both transports (native PACK RPC and JSON-RPC).
import { errorText } from "@sem/api-catalog";

export class SoftEtherError extends Error {
  code: number;
  constructor(code: number, message?: string) {
    super(message && !/^Error code \d+/.test(message) ? message : errorText(code));
    this.code = code;
    this.name = "SoftEtherError";
  }
}

export class ConnectionError extends Error {
  kind: "tls-mismatch" | "tls" | "network" | "timeout" | "http" | "auth" | "protocol" | "api-disabled";
  presentedFingerprint?: string;
  constructor(kind: ConnectionError["kind"], message: string, presentedFingerprint?: string) {
    super(message);
    this.kind = kind;
    this.presentedFingerprint = presentedFingerprint;
    this.name = "ConnectionError";
  }
}

export function normalizeFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return hex.match(/.{2}/g)?.join(":") ?? "";
}
