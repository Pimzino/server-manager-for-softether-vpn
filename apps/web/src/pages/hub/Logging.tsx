import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Alert, Anchor, Button, Group, SegmentedControl, Select, SimpleGrid, Stack, Switch, Table, Text } from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";
import { PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { SaveBar, useDocs, useEnumOptions, useHubAccess } from "../../components/hub-a/shared";
import { useCatalog, useRpc, useRpcMutation } from "../../lib/hooks";

interface HubLog {
  HubName_str?: string;
  SaveSecurityLog_bool: boolean;
  SecurityLogSwitchType_u32: number;
  SavePacketLog_bool: boolean;
  PacketLogSwitchType_u32: number;
  PacketLogConfig_u32: number[];
  [k: string]: unknown;
}

const SWITCH_FALLBACK = [
  { value: 0, label: "No switching (single file)" },
  { value: 1, label: "Every second" },
  { value: 2, label: "Every minute" },
  { value: 3, label: "Every hour" },
  { value: 4, label: "Every day" },
  { value: 5, label: "Every month" },
];

/** VpnRpcPacketLogSettingIndex, with operator-friendly explanations. */
const PACKET_TYPES: { index: number; key: string; label: string; help: string }[] = [
  { index: 0, key: "TcpConnection", label: "TCP connection log", help: "TCP SYN / FIN / RST — who connected to what." },
  { index: 1, key: "TcpAll", label: "TCP packet log", help: "Every TCP packet. Very large volumes on busy hubs." },
  { index: 2, key: "Dhcp", label: "DHCP log", help: "DHCP requests and address assignments." },
  { index: 3, key: "Udp", label: "UDP log", help: "UDP packets (DNS, VoIP, …)." },
  { index: 4, key: "Icmp", label: "ICMP log", help: "Ping and other ICMP messages." },
  { index: 5, key: "Ip", label: "IP log", help: "Other IP protocols (not TCP/UDP/ICMP)." },
  { index: 6, key: "Arp", label: "ARP log", help: "Address resolution packets." },
  { index: 7, key: "Ethernet", label: "Ethernet log", help: "Non-IP Ethernet frames." },
];

const LEVELS = [
  { value: "0", label: "None" },
  { value: "1", label: "Header" },
  { value: "2", label: "All" },
];

/** SoftEther factory default for a new hub. */
const DEFAULT_CONFIG = [1, 0, 1, 0, 0, 0, 0, 0];

function normalize(arr: number[] | undefined): number[] {
  const out = Array.from({ length: 16 }, (_, i) => Number(arr?.[i] ?? 0));
  return out;
}

export default function HubLoggingPage() {
  const { serverId, hub, role, canWrite } = useHubAccess();
  const doc = useDocs("VpnRpcHubLog");
  const catalog = useCatalog();
  const switchOptions = useEnumOptions("VpnRpcLogSwitchType", SWITCH_FALLBACK);
  const levelDocs = catalog.data?.enums.VpnRpcPacketLogSetting?.values;
  const typeDocs = catalog.data?.enums.VpnRpcPacketLogSettingIndex?.values;

  const q = useRpc<HubLog>(serverId, "GetHubLog", { HubName_str: hub }, { enabled: !!hub });
  const initial = useMemo<HubLog | null>(() => q.data ? { ...q.data, PacketLogConfig_u32: normalize(q.data.PacketLogConfig_u32) } : null, [q.data]);
  const [form, setForm] = useState<HubLog | null>(null);
  useEffect(() => setForm(initial), [initial]);
  const save = useRpcMutation(serverId, "SetHubLog", { success: "Logging settings saved" });
  const dirty = !!form && !!initial && JSON.stringify(form) !== JSON.stringify(initial);

  const setLevel = (i: number, v: number) => form && setForm({
    ...form, PacketLogConfig_u32: form.PacketLogConfig_u32.map((x, j) => (j === i ? v : x)),
  });
  const setAll = (vals: number[]) => form && setForm({
    ...form, PacketLogConfig_u32: form.PacketLogConfig_u32.map((x, j) => (j < vals.length ? vals[j] : x)),
  });
  const heavy = form?.SavePacketLog_bool && form.PacketLogConfig_u32.slice(0, 8).some((v, i) => v === 2 || (i === 1 && v > 0));

  return (
    <>
      <PageHeader
        title="Logging"
        description={<>Security and packet logs written by the VPN Server for this Virtual Hub (under <code>security_log/{hub}</code> and <code>packet_log/{hub}</code>). Log files can be browsed on the server's <Anchor component={Link} to={`/servers/${serverId}/logs`} size="sm">Logs</Anchor> page.</>}
      />
      {!canWrite && <ReadOnlyNotice role={role} />}
      <QueryState query={q}>
        {form && (
          <>
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
              <Section title="Security log" description="Records authentication, session establishment and termination, policy violations and other security events.">
                <Stack gap="md">
                  <Switch label="Save security log" description={doc("SaveSecurityLog_bool")}
                    checked={form.SaveSecurityLog_bool} disabled={!canWrite} data-testid="log-security-save"
                    onChange={(e) => setForm({ ...form, SaveSecurityLog_bool: e.currentTarget.checked })} />
                  <Select label="Log file switching" description={doc("SecurityLogSwitchType_u32")} data={switchOptions}
                    value={String(form.SecurityLogSwitchType_u32)} allowDeselect={false} readOnly={!canWrite}
                    disabled={!form.SaveSecurityLog_bool} data-testid="log-security-switch"
                    onChange={(v) => setForm({ ...form, SecurityLogSwitchType_u32: Number(v ?? 4) })} />
                </Stack>
              </Section>
              <Section title="Packet log" description="Records the headers or full contents of packets passing through the Virtual Hub, per packet type below.">
                <Stack gap="md">
                  <Switch label="Save packet log" description="Enable / disable saving packet logs"
                    checked={form.SavePacketLog_bool} disabled={!canWrite} data-testid="log-packet-save"
                    onChange={(e) => setForm({ ...form, SavePacketLog_bool: e.currentTarget.checked })} />
                  <Select label="Log file switching" description={doc("PacketLogSwitchType_u32")} data={switchOptions}
                    value={String(form.PacketLogSwitchType_u32)} allowDeselect={false} readOnly={!canWrite}
                    disabled={!form.SavePacketLog_bool} data-testid="log-packet-switch"
                    onChange={(v) => setForm({ ...form, PacketLogSwitchType_u32: Number(v ?? 4) })} />
                </Stack>
              </Section>
            </SimpleGrid>

            <Section
              title="Packet types to log"
              description={<>For each packet type choose what is saved: <b>None</b> — {levelDocs?.[0]?.doc ?? "not saved"}; <b>Header</b> — {levelDocs?.[1]?.doc ?? "only header"}; <b>All</b> — {levelDocs?.[2]?.doc ?? "all payloads"}.</>}
              actions={canWrite && (
                <Group gap="xs">
                  <Button size="xs" variant="default" onClick={() => setAll(DEFAULT_CONFIG)} data-testid="log-preset-default">Factory default</Button>
                  <Button size="xs" variant="default" onClick={() => setAll([1, 1, 1, 1, 1, 1, 1, 1])}>All headers</Button>
                  <Button size="xs" variant="default" onClick={() => setAll([0, 0, 0, 0, 0, 0, 0, 0])}>None</Button>
                </Group>
              )}
            >
              {!form.SavePacketLog_bool && (
                <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />} mb="sm">Packet logging is disabled; these settings apply once it is enabled.</Alert>
              )}
              <Table data-testid="packet-log-table" verticalSpacing="xs" striped>
                <Table.Thead>
                  <Table.Tr><Table.Th>Packet type</Table.Th><Table.Th>Description</Table.Th><Table.Th ta="right">Save</Table.Th></Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {PACKET_TYPES.map((t) => {
                    const v = form.PacketLogConfig_u32[t.index] ?? 0;
                    const changed = v !== (initial?.PacketLogConfig_u32[t.index] ?? 0);
                    return (
                      <Table.Tr key={t.key}>
                        <Table.Td>
                          <Text size="sm" fw={changed ? 700 : 500}>{typeDocs?.find((e) => e.value === t.index)?.doc ?? t.label}</Text>
                          <Text size="xs" c="dimmed" ff="monospace">{t.key}</Text>
                        </Table.Td>
                        <Table.Td><Text size="xs" c="dimmed">{t.help}</Text></Table.Td>
                        <Table.Td ta="right">
                          <SegmentedControl size="xs" data={LEVELS} value={String(v)} readOnly={!canWrite}
                            color={v === 2 ? "orange" : v === 1 ? "blue" : undefined}
                            onChange={(x) => setLevel(t.index, Number(x))} data-testid={`packet-log-${t.key}`} />
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
              {heavy && (
                <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />} mt="sm">
                  Logging every TCP packet or full payloads produces very large log files, can slow the hub down and may capture
                  sensitive user data. Make sure disk space and privacy obligations allow it.
                </Alert>
              )}
            </Section>
            {canWrite && (
              <SaveBar dirty={dirty} saving={save.isPending} onReset={() => setForm(initial)}
                onSave={() => save.mutate({ ...form, HubName_str: hub })} testId="log-save" />
            )}
          </>
        )}
      </QueryState>
    </>
  );
}
