// Human-friendly rendering of SoftEther status structs (GetSessionStatus, GetLinkStatus…).
// Known fields are grouped into titled property lists; every other key the server returns is listed under
// "All other fields" (collapsed), so nothing is hidden.
import type { ReactNode } from "react";
import { Button } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { bytes, downloadText, dt, num } from "../../lib/format";
import { notifyError } from "../../lib/hooks";
import { Mono, PropertyList, Section, StatusBadge, type Status } from "../../design";
import { fieldLabel } from "./RpcForm";
import { Disclosure, YesNo } from "./ui";
import { b64ToBytes, derB64ToPem, ipv6FromB64, toHex } from "./util";

/** SessionStatus_u32 / cascade status values. */
export const SESSION_STATUS: Record<number, { label: string; status: Status }> = {
  0: { label: "Connecting", status: "busy" },
  1: { label: "Negotiating", status: "busy" },
  2: { label: "Authenticating", status: "busy" },
  3: { label: "Established", status: "ok" },
  4: { label: "Retrying", status: "warning" },
  5: { label: "Idle", status: "off" },
};

export function SessionStatusBadge({ value, testId }: { value: number | undefined; testId?: string }) {
  const s = SESSION_STATUS[value ?? -1];
  return s ? <StatusBadge status={s.status} testId={testId}>{s.label}</StatusBadge> : <StatusBadge status="unknown" testId={testId}>Unknown</StatusBadge>;
}

/** "4.44 build 9807" from ProductVer_u32 + build. */
export function fmtVersion(ver: unknown, build?: unknown) {
  const v = Number(ver ?? 0);
  if (!v) return "–";
  const s = `${Math.floor(v / 100)}.${String(v % 100).padStart(2, "0")}`;
  return build ? `${s} build ${build}` : s;
}

function SavePem({ name, b64 }: { name: string; b64: string }) {
  return (
    <Button size="xs" variant="default" leftSection={<IconDownload size={12} />}
      onClick={() => { downloadText(`${name}.pem`, derB64ToPem(b64), "application/x-pem-file").catch((e) => notifyError(e, "Couldn’t save the certificate")); }}>
      Save PEM…
    </Button>
  );
}

/** Format any status value by its name suffix (_bool, _dt, _u64, _u32, _bin, _ip…). */
export function fmtField(key: string, v: unknown): ReactNode {
  if (v === undefined || v === null) return "–";
  if (key.endsWith("_bool")) return <YesNo value={v} />;
  if (key.endsWith("_dt")) return dt(String(v));
  if (key.endsWith("_u64")) return /Size|Bytes/.test(key) ? <span className="sem-num">{bytes(Number(v))} <span className="sem-dim">({num(Number(v))} B)</span></span> : <span className="sem-num">{num(Number(v))}</span>;
  if (key.endsWith("_u32")) return <span className="sem-num">{num(Number(v))}</span>;
  if (key.endsWith("_bin")) {
    const b = b64ToBytes(String(v));
    if (b.length === 16 && /Ip|Address6/i.test(key)) return <Mono>{ipv6FromB64(String(v))}</Mono>;
    if (b.length === 0 || b.every((x) => x === 0)) return <span className="sem-dim">Empty</span>;
    if (/X_bin$|Cert/.test(key)) {
      return <span className="sem-row-inline"><span className="sem-num">{num(b.length)} bytes</span><SavePem name={key.replace(/_bin$/, "")} b64={String(v)} /></span>;
    }
    return <span className="sem-mono sem-break">{toHex(b, "")}</span>;
  }
  if (key.endsWith("_ip")) return v === "::" || v === "" || v === "0.0.0.0" ? "–" : <Mono>{String(v)}</Mono>;
  return String(v) === "" ? <span className="sem-dim">None</span> : String(v);
}

/**
 * NODE_INFO (the facts a client reports about itself at login) keeps its integers in network byte order, and the
 * server packs them without converting (Admin.c OutRpcNodeInfo), so GetSessionStatus returns ClientPort 61635 as
 * 3,287,285,760. Server Manager byte-swaps them for display (SM.c SmPrintNodeInfo: Endian32). Do the same.
 */
export function swap32(v: unknown): number {
  const n = Number(v) >>> 0;
  return (((n & 0xff) << 24) | ((n & 0xff00) << 8) | ((n >>> 8) & 0xff00) | (n >>> 24)) >>> 0;
}

/** Integer NODE_INFO keys of GetSessionStatus that arrive byte-swapped (see swap32). */
export const NODE_INFO_SWAPPED = ["ClientProductVer_u32", "ClientProductBuild_u32", "ClientPort_u32", "ServerPort2_u32", "ProxyPort_u32"];

/** Every NODE_INFO key of GetSessionStatus (what the client reports about itself). */
export const NODE_INFO_KEYS = [
  ...NODE_INFO_SWAPPED, "ClientProductName_str", "ClientOsName_str", "ClientOsVer_str", "ClientOsProductId_str", "ClientHostname_str",
  "ServerHostname_str", "ProxyHostname_str", "UniqueId_bin", "ClientIpAddress_ip", "ServerIpAddress_ip", "ProxyIpAddress_ip",
  "ClientIpAddress6_bin", "ServerIpAddress6_bin", "ProxyIpAddress6_bin",
];

/**
 * Sessions the server creates itself (cascade, SecureNAT, Local Bridge, Layer 3 switch) have no client node
 * information and no separate authenticated user: Server Manager hides both for them (SM.c SmRefreshSessionStatus).
 */
export function isServerCreatedSession(d: Record<string, unknown>): boolean {
  const u = String(d.Username_str ?? "");
  return /^(Cascade|SecureNAT|Local Bridge)$/i.test(u) || /^L3SW_/i.test(u);
}

/** A reported port (NODE_INFO): byte-swapped, 0 = not reported. Ports aren't quantities: no thousands separator. */
export function fmtReportedPort(v: unknown): ReactNode {
  const p = swap32(v);
  return p ? <span className="sem-num">{p}</span> : "–";
}

/** A reported client version (NODE_INFO ClientProductVer/Build): byte-swapped like Server Manager does. */
export function fmtReportedVersion(ver: unknown, build: unknown): string {
  return fmtVersion(swap32(ver), swap32(build) || undefined);
}

export interface FieldGroup { title: string; fields: ([string, string] | [string, string, (v: unknown, all: Record<string, unknown>) => ReactNode])[] }

/**
 * Render grouped fields (keys in `hide` are left out even when a group lists them); every remaining key of the struct is listed under "All other fields" and the
 * effective policy under "Effective security policy" (both collapsed), so nothing the server returns is hidden.
 * `labelWidth` narrows the label column for use inside an Inspector (default 180).
 */
export function StatusGroups({ data, groups, hide = [], labelWidth = 180, testId }: {
  data: Record<string, unknown>; groups: FieldGroup[]; hide?: string[]; labelWidth?: number; testId?: string;
}) {
  const used = new Set<string>(hide);
  groups.forEach((g) => g.fields.forEach((f) => used.add(f[1])));
  const rest = Object.keys(data).filter((k) => !used.has(k) && !k.startsWith("policy:")).sort();
  const policy = Object.keys(data).filter((k) => k.startsWith("policy:")).sort();
  const sections = groups
    .map((g) => ({
      title: g.title,
      rows: g.fields.filter((f) => data[f[1]] !== undefined && !hide.includes(f[1])).map(([label, k, render]) => [label, render ? render(data[k], data) : fmtField(k, data[k])] as [ReactNode, ReactNode]),
    }))
    .filter((s) => s.rows.length);
  return (
    <div data-testid={testId}>
      {sections.map((s) => (
        <Section key={s.title} title={s.title} variant="inset">
          <PropertyList rows={s.rows} labelWidth={labelWidth} dense />
        </Section>
      ))}
      {rest.length > 0 && (
        <Disclosure label="All other fields" badge={<span className="sem-dim">({rest.length})</span>} testId="status-other">
          <div className="sem-inset" style={{ marginTop: "var(--sem-space-4)" }}>
            <PropertyList labelWidth={labelWidth} dense items={rest.map((k) => ({
              key: k, label: <span title={k}>{fieldLabel(k)}</span>, value: fmtField(k, data[k]), hint: k,
            }))} />
          </div>
        </Disclosure>
      )}
      {policy.length > 0 && (
        <Disclosure label="Effective security policy" badge={<span className="sem-dim">({policy.length})</span>} testId="status-policy">
          <div className="sem-inset" style={{ marginTop: "var(--sem-space-4)" }}>
            <PropertyList labelWidth={labelWidth} dense items={policy.map((k) => ({ key: k, label: fieldLabel(k.replace("policy:", "")), value: fmtField(k, data[k]) }))} />
          </div>
        </Disclosure>
      )}
    </div>
  );
}

/** Groups shared by GetSessionStatus and GetLinkStatus. */
export const CONNECTION_GROUPS: FieldGroup[] = [
  {
    title: "Connection",
    fields: [
      ["Session status", "SessionStatus_u32", (v) => <SessionStatusBadge value={Number(v)} />],
      ["Active", "Active_bool"], ["Connected", "Connected_bool"],
      ["Server name", "ServerName_str"], ["Server host name", "ServerHostname_str"], ["Server port", "ServerPort_u32"],
      ["Server product", "ServerProductName_str"],
      ["Server version", "ServerProductVer_u32", (v, all) => fmtVersion(v, all.ServerProductBuild_u32)],
      ["Underlay protocol", "UnderlayProtocol_str"], ["Protocol version", "ProtocolVersion_str"], ["Protocol details", "ProtocolDetails_str"],
      ["Started", "StartTime_dt"], ["First connection established", "FirstConnectionEstablisiedTime_dt"],
      ["Current connection established", "CurrentConnectionEstablishTime_dt"],
      // SoftEther spells this field both ways depending on the RPC.
      ["Connections established so far", "NumConnectionsEstablished_u32"], ["Connections established so far", "NumConnectionsEatablished_u32"],
    ],
  },
  {
    title: "Encryption and transport",
    fields: [
      ["Encryption", "UseEncrypt_bool"], ["Cipher", "CipherName_str"], ["Compression", "UseCompress_bool"],
      ["Half-duplex", "HalfConnection_bool"], ["VoIP / QoS", "QoS_bool"], ["R-UDP session", "IsRUDPSession_bool"],
      ["UDP acceleration enabled", "IsUdpAccelerationEnabled_bool"], ["Using UDP acceleration", "IsUsingUdpAcceleration_bool"],
      ["Maximum TCP connections", "MaxTcpConnections_u32"], ["Current TCP connections", "NumTcpConnections_u32"],
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
