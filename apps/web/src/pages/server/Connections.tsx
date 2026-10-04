import { useState } from "react";
import { Badge, Button, Drawer, Group, SegmentedControl, Stack, Text, Tooltip } from "@mantine/core";
import { IconPlugOff, IconRefresh } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, Copyable, ErrorAlert, KeyValue, PageHeader, QueryState } from "../../components/common";
import { duration } from "../../components/server-a/shared";
import { can, useRpc, useRpcMutation, useScope, useServer } from "../../lib/hooks";
import { ago, dt, num } from "../../lib/format";

interface ConnItem { Name_str: string; Hostname_str: string; Ip_ip: string; Port_u32: number; ConnectedTime_dt: string; Type_u32: number }
interface ConnInfo extends ConnItem {
  ServerStr_str: string; ServerVer_u32: number; ServerBuild_u32: number; ClientStr_str: string; ClientVer_u32: number; ClientBuild_u32: number;
}

/** VpnRpcConnectionType, with explanations. */
const CONN_TYPE: Record<number, { label: string; color: string; doc: string }> = {
  0: { label: "VPN client", color: "blue", doc: "VPN client or bridge session connection" },
  1: { label: "Initializing", color: "gray", doc: "Connection negotiating the protocol" },
  2: { label: "Login", color: "yellow", doc: "Connection in the authentication phase" },
  3: { label: "Additional", color: "cyan", doc: "Additional TCP connection of an existing multi-connection session" },
  4: { label: "Cluster RPC", color: "grape", doc: "RPC connection between cluster controller and member" },
  5: { label: "Admin RPC", color: "violet", doc: "Management (admin) RPC connection, e.g. this management server" },
  6: { label: "Hub enumeration", color: "gray", doc: "Client enumerating the Virtual Hubs" },
  7: { label: "Password change", color: "orange", doc: "Client changing a user password" },
  8: { label: "SSTP", color: "teal", doc: "Microsoft SSTP VPN connection" },
  9: { label: "OpenVPN", color: "teal", doc: "OpenVPN connection" },
};

function typeBadge(t: number) {
  const x = CONN_TYPE[t];
  return (
    <Tooltip label={x?.doc ?? `Type ${t}`}><Badge variant="light" color={x?.color ?? "gray"}>{x?.label ?? `Type ${t}`}</Badge></Tooltip>
  );
}

function ver(v: number, b: number) {
  if (!v && !b) return "–";
  return `${Math.floor(v / 100)}.${String(v % 100).padStart(2, "0")} build ${b}`;
}

function ConnectionDrawer({ serverId, name, onClose, canDisconnect }: { serverId: number; name: string | null; onClose: () => void; canDisconnect: boolean }) {
  const info = useRpc<ConnInfo>(serverId, "GetConnectionInfo", { Name_str: name ?? "" }, { enabled: !!name, refetchInterval: 10_000 });
  const disc = useRpcMutation(serverId, "DisconnectConnection", { success: "Connection disconnected", onSuccess: onClose });
  const c = info.data;
  return (
    <Drawer opened={!!name} onClose={onClose} position="right" size="lg" title={<Text fw={700}>Connection {name}</Text>} data-testid="connection-drawer">
      <QueryState query={info}>
        {c && (
          <Stack>
            <KeyValue rows={[
              ["Connection name", <Copyable value={c.Name_str} />],
              ["Type", typeBadge(c.Type_u32)],
              ["Source host name", c.Hostname_str || "–"],
              ["Source IP address", <Copyable value={c.Ip_ip} />],
              ["Source port", num(c.Port_u32)],
              ["Connected at", <>{dt(c.ConnectedTime_dt)} <Text span size="xs" c="dimmed">({ago(c.ConnectedTime_dt)})</Text></>],
              ["Server product", c.ServerStr_str || "–"],
              ["Server version", ver(c.ServerVer_u32, c.ServerBuild_u32)],
              ["Client product", c.ClientStr_str || "–"],
              ["Client version", ver(c.ClientVer_u32, c.ClientBuild_u32)],
            ]} />
            {canDisconnect && (
              <Group justify="flex-end">
                <ConfirmButton
                  title={`Disconnect ${c.Name_str}?`}
                  message={<>The TCP connection from <b>{c.Hostname_str || c.Ip_ip}:{c.Port_u32}</b> will be forcibly closed.{c.Type_u32 === 5 && " This is an admin RPC connection — if it belongs to this management server it will reconnect automatically."}</>}
                  confirmLabel="Disconnect"
                  onConfirm={() => disc.mutateAsync({ Name_str: c.Name_str })}
                  leftSection={<IconPlugOff size={14} />}
                  size="sm"
                >Disconnect</ConfirmButton>
              </Group>
            )}
          </Stack>
        )}
      </QueryState>
    </Drawer>
  );
}

export default function ConnectionsPage() {
  const { serverId } = useScope();
  const server = useServer(serverId);
  const role = server.data?.myRole;
  const [auto, setAuto] = useState("10");
  const list = useRpc<{ ConnectionList?: ConnItem[] }>(serverId, "EnumConnection", {}, { refetchInterval: auto === "off" ? false : Number(auto) * 1000 });
  const disc = useRpcMutation(serverId, "DisconnectConnection", { success: "Connection disconnected" });
  const [selected, setSelected] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState("all");
  const canWrite = can(role, "operator");
  const now = Date.now();

  const rows = (list.data?.ConnectionList ?? []).filter((c) =>
    typeFilter === "all" ? true : typeFilter === "vpn" ? [0, 1, 2, 3, 8, 9].includes(c.Type_u32) : [4, 5, 6, 7].includes(c.Type_u32));

  return (
    <>
      <PageHeader
        title="TCP connections"
        description="All TCP/IP connections currently open to the VPN server, including connections still negotiating, admin RPC and cluster links. Established VPN sessions are listed per hub under Sessions."
        actions={
          <>
            <SegmentedControl size="xs" value={auto} onChange={setAuto} data={[{ value: "off", label: "Manual" }, { value: "5", label: "5s" }, { value: "10", label: "10s" }, { value: "30", label: "30s" }]} aria-label="Auto refresh" />
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => list.refetch()} loading={list.isFetching}>Refresh</Button>
          </>
        }
      />
      {list.error ? <ErrorAlert error={list.error} /> : (
        <QueryState query={list}>
          <DataTable
            testId="connections-table"
            data={rows}
            rowKey={(c) => c.Name_str}
            onRowClick={(c) => setSelected(c.Name_str)}
            initialSort={{ key: "ConnectedTime_dt", dir: "desc" }}
            empty="No TCP connections"
            toolbar={
              <SegmentedControl size="xs" value={typeFilter} onChange={setTypeFilter}
                data={[{ value: "all", label: "All" }, { value: "vpn", label: "VPN / protocol" }, { value: "mgmt", label: "Management" }]} aria-label="Connection type filter" />
            }
            columns={[
              { key: "Name_str", title: "Name", render: (c) => <Text ff="monospace" size="sm" fw={600}>{c.Name_str}</Text>, value: (c) => Number(c.Name_str.replace(/\D/g, "")) || c.Name_str },
              { key: "Type_u32", title: "Type", render: (c) => typeBadge(c.Type_u32), value: (c) => CONN_TYPE[c.Type_u32]?.label ?? String(c.Type_u32) },
              { key: "Hostname_str", title: "Host" },
              { key: "Ip_ip", title: "Source IP", render: (c) => <Text ff="monospace" size="sm">{c.Ip_ip}</Text> },
              { key: "Port_u32", title: "Port", align: "right" },
              { key: "ConnectedTime_dt", title: "Connected", render: (c) => <Tooltip label={dt(c.ConnectedTime_dt)}><span>{ago(c.ConnectedTime_dt)}</span></Tooltip> },
              { key: "dur", title: "Duration", align: "right", value: (c) => now - new Date(c.ConnectedTime_dt).getTime(), render: (c) => duration(now - new Date(c.ConnectedTime_dt).getTime()) },
              {
                key: "actions", title: "", sortable: false, align: "right",
                render: (c) => canWrite && (
                  <Group justify="flex-end" onClick={(e) => e.stopPropagation()}>
                    <ConfirmButton
                      title={`Disconnect ${c.Name_str}?`}
                      message={<>The TCP connection from <b>{c.Hostname_str || c.Ip_ip}:{c.Port_u32}</b> ({CONN_TYPE[c.Type_u32]?.label ?? c.Type_u32}) will be forcibly closed.</>}
                      confirmLabel="Disconnect"
                      onConfirm={() => disc.mutateAsync({ Name_str: c.Name_str })}
                      leftSection={<IconPlugOff size={14} />}
                    >Disconnect</ConfirmButton>
                  </Group>
                ),
              },
            ]}
          />
        </QueryState>
      )}
      <ConnectionDrawer serverId={serverId} name={selected} onClose={() => setSelected(null)} canDisconnect={canWrite} />
    </>
  );
}
