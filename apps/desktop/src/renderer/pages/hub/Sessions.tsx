// Hub › Sessions. Everything connected to the Virtual Hub (VPN clients, cascades, local bridges, SecureNAT,
// Layer 3 switches), with auto-refresh, a type filter, multi-select disconnect and a live details Inspector.
// Ported from apps/web/src/pages/hub/Sessions.tsx.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button, SegmentedControl, Select, Switch, Tooltip } from "@mantine/core";
import { IconCopy, IconDevices, IconInfoCircle, IconPlugConnectedX, IconRefresh, IconTable } from "@tabler/icons-react";
import { ApiError, rpc } from "../../lib/api";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import { agoShort, bytes, dt, num, plural } from "../../lib/format";
import { hubBase } from "../../sections";
import { DataTable, ErrorState, Inspector, PageHeader, PropertySkeleton, StatusBadge, Tag, confirmAction, type RowKey, type TagColor } from "../../design";
import {
  CONNECTION_GROUPS, NODE_INFO_KEYS, SessionStatusBadge, StatusGroups, fmtReportedPort, fmtReportedVersion, isServerCreatedSession, type FieldGroup,
} from "../../components/domain/StatusView";
import { runSequential } from "../../components/domain/util";
import { Callout } from "../../components/domain/ui";
import { Unreachable, notifyBulk, useHubScope } from "./_hub-identity-traffic/shared";

interface SessionItem {
  Name_str: string; RemoteSession_bool: boolean; RemoteHostname_str: string; Username_str: string; ClientIP_ip: string; Hostname_str: string;
  MaxNumTcp_u32: number; CurrentNumTcp_u32: number; PacketSize_u64: number; PacketNum_u64: number; LinkMode_bool: boolean; SecureNATMode_bool: boolean;
  BridgeMode_bool: boolean; Layer3Mode_bool: boolean; Client_BridgeMode_bool: boolean; Client_MonitorMode_bool: boolean; VLanId_u32: number;
  CreatedTime_dt: string; LastCommTime_dt: string; Ip_ip?: string; IsDormant_bool?: boolean; IsDormantEnabled_bool?: boolean; LastCommDormant_dt?: string;
  [k: string]: unknown;
}

function sessionKind(s: SessionItem): { label: string; color: TagColor } {
  if (s.SecureNATMode_bool) return { label: "SecureNAT", color: "teal" };
  if (s.LinkMode_bool) return { label: "Cascade", color: "purple" };
  if (s.BridgeMode_bool) return { label: "Local Bridge", color: "orange" };
  if (s.Layer3Mode_bool) return { label: "L3 Switch", color: "teal" };
  return { label: "Client", color: "accent" };
}
const isInfra = (s: SessionItem) => s.LinkMode_bool || s.SecureNATMode_bool || s.BridgeMode_bool || s.Layer3Mode_bool;

function flags(s: SessionItem) {
  const f: string[] = [];
  if (s.Client_BridgeMode_bool && !s.SecureNATMode_bool && !s.Layer3Mode_bool) f.push("Bridge/router");
  if (s.Client_MonitorMode_bool) f.push("Monitor");
  if (s.RemoteSession_bool) f.push("Remote");
  if (s.IsDormant_bool) f.push("Dormant");
  return f;
}
const realIp = (ip: string | undefined) => (ip && ip !== "::" && ip !== "0.0.0.0" ? ip : "");

const SESSION_GROUPS: FieldGroup[] = [
  {
    title: "Identity",
    fields: [
      ["Session name", "Name_str"], ["User name", "Username_str"], ["Authenticated as", "RealUsername_str"], ["Group", "GroupName_str"],
      ["Cascade session", "LinkMode_bool"], ["Client IP address", "Client_Ip_Address_ip"], ["Client IP (session)", "SessionStatus_ClientIp_ip"],
      ["Client host name (session)", "SessionStatus_ClientHostName_str"],
    ],
  },
  {
    // What the client reported about itself at login (NODE_INFO). Integers arrive byte-swapped (fmtReported*).
    title: "Reported by the client",
    fields: [
      ["Product", "ClientProductName_str"],
      ["Version", "ClientProductVer_u32", (v, all) => fmtReportedVersion(v, all.ClientProductBuild_u32)],
      ["Operating system", "ClientOsName_str"], ["OS version", "ClientOsVer_str"], ["OS product ID", "ClientOsProductId_str"],
      ["Host name", "ClientHostname_str"], ["IP address", "ClientIpAddress_ip"], ["Port", "ClientPort_u32", fmtReportedPort],
      ["Server host name", "ServerHostname_str"], ["Server IP address", "ServerIpAddress_ip"], ["Server port", "ServerPort2_u32", fmtReportedPort],
      ["Proxy host", "ProxyHostname_str"], ["Proxy IP", "ProxyIpAddress_ip"], ["Proxy port", "ProxyPort_u32", fmtReportedPort],
      ["Unique ID", "UniqueId_bin"],
    ],
  },
  ...CONNECTION_GROUPS,
];
const HIDDEN = ["HubName_str", "SessionStatus_ClientIp6_bin", "ProxyIpAddress6_bin", "ClientIpAddress6_bin", "ServerIpAddress6_bin", "ClientProductBuild_u32"];
// Cascade, SecureNAT, bridge and L3 sessions carry no client report or separate login; Server Manager hides them too.
const HIDDEN_SERVER_CREATED = [...HIDDEN, ...NODE_INFO_KEYS, "RealUsername_str"];
// Proxy rows only when the client came through a proxy (Server Manager shows them only then, SM.c SmPrintNodeInfo).
const HIDDEN_NO_PROXY = [...HIDDEN, "ProxyHostname_str", "ProxyIpAddress_ip", "ProxyPort_u32"];
const hiddenFor = (d: Record<string, unknown>) => (isServerCreatedSession(d) ? HIDDEN_SERVER_CREATED : d.ProxyHostname_str ? HIDDEN : HIDDEN_NO_PROXY);
const INTERVALS = [{ value: "2000", label: "2 s" }, { value: "5000", label: "5 s" }, { value: "15000", label: "15 s" }];

export default function SessionsPage() {
  const { serverId, hub, reachable, ready } = useHubScope();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [auto, setAuto] = useState(true);
  const [interval, setIntervalMs] = useState("5000");
  const [kind, setKind] = useState<string | null>(null);
  const [selection, setSelection] = useState<RowKey[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const q = useRpc<{ SessionList?: SessionItem[] }>(serverId, "EnumSession", { HubName_str: hub }, { enabled: ready, refetchInterval: auto ? Number(interval) : false });
  const del = useRpcMutation<{ HubName_str: string; Name_str: string }>(serverId, "DeleteSession", {
    success: "Session disconnected",
    confirm: (p) => {
      const s = q.data?.SessionList?.find((x) => x.Name_str === p.Name_str);
      return {
        title: <>Disconnect “{p.Name_str}”?</>,
        message: s && isInfra(s)
          ? <>This is a {sessionKind(s).label} session: its owner re-creates it automatically. To stop it for good, turn off the {sessionKind(s).label} instead.</>
          : <>The session{s?.Username_str ? <> of <b>{s.Username_str}</b></> : null} ends immediately. Clients set to reconnect usually connect again; to block a user, change their policy or delete them.</>,
        confirmLabel: "Disconnect",
        testId: "disconnect-session",
      };
    },
    onSuccess: (_r, p) => { if (p.Name_str === open) setOpen(null); },
  });

  const all = q.data?.SessionList;
  const list = all?.filter((s) => !kind || sessionKind(s).label === kind);
  const counts = (all ?? []).reduce<Record<string, number>>((m, s) => { const k = sessionKind(s).label; m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const anyRemote = (all ?? []).some((s) => s.RemoteSession_bool);
  const anyVlan = (all ?? []).some((s) => s.VLanId_u32);
  const clients = counts.Client ?? 0;

  const tablesOf = (name: string) => nav(`${hubBase(serverId, hub)}/tables?session=${encodeURIComponent(name)}`);

  const bulkDisconnect = async (names: string[]) => {
    const ok = await confirmAction({
      title: <>Disconnect {plural(names.length, "session")}?</>,
      message: "These sessions end immediately. Cascade, SecureNAT and bridge sessions are re-created by their owners.",
      details: <div className="sem-dim" style={{ fontSize: "var(--sem-fz-small)" }}>{names.slice(0, 12).join(", ")}{names.length > 12 ? ` and ${names.length - 12} more` : ""}</div>,
      confirmLabel: "Disconnect",
      testId: "bulk-disconnect",
    });
    if (!ok) return;
    const res = await runSequential(names, (n) => rpc(serverId, "DeleteSession", { HubName_str: hub, Name_str: n }));
    notifyBulk("Disconnected", ["session", "sessions"], res.map((r) => ({ ok: r.ok, label: r.item, error: r.error })));
    setSelection([]);
    if (open && names.includes(open)) setOpen(null);
    void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
  };

  const columns = useMemo(() => [
    { key: "Name_str", title: "Session", mono: true, render: (s: SessionItem) => <span title={s.Name_str}>{s.Name_str}</span> },
    { key: "Username_str", title: "User", width: 140, truncate: true, render: (s: SessionItem) => <span className="sem-strong" title={s.Username_str}>{s.Username_str}</span> },
    { key: "kind", title: "Type", width: 128, value: (s: SessionItem) => sessionKind(s).label, render: (s: SessionItem) => {
      const k = sessionKind(s);
      const f = flags(s);
      return <span className="sem-row-inline" style={{ flexWrap: "nowrap", gap: "var(--sem-space-2)" }}>
        <Tag color={k.color}>{k.label}</Tag>{f.length > 0 && <Tag variant="outline" title={f.join(", ")}>{f.length === 1 ? f[0] : `+${f.length}`}</Tag>}
      </span>;
    } },
    { key: "source", title: "Source", width: 130, truncate: true, value: (s: SessionItem) => `${s.Hostname_str} ${s.ClientIP_ip}`, render: (s: SessionItem) => {
      const ip = realIp(s.ClientIP_ip);
      const host = s.Hostname_str && s.Hostname_str !== ip ? s.Hostname_str : "";
      return <span title={[host, ip].filter(Boolean).join(" · ")}>{host || (!ip && <span className="sem-dim">–</span>)}{host && ip ? <span className="sem-dim"> · </span> : null}{ip && <span className="sem-mono" data-dim={host ? true : undefined}>{ip}</span>}</span>;
    } },
    ...(anyRemote ? [{ key: "RemoteHostname_str", title: "Server", width: 120, truncate: true }] : []),
    { key: "tcp", title: "TCP", align: "right" as const, width: 56, value: (s: SessionItem) => s.CurrentNumTcp_u32, render: (s: SessionItem) => <span className="sem-num" title={`${num(s.CurrentNumTcp_u32)} of up to ${num(s.MaxNumTcp_u32)} TCP connections`}>{num(s.CurrentNumTcp_u32)}<span className="sem-dim">/{num(s.MaxNumTcp_u32)}</span></span> },
    { key: "PacketSize_u64", title: "Traffic", align: "right" as const, width: 80, render: (s: SessionItem) => <span className="sem-num" title={`${num(s.PacketNum_u64)} packets`}>{bytes(s.PacketSize_u64)}</span> },
    ...(anyVlan ? [{ key: "VLanId_u32", title: "VLAN", align: "right" as const, width: 60, render: (s: SessionItem) => (s.VLanId_u32 ? <span className="sem-num">{s.VLanId_u32}</span> : <span className="sem-dim">–</span>) }] : []),
    { key: "CreatedTime_dt", title: "Connected", width: 90, render: (s: SessionItem) => <span className="sem-dim" title={dt(s.CreatedTime_dt)}>{agoShort(s.CreatedTime_dt)}</span> },
    { key: "LastCommTime_dt", title: "Last activity", width: 94, render: (s: SessionItem) => <span className="sem-dim" title={dt(s.LastCommTime_dt)}>{agoShort(s.LastCommTime_dt)}</span> },
  ], [anyRemote, anyVlan]);

  return (
    <>
      <PageHeader
        title="Sessions"
        meta={reachable && all ? <>
          <span data-testid="sessions-count">{plural(all.length, "session")}</span>
          <span className="sem-dim">·</span><span className="sem-dim">{plural(clients, "VPN client")}</span>
          {all.length - clients > 0 && <><span className="sem-dim">·</span><span className="sem-dim">{num(all.length - clients)} infrastructure</span></>}
        </> : undefined}
        description="Everything connected to this Virtual Hub: VPN clients, cascades, local bridges, SecureNAT and Layer 3 switches."
        actions={reachable && (
          <div className="sem-row-inline" style={{ flexWrap: "nowrap" }}>
            <Switch size="xs" label="Auto-refresh" checked={auto} onChange={(e) => setAuto(e.currentTarget.checked)} data-testid="sessions-autorefresh" />
            <SegmentedControl size="xs" value={interval} onChange={setIntervalMs} data={INTERVALS} disabled={!auto} aria-label="Refresh interval" data-testid="sessions-interval" />
          </div>
        )}
      />
      {!reachable ? <Unreachable serverId={serverId} /> : (
        <DataTable
          testId="sessions-table"
          aria-label="Sessions"
          data={list}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          rowKey={(s) => s.Name_str}
          rowTestId={(s) => `session-row-${s.Name_str}`}
          selectable="multi"
          selection={selection}
          onSelectionChange={(keys, rows) => { setSelection(keys); if (open && rows.length === 1) setOpen(rows[0].Name_str); }}
          onRowOpen={(s) => setOpen(s.Name_str)}
          rowTone={(s) => (s.IsDormant_bool ? "dim" : undefined)}
          initialSort={{ key: "CreatedTime_dt", dir: "desc" }}
          searchPlaceholder="Filter sessions"
          filters={
            <Select size="xs" w={170} placeholder="All session types" clearable value={kind} onChange={setKind} aria-label="Filter by session type" data-testid="sessions-kind-filter"
              data={Object.entries(kind && !counts[kind] ? { ...counts, [kind]: 0 } : counts).sort().map(([k, n]) => ({ value: k, label: `${k} (${n})` }))} />
          }
          toolbar={selection.length > 0 && (
            <Button size="xs" variant="default" c="var(--sem-red)" leftSection={<IconPlugConnectedX size={13} />} onClick={() => void bulkDisconnect(selection.map(String))} data-testid="bulk-disconnect-button">
              Disconnect {selection.length}…
            </Button>
          )}
          empty={{ title: "No Sessions", description: "Nothing is connected to this Virtual Hub right now.", icon: <IconDevices size={28} stroke={1.4} /> }}
          contextMenu={(s, sel) => sel.length > 1 ? [
            { label: `Disconnect ${plural(sel.length, "Session")}…`, icon: <IconPlugConnectedX size={14} />, danger: true, onClick: () => void bulkDisconnect(sel.map((x) => x.Name_str)), testId: "menu-disconnect-sessions" },
          ] : [
            { label: "Show Details", icon: <IconInfoCircle size={14} />, onClick: () => setOpen(s.Name_str), shortcut: "↩", testId: `session-details-${s.Name_str}` },
            { label: "Show MAC & IP Entries", icon: <IconTable size={14} />, onClick: () => tablesOf(s.Name_str), testId: `session-tables-${s.Name_str}` },
            { label: "Copy Session Name", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(s.Name_str) },
            "divider",
            { label: "Disconnect…", icon: <IconPlugConnectedX size={14} />, danger: true, onClick: () => del.mutate({ HubName_str: hub, Name_str: s.Name_str }), testId: `disconnect-${s.Name_str}` },
          ]}
          columns={columns}
        />
      )}
      <SessionInspector serverId={serverId} hub={hub} name={open} onClose={() => setOpen(null)}
        onTables={tablesOf} onDisconnect={(n) => del.mutate({ HubName_str: hub, Name_str: n })} disconnecting={del.isPending} />
    </>
  );
}

function SessionInspector({ serverId, hub, name, onClose, onTables, onDisconnect, disconnecting }: {
  serverId: number; hub: string; name: string | null; onClose: () => void; onTables: (n: string) => void; onDisconnect: (n: string) => void; disconnecting: boolean;
}) {
  const q = useRpc<Record<string, unknown>>(serverId, "GetSessionStatus", { HubName_str: hub, Name_str: name ?? "" }, { enabled: !!name, refetchInterval: 5000 });
  const d = q.data;
  // GetSessionStatus answers "not found" (29) once the session is gone: say it ended instead of showing a raw error.
  const ended = q.error instanceof ApiError && q.error.softEtherCode === 29;
  return (
    <Inspector
      opened={!!name} onClose={onClose} width={420} testId="session-inspector"
      title={<span className="sem-mono" title={name ?? ""}>{name}</span>}
      subtitle={d ? <span className="sem-row-inline" style={{ gap: "var(--sem-space-3)" }}>
        {ended ? <StatusBadge status="off">Ended</StatusBadge> : <SessionStatusBadge value={Number(d.SessionStatus_u32)} />}
        {d.Username_str ? <span>{String(d.Username_str)}</span> : null}
      </span> : ended ? <StatusBadge status="off">Ended</StatusBadge> : q.error ? "Details unavailable" : "Loading…"}
      icon={<IconDevices size={17} stroke={1.6} />}
      actions={name && <>
        <Tooltip label="Refresh now" openDelay={300}>
          <Button size="xs" variant="default" onClick={() => void q.refetch()} aria-label="Refresh session details" data-testid="session-refresh"><IconRefresh size={13} className={q.isFetching ? "sem-spin" : undefined} /></Button>
        </Tooltip>
        <Button size="xs" variant="default" leftSection={<IconTable size={13} />} onClick={() => onTables(name)} data-testid="session-tables">MAC & IP Entries</Button>
        <Button size="xs" variant="default" c={ended ? undefined : "var(--sem-red)"} leftSection={<IconPlugConnectedX size={13} />} loading={disconnecting} disabled={ended} onClick={() => onDisconnect(name)} data-testid="session-disconnect">Disconnect…</Button>
      </>}
    >
      {d && (
        <div className="sem-row-inline" style={{ gap: "var(--sem-space-2)", marginTop: "var(--sem-space-4)" }}>
          {d.CipherName_str ? <Tag variant="outline">{String(d.CipherName_str)}</Tag> : null}
          {d.IsUsingUdpAcceleration_bool ? <Tag color="teal">UDP acceleration</Tag> : null}
          {d.UseCompress_bool ? <Tag color="purple">Compressed</Tag> : null}
          {d.UseEncrypt_bool === false ? <Tag color="orange">Not encrypted</Tag> : null}
        </div>
      )}
      {/* A failing refresh (e.g. the session has ended) is shown above the last known status instead of hiding it. */}
      {q.error ? <div style={{ marginTop: "var(--sem-space-5)" }} data-testid="session-error">
        {ended
          ? <Callout tone="gray" title="This session has ended">It’s no longer connected to this hub.{d ? " The details below are its last known status." : ""}</Callout>
          : <ErrorState error={q.error} inline onRetry={() => void q.refetch()} />}
      </div> : null}
      {!d ? (q.error ? null : <div style={{ marginTop: "var(--sem-space-5)" }}><PropertySkeleton rows={8} /></div>)
        : <StatusGroups data={d} groups={SESSION_GROUPS} hide={hiddenFor(d)} labelWidth={150} testId="session-status" />}
    </Inspector>
  );
}
