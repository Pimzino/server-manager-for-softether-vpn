// JSON-RPC client for SoftEther VPN Server (/api/ endpoint on any listener port).
// Authentication: HTTP Basic, username = hub name (hub-admin mode) or "administrator" (server admin).
// (The X-VPNADMIN-* headers also work, but SoftEther's HTTP parser drops requests whose headers have
// empty values, which breaks the common empty-password / no-hub case.)
// TLS: SoftEther ships self-signed certs, so we support fingerprint pinning (TOFU), CA validation,
// or explicit insecure mode.
import tls from "node:tls";
import { createHash } from "node:crypto";
import { Agent, buildConnector, request } from "undici";
import { errorText } from "@sem/api-catalog";
import { config } from "../config.ts";

export type TlsMode = "pin" | "ca" | "insecure";

export interface Endpoint {
  host: string;
  port: number;
  hub?: string | null;
  password: string;
  tlsMode: TlsMode;
  fingerprint?: string | null;
  caPem?: string | null;
}

export class SoftEtherError extends Error {
  code: number;
  constructor(code: number, message?: string) {
    super(message && !/^Error code \d+/.test(message) ? message : errorText(code));
    this.code = code;
    this.name = "SoftEtherError";
  }
}

export class ConnectionError extends Error {
  kind: "tls-mismatch" | "tls" | "network" | "timeout" | "http" | "auth" | "protocol";
  presentedFingerprint?: string;
  constructor(kind: ConnectionError["kind"], message: string, presentedFingerprint?: string) {
    super(message);
    this.kind = kind;
    this.presentedFingerprint = presentedFingerprint;
    this.name = "ConnectionError";
  }
}

export function normalizeFingerprint(fp: string): string {
  const hex = fp.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  return hex.match(/.{2}/g)?.join(":") ?? "";
}

const agents = new Map<string, Agent>();

function agentFor(ep: Endpoint, ephemeral = false): Agent {
  const caHash = ep.caPem ? createHash("sha256").update(ep.caPem).digest("hex") : "";
  const key = `${ep.host}:${ep.port}:${ep.tlsMode}:${ep.fingerprint ?? ""}:${caHash}`;
  let agent = ephemeral ? undefined : agents.get(key);
  if (agent) return agent;
  const base = buildConnector({
    rejectUnauthorized: ep.tlsMode === "ca",
    ca: ep.tlsMode === "ca" && ep.caPem ? ep.caPem : undefined,
    allowH2: false,
    timeout: 10_000,
  });
  agent = new Agent({
    connections: 4,
    keepAliveTimeout: 30_000,
    connect(opts, cb) {
      base(opts, (err, socket) => {
        if (err || !socket) return cb(err ?? new Error("connect failed"), null);
        if (ep.tlsMode === "pin") {
          const cert = (socket as tls.TLSSocket).getPeerCertificate?.();
          const presented = normalizeFingerprint(cert?.fingerprint256 ?? "");
          const expected = normalizeFingerprint(ep.fingerprint ?? "");
          if (!expected || presented !== expected) {
            socket.destroy();
            return cb(new ConnectionError("tls-mismatch",
              `Server certificate fingerprint ${presented} does not match the pinned fingerprint`, presented), null);
          }
        }
        cb(null, socket);
      });
    },
  });
  if (!ephemeral) agents.set(key, agent);
  return agent;
}

/** Drop pooled connections for an endpoint (after credential or TLS changes). */
export function resetAgents() {
  for (const a of agents.values()) void a.close();
  agents.clear();
}

let idCounter = 0;

export async function callRpc<T = Record<string, unknown>>(
  ep: Endpoint, method: string, params: Record<string, unknown> = {}, timeoutMs = config.rpcTimeoutMs,
  opts: { ephemeral?: boolean } = {},
): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: String(++idCounter), method, params });
  // Ephemeral agents (connection tests with unsaved settings) never share pooled, pre-verified sockets
  const dispatcher = agentFor(ep, opts.ephemeral);
  try {
    return await doCall<T>(ep, dispatcher, body, timeoutMs);
  } finally {
    if (opts.ephemeral) void dispatcher.close();
  }
}

async function doCall<T>(ep: Endpoint, dispatcher: Agent, body: string, timeoutMs: number): Promise<T> {
  let res;
  try {
    res = await request(`https://${formatHost(ep.host)}:${ep.port}/api/`, {
      method: "POST",
      dispatcher,
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${ep.hub || "administrator"}:${ep.password}`, "utf8").toString("base64")}`,
      },
      body,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
  } catch (e) {
    throw toConnectionError(e);
  }
  let text: string;
  try {
    text = await res.body.text();
  } catch (e) {
    throw toConnectionError(e);
  }
  if (res.statusCode === 401 || res.statusCode === 403) {
    throw new ConnectionError("auth", "Authentication failed: wrong administrator password or hub name");
  }
  if (res.statusCode !== 200) {
    throw new ConnectionError("http", `Unexpected HTTP ${res.statusCode} from server${text.includes("<html") ? " (is the JSON-RPC API disabled?)" : ""}`);
  }
  let json: { result?: T; error?: { code: number; message: string } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConnectionError("protocol", "Server returned invalid JSON");
  }
  if (!json || typeof json !== "object") throw new ConnectionError("protocol", "Server returned an unexpected JSON-RPC response");
  if (json.error) throw new SoftEtherError(json.error.code, json.error.message);
  return (json.result ?? {}) as T;
}

export function stripBrackets(host: string) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function formatHost(rawHost: string) {
  const host = stripBrackets(rawHost);
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function toConnectionError(e: unknown): Error {
  if (e instanceof ConnectionError) return e;
  const err = e as NodeJS.ErrnoException & { cause?: unknown };
  if (err?.cause instanceof ConnectionError) return err.cause;
  const code = err?.code ?? (err?.cause as NodeJS.ErrnoException | undefined)?.code;
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || code === "ETIMEDOUT") {
    return new ConnectionError("timeout", "Timed out talking to the server");
  }
  const library = (err as { library?: string })?.library ?? ((err?.cause as { library?: string } | undefined)?.library);
  if ((typeof code === "string" && (/^ERR_(SSL|TLS)_/.test(code) || /^UNABLE_TO_/.test(code) || /CERT|SIGNATURE/.test(code))) || library === "SSL routines") {
    return new ConnectionError("tls", `TLS verification failed (${code})`);
  }
  if (code === "UND_ERR_SOCKET" || code === "ECONNRESET") {
    return new ConnectionError("network", "Connection closed by server (wrong password lockout, API disabled, or not a SoftEther server)");
  }
  return new ConnectionError("network", `Cannot reach server: ${err?.message ?? String(e)}${code ? ` (${code})` : ""}`);
}

export interface ProbeResult {
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
  pem: string;
}

/** Open a TLS connection without verification and report the presented certificate (for TOFU pinning). */
export function probeCertificate(rawHost: string, port: number, timeoutMs = 8000): Promise<ProbeResult> {
  const host = stripBrackets(rawHost);
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false, servername: isIp(host) ? undefined : host });
    const timer = setTimeout(() => { sock.destroy(); reject(new ConnectionError("timeout", "Timed out connecting")); }, timeoutMs);
    sock.once("secureConnect", () => {
      clearTimeout(timer);
      const c = sock.getPeerCertificate(true);
      const der = c.raw;
      const pem = der ? `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n` : "";
      const fmt = (o: Record<string, unknown> | undefined) => o ? Object.entries(o).map(([k, v]) => `${k}=${v}`).join(", ") : "";
      resolve({
        fingerprint: normalizeFingerprint(c.fingerprint256 ?? ""),
        subject: fmt(c.subject as unknown as Record<string, unknown>),
        issuer: fmt(c.issuer as unknown as Record<string, unknown>),
        validFrom: c.valid_from,
        validTo: c.valid_to,
        selfSigned: fmt(c.subject as unknown as Record<string, unknown>) === fmt(c.issuer as unknown as Record<string, unknown>),
        pem,
      });
      sock.end();
    });
    sock.once("error", (e) => { clearTimeout(timer); reject(toConnectionError(e)); });
  });
}

function isIp(h: string) {
  return /^[\d.]+$/.test(h) || h.includes(":");
}
