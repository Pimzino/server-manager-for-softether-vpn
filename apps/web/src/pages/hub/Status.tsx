import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  Badge, Button, Group, SegmentedControl, SimpleGrid, Table, Text, Tooltip,
} from "@mantine/core";
import {
  IconActivity, IconAddressBook, IconDevices, IconFilter, IconListDetails, IconLogin, IconNetwork, IconRefresh,
  IconSettings, IconTable, IconUsers, IconUsersGroup, IconMessage, IconFileText,
} from "@tabler/icons-react";
import { ConfirmButton, KeyValue, OnlineBadge, PageHeader, QueryState, Section } from "../../components/common";
import { HUB_TYPE_LABELS, StatCard, useHubAccess } from "../../components/hub-a/shared";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import { ago, bytes, dt, num } from "../../lib/format";

interface HubStatus {
  HubName_str: string;
  Online_bool: boolean;
  HubType_u32: number;
  NumSessions_u32: number;
  NumSessionsClient_u32: number;
  NumSessionsBridge_u32: number;
  NumAccessLists_u32: number;
  NumUsers_u32: number;
  NumGroups_u32: number;
  NumMacTables_u32: number;
  NumIpTables_u32: number;
  "Recv.BroadcastBytes_u64": number;
  "Recv.BroadcastCount_u64": number;
  "Recv.UnicastBytes_u64": number;
  "Recv.UnicastCount_u64": number;
  "Send.BroadcastBytes_u64": number;
  "Send.BroadcastCount_u64": number;
  "Send.UnicastBytes_u64": number;
  "Send.UnicastCount_u64": number;
  SecureNATEnabled_bool: boolean;
  LastCommTime_dt: string;
  LastLoginTime_dt: string;
  CreatedTime_dt: string;
  NumLogin_u32: number;
}

const n = (v: unknown) => Number(v ?? 0) || 0;

/** Bytes/second rates computed from the delta between two consecutive polls. */
function useRates(s: HubStatus | undefined, updatedAt: number) {
  const prev = useRef<{ t: number; rx: number; tx: number } | null>(null);
  const [rate, setRate] = useState<{ rx: number; tx: number } | null>(null);
  useEffect(() => {
    if (!s) return;
    const now = Date.now();
    const rx = n(s["Recv.UnicastBytes_u64"]) + n(s["Recv.BroadcastBytes_u64"]);
    const tx = n(s["Send.UnicastBytes_u64"]) + n(s["Send.BroadcastBytes_u64"]);
    const p = prev.current;
    if (p && now - p.t > 500 && rx >= p.rx && tx >= p.tx) {
      const sec = (now - p.t) / 1000;
      setRate({ rx: (rx - p.rx) / sec, tx: (tx - p.tx) / sec });
    }
    prev.current = { t: now, rx, tx };
  }, [s, updatedAt]);
  return rate;
}

const INTERVALS = [
  { value: "0", label: "Off" },
  { value: "5000", label: "5s" },
  { value: "15000", label: "15s" },
  { value: "60000", label: "60s" },
];

export default function HubStatusPage() {
  const { serverId, hub, canWrite, base } = useHubAccess();
  const [interval, setIntervalMs] = useState("5000");
  const q = useRpc<HubStatus>(serverId, "GetHubStatus", { HubName_str: hub }, {
    refetchInterval: Number(interval) || false,
    enabled: !!hub,
  });
  const s = q.data;
  const rate = useRates(s, q.dataUpdatedAt);
  const setOnline = useRpcMutation(serverId, "SetHubOnline", { success: "Virtual Hub status changed" });

  const rxBytes = n(s?.["Recv.UnicastBytes_u64"]) + n(s?.["Recv.BroadcastBytes_u64"]);
  const txBytes = n(s?.["Send.UnicastBytes_u64"]) + n(s?.["Send.BroadcastBytes_u64"]);
  const rxPk = n(s?.["Recv.UnicastCount_u64"]) + n(s?.["Recv.BroadcastCount_u64"]);
  const txPk = n(s?.["Send.UnicastCount_u64"]) + n(s?.["Send.BroadcastCount_u64"]);

  const toggle = canWrite && s && (
    s.Online_bool ? (
      <ConfirmButton
        title={`Take ${hub} offline?`}
        message="While the Virtual Hub is offline it refuses every VPN connection, and all sessions currently connected (clients, bridges, cascades) are disconnected immediately."
        confirmLabel="Take offline"
        color="orange"
        size="sm"
        onConfirm={() => setOnline.mutateAsync({ HubName_str: hub, Online_bool: false })}
        loading={setOnline.isPending}
      >
        <span data-testid="hub-offline">Take offline</span>
      </ConfirmButton>
    ) : (
      <Button color="green" variant="light" loading={setOnline.isPending} data-testid="hub-online"
        onClick={() => setOnline.mutate({ HubName_str: hub, Online_bool: true })}>
        Bring online
      </Button>
    )
  );

  return (
    <>
      <PageHeader
        title="Hub status"
        badge={s && <><OnlineBadge online={s.Online_bool} /><Badge variant="outline" color="gray">{HUB_TYPE_LABELS[s.HubType_u32] ?? `Type ${s.HubType_u32}`}</Badge></>}
        description="Live counters of this Virtual Hub: connected sessions, registered objects, address tables and traffic since the hub was started."
        actions={
          <>
            <Tooltip label="Auto-refresh interval">
              <SegmentedControl size="xs" data={INTERVALS} value={interval} onChange={setIntervalMs} data-testid="status-refresh-interval" />
            </Tooltip>
            <Button variant="default" size="sm" leftSection={<IconRefresh size={16} />} loading={q.isFetching} onClick={() => q.refetch()} data-testid="status-refresh">Refresh</Button>
            {toggle}
          </>
        }
      />
      <QueryState query={q}>
        {s && (
          <>
            <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="md" mb="md" data-testid="hub-status-stats">
              <StatCard testId="stat-sessions" label="Sessions" value={num(s.NumSessions_u32)} icon={<IconDevices size={20} />}
                sub={`${num(s.NumSessionsClient_u32)} client · ${num(s.NumSessionsBridge_u32)} bridge`} />
              <StatCard testId="stat-users" label="Users" value={num(s.NumUsers_u32)} icon={<IconUsers size={20} />} color="grape"
                sub={`${num(s.NumGroups_u32)} group(s)`} />
              <StatCard testId="stat-tables" label="MAC / IP table" value={`${num(s.NumMacTables_u32)} / ${num(s.NumIpTables_u32)}`} icon={<IconTable size={20} />} color="teal"
                sub="Learned addresses" />
              <StatCard testId="stat-logins" label="Logins" value={num(s.NumLogin_u32)} icon={<IconLogin size={20} />} color="orange"
                sub={`Last: ${ago(s.LastLoginTime_dt)}`} />
            </SimpleGrid>

            <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
              <Section title="Summary">
                <KeyValue rows={[
                  ["Status", <OnlineBadge online={s.Online_bool} />],
                  ["Hub type", HUB_TYPE_LABELS[s.HubType_u32] ?? s.HubType_u32],
                  ["Sessions (total)", num(s.NumSessions_u32)],
                  ["Client-mode sessions", num(s.NumSessionsClient_u32)],
                  ["Bridge-mode sessions", num(s.NumSessionsBridge_u32)],
                  ["Users", num(s.NumUsers_u32)],
                  ["Groups", num(s.NumGroups_u32)],
                  ["Access list entries", num(s.NumAccessLists_u32)],
                  ["MAC table entries", num(s.NumMacTables_u32)],
                  ["IP table entries", num(s.NumIpTables_u32)],
                  ["SecureNAT", <Badge variant="light" color={s.SecureNATEnabled_bool ? "green" : "gray"}>{s.SecureNATEnabled_bool ? "Enabled" : "Disabled"}</Badge>],
                  ["Number of logins", num(s.NumLogin_u32)],
                  ["Created", <>{dt(s.CreatedTime_dt)} <Text span c="dimmed" size="xs">({ago(s.CreatedTime_dt)})</Text></>],
                  ["Last login", <>{dt(s.LastLoginTime_dt)} <Text span c="dimmed" size="xs">({ago(s.LastLoginTime_dt)})</Text></>],
                  ["Last communication", <>{dt(s.LastCommTime_dt)} <Text span c="dimmed" size="xs">({ago(s.LastCommTime_dt)})</Text></>],
                ]} />
              </Section>

              <div>
                <Section
                  title="Traffic"
                  description="Cumulative counters since the hub started. Receive = from VPN sessions into the hub; send = from the hub to sessions."
                  actions={rate && <Badge variant="light" leftSection={<IconActivity size={12} />}>{bytes(rate.rx)}/s in · {bytes(rate.tx)}/s out</Badge>}
                >
                  <Table data-testid="hub-traffic-table" withTableBorder verticalSpacing={6}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Direction</Table.Th>
                        <Table.Th ta="right">Unicast</Table.Th>
                        <Table.Th ta="right">Broadcast</Table.Th>
                        <Table.Th ta="right">Total</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {(["Recv", "Send"] as const).map((d) => (
                        <Table.Tr key={d}>
                          <Table.Td><Text size="sm" fw={600}>{d === "Recv" ? "Received" : "Sent"}</Text></Table.Td>
                          <Table.Td ta="right">
                            <Text size="sm">{bytes(n(s[`${d}.UnicastBytes_u64`]))}</Text>
                            <Text size="xs" c="dimmed">{num(n(s[`${d}.UnicastCount_u64`]))} pkts</Text>
                          </Table.Td>
                          <Table.Td ta="right">
                            <Text size="sm">{bytes(n(s[`${d}.BroadcastBytes_u64`]))}</Text>
                            <Text size="xs" c="dimmed">{num(n(s[`${d}.BroadcastCount_u64`]))} pkts</Text>
                          </Table.Td>
                          <Table.Td ta="right">
                            <Text size="sm" fw={600}>{bytes(d === "Recv" ? rxBytes : txBytes)}</Text>
                            <Text size="xs" c="dimmed">{num(d === "Recv" ? rxPk : txPk)} pkts</Text>
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                  <Text size="xs" c="dimmed" mt="xs">
                    Grand total {bytes(rxBytes + txBytes)} in {num(rxPk + txPk)} packets.
                  </Text>
                </Section>

                <Section title="Quick actions">
                  <Group gap="xs">
                    <Button component={Link} to={`${base}/sessions`} variant="light" size="xs" leftSection={<IconDevices size={14} />}>Sessions</Button>
                    <Button component={Link} to={`${base}/users`} variant="light" size="xs" leftSection={<IconUsers size={14} />}>Users</Button>
                    <Button component={Link} to={`${base}/groups`} variant="light" size="xs" leftSection={<IconUsersGroup size={14} />}>Groups</Button>
                    <Button component={Link} to={`${base}/tables`} variant="light" size="xs" leftSection={<IconAddressBook size={14} />}>MAC &amp; IP tables</Button>
                    <Button component={Link} to={`${base}/access`} variant="light" size="xs" leftSection={<IconFilter size={14} />}>Access lists</Button>
                    <Button component={Link} to={`${base}/securenat`} variant="light" size="xs" leftSection={<IconNetwork size={14} />}>SecureNAT</Button>
                    <Button component={Link} to={`${base}/message`} variant="light" size="xs" leftSection={<IconMessage size={14} />}>Client message</Button>
                    <Button component={Link} to={`${base}/logging`} variant="light" size="xs" leftSection={<IconFileText size={14} />}>Logging</Button>
                    <Button component={Link} to={`${base}/options`} variant="light" size="xs" leftSection={<IconListDetails size={14} />}>Options</Button>
                    <Button component={Link} to={`${base}/settings`} variant="light" size="xs" leftSection={<IconSettings size={14} />}>Properties</Button>
                  </Group>
                </Section>
              </div>
            </SimpleGrid>
          </>
        )}
      </QueryState>
    </>
  );
}
