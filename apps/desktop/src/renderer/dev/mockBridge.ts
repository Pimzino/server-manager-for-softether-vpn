// Development-only fake of window.sem, installed by main.tsx when the renderer runs in a plain browser
// (vite dev server, Playwright screenshots). Never bundled in production (guarded by import.meta.env.DEV).
//
// URL switches:  ?empty=1  no saved connections (first-run screen)
//                ?platform=win32  pretend to be Windows (caption-button inset, Segoe UI)
//                ?slow=1  800 ms latency on every call
// window.__semMenu("new-server") simulates a native menu action.
import { methods, types, enums, errors } from "@sem/api-catalog";
import type { ApiRequest, ApiResponse, AppInfo, SemBridge } from "../../shared/ipc";
import type { AppSettings, HubListItem, Server } from "../lib/types";

const params = new URLSearchParams(location.search);
const delay = params.has("slow") ? 800 : 120;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

function fp(seed: string): string {
  let h = 2166136261;
  const out: string[] = [];
  for (let i = 0; i < 32; i++) {
    for (const c of seed + i) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    out.push(((h >>> 0) & 255).toString(16).padStart(2, "0").toUpperCase());
  }
  return out.join(":");
}

function hub(name: string, sessions: number, users: number, online = true, extra: Partial<HubListItem> = {}): HubListItem {
  const rx = sessions * 1_300_000_000 + users * 11_000_000;
  return {
    HubName_str: name, Online_bool: online, HubType_u32: 0, NumUsers_u32: users, NumGroups_u32: Math.ceil(users / 12), NumSessions_u32: sessions,
    NumMacTables_u32: sessions * 2, NumIpTables_u32: sessions * 3, LastCommTime_dt: iso(sessions ? 20_000 : 3 * DAY), CreatedTime_dt: iso(400 * DAY),
    LastLoginTime_dt: iso(sessions ? 5 * MIN : 3 * DAY), NumLogin_u32: users * 37,
    "Ex.Recv.UnicastBytes_u64": rx, "Ex.Recv.BroadcastBytes_u64": rx / 40, "Ex.Send.UnicastBytes_u64": rx * 0.38, "Ex.Send.BroadcastBytes_u64": rx / 90,
    ...extra,
  };
}

function info(ver: string, build: number, host: string, os: string) {
  return {
    ServerProductName_str: "SoftEther VPN Server (64 bit)", ServerVersionString_str: `Version ${ver} Build ${build}   (English)`,
    ServerBuildInfoString_str: `Compiled 2025/10/12 11:01:22 by buildsan at crosscompiler`, ServerVerInt_u32: Math.round(Number(ver) * 100), ServerBuildInt_u32: build,
    ServerHostName_str: host, ServerType_u32: 0, ServerBuildDate_dt: "2025-10-12T02:01:22.000Z", ServerFamilyName_str: "",
    OsType_u32: 3100, OsServicePack_u32: 0, OsSystemName_str: "Linux", OsProductName_str: os, OsVendorName_str: "Unknown Vendor",
    OsVersion_str: "", KernelName_str: "Linux Kernel", KernelVersion_str: "6.8.0-45-generic",
  };
}

function status(hubs: HubListItem[], started: number, mem: number) {
  const sessions = hubs.reduce((a, h) => a + h.NumSessions_u32, 0);
  const users = hubs.reduce((a, h) => a + h.NumUsers_u32, 0);
  const sum = (k: string) => hubs.reduce((a, h) => a + Number(h[k] ?? 0), 0);
  return {
    ServerType_u32: 0, NumTcpConnections_u32: sessions * 2 + 3, NumTcpConnectionsLocal_u32: sessions * 2 + 3, NumTcpConnectionsRemote_u32: 0,
    NumHubTotal_u32: hubs.length, NumHubStandalone_u32: hubs.length, NumHubStatic_u32: 0, NumHubDynamic_u32: 0,
    NumSessionsTotal_u32: sessions, NumSessionsLocal_u32: sessions, NumSessionsRemote_u32: 0,
    NumMacTables_u32: sessions * 2, NumIpTables_u32: sessions * 3, NumUsers_u32: users, NumGroups_u32: hubs.reduce((a, h) => a + h.NumGroups_u32, 0),
    AssignedBridgeLicenses_u32: 0, AssignedClientLicenses_u32: 0, AssignedBridgeLicensesTotal_u32: 0, AssignedClientLicensesTotal_u32: 0,
    "Recv.BroadcastBytes_u64": sum("Ex.Recv.BroadcastBytes_u64"), "Recv.BroadcastCount_u64": 1_204_551, "Recv.UnicastBytes_u64": sum("Ex.Recv.UnicastBytes_u64"), "Recv.UnicastCount_u64": 88_120_402,
    "Send.BroadcastBytes_u64": sum("Ex.Send.BroadcastBytes_u64"), "Send.BroadcastCount_u64": 402_991, "Send.UnicastBytes_u64": sum("Ex.Send.UnicastBytes_u64"), "Send.UnicastCount_u64": 61_002_314,
    CurrentTime_dt: new Date().toISOString(), CurrentTick_u64: 912_334_556, StartTime_dt: iso(started),
    TotalMemory_u64: 12 * 2 ** 30, UsedMemory_u64: mem * 1.4, FreeMemory_u64: 12 * 2 ** 30 - mem * 1.4,
    TotalPhys_u64: 8 * 2 ** 30, UsedPhys_u64: mem, FreePhys_u64: 8 * 2 ** 30 - mem,
  };
}

interface MockServer extends Server { password: string; mockInfo?: Record<string, any>; mockHubs: HubListItem[]; started: number; mem: number; offlineError?: string }

const tokyoHubs = [hub("DEFAULT", 18, 64), hub("SALES", 12, 41), hub("ENGINEERING", 9, 37), hub("GUEST", 0, 5, false)];
const fraHubs = [hub("VPN", 20, 88), hub("PARTNERS", 3, 14), hub("MONITORING", 1, 2)];
const branchHubs = [hub("BRANCH", 6, 19)];

let servers: MockServer[] = params.has("empty") ? [] : [
  {
    id: 1, name: "Tokyo HQ", host: "vpn-tokyo.example.net", port: 443, hub: null, transport: "native", tlsMode: "pin", fingerprint: fp("tokyo"),
    passwordSaved: true, unlocked: true, tags: ["production", "apac"], notes: "Main office concentrator.", enabled: true, password: "x",
    mockInfo: info("4.44", 9807, "vpn-tokyo", "Ubuntu 24.04.1 LTS"), mockHubs: tokyoHubs, started: 23 * DAY + 4 * HOUR, mem: 1.9 * 2 ** 30, state: null,
  },
  {
    id: 2, name: "Frankfurt Edge", host: "fra-edge.example.net", port: 5555, hub: null, transport: "native", tlsMode: "pin", fingerprint: fp("fra"),
    passwordSaved: true, unlocked: true, tags: ["production", "eu"], notes: "", enabled: true, password: "x",
    mockInfo: info("5.02", 5185, "fra-edge-01", "Debian GNU/Linux 12"), mockHubs: fraHubs, started: 6 * DAY + 13 * HOUR, mem: 3.1 * 2 ** 30, state: null,
  },
  {
    id: 3, name: "Lab Raspberry Pi", host: "192.168.1.40", port: 992, hub: null, transport: "jsonrpc", tlsMode: "insecure", fingerprint: null,
    passwordSaved: true, unlocked: true, tags: ["lab"], notes: "", enabled: true, password: "x", mockHubs: [], started: 0, mem: 0, state: null,
    offlineError: "Couldn’t connect to 192.168.1.40:992 (ECONNREFUSED). Check that the VPN Server is running and the port is open.",
  },
  {
    id: 4, name: "Acme Corp", host: "acme-vpn.example.com", port: 443, hub: null, transport: "native", tlsMode: "pin", fingerprint: fp("acme"),
    passwordSaved: false, unlocked: false, tags: ["customer"], notes: "Customer-managed. Password in the shared vault.", enabled: true, password: "acme",
    mockInfo: info("4.43", 9799, "acme-gw", "Windows Server 2022"), mockHubs: [hub("ACME", 7, 22), hub("ACME-GUEST", 0, 3)], started: 41 * DAY, mem: 1.2 * 2 ** 30, state: null,
  },
  {
    id: 5, name: "Branch Office", host: "branch.example.org", port: 443, hub: "BRANCH", transport: "native", tlsMode: "pin", fingerprint: fp("branch"),
    passwordSaved: true, unlocked: true, tags: [], notes: "", enabled: true, password: "x",
    mockInfo: info("4.44", 9807, "branch-gw", "Ubuntu 22.04.4 LTS"), mockHubs: branchHubs, started: 2 * DAY, mem: 0.6 * 2 ** 30, state: null,
  },
];
let nextId = 6;
let settings: AppSettings = { backup: { enabled: true, intervalHours: 24, retention: 30 }, poll: { intervalSec: 30 }, deploy: { packageRetentionDays: 14 } };

const locked = (s: MockServer) => !s.passwordSaved && !s.unlocked;

function stateOf(s: MockServer): Server["state"] {
  if (locked(s)) return null;
  if (s.offlineError) return { checkedAt: now - 40_000, ok: false, error: s.offlineError, latencyMs: null, info: null, status: null, hubs: null };
  return {
    checkedAt: Date.now() - 8_000, ok: true, error: null, latencyMs: s.id * 17 + 9,
    info: s.mockInfo ?? null, status: s.hub ? null : status(s.mockHubs, s.started, s.mem), hubs: { HubList: s.mockHubs },
  };
}

function pub(s: MockServer): Server {
  const { password: _p, mockInfo: _i, mockHubs: _h, started: _s, mem: _m, offlineError: _o, ...rest } = s;
  return { ...rest, hasCa: s.tlsMode === "ca", createdAt: now - 90 * DAY, updatedAt: now - DAY, state: stateOf(s) };
}

const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ApiResponse => ({ status, body: { error, ...extra } });

function sessions(s: MockServer, hubName: string) {
  const h = s.mockHubs.find((x) => x.HubName_str === hubName);
  const names = ["akira", "yuki", "sato", "m.tanaka", "kenji", "hana", "ops-bridge", "laptop-042", "printer-gw", "r.suzuki", "emi", "takeshi"];
  return Array.from({ length: h?.NumSessions_u32 ?? 0 }, (_, i) => ({
    Name_str: `SID-${names[i % names.length].toUpperCase()}-[${["L2TP", "SSTP", "OPENVPN_L3", "SECURENAT"][i % 4]}]-${100 + i}`,
    RemoteSession_bool: false, RemoteHostname_str: "", Username_str: names[i % names.length], ClientIP_ip: `203.0.113.${20 + i}`,
    Hostname_str: `client-${i}.example`, MaxNumTcp_u32: 8, CurrentNumTcp_u32: 1 + (i % 4), PacketSize_u64: 1_200_000 * (i + 1), PacketNum_u64: 4_000 * (i + 1),
    LinkMode_bool: false, SecureNATMode_bool: false, BridgeMode_bool: false, Layer3Mode_bool: false, Client_BridgeMode_bool: false, Client_MonitorMode_bool: false,
    VLanId_u32: 0, UniqueId_bin: "", CreatedTime_dt: iso((i + 1) * 37 * MIN), LastCommTime_dt: iso(i * 1000),
  }));
}

function rpc(s: MockServer, method: string, p: Record<string, any>): ApiResponse {
  if (locked(s)) return fail(423, `${s.name} is locked. Enter its administrator password.`, { locked: true });
  if (s.offlineError) return fail(502, s.offlineError, { kind: "network" });
  const m = (methods as Record<string, { risk: string }>)[method];
  if (!m) return fail(404, `Unknown RPC method '${method}'`);
  const hubName = String(p.HubName_str ?? "");
  switch (method) {
    case "GetServerInfo": return ok(s.mockInfo);
    case "GetServerStatus": return s.hub ? fail(422, "Access has been denied.", { softEtherCode: 12 }) : ok(status(s.mockHubs, s.started, s.mem));
    case "EnumHub": return ok({ NumHub_u32: s.mockHubs.length, HubList: s.mockHubs });
    case "GetCaps": return ok({ CapsList: [["b_support_securenat", 1], ["b_support_cascade", 1], ["b_support_bridge", 1], ["b_support_ipsec", 1], ["b_support_wireguard", 1], ["i_max_hubs", 4096]].map(([n, v]) => ({ CapsName_str: n, CapsValue_u32: v, CapsDescrption_utf: String(n) })) });
    case "EnumListener": return ok({ ListenerList: [443, 992, 1194, 5555].map((port, i) => ({ Ports_u32: port, Enables_bool: i !== 2, Errors_bool: false })) });
    case "EnumConnection": return ok({ NumConnection_u32: 3, ConnectionList: [0, 1, 2].map((i) => ({ Name_str: `CID-${400 + i}`, Hostname_str: `198.51.100.${i + 7}`, Ip_ip: `198.51.100.${i + 7}`, Port_u32: 50000 + i, ConnectedTime_dt: iso(i * HOUR), Type_u32: 1 })) });
    case "GetHubStatus": {
      const h = s.mockHubs.find((x) => x.HubName_str === hubName);
      return h ? ok({ HubName_str: h.HubName_str, Online_bool: h.Online_bool, HubType_u32: 0, NumSessions_u32: h.NumSessions_u32, NumSessionsClient_u32: h.NumSessions_u32, NumSessionsBridge_u32: 0, NumAccessLists_u32: 4, NumUsers_u32: h.NumUsers_u32, NumGroups_u32: h.NumGroups_u32, NumMacTables_u32: h.NumMacTables_u32, NumIpTables_u32: h.NumIpTables_u32, SecureNATEnabled_bool: h.HubName_str === "GUEST", LastCommTime_dt: h.LastCommTime_dt, CreatedTime_dt: h.CreatedTime_dt, LastLoginTime_dt: h.LastLoginTime_dt, NumLogin_u32: h.NumLogin_u32 }) : fail(422, "The specified Virtual Hub does not exist on the server.", { softEtherCode: 8 });
    }
    case "EnumSession": return ok({ HubName_str: hubName, SessionList: sessions(s, hubName) });
    case "EnumUser": {
      const h = s.mockHubs.find((x) => x.HubName_str === hubName);
      return ok({ HubName_str: hubName, UserList: Array.from({ length: h?.NumUsers_u32 ?? 0 }, (_, i) => ({ Name_str: `user${String(i + 1).padStart(2, "0")}`, GroupName_str: i % 3 ? "staff" : "admins", Realname_utf: `User ${i + 1}`, Note_utf: "", AuthType_u32: 1, NumLogin_u32: i * 3, LastLoginTime_dt: iso(i * HOUR), DenyAccess_bool: i === 4, IsTrafficFilled_bool: false, IsExpiresFilled_bool: false, Expires_dt: "1970-01-01T09:00:00.000Z" })) });
    }
    case "EnumGroup": return ok({ HubName_str: hubName, GroupList: [{ Name_str: "admins", Realname_utf: "Administrators", Note_utf: "", NumUsers_u32: 4, DenyAccess_bool: false }, { Name_str: "staff", Realname_utf: "Staff", Note_utf: "", NumUsers_u32: 30, DenyAccess_bool: false }] });
    case "EnumLink": return ok({ HubName_str: hubName, LinkList: [] });
    case "EnumLocalBridge": return ok({ LocalBridgeList: [] });
    case "EnumL3Switch": return ok({ L3SWList: [] });
    case "GetKeep": return ok({ UseKeepConnect_bool: true, KeepConnectHost_str: "keepalive.softether.org", KeepConnectPort_u32: 80, KeepConnectProtocol_u32: 1, KeepConnectInterval_u32: 50 });
    case "GetSysLog": return ok({ SaveType_u32: 0, Hostname_str: "", Port_u32: 514 });
    default:
      return ok(m.risk === "read" ? {} : { ...p });
  }
}

async function handle(req: ApiRequest): Promise<ApiResponse> {
  const { method, path } = req;
  const body = (req.body ?? {}) as Record<string, any>;
  const seg = path.split("?")[0].split("/").filter(Boolean); // ["api", ...]
  const r = seg.slice(1);
  if (method === "GET" && r[0] === "catalog") return ok({ methods, types, enums, errors });
  if (r[0] === "settings") {
    if (method === "GET") return ok(settings);
    settings = { ...settings, ...body };
    return ok({ ok: true });
  }
  if (r[0] === "fleet" && r[1] === "summary") {
    const list = servers.map(pub);
    const t = { servers: list.length, online: 0, offline: 0, sessions: 0, users: 0, hubs: 0, recvBytes: 0, sendBytes: 0 };
    for (const s of list) {
      if (s.state?.ok) t.online++; else t.offline++;
      const st = s.state?.status;
      if (st) { t.sessions += st.NumSessionsTotal_u32; t.users += st.NumUsers_u32; t.hubs += st.NumHubTotal_u32; t.recvBytes += st["Recv.UnicastBytes_u64"]; t.sendBytes += st["Send.UnicastBytes_u64"]; }
    }
    return ok({ totals: t, servers: list });
  }
  if (r[0] === "fleet" && r[1] === "rpc") {
    return ok({ results: (body.serverIds as number[]).map((id) => {
      const s = servers.find((x) => x.id === id);
      if (!s) return { serverId: id, ok: false, error: "Server not found" };
      const res = rpc(s, body.method, body.params ?? {});
      return res.status < 400 ? { serverId: id, serverName: s.name, ok: true, result: res.body } : { serverId: id, serverName: s.name, ok: false, error: (res.body as { error: string }).error };
    }) });
  }
  if (r[0] === "servers") {
    if (r.length === 1 && method === "GET") return ok(servers.map(pub));
    if (r.length === 1 && method === "POST") {
      const s: MockServer = {
        id: nextId++, name: body.name, host: body.host, port: body.port, hub: body.hub ?? null, transport: body.transport, tlsMode: body.tlsMode,
        fingerprint: body.fingerprint ?? null, passwordSaved: !!body.savePassword, unlocked: true, tags: body.tags ?? [], notes: body.notes ?? "", enabled: true,
        password: body.password, mockInfo: info("4.44", 9807, body.host.split(".")[0], "Ubuntu 24.04.1 LTS"), mockHubs: [hub("DEFAULT", 0, 1)], started: 5 * MIN, mem: 0.4 * 2 ** 30, state: null,
      };
      servers.push(s);
      return ok(pub(s), 201);
    }
    if (r[1] === "probe") {
      if (/offline|unreachable/.test(body.host)) return fail(502, `Couldn’t connect to ${body.host}:${body.port} (ETIMEDOUT).`, { kind: "timeout" });
      return ok({ fingerprint: fp(body.host), subject: `CN=${body.host}`, issuer: `CN=${body.host}`, validFrom: "2024-03-01T00:00:00Z", validTo: "2037-12-31T23:59:59Z", selfSigned: true });
    }
    if (r[1] === "test") {
      if (body.password === "wrong") return ok({ ok: false, error: "User authentication failed.", kind: "auth" });
      return ok({ ok: true, info: info("4.44", 9807, body.host.split(".")[0], "Ubuntu 24.04.1 LTS"), capsCount: 142 });
    }
    const s = servers.find((x) => x.id === Number(r[1]));
    if (!s) return fail(404, "Server not found");
    if (r.length === 2) {
      if (method === "GET") return ok(pub(s));
      if (method === "DELETE") { servers = servers.filter((x) => x !== s); return ok({ ok: true }); }
      if (method === "PUT") {
        Object.assign(s, {
          name: body.name ?? s.name, host: body.host ?? s.host, port: body.port ?? s.port, hub: body.hub === undefined ? s.hub : body.hub, transport: body.transport ?? s.transport,
          tlsMode: body.tlsMode ?? s.tlsMode, fingerprint: body.fingerprint === undefined ? s.fingerprint : body.fingerprint, tags: body.tags ?? s.tags, notes: body.notes ?? s.notes,
          passwordSaved: body.savePassword ?? s.passwordSaved,
        });
        if (body.password) { s.password = body.password; s.unlocked = true; }
        return ok(pub(s));
      }
    }
    if (r[2] === "refresh") return ok(pub(s));
    if (r[2] === "unlock") {
      if (!body.password || body.password === "wrong") return fail(502, "The server rejected the administrator password.", { kind: "auth" });
      s.unlocked = true;
      return ok(pub(s));
    }
    if (r[2] === "lock") { s.unlocked = false; return ok(pub(s)); }
    if (r[2] === "rpc") return rpc(s, r[3], body);
    if (r[2] === "backups") return ok([]);
  }
  if (r[0] === "deploy") return ok(r[1] === "status" ? { msitools: { ok: true, version: "0.103" } } : []);
  return fail(404, `No mock for ${method} ${path}`);
}

export function installMockBridge() {
  const menuListeners = new Set<(a: string) => void>();
  const appInfo: AppInfo = {
    version: "1.0.0", platform: params.get("platform") ?? "darwin", arch: "arm64", electron: "44.4.5", node: "24.21.0",
    dataDir: params.get("platform") === "win32" ? "C:\\Users\\you\\AppData\\Roaming\\Server Manager for SoftEther VPN" : "/Users/you/Library/Application Support/Server Manager for SoftEther VPN",
  };
  const wait = <T>(v: T) => new Promise<T>((res) => setTimeout(() => res(v), delay));
  const bridge: SemBridge = {
    api: async (req) => wait(await handle(structuredClone(req))),
    download: async (path, opts) => { console.info("[mock] download", path, opts); return wait({ saved: true, filePath: `/Users/you/Downloads/${opts?.suggestedName ?? "file"}` }); },
    upload: async (path, opts) => { console.info("[mock] upload", path, opts); return wait({ status: 200, body: { ok: true } }); },
    saveFile: async (opts) => { console.info("[mock] saveFile", opts.suggestedName); return wait({ saved: true, filePath: `/Users/you/Downloads/${opts.suggestedName}` }); },
    openFile: async () => wait({ name: "ca.pem", content: "-----BEGIN CERTIFICATE-----\nMIIB...mock...\n-----END CERTIFICATE-----\n" }),
    openExternal: async (url) => { window.open(url, "_blank", "noopener"); },
    revealPath: async (p) => { console.info("[mock] reveal", p); },
    info: async () => appInfo,
    onMenu: (cb) => { menuListeners.add(cb); return () => { menuListeners.delete(cb); }; },
  };
  Object.assign(window, { sem: bridge, __semMock: true, __semMenu: (a: string) => menuListeners.forEach((l) => l(a)) });
}
