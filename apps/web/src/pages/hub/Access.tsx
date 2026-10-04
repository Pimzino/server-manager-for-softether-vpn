import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon, Alert, Badge, Button, Checkbox, Code, Divider, Drawer, Group, NumberInput, SegmentedControl, Select, SimpleGrid, Stack, Switch,
  Text, TextInput, Textarea, Tooltip,
} from "@mantine/core";
import {
  IconArrowDown, IconArrowUp, IconCopy, IconDownload, IconEdit, IconListNumbers, IconPlus, IconRefresh, IconTrash,
} from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, PageHeader, QueryState, ReadOnlyNotice } from "../../components/common";
import {
  b64ToBytes, bytesToB64, ipv6FromB64, ipv6ToB64, isIPv4, macFromB64, macToB64, mask4ToPrefix, mask6ToPrefix, normalizeMask4, normalizeMask6,
} from "../../components/hub/util";
import { downloadText } from "../../lib/format";
import { can, useCatalog, useRpc, useRpcMutation, useScope, useServer } from "../../lib/hooks";

type Access = Record<string, any> & {
  Id_u32: number; Note_utf: string; Active_bool: boolean; Priority_u32: number; Discard_bool: boolean; IsIPv6_bool: boolean; Protocol_u32: number;
};

const ZERO16 = bytesToB64(new Uint8Array(16));
const ZERO6 = bytesToB64(new Uint8Array(6));
const FULL_MAC_MASK = "FF-FF-FF-FF-FF-FF";

const PROTOCOLS = [
  { value: "0", label: "Any protocol" },
  { value: "6", label: "TCP" },
  { value: "17", label: "UDP" },
  { value: "1", label: "ICMPv4" },
  { value: "58", label: "ICMPv6" },
  { value: "custom", label: "Other IP protocol number…" },
];
function protoLabel(p: number) {
  return p === 0 ? "Any" : PROTOCOLS.find((x) => x.value === String(p))?.label ?? `IP proto ${p}`;
}

/* ------------------------------------------------------------------ form model */

interface RuleForm {
  note: string; active: boolean; priority: number; discard: boolean; ipv6: boolean;
  srcIp: string; srcMask: string; dstIp: string; dstMask: string;
  proto: string; customProto: number;
  srcPortStart: number; srcPortEnd: number; dstPortStart: number; dstPortEnd: number;
  srcUser: string; dstUser: string;
  checkSrcMac: boolean; srcMac: string; srcMacMask: string; checkDstMac: boolean; dstMac: string; dstMacMask: string;
  checkTcpState: boolean; established: boolean;
  delay: number; jitter: number; loss: number; redirectUrl: string;
}

function isAny4(ip: string, mask: string) { return (ip === "0.0.0.0" || ip === "") && (mask === "0.0.0.0" || mask === ""); }

function toForm(a: Access | null, nextPriority: number): RuleForm {
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

type Errors = Partial<Record<keyof RuleForm, string>>;

function validate(f: RuleForm): Errors {
  const e: Errors = {};
  if (!Number.isInteger(f.priority) || f.priority < 1) e.priority = "Priority must be 1 or higher";
  const ip = (k: "srcIp" | "dstIp", mk: "srcMask" | "dstMask") => {
    const v = f[k].trim(), m = f[mk].trim();
    if (!v && !m) return;
    if (f.ipv6) {
      if (!ipv6ToB64(v || "::")) e[k] = "Invalid IPv6 address";
      if (m && !normalizeMask6(m)) e[mk] = "Prefix length 0–128 or a contiguous IPv6 mask";
    } else {
      if (v && !isIPv4(v)) e[k] = "Invalid IPv4 address";
      if (m && !normalizeMask4(m)) e[mk] = "Dotted mask (255.255.255.0) or prefix length 0–32";
    }
  };
  ip("srcIp", "srcMask"); ip("dstIp", "dstMask");
  const port = (s: keyof RuleForm, en: keyof RuleForm) => {
    const a = f[s] as number, b = f[en] as number;
    if (a < 0 || a > 65535) e[s] = "0–65535";
    if (b < 0 || b > 65535) e[en] = "0–65535";
    else if (b !== 0 && b < a) e[en] = "End must be ≥ start";
  };
  port("srcPortStart", "srcPortEnd"); port("dstPortStart", "dstPortEnd");
  if (f.proto === "custom" && (f.customProto < 0 || f.customProto > 255)) e.customProto = "0–255";
  if (f.checkSrcMac) { if (!macToB64(f.srcMac)) e.srcMac = "e.g. 00-AC-01-23-45-67"; if (!macToB64(f.srcMacMask)) e.srcMacMask = "Invalid mask"; }
  if (f.checkDstMac) { if (!macToB64(f.dstMac)) e.dstMac = "e.g. 00-AC-01-23-45-67"; if (!macToB64(f.dstMacMask)) e.dstMacMask = "Invalid mask"; }
  if (f.delay < 0 || f.delay > 10000) e.delay = "0–10000 ms";
  if (f.jitter < 0 || f.jitter > 100) e.jitter = "0–100 %";
  if (f.loss < 0 || f.loss > 100) e.loss = "0–100 %";
  if (f.redirectUrl && !/^https?:\/\/\S+$/i.test(f.redirectUrl.trim())) e.redirectUrl = "Must be an http:// or https:// URL";
  return e;
}

/** Build the full VpnAccess struct, preserving unknown fields of the original rule. */
function fromForm(f: RuleForm, base: Access | null): Access {
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

/* ------------------------------------------------------------------ display */

function endpoint(a: Access, side: "src" | "dst") {
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
  if (ps || pe) parts.push(`port ${ps}${pe && pe !== ps ? `–${pe}` : ""}`);
  const user = side === "src" ? a.SrcUsername_str : a.DestUsername_str;
  if (user) parts.push(`user ${user}`);
  if (side === "src" ? a.CheckSrcMac_bool : a.CheckDstMac_bool) {
    parts.push(`MAC ${macFromB64(side === "src" ? a.SrcMacAddress_bin : a.DstMacAddress_bin)}`);
  }
  return parts.length ? parts.join(", ") : "any";
}

function extras(a: Access) {
  const x: string[] = [];
  if (a.CheckTcpState_bool) x.push(a.Established_bool ? "TCP established" : "TCP not established");
  if (a.Delay_u32) x.push(`delay ${a.Delay_u32} ms`);
  if (a.Jitter_u32) x.push(`jitter ${a.Jitter_u32}%`);
  if (a.Loss_u32) x.push(`loss ${a.Loss_u32}%`);
  if (a.RedirectUrl_str) x.push(`redirect → ${a.RedirectUrl_str}`);
  return x;
}

/* ------------------------------------------------------------------ editor */

function RuleDrawer({ opened, onClose, initial, mode, onSave, saving, nextPriority, readOnly }: {
  readOnly?: boolean; opened: boolean; onClose: () => void; initial: Access | null; mode: "create" | "edit"; onSave: (a: Access) => void; saving: boolean; nextPriority: number;
}) {
  const cat = useCatalog();
  const doc = (f: string) => cat.data?.types["VpnAccess"]?.fields.find((x) => x.name === f)?.doc;
  const [f, setF] = useState<RuleForm>(() => toForm(initial, nextPriority));
  useEffect(() => { if (opened) setF(toForm(initial, nextPriority)); }, [opened, initial, nextPriority]);
  const set = (p: Partial<RuleForm>) => setF((s) => ({ ...s, ...p }));
  const errs = validate(f);
  const hasErr = Object.keys(errs).length > 0;
  const proto = f.proto === "custom" ? f.customProto : Number(f.proto);
  const portsApply = proto === 0 || proto === 6 || proto === 17;

  const endpointFields = (side: "src" | "dst") => {
    const ipK = side === "src" ? "srcIp" : "dstIp", mK = side === "src" ? "srcMask" : "dstMask";
    const psK = side === "src" ? "srcPortStart" : "dstPortStart", peK = side === "src" ? "srcPortEnd" : "dstPortEnd";
    const uK = side === "src" ? "srcUser" : "dstUser";
    const cK = side === "src" ? "checkSrcMac" : "checkDstMac", macK = side === "src" ? "srcMac" : "dstMac", mmK = side === "src" ? "srcMacMask" : "dstMacMask";
    const F = side === "src" ? "Src" : "Dest";
    return (
      <Stack gap="xs">
        <Text fw={600} size="sm">{side === "src" ? "Source" : "Destination"}</Text>
        <SimpleGrid cols={2} spacing="xs">
          <TextInput label={f.ipv6 ? "IPv6 address" : "IPv4 address"} placeholder="any" value={f[ipK]} error={errs[ipK]}
            description={doc(`${F}IpAddress${f.ipv6 ? "6_bin" : "_ip"}`)?.replace(/^Valid only[^.]*\.\s*/, "")}
            onChange={(e) => set({ [ipK]: e.currentTarget.value } as Partial<RuleForm>)} ff="monospace" data-testid={`rule-${side}-ip`} />
          <TextInput label={f.ipv6 ? "Prefix length / mask" : "Subnet mask"} placeholder={f.ipv6 ? "128 (single host)" : "255.255.255.255 or 24"} value={f[mK]} error={errs[mK]}
            description={f.ipv6 ? "e.g. 64. Empty = single host (/128)." : "Dotted or prefix length. Empty = single host."}
            onChange={(e) => set({ [mK]: e.currentTarget.value } as Partial<RuleForm>)} ff="monospace" data-testid={`rule-${side}-mask`} />
        </SimpleGrid>
        {portsApply && (
          <SimpleGrid cols={2} spacing="xs">
            <NumberInput label="Port from" min={0} max={65535} value={f[psK]} error={errs[psK]} allowDecimal={false}
              description="0 = any port" onChange={(v) => set({ [psK]: Number(v) || 0 } as Partial<RuleForm>)} data-testid={`rule-${side}-port-start`} />
            <NumberInput label="Port to" min={0} max={65535} value={f[peK]} error={errs[peK]} allowDecimal={false}
              description="0 = same as start" onChange={(v) => set({ [peK]: Number(v) || 0 } as Partial<RuleForm>)} data-testid={`rule-${side}-port-end`} />
          </SimpleGrid>
        )}
        <TextInput label={side === "src" ? "Source user name" : "Destination user name"} placeholder="any user" value={f[uK]}
          description={doc(`${F}Username_str`)} onChange={(e) => set({ [uK]: e.currentTarget.value } as Partial<RuleForm>)} data-testid={`rule-${side}-user`} />
        <Switch label={`Match ${side === "src" ? "source" : "destination"} MAC address`} checked={f[cK]} description={doc(side === "src" ? "CheckSrcMac_bool" : "CheckDstMac_bool")}
          onChange={(e) => set({ [cK]: e.currentTarget.checked } as Partial<RuleForm>)} />
        {f[cK] && (
          <SimpleGrid cols={2} spacing="xs">
            <TextInput label="MAC address" value={f[macK]} error={errs[macK]} placeholder="00-AC-01-23-45-67" ff="monospace"
              onChange={(e) => set({ [macK]: e.currentTarget.value } as Partial<RuleForm>)} />
            <TextInput label="MAC mask" value={f[mmK]} error={errs[mmK]} placeholder={FULL_MAC_MASK} ff="monospace"
              description="FF-FF-FF-FF-FF-FF = exact match"
              onChange={(e) => set({ [mmK]: e.currentTarget.value } as Partial<RuleForm>)} />
          </SimpleGrid>
        )}
      </Stack>
    );
  };

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="xl"
      title={<Text fw={700}>{mode === "create" ? "Add access rule" : <>Edit access rule <Code>#{initial?.Id_u32}</Code></>}</Text>}>
      <form onSubmit={(e) => { e.preventDefault(); if (!hasErr) onSave(fromForm(f, mode === "edit" ? initial : null)); }} data-testid="access-rule-form">
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
            <Stack gap={4}>
              <Text size="sm" fw={500}>Action</Text>
              <SegmentedControl value={f.discard ? "discard" : "pass"} onChange={(v) => set({ discard: v === "discard" })}
                data={[{ value: "pass", label: "Pass" }, { value: "discard", label: "Discard" }]} color={f.discard ? "red" : "green"} data-testid="rule-action" />
            </Stack>
            <NumberInput label="Priority" min={1} value={f.priority} error={errs.priority} allowDecimal={false}
              description="Lower value = evaluated first" onChange={(v) => set({ priority: Number(v) || 0 })} data-testid="rule-priority" />
            <Stack gap={4}>
              <Text size="sm" fw={500}>IP version</Text>
              <SegmentedControl value={f.ipv6 ? "6" : "4"} onChange={(v) => set({ ipv6: v === "6", srcIp: "", srcMask: "", dstIp: "", dstMask: "" })}
                data={[{ value: "4", label: "IPv4" }, { value: "6", label: "IPv6" }]} data-testid="rule-ipver" />
            </Stack>
          </SimpleGrid>
          <Text size="xs" c="dimmed">{doc("Discard_bool")} {doc("Priority_u32")}</Text>
          <TextInput label="Note" description={doc("Note_utf")} value={f.note} onChange={(e) => set({ note: e.currentTarget.value })} data-testid="rule-note" />
          <Switch label="Rule enabled" checked={f.active} onChange={(e) => set({ active: e.currentTarget.checked })} data-testid="rule-active" />

          <Divider label="Protocol" labelPosition="left" />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <Select label="IP protocol" data={PROTOCOLS} value={f.proto} allowDeselect={false} onChange={(v) => set({ proto: v ?? "0" })} data-testid="rule-protocol" />
            {f.proto === "custom" && (
              <NumberInput label="Protocol number" min={0} max={255} value={f.customProto} error={errs.customProto} allowDecimal={false}
                description="IANA IP protocol number (e.g. 47 = GRE, 50 = ESP)" onChange={(v) => set({ customProto: Number(v) || 0 })} />
            )}
          </SimpleGrid>
          {!portsApply && <Text size="xs" c="dimmed">Port conditions only apply to TCP and UDP.</Text>}
          {proto === 6 && (
            <Group>
              <Switch label="Check TCP connection state" checked={f.checkTcpState} description={doc("CheckTcpState_bool")}
                onChange={(e) => set({ checkTcpState: e.currentTarget.checked })} data-testid="rule-tcpstate" />
              {f.checkTcpState && (
                <SegmentedControl size="xs" value={f.established ? "est" : "new"} onChange={(v) => set({ established: v === "est" })}
                  data={[{ value: "est", label: "Established" }, { value: "new", label: "Not established" }]} />
              )}
            </Group>
          )}

          <Divider />
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
            {endpointFields("src")}
            {endpointFields("dst")}
          </SimpleGrid>

          <Divider label="Network simulation (pass rules)" labelPosition="left" />
          <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="sm">
            <NumberInput label="Delay" suffix=" ms" min={0} max={10000} value={f.delay} error={errs.delay} allowDecimal={false}
              description={doc("Delay_u32")} onChange={(v) => set({ delay: Number(v) || 0 })} data-testid="rule-delay" />
            <NumberInput label="Jitter" suffix=" %" min={0} max={100} value={f.jitter} error={errs.jitter} allowDecimal={false}
              description={doc("Jitter_u32")} onChange={(v) => set({ jitter: Number(v) || 0 })} data-testid="rule-jitter" />
            <NumberInput label="Packet loss" suffix=" %" min={0} max={100} value={f.loss} error={errs.loss} allowDecimal={false}
              description={doc("Loss_u32")} onChange={(v) => set({ loss: Number(v) || 0 })} data-testid="rule-loss" />
          </SimpleGrid>
          <Textarea label="HTTP redirect URL" placeholder="https://portal.example.com/" value={f.redirectUrl} error={errs.redirectUrl} autosize minRows={1}
            description={doc("RedirectUrl_str")} onChange={(e) => set({ redirectUrl: e.currentTarget.value })} data-testid="rule-redirect" />
          {f.redirectUrl && f.discard && <Alert color="orange" variant="light">Redirects only take effect on Pass rules.</Alert>}
          {mode === "edit" && initial?.UniqueId_u32 !== undefined && <Text size="xs" c="dimmed">Unique ID: <Code>{String(initial.UniqueId_u32)}</Code></Text>}

          <Group justify="flex-end" mt="md">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            {!readOnly && <Button type="submit" loading={saving} disabled={hasErr} data-testid="rule-save">{mode === "create" ? "Add rule" : "Save rule"}</Button>}
          </Group>
        </Stack>
      </form>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ page */

export default function AccessPage() {
  const { serverId, hub = "" } = useScope();
  const role = useServer(serverId).data?.myRole;
  const canWrite = can(role, "operator");
  const q = useRpc<{ AccessList?: Access[] }>(serverId, "EnumAccess", { HubName_str: hub });
  const [editor, setEditor] = useState<{ mode: "create" | "edit"; rule: Access | null } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const add = useRpcMutation(serverId, "AddAccess", { success: "Access rule added", onSuccess: () => setEditor(null) });
  const setList = useRpcMutation(serverId, "SetAccessList", { success: "Access list updated", onSuccess: () => setEditor(null) });
  const del = useRpcMutation(serverId, "DeleteAccess", { success: "Access rule deleted" });

  const sorted = useMemo(() => [...(q.data?.AccessList ?? [])].sort((a, b) => a.Priority_u32 - b.Priority_u32 || a.Id_u32 - b.Id_u32), [q.data]);
  useEffect(() => { setSelected(new Set()); }, [q.data]);
  const nextPriority = (sorted.at(-1)?.Priority_u32 ?? 0) + 10;
  const busy = setList.isPending || add.isPending || del.isPending;

  const push = (list: Access[], success?: string) => setList.mutateAsync({ HubName_str: hub, AccessList: list }).then(() => success);

  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= sorted.length) return;
    const list = sorted.map((a) => ({ ...a }));
    const [a, b] = [list[idx], list[j]];
    if (a.Priority_u32 !== b.Priority_u32) {
      [a.Priority_u32, b.Priority_u32] = [b.Priority_u32, a.Priority_u32];
    } else {
      [list[idx], list[j]] = [list[j], list[idx]];
      list.forEach((r, i) => (r.Priority_u32 = (i + 1) * 10));
    }
    void push(list);
  };
  const renumber = () => void push(sorted.map((a, i) => ({ ...a, Priority_u32: (i + 1) * 10 })));
  const toggle = (id: number, on: boolean) => void push(sorted.map((a) => (a.Id_u32 === id ? { ...a, Active_bool: on } : a)));

  const save = (rule: Access) => {
    if (editor?.mode === "edit") void push(sorted.map((a) => (a.Id_u32 === rule.Id_u32 ? rule : a)));
    else {
      const { Id_u32: _id, UniqueId_u32: _uid, ...r } = rule;
      add.mutate({ HubName_str: hub, AccessListSingle: [r] });
    }
  };

  const allSel = sorted.length > 0 && sorted.every((a) => selected.has(a.Id_u32));

  return (
    <>
      <PageHeader
        title="Access lists"
        description="Packet filter rules evaluated in priority order (lowest value first) for every packet passing through the Virtual Hub. The first matching rule decides Pass or Discard; packets matching no rule pass."
        actions={<>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => q.refetch()} loading={q.isFetching}>Refresh</Button>
          <Button variant="default" leftSection={<IconDownload size={16} />} disabled={!sorted.length}
            onClick={() => downloadText(`${hub}-access-list.json`, JSON.stringify(sorted, null, 2), "application/json")} data-testid="export-access">Export JSON</Button>
          {canWrite && <Button variant="default" leftSection={<IconListNumbers size={16} />} disabled={!sorted.length || busy} onClick={renumber} data-testid="renumber-access">Renumber</Button>}
          {canWrite && <Button leftSection={<IconPlus size={16} />} onClick={() => setEditor({ mode: "create", rule: null })} data-testid="create-access">Add rule</Button>}
        </>}
      />
      {!canWrite && role && <ReadOnlyNotice role={role} />}
      <QueryState query={q}>
        <DataTable
          testId="access-table"
          data={sorted}
          rowKey={(a) => a.Id_u32}
          onRowClick={(a) => setEditor({ mode: "edit", rule: a })}
          empty="No access rules — all packets pass"
          toolbar={canWrite && selected.size > 0 && (
            <ConfirmButton size="sm" title={`Delete ${selected.size} rule(s)?`} confirmLabel="Delete rules" leftSection={<IconTrash size={14} />}
              message="The selected rules are removed in one atomic update of the access list."
              onConfirm={() => push(sorted.filter((a) => !selected.has(a.Id_u32)))}>
              <span data-testid="bulk-delete-access">Delete selected ({selected.size})</span>
            </ConfirmButton>
          )}
          columns={[
            ...(canWrite ? [{
              key: "sel", sortable: false, width: 36, value: () => "",
              title: <Checkbox size="xs" aria-label="Select all" checked={allSel} indeterminate={!allSel && selected.size > 0}
                onChange={(e) => setSelected(e.currentTarget.checked ? new Set(sorted.map((a) => a.Id_u32)) : new Set())} />,
              render: (a: Access) => (
                <div onClick={(e) => e.stopPropagation()}>
                  <Checkbox size="xs" aria-label={`Select rule ${a.Id_u32}`} checked={selected.has(a.Id_u32)}
                    onChange={(e) => { const on = e.currentTarget.checked; setSelected((s) => { const x = new Set(s); if (on) x.add(a.Id_u32); else x.delete(a.Id_u32); return x; }); }} />
                </div>
              ),
            }] : []),
            { key: "Priority_u32", title: "Priority", align: "right", render: (a) => <Text ff="monospace" size="sm">{a.Priority_u32}</Text> },
            { key: "Active_bool", title: "Enabled", render: (a) => (
              <div onClick={(e) => e.stopPropagation()}>
                <Switch size="xs" checked={a.Active_bool} disabled={!canWrite || busy} aria-label={`Toggle rule ${a.Id_u32}`}
                  onChange={(e) => toggle(a.Id_u32, e.currentTarget.checked)} data-testid={`toggle-access-${a.Id_u32}`} />
              </div>
            ) },
            { key: "Discard_bool", title: "Action", value: (a) => (a.Discard_bool ? "Discard" : "Pass"),
              render: (a) => <Badge color={a.Discard_bool ? "red" : "green"} variant={a.Active_bool ? "filled" : "outline"}>{a.Discard_bool ? "Discard" : "Pass"}</Badge> },
            { key: "Note_utf", title: "Note", render: (a) => <Text size="sm" fw={500} lineClamp={2} maw={220}>{a.Note_utf || <Text span c="dimmed" size="sm">–</Text>}</Text> },
            { key: "IsIPv6_bool", title: "IP", value: (a) => (a.IsIPv6_bool ? "IPv6" : "IPv4"), render: (a) => <Badge variant="outline" color="gray">{a.IsIPv6_bool ? "IPv6" : "IPv4"}</Badge> },
            { key: "Protocol_u32", title: "Protocol", value: (a) => protoLabel(a.Protocol_u32), render: (a) => protoLabel(a.Protocol_u32) },
            { key: "src", title: "Source", value: (a) => endpoint(a, "src"), render: (a) => <Text size="sm" ff="monospace" style={{ wordBreak: "break-all" }}>{endpoint(a, "src")}</Text> },
            { key: "dst", title: "Destination", value: (a) => endpoint(a, "dst"), render: (a) => <Text size="sm" ff="monospace" style={{ wordBreak: "break-all" }}>{endpoint(a, "dst")}</Text> },
            { key: "extras", title: "Options", sortable: false, value: (a) => extras(a).join(" "),
              render: (a) => <Group gap={4}>{extras(a).map((x) => <Badge key={x} size="xs" variant="light" color="gray" tt="none">{x}</Badge>)}</Group> },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (a) => {
                const idx = sorted.indexOf(a);
                return (
                  <Group gap={2} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                    {canWrite && <>
                      <Tooltip label="Move up (higher priority)"><ActionIcon variant="subtle" disabled={idx <= 0 || busy} onClick={() => move(idx, -1)} aria-label="Move up" data-testid={`up-access-${a.Id_u32}`}><IconArrowUp size={16} /></ActionIcon></Tooltip>
                      <Tooltip label="Move down"><ActionIcon variant="subtle" disabled={idx >= sorted.length - 1 || busy} onClick={() => move(idx, 1)} aria-label="Move down" data-testid={`down-access-${a.Id_u32}`}><IconArrowDown size={16} /></ActionIcon></Tooltip>
                      <Tooltip label="Duplicate"><ActionIcon variant="subtle" onClick={() => setEditor({ mode: "create", rule: { ...a, Note_utf: a.Note_utf ? `${a.Note_utf} (copy)` : "copy" } })} aria-label="Duplicate" data-testid={`dup-access-${a.Id_u32}`}><IconCopy size={16} /></ActionIcon></Tooltip>
                    </>}
                    <Tooltip label={canWrite ? "Edit" : "View"}><ActionIcon variant="subtle" onClick={() => setEditor({ mode: "edit", rule: a })} aria-label="Edit" data-testid={`edit-access-${a.Id_u32}`}><IconEdit size={16} /></ActionIcon></Tooltip>
                    {canWrite && (
                      <ConfirmButton title="Delete access rule?" confirmLabel="Delete rule" leftSection={<IconTrash size={14} />}
                        message={<>Rule <b>#{a.Id_u32}</b> ({a.Discard_bool ? "Discard" : "Pass"}{a.Note_utf ? `, “${a.Note_utf}”` : ""}) will be removed immediately.</>}
                        onConfirm={() => del.mutateAsync({ HubName_str: hub, Id_u32: a.Id_u32 })}>Delete</ConfirmButton>
                    )}
                  </Group>
                );
              },
            },
          ]}
        />
      </QueryState>
      <RuleDrawer opened={!!editor} onClose={() => setEditor(null)} initial={editor?.rule ?? null} mode={editor?.mode ?? "create"}
        onSave={save} readOnly={!canWrite} saving={add.isPending || setList.isPending} nextPriority={nextPriority} />
    </>
  );
}
