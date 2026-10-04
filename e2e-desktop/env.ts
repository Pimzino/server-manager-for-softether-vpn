// Shared environment of the desktop E2E suite: two real SoftEther VPN Servers, a real SoftEther VPN Client
// (for .vpn import checks) and the real Server Manager for SoftEther VPN desktop app built into e2e-desktop/.build.
import path from "node:path";
import os from "node:os";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const WIN = process.platform === "win32";
/** Executable file name on this platform (SoftEther's Windows binaries end in .exe). */
export const exe = (name: string) => (WIN ? `${name}.exe` : name);
export const E2E_DIR = path.join(ROOT, "e2e-desktop");
export const BUILD_DIR = path.join(E2E_DIR, ".build");
export const ARTIFACTS = path.join(E2E_DIR, "artifacts");
export const SCREENSHOTS = path.join(ARTIFACTS, "screenshots");
export const OUTPUTS = path.join(ARTIFACTS, "outputs");
export const SE_BUILD = process.env.SE_BUILD_DIR ?? path.join(os.homedir(), "se-build/src/build");
export const RUN_DIR = process.env.E2E_DESK_RUN_DIR ?? path.join(os.homedir(), "se-desk-e2e");
/** Fresh per run (global setup wipes RUN_DIR). */
export const DATA_DIR = path.join(RUN_DIR, "sem-data");
export const STATE_FILE = path.join(RUN_DIR, "state.json");
export const CLIENT_DIR = path.join(RUN_DIR, "client");
export const CLIENT_PORT = 9931; // fixed by SoftEther VPN Client

/** Server A: native transport only (JSON-RPC API disabled in its config), empty admin password. */
export const SERVER_A = { key: "A", name: "Alpha (native)", port: 16101, dir: path.join(RUN_DIR, "alpha"), password: "" };
/** Server B: admin password set, JSON-RPC enabled. The password is changed by the operations spec (see state). */
export const SERVER_B = { key: "B", name: "Beta", port: 16102, dir: path.join(RUN_DIR, "beta"), password: "Desk-Beta-Pw-1" };
export const B_NEW_PASSWORD = "Desk-Beta-Pw-2!";
/** Hub on B administered by a hub-admin connection (hub password, not saved). */
export const TENANT = { hub: "TENANT", password: "Tenant-Hub-Pw-9", name: "Tenant hub admin" };
