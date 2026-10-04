// First-run setup: while no administrator has ever been created, the server is in "setup mode"
// and exposes a one-time bootstrap endpoint guarded by a setup token that is only available to
// whoever can read the server's log or data directory. Once the first admin exists the setup is
// permanently closed (recorded in settings, so it never reopens even if the user table changes).
import { existsSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { get, getSetting, setSetting } from "./db.ts";
import { randomToken, sha256Hex } from "./crypto.ts";

export const SETUP_TOKEN_FILE = path.join(config.dataDir, "setup-token.txt");

let tokenHash: string | null = null;

function userCount() {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n;
}

/** True once the first administrator has been created through first-run setup. */
export function setupCompleted(): boolean {
  if (getSetting<number | null>("setupCompletedAt", null) !== null) return true;
  // Installations created before the setup flow existed already have users
  if (userCount() > 0) {
    markSetupCompleted("pre-existing users");
    return true;
  }
  return false;
}

export function markSetupCompleted(how: string) {
  if (getSetting<number | null>("setupCompletedAt", null) === null) {
    setSetting("setupCompletedAt", Date.now());
    setSetting("setupCompletedBy", how);
  }
  tokenHash = null;
  rmSync(SETUP_TOKEN_FILE, { force: true });
}

/**
 * Enter setup mode if needed: generate (or reuse, across restarts) the one-time setup token,
 * store it in data/setup-token.txt (mode 600) and log it. Returns the token or null.
 */
export function initSetupMode(log: { warn: (m: string) => void }): string | null {
  if (setupCompleted()) {
    rmSync(SETUP_TOKEN_FILE, { force: true });
    return null;
  }
  let token = existsSync(SETUP_TOKEN_FILE) ? readFileSync(SETUP_TOKEN_FILE, "utf8").trim() : "";
  if (token.length < 32) {
    token = randomToken(24);
    writeFileSync(SETUP_TOKEN_FILE, token + "\n", { mode: 0o600 });
    try { chmodSync(SETUP_TOKEN_FILE, 0o600); } catch { /* filesystem without POSIX modes */ }
  }
  tokenHash = sha256Hex(token);
  log.warn(
    `First-run setup required: open the web UI and create the first administrator. ` +
    `Setup token: ${token} (also stored in ${SETUP_TOKEN_FILE}; it is deleted once setup completes)`,
  );
  return token;
}

export function checkSetupToken(candidate: string): boolean {
  if (!tokenHash || setupCompleted()) return false;
  const a = Buffer.from(sha256Hex(candidate.trim()), "hex");
  const b = Buffer.from(tokenHash, "hex");
  return timingSafeEqual(a, b);
}
