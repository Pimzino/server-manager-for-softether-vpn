import { test, expect } from "@playwright/test";
import { Api, adminApi, eventually, seRpc, totp } from "../helpers.ts";
import { ADMIN, BETA_ADMIN_PASSWORD, SERVERS } from "../env.ts";

test.describe.configure({ mode: "serial" });

test("login: rejects bad password, accepts good one, CSRF header enforced", async () => {
  const bad = await new Api().call("POST", "/api/auth/login", { username: ADMIN.username, password: "wrong" });
  expect(bad.status).toBe(401);
  const api = await adminApi();
  const me = await api.get("/api/auth/me");
  expect(me.user.username).toBe(ADMIN.username);
  expect(me.user.role).toBe("admin");
  // Cookie-authenticated writes without the CSRF header are refused
  const res = await fetch(`http://127.0.0.1:18090/api/servers/probe`, {
    method: "POST", headers: { cookie: api.cookie, "content-type": "application/json" }, body: JSON.stringify({ host: "127.0.0.1", port: SERVERS[0].port }),
  });
  expect(res.status).toBe(403);
});

test("servers: TOFU probe, pin, add both servers, reject wrong fingerprint and wrong password", async () => {
  const api = await adminApi();
  for (const s of SERVERS) {
    const probe = await api.post("/api/servers/probe", { host: "127.0.0.1", port: s.port });
    expect(probe.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const password = s.name === "e2e-beta" ? BETA_ADMIN_PASSWORD : "";
    const body = { name: s.name, host: "127.0.0.1", port: s.port, password, tlsMode: "pin", tlsFingerprint: probe.fingerprint, tags: ["e2e", s.name] };
    const t = await api.post("/api/servers/test", body);
    expect(t.ok).toBe(true);
    expect(t.info.ServerProductName_str).toContain("SoftEther VPN Server");
    const created = await api.post("/api/servers", body, 201);
    expect(created.state.ok).toBe(true);
  }
  // Wrong pinned fingerprint -> tls-mismatch with the presented fingerprint reported
  const bogus = await api.call("POST", "/api/servers/test", {
    name: "x", host: "127.0.0.1", port: SERVERS[0].port, password: "", tlsMode: "pin", tlsFingerprint: "AA:".repeat(31) + "AA",
  });
  expect(bogus.status).toBe(502);
  expect(bogus.body.connection).toBe("tls-mismatch");
  expect(bogus.body.presentedFingerprint).toMatch(/^([0-9A-F]{2}:){31}/);
  // Wrong admin password on the password-protected server
  const probe = await api.post("/api/servers/probe", { host: "127.0.0.1", port: SERVERS[1].port });
  const wrongPw = await api.call("POST", "/api/servers/test", {
    name: "x", host: "127.0.0.1", port: SERVERS[1].port, password: "nope", tlsMode: "pin", tlsFingerprint: probe.fingerprint,
  });
  expect(wrongPw.status).toBe(502);
  expect(wrongPw.body.connection).toBe("auth");
  const list = await api.get("/api/servers");
  expect(list.map((s: any) => s.name).sort()).toEqual(["e2e-alpha", "e2e-beta"]);
});

test("RBAC: viewer can read but not write; hub-scoped helpdesk limited to its hub; audit records denials", async () => {
  const api = await adminApi();
  const servers = await api.get("/api/servers");
  const alpha = servers.find((s: any) => s.name === "e2e-alpha");
  await api.rpc(alpha.id, "CreateHub", { HubName_str: "RBAC_A", Online_bool: true });
  await api.rpc(alpha.id, "CreateHub", { HubName_str: "RBAC_B", Online_bool: true });

  await api.post("/api/users", { username: "zz_viewer", role: "viewer", password: "Viewer-Passw0rd!", mustChangePassword: false }, 201);
  const helpdesk = await api.post("/api/users", { username: "zz_helpdesk", role: "none", password: "Helpdesk-Passw0rd!", mustChangePassword: false }, 201);
  await api.post(`/api/users/${helpdesk.id}/grants`, { serverId: alpha.id, hub: "RBAC_A", role: "operator" }, 201);

  const viewer = await new Api().login("zz_viewer", "Viewer-Passw0rd!");
  const hubs = await viewer.rpc(alpha.id, "EnumHub");
  expect(hubs.HubList.length).toBeGreaterThanOrEqual(2);
  const denied = await viewer.call("POST", `/api/servers/${alpha.id}/rpc/CreateUser`, { HubName_str: "RBAC_A", Name_str: "x", AuthType_u32: 1, Auth_Password_str: "x" });
  expect(denied.status).toBe(403);

  const hd = await new Api().login("zz_helpdesk", "Helpdesk-Passw0rd!");
  const hdServers = await hd.get("/api/servers");
  expect(hdServers.map((s: any) => s.name)).toEqual(["e2e-alpha"]);
  const hdHubs = await hd.rpc(alpha.id, "EnumHub");
  expect(hdHubs.HubList.map((h: any) => h.HubName_str)).toEqual(["RBAC_A"]);
  await hd.rpc(alpha.id, "CreateUser", { HubName_str: "RBAC_A", Name_str: "hd_user", AuthType_u32: 1, Auth_Password_str: "Pw-12345" });
  expect((await hd.call("POST", `/api/servers/${alpha.id}/rpc/CreateUser`, { HubName_str: "RBAC_B", Name_str: "x", AuthType_u32: 0 })).status).toBe(403);
  expect((await hd.call("POST", `/api/servers/${alpha.id}/rpc/GetServerStatus`, {})).status).toBe(403);
  // Oracle: the user really exists on the SoftEther server
  const u = await seRpc(SERVERS[0].port, "", "GetUser", { HubName_str: "RBAC_A", Name_str: "hd_user" });
  expect(u.Name_str).toBe("hd_user");

  const audit = await api.get("/api/audit?q=RBAC_B&success=false");
  expect(audit.rows.some((r: any) => r.username === "zz_helpdesk" && r.action === "rpc.CreateUser")).toBe(true);
  const auditOk = await api.get("/api/audit?user=zz_helpdesk&action=rpc.CreateUser&success=true");
  expect(auditOk.total).toBe(1);
  // Secrets never reach the audit log
  expect(JSON.stringify(auditOk.rows[0].details)).not.toContain("Pw-12345");
});

test("MFA: enrol TOTP, login requires code, wrong code rejected, replay rejected, attempts limited", async () => {
  test.setTimeout(120_000);
  const api = await adminApi();
  await api.post("/api/users", { username: "zz_mfa", role: "viewer", password: "Mfa-User-Passw0rd!", mustChangePassword: false }, 201);
  const u = await new Api().login("zz_mfa", "Mfa-User-Passw0rd!");
  const setup = await u.post("/api/auth/mfa/setup");
  expect(setup.uri).toContain("otpauth://totp/");
  // Re-authentication is required, and the secret comes from the server-side pending enrolment
  expect((await u.call("POST", "/api/auth/mfa/enable", { code: totp(setup.secret), password: "wrong" })).status).toBe(400);
  await u.post("/api/auth/mfa/enable", { code: totp(setup.secret), password: "Mfa-User-Passw0rd!" });
  // API tokens cannot change sign-in security
  const tok = await u.post("/api/me/tokens", { name: "t", expiresInDays: 1 }, 201);
  const tu = new Api(); tu.bearer = tok.token;
  expect((await tu.call("POST", "/api/auth/mfa/setup")).status).toBe(403);
  // The enrolment step was consumed: wait for the next TOTP window so the login code is fresh
  await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 500));

  const s = new Api();
  const step1 = await s.post("/api/auth/login", { username: "zz_mfa", password: "Mfa-User-Passw0rd!" });
  expect(step1.mfaRequired).toBe(true);
  expect((await s.call("GET", "/api/servers")).status).toBe(401);
  expect((await s.call("POST", "/api/auth/mfa", { code: "000000" === totp(setup.secret) ? "111111" : "000000" })).status).toBe(401);
  const code = totp(setup.secret);
  const ok = await s.post("/api/auth/mfa", { code });
  expect(ok.user.mfaEnabled).toBe(true);
  expect((await s.call("GET", "/api/servers")).status).toBe(200);
  // Replay: the same code cannot complete a second login
  const s2 = new Api();
  await s2.post("/api/auth/login", { username: "zz_mfa", password: "Mfa-User-Passw0rd!" });
  expect((await s2.call("POST", "/api/auth/mfa", { code })).status).toBe(401);
  // Too many wrong codes destroy the pending session
  const s3 = new Api();
  await s3.post("/api/auth/login", { username: "zz_mfa", password: "Mfa-User-Passw0rd!" });
  const wrong = code === "123456" ? "654321" : "123456";
  for (let i = 0; i < 3; i++) await s3.call("POST", "/api/auth/mfa", { code: wrong });
  const after = await s3.call("POST", "/api/auth/mfa", { code: totp(setup.secret) });
  expect(after.status).toBe(401);
  expect(after.body.error).toMatch(/sign in again/);
});

test("account lockout after repeated failures, including parallel attempts; no username enumeration", async () => {
  const api = await adminApi();
  await api.post("/api/users", { username: "zz_lock", role: "viewer", password: "Lock-User-Passw0rd!", mustChangePassword: false }, 201);
  const s = new Api();
  // Parallel wrong guesses must still count individually
  await Promise.all(Array.from({ length: 6 }, () => s.call("POST", "/api/auth/login", { username: "zz_lock", password: "bad" })));
  const locked = await s.call("POST", "/api/auth/login", { username: "zz_lock", password: "Lock-User-Passw0rd!" });
  expect(locked.status).toBe(401);
  // Locked, unknown and wrong-password answers are indistinguishable
  const unknown = await s.call("POST", "/api/auth/login", { username: "zz_nobody", password: "x" });
  expect(unknown.body).toEqual(locked.body);
  const audit = await api.get("/api/audit?user=zz_lock&action=auth.login&success=false");
  expect(audit.rows.some((r: any) => r.error === "locked")).toBe(true);
  const users = await api.get("/api/users");
  const id = users.find((x: any) => x.username === "zz_lock").id;
  await api.put(`/api/users/${id}`, { unlock: true });
  await eventually(async () => (await s.call("POST", "/api/auth/login", { username: "zz_lock", password: "Lock-User-Passw0rd!" })).status === 200);
});
