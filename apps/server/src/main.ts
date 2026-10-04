import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import { config } from "./config.ts";
import { initSetupMode } from "./setup.ts";
import { HttpError } from "./servers.ts";
import authRoutes from "./routes/auth.ts";
import setupRoutes from "./routes/setup.ts";
import serverRoutes from "./routes/servers.ts";
import adminRoutes from "./routes/admin.ts";
import fleetRoutes from "./routes/fleet.ts";
import backupRoutes from "./routes/backups.ts";
import deployRoutes from "./routes/deploy.ts";
import hubDeployRoutes from "./routes/hubdeploy.ts";
import { startScheduler } from "./scheduler.ts";

function tlsOptions() {
  if (config.plainHttp) return undefined;
  let certFile = config.tlsCert;
  let keyFile = config.tlsKey;
  if (!certFile || !keyFile) {
    certFile = path.join(config.dataDir, "ui-cert.pem");
    keyFile = path.join(config.dataDir, "ui-key.pem");
    if (!existsSync(certFile) || !existsSync(keyFile)) {
      execFileSync("openssl", [
        "req", "-x509", "-newkey", "rsa:3072", "-sha256", "-days", "825", "-nodes",
        "-keyout", keyFile, "-out", certFile, "-subj", "/CN=softether-manager",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ], { stdio: "ignore" });
    }
  }
  return { cert: readFileSync(certFile), key: readFileSync(keyFile) };
}

const https = tlsOptions();
const app = Fastify({
  logger: { level: config.logLevel, redact: ["req.headers.authorization", "req.headers.cookie"] },
  trustProxy: config.trustProxy,
  bodyLimit: 32 * 1024 * 1024,
  ...(https ? { https } : {}),
});

await app.register(cookie);
await app.register(rateLimit, { global: false });
await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024, files: 1 } });

app.addHook("onSend", async (_req, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");
  if (https) reply.header("Strict-Transport-Security", "max-age=31536000");
  return payload;
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send(err.body);
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: "Invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  const e = err as { statusCode?: number; message: string };
  if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
  req.log.error(err);
  return reply.code(500).send({ error: "Internal server error" });
});

app.get("/healthz", async () => ({ ok: true }));

await app.register(setupRoutes);
await app.register(authRoutes);
await app.register(serverRoutes);
await app.register(adminRoutes);
await app.register(fleetRoutes);
await app.register(backupRoutes);
await app.register(deployRoutes);
await app.register(hubDeployRoutes);

if (existsSync(config.webDist)) {
  // wildcard: serve files from disk per request, so a rebuilt UI is picked up without a restart
  await app.register(fastifyStatic, { root: config.webDist, wildcard: true });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

// No administrator is ever created automatically: until first-run setup is completed in the UI
// (with the one-time token), the server only offers the setup page.
initSetupMode(app.log);
await app.listen({ host: config.host, port: config.port });
startScheduler(app.log);
