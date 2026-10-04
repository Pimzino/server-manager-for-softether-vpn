import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config.ts";

export type { SQLInputValue };

export const db = new DatabaseSync(config.dbFile);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer','none')),
    disabled INTEGER NOT NULL DEFAULT 0,
    totp_secret TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    last_login_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT, user_agent TEXT,
    mfa_pending INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER
  );
  CREATE TABLE servers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 443,
    hub TEXT,                         -- set => hub-admin mode connection
    password_sealed TEXT NOT NULL,
    tls_mode TEXT NOT NULL DEFAULT 'pin' CHECK (tls_mode IN ('pin','ca','insecure')),
    tls_fingerprint TEXT,             -- sha256 of server cert, colon-hex upper
    ca_pem TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE server_state (
    server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    checked_at INTEGER,
    ok INTEGER,
    error TEXT,
    latency_ms INTEGER,
    info TEXT,        -- JSON GetServerInfo
    status TEXT,      -- JSON GetServerStatus
    hubs TEXT         -- JSON EnumHub
  );
  CREATE TABLE grants (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,  -- NULL = all servers
    hub TEXT,                                                     -- NULL = all hubs
    role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer'))
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT,
    ip TEXT,
    action TEXT NOT NULL,
    server_id INTEGER,
    server_name TEXT,
    hub TEXT,
    target TEXT,
    details TEXT,
    success INTEGER NOT NULL,
    error TEXT
  );
  CREATE INDEX audit_ts ON audit_log(ts);
  CREATE TABLE config_backups (
    id INTEGER PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL
  );
  CREATE INDEX backups_server ON config_backups(server_id, created_at);
  CREATE TABLE client_packages (
    id INTEGER PRIMARY KEY,
    filename TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    arch TEXT NOT NULL DEFAULT 'x64',
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_path TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'upload',
    uploaded_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE profiles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL,           -- JSON profile definition
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE installer_builds (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    product_version TEXT NOT NULL,
    upgrade_code TEXT NOT NULL,
    package_id INTEGER REFERENCES client_packages(id) ON DELETE SET NULL,
    profile_ids TEXT NOT NULL,        -- JSON array
    options TEXT NOT NULL,            -- JSON
    stored_path TEXT,
    sha256 TEXT,
    size INTEGER,
    status TEXT NOT NULL,
    log TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: MFA hardening — per-session attempt counter, pending enrolment secret, TOTP replay protection
  `
  ALTER TABLE sessions ADD COLUMN mfa_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN pending_totp TEXT;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
  `,
  // 3: deployment templates, live per-hub profiles, per-user packages
  `
  CREATE TABLE deploy_templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL,           -- JSON (templateSchema); secrets sealed
    is_default INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE hub_profiles (
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    hub TEXT NOT NULL COLLATE NOCASE,
    template_id INTEGER REFERENCES deploy_templates(id) ON DELETE SET NULL,
    public_host TEXT,
    public_port INTEGER,
    account_name TEXT,
    upgrade_code TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, hub)
  );
  ALTER TABLE installer_builds ADD COLUMN kind TEXT NOT NULL DEFAULT 'msi';
  ALTER TABLE installer_builds ADD COLUMN server_id INTEGER;
  ALTER TABLE installer_builds ADD COLUMN hub TEXT;
  ALTER TABLE installer_builds ADD COLUMN username TEXT;
  ALTER TABLE installer_builds ADD COLUMN template_id INTEGER;
  ALTER TABLE installer_builds ADD COLUMN file_name TEXT;
  ALTER TABLE installer_builds ADD COLUMN product_code TEXT;
  CREATE INDEX builds_hub ON installer_builds(server_id, hub, username);
  `,
];

function migrate() {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]);
      version++;
      db.prepare("UPDATE schema_version SET version = ?").run(version);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
migrate();

export function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: SQLInputValue[]) {
  return db.prepare(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getSetting<T>(key: string, fallback: T): T {
  const r = get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  return r ? (JSON.parse(r.value) as T) : fallback;
}
export function setSetting(key: string, value: unknown) {
  run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
}
