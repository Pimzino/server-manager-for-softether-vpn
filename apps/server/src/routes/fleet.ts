import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { methods } from "@sem/api-catalog";
import { authenticate, canSeeServer, effectiveRole } from "../auth.ts";
import { executeRpc, getServer, HttpError, listServers, publicServer } from "../servers.ts";
import { ctxOf } from "./servers.ts";

export default async function fleetRoutes(app: FastifyInstance) {
  app.get("/api/fleet/summary", { preHandler: authenticate }, async (req) => {
    const u = req.principal!.user;
    const servers = listServers().filter((s) => canSeeServer(u, s.id)).map((s) => ({ ...publicServer(s, u), myRole: effectiveRole(u, s.id) }));
    let sessions = 0, users = 0, hubs = 0, recv = 0, send = 0, online = 0, offline = 0;
    for (const s of servers) {
      if (s.state?.ok) online++; else offline++;
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
    return { totals: { servers: servers.length, online, offline, sessions, users, hubs, recvBytes: recv, sendBytes: send }, servers };
  });

  /**
   * Run one RPC against many servers (e.g. create the same user on every hub named X,
   * set the same syslog destination fleet-wide). Each call is individually authorised and audited.
   */
  app.post("/api/fleet/rpc", { preHandler: authenticate }, async (req) => {
    const b = z.object({
      method: z.string(),
      params: z.record(z.string(), z.unknown()).default({}),
      serverIds: z.array(z.number().int()).min(1).max(500),
    }).parse(req.body);
    if (!methods[b.method]) throw new HttpError(404, `Unknown RPC method '${b.method}'`);
    const results = await Promise.all(b.serverIds.map(async (id) => {
      const s = getServer(id);
      if (!s || !canSeeServer(req.principal!.user, id)) return { serverId: id, ok: false, error: "Server not found" };
      try {
        const result = await executeRpc(ctxOf(req), s, b.method, b.params, { auditAction: `bulk.${b.method}` });
        return { serverId: id, serverName: s.name, ok: true, result };
      } catch (e) {
        return { serverId: id, serverName: s.name, ok: false, error: (e as Error).message };
      }
    }));
    return { results };
  });

  /** Prometheus exposition of cached server state (requires an API token or session). */
  app.get("/metrics", { preHandler: authenticate }, async (req, reply) => {
    const u = req.principal!.user;
    const lines: string[] = [];
    const metric = (name: string, help: string, type: "gauge" | "counter") => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    };
    const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    const servers = listServers().filter((s) => canSeeServer(u, s.id)).map((s) => publicServer(s, u));
    const defs: [string, string, "gauge" | "counter", string][] = [
      ["softether_sessions", "Current VPN sessions", "gauge", "NumSessionsTotal_u32"],
      ["softether_tcp_connections", "Current TCP connections", "gauge", "NumTcpConnections_u32"],
      ["softether_hubs", "Virtual hubs", "gauge", "NumHubTotal_u32"],
      ["softether_users", "Registered users", "gauge", "NumUsers_u32"],
      ["softether_groups", "Registered groups", "gauge", "NumGroups_u32"],
      ["softether_mac_table_entries", "MAC table entries", "gauge", "NumMacTables_u32"],
      ["softether_ip_table_entries", "IP table entries", "gauge", "NumIpTables_u32"],
      ["softether_recv_unicast_bytes_total", "Received unicast bytes", "counter", "Recv.UnicastBytes_u64"],
      ["softether_send_unicast_bytes_total", "Sent unicast bytes", "counter", "Send.UnicastBytes_u64"],
      ["softether_recv_broadcast_bytes_total", "Received broadcast bytes", "counter", "Recv.BroadcastBytes_u64"],
      ["softether_send_broadcast_bytes_total", "Sent broadcast bytes", "counter", "Send.BroadcastBytes_u64"],
      ["softether_memory_used_bytes", "OS used physical memory", "gauge", "UsedPhys_u64"],
      ["softether_memory_total_bytes", "OS total physical memory", "gauge", "TotalPhys_u64"],
    ];
    metric("softether_up", "1 if the last poll succeeded", "gauge");
    for (const s of servers) lines.push(`softether_up{server="${esc(s.name)}"} ${s.state?.ok ? 1 : 0}`);
    metric("softether_poll_latency_ms", "Latency of the last poll", "gauge");
    for (const s of servers) if (s.state?.latencyMs != null) lines.push(`softether_poll_latency_ms{server="${esc(s.name)}"} ${s.state.latencyMs}`);
    for (const [name, help, type, field] of defs) {
      metric(name, help, type);
      for (const s of servers) {
        const v = (s.state?.status as Record<string, number> | null)?.[field];
        if (typeof v === "number") lines.push(`${name}{server="${esc(s.name)}"} ${v}`);
      }
    }
    metric("softether_hub_sessions", "Sessions per virtual hub", "gauge");
    for (const s of servers) {
      const hubs = (s.state?.hubs as { HubList?: { HubName_str: string; NumSessions_u32: number; Online_bool: boolean }[] } | null)?.HubList ?? [];
      for (const h of hubs) lines.push(`softether_hub_sessions{server="${esc(s.name)}",hub="${esc(h.HubName_str)}"} ${h.NumSessions_u32}`);
    }
    metric("softether_hub_online", "1 if the virtual hub is online", "gauge");
    for (const s of servers) {
      const hubs = (s.state?.hubs as { HubList?: { HubName_str: string; Online_bool: boolean }[] } | null)?.HubList ?? [];
      for (const h of hubs) lines.push(`softether_hub_online{server="${esc(s.name)}",hub="${esc(h.HubName_str)}"} ${h.Online_bool ? 1 : 0}`);
    }
    reply.header("content-type", "text/plain; version=0.0.4");
    return lines.join("\n") + "\n";
  });
}
