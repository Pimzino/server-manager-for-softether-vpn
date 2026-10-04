// Break-glass administration from a shell on the management host (no web access needed).
//   node src/cli.ts reset-admin <username>   reset an EXISTING user to admin with a new one-time password
// It never creates accounts: the first administrator can only be created through first-run setup.
//   node src/cli.ts status                   show whether first-run setup is still open
// Run it as the service user with the same SEM_* environment so it opens the same database.
import { get, run } from "./db.ts";
import { hashPassword, randomToken } from "./crypto.ts";
import { audit } from "./audit.ts";
import { setupCompleted, SETUP_TOKEN_FILE } from "./setup.ts";

const [cmd, arg] = process.argv.slice(2);

if (cmd === "status") {
  console.log(setupCompleted() ? "Setup completed." : `Setup open. Token file: ${SETUP_TOKEN_FILE}`);
} else if (cmd === "reset-admin" && arg) {
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(arg)) throw new Error("Invalid username");
  const password = randomToken(15);
  const hash = await hashPassword(password);
  const existing = get<{ id: number }>("SELECT id FROM users WHERE username = ?", arg);
  if (!existing) {
    console.error(setupCompleted()
      ? `No user '${arg}'. reset-admin only resets existing accounts.`
      : `No users yet: complete first-run setup in the web UI (token file: ${SETUP_TOKEN_FILE}).`);
    process.exit(1);
  }
  run(`UPDATE users SET password_hash = ?, role = 'admin', disabled = 0, must_change_password = 1, failed_logins = 0,
       locked_until = NULL, totp_secret = NULL, totp_last_step = NULL WHERE id = ?`, hash, existing.id);
  run("DELETE FROM sessions WHERE user_id = ?", existing.id);
  run("DELETE FROM api_tokens WHERE user_id = ?", existing.id);
  audit({ username: arg, action: "cli.reset_admin", success: true });
  console.log(`Admin '${arg}' reset. One-time password (change at first sign-in; MFA cleared):\n${password}`);
} else {
  console.log("usage: node src/cli.ts status | reset-admin <username>");
  process.exitCode = 1;
}
