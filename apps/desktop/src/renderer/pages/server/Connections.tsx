// Server › Connections: every TCP connection open to the VPN Server (EnumConnection), including connections
// still negotiating, admin RPC and cluster links. Double-click shows GetConnectionInfo in the Inspector.
import { useMemo, useState } from "react";
import { Button, SegmentedControl, Select } from "@mantine/core";
import { IconCopy, IconDevices, IconInfoCircle, IconPlugConnected, IconPlugOff, IconRefresh } from "@tabler/icons-react";
import { notifySuccess, useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import { ago, agoShort, dt, duration, num, plural } from "../../lib/format";
import {
  CopyField, DataTable, ErrorState, Inspector, Mono, PageHeader, PropertyList, PropertySkeleton, Tag, confirmAction, type RowKey, type TagColor,
} from "../../design";
import { Unreachable, copyText, loadPref, savePref, useServerPage } from "./_server-network/shared";

interface ConnItem { Name_str: string; Hostname_str: string; Ip_ip: string; Port_u32: number; ConnectedTime_dt: string; Type_u32: number }
interface ConnInfo extends ConnItem {
  ServerStr_str: string; ServerVer_u32: number; ServerBuild_u32: number; ClientStr_str: string; ClientVer_u32: number; ClientBuild_u32: number;
}

/** VpnRpcConnectionType, with explanations. */
const CONN_TYPE: Record<number, { label: string; color: TagColor; doc: string; group: "vpn" | "mgmt" }> = {
  0: { label: "VPN client", color: "accent", doc: "VPN client or bridge session connection", group: "vpn" },
  1: { label: "Initializing", color: "gray", doc: "Connection negotiating the protocol", group: "vpn" },
  2: { label: "Login", color: "yellow", doc: "Connection in the authentication phase", group: "vpn" },
  3: { label: "Additional", color: "teal", doc: "Additional TCP connection of an existing multi-connection session", group: "vpn" },
  4: { label: "Cluster RPC", color: "purple", doc: "RPC connection between the cluster controller and a member", group: "mgmt" },
  5: { label: "Admin RPC", color: "purple", doc: "Management (admin) RPC connection, such as Server Manager, vpncmd or this app", group: "mgmt" },
  6: { label: "Hub listing", color: "gray", doc: "Client listing the Virtual Hubs", group: "mgmt" },
  7: { label: "Password change", color: "orange", doc: "Client changing a user password", group: "mgmt" },
  8: { label: "SSTP", color: "teal", doc: "Microsoft SSTP VPN connection", group: "vpn" },
  9: { label: "OpenVPN", color: "teal", doc: "OpenVPN connection", group: "vpn" },
};

const REFRESH = ["off", "5", "10", "30"] as const;
type Refresh = (typeof REFRESH)[number];

function TypeTag({ t }: { t: number }) {
  const x = CONN_TYPE[t];
  return <span title={x?.doc}><Tag color={x?.color ?? "gray"}>{x?.label ?? `Type ${t}`}</Tag></span>;
}

function ver(v: number, b: number) {
  if (!v && !b) return undefined;
  return `${Math.floor(v / 100)}.${String(v % 100).padStart(2, "0")} Build ${b}`;
}

const source = (c: ConnItem) => `${c.Hostname_str && c.Hostname_str !== c.Ip_ip ? `${c.Hostname_str} (${c.Ip_ip})` : c.Ip_ip}:${c.Port_u32}`;

export default function ConnectionsPage() {
  const { serverId } = useScope();
  const { s, reachable, live } = useServerPage(serverId);
  const [auto, setAuto] = useState<Refresh>(() => loadPref("connections.refresh", "10", REFRESH));
  const list = useRpc<{ ConnectionList?: ConnItem[] }>(serverId, "EnumConnection", {}, {
    refetchInterval: auto === "off" ? false : Number(auto) * 1000, enabled: live,
  });
  const disc = useRpcMutation<{ Name_str: string }>(serverId, "DisconnectConnection", { success: false, confirm: false });
  const [typeFilter, setTypeFilter] = useState<"all" | "vpn" | "mgmt">("all");
  const [sel, setSel] = useState<RowKey[]>([]);
  const [inspect, setInspect] = useState<string | null>(null);
  const now = list.dataUpdatedAt || Date.now();

  const all = useMemo(() => list.data?.ConnectionList ?? [], [list.data]);
  const counts = { vpn: all.filter((c) => CONN_TYPE[c.Type_u32]?.group !== "mgmt").length, mgmt: all.filter((c) => CONN_TYPE[c.Type_u32]?.group === "mgmt").length };
  const rows = typeFilter === "all" ? all : all.filter((c) => (CONN_TYPE[c.Type_u32]?.group ?? "vpn") === typeFilter);
  const selected = all.filter((c) => sel.includes(c.Name_str));

  const disconnect = async (targets: ConnItem[]) => {
    if (!targets.length) return;
    const one = targets.length === 1 ? targets[0] : null;
    const admin = targets.some((c) => c.Type_u32 === 5);
    const ok = await confirmAction({
      title: one ? <>Disconnect {one.Name_str}?</> : <>Disconnect {targets.length} connections?</>,
      message: <>
        {one ? <>The TCP connection from <b>{source(one)}</b> ({CONN_TYPE[one.Type_u32]?.label ?? `type ${one.Type_u32}`}) is closed.</>
          : "The selected TCP connections are closed."}
        {admin && " An admin RPC connection may belong to this app or another manager; it reconnects on its next request."}
      </>,
      confirmLabel: one ? "Disconnect" : `Disconnect ${targets.length}`,
      tone: "danger",
      testId: "connection-disconnect",
    });
    if (!ok) return;
    let done = 0;
    for (const c of targets) {
      try { await disc.mutateAsync({ Name_str: c.Name_str }); done++; } catch { /* toasted by the hook */ }
    }
    if (done) notifySuccess(done === 1 ? "Connection disconnected" : `${done} connections disconnected`);
    if (inspect && targets.some((c) => c.Name_str === inspect)) setInspect(null);
    setSel([]);
  };

  if (!s) return null;
  return (
    <>
      <PageHeader
        title="Connections"
        meta={list.data ? <>{plural(all.length, "TCP connection")} · {num(counts.vpn)} VPN · {num(counts.mgmt)} management</> : undefined}
        description="Every TCP connection open to the server, including ones still negotiating. Established VPN sessions are listed per hub under Sessions."
        actions={reachable && (
          <Select
            size="sm" w={168} value={auto} allowDeselect={false} aria-label="Automatic refresh"
            leftSection={<IconRefresh size={13} />} data-testid="connections-refresh"
            onChange={(v) => { const r = (v ?? "10") as Refresh; setAuto(r); savePref("connections.refresh", r); }}
            data={[{ value: "off", label: "Refresh Manually" }, { value: "5", label: "Every 5 Seconds" }, { value: "10", label: "Every 10 Seconds" }, { value: "30", label: "Every 30 Seconds" }]}
          />
        )}
      />
      {!reachable ? <Unreachable serverId={serverId} /> : (
        <DataTable
          testId="connections-table"
          aria-label="TCP connections"
          data={list.data ? rows : undefined}
          loading={list.isLoading || list.isFetching}
          error={list.error}
          onRetry={() => void list.refetch()}
          rowKey={(c) => c.Name_str}
          rowTestId={(c) => `connection-row-${c.Name_str}`}
          selectable="multi"
          selection={sel}
          onSelectionChange={(k) => setSel(k)}
          initialSort={{ key: "ConnectedTime_dt", dir: "desc" }}
          searchPlaceholder="Filter Connections"
          onRowOpen={(c) => setInspect(c.Name_str)}
          empty={{ title: "No TCP connections", description: "Clients, managers and cluster members appear here while they’re connected.", icon: <IconDevices size={28} stroke={1.4} /> }}
          filters={(
            <SegmentedControl
              size="xs" value={typeFilter} onChange={(v) => setTypeFilter(v as typeof typeFilter)} aria-label="Connection type"
              data={[{ value: "all", label: `All (${all.length})` }, { value: "vpn", label: `VPN (${counts.vpn})` }, { value: "mgmt", label: `Management (${counts.mgmt})` }]}
              data-testid="connections-type-filter"
            />
          )}
          toolbar={(
            <div className="sem-row-inline" style={{ gap: "var(--sem-space-3)" }}>
              <Button size="xs" variant="default" leftSection={<IconInfoCircle size={13} />} disabled={selected.length !== 1}
                onClick={() => setInspect(selected[0]?.Name_str ?? null)} data-testid="connection-info">Get Info</Button>
              <Button size="xs" variant="default" c={selected.length ? "var(--sem-red)" : undefined} leftSection={<IconPlugOff size={13} />} disabled={!selected.length}
                onClick={() => void disconnect(selected)} data-testid="connection-disconnect">{selected.length > 1 ? `Disconnect ${selected.length}…` : "Disconnect…"}</Button>
            </div>
          )}
          contextMenu={(c, rowsSel) => [
            { label: "Get Info", icon: <IconInfoCircle size={14} />, onClick: () => setInspect(c.Name_str), shortcut: "↩" },
            { label: "Copy Source Address", icon: <IconCopy size={14} />, onClick: () => void copyText(`${c.Ip_ip}:${c.Port_u32}`, "Address copied") },
            { label: "Copy Name", icon: <IconCopy size={14} />, onClick: () => void copyText(c.Name_str, "Connection name copied") },
            "divider",
            { label: rowsSel.length > 1 ? `Disconnect ${rowsSel.length} Connections…` : "Disconnect…", icon: <IconPlugOff size={14} />, danger: true,
              onClick: () => void disconnect(rowsSel), testId: "connection-menu-disconnect" },
          ]}
          columns={[
            {
              key: "Name_str", title: "Name", width: 100, mono: true,
              value: (c) => Number(c.Name_str.replace(/\D/g, "")) || c.Name_str,
              render: (c) => <span className="sem-strong">{c.Name_str}</span>,
            },
            { key: "Type_u32", title: "Type", width: 128, value: (c) => CONN_TYPE[c.Type_u32]?.label ?? String(c.Type_u32), render: (c) => <TypeTag t={c.Type_u32} /> },
            { key: "Hostname_str", title: "Host", truncate: true, render: (c) => c.Hostname_str || <span className="sem-dim">–</span> },
            { key: "Ip_ip", title: "Source address", width: 150, mono: true, render: (c) => c.Ip_ip },
            { key: "Port_u32", title: "Port", width: 70, align: "right", render: (c) => <span className="sem-num">{c.Port_u32}</span> },
            {
              key: "ConnectedTime_dt", title: "Connected", width: 110,
              render: (c) => <span className="sem-dim" title={dt(c.ConnectedTime_dt)}>{agoShort(c.ConnectedTime_dt)}</span>,
            },
            {
              key: "dur", title: "Duration", width: 96, align: "right",
              value: (c) => now - new Date(c.ConnectedTime_dt).getTime(),
              render: (c) => <span className="sem-num">{duration(now - new Date(c.ConnectedTime_dt).getTime())}</span>,
            },
          ]}
        />
      )}
      <ConnectionInspector serverId={serverId} name={inspect} onClose={() => setInspect(null)}
        onDisconnect={(c) => void disconnect([c])} />
    </>
  );
}

function ConnectionInspector({ serverId, name, onClose, onDisconnect }: {
  serverId: number; name: string | null; onClose: () => void; onDisconnect: (c: ConnItem) => void;
}) {
  const info = useRpc<ConnInfo>(serverId, "GetConnectionInfo", { Name_str: name ?? "" }, { enabled: !!name, refetchInterval: 10_000 });
  const c = info.data;
  return (
    <Inspector
      opened={!!name} onClose={onClose} testId="connection-drawer"
      title={name ?? ""} subtitle={c ? CONN_TYPE[c.Type_u32]?.doc ?? `Type ${c.Type_u32}` : "TCP connection"}
      icon={<IconPlugConnected size={18} stroke={1.6} />}
      actions={c && (
        <Button size="xs" variant="default" c="var(--sem-red)" leftSection={<IconPlugOff size={13} />} onClick={() => onDisconnect(c)} data-testid="connection-drawer-disconnect">
          Disconnect…
        </Button>
      )}
    >
      {info.error ? <ErrorState error={info.error} inline onRetry={() => void info.refetch()} /> : !c ? <PropertySkeleton rows={8} /> : (
        <>
          <h3 className="sem-section-title" style={{ marginTop: "var(--sem-space-5)" }}>Connection</h3>
          <PropertyList labelWidth={120} dense testId="connection-props" items={[
            { label: "Name", value: <CopyField value={c.Name_str} size="sm" /> },
            { label: "Type", value: <TypeTag t={c.Type_u32} /> },
            { label: "Host name", value: c.Hostname_str },
            { label: "Address", value: <CopyField value={c.Ip_ip} size="sm" /> },
            { label: "Port", value: <Mono>{c.Port_u32}</Mono> },
            { label: "Connected", value: <>{dt(c.ConnectedTime_dt)} <span className="sem-dim">({ago(c.ConnectedTime_dt)})</span></> },
          ]} />
          <h3 className="sem-section-title" style={{ marginTop: "var(--sem-space-7)" }}>Software</h3>
          <PropertyList labelWidth={120} dense items={[
            { label: "Server", value: c.ServerStr_str },
            { label: "Server version", value: ver(c.ServerVer_u32, c.ServerBuild_u32) },
            { label: "Client", value: c.ClientStr_str },
            { label: "Client version", value: ver(c.ClientVer_u32, c.ClientBuild_u32) },
          ]} />
        </>
      )}
    </Inspector>
  );
}
