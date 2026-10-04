export type Role = "admin" | "operator" | "viewer" | "none";

export interface User {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: Role;
  disabled: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt: number | null;
  createdAt: number;
  lockedUntil: number | null;
}

export interface Grant { id: number; serverId: number | null; serverName: string | null; hub: string | null; role: Exclude<Role, "none"> }
export interface UserWithGrants extends User { grants: Grant[] }

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

export interface Server {
  id: number;
  name: string;
  host: string;
  port: number;
  hub: string | null;
  tlsMode: "pin" | "ca" | "insecure";
  tlsFingerprint: string | null;
  hasCa: boolean;
  tags: string[];
  notes: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  state: ServerState | null;
  myRole: Role;
  visibleHubs: string[] | null;
  /** Roles granted on individual hubs (hub name -> role) */
  hubRoles?: Record<string, Role>;
}

export type FieldKind = "string" | "number" | "boolean" | "ip" | "datetime" | "binary" | "enum" | "array" | "object";
export interface CatalogField { name: string; kind: FieldKind; doc: string; items?: string; enum?: string; type?: string }
export interface CatalogType { name: string; doc: string; fields: CatalogField[] }
export interface CatalogEnum { name: string; values: { key: string; value: number; doc: string }[] }
export interface MethodInfo {
  name: string; doc: string; input: string | null; output: string; area: string;
  risk: "read" | "write" | "danger"; hubScoped: boolean;
}
export interface Catalog {
  methods: Record<string, MethodInfo>;
  types: Record<string, CatalogType>;
  enums: Record<string, CatalogEnum>;
  errors: Record<string, string>;
}
