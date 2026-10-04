import { getSetting } from "./db.ts";

export interface PasswordPolicy { minLength: number; requireMixed: boolean }

export function passwordPolicy(): PasswordPolicy {
  return getSetting<PasswordPolicy>("passwordPolicy", { minLength: 12, requireMixed: true });
}

/** Returns an error message, or null when the password satisfies the policy. */
export function validatePasswordPolicy(pw: string, username: string): string | null {
  const p = passwordPolicy();
  if (pw.length < p.minLength) return `Password must be at least ${p.minLength} characters`;
  if (pw.length > 512) return "Password is too long";
  if (pw.toLowerCase().includes(username.toLowerCase())) return "Password must not contain the username";
  if (p.requireMixed) {
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
    if (classes < 3) return "Password must contain at least three of: lowercase, uppercase, digits, symbols";
  }
  return null;
}
