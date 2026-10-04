// Native SoftEther admin transport: binary PACK RPC over TLS, exactly what the official Server Manager
// (vpnsmgr) and "vpncmd /SERVER" use. Works on any listener port, even when the JSON-RPC API is off.
//
// Ported from vendor/SoftEtherVPN/src:
//   Cedar/Session.c  NewRpcSessionEx2          TLS connect, signature, hello
//   Cedar/Protocol.c ClientUploadSignature     POST /vpnsvc/connect.cgi (body "VPNCONNECT", accepted by
//                                              ServerDownloadSignature as an alternative to the watermark)
//                    ClientDownloadHello       hello PACK: "hello", "version", "build", 20-byte "random"
//                    PackAddClientVersion
//   Cedar/Admin.c    AdminConnectMain          "method"="admin", "accept_empty_password", client OS version
//                                              (OutRpcWinVer), "secure_password", optional "hubname"
//                    HashAdminPassword         SHA-0(password)
//                    AdminAccept / AdminCheckPassword   (server side, for the error codes)
//   Cedar/Sam.c      SecurePassword            SHA-0(hashed_password || random)
//   Mayaqua/HTTP.c   HttpClientSend/Recv       login PACKs travel in HTTP POST /vpnsvc/vpn.cgi bodies
//   Cedar/Remote.c   RpcCall/RpcCallInternal   after login: u32 length + PACK, with "function_name";
//                                              errors come back as the "error" element
//
// Parameters are converted with a port of JsonToPack() and results with PackToJson() plus the
// per-method hints (see pack.ts), so this transport returns the same JSON shapes as JSON-RPC.
//
// Sessions: one authenticated connection per endpoint+credentials, reused and serialized (RPC is strictly
// request/response on one socket), closed after IDLE_MS without calls, and transparently re-established
// once when a reused connection turns out to be dead (like RpcCall() + AdminReconnect()). The protocol has
// no keep-alive message: the server waits forever on an admin RPC socket (AdminAccept sets an infinite
// timeout) and vpnsmgr/vpncmd send nothing while idle, so idle sessions are simply closed and reopened on
// demand (TCP keep-alive is enabled against silent NAT drops). The server runs admin RPCs under one global
// lock (CedarSuperLock), so serializing calls on one socket costs no throughput.
import tls from "node:tls";
import net from "node:net";
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Endpoint } from "./client.ts";
import { ConnectionError, SoftEtherError, normalizeFingerprint } from "./errors.ts";
import { JsonParamError, Pack, PackError, decodePack, encodePack, jsonToPack, packToJson } from "./pack.ts";

// Cedar/Cedar.h error codes used here
const ERR_SERVER_IS_NOT_VPN = 2;
const ERR_DISCONNECTED = 3;
const ERR_PROTOCOL_ERROR = 4;
const ERR_HUB_NOT_FOUND = 8;
const ERR_ACCESS_DENIED = 12;
const ERR_INVALID_PARAMETER = 38;
const ERR_NULL_PASSWORD_LOCAL_ONLY = 51;
const ERR_NOT_ENOUGH_RIGHT = 52;
const ERR_IP_ADDRESS_DENIED = 109;

/** Login errors that the JSON-RPC API reports as HTTP 401/403 (JsonRpcAuthLogin() returns NULL). */
const AUTH_ERRORS = new Set([ERR_ACCESS_DENIED, ERR_HUB_NOT_FOUND, ERR_IP_ADDRESS_DENIED, ERR_NULL_PASSWORD_LOCAL_ONLY, ERR_NOT_ENOUGH_RIGHT]);

/** Idle sessions are closed after this long (SEM_NATIVE_IDLE_MS overrides, for tests). */
const IDLE_MS = Number(process.env.SEM_NATIVE_IDLE_MS) || 60_000;
const CLIENT_STR = "Server Manager for SoftEther VPN (native admin RPC)";
const HTTP_VPN_TARGET = "/vpnsvc/vpn.cgi";
const HTTP_VPN_TARGET2 = "/vpnsvc/connect.cgi";
const HTTP_VPN_TARGET_POSTDATA = "VPNCONNECT";
const HTTP_CONTENT_TYPE2 = "application/octet-stream";
const HTTP_CONTENT_TYPE3 = "image/jpeg";
const HTTP_KEEP_ALIVE = "timeout=15; max=19";
const HTTP_PACK_RAND_SIZE_MAX = 1000;
const MAX_NOOP_PER_SESSION = 30;
const NOOP_IGNORE = 2;
const MAX_PACK_SIZE = 512 * 1024 * 1024;
const HTTP_HEADER_LINE_MAX_SIZE = 4096;

// ---------------------------------------------------------------------------------------------------
// SHA-0 (FIPS 180, 1993): SHA-1 without the one-bit rotation in the message schedule. SoftEther hashes
// admin passwords with it (Mayaqua/Encrypt.c Internal_Sha0), and Node's crypto has no SHA-0.

export function sha0(data: Buffer | Uint8Array): Buffer {
  const ml = data.length;
  const withPad = Math.ceil((ml + 9) / 64) * 64;
  const m = Buffer.alloc(withPad);
  m.set(data);
  m[ml] = 0x80;
  const bits = BigInt(ml) * 8n;
  m.writeUInt32BE(Number((bits >> 32n) & 0xffffffffn), withPad - 8);
  m.writeUInt32BE(Number(bits & 0xffffffffn), withPad - 4);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < withPad; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = m.readUInt32BE(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; // SHA-1 would rotate left by 1 here
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = Buffer.alloc(20);
  [h0, h1, h2, h3, h4].forEach((h, i) => out.writeUInt32BE(h, i * 4));
  return out;
}

/** HashAdminPassword(): SHA-0 of the password bytes (UTF-8, as typed into vpncmd / sent in HTTP Basic). */
export function hashAdminPassword(password: string): Buffer {
  return sha0(Buffer.from(password, "utf8"));
}

/** SecurePassword(): SHA-0(hashed_password || server random). */
export function securePassword(hashed: Buffer, random: Buffer): Buffer {
  return sha0(Buffer.concat([hashed, random]));
}

// ---------------------------------------------------------------------------------------------------
// Socket plumbing

/** The peer closed or reset the connection (the only failure worth a transparent reconnect). */
class SocketClosed extends Error {
  /** Set by NativeSession.call(): the connection had served calls before (or was already dead), so it is safe to reconnect and repeat. */
  retryable = false;
  constructor(message = "Connection closed by server") {
    super(message);
    this.name = "SocketClosed";
  }
}

class Reader {
  private chunks: Buffer[] = [];
  private length = 0;
  private wake: (() => void) | null = null;
  private failure: Error | null = null;

  constructor(sock: net.Socket) {
    sock.on("data", (d: Buffer) => { this.chunks.push(d); this.length += d.length; this.notify(); });
    sock.on("error", (e) => { this.failure ??= e; this.notify(); });
    sock.on("close", () => { this.failure ??= new SocketClosed(); this.notify(); });
    sock.on("end", () => { this.failure ??= new SocketClosed(); this.notify(); });
  }

  private notify() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  fail(e: Error) {
    this.failure ??= e;
    this.notify();
  }

  private async fill(n: number): Promise<void> {
    while (this.length < n) {
      if (this.failure) throw this.failure;
      await new Promise<void>((r) => { this.wake = r; });
    }
  }

  private take(n: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    return out;
  }

  async exact(n: number): Promise<Buffer> {
    await this.fill(n);
    return Buffer.from(this.take(n));
  }

  /** RecvLine(): up to "\n" (the "\r" is trimmed with the rest of the whitespace by the callers). */
  async line(max = HTTP_HEADER_LINE_MAX_SIZE): Promise<string> {
    for (;;) {
      const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length);
      this.chunks = all.length ? [all] : [];
      const i = all.indexOf(0x0a);
      if (i >= 0) return this.take(i + 1).toString("latin1").replace(/\r?\n$/, "");
      if (all.length > max) throw new ConnectionError("protocol", "HTTP header line too long");
      if (this.failure) throw this.failure;
      await new Promise<void>((r) => { this.wake = r; });
    }
  }
}

function stripBrackets(host: string) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function toConnError(e: unknown, timedOut: boolean): Error {
  if (timedOut) return new ConnectionError("timeout", "Timed out talking to the server");
  if (e instanceof ConnectionError || e instanceof SoftEtherError) return e;
  if (e instanceof SocketClosed) return new ConnectionError("network", "Connection closed by server (not a SoftEther VPN Server, or the connection was dropped)");
  if (e instanceof PackError) return new ConnectionError("protocol", `Invalid PACK from server: ${e.message}`);
  const err = e as NodeJS.ErrnoException & { library?: string; reason?: string };
  const code = err?.code;
  if (code === "ETIMEDOUT") return new ConnectionError("timeout", "Timed out talking to the server");
  if ((typeof code === "string" && (/^ERR_(SSL|TLS)_/.test(code) || /^UNABLE_TO_/.test(code) || /CERT|SIGNATURE|DEPTH_ZERO|SELF_SIGNED/.test(code))) || err?.library === "SSL routines") {
    return new ConnectionError("tls", `TLS verification failed (${code ?? err?.reason ?? err?.message})`);
  }
  if (code === "ECONNRESET" || code === "EPIPE") {
    return new ConnectionError("network", "Connection closed by server (not a SoftEther VPN Server, or the connection was dropped)");
  }
  return new ConnectionError("network", `Cannot reach server: ${err?.message ?? String(e)}${code ? ` (${code})` : ""}`);
}

/** HTTP date as GetHttpDateStr() formats it. */
function httpDate(d = new Date()) {
  return d.toUTCString();
}

/** CreateDummyValue(): random padding element added to every HTTP-framed PACK. */
function addDummyValue(p: Pack) {
  p.addData("pencore", randomBytes(randomInt(0, HTTP_PACK_RAND_SIZE_MAX)));
}

// ---------------------------------------------------------------------------------------------------
// One authenticated admin connection

interface LoginResult { emptyPassword: boolean }

class NativeSession {
  sock: tls.TLSSocket | null = null;
  reader: Reader | null = null;
  dead = false;
  calls = 0;
  serverStr = "";
  serverVer = 0;
  serverBuild = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private timedOut = false;
  onClose: (() => void) | null = null;

  readonly ep: Endpoint;

  constructor(ep: Endpoint) {
    this.ep = ep;
  }

  /** TLS connect + signature + hello + admin login (AdminConnectMain). */
  async open(timeoutMs: number): Promise<LoginResult> {
    return this.withDeadline(timeoutMs, async () => {
      await this.connectTls();
      const random = await this.hello();
      const first = await this.login(this.ep.password, random);
      if (first === ERR_ACCESS_DENIED && !this.ep.hub && this.ep.password !== "") {
        // JSON-RPC accepts any password while the server administrator password is empty
        // (JsonRpcAuthLogin); the native login checks the exact hash. Try the empty password once so both
        // transports accept the same credentials.
        this.destroy();
        await this.connectTls();
        const random2 = await this.hello();
        const second = await this.login("", random2);
        if (second === 0) return { emptyPassword: true };
        throw authError(first);
      }
      if (first !== 0) throw AUTH_ERRORS.has(first) ? authError(first) : new SoftEtherError(first);
      return { emptyPassword: false };
    });
  }

  private connectTls(): Promise<void> {
    const ep = this.ep;
    const host = stripBrackets(ep.host);
    return new Promise((resolve, reject) => {
      const sock = tls.connect({
        host,
        port: ep.port,
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: ep.tlsMode === "ca",
        ca: ep.tlsMode === "ca" && ep.caPem ? ep.caPem : undefined,
      });
      this.sock = sock;
      this.reader = new Reader(sock);
      this.dead = false;
      sock.setNoDelay(true);
      const onError = (e: Error) => { cleanup(); reject(e); };
      const onClose = () => { cleanup(); reject(new SocketClosed("Connection closed during the TLS handshake")); };
      const cleanup = () => { sock.off("error", onError); sock.off("close", onClose); };
      sock.once("error", onError);
      sock.once("close", onClose);
      sock.once("secureConnect", () => {
        cleanup();
        if (ep.tlsMode === "pin") {
          const presented = normalizeFingerprint(sock.getPeerCertificate()?.fingerprint256 ?? "");
          const expected = normalizeFingerprint(ep.fingerprint ?? "");
          if (!expected || presented !== expected) {
            sock.destroy();
            reject(new ConnectionError("tls-mismatch",
              `Server certificate fingerprint ${presented} does not match the pinned fingerprint`, presented));
            return;
          }
        }
        sock.setKeepAlive(true, 30_000);
        // Only the current socket decides the session's state (a replaced socket may close later)
        sock.on("close", () => { if (this.sock === sock) { this.dead = true; this.onClose?.(); } });
        resolve();
      });
    });
  }

  private remoteIpStr(): string {
    const a = this.sock?.remoteAddress ?? stripBrackets(this.ep.host);
    return a.startsWith("::ffff:") && net.isIPv4(a.slice(7)) ? a.slice(7) : a;
  }

  private write(data: Buffer | string): Promise<void> {
    const sock = this.sock!;
    return new Promise((resolve, reject) => {
      if (sock.destroyed) return reject(new SocketClosed());
      sock.write(data, (e) => (e ? reject(e) : resolve()));
    });
  }

  /** ClientUploadSignature() + ClientDownloadHello(). Returns the server random. */
  private async hello(): Promise<Buffer> {
    const body = Buffer.from(HTTP_VPN_TARGET_POSTDATA, "ascii");
    await this.write(
      `POST ${HTTP_VPN_TARGET2} HTTP/1.1\r\n` +
      `Host: ${this.remoteIpStr()}\r\n` +
      `Content-Type: ${HTTP_CONTENT_TYPE3}\r\n` +
      "Connection: Keep-Alive\r\n" +
      `Content-Length: ${body.length}\r\n\r\n`);
    await this.write(body);
    let p: Pack | null;
    try {
      p = await this.httpRecv();
    } catch (e) {
      if (e instanceof SocketClosed) throw notVpn();
      throw e;
    }
    if (!p) throw notVpn();
    const err = p.getInt("error");
    if (err) throw new SoftEtherError(err);
    const hello = p.getStr("hello");
    const random = p.getData("random");
    if (hello === null || !random || random.length !== 20) throw notVpn();
    this.serverStr = hello;
    this.serverVer = p.getInt("version");
    this.serverBuild = p.getInt("build");
    return random;
  }

  /** AdminConnectMain() login. Returns the SoftEther error code (0 = logged in). */
  private async login(password: string, random: Buffer): Promise<number> {
    const p = new Pack();
    // PackAddClientVersion(): the server only logs these
    p.addStr("client_str", CLIENT_STR);
    p.addInt("client_ver", this.serverVer);
    p.addInt("client_build", this.serverBuild);
    p.addStr("method", "admin");
    p.addBool("accept_empty_password", true);
    // OutRpcWinVer(): what GetWinVer() fills in on a non-Windows client
    p.addBool("V_IsWindows", false);
    p.addBool("V_IsNT", false);
    p.addBool("V_IsServer", false);
    p.addBool("V_IsBeta", false);
    p.addInt("V_VerMajor", 0);
    p.addInt("V_VerMinor", 0);
    p.addInt("V_Build", 0);
    p.addInt("V_ServicePack", 0);
    p.addStr("V_Title", `${process.platform} ${process.arch}`);
    p.addData("secure_password", securePassword(hashAdminPassword(password), random));
    if (this.ep.hub) p.addStr("hubname", this.ep.hub);
    await this.httpSend(p);
    let res: Pack | null;
    try {
      res = await this.httpRecv();
    } catch (e) {
      if (e instanceof SocketClosed) return ERR_DISCONNECTED;
      throw e;
    }
    if (!res) return ERR_PROTOCOL_ERROR;
    return res.getInt("error");
  }

  /** HttpClientSend() */
  private async httpSend(p: Pack): Promise<void> {
    addDummyValue(p);
    const body = encodePack(p);
    await this.write(
      `POST ${HTTP_VPN_TARGET} HTTP/1.1\r\n` +
      `Date: ${httpDate()}\r\n` +
      `Host: ${this.remoteIpStr()}\r\n` +
      `Keep-Alive: ${HTTP_KEEP_ALIVE}\r\n` +
      "Connection: Keep-Alive\r\n" +
      `Content-Type: ${HTTP_CONTENT_TYPE2}\r\n` +
      `Content-Length: ${body.length}\r\n\r\n`);
    await this.write(body);
  }

  /** HttpClientRecv(): null when the answer is not a SoftEther PACK response. */
  private async httpRecv(): Promise<Pack | null> {
    const r = this.reader!;
    for (let noops = 0; ; noops++) {
      const first = (await r.line()).trim().split(" ").filter((t) => t !== "");
      if (first.length < 3) return null;
      const headers = new Map<string, string>();
      for (;;) {
        const l = (await r.line()).trim();
        if (l === "") break;
        const i = l.indexOf(":");
        if (i <= 0) return null;
        headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim());
      }
      if (first[0].toUpperCase() !== "HTTP/1.1" || first[1] !== "200") return null;
      if ((headers.get("content-type") ?? "").toLowerCase() !== HTTP_CONTENT_TYPE2) return null;
      const size = Number.parseInt(headers.get("content-length") ?? "0", 10);
      if (!Number.isFinite(size) || size <= 0 || size > MAX_PACK_SIZE) return null;
      const p = decodePack(await r.exact(size));
      if (p.getInt("noop") === NOOP_IGNORE) {
        if (noops + 1 > MAX_NOOP_PER_SESSION) return null;
        continue;
      }
      return p;
    }
  }

  /** RpcCallInternal(): one request/response on the admin RPC channel. */
  private async rpc(req: Pack): Promise<Pack> {
    const body = encodePack(req);
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(body.length);
    let size: number;
    try {
      await this.write(Buffer.concat([len, body]));
      size = (await this.reader!.exact(4)).readUInt32BE(0);
    } catch (e) {
      // Any socket-level failure (reset, EPIPE, destroyed stream...) means the connection is gone
      if (e instanceof ConnectionError || e instanceof SocketClosed) throw e;
      throw new SocketClosed(`Connection lost: ${(e as Error)?.message ?? String(e)}`);
    }
    if (size > MAX_PACK_SIZE) throw new ConnectionError("protocol", "RPC response too large");
    let data: Buffer;
    try {
      data = await this.reader!.exact(size);
    } catch (e) {
      if (e instanceof ConnectionError || e instanceof SocketClosed) throw e;
      throw new SocketClosed(`Connection lost: ${(e as Error)?.message ?? String(e)}`);
    }
    return decodePack(data);
  }

  /**
   * Serialized RPC call that must finish by `deadline` (epoch ms), time spent queued behind other calls
   * included. Rejects with SocketClosed when the connection died before an answer arrived. A call whose
   * deadline passes while it is still queued is dropped without being sent and without disturbing the
   * connection (which is still busy with, and healthy for, the call ahead of it).
   */
  call(req: Pack, deadline: number): Promise<Pack> {
    let state: "queued" | "running" | "abandoned" = "queued";
    const run = async () => {
      if (state === "abandoned" || deadline - Date.now() <= 0) {
        state = "abandoned";
        throw new ConnectionError("timeout", "Timed out talking to the server");
      }
      state = "running";
      this.clearIdle();
      if (this.dead || !this.sock || this.sock.destroyed) {
        const e = new SocketClosed();
        e.retryable = true; // nothing was sent
        throw e;
      }
      const wasUsed = this.calls > 0;
      this.calls++;
      try {
        return await this.withDeadline(deadline - Date.now(), () => this.rpc(req));
      } catch (e) {
        if (e instanceof SocketClosed) e.retryable = wasUsed;
        throw e;
      } finally {
        this.armIdle();
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return new Promise<Pack>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state !== "queued") return; // a running call is bounded by withDeadline()
        state = "abandoned";
        reject(new ConnectionError("timeout", "Timed out talking to the server"));
      }, Math.max(1, deadline - Date.now()));
      p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
  }

  private async withDeadline<T>(timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    this.timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.timedOut = true;
        this.reader?.fail(new ConnectionError("timeout", "Timed out talking to the server"));
        this.destroy();
        reject(new ConnectionError("timeout", "Timed out talking to the server"));
      }, timeoutMs);
    });
    try {
      return await Promise.race([fn(), expired]);
    } catch (e) {
      if (this.timedOut) throw new ConnectionError("timeout", "Timed out talking to the server");
      if (e instanceof SocketClosed) { this.destroy(); throw e; }
      if (!(e instanceof SoftEtherError) && !(e instanceof ConnectionError && e.kind === "auth")) this.destroy();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdle() {
    this.clearIdle();
    if (this.dead) return;
    this.idleTimer = setTimeout(() => this.destroy(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  destroy() {
    this.clearIdle();
    this.dead = true;
    if (this.sock && !this.sock.destroyed) this.sock.destroy();
  }
}

function notVpn() {
  return new ConnectionError("protocol",
    `The server did not answer like a SoftEther VPN Server (error ${ERR_SERVER_IS_NOT_VPN}: not a VPN server)`);
}

function authError(code: number) {
  const e = new ConnectionError("auth", code === ERR_HUB_NOT_FOUND
    ? "Authentication failed: the Virtual Hub does not exist"
    : code === ERR_IP_ADDRESS_DENIED
      ? "Authentication failed: this computer's IP address is not allowed to administer the server"
      : code === ERR_NULL_PASSWORD_LOCAL_ONLY
        ? "Authentication failed: an empty password is only accepted from localhost"
        : "Authentication failed: wrong administrator password or hub name");
  (e as ConnectionError & { softEtherCode?: number }).softEtherCode = code;
  return e;
}

// ---------------------------------------------------------------------------------------------------
// Session pool

const sessions = new Map<string, Promise<NativeSession>>();

function sessionKey(ep: Endpoint): string {
  const h = (s: string) => createHash("sha256").update(s).digest("hex");
  return [stripBrackets(ep.host).toLowerCase(), ep.port, (ep.hub ?? "").toLowerCase(), h(ep.password),
    ep.tlsMode, normalizeFingerprint(ep.fingerprint ?? ""), ep.caPem ? h(ep.caPem) : ""].join("|");
}

async function openSession(ep: Endpoint, timeoutMs: number): Promise<NativeSession> {
  const s = new NativeSession(ep);
  try {
    await s.open(timeoutMs);
  } catch (e) {
    s.destroy();
    throw toConnError(e, false);
  }
  return s;
}

function pooledSession(ep: Endpoint, timeoutMs: number): Promise<NativeSession> {
  const key = sessionKey(ep);
  const existing = sessions.get(key);
  if (existing) return existing;
  const p = openSession(ep, timeoutMs).then((s) => {
    s.onClose = () => { if (sessions.get(key) === p) sessions.delete(key); };
    if (s.dead) s.onClose();
    return s;
  });
  sessions.set(key, p);
  p.catch(() => { if (sessions.get(key) === p) sessions.delete(key); });
  return p;
}

/** Waits for `p` (e.g. a login someone else started with a longer timeout) no later than `deadline`. */
function untilDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ConnectionError("timeout", "Timed out talking to the server")),
      Math.max(1, deadline - Date.now()));
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Bumped by closeNativeSessions(): calls started before it must not log in again with their credentials. */
let generation = 0;
let reconnects = 0;

/** Diagnostics (used by tools/verify-native): pooled sessions and transparent reconnects so far. */
export function nativeSessionStats(): { sessions: number; reconnects: number } {
  return { sessions: sessions.size, reconnects };
}

export async function callNativeRpc<T = Record<string, unknown>>(
  ep: Endpoint, method: string, params: Record<string, unknown>, timeoutMs: number, opts: { ephemeral?: boolean } = {},
): Promise<T> {
  // JsonRpcProcPost(): an empty method name is rejected before dispatch
  if (!method) throw new SoftEtherError(ERR_INVALID_PARAMETER);
  // JsonRpcProcRequestObject(): JsonToPack(params), then "function_name"
  let req: Pack;
  try {
    req = jsonToPack(params ?? {});
  } catch (e) {
    if (e instanceof JsonParamError) throw new SoftEtherError(ERR_INVALID_PARAMETER);
    throw e;
  }
  // The server dispatches on this element (CallRpcDispatcher). A "function_name_*" parameter would already
  // have created it, and PackAddStr() would then keep the parameter's value: the server would run another
  // RPC than `method` (JSON-RPC has that flaw: JsonRpcProcRequestObject() also uses PackAddStr()), and its
  // result would be converted with the wrong method's hints. The native transport always runs `method`.
  req.remove("function_name");
  req.addStr("function_name", method);

  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  const gen = generation;

  let res: Pack;
  if (opts.ephemeral) {
    const s = await openSession(ep, timeoutMs);
    try {
      res = await s.call(req, deadline).catch((e) => { throw toConnError(e, false); });
    } finally {
      s.destroy();
    }
  } else {
    const key = sessionKey(ep);
    let sp = pooledSession(ep, timeoutMs);
    let s = await untilDeadline(sp, deadline);
    try {
      res = await s.call(req, deadline);
    } catch (e) {
      // RpcCall(): a dead reused connection is re-established once and the call repeated. Not after
      // closeNativeSessions() (lock, credential change, quit): that must not open a new session.
      if (!(e instanceof SocketClosed) || !e.retryable || gen !== generation) throw toConnError(e, false);
      s.destroy();
      if (sessions.get(key) === sp) sessions.delete(key);
      reconnects++;
      sp = pooledSession(ep, left());
      s = await untilDeadline(sp, deadline);
      try {
        res = await s.call(req, deadline);
      } catch (e2) {
        throw toConnError(e2, false);
      }
    }
  }

  const err = res.getInt("error");
  if (err !== 0) throw new SoftEtherError(err);
  return packToJson(res, method) as T;
}

export function closeNativeSessions(): void {
  generation++;
  for (const p of sessions.values()) p.then((s) => s.destroy(), () => undefined);
  sessions.clear();
}
