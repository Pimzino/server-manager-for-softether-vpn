// Paths, tunables and the master key of the desktop app.
//
// Everything here is initialised lazily from main.ts (initPaths → after app "ready": initKeystore),
// because the userData path depends on the app name and safeStorage only works once the app is ready.
import { app, safeStorage } from "electron";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export type KeystoreMode = "safeStorage" | "plain";

interface Paths { dataDir: string; dbFile: string; filesDir: string; resourcesDir: string }
let paths: Paths | null = null;
let masterKey: Buffer | null = null;
let keystoreMode: KeystoreMode | null = null;

/**
 * Resolve the data directory: SEM_DATA_DIR (tests, portable use) or app.getPath("userData").
 * With SEM_DATA_DIR, Chromium's own profile data goes there too (so tests never touch the real
 * profile, and the single-instance lock is per data directory). Must run before app "ready".
 */
export function initPaths(): Paths {
  if (paths) return paths;
  const override = env("SEM_DATA_DIR");
  if (override) {
    mkdirSync(path.resolve(override), { recursive: true });
    app.setPath("userData", path.resolve(override));
  }
  const dataDir = path.resolve(override ?? app.getPath("userData"));
  mkdirSync(dataDir, { recursive: true });
  const filesDir = path.join(dataDir, "files");
  mkdirSync(filesDir, { recursive: true });
  paths = { dataDir, dbFile: path.join(dataDir, "sem.db"), filesDir, resourcesDir: resolveResourcesDir() };
  return paths;
}

/**
 * Read-only assets used by client deployment (setup.exe launcher stubs, default icon).
 * Packaged: electron-builder copies apps/desktop/resources to <resources>/resources (extraResources).
 * Development: apps/desktop/resources, relative to dist/main/main.mjs. SEM_RESOURCES_DIR overrides.
 */
function resolveResourcesDir(): string {
  const override = env("SEM_RESOURCES_DIR");
  if (override) return path.resolve(override);
  if (app.isPackaged) return path.join(process.resourcesPath, "resources");
  return path.resolve(import.meta.dirname, "../../resources");
}

function need<T>(v: T | null, what: string): T {
  if (v === null) throw new Error(`${what} used before initialisation`);
  return v;
}

function writeSecretFile(file: string, data: string | Buffer) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* filesystems without POSIX modes (exFAT, FAT) */ }
  renameSync(tmp, file);
}

/**
 * Load (or create) the 32-byte master key that seals stored secrets (saved server passwords,
 * profile credentials). It is itself sealed with Electron safeStorage (macOS Keychain / Windows
 * DPAPI / libsecret) in master.key.sealed. SEM_INSECURE_KEYSTORE=1, or no usable safeStorage,
 * falls back to a plain hex file (mode 600). Must run after app "ready".
 */
export function initKeystore(): KeystoreMode {
  if (keystoreMode) return keystoreMode;
  const { dataDir } = need(paths, "paths");
  const sealedFile = path.join(dataDir, "master.key.sealed");
  const plainFile = path.join(dataDir, "master.key");
  const insecure = env("SEM_INSECURE_KEYSTORE") === "1";
  let available = false;
  try { available = safeStorage.isEncryptionAvailable(); } catch { available = false; }
  // On Linux "basic_text" is an obfuscation with a hard-coded key: treat it as unavailable.
  if (available && process.platform === "linux") {
    try { if (safeStorage.getSelectedStorageBackend() === "basic_text") available = false; } catch { /* older API */ }
  }
  const decodeKey = (hex: string) => {
    const buf = Buffer.from(hex.trim(), "hex");
    if (buf.length !== 32) throw new Error("master key file is corrupt (expected 32 bytes)");
    return buf;
  };
  if (insecure || !available) {
    if (existsSync(plainFile)) masterKey = decodeKey(readFileSync(plainFile, "utf8"));
    else if (existsSync(sealedFile)) {
      if (!available) throw new Error("The master key is sealed with the OS keychain, which is not available");
      masterKey = decodeKey(safeStorage.decryptString(readFileSync(sealedFile)));
    } else {
      masterKey = randomBytes(32);
      writeSecretFile(plainFile, masterKey.toString("hex"));
    }
    keystoreMode = "plain";
  } else {
    if (existsSync(sealedFile)) {
      masterKey = decodeKey(safeStorage.decryptString(readFileSync(sealedFile)));
    } else {
      // First start, or migrating a data dir created in plain mode: seal the key.
      masterKey = existsSync(plainFile) ? decodeKey(readFileSync(plainFile, "utf8")) : randomBytes(32);
      writeSecretFile(sealedFile, safeStorage.encryptString(masterKey.toString("hex")));
      rmSync(plainFile, { force: true });
    }
    keystoreMode = "safeStorage";
  }
  return keystoreMode;
}

/** The OS user running the app: recorded as "created by" on backups, packages and builds. */
export function localActor(): string {
  try { return os.userInfo().username || "local"; } catch { return "local"; }
}

export const config = {
  get dataDir() { return need(paths, "paths").dataDir; },
  get dbFile() { return need(paths, "paths").dbFile; },
  get filesDir() { return need(paths, "paths").filesDir; },
  get resourcesDir() { return need(paths, "paths").resourcesDir; },
  get masterKey() { return need(masterKey, "master key"); },
  get keystoreMode() { return keystoreMode; },
  rpcTimeoutMs: Number(env("SEM_RPC_TIMEOUT_MS", "20000")),
  /** Defaults; the Settings page overrides them (settings table). */
  pollIntervalSec: Number(env("SEM_POLL_INTERVAL_SEC", "30")),
  backupIntervalHours: Number(env("SEM_BACKUP_INTERVAL_HOURS", "24")),
  backupRetention: Number(env("SEM_BACKUP_RETENTION", "30")),
};
