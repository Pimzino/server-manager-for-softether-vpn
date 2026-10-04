import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { methods } from "@sem/api-catalog";
import { executeRpc, getServer, HttpError, listServers, publicServer } from "../servers.ts";

export default async function fleetRoutes(app: FastifyInstance) {
  app.get("/api/fleet/summary", async () => {
    const servers = listServers().map(publicServer);
    let sessions = 0, users = 0, hubs = 0, recv = 0, send = 0, online = 0, offline = 0, locked = 0;
    for (const s of servers) {
      // Each server counts once: locked (password not entered, state unknown), online or offline.
      if (!s.unlocked) locked++;
      else if (s.state?.ok) online++;
      else offline++;
      const st = s.state?.status as Record<string, number> | null;
      if (st) {
        sessions += st.NumSessionsTotal_u32 ?? 0;
        users += st.NumUsers_u32 ?? 0;
        hubs += st.NumHubTotal_u32 ?? 0;
        recv += st["Recv.BroadcastBytes_u64"] ?? 0;
        send += st["Send.BroadcastBytes_u64"] ?? 0;
        recv += st["Recv.UnicastBytes_u64"] ?? 0;
        send += st["Send.UnicastBytes_u64"] ?? 0;
      }
    }
    return { totals: { servers: servers.length, online, offline, locked, sessions, users, hubs, recvBytes: recv, sendBytes: send }, servers };
  });

  /**
   * Run one RPC against many servers (e.g. create the same user on every hub named X, set the same
   * syslog destination fleet-wide). Each server reports its own result; locked servers fail with
   * `locked: true`.
   */
  app.post("/api/fleet/rpc", async (req) => {
    const b = z.object({
      method: z.string(),
      params: z.record(z.string(), z.unknown()).default({}),
      serverIds: z.array(z.number().int()).min(1).max(500),
    }).parse(req.body);
    if (!methods[b.method]) throw new HttpError(404, `Unknown RPC method '${b.method}'`);
    const results = await Promise.all(b.serverIds.map(async (id) => {
      const s = getServer(id);
      if (!s) return { serverId: id, ok: false, error: "Server not found" };
      try {
        const result = await executeRpc(s, b.method, { ...b.params });
        return { serverId: id, serverName: s.name, ok: true, result };
      } catch (e) {
        const extra = e instanceof HttpError ? e.body : {};
        return { serverId: id, serverName: s.name, ok: false, ...extra, error: (e as Error).message };
      }
    }));
    return { results };
  });
}
