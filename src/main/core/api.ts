// In-process REST API (Fastify). It never listens on a port: the IPC bridge calls app.inject().
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import { HttpError } from "./servers.ts";
import serverRoutes from "./routes/servers.ts";
import fleetRoutes from "./routes/fleet.ts";
import backupRoutes from "./routes/backups.ts";
import deployRoutes from "./routes/deploy.ts";
import hubDeployRoutes from "./routes/hubdeploy.ts";
import settingsRoutes from "./routes/settings.ts";

export async function buildApi(): Promise<FastifyInstance> {
  const app = Fastify({
    // No pino: nothing to log to (and pino transports use worker threads that do not bundle).
    logger: false,
    bodyLimit: 32 * 1024 * 1024,
  });

  await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send(err.body);
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const e = err as { statusCode?: number; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    console.error("[api]", err);
    return reply.code(500).send({ error: e.message || "Internal error" });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: `No such endpoint: ${req.method} ${req.url.split("?")[0]}` }));

  app.get("/api/health", async () => ({ ok: true }));

  await app.register(serverRoutes);
  await app.register(fleetRoutes);
  await app.register(backupRoutes);
  await app.register(deployRoutes);
  await app.register(hubDeployRoutes);
  await app.register(settingsRoutes);
  await app.ready();
  return app;
}
