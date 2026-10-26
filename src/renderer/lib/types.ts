// Shapes returned by the in-process API (see docs/desktop-architecture.md).

export type Transport = "native" | "jsonrpc";
export type TlsMode = "pin" | "ca" | "insecure";

export interface HubListItem {
  HubName_str: string;
  Online_bool: boolean;
  HubType_u32: number;
  NumUsers_u32: number;
  NumGroups_u32: number;
  NumSessions_u32: number;
  NumMacTables_u32: number;
  NumIpTables_u32: number;
  LastCommTime_dt: string;
  CreatedTime_dt: string;
  LastLoginTime_dt: string;
  NumLogin_u32: number;
  [k: string]: unknown;
}

export interface ServerState {
  checkedAt: number | null;
  ok: boolean | null;
  error: string | null;
  latencyMs: number | null;
  info: Record<string, any> | null;
  status: Record<string, any> | null;
  hubs: { HubList?: HubListItem[] } | null;
}

/** A saved connection setting (GET /api/servers/:id). */
export interface Server {
  id: number;
  name: string;
  host: string;
  port: number;
  /** Virtual Hub name when the connection is in hub-admin mode, else null. */
  hub: string | null;
  transport: Transport;
  tlsMode: TlsMode;
  fingerprint: string | null;
  hasCa?: boolean;
  /** The admin password is stored in the OS keychain (Keychain / DPAPI). */
  passwordSaved: boolean;
  /** A password is available for this session (saved, or entered via unlock). */
  unlocked: boolean;
  tags: string[];
  notes: string;
  enabled: boolean;
  createdAt?: number;
  updatedAt?: number;
  state: ServerState | null;
}

/** Body of POST /api/servers and PUT /api/servers/:id. */
export interface ServerInput {
  name: string;
  host: string;
  port: number;
  hub?: string | null;
  /** Empty on PUT keeps the stored password. */
  password: string;
  savePassword: boolean;
  transport: Transport;
  tlsMode: TlsMode;
  fingerprint?: string | null;
  caPem?: string | null;
  tags?: string[];
  notes?: string;
}

/** POST /api/servers/probe */
export interface ProbeResult {
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
  pem?: string;
}

/** POST /api/servers/test */
export interface TestResult {
  ok: boolean;
  info?: Record<string, any>;
  capsCount?: number | null;
  error?: string;
  kind?: ConnectionKind;
  presentedFingerprint?: string;
}

export type ConnectionKind = "tls-mismatch" | "tls" | "network" | "timeout" | "http" | "auth" | "protocol" | "api-disabled";

export interface FleetSummary {
  totals: { servers: number; online: number; offline: number; sessions: number; users: number; hubs: number; recvBytes: number; sendBytes: number };
  servers: Server[];
}

export interface BulkResult { serverId: number; serverName?: string; ok: boolean; result?: Record<string, unknown>; error?: string }

/** GET/PUT /api/settings */
export interface AppSettings {
  backup: { enabled: boolean; intervalHours: number; retention: number };
  poll: { intervalSec: number };
  deploy?: { packageRetentionDays: number };
}

export type FieldKind = "string" | "number" | "boolean" | "ip" | "datetime" | "binary" | "enum" | "array" | "object";
export interface CatalogField { name: string; kind: FieldKind; doc: string; items?: string; enum?: string; type?: string }
export interface CatalogType { name: string; doc: string; fields: CatalogField[] }
export interface CatalogEnum { name: string; values: { key: string; value: number; doc: string }[] }
export type Risk = "read" | "write" | "danger";
export interface MethodInfo {
  name: string; doc: string; input: string | null; output: string; area: string;
  risk: Risk; hubScoped: boolean;
}
export interface Catalog {
  methods: Record<string, MethodInfo>;
  types: Record<string, CatalogType>;
  enums: Record<string, CatalogEnum>;
  errors: Record<string, string>;
}
