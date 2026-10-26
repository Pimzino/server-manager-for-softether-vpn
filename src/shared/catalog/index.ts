// SoftEther VPN Server JSON-RPC catalog: method metadata, types, enums, error texts,
// plus the management layer's classification (area, risk, scope) of every method.
import catalogJson from "./catalog.json" with { type: "json" };

export type FieldKind =
  | "string" | "number" | "boolean" | "ip" | "datetime" | "binary"
  | "enum" | "array" | "object";

export interface CatalogField {
  name: string;
  kind: FieldKind;
  doc: string;
  items?: string;
  enum?: string;
  type?: string;
}
export interface CatalogType { name: string; doc: string; fields: CatalogField[] }
export interface CatalogEnum { name: string; values: { key: string; value: number; doc: string }[] }
export interface CatalogMethod {
  name: string;
  doc: string;
  input: string | null;
  output: string;
  serverDeclared: boolean;
  dangerous?: boolean;
}

/** read: no state change. write: changes config. danger: disruptive or security-critical. */
export type Risk = "read" | "write" | "danger";

export interface MethodInfo extends CatalogMethod {
  area: Area;
  risk: Risk;
  /** Method operates on a single Virtual Hub (takes HubName_str) */
  hubScoped: boolean;
}

export type Area =
  | "server" | "listener" | "cluster" | "certificate" | "hub" | "user" | "group"
  | "access" | "session" | "cascade" | "securenat" | "bridge" | "l3switch"
  | "log" | "config" | "ipsec" | "protocols" | "ddns" | "wireguard"
  | "license" | "security" | "diagnostics";

interface RawCatalog {
  serverMethods: string[];
  methods: Record<string, CatalogMethod>;
  types: Record<string, CatalogType>;
  enums: Record<string, CatalogEnum>;
  errors: Record<string, string>;
}
const raw = catalogJson as unknown as RawCatalog;

const DANGER = new Set([
  "SetServerPassword", "SetFarmSetting", "SetServerCert", "RegenerateServerCert",
  "RebootServer", "SetConfig", "Crash", "Debug", "DeleteHub", "Flush",
  "SetServerCipher", "DeleteListener", "SetPortsUDP", "SetSpecialListener",
  "AddLicenseKey", "DelLicenseKey", "SetEnableEthVLan",
  // Reads that disclose every secret on the server (full config incl. password hashes and keys)
  "GetConfig",
  // Protocol keys (WireGuard private key/PSK) and the server administrator's limits on a hub
  "SetProtoOptions", "SetHubAdminOptions", "SetHubExtOptions",
]);

const AREA_RULES: [RegExp, Area][] = [
  [/^(Test|GetServerInfo|GetServerStatus|GetCaps|RebootServer|SetKeep|GetKeep|GetAdminMsg|Flush|GetDefaultHubAdminOptions)$/, "server"],
  [/Listener|PortsUDP/, "listener"],
  [/Farm/, "cluster"],
  [/ServerCert|ServerCipher|RegenerateServerCert/, "certificate"],
  [/^(Create|Set|Get|Enum|Delete)Hub$|HubOnline|HubStatus|HubAdminOptions|HubExtOptions|HubMsg|HubRadius|HubLog|^(Add|Enum|Get|Delete)Ca$|Crl$|AcList/, "hub"],
  [/User$/, "user"],
  [/Group$/, "group"],
  [/Access/, "access"],
  [/Session|Connection|MacTable|IpTable/, "session"],
  [/Link/, "cascade"],
  [/SecureNAT|EnumNAT|EnumDHCP/, "securenat"],
  [/Bridge|EnumEthernet|EthVLan/, "bridge"],
  [/L3/, "l3switch"],
  [/Log|SysLog/, "log"],
  [/Config$/, "config"],
  [/IPsec|EtherIp/, "ipsec"],
  [/OpenVpn|Sstp|ProtoOptions|SpecialListener/, "protocols"],
  [/DDns|Azure|Vgs/, "ddns"],
  [/Wgk/, "wireguard"],
  [/License/, "license"],
  [/ServerPassword/, "security"],
  [/Crash|Debug/, "diagnostics"],
];

function classifyArea(name: string): Area {
  if (name === "SetServerPassword") return "security";
  if (name === "GetConfig" || name === "SetConfig") return "config";
  if (name.includes("OpenVpnSstp")) return "protocols";
  for (const [re, area] of AREA_RULES) if (re.test(name)) return area;
  return "server";
}

function classifyRisk(m: CatalogMethod): Risk {
  if (DANGER.has(m.name) || m.dangerous) return "danger";
  if (/^(Get|Enum|Test|Read|MakeOpenVpnConfigFile)/.test(m.name)) {
    // A few Get* calls have side effects on the wire but not on config; still read.
    return "read";
  }
  return "write";
}

export const types = raw.types;
export const enums = raw.enums;
export const errors: Record<number, string> = Object.fromEntries(
  Object.entries(raw.errors).map(([k, v]) => [Number(k), v]),
);

const HUB_FIELDS = ["HubName_str", "HubName_Ex_str", "RpcHubName_str"];
/** Methods that carry a hub name but are server-level operations */
const NOT_HUB_SCOPED = new Set([
  "CreateHub", "EnumHub", "AddL3If", "DelL3If", "AddEtherIpId", "DeleteEtherIpId", "GetEtherIpId",
  "GetDefaultHubAdminOptions",
]);

/** The input field that names the Virtual Hub for a hub-scoped method */
export function hubFieldOf(method: string): string | null {
  const m = raw.methods[method];
  const t = m?.input ? raw.types[m.input] : undefined;
  return t?.fields.find((f) => HUB_FIELDS.includes(f.name))?.name ?? null;
}

export const methods: Record<string, MethodInfo> = Object.fromEntries(
  Object.values(raw.methods)
    .filter((m) => m.serverDeclared)
    .map((m) => [m.name, {
      ...m,
      area: classifyArea(m.name),
      risk: classifyRisk(m),
      hubScoped: hubFieldOf(m.name) !== null && !NOT_HUB_SCOPED.has(m.name),
    }]),
);

export function errorText(code: number): string {
  return errors[code] ?? `SoftEther error ${code}`;
}

export const catalog = { methods, types, enums, errors };
export default catalog;
