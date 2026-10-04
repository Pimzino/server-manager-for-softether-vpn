// Local SQLite store (node:sqlite). Fresh schema for the single-user desktop app: no users,
// sessions, API tokens, grants or audit log.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { config } from "./config.ts";

export type { SQLInputValue };

let handle: DatabaseSync | null = null;

function db(): DatabaseSync {
  if (!handle) throw new Error("Database used before initDb()");
  return handle;
}

const MIGRATIONS: string[] = [
  // 1: initial desktop schema
  `
  CREATE TABLE servers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 443,
    hub TEXT,                         -- set => hub-admin mode connection
    transport TEXT NOT NULL DEFAULT 'native' CHECK (transport IN ('native','jsonrpc')),
    password_saved INTEGER NOT NULL DEFAULT 0,
    password_sealed TEXT,             -- only when password_saved = 1
    tls_mode TEXT NOT NULL DEFAULT 'pin' CHECK (tls_mode IN ('pin','ca','insecure')),
    tls_fingerprint TEXT,             -- sha256 of the server certificate, colon-hex upper
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
    settings TEXT NOT NULL,           -- JSON profile definition, secrets sealed
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
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
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'msi',
    server_id INTEGER,
    hub TEXT,
    username TEXT,
    template_id INTEGER,
    file_name TEXT,
    product_code TEXT
  );
  CREATE INDEX builds_hub ON installer_builds(server_id, hub, username);
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
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

function migrate() {
  const d = db();
  d.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = d.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) d.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  while (version < MIGRATIONS.length) {
    d.exec("BEGIN");
    try {
      d.exec(MIGRATIONS[version]);
      version++;
      d.prepare("UPDATE schema_version SET version = ?").run(version);
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  }
}

export function initDb() {
  if (handle) return;
  handle = new DatabaseSync(config.dbFile);
  handle.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate();
}

export function closeDb() {
  if (!handle) return;
  try { handle.close(); } catch { /* already closed */ }
  handle = null;
}

export function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return db().prepare(sql).all(...params) as T[];
}
export function get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db().prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: SQLInputValue[]) {
  return db().prepare(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
  db().exec("BEGIN");
  try {
    const r = fn();
    db().exec("COMMIT");
    return r;
  } catch (e) {
    db().exec("ROLLBACK");
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
