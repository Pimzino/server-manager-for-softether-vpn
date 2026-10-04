import { Link } from "react-router";
import { Alert, Anchor, Badge, Button, Group, Progress, SimpleGrid, Stack, Table, Text, Tooltip } from "@mantine/core";
import {
  IconActivity, IconClock, IconDevices, IconPlugConnected, IconRefresh, IconStack2, IconUsers, IconUsersGroup, IconTable, IconNetwork,
  IconArrowRight, IconAlertTriangle,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorAlert, KeyValue, OnlineBadge, PageHeader, QueryState, Section } from "../../components/common";
import { StatCard, duration, enumLabel } from "../../components/server-a/shared";
import { useCatalog, useRpc, useScope, useServer } from "../../lib/hooks";
import { ago, bytes, dt, num } from "../../lib/format";
import type { HubListItem } from "../../lib/types";

const SERVER_TYPE: Record<number, string> = { 0: "Standalone server", 1: "Cluster controller", 2: "Cluster member" };
const REFRESH_MS = 10_000;

type Info = Record<string, any>;
type Status = Record<string, any>;

function versionText(info: Info) {
  const v = Number(info.ServerVerInt_u32 ?? 0);
  return v ? `${Math.floor(v / 100)}.${String(v % 100).padStart(2, "0")}` : "–";
}

function TrafficTable({ s }: { s: Status }) {
  const n = (k: string) => Number(s[k] ?? 0);
  const rows = [
    { dir: "Received", ub: n("Recv.UnicastBytes_u64"), uc: n("Recv.UnicastCount_u64"), bb: n("Recv.BroadcastBytes_u64"), bc: n("Recv.BroadcastCount_u64") },
    { dir: "Sent", ub: n("Send.UnicastBytes_u64"), uc: n("Send.UnicastCount_u64"), bb: n("Send.BroadcastBytes_u64"), bc: n("Send.BroadcastCount_u64") },
  ];
  return (
    <Table striped withTableBorder data-testid="overview-traffic">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Direction</Table.Th>
          <Table.Th ta="right">Unicast bytes</Table.Th>
          <Table.Th ta="right">Unicast packets</Table.Th>
          <Table.Th ta="right">Broadcast bytes</Table.Th>
          <Table.Th ta="right">Broadcast packets</Table.Th>
          <Table.Th ta="right">Total bytes</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((r) => (
          <Table.Tr key={r.dir}>
            <Table.Td fw={600}>{r.dir}</Table.Td>
            <Table.Td ta="right"><Tooltip label={`${num(r.ub)} bytes`}><span>{bytes(r.ub)}</span></Tooltip></Table.Td>
            <Table.Td ta="right">{num(r.uc)}</Table.Td>
            <Table.Td ta="right"><Tooltip label={`${num(r.bb)} bytes`}><span>{bytes(r.bb)}</span></Tooltip></Table.Td>
            <Table.Td ta="right">{num(r.bc)}</Table.Td>
            <Table.Td ta="right" fw={600}>{bytes(r.ub + r.bb)}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function MemoryBar({ label, total, used, free }: { label: string; total: number; used: number; free: number }) {
  if (!total) {
    return (
      <div>
        <Text size="sm" fw={600}>{label}</Text>
        <Text size="sm" c="dimmed">Not reported by this operating system.</Text>
      </div>
    );
  }
  const pct = Math.min(100, Math.round((used / total) * 100));
  return (
    <div>
      <Group justify="space-between" mb={4}>
        <Text size="sm" fw={600}>{label}</Text>
        <Text size="sm" c="dimmed">{bytes(used)} used of {bytes(total)} · {bytes(free)} free ({pct}%)</Text>
      </Group>
      <Progress value={pct} color={pct > 90 ? "red" : pct > 75 ? "orange" : "blue"} size="lg" radius="sm" />
    </div>
  );
}

function HubQuickLinks({ serverId, hubs }: { serverId: number; hubs: HubListItem[] | undefined }) {
  if (!hubs) return null;
  const sorted = [...hubs].sort((a, b) => b.NumSessions_u32 - a.NumSessions_u32 || a.HubName_str.localeCompare(b.HubName_str));
  return (
    <Section
      title="Virtual Hubs"
      description="Hubs on this server, busiest first."
      actions={<Button component={Link} to={`/servers/${serverId}/hubs`} variant="light" size="xs" rightSection={<IconArrowRight size={14} />}>All hubs</Button>}
    >
      {sorted.length === 0 ? <Text c="dimmed" size="sm">No Virtual Hubs.</Text> : (
        <Table data-testid="overview-hubs">
          <Table.Thead>
            <Table.Tr><Table.Th>Hub</Table.Th><Table.Th>Status</Table.Th><Table.Th ta="right">Sessions</Table.Th><Table.Th ta="right">Users</Table.Th><Table.Th>Last activity</Table.Th></Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sorted.slice(0, 10).map((h) => (
              <Table.Tr key={h.HubName_str}>
                <Table.Td><Anchor component={Link} to={`/servers/${serverId}/hubs/${encodeURIComponent(h.HubName_str)}`} fw={600}>{h.HubName_str}</Anchor></Table.Td>
                <Table.Td><OnlineBadge online={h.Online_bool} /></Table.Td>
                <Table.Td ta="right">{num(h.NumSessions_u32)}</Table.Td>
                <Table.Td ta="right">{num(h.NumUsers_u32)}</Table.Td>
                <Table.Td>{ago(h.LastCommTime_dt)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {sorted.length > 10 && <Text size="xs" c="dimmed" mt={4}>Showing 10 of {sorted.length} hubs.</Text>}
    </Section>
  );
}

export default function OverviewPage() {
  const { serverId } = useScope();
  const qc = useQueryClient();
  const server = useServer(serverId);
  const catalog = useCatalog();
  const s = server.data;
  const hubMode = !!s?.hub;
  const limited = !!s?.visibleHubs;
  const restricted = hubMode || limited;
  const info = useRpc<Info>(serverId, "GetServerInfo", {}, { refetchInterval: REFRESH_MS, enabled: !!s });
  const status = useRpc<Status>(serverId, "GetServerStatus", {}, { refetchInterval: REFRESH_MS, enabled: !!s && !restricted });
  const hubs = useRpc<{ HubList?: HubListItem[] }>(serverId, "EnumHub", {}, { refetchInterval: REFRESH_MS, enabled: !!s });
  const st = s?.state;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
    void qc.invalidateQueries({ queryKey: ["server", serverId] });
  };

  const i = info.data;
  const t = status.data;
  const uptimeMs = t ? new Date(t.CurrentTime_dt).getTime() - new Date(t.StartTime_dt).getTime() : undefined;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Live status of this VPN server. Refreshes automatically every 10 seconds."
        badge={<Badge variant="dot" color={info.isFetching || status.isFetching ? "blue" : "gray"}>auto-refresh 10s</Badge>}
        actions={<Button variant="default" leftSection={<IconRefresh size={16} />} onClick={refresh} loading={info.isFetching && !info.data} data-testid="overview-refresh">Refresh</Button>}
      />

      <Section title="Management connection" description="How the management server sees this VPN server (background health poll).">
        <Group gap="xl" wrap="wrap" data-testid="overview-poll">
          <div><Text size="xs" c="dimmed">State</Text><OnlineBadge online={st?.ok} onLabel="Reachable" offLabel="Unreachable" /></div>
          <div><Text size="xs" c="dimmed">Latency</Text><Text fw={600}>{st?.latencyMs != null ? `${st.latencyMs} ms` : "–"}</Text></div>
          <div><Text size="xs" c="dimmed">Last check</Text><Tooltip label={st?.checkedAt ? dt(st.checkedAt) : "Never"}><Text fw={600}>{st?.checkedAt ? ago(st.checkedAt) : "Never"}</Text></Tooltip></div>
          <div><Text size="xs" c="dimmed">Endpoint</Text><Text fw={600} ff="monospace">{s ? `${s.host}:${s.port}` : "–"}</Text></div>
          <div><Text size="xs" c="dimmed">TLS verification</Text><Text fw={600}>{s ? { pin: "Pinned fingerprint", ca: "CA certificate", insecure: "Not verified" }[s.tlsMode] : "–"}</Text></div>
          {hubMode && <div><Text size="xs" c="dimmed">Mode</Text><Badge color="grape" variant="light">Hub admin: {s?.hub}</Badge></div>}
        </Group>
        {st?.error && <Alert mt="sm" color="red" icon={<IconAlertTriangle size={16} />} title="Last poll failed">{st.error}</Alert>}
      </Section>

      {restricted && (
        <Alert color="grape" variant="light" mb="md" title={hubMode ? "Hub administrator connection" : "Hub-scoped access"}>
          {hubMode
            ? <>This server is managed with Virtual Hub administrator credentials, so server-wide status (sessions, traffic, memory) is not available. </>
            : <>Your access is limited to specific Virtual Hubs, so server-wide status is hidden. </>}
          {hubMode && s?.hub && <Anchor component={Link} to={`/servers/${serverId}/hubs/${encodeURIComponent(s.hub)}`}>Open the status of hub {s.hub} →</Anchor>}
        </Alert>
      )}

      {!restricted && (
        <QueryState query={status}>
          {t && (
            <>
              <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="md" mb="md" data-testid="overview-stats">
                <StatCard label="Uptime" value={duration(uptimeMs)} hint={`Since ${dt(t.StartTime_dt)}`} icon={<IconClock size={20} />} color="teal" testId="stat-uptime" />
                <StatCard label="VPN sessions" value={num(t.NumSessionsTotal_u32)} hint={`${num(t.NumSessionsLocal_u32)} local · ${num(t.NumSessionsRemote_u32)} remote`} icon={<IconActivity size={20} />} testId="stat-sessions" />
                <StatCard label="TCP connections" value={num(t.NumTcpConnections_u32)} hint={`${num(t.NumTcpConnectionsLocal_u32)} local · ${num(t.NumTcpConnectionsRemote_u32)} remote`} icon={<IconPlugConnected size={20} />} color="indigo" testId="stat-tcp" />
                <StatCard label="Virtual Hubs" value={num(t.NumHubTotal_u32)} hint={`${num(t.NumHubStandalone_u32)} standalone · ${num(t.NumHubStatic_u32)} static · ${num(t.NumHubDynamic_u32)} dynamic`} icon={<IconStack2 size={20} />} color="violet" testId="stat-hubs" />
                <StatCard label="Users" value={num(t.NumUsers_u32)} hint="Total across all hubs" icon={<IconUsers size={20} />} color="cyan" />
                <StatCard label="Groups" value={num(t.NumGroups_u32)} hint="Total across all hubs" icon={<IconUsersGroup size={20} />} color="cyan" />
                <StatCard label="MAC table entries" value={num(t.NumMacTables_u32)} hint="Total across all hubs" icon={<IconTable size={20} />} color="gray" />
                <StatCard label="IP table entries" value={num(t.NumIpTables_u32)} hint="Total across all hubs" icon={<IconNetwork size={20} />} color="gray" />
              </SimpleGrid>

              <Section title="Traffic" description="Cumulative traffic through all Virtual Hubs since the server started.">
                <TrafficTable s={t} />
              </Section>

              <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
                <Section title="Memory">
                  <Stack gap="md">
                    <MemoryBar label="Physical memory" total={Number(t.TotalPhys_u64 ?? 0)} used={Number(t.UsedPhys_u64 ?? 0)} free={Number(t.FreePhys_u64 ?? 0)} />
                    <MemoryBar label="Virtual memory (incl. swap)" total={Number(t.TotalMemory_u64 ?? 0)} used={Number(t.UsedMemory_u64 ?? 0)} free={Number(t.FreeMemory_u64 ?? 0)} />
                  </Stack>
                </Section>
                <Section title="Clock & licenses">
                  <KeyValue rows={[
                    ["Server type", SERVER_TYPE[t.ServerType_u32] ?? enumLabel(catalog.data, "VpnRpcServerType", t.ServerType_u32)],
                    ["Server current time", dt(t.CurrentTime_dt)],
                    ["Started", <>{dt(t.StartTime_dt)} <Text span c="dimmed" size="xs">({ago(t.StartTime_dt)})</Text></>],
                    ["High-precision system tick", num(t.CurrentTick_u64)],
                    ["Assigned client licenses", `${num(t.AssignedClientLicenses_u32)} (cluster-wide ${num(t.AssignedClientLicensesTotal_u32)})`],
                    ["Assigned bridge licenses", `${num(t.AssignedBridgeLicenses_u32)} (cluster-wide ${num(t.AssignedBridgeLicensesTotal_u32)})`],
                  ]} />
                </Section>
              </SimpleGrid>
            </>
          )}
        </QueryState>
      )}

      <Section title="Server information" description="Product, build and host operating system (GetServerInfo).">
        {info.error ? <ErrorAlert error={info.error} /> : (
          <QueryState query={info}>
            {i && (
              <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md" data-testid="overview-info">
                <KeyValue rows={[
                  ["Product", i.ServerProductName_str],
                  ["Version", <>{versionText(i)} <Text span c="dimmed" size="xs">({i.ServerVersionString_str})</Text></>],
                  ["Build", num(i.ServerBuildInt_u32)],
                  ["Build info", i.ServerBuildInfoString_str],
                  ["Build date", dt(i.ServerBuildDate_dt)],
                  ["Family", i.ServerFamilyName_str || "–"],
                  ["Server type", <Badge variant="light" color="gray">{SERVER_TYPE[i.ServerType_u32] ?? enumLabel(catalog.data, "VpnRpcServerType", i.ServerType_u32)}</Badge>],
                ]} />
                <KeyValue rows={[
                  ["Host name", i.ServerHostName_str],
                  ["Operating system", `${i.OsSystemName_str ?? ""} ${i.OsVersion_str ?? ""}`.trim() || "–"],
                  ["OS type", enumLabel(catalog.data, "VpnRpcOsType", i.OsType_u32)],
                  ["OS product / vendor", [i.OsProductName_str, i.OsVendorName_str].filter(Boolean).join(" / ") || "–"],
                  ["Service pack", i.OsServicePack_u32 ? num(i.OsServicePack_u32) : "–"],
                  ["Kernel", i.KernelName_str || "–"],
                  ["Kernel version", <Text size="sm" style={{ wordBreak: "break-word" }}>{i.KernelVersion_str || "–"}</Text>],
                ]} />
              </SimpleGrid>
            )}
          </QueryState>
        )}
      </Section>

      {!hubMode && (hubs.error ? <ErrorAlert error={hubs.error} /> : <HubQuickLinks serverId={serverId} hubs={hubs.data?.HubList} />)}
      {!restricted && (
        <Group gap="xs">
          <Button component={Link} to={`/servers/${serverId}/connections`} variant="subtle" size="xs" leftSection={<IconDevices size={14} />}>TCP connections</Button>
          <Button component={Link} to={`/servers/${serverId}/listeners`} variant="subtle" size="xs" leftSection={<IconPlugConnected size={14} />}>Listeners</Button>
        </Group>
      )}
    </>
  );
}
