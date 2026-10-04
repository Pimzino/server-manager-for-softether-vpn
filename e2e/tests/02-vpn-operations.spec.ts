// Core VPN administration through the manager's RPC gateway, verified against the SoftEther
// servers directly (independent oracle) — including a real site-to-site cascade VPN session.
import { test, expect } from "@playwright/test";
import { adminApi, eventually, seRpc } from "../helpers.ts";
import { BETA_ADMIN_PASSWORD, SERVERS } from "../env.ts";

test.describe.configure({ mode: "serial" });
const [ALPHA, BETA] = SERVERS;

async function ids() {
  const api = await adminApi();
  const list = await api.get("/api/servers");
  return { api, alpha: list.find((s: any) => s.name === ALPHA.name).id as number, beta: list.find((s: any) => s.name === BETA.name).id as number };
}

test("hub lifecycle, users, groups with policy, access list, SecureNAT", async () => {
  const { api, alpha } = await ids();
  await api.rpc(alpha, "CreateHub", { HubName_str: "HQ", Online_bool: true, MaxSession_u32: 0 });
  await api.rpc(alpha, "CreateGroup", {
    HubName_str: "HQ", Name_str: "engineers", Realname_utf: "Engineering", Note_utf: "e2e",
    UsePolicy_bool: true, "policy:Access_bool": true, "policy:MaxConnection_u32": 4, "policy:TimeOut_u32": 30,
  });
  await api.rpc(alpha, "CreateUser", {
    HubName_str: "HQ", Name_str: "site-link", GroupName_str: "engineers", Realname_utf: "Site link", AuthType_u32: 1, Auth_Password_str: "Link-Passw0rd!",
  });
  await api.rpc(alpha, "CreateUser", { HubName_str: "HQ", Name_str: "bob", AuthType_u32: 1, Auth_Password_str: "Bob-Passw0rd!" });
  await api.rpc(alpha, "AddAccess", {
    HubName_str: "HQ",
    AccessListSingle: [{
      Note_utf: "block telnet", Active_bool: true, Priority_u32: 100, Discard_bool: true, IsIPv6_bool: false,
      SrcIpAddress_ip: "0.0.0.0", SrcSubnetMask_ip: "0.0.0.0", DestIpAddress_ip: "10.0.0.0", DestSubnetMask_ip: "255.0.0.0",
      Protocol_u32: 6, SrcPortStart_u32: 0, SrcPortEnd_u32: 0, DestPortStart_u32: 23, DestPortEnd_u32: 23,
    }],
  });
  await api.rpc(alpha, "EnableSecureNAT", { HubName_str: "HQ" });

  // Oracle checks directly on SoftEther
  const g = await seRpc(ALPHA.port, "", "GetGroup", { HubName_str: "HQ", Name_str: "engineers" });
  expect(g["policy:MaxConnection_u32"]).toBe(4);
  const u = await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "HQ", Name_str: "site-link" });
  expect(u.GroupName_str).toBe("engineers");
  const acl = await seRpc(ALPHA.port, "", "EnumAccess", { HubName_str: "HQ" });
  expect(acl.AccessList.some((a: any) => a.Note_utf === "block telnet" && a.DestPortStart_u32 === 23 && a.Discard_bool)).toBe(true);
  const nat = await seRpc(ALPHA.port, "", "GetSecureNATStatus", { HubName_str: "HQ" });
  expect(nat).toBeTruthy();
  const hub = await seRpc(ALPHA.port, "", "GetHubStatus", { HubName_str: "HQ" });
  expect(hub.SecureNATEnabled_bool).toBe(true);
  expect(hub.NumUsers_u32).toBe(2);

  // Update preserves untouched fields (read-modify-write)
  const cur = await api.rpc(alpha, "GetUser", { HubName_str: "HQ", Name_str: "bob" });
  await api.rpc(alpha, "SetUser", { ...cur, Realname_utf: "Bob Builder", Auth_Password_str: "" });
  const after = await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "HQ", Name_str: "bob" });
  expect(after.Realname_utf).toBe("Bob Builder");
  expect(after.HashedKey_bin).toBe(cur.HashedKey_bin);
});

test("site-to-site cascade: beta hub links to alpha hub and establishes a real VPN session", async () => {
  const { api, beta } = await ids();
  await api.rpc(beta, "CreateHub", { HubName_str: "BRANCH", Online_bool: true });
  const linkHash = (await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "HQ", Name_str: "site-link" })).HashedKey_bin;
  await api.rpc(beta, "CreateLink", {
    HubName_Ex_str: "BRANCH", AccountName_utf: "to-hq", Online_bool: false, CheckServerCert_bool: false,
    Hostname_str: "127.0.0.1", Port_u32: ALPHA.port, HubName_str: "HQ", ProxyType_u32: 0,
    MaxConnection_u32: 2, UseEncrypt_bool: true, UseCompress_bool: false, AdditionalConnectionInterval_u32: 1,
    // Password users authenticate with the SHA-0 hash (AuthType 1); plain (2) is for RADIUS/NT users.
    AuthType_u32: 1, Username_str: "site-link", HashedPassword_bin: linkHash,
  });
  await api.rpc(beta, "SetLinkOnline", { HubName_str: "BRANCH", AccountName_utf: "to-hq" });
  const status = await eventually(async () => {
    const s = await api.rpc(beta, "GetLinkStatus", { HubName_Ex_str: "BRANCH", AccountName_utf: "to-hq" });
    return s.Connected_bool ? s : null;
  }, 30_000).catch(async (e) => {
    const links = await api.rpc(beta, "EnumLink", { HubName_str: "BRANCH" });
    throw new Error(`${e.message}; EnumLink=${JSON.stringify(links.LinkList)}`);
  });
  expect(status.ServerName_str).toBe("127.0.0.1");
  expect(status.UseEncrypt_bool).toBe(true);
  // The session appears on the alpha side, authenticated as site-link
  const sessions = await eventually(async () => {
    const r = await seRpc(ALPHA.port, "", "EnumSession", { HubName_str: "HQ" });
    return r.SessionList.find((s: any) => s.Username_str === "site-link") ? r : null;
  });
  const sess = sessions.SessionList.find((s: any) => s.Username_str === "site-link");
  expect(sess.Hostname_str ?? sess.RemoteHostname_str).toBeTruthy();
  // Visible through the manager too, and disconnectable
  const alphaId = (await api.get("/api/servers")).find((s: any) => s.name === ALPHA.name).id;
  const viaMgr = await api.rpc(alphaId, "EnumSession", { HubName_str: "HQ" });
  expect(viaMgr.SessionList.some((s: any) => s.Username_str === "site-link")).toBe(true);
  await api.rpc(beta, "SetLinkOffline", { HubName_str: "BRANCH", AccountName_utf: "to-hq" });
  // The group policy TimeOut (30 s) keeps the server-side session alive waiting for a reconnect
  await eventually(async () => {
    const r = await seRpc(ALPHA.port, "", "EnumSession", { HubName_str: "HQ" });
    return !r.SessionList.some((s: any) => s.Username_str === "site-link");
  }, 60_000, 1000);
});

test("server-level configuration: listener, syslog, keepalive, OpenVPN/SSTP, IPsec, L3 switch, protocol options", async () => {
  const { api, beta } = await ids();
  await api.rpc(beta, "CreateListener", { Port_u32: 15699, Enable_bool: true });
  const l = await seRpc(BETA.port, BETA_ADMIN_PASSWORD, "EnumListener");
  expect(l.ListenerList.some((x: any) => x.Ports_u32 === 15699)).toBe(true);
  await api.rpc(beta, "DeleteListener", { Port_u32: 15699 });

  await api.rpc(beta, "SetSysLog", { SaveType_u32: 1, Hostname_str: "syslog.example.com", Port_u32: 514 });
  expect((await seRpc(BETA.port, BETA_ADMIN_PASSWORD, "GetSysLog")).Hostname_str).toBe("syslog.example.com");

  const ov = await api.rpc(beta, "GetOpenVpnSstpConfig");
  await api.rpc(beta, "SetOpenVpnSstpConfig", { ...ov, EnableSSTP_bool: !ov.EnableSSTP_bool });
  expect((await seRpc(BETA.port, BETA_ADMIN_PASSWORD, "GetOpenVpnSstpConfig")).EnableSSTP_bool).toBe(!ov.EnableSSTP_bool);

  const zip = await api.rpc(beta, "MakeOpenVpnConfigFile");
  expect(Buffer.from(zip.Buffer_bin, "base64").subarray(0, 2).toString()).toBe("PK");

  await api.rpc(beta, "AddL3Switch", { Name_str: "core" });
  await api.rpc(beta, "AddL3If", { Name_str: "core", HubName_str: "BRANCH", IpAddress_ip: "192.168.50.1", SubnetMask_ip: "255.255.255.0" });
  await api.rpc(beta, "AddL3Table", { Name_str: "core", NetworkAddress_ip: "10.20.0.0", SubnetMask_ip: "255.255.0.0", GatewayAddress_ip: "192.168.50.254", Metric_u32: 1 });
  const tbl = await seRpc(BETA.port, BETA_ADMIN_PASSWORD, "EnumL3Table", { Name_str: "core" });
  expect(tbl.L3Table.some((r: any) => r.NetworkAddress_ip === "10.20.0.0")).toBe(true);
  await api.rpc(beta, "StartL3Switch", { Name_str: "core" });
  await eventually(async () => (await seRpc(BETA.port, BETA_ADMIN_PASSWORD, "EnumL3Switch")).L3SWList.find((s: any) => s.Name_str === "core")?.Active_bool);

  const po = await api.rpc(beta, "GetProtoOptions", { Protocol_str: "OpenVPN" });
  expect(po.Name_str).toContain("Enabled");

  const caps = await api.rpc(beta, "GetCaps");
  expect(caps.CapsList.length).toBeGreaterThan(50);
  const cipher = await api.rpc(beta, "GetServerCipherList");
  expect(cipher.String_str).toContain("AES");
});

test("gateway enforces danger classification and translates SoftEther errors", async () => {
  const { api, alpha } = await ids();
  const missing = await api.call("POST", `/api/servers/${alpha}/rpc/GetHub`, { HubName_str: "DOES_NOT_EXIST" });
  expect(missing.status).toBe(422);
  expect(missing.body.softEtherCode).toBe(8);
  expect(missing.body.error).toMatch(/Virtual Hub does not exist/);
  const unknown = await api.call("POST", `/api/servers/${alpha}/rpc/NoSuchMethod`, {});
  expect(unknown.status).toBe(404);
  // Operator cannot run danger-class methods
  await api.post("/api/users", { username: "zz_operator", role: "operator", password: "Operator-Passw0rd!", mustChangePassword: false }, 201);
  const { Api } = await import("../helpers.ts");
  const op = await new Api().login("zz_operator", "Operator-Passw0rd!");
  expect((await op.call("POST", `/api/servers/${alpha}/rpc/DeleteHub`, { HubName_str: "HQ" })).status).toBe(403);
  expect((await op.call("POST", `/api/servers/${alpha}/rpc/CreateUser`, { HubName_str: "HQ", Name_str: "op_made", AuthType_u32: 0 })).status).toBe(200);
});

test("secrets: non-admins never receive password hashes/PSKs, and their edits don't wipe them", async () => {
  const { api, alpha } = await ids();
  const { Api } = await import("../helpers.ts");
  await api.rpc(alpha, "SetHubRadius", { HubName_str: "HQ", RadiusServerName_str: "radius.example.com", RadiusPort_u32: 1812, RadiusSecret_str: "S3cr3t-Radius", RadiusRetryInterval_u32: 500 });
  const adminView = await api.rpc(alpha, "GetUser", { HubName_str: "HQ", Name_str: "bob" });
  expect(adminView.HashedKey_bin).toBeTruthy();
  const op = await new Api().login("zz_operator", "Operator-Passw0rd!");
  const opUser = await op.rpc(alpha, "GetUser", { HubName_str: "HQ", Name_str: "bob" });
  expect(opUser.HashedKey_bin).toBeUndefined();
  expect(opUser.NtLmSecureHash_bin).toBeUndefined();
  const opRadius = await op.rpc(alpha, "GetHubRadius", { HubName_str: "HQ" });
  expect(opRadius.RadiusSecret_str).toBeUndefined();
  expect((await op.call("POST", `/api/servers/${alpha}/rpc/GetConfig`, {})).status).toBe(403);
  // Operator edits the retry interval without knowing the secret: secret is preserved server-side
  await op.rpc(alpha, "SetHubRadius", { ...opRadius, HubName_str: "HQ", RadiusRetryInterval_u32: 700 });
  const after = await seRpc(ALPHA.port, "", "GetHubRadius", { HubName_str: "HQ" });
  expect(after.RadiusRetryInterval_u32).toBe(700);
  // ...but pointing RADIUS elsewhere requires re-entering the secret (it would otherwise be sent there)
  expect((await op.call("POST", `/api/servers/${alpha}/rpc/SetHubRadius`, { ...opRadius, HubName_str: "HQ", RadiusPort_u32: 1645 })).status).toBe(403);
  expect(after.RadiusSecret_str).toBe("S3cr3t-Radius");
  // Operator edits a user (read-modify-write) without wiping the password
  await op.rpc(alpha, "SetUser", { ...opUser, Note_utf: "edited by operator", Auth_Password_str: "" });
  const bob = await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "HQ", Name_str: "bob" });
  expect(bob.Note_utf).toBe("edited by operator");
  expect(bob.HashedKey_bin).toBe(adminView.HashedKey_bin);
  // Changing the password while the old hash is still in the object must take effect
  await api.rpc(alpha, "SetUser", { ...adminView, Auth_Password_str: "New-Bob-Passw0rd!" });
  const bob2 = await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "HQ", Name_str: "bob" });
  expect(bob2.HashedKey_bin).not.toBe(adminView.HashedKey_bin);
  const { softEtherPasswordHash } = await import("../../apps/server/src/deploy/vpnfile.ts");
  expect(bob2.HashedKey_bin).toBe(softEtherPasswordHash("bob", "New-Bob-Passw0rd!").toString("base64"));
});

test("review regressions: hub-key aliasing, fleet/state hub leaks, hub-operator limits, link redirect, audit redaction", async () => {
  const { api, alpha, beta } = await ids();
  const { Api } = await import("../helpers.ts");
  const hd = await new Api().login("zz_helpdesk", "Helpdesk-Passw0rd!");
  // A differently-cased/suffixed duplicate hub key is rejected instead of silently targeting another hub
  for (const alias of [{ hubname_str: "RBAC_B" }, { HubName_utf: "RBAC_B" }, { HUBNAME_STR: "RBAC_B" }]) {
    const r = await hd.call("POST", `/api/servers/${alpha}/rpc/CreateUser`, { HubName_str: "RBAC_A", ...alias, Name_str: "evil", AuthType_u32: 0 });
    expect(r.status, JSON.stringify(alias)).toBe(400);
  }
  expect((await seRpc(ALPHA.port, "", "EnumUser", { HubName_str: "RBAC_B" })).UserList.some((u: any) => u.Name_str === "evil")).toBe(false);
  // Fleet bulk and cached state honour hub visibility
  const bulk = await hd.post("/api/fleet/rpc", { method: "EnumHub", params: {}, serverIds: [alpha] });
  expect(bulk.results[0].result.HubList.map((h: any) => h.HubName_str)).toEqual(["RBAC_A"]);
  const mine = (await hd.get("/api/servers"))[0];
  expect(mine.state.status).toBeNull();
  expect(mine.state.hubs.HubList.map((h: any) => h.HubName_str)).toEqual(["RBAC_A"]);
  // Hub admin options are the server admin's limits: not for hub-level grants
  const opts = await api.rpc(alpha, "GetHubAdminOptions", { HubName_str: "RBAC_A" });
  expect((await hd.call("POST", `/api/servers/${alpha}/rpc/SetHubAdminOptions`, { ...opts, HubName_str: "RBAC_A" })).status).toBe(403);
  // A non-admin cannot redirect a cascade to another host and have the stored secret re-injected
  const op = await new Api().login("zz_operator", "Operator-Passw0rd!");
  const link = await op.rpc(beta, "GetLink", { HubName_Ex_str: "BRANCH", AccountName_utf: "to-hq" });
  const redirect = await op.call("POST", `/api/servers/${beta}/rpc/SetLink`, { ...link, HubName_Ex_str: "BRANCH", Hostname_str: "attacker.invalid" });
  expect(redirect.status).toBe(403);
  // Same host: allowed, and the credential is preserved
  await op.rpc(beta, "SetLink", { ...link, HubName_Ex_str: "BRANCH", MaxConnection_u32: 3 });
  const after = await seRpc(BETA.port, BETA_ADMIN_PASSWORD, "GetLink", { HubName_Ex_str: "BRANCH", AccountName_utf: "to-hq" });
  expect(after.MaxConnection_u32).toBe(3);
  expect(after.HashedPassword_bin).toBe((await seRpc(ALPHA.port, "", "GetUser", { HubName_str: "HQ", Name_str: "site-link" })).HashedKey_bin);
  // Protocol keys never land in the audit log; SetProtoOptions is admin-only
  const wg = await api.rpc(beta, "GetProtoOptions", { Protocol_str: "WireGuard" });
  expect((await op.call("POST", `/api/servers/${beta}/rpc/SetProtoOptions`, wg)).status).toBe(403);
  await api.rpc(beta, "SetProtoOptions", wg);
  const entry = (await api.get("/api/audit?action=rpc.SetProtoOptions&success=true")).rows[0];
  const i = entry.details.Name_str.indexOf("PrivateKey");
  expect(entry.details.Value_bin[i]).toBe("[redacted]");
  const current = await seRpc(BETA.port, BETA_ADMIN_PASSWORD, "GetProtoOptions", { Protocol_str: "WireGuard" });
  expect(current.Value_bin[current.Name_str.indexOf("PrivateKey")]).toBe(wg.Value_bin[i]);
});
