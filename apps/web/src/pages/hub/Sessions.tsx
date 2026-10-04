import { useState } from "react";
import { useNavigate } from "react-router";
import { ActionIcon, Badge, Button, Code, Drawer, Group, SegmentedControl, Select, Stack, Switch, Text, Tooltip } from "@mantine/core";
import { IconEye, IconPlugConnectedX, IconRefresh, IconTable } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, ErrorAlert, PageHeader, QueryState } from "../../components/common";
import { CONNECTION_GROUPS, SessionStatusBadge, StatusGroups, fmtVersion, type FieldGroup } from "../../components/hub/StatusView";
import { ago, bytes, dt, num } from "../../lib/format";
import { can, useRpc, useRpcMutation, useScope, useServer } from "../../lib/hooks";

interface SessionItem {
  Name_str: string; RemoteSession_bool: boolean; RemoteHostname_str: string; Username_str: string; ClientIP_ip: string; Hostname_str: string;
  MaxNumTcp_u32: number; CurrentNumTcp_u32: number; PacketSize_u64: number; PacketNum_u64: number; LinkMode_bool: boolean; SecureNATMode_bool: boolean;
  BridgeMode_bool: boolean; Layer3Mode_bool: boolean; Client_BridgeMode_bool: boolean; Client_MonitorMode_bool: boolean; VLanId_u32: number;
  CreatedTime_dt: string; LastCommTime_dt: string; Ip_ip?: string; IsDormant_bool?: boolean; IsDormantEnabled_bool?: boolean; LastCommDormant_dt?: string;
  [k: string]: unknown;
}

function sessionKind(s: SessionItem): { label: string; color: string } {
  if (s.SecureNATMode_bool) return { label: "SecureNAT", color: "teal" };
  if (s.LinkMode_bool) return { label: "Cascade", color: "violet" };
  if (s.BridgeMode_bool) return { label: "Local bridge", color: "orange" };
  if (s.Layer3Mode_bool) return { label: "L3 switch", color: "cyan" };
  return { label: "Client", color: "blue" };
}

function flags(s: SessionItem) {
  const f: string[] = [];
  if (s.Client_BridgeMode_bool) f.push("Bridge/router mode");
  if (s.Client_MonitorMode_bool) f.push("Monitor mode");
  if (s.RemoteSession_bool) f.push("Remote (cluster)");
  if (s.IsDormant_bool) f.push("Dormant");
  return f;
}

const SESSION_GROUPS: FieldGroup[] = [
  {
    title: "Identity",
    fields: [
      ["Session name", "Name_str"], ["User name", "Username_str"], ["Authenticated as", "RealUsername_str"], ["Group", "GroupName_str"],
      ["Cascade session", "LinkMode_bool"], ["Client IP address", "Client_Ip_Address_ip"], ["Client IP (session)", "SessionStatus_ClientIp_ip"],
      ["Client hostname (session)", "SessionStatus_ClientHostName_str"], ["Client port", "ClientPort_u32"],
    ],
  },
  {
    title: "Client",
    fields: [
      ["Client product", "ClientProductName_str"],
      ["Client version", "ClientProductVer_u32", (v, all) => fmtVersion(v, all.ClientProductBuild_u32)],
      ["Client OS", "ClientOsName_str"], ["Client OS version", "ClientOsVer_str"], ["Client OS product ID", "ClientOsProductId_str"],
      ["Client host name", "ClientHostname_str"], ["Client IP", "ClientIpAddress_ip"], ["Unique ID", "UniqueId_bin"],
      ["Proxy host", "ProxyHostname_str"], ["Proxy IP", "ProxyIpAddress_ip"], ["Proxy port", "ProxyPort_u32"],
    ],
  },
  ...CONNECTION_GROUPS,
];

function SessionDrawer({ serverId, hub, name, onClose, canWrite, onDisconnected }: {
  serverId: number; hub: string; name: string | null; onClose: () => void; canWrite: boolean; onDisconnected: () => void;
}) {
  const q = useRpc<Record<string, unknown>>(serverId, "GetSessionStatus", { HubName_str: hub, Name_str: name ?? "" }, { enabled: !!name, refetchInterval: 5000 });
  const del = useRpcMutation(serverId, "DeleteSession", { success: "Session disconnected", onSuccess: onDisconnected });
  return (
    <Drawer opened={!!name} onClose={onClose} position="right" size="xl" title={<Text fw={700}>Session <Code>{name}</Code></Text>}>
      <Stack>
        <Group justify="space-between">
          <Group gap="xs">
            {q.data && <SessionStatusBadge value={Number(q.data.SessionStatus_u32)} />}
            {q.data?.CipherName_str ? <Badge variant="outline" color="gray" tt="none">{String(q.data.CipherName_str)}</Badge> : null}
            {q.data?.IsUsingUdpAcceleration_bool ? <Badge variant="light" color="teal">UDP accel</Badge> : null}
            {q.data?.UseCompress_bool ? <Badge variant="light" color="grape">Compressed</Badge> : null}
          </Group>
          <Group gap="xs">
            <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={() => q.refetch()} loading={q.isFetching}>Refresh</Button>
            {canWrite && name && (
              <ConfirmButton title={`Disconnect session ${name}?`} confirmLabel="Disconnect" leftSection={<IconPlugConnectedX size={14} />}
                message="The session is terminated immediately. VPN clients configured to reconnect will usually connect again; to block a user, change their policy or delete them."
                onConfirm={() => del.mutateAsync({ HubName_str: hub, Name_str: name })}>Disconnect</ConfirmButton>
            )}
          </Group>
        </Group>
        {q.error ? <ErrorAlert error={q.error} /> : (
          <QueryState query={q}>{q.data && <StatusGroups data={q.data} groups={SESSION_GROUPS} hide={["HubName_str", "SessionStatus_ClientIp6_bin", "ProxyIpAddress6_bin", "ClientIpAddress6_bin", "ServerIpAddress6_bin"]} />}</QueryState>
        )}
      </Stack>
    </Drawer>
  );
}

export default function SessionsPage() {
  const { serverId, hub = "" } = useScope();
  const role = useServer(serverId).data?.myRole;
  const canWrite = can(role, "operator");
  const nav = useNavigate();
  const [auto, setAuto] = useState(true);
  const [interval, setIntervalMs] = useState("5000");
  const [kind, setKind] = useState<string | null>(null);
  const q = useRpc<{ SessionList?: SessionItem[] }>(serverId, "EnumSession", { HubName_str: hub }, { refetchInterval: auto ? Number(interval) : false });
  const [open, setOpen] = useState<string | null>(null);
  const del = useRpcMutation(serverId, "DeleteSession", { success: "Session disconnected" });

  const list = (q.data?.SessionList ?? []).filter((s) => !kind || sessionKind(s).label === kind);
  const all = q.data?.SessionList ?? [];
  const counts = all.reduce<Record<string, number>>((m, s) => { const k = sessionKind(s).label; m[k] = (m[k] ?? 0) + 1; return m; }, {});

  return (
    <>
      <PageHeader
        title="Sessions"
        description="VPN sessions currently connected to this Virtual Hub: VPN clients, cascade links, local bridges, SecureNAT and Layer-3 switch sessions."
        badge={<Badge variant="light">{all.length} connected</Badge>}
        actions={<>
          <Group gap={6}>
            <Switch label="Auto-refresh" checked={auto} onChange={(e) => setAuto(e.currentTarget.checked)} data-testid="sessions-autorefresh" />
            {auto && <SegmentedControl size="xs" value={interval} onChange={setIntervalMs} data={[{ value: "2000", label: "2s" }, { value: "5000", label: "5s" }, { value: "15000", label: "15s" }]} />}
          </Group>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => q.refetch()} loading={q.isFetching}>Refresh</Button>
        </>}
      />
      <QueryState query={q}>
        <DataTable
          testId="sessions-table"
          data={list}
          rowKey={(s) => s.Name_str}
          onRowClick={(s) => setOpen(s.Name_str)}
          initialSort={{ key: "CreatedTime_dt", dir: "desc" }}
          empty="No sessions connected"
          toolbar={
            <Select size="sm" w={200} placeholder="All session types" clearable value={kind} onChange={setKind} aria-label="Filter by type"
              data={Object.entries(counts).map(([k, n]) => ({ value: k, label: `${k} (${n})` }))} />
          }
          columns={[
            { key: "Name_str", title: "Session", render: (s) => <Text fw={600} size="sm" ff="monospace">{s.Name_str}</Text> },
            { key: "Username_str", title: "User" },
            { key: "kind", title: "Type", value: (s) => sessionKind(s).label, render: (s) => {
              const k = sessionKind(s);
              return (
                <Group gap={4}>
                  <Badge variant="light" color={k.color}>{k.label}</Badge>
                  {flags(s).map((f) => <Badge key={f} size="xs" variant="outline" color="gray" tt="none">{f}</Badge>)}
                </Group>
              );
            } },
            { key: "source", title: "Source host / IP", value: (s) => `${s.Hostname_str} ${s.ClientIP_ip}`, render: (s) => (
              <Stack gap={0}>
                <Text size="sm">{s.Hostname_str || "–"}</Text>
                {s.ClientIP_ip && s.ClientIP_ip !== "::" && s.ClientIP_ip !== "0.0.0.0" && <Text size="xs" c="dimmed" ff="monospace">{s.ClientIP_ip}</Text>}
              </Stack>
            ) },
            { key: "RemoteHostname_str", title: "Server", render: (s) => <Text size="sm">{s.RemoteHostname_str}</Text> },
            { key: "tcp", title: "TCP conns", align: "right", value: (s) => s.CurrentNumTcp_u32, render: (s) => `${num(s.CurrentNumTcp_u32)} / ${num(s.MaxNumTcp_u32)}` },
            { key: "PacketSize_u64", title: "Traffic", align: "right", render: (s) => <Tooltip label={`${num(s.PacketNum_u64)} packets`}><span>{bytes(s.PacketSize_u64)}</span></Tooltip> },
            { key: "VLanId_u32", title: "VLAN", align: "right", render: (s) => (s.VLanId_u32 ? s.VLanId_u32 : "–") },
            { key: "CreatedTime_dt", title: "Connected", render: (s) => <Tooltip label={dt(s.CreatedTime_dt)}><span>{ago(s.CreatedTime_dt)}</span></Tooltip> },
            { key: "LastCommTime_dt", title: "Last activity", render: (s) => <Tooltip label={dt(s.LastCommTime_dt)}><span>{ago(s.LastCommTime_dt)}</span></Tooltip> },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (s) => (
                <Group gap={4} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                  <Tooltip label="Details"><ActionIcon variant="subtle" onClick={() => setOpen(s.Name_str)} aria-label="Details" data-testid={`session-details-${s.Name_str}`}><IconEye size={16} /></ActionIcon></Tooltip>
                  <Tooltip label="MAC / IP entries of this session">
                    <ActionIcon variant="subtle" aria-label="Tables" onClick={() => nav(`/servers/${serverId}/hubs/${encodeURIComponent(hub)}/tables?session=${encodeURIComponent(s.Name_str)}`)}><IconTable size={16} /></ActionIcon>
                  </Tooltip>
                  {canWrite && (
                    <ConfirmButton title={`Disconnect ${s.Name_str}?`} confirmLabel="Disconnect" leftSection={<IconPlugConnectedX size={14} />}
                      message={<>Session <b>{s.Name_str}</b> ({s.Username_str}) is terminated immediately.{s.LinkMode_bool || s.SecureNATMode_bool || s.BridgeMode_bool ? " This is an infrastructure session; it will be re-created automatically by its owner (cascade / SecureNAT / bridge)." : ""}</>}
                      onConfirm={() => del.mutateAsync({ HubName_str: hub, Name_str: s.Name_str })}>
                      <span data-testid={`disconnect-${s.Name_str}`}>Disconnect</span>
                    </ConfirmButton>
                  )}
                </Group>
              ),
            },
          ]}
        />
      </QueryState>
      <SessionDrawer serverId={serverId} hub={hub} name={open} onClose={() => setOpen(null)} canWrite={canWrite} onDisconnected={() => setOpen(null)} />
    </>
  );
}
