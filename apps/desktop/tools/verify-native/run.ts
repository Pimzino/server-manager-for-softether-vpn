// E2E verification of the native PACK admin transport against a real SoftEther VPN Server.
//
//   node apps/desktop/tools/verify-native/run.ts
//
// Starts a throwaway vpnserver (port 15701, run dir ~/se-desk-native), then:
//   1. SHA-0 known-answer vectors + the server's own HashedPassword (from its config) vs hashAdminPassword()
//   2. native writes (hub, user, group, access rules, AC list, SecureNAT, cascade, CA, CRL, L3, EtherIP,
//      message, UDP ports, cipher) each read back through JSON-RPC
//   3. every read-risk catalog method called through BOTH transports, results deep-compared
//   4. hub-admin mode, wrong passwords, empty admin password, TLS pin/CA, IPv6, timeouts, session reuse,
//      ephemeral calls, idle close, recovery after a server restart, SetConfig round trip, DeleteHub
//   5. parameter edge cases through both transports; deadlines of queued/joined calls and closeNativeSessions()
//      with the server frozen (SIGSTOP)
// and writes tools/verify-native/REPORT.md. The server's process group is always killed at the end.
process.env.SEM_NATIVE_IDLE_MS ??= "3000"; // exercised by the idle-close scenario (read at module load)

import tls from "node:tls";
import net from "node:net";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  JsonRpcError, JsonRpcHttpError, PORT, RUN_DIR, jsonRpc, prepareRunDir, startServer, stopServer, waitFor, waitGone,
} from "./server.ts";

const HERE = import.meta.dirname;
const { callNativeRpc, closeNativeSessions, hashAdminPassword, nativeSessionStats, sha0 } =
  await import("../../src/main/softether/native.ts");
const { ConnectionError, SoftEtherError, normalizeFingerprint } = await import("../../src/main/softether/errors.ts");
const { methods: catalogMethods } = await import("../../../../packages/api-catalog/index.ts");
import type { Endpoint } from "../../src/main/softether/client.ts";

// ---------------------------------------------------------------------------------------------------
// Instrumentation: count TLS connections the native transport opens

let tlsConnects = 0;
let lastSocket: tls.TLSSocket | null = null;
const origConnect = tls.connect;
(tls as { connect: typeof tls.connect }).connect = function (this: unknown, ...args: unknown[]) {
  const sock = (origConnect as (...a: unknown[]) => tls.TLSSocket).apply(tls, args);
  // Count only the native transport's connections (the harness' JSON-RPC calls go through https)
  if (new Error().stack?.includes("softether/native.ts")) {
    tlsConnects++;
    lastSocket = sock;
  }
  return sock;
} as typeof tls.connect;

// ---------------------------------------------------------------------------------------------------
// Fixtures

const ADMIN_PW = "Nat1ve-Adm1n-Pw";
const HUB = "NATIVEHUB";
const HUB_PW = "Hub-Adm1n-Pw";
const USER = "alice";
const GROUP = "staff";
const LINK = "cascade-1";
const L3SW = "l3sw";
const ETHERIP_ID = "etherip-peer";
const REALNAME = "Ālïcé 名前 😀";

const admin: Endpoint = { host: "127.0.0.1", port: PORT, password: ADMIN_PW, tlsMode: "insecure", transport: "native" };
const T = 30_000;

const TW_SECTION = "twin writes: native vs JSON-RPC response";
const EDGE_SECTION = "edge case: native vs JSON-RPC";
type Row = { section: string; name: string; params: string; result: string; ok: boolean; detail: string };
const rows: Row[] = [];
const ignoredApplied = new Map<string, Set<string>>(); // rule reason -> methods where it hid a difference
let failures = 0;

function record(section: string, name: string, params: unknown, ok: boolean, result: string, detail = "") {
  if (!ok) failures++;
  rows.push({ section, name, params: params === undefined ? "" : short(JSON.stringify(params)), result, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${section}] ${name}: ${result}${detail ? ` - ${detail}` : ""}`);
}

function short(s: string, n = 90) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function native(method: string, params: Record<string, unknown> = {}, ep: Endpoint = admin, opts?: { ephemeral?: boolean }) {
  return callNativeRpc<Record<string, unknown>>(ep, method, params, T, opts);
}
async function json(method: string, params: Record<string, unknown> = {}, hub = "", pw = ADMIN_PW) {
  return jsonRpc(hub, pw, method, params, T);
}

type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; error: string; code?: number; kind?: string };
async function outcome(p: Promise<Record<string, unknown>>): Promise<Outcome> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    const err = e as { code?: number; kind?: string; message?: string; status?: number };
    if (e instanceof SoftEtherError || e instanceof JsonRpcError) return { ok: false, error: `SoftEther error ${err.code}`, code: err.code };
    if (e instanceof ConnectionError) return { ok: false, error: `ConnectionError(${err.kind})`, kind: err.kind };
    if (e instanceof JsonRpcHttpError) return { ok: false, error: `HTTP ${err.status}` };
    return { ok: false, error: String(err?.message ?? e) };
  }
}

// ---------------------------------------------------------------------------------------------------
// Deep comparison with documented volatile fields

type Diff = { path: string; a: unknown; b: unknown };
function deepDiff(a: unknown, b: unknown, p = "", out: Diff[] = []): Diff[] {
  const kind = (x: unknown) => (x === null ? "null" : Array.isArray(x) ? "array" : typeof x);
  if (kind(a) !== kind(b)) { out.push({ path: p || "(root)", a, b }); return out; }
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) out.push({ path: `${p}.length`, a: a.length, b: bb.length });
    for (let i = 0; i < Math.min(a.length, bb.length); i++) deepDiff(a[i], bb[i], `${p}[${i}]`, out);
  } else if (a && typeof a === "object") {
    const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      const q = p ? `${p}.${k}` : k;
      if (!(k in ao)) out.push({ path: q, a: "(missing)", b: bo[k] });
      else if (!(k in bo)) out.push({ path: q, a: ao[k], b: "(missing)" });
      else deepDiff(ao[k], bo[k], q, out);
    }
  } else if (a !== b) {
    out.push({ path: p || "(root)", a, b });
  }
  return out;
}

/** Shape = same keys and value types everywhere (for lists whose content is inherently per-connection). */
function shapeOf(x: unknown): unknown {
  if (Array.isArray(x)) return x.length ? [shapeOf(x[0])] : [];
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, shapeOf(v)]).sort());
  return x === null ? "null" : typeof x;
}

interface Volatile { method: RegExp; path: RegExp; reason: string; shapeOnly?: boolean }
const VOLATILE: Volatile[] = [
  { method: /^GetServerStatus$/, path: /^(CurrentTime_dt|CurrentTick_u64)$/, reason: "server clock at the moment of the call" },
  { method: /^GetServerStatus$/, path: /^Mem[A-Za-z]+_u64$/, reason: "live memory statistics of the server process" },
  { method: /^GetServerStatus$/, path: /^(Recv|Send)\.\w+_u64$/, reason: "server-wide traffic counters (every admin call adds traffic)" },
  { method: /^GetServerStatus$/, path: /^NumTcpConnections(Local)?_u32$/, reason: "the two transports' own admin connections are counted" },
  { method: /^(EnumFarmMember|GetFarmInfo)$/, path: /NumTcpConnections_u32$/, reason: "cluster member TCP connection counts include the two transports' own admin connections" },
  { method: /^EnumConnection$/, path: /^ConnectionList/, reason: "lists the caller's own connection (names/ports/times differ per transport): compared by shape", shapeOnly: true },
  { method: /^(GetHubStatus|EnumHub|GetUser|EnumUser|GetGroup|EnumGroup|GetSecureNATStatus|GetSessionStatus|EnumSession|GetLinkStatus)$/, path: /(Recv|Send)\.\w+_u64$|(LastCommTime|LastCommDormant)_dt$|Num(Mac|Ip)Tables_u32$/, reason: "SecureNAT/virtual host traffic and table timers keep changing between the two calls" },
  { method: /^GetSessionStatus$/, path: /^(Client_Ip_Address_ip|SessionStatus_ClientHostName_str|UniqueId_bin|CurrentConnectionEstablishTime_dt|TotalRecvSize(Real)?_u64|TotalSendSize(Real)?_u64|Total(Recv|Send)Size_u64)$/, reason: "live session counters" },
  { method: /^(EnumMacTable|EnumIpTable|EnumNAT|EnumDHCP)$/, path: /(CreatedTime|UpdatedTime|LastCommTime|ExpireTime|LeasedTime)_dt$|(SendSize|RecvSize)_u64$/, reason: "table entry timestamps/counters of the live SecureNAT" },
  { method: /^EnumLogFile$/, path: /(FileSize_u32|UpdatedTime_dt)$/, reason: "log files grow while the test runs" },
  { method: /^ReadLogFile$/, path: /^Buffer_bin$/, reason: "the log file grows between the two reads (compared: prefix equality)" },
  { method: /^GetConfig$/, path: /^FileData_bin$/, reason: "the config text contains live counters/timestamps (compared: line by line, volatile lines ignored)" },
  { method: /^MakeOpenVpnConfigFile$/, path: /^Buffer_bin$/, reason: "the ZIP embeds file timestamps (compared: sizes)" },
  { method: /^Set(User|Group)$/, path: /^UpdatedTime_dt$/, reason: "each SetUser stamps the user with the server's current time" },
  { method: /^SetCrl$/, path: /^Key_u32$/, reason: "SetCrl stores the CRL entry under a new key on every call" },
  { method: /^GetDDnsClientStatus$/, path: /Err_IPv[46]_(u32|utf)$/, reason: "DDNS client state machine (no internet in the test)" },
];

function compareMethod(method: string, n: Record<string, unknown>, j: Record<string, unknown>): { equal: boolean; exact: boolean; unexplained: Diff[]; ignored: string[] } {
  const diffs = deepDiff(n, j);
  if (!diffs.length) return { equal: true, exact: true, unexplained: [], ignored: [] };
  const ignored = new Set<string>();
  const unexplained: Diff[] = [];
  for (const d of diffs) {
    const top = d.path.replace(/^\(root\)$/, "");
    const rule = VOLATILE.find((v) => v.method.test(method) && v.path.test(top));
    if (!rule) { unexplained.push(d); continue; }
    if (rule.shapeOnly) {
      const key = top.split(/[.[]/)[0];
      if (!isDeepStrictEqual(shapeOf(n[key]), shapeOf(j[key]))) { unexplained.push({ path: `${key} (shape)`, a: shapeOf(n[key]), b: shapeOf(j[key]) }); continue; }
    }
    if (method === "ReadLogFile" && top === "Buffer_bin") {
      const a = Buffer.from(String(n.Buffer_bin), "base64"), b = Buffer.from(String(j.Buffer_bin), "base64");
      const [s, l] = a.length <= b.length ? [a, b] : [b, a];
      if (!l.subarray(0, s.length).equals(s)) { unexplained.push(d); continue; }
    }
    if (method === "MakeOpenVpnConfigFile" && top === "Buffer_bin") {
      if (Buffer.from(String(n.Buffer_bin), "base64").length !== Buffer.from(String(j.Buffer_bin), "base64").length) { unexplained.push(d); continue; }
    }
    if (method === "GetConfig" && top === "FileData_bin") {
      const cleaned = (s: unknown) => Buffer.from(String(s), "base64").toString("utf8").split(/\r?\n/)
        .filter((l) => !/(Time|Tick|Traffic|Broadcast|Unicast|Count|Bytes|NumLogin|LastComm|Uptime|CreatedTime)/i.test(l));
      if (!isDeepStrictEqual(cleaned(n.FileData_bin), cleaned(j.FileData_bin))) { unexplained.push(d); continue; }
    }
    ignored.add(top.replace(/\[\d+\]/g, "[]"));
    if (!ignoredApplied.has(rule.reason)) ignoredApplied.set(rule.reason, new Set());
    ignoredApplied.get(rule.reason)!.add(method);
  }
  return { equal: unexplained.length === 0, exact: false, unexplained, ignored: [...ignored] };
}

// ---------------------------------------------------------------------------------------------------
// Certificates made with openssl (a CA for AddCa and a server certificate with IP SANs for SetServerCert)

function makeCerts() {
  const dir = path.join(RUN_DIR, "certs");
  mkdirSync(dir, { recursive: true });
  const ossl = (args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  ossl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "30",
    "-subj", "/CN=Native Verify Test CA/O=SoftEther Manager"]);
  ossl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "srv.key", "-out", "srv.pem", "-days", "30",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,IP:::1,DNS:localhost"]);
  ossl(["x509", "-in", "ca.pem", "-outform", "DER", "-out", "ca.der"]);
  ossl(["x509", "-in", "srv.pem", "-outform", "DER", "-out", "srv.der"]);
  ossl(["rsa", "-in", "srv.key", "-outform", "DER", "-traditional", "-out", "srv.key.der"]);
  const rd = (f: string) => readFileSync(path.join(dir, f));
  return {
    caPem: rd("ca.pem").toString(), caDer: rd("ca.der"),
    srvPem: rd("srv.pem").toString(), srvDer: rd("srv.der"), srvKeyDer: rd("srv.key.der"), srvKeyPem: rd("srv.key").toString(),
  };
}

function probeFingerprint(host = "127.0.0.1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = origConnect({ host, port: PORT, rejectUnauthorized: false });
    s.once("secureConnect", () => { resolve(normalizeFingerprint(s.getPeerCertificate().fingerprint256)); s.destroy(); });
    s.once("error", reject);
  });
}

async function waitReady() {
  await waitFor(async () => !!(await jsonRpc("", ADMIN_PW, "Test", { IntValue_u32: 1 }, 3000).catch(async (e) => {
    if (e instanceof JsonRpcHttpError) return jsonRpc("", "", "Test", { IntValue_u32: 1 }, 3000);
    throw e;
  })), "vpnserver JSON-RPC", 60_000);
}

// ---------------------------------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  prepareRunDir();
  startServer();
  await waitFor(async () => !!(await jsonRpc("", "", "Test", { IntValue_u32: 1 }, 3000)), "vpnserver JSON-RPC", 60_000);
  await jsonRpc("", "", "SetServerPassword", { PlainTextPassword_str: ADMIN_PW });
  const info = await json("GetServerInfo");
  const certs = makeCerts();

  // 1. SHA-0 ------------------------------------------------------------------------------------------
  const vectors: [string, string][] = [
    ["", "f96cea198ad1dd5617ac084a3d92c6107708c0ef"],
    ["abc", "0164b8a914cd2a5e74c4f7ff082c4d97f1edf880"],
  ];
  for (const [msg, want] of vectors) {
    const got = sha0(Buffer.from(msg)).toString("hex");
    record("sha0", `SHA-0("${msg}")`, undefined, got === want, got === want ? "matches the published vector" : `got ${got}`, want);
  }
  {
    const cfg = Buffer.from(String((await json("GetConfig")).FileData_bin), "base64").toString("utf8");
    const m = /byte HashedPassword ([A-Za-z0-9+/=]+)/.exec(cfg);
    const want = m ? Buffer.from(m[1], "base64").toString("hex") : "(not found)";
    const got = hashAdminPassword(ADMIN_PW).toString("hex");
    record("sha0", "HashAdminPassword vs server config", undefined, got === want,
      got === want ? "our SHA-0 of the admin password equals the server's HashedPassword" : `got ${got}`, `server ${want}`);
  }

  // 2. Native writes, read back through JSON-RPC ------------------------------------------------------
  const W = "native write -> JSON-RPC read-back";
  async function write(name: string, params: Record<string, unknown>, check: () => Promise<[boolean, string]>) {
    const o = await outcome(native(name, params));
    if (!o.ok) { record(W, name, params, false, `native call failed: ${o.error}`); return undefined; }
    let ok = false, detail = "";
    try { [ok, detail] = await check(); } catch (e) { detail = `read-back failed: ${(e as Error).message}`; }
    record(W, name, params, ok, ok ? "applied" : "read-back mismatch", detail);
    return o.value;
  }

  await write("CreateHub", { HubName_str: HUB, AdminPasswordPlainText_str: HUB_PW, Online_bool: true, MaxSession_u32: 0, NoEnum_bool: false, HubType_u32: 0 },
    async () => { const r = await json("EnumHub"); const hubs = (r.HubList as { HubName_str: string }[]).map((h) => h.HubName_str); return [hubs.includes(HUB), `hubs: ${hubs.join(",")}`]; });
  await write("SetHub", { HubName_str: HUB, AdminPasswordPlainText_str: HUB_PW, Online_bool: true, MaxSession_u32: 77, NoEnum_bool: true, HubType_u32: 0 },
    async () => { const r = await json("GetHub", { HubName_str: HUB }); return [r.MaxSession_u32 === 77 && r.NoEnum_bool === true, JSON.stringify(r)]; });
  await write("CreateGroup", { HubName_str: HUB, Name_str: GROUP, Realname_utf: "Staff Ünïcode", Note_utf: "group note" },
    async () => { const r = await json("GetGroup", { HubName_str: HUB, Name_str: GROUP }); return [r.Realname_utf === "Staff Ünïcode", `Realname_utf=${r.Realname_utf}`]; });
  await write("CreateUser", { HubName_str: HUB, Name_str: USER, GroupName_str: GROUP, Realname_utf: REALNAME, Note_utf: "created natively",
    ExpireTime_dt: "2030-01-02T03:04:05.678Z", AuthType_u32: 1, Auth_Password_str: "user-pw-1" },
  async () => {
    const r = await json("GetUser", { HubName_str: HUB, Name_str: USER });
    // Parity: the same user created through JSON-RPC must be stored identically (the server itself
    // does not round-trip characters outside the BMP, whichever transport sends them)
    await json("CreateUser", { HubName_str: HUB, Name_str: "bob", GroupName_str: GROUP, Realname_utf: REALNAME, Note_utf: "created natively",
      ExpireTime_dt: "2030-01-02T03:04:05.678Z", AuthType_u32: 1, Auth_Password_str: "user-pw-1" });
    const b = await json("GetUser", { HubName_str: HUB, Name_str: "bob" });
    const same = ["Realname_utf", "Note_utf", "ExpireTime_dt", "AuthType_u32", "GroupName_str"].every((k) => r[k] === b[k]);
    return [same && r.ExpireTime_dt === "2030-01-02T03:04:05.678Z" && r.AuthType_u32 === 1 && r.GroupName_str === GROUP && String(r.Realname_utf).startsWith("Ālïcé 名前"),
      `Realname_utf=${JSON.stringify(r.Realname_utf)} (JSON-RPC-created twin: ${JSON.stringify(b.Realname_utf)}) ExpireTime_dt=${r.ExpireTime_dt} AuthType_u32=${r.AuthType_u32} GroupName_str=${r.GroupName_str}`];
  });
  {
    // Password check: the user's NTLM hash (NtLmSecureHash) differs from an empty one only if the password was set
    const cur = await json("GetUser", { HubName_str: HUB, Name_str: USER });
    await write("SetUser", { ...cur, Note_utf: "updated natively", UsePolicy_bool: true, "policy:MaxConnection_u32": 5, "policy:NoRouting_bool": true,
      "policy:TimeOut_u32": 120 },
    async () => {
      const r = await json("GetUser", { HubName_str: HUB, Name_str: USER });
      return [r.Note_utf === "updated natively" && r.UsePolicy_bool === true && r["policy:MaxConnection_u32"] === 5 && r["policy:NoRouting_bool"] === true
        && r.HashedKey_bin === cur.HashedKey_bin, `Note_utf=${r.Note_utf} UsePolicy_bool=${r.UsePolicy_bool} MaxConnection=${r["policy:MaxConnection_u32"]} hash kept=${r.HashedKey_bin === cur.HashedKey_bin}`];
    });
  }
  const v6 = (s: string) => {
    const b = Buffer.alloc(16);
    s.split(":").forEach((h, i, a) => { if (h) b.writeUInt16BE(parseInt(h, 16), (i === a.length - 1 && a.length < 8 ? 7 : i) * 2); });
    return b.toString("base64");
  };
  await write("AddAccess", { HubName_str: HUB, AccessListSingle: [{
    Note_utf: "allow ssh from 10/8 ✓", Active_bool: true, Priority_u32: 100, Discard_bool: false, IsIPv6_bool: false,
    SrcIpAddress_ip: "10.0.0.0", SrcSubnetMask_ip: "255.0.0.0", DestIpAddress_ip: "192.168.7.8", DestSubnetMask_ip: "255.255.255.255",
    Protocol_u32: 6, SrcPortStart_u32: 0, SrcPortEnd_u32: 0, DestPortStart_u32: 22, DestPortEnd_u32: 22,
    SrcUsername_str: USER, DestUsername_str: "", CheckSrcMac_bool: true, SrcMacAddress_bin: Buffer.from("5e0000000001", "hex").toString("base64"),
    SrcMacMask_bin: Buffer.from("ffffffffffff", "hex").toString("base64"), CheckDstMac_bool: false, CheckTcpState_bool: true, Established_bool: false,
    Delay_u32: 10, Jitter_u32: 2, Loss_u32: 1, RedirectUrl_str: "",
  }] }, async () => {
    const r = await json("EnumAccess", { HubName_str: HUB });
    const a = (r.AccessList as Record<string, unknown>[]).find((x) => x.Note_utf === "allow ssh from 10/8 ✓");
    return [!!a && a.SrcIpAddress_ip === "10.0.0.0" && a.SrcSubnetMask_ip === "255.0.0.0" && a.DestIpAddress_ip === "192.168.7.8" && a.DestPortStart_u32 === 22
      && a.SrcMacAddress_bin === "XgAAAAAB" && a.CheckTcpState_bool === true && a.Delay_u32 === 10, JSON.stringify(a)?.slice(0, 300) ?? "not found"];
  });
  await write("AddAccess", { HubName_str: HUB, AccessListSingle: [{
    Note_utf: "ipv6 rule", Active_bool: true, Priority_u32: 200, Discard_bool: true, IsIPv6_bool: true,
    SrcIpAddress6_bin: v6("2001:db8:0:0:0:0:0:0"), SrcSubnetMask6_bin: v6("ffff:ffff:ffff:ffff:0:0:0:0"),
    DestIpAddress6_bin: v6("0:0:0:0:0:0:0:0"), DestSubnetMask6_bin: v6("0:0:0:0:0:0:0:0"), Protocol_u32: 17,
  }] }, async () => {
    const r = await json("EnumAccess", { HubName_str: HUB });
    const a = (r.AccessList as Record<string, unknown>[]).find((x) => x.Note_utf === "ipv6 rule");
    return [!!a && a.IsIPv6_bool === true && a.SrcIpAddress6_bin === v6("2001:db8:0:0:0:0:0:0") && a.Discard_bool === true && a.Protocol_u32 === 17,
      JSON.stringify(a)?.slice(0, 300) ?? "not found"];
  });
  {
    const acl = [
      { Id_u32: 1, Priority_u32: 10, Deny_bool: true, Masked_bool: true, IpAddress_ip: "192.168.50.0", SubnetMask_ip: "255.255.255.0" },
      { Id_u32: 2, Priority_u32: 20, Deny_bool: false, Masked_bool: false, IpAddress_ip: "2001:db8::1", SubnetMask_ip: "0.0.0.0" },
      { Id_u32: 3, Priority_u32: 30, Deny_bool: false, Masked_bool: true, IpAddress_ip: "fe80::1%3", SubnetMask_ip: "ffff:ffff:ffff:ffff::" },
    ];
    await write("SetAcList", { HubName_str: HUB, ACList: acl }, async () => {
      const r = await json("GetAcList", { HubName_str: HUB });
      // Parity: the same list sent through JSON-RPC must be stored identically
      await json("SetAcList", { HubName_str: HUB, ACList: acl });
      const j = await json("GetAcList", { HubName_str: HUB });
      await native("SetAcList", { HubName_str: HUB, ACList: acl });
      const l = r.ACList as Record<string, unknown>[];
      const ips = l.map((x) => `${x.IpAddress_ip}/${x.SubnetMask_ip}/${x.Deny_bool}/${x.Priority_u32}`).join(" ");
      return [isDeepStrictEqual(r, j) && ips.startsWith("192.168.50.0/255.255.255.0/true/10 2001:db8::1/"),
        `${ips} (identical to the JSON-RPC write: ${isDeepStrictEqual(r, j)}; the server itself normalises IPv6 masks and drops scope ids)`];
    });
  }
  {
    const cur = await json("GetSecureNATOption", { RpcHubName_str: HUB });
    await write("SetSecureNATOption", { ...cur, RpcHubName_str: HUB, Ip_ip: "192.168.77.1", Mask_ip: "255.255.255.0", DhcpLeaseIPStart_ip: "192.168.77.10",
      DhcpLeaseIPEnd_ip: "192.168.77.200", DhcpSubnetMask_ip: "255.255.255.0", DhcpGatewayAddress_ip: "192.168.77.1", DhcpDnsServerAddress_ip: "192.168.77.1",
      DhcpDnsServerAddress2_ip: "9.9.9.9", DhcpDomainName_str: "native.test", Mtu_u32: 1400, SaveLog_bool: false,
      ApplyDhcpPushRoutes_bool: true, DhcpPushRoutes_str: "10.99.0.0/255.255.0.0/192.168.77.1" },
    async () => {
      const r = await json("GetSecureNATOption", { RpcHubName_str: HUB });
      return [r.Ip_ip === "192.168.77.1" && r.DhcpDnsServerAddress2_ip === "9.9.9.9" && r.DhcpDomainName_str === "native.test" && r.Mtu_u32 === 1400
        && r.DhcpPushRoutes_str === "10.99.0.0/255.255.0.0/192.168.77.1" && r.SaveLog_bool === false,
      `Ip=${r.Ip_ip} Dns2=${r.DhcpDnsServerAddress2_ip} Domain=${r.DhcpDomainName_str} Mtu=${r.Mtu_u32} Routes=${r.DhcpPushRoutes_str}`];
    });
  }
  await write("EnableSecureNAT", { HubName_str: HUB }, async () => {
    const r = await json("GetSecureNATStatus", { HubName_str: HUB });
    const s = await json("EnumSession", { HubName_str: HUB });
    const names = (s.SessionList as { Name_str: string }[]).map((x) => x.Name_str);
    return [names.some((n) => /SECURENAT/i.test(n)), `sessions: ${names.join(",")} status keys: ${Object.keys(r).length}`];
  });
  await write("CreateLink", { HubName_Ex_str: HUB, AccountName_utf: LINK, Online_bool: false, Hostname_str: "vpn.example.invalid", Port_u32: 443, HubName_str: "REMOTEHUB",
    AuthType_u32: 1, Username_str: "cascade-user", PlainPassword_str: "cascade-pw", MaxConnection_u32: 2, UseEncrypt_bool: true, UseCompress_bool: false,
    CheckServerCert_bool: false, AdditionalConnectionInterval_u32: 1, ConnectionDisconnectSpan_u32: 0, "policy:MaxUpload_u32": 1000 },
  async () => {
    const r = await json("GetLink", { HubName_Ex_str: HUB, AccountName_utf: LINK });
    return [r.Hostname_str === "vpn.example.invalid" && r.HubName_str === "REMOTEHUB" && r.Username_str === "cascade-user" && r.MaxConnection_u32 === 2,
      `Hostname=${r.Hostname_str} Hub=${r.HubName_str} User=${r.Username_str} MaxConnection=${r.MaxConnection_u32}`];
  });
  await write("AddCa", { HubName_str: HUB, Cert_bin: certs.caDer.toString("base64") }, async () => {
    const r = await json("EnumCa", { HubName_str: HUB });
    const ca = (r.CAList as Record<string, unknown>[])[0];
    const g = ca ? await json("GetCa", { HubName_str: HUB, Key_u32: ca.Key_u32 }) : {};
    return [g.Cert_bin === certs.caDer.toString("base64"), `CAList: ${JSON.stringify(r.CAList)?.slice(0, 200)}; DER round trip ${g.Cert_bin === certs.caDer.toString("base64")}`];
  });
  await write("AddCrl", { HubName_str: HUB, CommonName_utf: "Revoked Ünïcode", Organization_utf: "Org", Serial_bin: Buffer.from("0102030405", "hex").toString("base64") },
    async () => { const r = await json("EnumCrl", { HubName_str: HUB }); return [(r.CRLList as unknown[]).length === 1, JSON.stringify(r).slice(0, 200)]; });
  await write("SetHubMsg", { HubName_str: HUB, Msg_bin: Buffer.from("Welcome — native ✓").toString("base64") },
    async () => { const r = await json("GetHubMsg", { HubName_str: HUB }); return [Buffer.from(String(r.Msg_bin), "base64").toString() === "Welcome — native ✓", `Msg=${Buffer.from(String(r.Msg_bin), "base64").toString()}`]; });
  await write("AddL3Switch", { Name_str: L3SW }, async () => { const r = await json("EnumL3Switch"); return [JSON.stringify(r).includes(L3SW), JSON.stringify(r).slice(0, 200)]; });
  await write("AddL3If", { Name_str: L3SW, HubName_str: HUB, IpAddress_ip: "10.200.0.1", SubnetMask_ip: "255.255.255.0" },
    async () => { const r = await json("EnumL3If", { Name_str: L3SW }); return [JSON.stringify(r).includes("10.200.0.1"), JSON.stringify(r).slice(0, 200)]; });
  await write("AddL3Table", { Name_str: L3SW, NetworkAddress_ip: "10.201.0.0", SubnetMask_ip: "255.255.0.0", GatewayAddress_ip: "10.200.0.254", Metric_u32: 7 },
    async () => { const r = await json("EnumL3Table", { Name_str: L3SW }); return [JSON.stringify(r).includes("10.201.0.0") && JSON.stringify(r).includes("\"Metric_u32\":7"), JSON.stringify(r).slice(0, 200)]; });
  await write("AddEtherIpId", { Id_str: ETHERIP_ID, HubName_str: HUB, UserName_str: USER, Password_str: "user-pw-1" },
    async () => { const r = await json("GetEtherIpId", { Id_str: ETHERIP_ID }); return [r.HubName_str === HUB && r.UserName_str === USER, JSON.stringify(r)]; });
  {
    const before = await json("GetPortsUDP");
    await write("SetPortsUDP", { Ports_u32: [15791, 15792] }, async () => { const r = await json("GetPortsUDP"); return [isDeepStrictEqual(r.Ports_u32, [15791, 15792]), JSON.stringify(r)]; });
    await write("SetPortsUDP", { Ports_u32: before.Ports_u32 ?? [] }, async () => { const r = await json("GetPortsUDP"); return [isDeepStrictEqual(r.Ports_u32 ?? [], before.Ports_u32 ?? []), `restored ${JSON.stringify(r)}`]; });
  }
  {
    const cur = String((await json("GetServerCipher")).String_str);
    const list = String((await json("GetServerCipherList")).String_str).split(";").filter(Boolean);
    const other = list.find((c) => c !== cur && /AES256-GCM-SHA384|AES128-GCM-SHA256|AES256-SHA/.test(c)) ?? list.find((c) => c !== cur)!;
    await write("SetServerCipher", { String_str: other }, async () => { const r = await json("GetServerCipher"); return [r.String_str === other, `${cur} -> ${r.String_str}`]; });
    await write("SetServerCipher", { String_str: cur }, async () => { const r = await json("GetServerCipher"); return [r.String_str === cur, `restored ${r.String_str}`]; });
  }

  // An online cascade (NATIVEHUB -> TARGETHUB on this same server) so GetLinkStatus has data to compare
  const ONLINE_LINK = "online-link";
  await json("CreateHub", { HubName_str: "TARGETHUB", AdminPasswordPlainText_str: HUB_PW, Online_bool: true, HubType_u32: 0 });
  await json("CreateUser", { HubName_str: "TARGETHUB", Name_str: "linkuser", AuthType_u32: 1, Auth_Password_str: "link-pw-1" });
  await write("CreateLink", { HubName_Ex_str: HUB, AccountName_utf: ONLINE_LINK, Online_bool: false, Hostname_str: "127.0.0.1", Port_u32: PORT,
    HubName_str: "TARGETHUB", AuthType_u32: 1, Username_str: "linkuser",
    // CLIENT_AUTHTYPE_PASSWORD carries HashPassword() = SHA-0(password || upper(username)), computed with our sha0()
    HashedPassword_bin: sha0(Buffer.from("link-pw-1" + "LINKUSER")).toString("base64"), MaxConnection_u32: 1, UseEncrypt_bool: true,
    CheckServerCert_bool: false, AdditionalConnectionInterval_u32: 1 },
  async () => { const r = await json("GetLink", { HubName_Ex_str: HUB, AccountName_utf: ONLINE_LINK }); return [r.HubName_str === "TARGETHUB", `Hostname=${r.Hostname_str}:${r.Port_u32} Hub=${r.HubName_str}`]; });
  await write("SetLinkOnline", { HubName_str: HUB, AccountName_utf: ONLINE_LINK }, async () => {
    let st: Record<string, unknown> = {};
    await waitFor(async () => { st = await json("GetLinkStatus", { HubName_Ex_str: HUB, AccountName_utf: ONLINE_LINK }); return st.Connected_bool === true; }, "cascade to connect", 30_000).catch(() => undefined);
    return [st.Connected_bool === true, `Connected_bool=${st.Connected_bool} ServerName=${st.ServerName_str} (the cascade logged in with a password hash made by our sha0())`];
  });
  const targetSessions = await json("EnumSession", { HubName_str: "TARGETHUB" });
  const cascadeSession = (targetSessions.SessionList as { Name_str: string }[]).find((x) => /linkuser/i.test(x.Name_str))?.Name_str ?? "";

  // 3. Read methods through both transports -----------------------------------------------------------
  const C = "read: native vs JSON-RPC";
  const enumCa = await json("EnumCa", { HubName_str: HUB });
  const enumCrl = await json("EnumCrl", { HubName_str: HUB });
  const sessions = await json("EnumSession", { HubName_str: HUB });
  const natSession = (sessions.SessionList as { Name_str: string }[]).find((s) => /SECURENAT/i.test(s.Name_str))?.Name_str ?? "";
  const logs = await json("EnumLogFile");
  const logFile = (logs.LogFiles as { FilePath_str: string; FileSize_u32: number }[]).find((l) => /server_log/.test(l.FilePath_str))?.FilePath_str ?? "";
  // A connection that exists for both calls: our own native admin connection
  await native("Test", { IntValue_u32: 1 });
  const conns = await json("EnumConnection");
  const adminConn = (conns.ConnectionList as { Name_str: string; Type_u32: number }[]).find((c) => c.Type_u32 === 5 /* CONNECTION_TYPE_ADMIN_RPC */)?.Name_str ?? "";

  const H = { HubName_str: HUB };
  const plan: Record<string, Record<string, unknown>[]> = {
    Test: [{ IntValue_u32: 4294967295, Int64Value_u64: 1234567890123, StrValue_str: "str ü", UniStrValue_utf: "ユニコード 😀" }],
    GetFarmInfo: [{ Id_u32: 0 }],
    GetHub: [H], GetHubRadius: [H], GetHubStatus: [H], GetHubLog: [H], EnumCa: [H], EnumLink: [H], EnumAccess: [H], EnumUser: [H],
    EnumGroup: [H], EnumSession: [H], EnumMacTable: [H], EnumIpTable: [H], EnumNAT: [H], EnumDHCP: [H], GetSecureNATStatus: [H],
    GetHubAdminOptions: [H], GetHubExtOptions: [H], EnumCrl: [H], GetAcList: [H], GetHubMsg: [H],
    GetDefaultHubAdminOptions: [{}, H],
    GetCa: [{ ...H, Key_u32: (enumCa.CAList as { Key_u32: number }[])[0]?.Key_u32 ?? 0 }],
    GetCrl: [{ ...H, Key_u32: (enumCrl.CRLList as { Key_u32: number }[])[0]?.Key_u32 ?? 0 }],
    GetLink: [{ HubName_Ex_str: HUB, AccountName_utf: LINK }],
    GetLinkStatus: [{ HubName_Ex_str: HUB, AccountName_utf: LINK }, { HubName_Ex_str: HUB, AccountName_utf: ONLINE_LINK }],
    GetUser: [{ ...H, Name_str: USER }],
    GetGroup: [{ ...H, Name_str: GROUP }],
    GetSessionStatus: [{ ...H, Name_str: natSession }, { HubName_str: "TARGETHUB", Name_str: cascadeSession }],
    GetSecureNATOption: [{ RpcHubName_str: HUB }],
    GetConnectionInfo: [{ Name_str: adminConn }],
    EnumL3If: [{ Name_str: L3SW }], EnumL3Table: [{ Name_str: L3SW }],
    ReadLogFile: [{ FilePath_str: logFile, Offset_u32: 0 }],
    GetEtherIpId: [{ Id_str: ETHERIP_ID }],
    GetProtoOptions: [{ Protocol_str: "OpenVPN" }, { Protocol_str: "SSTP" }, { Protocol_str: "WireGuard" }],
  };
  const readMethods = Object.values(catalogMethods).filter((m) => m.risk === "read" || m.name === "GetConfig").map((m) => m.name).sort();
  const compared: { method: string; params: Record<string, unknown>; status: string; ok: boolean; detail: string }[] = [];
  for (const method of readMethods) {
    const paramSets = plan[method] ?? [{}];
    for (const params of paramSets) {
      // Alternate the order so time-dependent fields are not systematically biased
      const n = await outcome(native(method, params));
      const j = await outcome(json(method, params));
      let status: string, ok: boolean, detail = "";
      if (n.ok && j.ok) {
        const c = compareMethod(method, n.value, j.value);
        ok = c.equal;
        status = c.exact ? "equal" : c.equal ? "equal (volatile fields ignored)" : "DIFFERENT";
        detail = c.equal ? (c.ignored.length ? `ignored: ${c.ignored.join(", ")}` : `${Object.keys(n.value).length} keys`)
          : c.unexplained.slice(0, 4).map((d) => `${d.path}: native=${short(JSON.stringify(d.a), 60)} json=${short(JSON.stringify(d.b), 60)}`).join("; ");
      } else if (!n.ok && !j.ok) {
        ok = n.code !== undefined && n.code === j.code;
        status = ok ? "same error" : "DIFFERENT errors";
        detail = `native: ${n.error}; json: ${j.error}`;
      } else {
        ok = false;
        status = "DIFFERENT (one side failed)";
        detail = `native: ${n.ok ? "ok" : n.error}; json: ${j.ok ? "ok" : j.error}`;
      }
      compared.push({ method, params, status, ok, detail });
      record(C, method, params, ok, status, detail);
    }
  }

  // 3b. Idempotent writes: the same Set* request (the current settings) through both transports must
  //     produce the same response (covers the result conversion of the Set* RPCs as well).
  const P = "idempotent write: native vs JSON-RPC response";
  const crlKey = (enumCrl.CRLList as { Key_u32: number }[])[0]?.Key_u32 ?? 0;
  const pairs: [string, string | null, Record<string, unknown>][] = [
    ["SetHub", "GetHub", H], ["SetHubRadius", "GetHubRadius", H], ["SetHubLog", "GetHubLog", H],
    ["SetUser", "GetUser", { ...H, Name_str: USER }], ["SetGroup", "GetGroup", { ...H, Name_str: GROUP }],
    ["SetLink", "GetLink", { HubName_Ex_str: HUB, AccountName_utf: LINK }], ["SetSecureNATOption", "GetSecureNATOption", { RpcHubName_str: HUB }],
    ["SetAcList", "GetAcList", H], ["SetAccessList", "EnumAccess", H], ["SetHubMsg", "GetHubMsg", H], ["SetCrl", "GetCrl", { ...H, Key_u32: crlKey }],
    ["SetHubAdminOptions", "GetHubAdminOptions", H], ["SetHubExtOptions", "GetHubExtOptions", H],
    ["SetKeep", "GetKeep", {}], ["SetSysLog", "GetSysLog", {}], ["SetIPsecServices", "GetIPsecServices", {}],
    ["SetOpenVpnSstpConfig", "GetOpenVpnSstpConfig", {}], ["SetDDnsInternetSetting", "GetDDnsInternetSetting", {}],
    ["SetSpecialListener", "GetSpecialListener", {}], ["SetServerCipher", "GetServerCipher", {}], ["SetPortsUDP", "GetPortsUDP", {}],
    ["SetProtoOptions", "GetProtoOptions", { Protocol_str: "OpenVPN" }], ["SetAzureStatus", "GetAzureStatus", {}],
    ["SetHubOnline", null, { HubName_str: HUB, Online_bool: true }], ["EnableListener", null, { Port_u32: PORT, Enable_bool: true }],
    ["SetLinkOffline", null, { HubName_str: HUB, AccountName_utf: LINK }],
  ];
  for (const [set, get, params] of pairs) {
    // SetCrl re-creates the entry under a new key: look the key up again before each call
    const fresh = async () => set === "SetCrl" ? { ...params, Key_u32: ((await json("EnumCrl", H)).CRLList as { Key_u32: number }[])[0]?.Key_u32 ?? 0 } : params;
    const reqFor = async () => { const p = await fresh(); return get ? { ...p, ...(await json(get, p)) } : p; };
    const n = await outcome(native(set, await reqFor()));
    const j = await outcome(json(set, await reqFor()));
    let ok: boolean, status: string, detail = "";
    if (n.ok && j.ok) {
      const c = compareMethod(set, n.value, j.value);
      ok = c.equal;
      status = c.exact ? "same response" : c.equal ? "same response (volatile fields ignored)" : "DIFFERENT";
      detail = c.equal ? `${Object.keys(n.value).length} keys` : c.unexplained.slice(0, 4).map((d) => `${d.path}: native=${short(JSON.stringify(d.a), 60)} json=${short(JSON.stringify(d.b), 60)}`).join("; ");
    } else if (!n.ok && !j.ok) {
      ok = n.code !== undefined && n.code === j.code;
      status = ok ? "same error" : "DIFFERENT errors";
      detail = `native: ${n.error}; json: ${j.error}`;
    } else {
      ok = false;
      status = "DIFFERENT (one side failed)";
      detail = `native: ${n.ok ? "ok" : n.error}; json: ${j.ok ? "ok" : j.error}`;
    }
    record(P, set, get ? `(current ${get} result)` : params, ok, status, detail);
  }

  // 3c. Twin writes: the same operation on twin objects (TWIN-N natively, TWIN-J through JSON-RPC); the
  //     responses must be identical once the twin names are mapped. Covers the result conversion of the
  //     Create/Add/Delete/Rename/Start/Stop RPCs whose OutRpc functions no read method uses.
  const TW = TW_SECTION;
  const NH = "TWIN-N", JH = "TWIN-J";
  const twinMap: [string, string][] = [[JH, NH], ["l3-j", "l3-n"]];
  async function twin(method: string, nParams: Record<string, unknown>, jParams: Record<string, unknown>, extraMap: [string, string][] = [], volatileKeys: RegExp | null = null) {
    const n = await outcome(native(method, nParams));
    const j = await outcome(json(method, jParams));
    let ok: boolean, status: string, detail = "";
    if (n.ok && j.ok) {
      let text = JSON.stringify(j.value);
      for (const [from, to] of [...twinMap, ...extraMap]) text = text.split(from).join(to);
      const diffs = deepDiff(n.value, JSON.parse(text)).filter((d) => !(volatileKeys && volatileKeys.test(d.path)));
      ok = diffs.length === 0;
      status = ok ? (volatileKeys ? "same response (per-object keys ignored)" : "same response") : "DIFFERENT";
      detail = ok ? `${Object.keys(n.value).length} keys` : diffs.slice(0, 4).map((d) => `${d.path}: native=${short(JSON.stringify(d.a), 60)} json=${short(JSON.stringify(d.b), 60)}`).join("; ");
    } else if (!n.ok && !j.ok) {
      ok = n.code !== undefined && n.code === j.code;
      status = ok ? "same error" : "DIFFERENT errors";
      detail = `native: ${n.error}; json: ${j.error}`;
    } else {
      ok = false;
      status = "DIFFERENT (one side failed)";
      detail = `native: ${n.ok ? "ok" : n.error}; json: ${j.ok ? "ok" : j.error}`;
    }
    record(TW, method, nParams, ok, status, detail);
  }
  const both = (p: (h: string, l3: string) => Record<string, unknown>) => [p(NH, "l3-n"), p(JH, "l3-j")] as const;
  await twin("CreateHub", ...both((h) => ({ HubName_str: h, AdminPasswordPlainText_str: HUB_PW, Online_bool: true, MaxSession_u32: 10, NoEnum_bool: false, HubType_u32: 0 })));
  await twin("EnableSecureNAT", ...both((h) => ({ HubName_str: h })));
  await twin("CreateGroup", ...both((h) => ({ HubName_str: h, Name_str: "grp", Realname_utf: "Grp", Note_utf: "n" })));
  await twin("CreateUser", ...both((h) => ({ HubName_str: h, Name_str: "usr", GroupName_str: "grp", Realname_utf: "Usr", AuthType_u32: 1, Auth_Password_str: "pw-usr-1" })),
    [], /CreatedTime_dt|UpdatedTime_dt|HashedKey_bin|NtLmSecureHash_bin/);
  const rule = { Note_utf: "twin rule", Active_bool: true, Priority_u32: 5, Discard_bool: false, IsIPv6_bool: false, SrcIpAddress_ip: "172.16.0.0",
    SrcSubnetMask_ip: "255.240.0.0", Protocol_u32: 17, DestPortStart_u32: 53, DestPortEnd_u32: 53 };
  await twin("AddAccess", ...both((h) => ({ HubName_str: h, AccessListSingle: [rule] })));
  await twin("AddCa", ...both((h) => ({ HubName_str: h, Cert_bin: certs.caDer.toString("base64") })));
  await twin("AddCrl", ...both((h) => ({ HubName_str: h, CommonName_utf: "twin revoked", Serial_bin: "AQI=" })));
  await twin("CreateLink", ...both((h) => ({ HubName_Ex_str: h, AccountName_utf: "lnk", Online_bool: false, Hostname_str: "twin.example.invalid", Port_u32: 443,
    HubName_str: "X", AuthType_u32: 0, Username_str: "u" })));
  await twin("RenameLink", ...both((h) => ({ HubName_str: h, OldAccountName_utf: "lnk", NewAccountName_utf: "lnk2" })));
  await twin("AddL3Switch", ...both((_h, l3) => ({ Name_str: l3 })));
  await twin("AddL3If", ...both((h, l3) => ({ Name_str: l3, HubName_str: h, IpAddress_ip: "10.210.0.1", SubnetMask_ip: "255.255.255.0" })));
  await twin("AddL3Table", ...both((_h, l3) => ({ Name_str: l3, NetworkAddress_ip: "10.211.0.0", SubnetMask_ip: "255.255.0.0", GatewayAddress_ip: "10.210.0.254", Metric_u32: 3 })));
  await twin("StartL3Switch", ...both((_h, l3) => ({ Name_str: l3 })));
  await twin("StopL3Switch", ...both((_h, l3) => ({ Name_str: l3 })));
  await twin("DelL3Table", ...both((_h, l3) => ({ Name_str: l3, NetworkAddress_ip: "10.211.0.0", SubnetMask_ip: "255.255.0.0", GatewayAddress_ip: "10.210.0.254", Metric_u32: 3 })));
  await twin("DelL3If", ...both((h, l3) => ({ Name_str: l3, HubName_str: h, IpAddress_ip: "10.210.0.1", SubnetMask_ip: "255.255.255.0" })));
  await twin("DelL3Switch", ...both((_h, l3) => ({ Name_str: l3 })));
  {
    const idOf = async (h: string) => ((await json("EnumAccess", { HubName_str: h })).AccessList as { Id_u32: number }[])[0]?.Id_u32 ?? 0;
    await twin("DeleteAccess", { HubName_str: NH, Id_u32: await idOf(NH) }, { HubName_str: JH, Id_u32: await idOf(JH) }, [], /Id_u32/);
    const caOf = async (h: string) => ((await json("EnumCa", { HubName_str: h })).CAList as { Key_u32: number }[])[0]?.Key_u32 ?? 0;
    await twin("DeleteCa", { HubName_str: NH, Key_u32: await caOf(NH) }, { HubName_str: JH, Key_u32: await caOf(JH) }, [], /Key_u32/);
    const sesOf = async (h: string) => ((await json("EnumSession", { HubName_str: h })).SessionList as { Name_str: string }[]).find((x) => /SECURENAT/i.test(x.Name_str))?.Name_str ?? "";
    const sn = await sesOf(NH), sj = await sesOf(JH);
    await twin("DeleteSession", { HubName_str: NH, Name_str: sn }, { HubName_str: JH, Name_str: sj }, [[sj, sn]]);
    const macOf = async (h: string) => ((await json("EnumMacTable", { HubName_str: h })).MacTable as { Key_u32: number }[] | undefined)?.[0]?.Key_u32;
    const mn = await macOf(NH), mj = await macOf(JH);
    if (mn !== undefined && mj !== undefined) await twin("DeleteMacTable", { HubName_str: NH, Key_u32: mn }, { HubName_str: JH, Key_u32: mj }, [], /Key_u32/);
    else await twin("DeleteMacTable", { HubName_str: NH, Key_u32: 1 }, { HubName_str: JH, Key_u32: 1 }); // no entries: both must fail alike
  }
  await twin("DisableSecureNAT", ...both((h) => ({ HubName_str: h })));
  await twin("DeleteUser", ...both((h) => ({ HubName_str: h, Name_str: "usr" })));
  await twin("DeleteGroup", ...both((h) => ({ HubName_str: h, Name_str: "grp" })));
  await twin("SetServerPassword", { PlainTextPassword_str: ADMIN_PW }, { PlainTextPassword_str: ADMIN_PW });
  {
    // Two hub-admin connections to disconnect, one through each transport
    await native("GetHub", { HubName_str: NH }, { ...admin, hub: NH, password: HUB_PW });
    await native("GetHub", { HubName_str: JH }, { ...admin, hub: JH, password: HUB_PW });
    const cl = await json("EnumConnection");
    const adm = (cl.ConnectionList as { Name_str: string; Type_u32: number }[]).filter((c) => c.Type_u32 === 5).map((c) => c.Name_str);
    if (adm.length >= 2) await twin("DisconnectConnection", { Name_str: adm[adm.length - 2] }, { Name_str: adm[adm.length - 1] }, [[adm[adm.length - 1], adm[adm.length - 2]]]);
    else record(TW, "DisconnectConnection", undefined, false, `only ${adm.length} admin connection(s) found`);
  }
  await twin("DeleteHub", ...both((h) => ({ HubName_str: h })));
  {
    // DeleteSession on the cascade's session in TARGETHUB, natively; the cascade reconnects and the new session
    // is deleted through JSON-RPC
    const cascadeIn = async () => ((await json("EnumSession", { HubName_str: "TARGETHUB" })).SessionList as { Name_str: string }[])
      .map((x) => x.Name_str).find((x) => /linkuser/i.test(x));
    const first = await cascadeIn();
    let second: string | undefined;
    if (first) {
      const n = await outcome(native("DeleteSession", { HubName_str: "TARGETHUB", Name_str: first }));
      await waitFor(async () => { second = await cascadeIn(); return !!second && second !== first; }, "cascade to reconnect", 60_000).catch(() => undefined);
      if (n.ok && second) {
        const j = await outcome(json("DeleteSession", { HubName_str: "TARGETHUB", Name_str: second }));
        const same = j.ok && isDeepStrictEqual(n.value, JSON.parse(JSON.stringify(j.value).split(second).join(first)));
        record(TW, "DeleteSession (cascade session)", { HubName_str: "TARGETHUB", Name_str: first }, same, same ? "same response" : "DIFFERENT",
          `native ${JSON.stringify(n.value)}; json ${j.ok ? JSON.stringify(j.value) : j.error}`);
      } else {
        record(TW, "DeleteSession (cascade session)", undefined, n.ok, n.ok ? "native ok; cascade did not reconnect in time for the JSON-RPC twin" : n.error);
      }
    }
  }

  // 4. Scenarios ---------------------------------------------------------------------------------------
  const S = "scenario";
  // Hub-admin mode (hub password), same methods through both transports
  {
    const hubEp: Endpoint = { ...admin, hub: HUB, password: HUB_PW };
    for (const [method, params] of [["GetHub", H], ["EnumUser", H], ["EnumHub", {}], ["GetServerInfo", {}], ["GetServerStatus", {}], ["GetUser", { ...H, Name_str: USER }], ["EnumHub", { HubName_str: "OTHER" }]] as [string, Record<string, unknown>][]) {
      const n = await outcome(native(method, params, hubEp));
      const j = await outcome(json(method, params, HUB, HUB_PW));
      const same = n.ok && j.ok ? compareMethod(method, n.value, j.value).equal : (!n.ok && !j.ok && n.code === j.code);
      record(S, `hub-admin mode: ${method}`, params, same, n.ok && j.ok ? "same result" : `native ${n.ok ? "ok" : n.error} / json ${j.ok ? "ok" : j.error}`);
    }
    const wrongHub = await outcome(native("GetHub", H, { ...hubEp, password: "wrong" }));
    const wrongHubJ = await outcome(json("GetHub", H, HUB, "wrong"));
    record(S, "hub-admin mode, wrong hub password", undefined, !wrongHub.ok && wrongHub.kind === "auth" && !wrongHubJ.ok,
      `native ${wrongHub.ok ? "ok" : wrongHub.error}; json ${wrongHubJ.ok ? "ok" : wrongHubJ.error}`);
    const noHub = await outcome(native("GetHub", { HubName_str: "NOSUCHHUB" }, { ...hubEp, hub: "NOSUCHHUB" }));
    record(S, "hub-admin mode, nonexistent hub", undefined, !noHub.ok && noHub.kind === "auth", `native ${noHub.ok ? "ok" : noHub.error}`);
  }
  // Wrong admin password
  {
    let caught: unknown;
    try { await native("Test", { IntValue_u32: 1 }, { ...admin, password: "definitely-wrong" }); } catch (e) { caught = e; }
    const j = await outcome(json("Test", { IntValue_u32: 1 }, "", "definitely-wrong"));
    const ce = caught as InstanceType<typeof ConnectionError> & { softEtherCode?: number };
    record(S, "wrong admin password", undefined, caught instanceof ConnectionError && ce.kind === "auth" && ce.softEtherCode === 12 && !j.ok,
      `native: ${ce?.name}(${ce?.kind}) code ${ce?.softEtherCode} "${ce?.message}"; json: ${j.ok ? "ok" : j.error} (app's JSON-RPC client maps 401/403 to ConnectionError(auth))`);
  }
  // Invalid parameters (the JSON-RPC parser rejects negative/fractional numbers)
  {
    const n = await outcome(native("Test", { IntValue_u32: -1 }));
    record(S, "invalid number parameter (-1)", undefined, !n.ok && n.code === 38, `native ${n.ok ? "ok" : n.error} (JSON-RPC answers ERR_INVALID_PARAMETER for unparsable JSON)`);
    const lc = await outcome(native("enumhub", {}));
    const lcj = await outcome(json("enumhub", {}));
    record(S, "method names are case-insensitive (\"enumhub\")", undefined, lc.ok && lcj.ok && isDeepStrictEqual(lc.value, lcj.value),
      lc.ok ? `same result as JSON-RPC: ${JSON.stringify(lc.value).slice(0, 80)}` : lc.error);
    const u = await outcome(native("NoSuchMethod", {}));
    const uj = await outcome(json("NoSuchMethod", {}));
    record(S, "unknown method", undefined, !u.ok && !uj.ok && u.code === uj.code, `native ${u.ok ? "ok" : u.error}; json ${uj.ok ? "ok" : uj.error}`);
  }
  // TLS pinning
  const fp = await probeFingerprint();
  {
    const good = await outcome(native("Test", { IntValue_u32: 2 }, { ...admin, tlsMode: "pin", fingerprint: fp.toLowerCase().replace(/:/g, "") }));
    record(S, "TLS pin: correct fingerprint", undefined, good.ok, good.ok ? "connected" : good.error);
    let caught: unknown;
    const bad = "AA:" + fp.slice(3);
    try { await native("Test", { IntValue_u32: 2 }, { ...admin, tlsMode: "pin", fingerprint: bad }); } catch (e) { caught = e; }
    const ce = caught as InstanceType<typeof ConnectionError>;
    record(S, "TLS pin: wrong fingerprint", undefined, caught instanceof ConnectionError && ce.kind === "tls-mismatch" && ce.presentedFingerprint === fp,
      `${ce?.kind}: presented ${ce?.presentedFingerprint}`);
    const caSelf = await outcome(native("Test", { IntValue_u32: 2 }, { ...admin, tlsMode: "ca", caPem: certs.caPem }));
    record(S, "TLS ca: untrusted server certificate", undefined, !caSelf.ok && caSelf.kind === "tls", caSelf.ok ? "connected?!" : caSelf.error);
  }
  // IPv6
  {
    const listens6 = await new Promise<boolean>((r) => { const s = net.connect({ host: "::1", port: PORT }, () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
    if (listens6) {
      for (const host of ["::1", "[::1]"]) {
        const o = await outcome(native("GetServerInfo", {}, { ...admin, host }));
        const j = await outcome(json("GetServerInfo"));
        record(S, `IPv6 host ${host}`, undefined, o.ok && j.ok && isDeepStrictEqual(o.value, j.value), o.ok ? "same GetServerInfo as over IPv4 JSON-RPC" : o.error);
      }
    } else {
      record(S, "IPv6 ::1", undefined, true, "skipped: the server does not listen on ::1 here");
    }
  }
  // Session reuse, serialization, ephemeral calls, idle close
  {
    closeNativeSessions();
    const c0 = tlsConnects;
    for (let i = 0; i < 25; i++) await native("Test", { IntValue_u32: i });
    const par = await Promise.all(Array.from({ length: 10 }, (_, i) => native("Test", { IntValue_u32: 1000 + i })));
    const orderOk = par.every((r, i) => r.IntValue_u32 === 1000 + i);
    record(S, "session reuse: 25 sequential + 10 concurrent calls", undefined, tlsConnects - c0 === 1 && orderOk,
      `${tlsConnects - c0} TLS connection(s); concurrent answers matched their requests: ${orderOk}`);
    const c1 = tlsConnects;
    for (let i = 0; i < 3; i++) await native("Test", { IntValue_u32: i }, admin, { ephemeral: true });
    record(S, "ephemeral calls", undefined, tlsConnects - c1 === 3 && nativeSessionStats().sessions === 1,
      `${tlsConnects - c1} connections for 3 ephemeral calls; pooled sessions: ${nativeSessionStats().sessions}`);
    const c2 = tlsConnects;
    await new Promise((r) => setTimeout(r, Number(process.env.SEM_NATIVE_IDLE_MS) + 1500));
    const pooledAfterIdle = nativeSessionStats().sessions;
    const again = await outcome(native("Test", { IntValue_u32: 5 }));
    record(S, `idle close after ${process.env.SEM_NATIVE_IDLE_MS} ms`, undefined, pooledAfterIdle === 0 && again.ok && tlsConnects - c2 === 1,
      `pool after idle: ${pooledAfterIdle}; next call ok=${again.ok} with ${tlsConnects - c2} new connection`);
  }
  // Server drops the admin connection (DisconnectConnection): next call must reconnect transparently
  {
    await native("Test", { IntValue_u32: 1 });
    const cl = await json("EnumConnection");
    const mine = (cl.ConnectionList as { Name_str: string; Type_u32: number }[]).filter((c) => c.Type_u32 === 5);
    for (const c of mine) await json("DisconnectConnection", { Name_str: c.Name_str }).catch(() => undefined);
    const r0 = nativeSessionStats().reconnects, c0 = tlsConnects;
    const o = await outcome(native("Test", { IntValue_u32: 9 }));
    record(S, "server drops the admin connection", undefined, o.ok && tlsConnects - c0 === 1,
      `${o.ok ? "call succeeded" : o.error}; new connections ${tlsConnects - c0}, retried in-flight: ${nativeSessionStats().reconnects - r0 > 0}`);
  }
  // A pooled connection found dead when the next call starts: reconnect once and repeat (RpcCall + AdminReconnect)
  {
    closeNativeSessions();
    await native("Test", { IntValue_u32: 1 });
    const r0 = nativeSessionStats().reconnects, c0 = tlsConnects;
    lastSocket!.destroy(); // the pool learns about it only after the call below has picked the session
    const o = await outcome(native("Test", { IntValue_u32: 77 }));
    record(S, "reused connection dead at call time", undefined, o.ok && o.value.IntValue_u32 === 77 && nativeSessionStats().reconnects - r0 === 1 && tlsConnects - c0 === 1,
      `${o.ok ? "call succeeded" : o.error}; transparent reconnects ${nativeSessionStats().reconnects - r0}; new connections ${tlsConnects - c0}`);
  }
  // Authentication failures are not retried (one login attempt; server-admin mode adds one empty-password probe)
  {
    const c0 = tlsConnects;
    await outcome(native("Test", {}, { ...admin, hub: HUB, password: "nope" }));
    const hubCost = tlsConnects - c0;
    const c1 = tlsConnects;
    await outcome(native("Test", {}, { ...admin, password: "nope" }));
    record(S, "auth failures are not retried", undefined, hubCost === 1 && tlsConnects - c1 === 2,
      `hub-admin: ${hubCost} connection; server-admin: ${tlsConnects - c1} connections (password + empty-password probe)`);
  }
  // Timeouts, refused connections, non-SoftEther servers
  {
    const silent = net.createServer(() => { /* accept and never answer */ });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const port = (silent.address() as net.AddressInfo).port;
    const t1 = Date.now();
    let caught: unknown;
    try { await callNativeRpc({ ...admin, port }, "Test", {}, 1500); } catch (e) { caught = e; }
    const dt = Date.now() - t1;
    record(S, "silent TCP server (timeout 1500 ms)", undefined, caught instanceof ConnectionError && (caught as { kind: string }).kind === "timeout" && dt < 3000,
      `${(caught as Error)?.name}(${(caught as { kind?: string })?.kind}) after ${dt} ms`);
    silent.close();

    const web = https.createServer({ key: certs.srvKeyPem, cert: certs.srvPem }, (_req, res) => { res.writeHead(404, { "content-type": "text/html" }); res.end("<html>nope</html>"); });
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
    const wport = (web.address() as net.AddressInfo).port;
    const w = await outcome(callNativeRpc({ ...admin, port: wport }, "Test", {}, 5000));
    record(S, "plain HTTPS server (not SoftEther)", undefined, !w.ok && w.kind === "protocol", w.ok ? "ok?!" : w.error);
    web.close();
    web.closeAllConnections();

    const refused = await outcome(callNativeRpc({ ...admin, port: 1 }, "Test", {}, 5000));
    record(S, "connection refused", undefined, !refused.ok && refused.kind === "network", refused.ok ? "ok?!" : refused.error);
  }
  // Empty administrator password (vpnsmgr's accept_empty_password path) and JSON-RPC's "any password" rule
  {
    await native("SetServerPassword", { PlainTextPassword_str: "" });
    closeNativeSessions();
    const empty = await outcome(native("GetServerInfo", {}, { ...admin, password: "" }));
    const anyN = await outcome(native("GetServerInfo", {}, { ...admin, password: "anything" }));
    const anyJ = await outcome(json("GetServerInfo", {}, "", "anything"));
    record(S, "empty admin password: native with \"\"", undefined, empty.ok, empty.ok ? "logged in" : empty.error);
    record(S, "empty admin password: any password", undefined, anyN.ok && anyJ.ok,
      `native ${anyN.ok ? "ok" : anyN.error} / json ${anyJ.ok ? "ok" : anyJ.error} (JSON-RPC accepts any password while the admin password is empty; native retries with the empty password)`);
    await native("SetServerPassword", { PlainTextPassword_str: ADMIN_PW }, { ...admin, password: "" });
    closeNativeSessions();
    const back = await outcome(native("Test", { IntValue_u32: 1 }));
    const oldEmpty = await outcome(native("Test", { IntValue_u32: 1 }, { ...admin, password: "" }));
    record(S, "password restored", undefined, back.ok && !oldEmpty.ok && oldEmpty.kind === "auth", `new password ok=${back.ok}; empty password now ${oldEmpty.ok ? "accepted?!" : oldEmpty.error}`);
  }
  // SetServerCert (native) then TLS "ca" mode against our own CA-less self-signed server cert with IP SANs
  {
    const o = await outcome(native("SetServerCert", { Cert_bin: certs.srvDer.toString("base64"), Key_bin: certs.srvKeyDer.toString("base64") }));
    closeNativeSessions();
    const fp2 = await probeFingerprint();
    const expected = normalizeFingerprint(execFileSync("openssl", ["x509", "-in", path.join(RUN_DIR, "certs/srv.pem"), "-noout", "-fingerprint", "-sha256"]).toString().split("=")[1]);
    record(W, "SetServerCert", { Cert_bin: "(srv.der)", Key_bin: "(srv.key.der)" }, o.ok && fp2 === expected, o.ok ? `server now presents ${fp2}` : o.error);
    const ca = await outcome(native("Test", { IntValue_u32: 3 }, { ...admin, tlsMode: "ca", caPem: certs.srvPem }));
    record(S, "TLS ca: trusted certificate with IP SAN", undefined, ca.ok, ca.ok ? "verified and connected" : ca.error);
    const pin = await outcome(native("Test", { IntValue_u32: 3 }, { ...admin, tlsMode: "pin", fingerprint: fp }));
    record(S, "TLS pin: old fingerprint after certificate change", undefined, !pin.ok && pin.kind === "tls-mismatch", pin.ok ? "ok?!" : pin.error);
  }
  // Cluster controller mode, so EnumFarmMember / GetFarmInfo / GetFarmSetting have data to compare
  {
    const caps = await native("GetCaps");
    if (caps.caps_b_support_cluster_u32 === 1 || (caps.CapsList as { CapsName_str: string; CapsValue_u32: number }[] | undefined)?.some((c) => c.CapsName_str === "b_support_cluster" && c.CapsValue_u32 === 1)) {
      const set = await outcome(native("SetFarmSetting", { ServerType_u32: 1, NumPort_u32: 1, Ports_u32: [PORT], PublicIp_ip: "127.0.0.1", Weight_u32: 100, ControllerOnly_bool: false, MemberPasswordPlaintext_str: "farm-pw" }));
      await new Promise((r) => setTimeout(r, 1500));
      await waitReady();
      let members: Record<string, unknown> = {};
      await waitFor(async () => { members = await json("EnumFarmMember"); return ((members.FarmMemberList as unknown[]) ?? []).length > 0; }, "farm member list", 20_000).catch(() => undefined);
      record(W, "SetFarmSetting (controller)", undefined, set.ok && ((members.FarmMemberList as unknown[]) ?? []).length > 0, set.ok ? `farm members: ${JSON.stringify(members).slice(0, 160)}` : set.error);
      const id = ((members.FarmMemberList as { Id_u32: number }[]) ?? [])[0]?.Id_u32 ?? 0;
      for (const [method, params] of [["GetFarmSetting", {}], ["EnumFarmMember", {}], ["GetFarmInfo", { Id_u32: id }], ["GetServerStatus", {}], ["EnumHub", {}]] as [string, Record<string, unknown>][]) {
        const n = await outcome(native(method, params));
        const j = await outcome(json(method, params));
        const c = n.ok && j.ok ? compareMethod(method, n.value, j.value) : null;
        const ok = c ? c.equal : (!n.ok && !j.ok && n.code === j.code);
        record(C, `${method} (cluster controller)`, params, ok, c ? (c.exact ? "equal" : c.equal ? "equal (volatile fields ignored)" : "DIFFERENT") : `native ${n.ok ? "ok" : n.error} / json ${j.ok ? "ok" : j.error}`,
          c && !c.equal ? c.unexplained.slice(0, 4).map((d) => `${d.path}: native=${short(JSON.stringify(d.a), 60)} json=${short(JSON.stringify(d.b), 60)}`).join("; ") : c?.ignored.length ? `ignored: ${c.ignored.join(", ")}` : "");
      }
      const back = await outcome(native("SetFarmSetting", { ServerType_u32: 0, NumPort_u32: 0, Ports_u32: [], Weight_u32: 100 }));
      await new Promise((r) => setTimeout(r, 1500));
      await waitReady();
      const st = await json("GetFarmSetting");
      record(W, "SetFarmSetting (back to standalone)", undefined, back.ok && st.ServerType_u32 === 0, back.ok ? `ServerType_u32=${st.ServerType_u32}` : back.error);
    } else {
      record(S, "cluster controller mode", undefined, true, "skipped: b_support_cluster is off in this build");
    }
  }
  // 5. Edge cases of the JSON -> PACK conversion (review): the same parameters are written through each
  //    transport and read back through JSON-RPC (or echoed by the Test RPC); both must give the same result.
  {
    const E = EDGE_SECTION;
    const EHUB = "EDGEHUB";
    await json("CreateHub", { HubName_str: EHUB, Online_bool: true, HubType_u32: 0 });
    await json("CreateUser", { HubName_str: EHUB, Name_str: "edge", AuthType_u32: 1, Auth_Password_str: "x" });
    const summary = (o: Outcome) => (o.ok ? short(JSON.stringify(o.value), 70) : o.error);
    // Test echoes IntValue (as StrValue "%u"), Int64Value and UniStrValue
    const echo: [string, Record<string, unknown>][] = [
      ["_u32 from \"0x1F\"", { IntValue_u32: "0x1F" }], ["_u32 from \"-1\"", { IntValue_u32: "-1" }], ["_u32 from 2^32+1", { IntValue_u32: 4294967297 }],
      ["_u32 array [5,6]", { IntValue_u32: [5, 6] }], ["_u32 empty array", { IntValue_u32: [] }], ["_u32 nested array", { IntValue_u32: [[5]] }],
      ["_u32 [null,7]", { IntValue_u32: [null, 7] }], ["case-insensitive duplicate keys", { IntValue_u32: 1, intvalue_u32: 2 }],
      ["same name, two types", { IntValue_u32: 1, IntValue_str: "2" }], ["_u64 2^53+1 as string", { Int64Value_u64: "9007199254740993" }],
      ["_u64 \"1,234\"", { Int64Value_u64: "1,234" }], ["_u64 2^64 (wraps)", { Int64Value_u64: 18446744073709551616 }],
      ["_u64 1.5 (rejected)", { Int64Value_u64: 1.5 }], ["negative in a nested object (rejected)", { x: { y: -1 }, IntValue_u32: 1 }],
      ["NUL inside strings", { StrValue_str: "a\u0000b", UniStrValue_utf: "c\u0000d" }], ["_utf from a number", { UniStrValue_utf: 12345678901234 }],
      ["_utf lone surrogate (rejected)", { UniStrValue_utf: "x\ud800y" }],
      ["_dt month 13 / day 40 / 25:61:61", { Int64Value_dt: "2030-13-40T25:61:61Z" }], ["_dt -05:00 suffix", { Int64Value_dt: "2030-06-15T12:34:56.7-05:00" }],
      ["_dt +09:00 suffix", { Int64Value_dt: "2030-06-15T12:34:56+09:00" }], ["_dt year 2300", { Int64Value_dt: "2300-01-01T00:00:00Z" }],
      ["_dt garbage", { Int64Value_dt: "yesterday" }], ["_bool from \" TRUE \"", { IntValue_bool: " TRUE " }],
    ];
    for (const [name, params] of echo) {
      const [n, j] = [await outcome(native("Test", params)), await outcome(json("Test", params))];
      const ok = n.ok === j.ok && (n.ok ? isDeepStrictEqual(n.value, (j as { value: unknown }).value) : n.code === j.code);
      record(E, `Test ${name}`, params, ok, ok ? `same: ${summary(n)}` : "DIFFERENT", ok ? "" : `native ${summary(n)} / json ${summary(j)}`);
    }
    async function roundTrip(name: string, method: string, params: Record<string, unknown>, get: string, pick: (r: Record<string, unknown>) => unknown) {
      const wn = await outcome(native(method, params));
      const rn = await outcome(json(get, { HubName_str: EHUB, Name_str: "edge" }));
      const wj = await outcome(json(method, params));
      const rj = await outcome(json(get, { HubName_str: EHUB, Name_str: "edge" }));
      const vn = rn.ok ? pick(rn.value) : rn.error, vj = rj.ok ? pick(rj.value) : rj.error;
      const ok = wn.ok === wj.ok && isDeepStrictEqual(vn, vj);
      record(E, name, params, ok, ok ? `same: ${short(JSON.stringify(vn ?? null), 70)}` : "DIFFERENT",
        ok ? "" : `native write ${wn.ok ? "ok" : wn.error} -> ${JSON.stringify(vn)} / JSON-RPC write ${wj.ok ? "ok" : wj.error} -> ${JSON.stringify(vj)}`);
    }
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const bins: [string, string][] = [
      ["spaces inside", "aGVs bG8="], ["CR/LF", "aGVs\nbG8=\r\n"], ["\"-\" ends the input", `${b64("abc")}-garbage`], ["no padding", "aGVsbG8"],
      ["bad character", "aGVs*G8="], ["bad character after 64 chars", `${b64("A".repeat(60))}!!!!`], ["data after padding", "aGk=aGk="],
      ["URL-safe alphabet", "_-8="], ["non-ASCII space", "aGVs bG8="],
    ];
    for (const [name, v] of bins) await roundTrip(`_bin ${name} (SetHubMsg -> GetHubMsg)`, "SetHubMsg", { HubName_str: EHUB, Msg_bin: v }, "GetHubMsg", (r) => r.Msg_bin ?? null);
    for (const ip of ["2001:db8::1", "fe80::1%5", "[::1]", "010.001.2.3", "1.2.3", "::ffff:1.2.3.4", "1::2::3", "::"]) {
      await roundTrip(`_ip ${JSON.stringify(ip)} (SetAcList -> GetAcList)`, "SetAcList", { HubName_str: EHUB, ACList: [{ Id_u32: 1, Deny_bool: true, Priority_u32: 1, Masked_bool: true, IpAddress_ip: ip, SubnetMask_ip: ip.includes(":") ? "ffff:ffff::" : "255.255.0.0" }] }, "GetAcList", (r) => r.ACList);
    }
    await roundTrip("_ip IPv4 + IPv6 entries (SetAcList -> GetAcList)", "SetAcList", { HubName_str: EHUB, ACList: [{ Id_u32: 1, Priority_u32: 1, IpAddress_ip: "1.2.3.4", SubnetMask_ip: "255.0.0.0" }, { Id_u32: 2, Priority_u32: 2, IpAddress_ip: "2001:db8::", SubnetMask_ip: "ffff::" }] }, "GetAcList", (r) => r.ACList);
    await roundTrip("empty array (SetAcList -> GetAcList)", "SetAcList", { HubName_str: EHUB, ACList: [] }, "GetAcList", (r) => r.ACList);
    for (const d of ["2030-06-15T12:34:56.789Z", "2099-12-31T23:59:59.999Z", "2300-01-01T00:00:00Z", "1971-02-01T00:00:00Z", 1893456000000]) {
      await roundTrip(`_dt ${d} (SetUser ExpireTime -> GetUser)`, "SetUser", { HubName_str: EHUB, Name_str: "edge", AuthType_u32: 1, Auth_Password_str: "x", ExpireTime_dt: d }, "GetUser", (r) => r.ExpireTime_dt);
    }
    // A "function_name_*" parameter: JSON-RPC runs the RPC it names (PackAddStr keeps the parameter); native always runs `method`
    {
      const params = { function_name_str: "GetServerInfo", IntValue_u32: 3 };
      const [n, j] = [await outcome(native("Test", params)), await outcome(json("Test", params))];
      const ok = n.ok && n.value.IntValue_u32 === 3 && j.ok && "ServerProductName_str" in j.value;
      record(E, "function_name_str parameter (deliberate difference)", params, ok,
        ok ? "native ran Test; JSON-RPC ran GetServerInfo" : `native ${summary(n)} / json ${summary(j)}`);
    }
    await json("DeleteHub", { HubName_str: EHUB });
  }
  // Deadlines and closeNativeSessions() with the server frozen (SIGSTOP on its process group)
  {
    const pg = (JSON.parse(readFileSync(path.join(RUN_DIR, "pids.json"), "utf8")) as number[])[0];
    const freeze = (on: boolean) => process.kill(-pg, on ? "SIGSTOP" : "SIGCONT");
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      closeNativeSessions();
      await native("Test", { IntValue_u32: 1 });
      const r0 = nativeSessionStats().reconnects, c0 = tlsConnects;
      freeze(true);
      const t0 = Date.now();
      const a = outcome(callNativeRpc(admin, "Test", { IntValue_u32: 2 }, 4000)).then((o) => ({ o, dt: Date.now() - t0 }));
      const b = await outcome(callNativeRpc(admin, "Test", { IntValue_u32: 3 }, 600)).then((o) => ({ o, dt: Date.now() - t0 }));
      await sleep(400);
      freeze(false);
      const ra = await a;
      const c = await outcome(native("Test", { IntValue_u32: 4 }));
      record(S, "queued call behind a stalled call honours its own timeout (600 ms)", undefined, !b.o.ok && b.o.kind === "timeout" && b.dt < 1100,
        `${b.o.ok ? "ok?!" : b.o.error} after ${b.dt} ms`);
      record(S, "dropping the queued call leaves the busy connection intact", undefined,
        ra.o.ok && c.ok && nativeSessionStats().reconnects === r0 && tlsConnects === c0,
        `stalled call ${ra.o.ok ? "answered" : ra.o.error} after ${ra.dt} ms (server resumed at ~1000 ms); next call ok=${c.ok}; new connections ${tlsConnects - c0}`);

      const silent = net.createServer(() => { /* never answers */ });
      await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
      const sep = { ...admin, port: (silent.address() as net.AddressInfo).port };
      const slow = outcome(callNativeRpc(sep, "Test", {}, 4000));
      await sleep(50);
      const t1 = Date.now();
      const fast = await outcome(callNativeRpc(sep, "Test", {}, 500));
      const dt1 = Date.now() - t1;
      record(S, "caller joining another caller's slow login honours its own timeout (500 ms)", undefined, !fast.ok && fast.kind === "timeout" && dt1 < 1100,
        `${fast.ok ? "ok?!" : fast.error} after ${dt1} ms (the other login has 4000 ms)`);
      await slow;
      silent.close();

      await native("Test", { IntValue_u32: 1 });
      freeze(true);
      const t2 = Date.now();
      const x = outcome(callNativeRpc(admin, "Test", { IntValue_u32: 5 }, 5000)).then((o) => ({ o, dt: Date.now() - t2 }));
      await sleep(200);
      const c2 = tlsConnects;
      closeNativeSessions();
      const rx = await x;
      freeze(false);
      record(S, "closeNativeSessions() during a call: no re-login with the old credentials", undefined,
        !rx.o.ok && rx.dt < 1500 && tlsConnects === c2 && nativeSessionStats().sessions === 0,
        `${rx.o.ok ? "ok?!" : rx.o.error} after ${rx.dt} ms; new connections ${tlsConnects - c2}; pooled sessions ${nativeSessionStats().sessions}`);
    } finally {
      try { freeze(false); } catch { /* gone */ }
    }
    await waitReady();
  }
  // Recovery after a server restart
  {
    await native("Flush"); // write the configuration to disk first: kill -9 skips the save on exit
    const c0 = tlsConnects;
    stopServer();
    await waitGone();
    startServer();
    await waitReady();
    const o = await outcome(native("GetServerInfo"));
    record(S, "server restart (kill -9 + start)", undefined, o.ok && tlsConnects - c0 === 1, o.ok ? `pooled session re-established (${tlsConnects - c0} new connection)` : o.error);
  }
  // SetConfig round trip (restarts the server core), then DeleteHub
  {
    const before = await native("GetConfig");
    const text = Buffer.from(String(before.FileData_bin), "base64").toString("utf8");
    record(S, "GetConfig size", undefined, text.length > 10_000, `${text.length} bytes of config text over native`);
    const edited = text.replace(/uint MaxConcurrentDnsClientThreads \d+/, "uint MaxConcurrentDnsClientThreads 513");
    const set = await outcome(native("SetConfig", { FileData_bin: Buffer.from(edited).toString("base64") }));
    await new Promise((r) => setTimeout(r, 2000));
    await waitReady();
    const after = await outcome(native("GetConfig"));
    const hubs = await outcome(native("EnumHub"));
    const ok = set.ok && after.ok && Buffer.from(String(after.value.FileData_bin), "base64").toString().includes("MaxConcurrentDnsClientThreads 513")
      && hubs.ok && JSON.stringify(hubs.value).includes(HUB);
    record(W, "SetConfig (round trip, server core restarts)", { FileData_bin: `(${text.length} bytes, 1 line changed)` }, ok,
      ok ? "edited config applied; hub survived; session re-established" : `set ${set.ok ? "ok" : set.error}; after ${after.ok ? "ok" : after.error}`);
    await write("DeleteHub", { HubName_str: HUB }, async () => { const r = await json("EnumHub"); return [!JSON.stringify(r).includes(HUB), JSON.stringify(r)]; });
  }

  closeNativeSessions();
  writeReport({ info, compared, seconds: Math.round((Date.now() - t0) / 1000) });
}

function writeReport(x: { info: Record<string, unknown>; compared: { method: string; params: Record<string, unknown>; status: string; ok: boolean; detail: string }[]; seconds: number }) {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines: string[] = [];
  const passed = rows.filter((r) => r.ok).length;
  lines.push("# Native PACK admin transport: verification report", "");
  lines.push(`Generated by \`tools/verify-native/run.ts\` on ${new Date().toISOString()} in ${x.seconds} s.`, "");
  lines.push(`**Result: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}** (${passed}/${rows.length} passed).`, "");
  lines.push("## Re-run", "", "```sh", "cd <repository root>", "node apps/desktop/tools/verify-native/run.ts", "```", "");
  lines.push("Requirements: SoftEther VPN built from source in `~/se-build/src/build` (override with `SE_BUILD_DIR`), `openssl` on PATH, Node 24.",
    "The run uses port 15701 and `~/se-desk-native` (override with `VERIFY_NATIVE_PORT` / `VERIFY_NATIVE_RUN_DIR`) and always kills the",
    "server's process group at the end. `python3 apps/desktop/tools/verify-native/gen-hints.py --check` verifies that the PackToJson hints",
    "in `src/main/softether/pack.ts` match the C source.", "");
  lines.push("## Server under test", "", `${x.info.ServerProductName_str} ${x.info.ServerVersionString_str} (${x.info.ServerBuildInfoString_str}), ${x.info.OsType_u32 !== undefined ? `OS type ${x.info.OsType_u32}` : ""} ${x.info.OsProductName_str ?? ""}`.trim(), "");
  const section = (title: string, sec: string, intro?: string) => {
    lines.push(`## ${title}`, "");
    if (intro) lines.push(intro, "");
    lines.push("| Check | Params | Result | Details |", "|---|---|---|---|");
    for (const r of rows.filter((q) => q.section === sec)) {
      lines.push(`| ${esc(r.name)} | ${r.params ? `\`${esc(r.params)}\`` : ""} | ${r.ok ? "PASS" : "**FAIL**"}: ${esc(r.result)} | ${esc(short(r.detail, 220))} |`);
    }
    lines.push("");
  };
  section("SHA-0", "sha0", "SoftEther hashes admin passwords with SHA-0 (not in Node's crypto); `sha0()` is checked against published vectors and against the hash the server itself stores.");
  section("Every read method: native vs JSON-RPC", "read: native vs JSON-RPC",
    "Each read-risk method of `packages/api-catalog` (plus GetConfig) is called through the native transport and through the server's JSON-RPC API with the same parameters; the two JSON results are deep-compared. \"same error\" means both transports returned the same SoftEther error code.");
  section("Writes over the native transport", "native write -> JSON-RPC read-back",
    "Each write is sent natively (params converted by the JsonToPack port) and its effect is read back through JSON-RPC.");
  section("Idempotent writes: native vs JSON-RPC response", "idempotent write: native vs JSON-RPC response",
    "Each Set* method is sent the object its Get* method currently returns (so nothing changes), once natively and once through JSON-RPC; the two responses are deep-compared.");
  section("Twin writes: native vs JSON-RPC response", TW_SECTION,
    "The same Create/Add/Delete/Rename/Start/Stop operation is applied to twin objects (hub TWIN-N natively, TWIN-J through JSON-RPC) and the responses are compared after mapping the twin names; per-object keys (Id/Key, creation times, password hashes with random salt) are ignored where noted.");
  section("Parameter edge cases: native vs JSON-RPC", EDGE_SECTION,
    "Unusual parameters (strings for numbers, wrapped/unsafe integers, arrays, duplicate keys, NUL and unpaired surrogates, malformed base64, IPv6/scoped/odd IP strings, out-of-range dates) go through each transport's JSON -> PACK conversion; the Test RPC echoes them, other writes are read back through JSON-RPC. Rejected inputs must fail with the same SoftEther error.");
  section("Scenarios", "scenario");
  // Which OutRpc*() result converters (Admin.c DECLARE_RPC table) were proven identical by at least one comparison
  const admin = readFileSync(path.join(HERE, "../../../../vendor/SoftEtherVPN/src/Cedar/Admin.c"), "latin1");
  const decl = [...admin.matchAll(/^\s*DECLARE_RPC(?:_EX)?\("(\w+)",\s*\w+,\s*\w+,\s*\w+,\s*(\w+)/gm)].map((m) => ({ rpc: m[1], out: m[2] }));
  const provenEqual = new Set(rows.filter((r) => r.ok && /^(read|idempotent|twin)/.test(r.section) && /^(equal|same response)/.test(r.result)).map((r) => r.name.replace(/ \(.*\)$/, "")));
  const byOut = new Map<string, string[]>();
  for (const d of decl) byOut.set(d.out, [...(byOut.get(d.out) ?? []), d.rpc]);
  const uncovered = [...byOut].filter(([, rpcs]) => !rpcs.some((r) => provenEqual.has(r)));
  lines.push("## Result-conversion coverage", "",
    `${byOut.size - uncovered.length} of the ${byOut.size} OutRpc*() result converters used by the ${decl.length} admin RPCs (Cedar/Admin.c DECLARE_RPC) were proven to give identical JSON through both transports by at least one comparison above (the hint table itself is generated for all ${decl.length} RPCs).`, "",
    "Not proven (no successful call possible here; both transports returned the same error where attempted):", "");
  for (const [out, rpcs] of uncovered) {
    const tried = rows.filter((r) => rpcs.includes(r.name.replace(/ \(.*\)$/, "")));
    lines.push(`* \`${out}\` (${rpcs.join(", ")}): ${tried.length ? tried.map((r) => r.result + (r.detail ? ` (${short(r.detail, 80)})` : "")).join("; ") : "not called (needs hardware/licensing/cluster member not available in this test)"}`);
  }
  lines.push("");
  lines.push("## Volatile fields ignored in comparisons", "", "| Reason | Methods where it hid a difference in this run |", "|---|---|");
  for (const v of VOLATILE) {
    const used = ignoredApplied.get(v.reason);
    lines.push(`| ${esc(v.reason)} (\`${v.path.source}\`) | ${used ? [...used].join(", ") : "(no difference in this run)"} |`);
  }
  lines.push("");
  writeFileSync(path.join(HERE, "REPORT.md"), lines.join("\n"));
  console.log(`\nREPORT: ${path.join(HERE, "REPORT.md")}  (${passed}/${rows.length} passed)`);
}

try {
  await main();
} catch (e) {
  console.error("FATAL", e);
  failures++;
  try { writeReport({ info: {}, compared: [], seconds: 0 }); } catch { /* ignore */ }
} finally {
  closeNativeSessions();
  stopServer();
}
process.exit(failures ? 1 : 0);
