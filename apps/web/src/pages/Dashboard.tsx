import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Anchor, Badge, Button, Card, Group, MultiSelect, Paper, SegmentedControl, SimpleGrid, Stack, Table, Text, ThemeIcon, Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle, IconArrowDown, IconArrowUp, IconDevices, IconLayoutGrid, IconList, IconPlus, IconRefresh, IconServer2,
  IconStack2, IconUsers,
} from "@tabler/icons-react";
import { DataTable } from "../components/DataTable";
import { Empty, ErrorAlert, OnlineBadge, PageHeader, QueryState } from "../components/common";
import { get } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ago, bytes, dt, num } from "../lib/format";
import type { HubListItem, Server } from "../lib/types";

interface FleetSummary {
  totals: { servers: number; online: number; offline: number; sessions: number; users: number; hubs: number; recvBytes: number; sendBytes: number };
  servers: Server[];
}

function StatCard({ label, value, sub, icon, color = "blue", testId }: { label: string; value: React.ReactNode; sub?: React.ReactNode; icon: React.ReactNode; color?: string; testId?: string }) {
  return (
    <Paper withBorder radius="md" p="md" data-testid={testId}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>{label}</Text>
          <Text fw={700} fz={28} lh={1.2} mt={4}>{value}</Text>
          {sub && <Text size="xs" c="dimmed" mt={4} component="div">{sub}</Text>}
        </div>
        <ThemeIcon variant="light" color={color} size={38} radius="md">{icon}</ThemeIcon>
      </Group>
    </Paper>
  );
}

const status = (s: Server) => s.state?.status as Record<string, number> | null | undefined;
const hubList = (s: Server): HubListItem[] => s.state?.hubs?.HubList ?? [];
const version = (s: Server) => {
  const i = s.state?.info;
  if (!i) return null;
  return String(i.ServerVersionString_str ?? "").replace(/\s*\(.*\)\s*$/, "") || null;
};
const serverTraffic = (s: Server) => {
  const st = status(s);
  if (!st) return { recv: 0, send: 0 };
  return {
    recv: (st["Recv.UnicastBytes_u64"] ?? 0) + (st["Recv.BroadcastBytes_u64"] ?? 0),
    send: (st["Send.UnicastBytes_u64"] ?? 0) + (st["Send.BroadcastBytes_u64"] ?? 0),
  };
};

function ServerStatus({ s }: { s: Server }) {
  if (!s.enabled) return <Badge color="gray" variant="light">Disabled</Badge>;
  const badge = <OnlineBadge online={s.state?.ok} />;
  return s.state?.error ? <Tooltip label={s.state.error} multiline w={320} withArrow>{badge}</Tooltip> : badge;
}

function ServerCard({ s, onOpen }: { s: Server; onOpen: () => void }) {
  const st = status(s);
  const t = serverTraffic(s);
  return (
    <Card withBorder radius="md" padding="md" style={{ cursor: "pointer" }} onClick={onOpen} data-testid={`server-card-${s.id}`}>
      <Group justify="space-between" wrap="nowrap" mb={4}>
        <Text fw={700} truncate>{s.name}</Text>
        <ServerStatus s={s} />
      </Group>
      <Text size="xs" c="dimmed" ff="monospace" truncate>{s.host}:{s.port}{s.hub ? ` · hub ${s.hub}` : ""}</Text>
      <Text size="xs" c="dimmed" truncate mt={2}>{version(s) ?? "Version unknown"}</Text>
      <SimpleGrid cols={3} mt="sm" spacing="xs">
        <div><Text size="xs" c="dimmed">Sessions</Text><Text fw={600}>{num(st?.NumSessionsTotal_u32)}</Text></div>
        <div><Text size="xs" c="dimmed">Hubs</Text><Text fw={600}>{num(st?.NumHubTotal_u32 ?? (s.state?.hubs ? hubList(s).length : undefined))}</Text></div>
        <div><Text size="xs" c="dimmed">Latency</Text><Text fw={600}>{s.state?.latencyMs != null ? `${s.state.latencyMs} ms` : "–"}</Text></div>
      </SimpleGrid>
      {st && <Text size="xs" c="dimmed" mt={6}>↓ {bytes(t.recv)} · ↑ {bytes(t.send)}</Text>}
      {s.state?.error && s.enabled && (
        <Text size="xs" c="red" mt={6} lineClamp={2}>{s.state.error}</Text>
      )}
      <Group justify="space-between" mt="sm" gap={4}>
        <Group gap={4}>{s.tags.map((t) => <Badge key={t} size="xs" variant="outline">{t}</Badge>)}</Group>
        <Text size="xs" c="dimmed">{s.state?.checkedAt ? `checked ${ago(s.state.checkedAt)}` : "never checked"}</Text>
      </Group>
    </Card>
  );
}

export default function DashboardPage() {
  const nav = useNavigate();
  const { user } = useAuth();
  const q = useQuery({ queryKey: ["fleet-summary"], queryFn: () => get<FleetSummary>("/api/fleet/summary"), refetchInterval: 15_000 });
  const [tags, setTags] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [view, setView] = useState<string>(() => { try { return localStorage.getItem("sem.dashboard.view") ?? "grid"; } catch { return "grid"; } });

  const allTags = useMemo(() => [...new Set((q.data?.servers ?? []).flatMap((s) => s.tags))].sort(), [q.data]);
  const servers = useMemo(() => (q.data?.servers ?? []).filter((s) => {
    if (tags.length && !tags.some((t) => s.tags.includes(t))) return false;
    if (statusFilter === "online" && !s.state?.ok) return false;
    if (statusFilter === "offline" && (s.state?.ok || !s.enabled)) return false;
    return true;
  }), [q.data, tags, statusFilter]);

  // Totals for the filtered set (equal to backend totals when no filter is active)
  const totals = useMemo(() => {
    const t = { servers: servers.length, online: 0, offline: 0, sessions: 0, users: 0, hubs: 0, recv: 0, send: 0 };
    for (const s of servers) {
      if (s.state?.ok) t.online++; else t.offline++;
      const st = status(s);
      if (st) {
        t.sessions += st.NumSessionsTotal_u32 ?? 0;
        t.users += st.NumUsers_u32 ?? 0;
        t.hubs += st.NumHubTotal_u32 ?? 0;
      }
      const tr = serverTraffic(s);
      t.recv += tr.recv; t.send += tr.send;
    }
    return t;
  }, [servers]);

  const topHubs = useMemo(() => servers
    .flatMap((s) => hubList(s).map((h) => ({ server: s, hub: h })))
    .sort((a, b) => (b.hub.NumSessions_u32 ?? 0) - (a.hub.NumSessions_u32 ?? 0) || a.hub.HubName_str.localeCompare(b.hub.HubName_str))
    .slice(0, 10), [servers]);

  const problems = servers.filter((s) => s.enabled && s.state && s.state.ok === false);
  const isAdmin = user?.role === "admin";
  const filtered = tags.length > 0 || statusFilter !== "all";

  const setViewPersist = (v: string) => { setView(v); try { localStorage.setItem("sem.dashboard.view", v); } catch { /* ignore */ } };

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Fleet-wide health of every SoftEther VPN Server you can access. Data comes from the management server's background poller and refreshes every 15 seconds."
        actions={
          <>
            <Button variant="default" leftSection={<IconRefresh size={16} />} loading={q.isFetching} onClick={() => void q.refetch()} data-testid="dashboard-refresh">Refresh</Button>
            {isAdmin && <Button leftSection={<IconPlus size={16} />} onClick={() => nav("/servers?add=1")}>Add server</Button>}
          </>
        }
      />
      <QueryState query={q}>
        {q.data && q.data.servers.length === 0 ? (
          <Card withBorder radius="md" p="xl" data-testid="dashboard-empty">
            <Stack align="center" gap="sm">
              <ThemeIcon size={56} radius="xl" variant="light"><IconServer2 size={30} /></ThemeIcon>
              <Text fw={700} size="lg">No servers yet</Text>
              <Text c="dimmed" ta="center" maw={520}>
                {isAdmin
                  ? "Register your first SoftEther VPN Server to start monitoring sessions, hubs and traffic from one place."
                  : "No servers have been shared with you yet. Ask an administrator to grant you access."}
              </Text>
              {isAdmin && <Button leftSection={<IconPlus size={16} />} onClick={() => nav("/servers?add=1")} data-testid="dashboard-add-first">Add your first server</Button>}
            </Stack>
          </Card>
        ) : (
          <>
            <SimpleGrid cols={{ base: 1, xs: 2, md: 3, lg: 5 }} mb="md" data-testid="dashboard-kpis">
              <StatCard testId="kpi-servers" label="Servers" value={num(totals.servers)} icon={<IconServer2 size={22} />}
                sub={<Group gap={6}><Badge size="xs" color="green" variant="light">{totals.online} online</Badge>{totals.offline > 0 && <Badge size="xs" color="red" variant="light">{totals.offline} offline</Badge>}</Group>} />
              <StatCard testId="kpi-sessions" label="VPN sessions" value={num(totals.sessions)} icon={<IconDevices size={22} />} color="teal" sub="Active sessions (local + cluster)" />
              <StatCard testId="kpi-hubs" label="Virtual hubs" value={num(totals.hubs)} icon={<IconStack2 size={22} />} color="grape" />
              <StatCard testId="kpi-users" label="VPN users" value={num(totals.users)} icon={<IconUsers size={22} />} color="orange" sub="Registered users across all hubs" />
              <StatCard testId="kpi-traffic" label="Traffic" value={bytes(totals.recv + totals.send)} icon={<IconArrowsIcon />} color="cyan"
                sub={<Group gap={8}><span><IconArrowDown size={11} /> {bytes(totals.recv)}</span><span><IconArrowUp size={11} /> {bytes(totals.send)}</span></Group>} />
            </SimpleGrid>

            {problems.length > 0 && (
              <Paper withBorder radius="md" p="sm" mb="md" style={{ borderColor: "var(--mantine-color-red-5)" }} data-testid="dashboard-problems">
                <Group gap="xs" mb={4}><IconAlertTriangle size={18} color="var(--mantine-color-red-6)" /><Text fw={600}>{problems.length} server(s) need attention</Text></Group>
                <Stack gap={2}>
                  {problems.map((s) => (
                    <Text key={s.id} size="sm">
                      <Anchor onClick={() => nav(`/servers/${s.id}`)}>{s.name}</Anchor>
                      <Text span c="dimmed" size="sm"> — {s.state?.error ?? "unreachable"} ({ago(s.state?.checkedAt)})</Text>
                    </Text>
                  ))}
                </Stack>
              </Paper>
            )}

            <Card withBorder radius="md" padding="lg" mb="md">
              <Group justify="space-between" mb="sm" wrap="wrap">
                <Text fw={700} size="lg">Servers</Text>
                <Group gap="xs" wrap="wrap">
                  {allTags.length > 0 && (
                    <MultiSelect data={allTags} value={tags} onChange={setTags} placeholder={tags.length ? undefined : "Filter by tag"} clearable size="xs" w={240} aria-label="Filter by tag" data-testid="dashboard-tag-filter" />
                  )}
                  <SegmentedControl size="xs" value={statusFilter} onChange={setStatusFilter} data={[{ value: "all", label: "All" }, { value: "online", label: "Online" }, { value: "offline", label: "Offline" }]} />
                  <SegmentedControl size="xs" value={view} onChange={setViewPersist} data={[
                    { value: "grid", label: <IconLayoutGrid size={14} aria-label="Grid view" /> },
                    { value: "table", label: <IconList size={14} aria-label="Table view" /> },
                  ]} />
                </Group>
              </Group>
              {servers.length === 0 ? <Empty>No servers match the filter</Empty> : view === "grid" ? (
                <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 4 }} data-testid="dashboard-server-grid">
                  {servers.map((s) => <ServerCard key={s.id} s={s} onOpen={() => nav(`/servers/${s.id}`)} />)}
                </SimpleGrid>
              ) : (
                <DataTable
                  testId="dashboard-servers-table"
                  data={servers}
                  rowKey={(s) => s.id}
                  onRowClick={(s) => nav(`/servers/${s.id}`)}
                  initialSort={{ key: "name", dir: "asc" }}
                  columns={[
                    { key: "name", title: "Name", render: (s) => <Text fw={600}>{s.name}</Text> },
                    { key: "status", title: "Status", value: (s) => (s.enabled ? (s.state?.ok ? 2 : 1) : 0), render: (s) => <ServerStatus s={s} /> },
                    { key: "endpoint", title: "Endpoint", value: (s) => `${s.host}:${s.port}`, render: (s) => <Text size="sm" ff="monospace">{s.host}:{s.port}</Text> },
                    { key: "version", title: "Version", value: (s) => version(s) ?? "", render: (s) => <Text size="sm">{version(s) ?? "–"}</Text> },
                    { key: "sessions", title: "Sessions", align: "right", value: (s) => status(s)?.NumSessionsTotal_u32 ?? -1, render: (s) => num(status(s)?.NumSessionsTotal_u32) },
                    { key: "hubs", title: "Hubs", align: "right", value: (s) => status(s)?.NumHubTotal_u32 ?? -1, render: (s) => num(status(s)?.NumHubTotal_u32) },
                    { key: "traffic", title: "Traffic ↓/↑", align: "right", value: (s) => serverTraffic(s).recv + serverTraffic(s).send, render: (s) => status(s) ? `${bytes(serverTraffic(s).recv)} / ${bytes(serverTraffic(s).send)}` : "–" },
                    { key: "latency", title: "Latency", align: "right", value: (s) => s.state?.latencyMs ?? -1, render: (s) => (s.state?.latencyMs != null ? `${s.state.latencyMs} ms` : "–") },
                    { key: "checked", title: "Last check", value: (s) => s.state?.checkedAt ?? 0, render: (s) => <Tooltip label={dt(s.state?.checkedAt)}><Text size="sm">{ago(s.state?.checkedAt)}</Text></Tooltip> },
                    { key: "error", title: "Error", value: (s) => s.state?.error ?? "", render: (s) => <Text size="xs" c="red" lineClamp={2} maw={280}>{s.state?.error ?? ""}</Text> },
                    { key: "tags", title: "Tags", value: (s) => s.tags.join(" "), render: (s) => <Group gap={4}>{s.tags.map((t) => <Badge key={t} size="xs" variant="outline">{t}</Badge>)}</Group> },
                  ]}
                />
              )}
              {filtered && <Text size="xs" c="dimmed" mt="xs">KPIs above reflect the filtered servers ({servers.length} of {q.data?.servers.length}).</Text>}
            </Card>

            <Card withBorder radius="md" padding="lg" mb="md">
              <Text fw={700} size="lg">Top hubs by sessions</Text>
              <Text size="sm" c="dimmed" mb="sm">The busiest Virtual Hubs across the servers shown above.</Text>
              {topHubs.length === 0 ? <Empty>No hub data yet</Empty> : (
                <Table.ScrollContainer minWidth={600}>
                  <Table striped highlightOnHover data-testid="dashboard-top-hubs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Hub</Table.Th><Table.Th>Server</Table.Th><Table.Th>Status</Table.Th>
                        <Table.Th ta="right">Sessions</Table.Th><Table.Th ta="right">Users</Table.Th><Table.Th ta="right">Traffic ↓/↑</Table.Th><Table.Th>Last activity</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {topHubs.map(({ server: s, hub: h }) => {
                        const rx = Number(h["Ex.Recv.UnicastBytes_u64"] ?? 0) + Number(h["Ex.Recv.BroadcastBytes_u64"] ?? 0);
                        const tx = Number(h["Ex.Send.UnicastBytes_u64"] ?? 0) + Number(h["Ex.Send.BroadcastBytes_u64"] ?? 0);
                        return (
                          <Table.Tr key={`${s.id}/${h.HubName_str}`} style={{ cursor: "pointer" }} onClick={() => nav(`/servers/${s.id}/hubs/${encodeURIComponent(h.HubName_str)}`)}>
                            <Table.Td><Text fw={600} size="sm">{h.HubName_str}</Text></Table.Td>
                            <Table.Td><Text size="sm">{s.name}</Text></Table.Td>
                            <Table.Td><OnlineBadge online={h.Online_bool} /></Table.Td>
                            <Table.Td ta="right">{num(h.NumSessions_u32)}</Table.Td>
                            <Table.Td ta="right">{num(h.NumUsers_u32)}</Table.Td>
                            <Table.Td ta="right">{bytes(rx)} / {bytes(tx)}</Table.Td>
                            <Table.Td><Text size="sm">{ago(h.LastCommTime_dt)}</Text></Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}
            </Card>
          </>
        )}
        {q.data && q.error && <ErrorAlert error={q.error} />}
      </QueryState>
    </>
  );
}

function IconArrowsIcon() {
  return <Group gap={0} wrap="nowrap"><IconArrowDown size={16} /><IconArrowUp size={16} /></Group>;
}
