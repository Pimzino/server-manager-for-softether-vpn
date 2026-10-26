// Server › Overview. The REFERENCE PAGE for ported pages: data via useRpc, layout via the design
// components (PageHeader, Section, PropertyList, MetricGrid, DataTable), no ad-hoc styling.
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@mantine/core";
import { IconPencil, IconPlugConnectedX, IconRefresh, IconStack2 } from "@tabler/icons-react";
import { post } from "../../lib/api";
import { enumLabel, useCatalog, useRpc, useScope, useServer } from "../../lib/hooks";
import { ago, agoShort, bytes, dateShort, dt, duration, num, serverVersion, shortFp } from "../../lib/format";
import { secretStore } from "../../lib/platform";
import type { HubListItem } from "../../lib/types";
import { hubBase, serverBase } from "../../sections";
import {
  CopyField, DataTable, EmptyState, ErrorState, Meter, Metric, MetricGrid, MetricSkeleton, Mono, PageHeader, PropertyList, PropertySkeleton,
  QueryState, Section, SectionGrid, StatusBadge, Tag, serverStatus, useShell,
} from "../../design";

const SERVER_TYPE: Record<number, string> = { 0: "Standalone server", 1: "Cluster controller", 2: "Cluster member" };
const TRANSPORT = { native: "Native admin protocol", jsonrpc: "JSON-RPC API" } as const;
const REFRESH_MS = 10_000;

type Info = Record<string, any>;
type Status = Record<string, any>;

export default function OverviewPage() {
  const { serverId } = useScope();
  const nav = useNavigate();
  const shell = useShell();
  const server = useServer(serverId);
  const catalog = useCatalog();
  const qc = useQueryClient();
  const s = server.data;
  const hubMode = !!s?.hub;
  // The background poll already knows the server is down: don't hammer it from every section.
  const reachable = s?.state?.ok !== false;
  const info = useRpc<Info>(serverId, "GetServerInfo", {}, { refetchInterval: REFRESH_MS, enabled: !!s && reachable });
  const status = useRpc<Status>(serverId, "GetServerStatus", {}, { refetchInterval: REFRESH_MS, enabled: !!s && reachable && !hubMode });
  const hubs = useRpc<{ HubList?: HubListItem[] }>(serverId, "EnumHub", {}, { refetchInterval: REFRESH_MS, enabled: !!s && reachable });

  if (!s) return null;
  const st = serverStatus(s);
  const i = info.data;
  const t = status.data;
  const uptimeMs = t ? new Date(t.CurrentTime_dt).getTime() - new Date(t.StartTime_dt).getTime() : undefined;
  const n = (k: string) => Number(t?.[k] ?? 0);
  const store = secretStore();
  const hubRows = [...(hubs.data?.HubList ?? [])].sort((a, b) => b.NumSessions_u32 - a.NumSessions_u32 || a.HubName_str.localeCompare(b.HubName_str));

  return (
    <>
      <PageHeader
        title="Overview"
        meta={<>
          <StatusBadge status={st.status} tooltip={st.detail} testId="overview-status">{st.label}</StatusBadge>
          <span className="sem-dim">·</span><Mono dim>{s.host}:{s.port}</Mono>
          {i && <><span className="sem-dim">·</span>{serverVersion(i)}</>}
          {hubMode && <><span className="sem-dim">·</span><Tag color="purple">Hub admin: {s.hub}</Tag></>}
        </>}
        actions={<Button variant="default" leftSection={<IconPencil size={14} />} onClick={() => shell.openConnection(s.id)} data-testid="overview-edit">Edit Connection…</Button>}
      />

      {!reachable && (
        <div className="sem-unreachable" data-testid="overview-unreachable">
          <EmptyState
            icon={<IconPlugConnectedX size={30} stroke={1.4} />}
            title={<>Can’t reach {s.name}</>}
            description={<>{s.state?.error ?? "The last status check failed."}<br /><span className="sem-dim">Last checked {agoShort(s.state?.checkedAt)}.</span></>}
            action={(
              <div className="sem-row-inline">
                <Button variant="default" onClick={() => shell.openConnection(s.id)}>Edit Connection…</Button>
                <Button leftSection={<IconRefresh size={14} />} onClick={async () => {
                  await post(`/api/servers/${serverId}/refresh`).catch(() => undefined);
                  void qc.invalidateQueries({ queryKey: ["server", serverId] });
                  void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
                }}>Try Again</Button>
              </div>
            )}
          />
        </div>
      )}

      {reachable && !hubMode && (
        <QueryState query={status} skeleton={<MetricSkeleton count={6} />}>
          {t && (
            <MetricGrid testId="overview-stats" min={122}>
              <Metric label="Uptime" value={duration(uptimeMs)} hint={`Since ${dateShort(t.StartTime_dt)}`} testId="stat-uptime" />
              <Metric label="VPN sessions" value={num(t.NumSessionsTotal_u32)} hint={`${num(t.NumSessionsLocal_u32)} local · ${num(t.NumSessionsRemote_u32)} remote`} testId="stat-sessions" />
              <Metric label="TCP connections" value={num(t.NumTcpConnections_u32)} hint={`${num(t.NumTcpConnectionsLocal_u32)} local · ${num(t.NumTcpConnectionsRemote_u32)} remote`} testId="stat-tcp" />
              <Metric label="Virtual Hubs" value={num(t.NumHubTotal_u32)} hint={t.NumHubStatic_u32 + t.NumHubDynamic_u32 ? `${num(t.NumHubStatic_u32 + t.NumHubDynamic_u32)} in cluster` : "Standalone"} testId="stat-hubs" onClick={() => nav(`${serverBase(serverId)}/hubs`)} />
              <Metric label="Users" value={num(t.NumUsers_u32)} hint={`${num(t.NumGroups_u32)} groups`} />
              <Metric label="MAC / IP entries" value={`${num(t.NumMacTables_u32)} / ${num(t.NumIpTables_u32)}`} hint="Learned addresses" />
            </MetricGrid>
          )}
        </QueryState>
      )}

      {reachable && hubMode && (
        <div className="sem-callouts">
          <div className="sem-callout" data-tone="purple">
            <IconStack2 size={16} stroke={1.7} />
            <div className="sem-callout-text">
              <b>Hub administrator connection.</b> Server-wide status isn’t available with the hub’s password.
            </div>
            <Button size="xs" variant="default" onClick={() => nav(hubBase(serverId, s.hub!))}>Open {s.hub}</Button>
          </div>
        </div>
      )}

      {reachable && <SectionGrid>
        <Section title="Connection" variant="inset" testId="overview-poll">
          <PropertyList labelWidth={130} items={[
            { label: "Status", value: <StatusBadge status={st.status}>{st.label}{s.state?.ok && s.state.latencyMs != null ? ` · ${s.state.latencyMs} ms` : ""}</StatusBadge> },
            { label: "Last checked", value: s.state?.checkedAt ? <span title={dt(s.state.checkedAt)}>{ago(s.state.checkedAt)}</span> : "Never" },
            { label: "Protocol", value: TRANSPORT[s.transport] ?? s.transport },
            { label: "Certificate", value: s.tlsMode === "pin"
              ? <CopyField value={s.fingerprint ?? ""} display={`Trusted · ${shortFp(s.fingerprint)}`} size="sm" />
              : s.tlsMode === "ca" ? "Verified with a CA" : <Tag color="red">Not verified</Tag> },
            { label: "Password", value: s.passwordSaved ? store.saved : s.unlocked ? "Entered for this session" : "Not saved" },
          ]} />
        </Section>

        <Section title="Server" variant="inset">
          {info.error ? <ErrorState error={info.error} inline onRetry={() => void info.refetch()} /> : !i ? <PropertySkeleton /> : (
            <PropertyList labelWidth={130} testId="overview-info" items={[
              { label: "Product", value: i.ServerProductName_str },
              { label: "Version", value: serverVersion(i) },
              { label: "Type", value: SERVER_TYPE[i.ServerType_u32] ?? enumLabel(catalog.data, "VpnRpcServerType", i.ServerType_u32) },
              { label: "Host name", value: i.ServerHostName_str },
              { label: "Operating system", value: [i.OsProductName_str, i.OsVersion_str].filter(Boolean).join(" ") || "–" },
              { label: "Built", value: dt(i.ServerBuildDate_dt) },
            ]} />
          )}
        </Section>
      </SectionGrid>}

      {reachable && !hubMode && t && (
        <SectionGrid>
          <Section title="Traffic" description="Through all Virtual Hubs since the server started.">
            <DataTable
              testId="overview-traffic" searchable={false} footer={false} rowKey={(r) => r.dir}
              data={[
                { dir: "Received", ub: n("Recv.UnicastBytes_u64"), up: n("Recv.UnicastCount_u64"), bb: n("Recv.BroadcastBytes_u64"), bp: n("Recv.BroadcastCount_u64") },
                { dir: "Sent", ub: n("Send.UnicastBytes_u64"), up: n("Send.UnicastCount_u64"), bb: n("Send.BroadcastBytes_u64"), bp: n("Send.BroadcastCount_u64") },
              ]}
              columns={[
                { key: "dir", title: "", sortable: false, render: (r) => <span className="sem-strong">{r.dir}</span> },
                { key: "ub", title: "Unicast", align: "right", sortable: false, render: (r) => <span title={`${num(r.up)} packets`}>{bytes(r.ub)}</span> },
                { key: "bb", title: "Broadcast", align: "right", sortable: false, render: (r) => <span title={`${num(r.bp)} packets`}>{bytes(r.bb)}</span> },
                { key: "total", title: "Total", align: "right", sortable: false, render: (r) => <span className="sem-strong">{bytes(r.ub + r.bb)}</span> },
              ]}
            />
          </Section>
          <Section title="Memory">
            <div className="sem-stack">
              <Meter label="Physical" value={n("UsedPhys_u64")} max={n("TotalPhys_u64")} detail={n("TotalPhys_u64") ? `${bytes(n("UsedPhys_u64"))} of ${bytes(n("TotalPhys_u64"))}` : "Not reported"} />
              <Meter label="Virtual (incl. swap)" value={n("UsedMemory_u64")} max={n("TotalMemory_u64")} detail={n("TotalMemory_u64") ? `${bytes(n("UsedMemory_u64"))} of ${bytes(n("TotalMemory_u64"))}` : "Not reported"} />
            </div>
          </Section>
        </SectionGrid>
      )}

      {reachable && <Section
        title="Virtual Hubs"
        actions={!hubMode ? <Button size="xs" variant="default" onClick={() => nav(`${serverBase(serverId)}/hubs`)}>Manage Hubs…</Button> : undefined}
      >
        <DataTable
          testId="overview-hubs"
          aria-label="Virtual Hubs"
          data={hubs.data ? hubRows : undefined}
          loading={hubs.isLoading}
          error={hubs.error}
          onRetry={() => void hubs.refetch()}
          rowKey={(h) => h.HubName_str}
          searchable={hubRows.length > 8}
          selectable="single"
          onRowOpen={(h) => nav(hubBase(serverId, h.HubName_str))}
          rowTestId={(h) => `overview-hub-${h.HubName_str}`}
          empty={{ title: "No Virtual Hubs", description: "Create one on the Virtual Hubs page." }}
          columns={[
            { key: "HubName_str", title: "Name", render: (h) => <span className="sem-strong">{h.HubName_str}</span> },
            { key: "Online_bool", title: "Status", width: 100, render: (h) => <StatusBadge status={h.Online_bool ? "ok" : "off"}>{h.Online_bool ? "Online" : "Offline"}</StatusBadge> },
            { key: "NumSessions_u32", title: "Sessions", align: "right", width: 90, render: (h) => num(h.NumSessions_u32) },
            { key: "NumUsers_u32", title: "Users", align: "right", width: 80, render: (h) => num(h.NumUsers_u32) },
            { key: "NumGroups_u32", title: "Groups", align: "right", width: 80, render: (h) => num(h.NumGroups_u32) },
            { key: "LastCommTime_dt", title: "Last activity", width: 140, render: (h) => <span className="sem-dim">{agoShort(h.LastCommTime_dt)}</span> },
          ]}
        />
      </Section>}
    </>
  );
}
