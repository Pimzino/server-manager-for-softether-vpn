// Shared E2E environment: two real SoftEther VPN Servers, a real SoftEther VPN Client (for .vpn
// verification) and a fresh SoftEther Manager backend, all on isolated ports/data dirs.
import path from "node:path";
import os from "node:os";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const SE_BUILD = process.env.SE_BUILD_DIR ?? path.join(os.homedir(), "se-build/src/build");
export const RUN_DIR = process.env.E2E_RUN_DIR ?? path.join(os.homedir(), "se-e2e");
export const ARTIFACTS = path.join(ROOT, "e2e/artifacts");

export const SERVERS = [
  { name: "e2e-alpha", port: 15601, dir: path.join(RUN_DIR, "alpha") },
  { name: "e2e-beta", port: 15602, dir: path.join(RUN_DIR, "beta") },
];
export const CLIENT_DIR = path.join(RUN_DIR, "client");
export const BACKEND_PORT = 18090;
export const BASE_URL = `http://127.0.0.1:${BACKEND_PORT}`;
export const BACKEND_DATA = path.join(RUN_DIR, "sem-data");
export const ADMIN = { username: "admin", password: "E2e-Adm1n-Passw0rd!" };
/** SoftEther server admin password the tests set on e2e-beta (e2e-alpha keeps an empty password). */
export const BETA_ADMIN_PASSWORD = "Beta-Srv-Pw-123";
