// Human-friendly rendering of SoftEther status structs (session / cascade status).
import type { ReactNode } from "react";
import { Accordion, Badge, Button, Code, Group, Text } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { KeyValue } from "../common";
import { fieldLabel } from "../RpcForm";
import { bytes, downloadText, dt, num } from "../../lib/format";
import { b64ToBytes, derB64ToPem, ipv6FromB64 } from "./util";

export const SESSION_STATUS: Record<number, { label: string; color: string }> = {
  0: { label: "Connecting", color: "yellow" },
  1: { label: "Negotiating", color: "yellow" },
  2: { label: "Authenticating", color: "yellow" },
  3: { label: "Established", color: "green" },
  4: { label: "Retrying", color: "orange" },
  5: { label: "Idle", color: "gray" },
};

export function SessionStatusBadge({ value }: { value: number | undefined }) {
  const s = SESSION_STATUS[value ?? -1];
  return s ? <Badge color={s.color} variant="light">{s.label}</Badge> : <Badge color="gray" variant="light">Unknown</Badge>;
}

export function fmtVersion(ver: unknown, build?: unknown) {
  const v = Number(ver ?? 0);
  if (!v) return "–";
  const s = `${Math.floor(v / 100)}.${String(v % 100).padStart(2, "0")}`;
  return build ? `${s} build ${build}` : s;
}

/** Format any status value by its name suffix. */
export function fmtField(key: string, v: unknown): ReactNode {
  if (v === undefined || v === null) return "–";
  if (key.endsWith("_bool")) return v ? <Badge size="sm" variant="light" color="green">Yes</Badge> : <Badge size="sm" variant="light" color="gray">No</Badge>;
  if (key.endsWith("_dt")) return dt(String(v));
  if (key.endsWith("_u64")) return /Size|Bytes/.test(key) ? `${bytes(Number(v))} (${num(Number(v))} B)` : num(Number(v));
  if (key.endsWith("_u32")) return num(Number(v));
  if (key.endsWith("_bin")) {
    const b = b64ToBytes(String(v));
    if (b.length === 16 && /Ip|Address6/i.test(key)) return <Code>{ipv6FromB64(String(v))}</Code>;
    if (b.length === 0 || b.every((x) => x === 0)) return <Text span size="sm" c="dimmed">(empty)</Text>;
    if (/X_bin$|Cert/.test(key)) {
      return (
        <Group gap="xs">
          <Text span size="sm">{b.length} bytes</Text>
          <Button size="compact-xs" variant="light" leftSection={<IconDownload size={12} />}
            onClick={() => downloadText(`${key.replace(/_bin$/, "")}.pem`, derB64ToPem(String(v)), "application/x-pem-file")}>PEM</Button>
        </Group>
      );
    }
    return <Code style={{ wordBreak: "break-all" }}>{[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}</Code>;
  }
  if (key.endsWith("_ip") && v === "::") return "–";
  return String(v) === "" ? <Text span size="sm" c="dimmed">(none)</Text> : String(v);
}

export interface FieldGroup { title: string; fields: ([string, string] | [string, string, (v: unknown, all: Record<string, unknown>) => ReactNode])[] }

/**
 * Render grouped fields; every remaining key of the struct is shown under "All other fields"
 * so nothing the server returns is hidden.
 */
export function StatusGroups({ data, groups, hide = [] }: { data: Record<string, unknown>; groups: FieldGroup[]; hide?: string[] }) {
  const used = new Set<string>(hide);
  groups.forEach((g) => g.fields.forEach((f) => used.add(f[1])));
  const rest = Object.keys(data).filter((k) => !used.has(k) && !k.startsWith("policy:")).sort();
  const policy = Object.keys(data).filter((k) => k.startsWith("policy:")).sort();
  const items = [
    ...groups.map((g) => ({ key: g.title, title: g.title, rows: g.fields.filter((f) => data[f[1]] !== undefined).map(([label, k, render]) => [label, render ? render(data[k], data) : fmtField(k, data[k])] as [ReactNode, ReactNode]) })),
    ...(rest.length ? [{ key: "other", title: "All other fields", rows: rest.map((k) => [<>{fieldLabel(k)} <Text span size="xs" c="dimmed" ff="monospace">{k}</Text></>, fmtField(k, data[k])] as [ReactNode, ReactNode]) }] : []),
    ...(policy.length ? [{ key: "policy", title: "Effective security policy", rows: policy.map((k) => [fieldLabel(k.replace("policy:", "")), fmtField(k, data[k])] as [ReactNode, ReactNode]) }] : []),
  ].filter((i) => i.rows.length);
  return (
    <Accordion multiple defaultValue={groups.map((g) => g.title)} variant="contained">
      {items.map((i) => (
        <Accordion.Item key={i.key} value={i.key}>
          <Accordion.Control><Text fw={600} size="sm">{i.title}</Text></Accordion.Control>
          <Accordion.Panel><KeyValue rows={i.rows} /></Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  );
}

/** Groups shared by GetSessionStatus and GetLinkStatus. */
export const CONNECTION_GROUPS: FieldGroup[] = [
  {
    title: "Connection",
    fields: [
      ["Session status", "SessionStatus_u32", (v) => <SessionStatusBadge value={Number(v)} />],
      ["Active", "Active_bool"], ["Connected", "Connected_bool"],
      ["Server name", "ServerName_str"], ["Server hostname", "ServerHostname_str"], ["Server port", "ServerPort_u32"],
      ["Server product", "ServerProductName_str"],
      ["Server version", "ServerProductVer_u32", (v, all) => fmtVersion(v, all.ServerProductBuild_u32)],
      ["Underlay protocol", "UnderlayProtocol_str"], ["Protocol version", "ProtocolVersion_str"], ["Protocol details", "ProtocolDetails_str"],
      ["Started", "StartTime_dt"], ["First connection established", "FirstConnectionEstablisiedTime_dt"],
      ["Current connection established", "CurrentConnectionEstablishTime_dt"],
      ["Connections established so far", "NumConnectionsEstablished_u32"], ["Connections established so far", "NumConnectionsEatablished_u32"],
    ],
  },
  {
    title: "Encryption & transport",
    fields: [
      ["Encryption", "UseEncrypt_bool"], ["Cipher", "CipherName_str"], ["Compression", "UseCompress_bool"],
      ["Half-duplex", "HalfConnection_bool"], ["VoIP / QoS", "QoS_bool"], ["R-UDP session", "IsRUDPSession_bool"],
      ["UDP acceleration enabled", "IsUdpAccelerationEnabled_bool"], ["Using UDP acceleration", "IsUsingUdpAcceleration_bool"],
      ["Max TCP connections", "MaxTcpConnections_u32"], ["Current TCP connections", "NumTcpConnections_u32"],
      ["Upload TCP connections", "NumTcpConnectionsUpload_u32"], ["Download TCP connections", "NumTcpConnectionsDownload_u32"],
      ["Bridge mode", "IsBridgeMode_bool"], ["Monitor mode", "IsMonitorMode_bool"], ["VLAN ID", "VLanId_u32"],
    ],
  },
  {
    title: "Traffic",
    fields: [
      ["Total sent", "TotalSendSize_u64"], ["Total received", "TotalRecvSize_u64"],
      ["Total sent (uncompressed)", "TotalSendSizeReal_u64"], ["Total received (uncompressed)", "TotalRecvSizeReal_u64"],
      ["Unicast sent", "Send.UnicastBytes_u64"], ["Unicast packets sent", "Send.UnicastCount_u64"],
      ["Broadcast sent", "Send.BroadcastBytes_u64"], ["Broadcast packets sent", "Send.BroadcastCount_u64"],
      ["Unicast received", "Recv.UnicastBytes_u64"], ["Unicast packets received", "Recv.UnicastCount_u64"],
      ["Broadcast received", "Recv.BroadcastBytes_u64"], ["Broadcast packets received", "Recv.BroadcastCount_u64"],
    ],
  },
];
