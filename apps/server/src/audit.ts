import { run } from "./db.ts";

export interface AuditEntry {
  userId?: number | null;
  username?: string | null;
  ip?: string | null;
  action: string;
  serverId?: number | null;
  serverName?: string | null;
  hub?: string | null;
  target?: string | null;
  details?: unknown;
  success: boolean;
  error?: string | null;
}

const SECRET_KEY = /pass|secret|key|token|cert_bin|privatekey|psk|hashedpassword|ntlmsecure|sharedkey/i;

const SECRET_OPTION_NAME = /key|secret|password|psk|mask/i;

/** Replace secret-looking values (passwords, private keys, PSKs) before persisting. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth]";
  // Protocol options are parallel arrays (Name_str[] / Value_bin[]): redact by option name
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (Array.isArray(o.Name_str) && Array.isArray(o.Value_bin)) {
      const values = (o.Value_bin as unknown[]).map((v, i) =>
        typeof (o.Name_str as unknown[])[i] === "string" && SECRET_OPTION_NAME.test((o.Name_str as string[])[i]) && v ? "[redacted]" : v);
      value = { ...o, Value_bin: values };
    }
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && !/^(Use|Is|Enable|Check|Num)/.test(k) && typeof v !== "boolean" && typeof v !== "number") {
        out[k] = v === "" || v == null ? v : "[redacted]";
      } else if (typeof v === "string" && v.length > 4096) {
        out[k] = `[${v.length} chars]`;
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function audit(e: AuditEntry) {
  run(
    `INSERT INTO audit_log (ts, user_id, username, ip, action, server_id, server_name, hub, target, details, success, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    Date.now(), e.userId ?? null, e.username ?? null, e.ip ?? null, e.action,
    e.serverId ?? null, e.serverName ?? null, e.hub ?? null, e.target ?? null,
    e.details === undefined ? null : JSON.stringify(redact(e.details)),
    e.success ? 1 : 0, e.error ?? null,
  );
}
