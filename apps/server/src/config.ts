import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

const dataDir = path.resolve(env("SEM_DATA_DIR", path.resolve(import.meta.dirname, "../../../data"))!);
mkdirSync(dataDir, { recursive: true });

/**
 * Master key used to encrypt stored secrets (SoftEther admin passwords, TOTP secrets).
 * Provide SEM_MASTER_KEY (64 hex chars) in production, typically from a secrets manager;
 * otherwise a key file is generated inside the data directory on first start.
 */
function loadMasterKey(): Buffer {
  const fromEnv = env("SEM_MASTER_KEY");
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, "hex");
    if (buf.length !== 32) throw new Error("SEM_MASTER_KEY must be 64 hex characters (32 bytes)");
    return buf;
  }
  const keyFile = path.join(dataDir, "master.key");
  if (!existsSync(keyFile)) {
    writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
    try { chmodSync(keyFile, 0o600); } catch { /* filesystems without POSIX modes */ }
  }
  return Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
}

function parseTrustProxy(v: string | undefined): string[] | false {
  if (!v || v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return ["127.0.0.1", "::1"];
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

export const config = {
  host: env("SEM_HOST", "127.0.0.1")!,
  port: Number(env("SEM_PORT", "8443")),
  dataDir,
  dbFile: path.join(dataDir, "sem.db"),
  filesDir: path.join(dataDir, "files"),
  masterKey: loadMasterKey(),
  /** PEM files for serving the management UI over HTTPS. If absent, a self-signed pair is generated. */
  tlsCert: env("SEM_TLS_CERT"),
  tlsKey: env("SEM_TLS_KEY"),
  /** Set SEM_HTTP=1 to serve plain HTTP (only behind a TLS-terminating reverse proxy). */
  plainHttp: env("SEM_HTTP") === "1",
  /**
   * Reverse-proxy trust. Never "trust everything" (the client controls the left-most
   * X-Forwarded-For entry) and no hop counts (Fastify 5 disallows them): a comma-separated list of
   * proxy addresses/CIDRs, e.g. "10.0.0.5,10.0.1.0/24". "1" means a proxy on this host (loopback).
   */
  trustProxy: parseTrustProxy(env("SEM_TRUST_PROXY")),
  sessionTtlHours: Number(env("SEM_SESSION_TTL_HOURS", "12")),
  sessionIdleMinutes: Number(env("SEM_SESSION_IDLE_MINUTES", "60")),
  /** Login / MFA attempts per minute per client IP. */
  loginRateLimit: Number(env("SEM_LOGIN_RATE_LIMIT", "10")),
  rpcTimeoutMs: Number(env("SEM_RPC_TIMEOUT_MS", "20000")),
  pollIntervalSec: Number(env("SEM_POLL_INTERVAL_SEC", "30")),
  backupIntervalHours: Number(env("SEM_BACKUP_INTERVAL_HOURS", "24")),
  backupRetention: Number(env("SEM_BACKUP_RETENTION", "30")),
  auditRetentionDays: Number(env("SEM_AUDIT_RETENTION_DAYS", "365")),
  wixlPath: env("SEM_WIXL", "wixl")!,
  webDist: path.resolve(import.meta.dirname, "../../web/dist"),
  logLevel: env("SEM_LOG_LEVEL", "info")!,
};

mkdirSync(config.filesDir, { recursive: true });
