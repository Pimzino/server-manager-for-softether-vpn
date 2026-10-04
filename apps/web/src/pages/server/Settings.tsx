import { useEffect, useState } from "react";
import { Button, Code, Group, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Switch, Text, TextInput, Typography } from "@mantine/core";
import { IconDeviceFloppy } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { Empty, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { HelpLabel, useServerAccess } from "../../components/server-b/ui";
import { useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import { b64ToText, num } from "../../lib/format";

interface Keep { UseKeepConnect_bool?: boolean; KeepConnectHost_str?: string; KeepConnectPort_u32?: number; KeepConnectProtocol_u32?: number; KeepConnectInterval_u32?: number }
interface Syslog { SaveType_u32?: number; Hostname_str?: string; Port_u32?: number }
interface AdminOpt { Name_str: string; Value_u32: number; Descrption_utf: string }

const KEEP_DOC = {
  use: "Keep the Internet connection alive by sending packets to a nominated server at a fixed interval. Useful where idle connections are dropped (NAT routers, mobile links). Packets carry random content; no information identifying a computer or user is sent.",
  host: "Host name or IP address of the keep-alive destination.",
  port: "Port number of the destination.",
  protocol: "Protocol used for keep-alive packets.",
  interval: "Interval between packet sends, in seconds.",
};

const SYSLOG_TYPES = [
  { value: "0", label: "Do not use syslog" },
  { value: "1", label: "Server log only" },
  { value: "2", label: "Server log and Virtual Hub security logs" },
  { value: "3", label: "Server, hub security and packet logs" },
];

function hostValid(h: string) {
  return /^[A-Za-z0-9]([A-Za-z0-9-]{0,62})?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62})?)*\.?$/.test(h) || /^[0-9a-fA-F:]+$/.test(h);
}

function KeepAliveSection({ serverId, canEdit }: { serverId: number; canEdit: boolean }) {
  const q = useRpc<Keep>(serverId, "GetKeep");
  const [f, setF] = useState<Keep>({});
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  const save = useRpcMutation(serverId, "SetKeep", { success: "Keep-alive settings saved" });
  const d = q.data;
  const dirty = !!d && (Object.keys(f) as (keyof Keep)[]).some((k) => f[k] !== d[k]);
  const hostErr = f.UseKeepConnect_bool && !(f.KeepConnectHost_str ?? "").trim() ? "Required" : f.KeepConnectHost_str && !hostValid(f.KeepConnectHost_str.trim()) ? "Invalid host name" : undefined;
  const portErr = f.UseKeepConnect_bool && (!f.KeepConnectPort_u32 || f.KeepConnectPort_u32 > 65535) ? "1–65535" : undefined;
  const intErr = f.UseKeepConnect_bool && (!f.KeepConnectInterval_u32 || f.KeepConnectInterval_u32 < 5 || f.KeepConnectInterval_u32 > 600) ? "5–600 seconds" : undefined;
  const invalid = !!(hostErr || portErr || intErr);
  return (
    <Section title="Keep-alive Internet connection" description="Sends small packets periodically so that NAT routers and ISPs do not drop idle connections.">
      <QueryState query={q}>
        <form onSubmit={(e) => { e.preventDefault(); save.mutate({ ...d, ...f, KeepConnectHost_str: (f.KeepConnectHost_str ?? "").trim() }); }}>
          <Stack>
            <Switch label={<HelpLabel label="Enable keep-alive" doc={KEEP_DOC.use} />} checked={!!f.UseKeepConnect_bool} disabled={!canEdit}
              onChange={(e) => setF((s) => ({ ...s, UseKeepConnect_bool: e.currentTarget.checked }))} data-testid="keep-enable" />
            <SimpleGrid cols={{ base: 1, md: 4 }}>
              <TextInput label={<HelpLabel label="Destination host" doc={KEEP_DOC.host} />} value={f.KeepConnectHost_str ?? ""} readOnly={!canEdit} error={hostErr}
                onChange={(e) => setF((s) => ({ ...s, KeepConnectHost_str: e.currentTarget.value }))} data-testid="keep-host" />
              <NumberInput label={<HelpLabel label="Port" doc={KEEP_DOC.port} />} min={1} max={65535} allowDecimal={false} value={f.KeepConnectPort_u32 ?? 80} readOnly={!canEdit} error={portErr}
                onChange={(v) => setF((s) => ({ ...s, KeepConnectPort_u32: Number(v) || 0 }))} data-testid="keep-port" />
              <div>
                <Text size="sm" fw={500} mb={4}><HelpLabel label="Protocol" doc={KEEP_DOC.protocol} /></Text>
                <SegmentedControl data={[{ value: "0", label: "TCP" }, { value: "1", label: "UDP" }]} value={String(f.KeepConnectProtocol_u32 ?? 1)} disabled={!canEdit}
                  onChange={(v) => setF((s) => ({ ...s, KeepConnectProtocol_u32: Number(v) }))} data-testid="keep-protocol" />
              </div>
              <NumberInput label={<HelpLabel label="Interval" doc={KEEP_DOC.interval} />} min={5} max={600} allowDecimal={false} value={f.KeepConnectInterval_u32 ?? 50} readOnly={!canEdit} error={intErr}
                rightSection={<Text size="xs" c="dimmed">sec</Text>} onChange={(v) => setF((s) => ({ ...s, KeepConnectInterval_u32: Number(v) || 0 }))} data-testid="keep-interval" />
            </SimpleGrid>
            {canEdit && (
              <Group justify="flex-end">
                <Button variant="default" disabled={!dirty} onClick={() => d && setF(d)}>Reset</Button>
                <Button type="submit" leftSection={<IconDeviceFloppy size={16} />} loading={save.isPending} disabled={!dirty || invalid} data-testid="save-keep">Save</Button>
              </Group>
            )}
          </Stack>
        </form>
      </QueryState>
    </Section>
  );
}

function SyslogSection({ serverId, canEdit }: { serverId: number; canEdit: boolean }) {
  const q = useRpc<Syslog>(serverId, "GetSysLog");
  const [f, setF] = useState<Syslog>({});
  useEffect(() => { if (q.data) setF({ ...q.data, Port_u32: q.data.Port_u32 || 514 }); }, [q.data]);
  const save = useRpcMutation(serverId, "SetSysLog", { success: "Syslog settings saved" });
  const d = q.data;
  const on = (f.SaveType_u32 ?? 0) !== 0;
  const dirty = !!d && (f.SaveType_u32 !== d.SaveType_u32 || (f.Hostname_str ?? "") !== (d.Hostname_str ?? "") || f.Port_u32 !== (d.Port_u32 || 514));
  const hostErr = on && !(f.Hostname_str ?? "").trim() ? "Required when syslog is enabled" : f.Hostname_str && !hostValid(f.Hostname_str.trim()) ? "Invalid host name" : undefined;
  const portErr = on && (!f.Port_u32 || f.Port_u32 > 65535) ? "1–65535" : undefined;
  return (
    <Section title="Syslog forwarding" description="Send log records to a syslog server (UDP) in addition to the local log files.">
      <QueryState query={q}>
        <form onSubmit={(e) => { e.preventDefault(); save.mutate({ ...d, ...f, Hostname_str: (f.Hostname_str ?? "").trim() }); }}>
          <Stack>
            <SimpleGrid cols={{ base: 1, md: 3 }}>
              <Select label={<HelpLabel label="What to send" doc="The behaviour of the syslog function: which logs are forwarded to the syslog server." />} data={SYSLOG_TYPES}
                value={String(f.SaveType_u32 ?? 0)} onChange={(v) => setF((s) => ({ ...s, SaveType_u32: Number(v ?? 0) }))} allowDeselect={false} readOnly={!canEdit} data-testid="syslog-type" />
              <TextInput label={<HelpLabel label="Syslog server" doc="Host name or IP address of the syslog server." />} value={f.Hostname_str ?? ""} readOnly={!canEdit} disabled={!on} error={hostErr}
                onChange={(e) => setF((s) => ({ ...s, Hostname_str: e.currentTarget.value }))} data-testid="syslog-host" />
              <NumberInput label={<HelpLabel label="Port" doc="UDP port of the syslog server (usually 514)." />} min={1} max={65535} allowDecimal={false} value={f.Port_u32 ?? 514} readOnly={!canEdit} disabled={!on} error={portErr}
                onChange={(v) => setF((s) => ({ ...s, Port_u32: Number(v) || 0 }))} data-testid="syslog-port" />
            </SimpleGrid>
            {(f.SaveType_u32 ?? 0) === 3 && <Text size="xs" c="orange">Packet logs can be extremely voluminous; make sure the syslog server and network can absorb the rate.</Text>}
            {canEdit && (
              <Group justify="flex-end">
                <Button variant="default" disabled={!dirty} onClick={() => d && setF({ ...d, Port_u32: d.Port_u32 || 514 })}>Reset</Button>
                <Button type="submit" leftSection={<IconDeviceFloppy size={16} />} loading={save.isPending} disabled={!dirty || !!hostErr || !!portErr} data-testid="save-syslog">Save</Button>
              </Group>
            )}
          </Stack>
        </form>
      </QueryState>
    </Section>
  );
}

function AdminMessageSection({ serverId }: { serverId: number }) {
  const q = useRpc<{ Msg_bin?: string }>(serverId, "GetAdminMsg");
  const text = b64ToText(q.data?.Msg_bin);
  return (
    <Section title="Message for administrators" description="Message the VPN Server shows to administrators when they connect (e.g. update notices from the vendor). Read-only.">
      <QueryState query={q}>
        {text ? (
          <Typography><Code block style={{ whiteSpace: "pre-wrap" }} data-testid="admin-msg">{text}</Code></Typography>
        ) : <Empty>No administrator message</Empty>}
      </QueryState>
    </Section>
  );
}

function DefaultAdminOptionsSection({ serverId }: { serverId: number }) {
  // The defaults are server-wide, but the management gateway treats this method as hub-scoped
  // (its input type carries HubName_str), so pass any existing hub name.
  const hubs = useRpc<{ HubList?: { HubName_str: string }[] }>(serverId, "EnumHub");
  const anyHub = hubs.data?.HubList?.map((h) => h.HubName_str).sort()[0];
  const q = useRpc<{ AdminOptionList?: AdminOpt[] }>(serverId, "GetDefaultHubAdminOptions", { HubName_str: anyHub ?? "" }, { enabled: !!anyHub });
  if (hubs.data && !anyHub) {
    return (
      <Section title="Default Virtual Hub admin options" description="Default values of the Virtual Hub administration options, applied to newly created hubs.">
        <Empty>Create a Virtual Hub first; the server reports these defaults through an existing hub.</Empty>
      </Section>
    );
  }
  return (
    <Section title="Default Virtual Hub admin options" description="Default values of the Virtual Hub administration options, applied to newly created hubs. Hub-specific values are edited on each hub's “Admin & ext options” page.">
      <QueryState query={{ isLoading: hubs.isLoading || q.isLoading, error: hubs.error ?? q.error }}>
        <DataTable
          testId="default-admin-options-table"
          data={q.data?.AdminOptionList}
          rowKey={(r) => r.Name_str}
          initialSort={{ key: "Name_str", dir: "asc" }}
          maxHeight={520}
          columns={[
            { key: "Name_str", title: "Option", width: 280, render: (r) => <Text size="sm" ff="monospace">{r.Name_str}</Text> },
            { key: "Value_u32", title: "Default", align: "right", width: 90, render: (r) => <Text size="sm" fw={r.Value_u32 ? 600 : undefined}>{num(r.Value_u32)}</Text> },
            { key: "Descrption_utf", title: "Description", render: (r) => <Text size="xs" c="dimmed">{r.Descrption_utf}</Text> },
          ]}
        />
      </QueryState>
    </Section>
  );
}

export default function ServerSettingsPage() {
  const { serverId } = useScope();
  const { role, isOperator } = useServerAccess(serverId);
  return (
    <>
      <PageHeader title="Server settings" description="Server-wide miscellaneous settings: keep-alive, syslog forwarding, administrator message and default hub admin options." />
      {!isOperator && <ReadOnlyNotice role={role} />}
      <KeepAliveSection serverId={serverId} canEdit={isOperator} />
      <SyslogSection serverId={serverId} canEdit={isOperator} />
      <AdminMessageSection serverId={serverId} />
      <DefaultAdminOptionsSection serverId={serverId} />
    </>
  );
}
