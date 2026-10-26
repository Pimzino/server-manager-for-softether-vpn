import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "./config.ts";

/** AES-256-GCM encryption of secrets at rest: `v1:iv:tag:ciphertext` (base64), keyed by the master key. */
export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.masterKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export function unseal(sealed: string): string {
  const [v, iv, tag, ct] = sealed.split(":");
  if (v !== "v1") throw new Error("Unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", config.masterKey, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
