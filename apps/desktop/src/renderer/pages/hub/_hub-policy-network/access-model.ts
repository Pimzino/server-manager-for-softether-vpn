// Access list rule model (VpnAccess): form state, validation, conversion back to the RPC struct and
// one-line descriptions for the table. Ported unchanged in behaviour from apps/web/src/pages/hub/Access.tsx.
import {
  b64ToBytes, bytesToB64, ipv6FromB64, ipv6ToB64, isIPv4, macFromB64, macToB64, mask4ToPrefix, mask6ToPrefix, normalizeMask4, normalizeMask6,
} from "../../../components/domain/util";

export type Access = Record<string, any> & {
  Id_u32: number; Note_utf: string; Active_bool: boolean; Priority_u32: number; Discard_bool: boolean; IsIPv6_bool: boolean; Protocol_u32: number;
};

export const ZERO16 = bytesToB64(new Uint8Array(16));
export const ZERO6 = bytesToB64(new Uint8Array(6));
export const FULL_MAC_MASK = "FF-FF-FF-FF-FF-FF";

export const PROTOCOLS = [
  { value: "0", label: "Any protocol" },
  { value: "6", label: "TCP" },
  { value: "17", label: "UDP" },
  { value: "1", label: "ICMPv4" },
  { value: "58", label: "ICMPv6" },
  { value: "custom", label: "Other IP protocol…" },
];

export function protoLabel(p: number) {
  return p === 0 ? "Any" : PROTOCOLS.find((x) => x.value === String(p))?.label ?? `IP ${p}`;
}

export interface RuleForm {
  note: string; active: boolean; priority: number; discard: boolean; ipv6: boolean;
  srcIp: string; srcMask: string; dstIp: string; dstMask: string;
  proto: string; customProto: number;
  srcPortStart: number; srcPortEnd: number; dstPortStart: number; dstPortEnd: number;
  srcUser: string; dstUser: string;
  checkSrcMac: boolean; srcMac: string; srcMacMask: string; checkDstMac: boolean; dstMac: string; dstMacMask: string;
  checkTcpState: boolean; established: boolean;
  delay: number; jitter: number; loss: number; redirectUrl: string;
}

export const isAny4 = (ip: string, mask: string) => (ip === "0.0.0.0" || ip === "") && (mask === "0.0.0.0" || mask === "");

export function toForm(a: Access | null, nextPriority: number): RuleForm {
  if (!a) {
    return {
      note: "", active: true, priority: nextPriority, discard: false, ipv6: false, srcIp: "", srcMask: "", dstIp: "", dstMask: "",
      proto: "0", customProto: 0, srcPortStart: 0, srcPortEnd: 0, dstPortStart: 0, dstPortEnd: 0, srcUser: "", dstUser: "",
      checkSrcMac: false, srcMac: "", srcMacMask: FULL_MAC_MASK, checkDstMac: false, dstMac: "", dstMacMask: FULL_MAC_MASK,
      checkTcpState: false, established: true, delay: 0, jitter: 0, loss: 0, redirectUrl: "",
    };
  }
  const v6 = !!a.IsIPv6_bool;
  const ep = (ipKey: string, maskKey: string): [string, string] => {
    if (v6) {
      const ip = b64ToBytes(a[`${ipKey}6_bin`]); const m = b64ToBytes(a[`${maskKey}6_bin`]);
      const p = mask6ToPrefix(m);
      if (m.every((x) => x === 0) && ip.every((x) => x === 0)) return ["", ""];
      return [ipv6FromB64(a[`${ipKey}6_bin`]), p !== null ? String(p) : ipv6FromB64(a[`${maskKey}6_bin`])];
    }
    const ip = String(a[`${ipKey}_ip`] ?? ""), m = String(a[`${maskKey}_ip`] ?? "");
    return isAny4(ip, m) ? ["", ""] : [ip, m];
  };
  const [srcIp, srcMask] = ep("SrcIpAddress", "SrcSubnetMask");
  const [dstIp, dstMask] = ep("DestIpAddress", "DestSubnetMask");
  const known = PROTOCOLS.some((p) => p.value === String(a.Protocol_u32));
  return {
    note: a.Note_utf ?? "", active: !!a.Active_bool, priority: a.Priority_u32 ?? 1, discard: !!a.Discard_bool, ipv6: v6,
    srcIp, srcMask, dstIp, dstMask,
    proto: known ? String(a.Protocol_u32) : "custom", customProto: known ? 0 : a.Protocol_u32,
    srcPortStart: a.SrcPortStart_u32 ?? 0, srcPortEnd: a.SrcPortEnd_u32 ?? 0, dstPortStart: a.DestPortStart_u32 ?? 0, dstPortEnd: a.DestPortEnd_u32 ?? 0,
    srcUser: a.SrcUsername_str ?? "", dstUser: a.DestUsername_str ?? "",
    checkSrcMac: !!a.CheckSrcMac_bool, srcMac: a.CheckSrcMac_bool ? macFromB64(a.SrcMacAddress_bin) : "", srcMacMask: a.CheckSrcMac_bool ? macFromB64(a.SrcMacMask_bin) : FULL_MAC_MASK,
    checkDstMac: !!a.CheckDstMac_bool, dstMac: a.CheckDstMac_bool ? macFromB64(a.DstMacAddress_bin) : "", dstMacMask: a.CheckDstMac_bool ? macFromB64(a.DstMacMask_bin) : FULL_MAC_MASK,
    checkTcpState: !!a.CheckTcpState_bool, established: a.CheckTcpState_bool ? !!a.Established_bool : true,
    delay: a.Delay_u32 ?? 0, jitter: a.Jitter_u32 ?? 0, loss: a.Loss_u32 ?? 0, redirectUrl: a.RedirectUrl_str ?? "",
  };
}

export type Errors = Partial<Record<keyof RuleForm, string>>;

export function validate(f: RuleForm): Errors {
  const e: Errors = {};
  if (!Number.isInteger(f.priority) || f.priority < 1) e.priority = "Use 1 or higher.";
  const ip = (k: "srcIp" | "dstIp", mk: "srcMask" | "dstMask") => {
    const v = f[k].trim(), m = f[mk].trim();
    if (!v && !m) return;
    if (f.ipv6) {
      if (!ipv6ToB64(v || "::")) e[k] = "Enter an IPv6 address.";
      if (m && !normalizeMask6(m)) e[mk] = "Prefix length 0–128 or a contiguous IPv6 mask.";
    } else {
      if (v && !isIPv4(v)) e[k] = "Enter an IPv4 address.";
      if (m && !normalizeMask4(m)) e[mk] = "Dotted mask (255.255.255.0) or prefix length 0–32.";
    }
  };
  ip("srcIp", "srcMask"); ip("dstIp", "dstMask");
  const port = (s: keyof RuleForm, en: keyof RuleForm) => {
    const a = f[s] as number, b = f[en] as number;
    if (a < 0 || a > 65535) e[s] = "0–65535";
    if (b < 0 || b > 65535) e[en] = "0–65535";
    else if (b !== 0 && b < a) e[en] = "Must not be lower than the first port.";
  };
  port("srcPortStart", "srcPortEnd"); port("dstPortStart", "dstPortEnd");
  if (f.proto === "custom" && (f.customProto < 0 || f.customProto > 255)) e.customProto = "0–255";
  if (f.checkSrcMac) { if (!macToB64(f.srcMac)) e.srcMac = "For example 00-AC-01-23-45-67."; if (!macToB64(f.srcMacMask)) e.srcMacMask = "Enter a MAC mask."; }
  if (f.checkDstMac) { if (!macToB64(f.dstMac)) e.dstMac = "For example 00-AC-01-23-45-67."; if (!macToB64(f.dstMacMask)) e.dstMacMask = "Enter a MAC mask."; }
  if (f.delay < 0 || f.delay > 10000) e.delay = "0–10,000 ms";
  if (f.jitter < 0 || f.jitter > 100) e.jitter = "0–100 %";
  if (f.loss < 0 || f.loss > 100) e.loss = "0–100 %";
  if (f.redirectUrl && !/^https?:\/\/\S+$/i.test(f.redirectUrl.trim())) e.redirectUrl = "Use an http:// or https:// URL.";
  return e;
}

/** Build the full VpnAccess struct, preserving unknown fields of the original rule. */
export function fromForm(f: RuleForm, base: Access | null): Access {
  const proto = f.proto === "custom" ? f.customProto : Number(f.proto);
  const hasPorts = proto === 6 || proto === 17 || proto === 0;
  const out: Access = {
    ...(base ?? {}),
    Id_u32: base?.Id_u32 ?? 0,
    Note_utf: f.note, Active_bool: f.active, Priority_u32: f.priority, Discard_bool: f.discard, IsIPv6_bool: f.ipv6, Protocol_u32: proto,
    SrcIpAddress_ip: "0.0.0.0", SrcSubnetMask_ip: "0.0.0.0", DestIpAddress_ip: "0.0.0.0", DestSubnetMask_ip: "0.0.0.0",
    SrcIpAddress6_bin: ZERO16, SrcSubnetMask6_bin: ZERO16, DestIpAddress6_bin: ZERO16, DestSubnetMask6_bin: ZERO16,
    SrcPortStart_u32: hasPorts ? f.srcPortStart : 0, SrcPortEnd_u32: hasPorts ? f.srcPortEnd : 0,
    DestPortStart_u32: hasPorts ? f.dstPortStart : 0, DestPortEnd_u32: hasPorts ? f.dstPortEnd : 0,
    SrcUsername_str: f.srcUser.trim(), DestUsername_str: f.dstUser.trim(),
    CheckSrcMac_bool: f.checkSrcMac, SrcMacAddress_bin: f.checkSrcMac ? macToB64(f.srcMac)! : ZERO6, SrcMacMask_bin: f.checkSrcMac ? macToB64(f.srcMacMask)! : ZERO6,
    CheckDstMac_bool: f.checkDstMac, DstMacAddress_bin: f.checkDstMac ? macToB64(f.dstMac)! : ZERO6, DstMacMask_bin: f.checkDstMac ? macToB64(f.dstMacMask)! : ZERO6,
    CheckTcpState_bool: proto === 6 ? f.checkTcpState : false, Established_bool: proto === 6 && f.checkTcpState ? f.established : false,
    Delay_u32: f.delay, Jitter_u32: f.jitter, Loss_u32: f.loss, RedirectUrl_str: f.redirectUrl.trim(),
  };
  const ep = (ip: string, mask: string, ipKey: string, maskKey: string) => {
    ip = ip.trim(); mask = mask.trim();
    if (!ip && !mask) return;
    if (f.ipv6) {
      out[`${ipKey}6_bin`] = ipv6ToB64(ip || "::")!;
      out[`${maskKey}6_bin`] = mask ? normalizeMask6(mask)! : bytesToB64(new Uint8Array(16).fill(255));
    } else {
      out[`${ipKey}_ip`] = ip || "0.0.0.0";
      out[`${maskKey}_ip`] = mask ? normalizeMask4(mask)! : "255.255.255.255";
    }
  };
  ep(f.srcIp, f.srcMask, "SrcIpAddress", "SrcSubnetMask");
  ep(f.dstIp, f.dstMask, "DestIpAddress", "DestSubnetMask");
  return out;
}

/** Protocol and destination ports, the way firewall lists show a service: "TCP 22", "UDP 1000–2000", "Any". */
export function service(a: Access) {
  const ps = a.DestPortStart_u32, pe = a.DestPortEnd_u32;
  const ports = ps || pe ? ` ${ps}${pe && pe !== ps ? `–${pe}` : ""}` : "";
  return `${protoLabel(a.Protocol_u32)}${ports}`;
}

/** "10.0.0.0/8, port 22, user alice" — or "any". `ports: false` leaves the ports out (shown by service()). */
export function endpoint(a: Access, side: "src" | "dst", ports = true) {
  const parts: string[] = [];
  const ipKey = side === "src" ? "SrcIpAddress" : "DestIpAddress", maskKey = side === "src" ? "SrcSubnetMask" : "DestSubnetMask";
  if (a.IsIPv6_bool) {
    const m = b64ToBytes(a[`${maskKey}6_bin`]);
    if (!m.every((x) => x === 0)) {
      const p = mask6ToPrefix(m);
      parts.push(`${ipv6FromB64(a[`${ipKey}6_bin`])}/${p ?? ipv6FromB64(a[`${maskKey}6_bin`])}`);
    }
  } else {
    const ip = a[`${ipKey}_ip`], m = a[`${maskKey}_ip`];
    if (!isAny4(ip, m)) {
      const p = mask4ToPrefix(m);
      parts.push(p === 32 ? ip : `${ip}/${p ?? m}`);
    }
  }
  const ps = side === "src" ? a.SrcPortStart_u32 : a.DestPortStart_u32, pe = side === "src" ? a.SrcPortEnd_u32 : a.DestPortEnd_u32;
  if (ports && (ps || pe)) parts.push(`port ${ps}${pe && pe !== ps ? `–${pe}` : ""}`);
  const user = side === "src" ? a.SrcUsername_str : a.DestUsername_str;
  if (user) parts.push(`user ${user}`);
  if (side === "src" ? a.CheckSrcMac_bool : a.CheckDstMac_bool) {
    parts.push(`MAC ${macFromB64(side === "src" ? a.SrcMacAddress_bin : a.DstMacAddress_bin)}`);
  }
  return parts.length ? parts.join(", ") : "any";
}

/** Extra conditions and effects: TCP state, delay/jitter/loss, redirect. */
export function extras(a: Access) {
  const x: string[] = [];
  if (a.CheckTcpState_bool) x.push(a.Established_bool ? "TCP established" : "TCP new");
  if (a.Delay_u32) x.push(`delay ${a.Delay_u32} ms`);
  if (a.Jitter_u32) x.push(`jitter ${a.Jitter_u32}%`);
  if (a.Loss_u32) x.push(`loss ${a.Loss_u32}%`);
  if (a.RedirectUrl_str) x.push(`redirect ${a.RedirectUrl_str}`);
  return x;
}
