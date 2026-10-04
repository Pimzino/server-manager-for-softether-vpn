import { useEffect, useState, type ReactNode } from "react";
import {
  ActionIcon, Alert, Badge, Button, Card, Code, Divider, Group, NumberInput, SimpleGrid, Stack, Switch, Table, Tabs, Text, TextInput, Tooltip,
} from "@mantine/core";
import { IconPlayerPlay, IconPlayerStop, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, ErrorAlert, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { isIPv4, macFromB64, macToB64, normalizeMask4 } from "../../components/hub/util";
import { ago, bytes, dt, num } from "../../lib/format";
import { can, useCatalog, useRpc, useRpcMutation, useScope, useServer } from "../../lib/hooks";

type Struct = Record<string, any>;
interface NatItem { Id_u32: number; Protocol_u32: number; SrcIp_ip: string; SrcHost_str: string; SrcPort_u32: number; DestIp_ip: string; DestHost_str: string; DestPort_u32: number; CreatedTime_dt: string; LastCommTime_dt: string; SendSize_u64: number; RecvSize_u64: number; TcpStatus_u32: number }
interface DhcpItem { Id_u32: number; LeasedTime_dt: string; ExpireTime_dt: string; MacAddress_bin: string; IpAddress_ip: string; Mask_u32: number; Hostname_str: string }

const NAT_PROTO: Record<number, string> = { 0: "TCP", 1: "UDP", 2: "DNS", 3: "ICMP" };
const TCP_STATE: Record<number, { label: string; color: string }> = {
  0: { label: "Connecting", color: "yellow" }, 1: { label: "Sending RST", color: "red" }, 2: { label: "Connected", color: "blue" },
  3: { label: "Established", color: "green" }, 4: { label: "Closing", color: "gray" },
};

/** Mask_u32 is the in-memory (network-order) address read as a little-endian integer. */
function maskU32(n: number) {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join(".");
}

function duration(sec: number) {
  if (!sec) return "0 s";
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(" ");
}

const emptyIp = (v: unknown) => !v || v === "::" || v === "0.0.0.0";

/* ------------------------------------------------------------------ push routes */

interface Route { net: string; mask: string; gw: string }

function parseRoutes(s: string): Route[] {
  return s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const [net = "", mask = "", gw = ""] = x.split("/");
    return { net, mask, gw };
  });
}
function formatRoutes(r: Route[]) {
  return r.filter((x) => x.net || x.mask || x.gw).map((x) => `${x.net}/${normalizeMask4(x.mask) ?? x.mask}/${x.gw}`).join(", ");
}
function routeErrors(r: Route) {
  return {
    net: isIPv4(r.net) ? undefined : "Invalid network",
    mask: normalizeMask4(r.mask) ? undefined : "Mask or /prefix",
    gw: isIPv4(r.gw) ? undefined : "Invalid gateway",
  };
}

function RoutesEditor({ routes, onChange, readOnly }: { routes: Route[]; onChange: (r: Route[]) => void; readOnly: boolean }) {
  const upd = (i: number, p: Partial<Route>) => onChange(routes.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <Stack gap="xs" data-testid="dhcp-routes-editor">
      {routes.length > 0 && (
        <Table withRowBorders={false} verticalSpacing={2}>
          <Table.Thead><Table.Tr><Table.Th>Network</Table.Th><Table.Th>Subnet mask</Table.Th><Table.Th>Gateway</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {routes.map((r, i) => {
              const e = routeErrors(r);
              return (
                <Table.Tr key={i}>
                  <Table.Td><TextInput size="xs" ff="monospace" placeholder="192.168.5.0" value={r.net} error={r.net && e.net} readOnly={readOnly} onChange={(ev) => upd(i, { net: ev.currentTarget.value })} /></Table.Td>
                  <Table.Td><TextInput size="xs" ff="monospace" placeholder="255.255.255.0 or 24" value={r.mask} error={r.mask && e.mask} readOnly={readOnly} onChange={(ev) => upd(i, { mask: ev.currentTarget.value })} /></Table.Td>
                  <Table.Td><TextInput size="xs" ff="monospace" placeholder="192.168.30.254" value={r.gw} error={r.gw && e.gw} readOnly={readOnly} onChange={(ev) => upd(i, { gw: ev.currentTarget.value })} /></Table.Td>
                  <Table.Td>{!readOnly && <ActionIcon variant="subtle" color="red" onClick={() => onChange(routes.filter((_, j) => j !== i))} aria-label="Remove route"><IconTrash size={14} /></ActionIcon>}</Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      )}
      {!readOnly && (
        <Button size="xs" variant="light" w="fit-content" leftSection={<IconPlus size={14} />} disabled={routes.length >= 64}
          onClick={() => onChange([...routes, { net: "", mask: "255.255.255.0", gw: "" }])} data-testid="dhcp-route-add">Add route</Button>
      )}
      <Text size="xs" c="dimmed">Pushed as: <Code>{formatRoutes(routes) || "(none)"}</Code> — maximum 64 entries.</Text>
    </Stack>
  );
}

/* ------------------------------------------------------------------ options form */

function OptionsForm({ serverId, hub, canWrite }: { serverId: number; hub: string; canWrite: boolean }) {
  const cat = useCatalog();
  const doc = (f: string) => cat.data?.types["VpnVhOption"]?.fields.find((x) => x.name === f)?.doc;
  const q = useRpc<Struct>(serverId, "GetSecureNATOption", { RpcHubName_str: hub });
  const [f, setF] = useState<Struct | null>(null);
  const [mac, setMac] = useState("");
  const [routes, setRoutes] = useState<Route[]>([]);
  const reset = () => {
    if (!q.data) return;
    setF({ ...q.data, DhcpDnsServerAddress_ip: emptyIp(q.data.DhcpDnsServerAddress_ip) ? "" : q.data.DhcpDnsServerAddress_ip, DhcpDnsServerAddress2_ip: emptyIp(q.data.DhcpDnsServerAddress2_ip) ? "" : q.data.DhcpDnsServerAddress2_ip, DhcpGatewayAddress_ip: emptyIp(q.data.DhcpGatewayAddress_ip) ? "" : q.data.DhcpGatewayAddress_ip });
    setMac(macFromB64(q.data.MacAddress_bin));
    setRoutes(parseRoutes(String(q.data.DhcpPushRoutes_str ?? "")));
  };
  useEffect(reset, [q.data]);
  const save = useRpcMutation(serverId, "SetSecureNATOption", { success: "SecureNAT settings saved" });
  const ro = !canWrite;
  if (!f) return <QueryState query={q}>{null}</QueryState>;
  const set = (p: Struct) => setF((s) => ({ ...s!, ...p }));

  const e: Record<string, string | undefined> = {};
  if (!macToB64(mac)) e.mac = "e.g. 5E-81-47-62-B3-55";
  const ipReq = (k: string) => { if (!isIPv4(String(f[k] ?? ""))) e[k] = "Invalid IPv4 address"; };
  const ipOpt = (k: string) => { if (f[k] && !isIPv4(String(f[k]))) e[k] = "Invalid IPv4 address"; };
  ipReq("Ip_ip");
  if (!normalizeMask4(String(f.Mask_ip ?? ""))) e.Mask_ip = "Invalid subnet mask";
  if (!(f.Mtu_u32 >= 64 && f.Mtu_u32 <= 1500)) e.Mtu_u32 = "64–1500";
  if (f.UseDhcp_bool) {
    ipReq("DhcpLeaseIPStart_ip"); ipReq("DhcpLeaseIPEnd_ip");
    if (!normalizeMask4(String(f.DhcpSubnetMask_ip ?? ""))) e.DhcpSubnetMask_ip = "Invalid subnet mask";
    ipOpt("DhcpGatewayAddress_ip"); ipOpt("DhcpDnsServerAddress_ip"); ipOpt("DhcpDnsServerAddress2_ip");
    if (!e.DhcpLeaseIPStart_ip && !e.DhcpLeaseIPEnd_ip) {
      const n = (s: string) => s.split(".").reduce((a, o) => a * 256 + Number(o), 0);
      if (n(f.DhcpLeaseIPEnd_ip) < n(f.DhcpLeaseIPStart_ip)) e.DhcpLeaseIPEnd_ip = "End must not be before start";
    }
    if (f.DhcpExpireTimeSpan_u32 < 1) e.DhcpExpireTimeSpan_u32 = "At least 1 second";
    if (f.ApplyDhcpPushRoutes_bool && routes.some((r) => Object.values(routeErrors(r)).some(Boolean))) e.routes = "Fix the invalid static routes";
  }
  const hasErr = Object.values(e).some(Boolean);

  const submit = () => {
    const p: Struct = {
      ...q.data, ...f, RpcHubName_str: hub, MacAddress_bin: macToB64(mac),
      Mask_ip: normalizeMask4(String(f.Mask_ip)), DhcpSubnetMask_ip: normalizeMask4(String(f.DhcpSubnetMask_ip)) ?? f.DhcpSubnetMask_ip,
      DhcpGatewayAddress_ip: f.DhcpGatewayAddress_ip || "0.0.0.0", DhcpDnsServerAddress_ip: f.DhcpDnsServerAddress_ip || "0.0.0.0",
      DhcpDnsServerAddress2_ip: f.DhcpDnsServerAddress2_ip || "0.0.0.0", DhcpPushRoutes_str: formatRoutes(routes),
    };
    save.mutate(p);
  };

  const ip = (k: string, label: string, placeholder?: string) => (
    <TextInput label={label} description={doc(k)} value={String(f[k] ?? "")} error={e[k]} readOnly={ro} ff="monospace" placeholder={placeholder}
      onChange={(ev) => set({ [k]: ev.currentTarget.value.trim() })} data-testid={`snat-${k}`} />
  );

  return (
    <form onSubmit={(ev) => { ev.preventDefault(); if (!hasErr) submit(); }} data-testid="securenat-form">
      <Section title="Virtual host" description="The SecureNAT virtual network interface on the hub's segment. Clients use its IP as gateway / DNS when Virtual NAT is on.">
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <TextInput label="MAC address" description={doc("MacAddress_bin")} value={mac} error={e.mac} readOnly={ro} ff="monospace" onChange={(ev) => setMac(ev.currentTarget.value)} data-testid="snat-mac" />
          {ip("Ip_ip", "IP address")}
          <TextInput label="Subnet mask" description={doc("Mask_ip")} value={String(f.Mask_ip ?? "")} error={e.Mask_ip} readOnly={ro} ff="monospace"
            onChange={(ev) => set({ Mask_ip: ev.currentTarget.value.trim() })} data-testid="snat-Mask_ip" />
        </SimpleGrid>
      </Section>

      <Section title="Virtual NAT" description="User-mode NAT that routes traffic from the virtual segment to the networks the VPN server can reach.">
        <Stack gap="sm">
          <Switch label="Enable Virtual NAT" description={doc("UseNat_bool")} checked={!!f.UseNat_bool} disabled={ro} onChange={(ev) => set({ UseNat_bool: ev.currentTarget.checked })} data-testid="snat-usenat" />
          <SimpleGrid cols={{ base: 1, sm: 3 }}>
            <NumberInput label="MTU" description={doc("Mtu_u32")} min={64} max={1500} allowDecimal={false} value={f.Mtu_u32} error={e.Mtu_u32} readOnly={ro} onChange={(v) => set({ Mtu_u32: Number(v) || 0 })} data-testid="snat-mtu" />
            <NumberInput label="TCP session timeout" suffix=" s" description={`${doc("NatTcpTimeout_u32")} (${duration(f.NatTcpTimeout_u32)})`} min={1} allowDecimal={false} value={f.NatTcpTimeout_u32} readOnly={ro} onChange={(v) => set({ NatTcpTimeout_u32: Number(v) || 0 })} />
            <NumberInput label="UDP session timeout" suffix=" s" description={`${doc("NatUdpTimeout_u32")} (${duration(f.NatUdpTimeout_u32)})`} min={1} allowDecimal={false} value={f.NatUdpTimeout_u32} readOnly={ro} onChange={(v) => set({ NatUdpTimeout_u32: Number(v) || 0 })} />
          </SimpleGrid>
          <Switch label="Save NAT and DHCP logs to the hub security log" description={doc("SaveLog_bool")} checked={!!f.SaveLog_bool} disabled={ro} onChange={(ev) => set({ SaveLog_bool: ev.currentTarget.checked })} />
        </Stack>
      </Section>

      <Section title="Virtual DHCP server" description="Hands out addresses to VPN clients on this hub. Disable it when a DHCP server already exists on a bridged LAN.">
        <Stack gap="sm">
          <Switch label="Enable Virtual DHCP server" description={doc("UseDhcp_bool")} checked={!!f.UseDhcp_bool} disabled={ro} onChange={(ev) => set({ UseDhcp_bool: ev.currentTarget.checked })} data-testid="snat-usedhcp" />
          {f.UseDhcp_bool && (
            <>
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                {ip("DhcpLeaseIPStart_ip", "Lease range start")}
                {ip("DhcpLeaseIPEnd_ip", "Lease range end")}
                <TextInput label="Subnet mask" description={doc("DhcpSubnetMask_ip")} value={String(f.DhcpSubnetMask_ip ?? "")} error={e.DhcpSubnetMask_ip} readOnly={ro} ff="monospace"
                  onChange={(ev) => set({ DhcpSubnetMask_ip: ev.currentTarget.value.trim() })} />
              </SimpleGrid>
              <NumberInput w={320} label="Lease time" suffix=" s" description={`${doc("DhcpExpireTimeSpan_u32")} (${duration(f.DhcpExpireTimeSpan_u32)})`} min={1} allowDecimal={false}
                value={f.DhcpExpireTimeSpan_u32} error={e.DhcpExpireTimeSpan_u32} readOnly={ro} onChange={(v) => set({ DhcpExpireTimeSpan_u32: Number(v) || 0 })} />
              <Divider label="Options pushed to clients" labelPosition="left" />
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                {ip("DhcpGatewayAddress_ip", "Default gateway", "none")}
                {ip("DhcpDnsServerAddress_ip", "Primary DNS server", "none")}
                {ip("DhcpDnsServerAddress2_ip", "Secondary DNS server", "none")}
              </SimpleGrid>
              <TextInput label="Domain name" description={doc("DhcpDomainName_str")} value={String(f.DhcpDomainName_str ?? "")} readOnly={ro}
                onChange={(ev) => set({ DhcpDomainName_str: ev.currentTarget.value })} />
              {!f.DhcpGatewayAddress_ip && <Alert variant="light" color="blue">No default gateway is pushed: clients keep their own default route (split tunnelling). Use static routes below for VPN-side networks.</Alert>}
              <Divider label="Classless static routes (RFC 3442)" labelPosition="left" />
              <Switch label="Push static routes" description={doc("ApplyDhcpPushRoutes_bool")} checked={!!f.ApplyDhcpPushRoutes_bool} disabled={ro}
                onChange={(ev) => set({ ApplyDhcpPushRoutes_bool: ev.currentTarget.checked })} data-testid="snat-apply-routes" />
              {f.ApplyDhcpPushRoutes_bool && (
                <>
                  <Text size="xs" c="dimmed">{doc("DhcpPushRoutes_str")}</Text>
                  <RoutesEditor routes={routes} onChange={setRoutes} readOnly={ro} />
                  {e.routes && <Text size="sm" c="red">{e.routes}</Text>}
                </>
              )}
            </>
          )}
        </Stack>
      </Section>
      {canWrite && (
        <Group justify="flex-end" mb="md">
          <Button variant="default" onClick={reset}>Revert</Button>
          <Button type="submit" loading={save.isPending} disabled={hasErr} data-testid="snat-save">Save settings</Button>
        </Group>
      )}
    </form>
  );
}

/* ------------------------------------------------------------------ page */

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card withBorder padding="sm" radius="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>{label}</Text>
      <Text size="xl" fw={700}>{value}</Text>
    </Card>
  );
}

export default function SecureNatPage() {
  const { serverId, hub = "" } = useScope();
  const role = useServer(serverId).data?.myRole;
  const canWrite = can(role, "operator");
  const hubStatus = useRpc<Struct>(serverId, "GetHubStatus", { HubName_str: hub });
  const enabled = !!hubStatus.data?.SecureNATEnabled_bool;
  const status = useRpc<Struct>(serverId, "GetSecureNATStatus", { HubName_str: hub }, { enabled, refetchInterval: 10_000 });
  const [tab, setTab] = useState<string | null>("settings");
  const nat = useRpc<{ NatTable?: NatItem[] }>(serverId, "EnumNAT", { HubName_str: hub }, { enabled: enabled && tab === "nat", refetchInterval: 10_000 });
  const dhcp = useRpc<{ DhcpTable?: DhcpItem[] }>(serverId, "EnumDHCP", { HubName_str: hub }, { enabled: enabled && tab === "dhcp", refetchInterval: 10_000 });
  const enable = useRpcMutation(serverId, "EnableSecureNAT", { success: "SecureNAT enabled" });
  const disable = useRpcMutation(serverId, "DisableSecureNAT", { success: "SecureNAT disabled" });

  return (
    <>
      <PageHeader
        title="SecureNAT"
        description="Built-in virtual NAT router and DHCP server for the Virtual Hub. Lets VPN clients reach networks via the VPN server without a physical bridge or administrator rights on the host."
        badge={hubStatus.data ? <Badge color={enabled ? "green" : "gray"} variant="light" data-testid="securenat-state">{enabled ? "Enabled" : "Disabled"}</Badge> : null}
        actions={<>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => { void hubStatus.refetch(); if (enabled) void status.refetch(); }} loading={hubStatus.isFetching}>Refresh</Button>
          {canWrite && hubStatus.data && (enabled ? (
            <ConfirmButton size="sm" variant="filled" title="Disable SecureNAT?" confirmLabel="Disable" leftSection={<IconPlayerStop size={16} />}
              message="All NAT sessions are dropped and the virtual DHCP server stops; clients relying on it lose connectivity when their lease expires. Settings are kept."
              onConfirm={() => disable.mutateAsync({ HubName_str: hub })}>
              <span data-testid="securenat-disable">Disable SecureNAT</span>
            </ConfirmButton>
          ) : (
            <ConfirmButton size="sm" variant="filled" color="green" title="Enable SecureNAT?" confirmLabel="Enable" leftSection={<IconPlayerPlay size={16} />}
              message="The virtual host, NAT and DHCP server start on this hub's segment using the settings below. Do not enable the DHCP server if the hub is bridged to a LAN that already has one."
              onConfirm={() => enable.mutateAsync({ HubName_str: hub })}>
              <span data-testid="securenat-enable">Enable SecureNAT</span>
            </ConfirmButton>
          ))}
        </>}
      />
      {!canWrite && role && <ReadOnlyNotice role={role} />}
      {hubStatus.error ? <ErrorAlert error={hubStatus.error} /> : null}
      {enabled && (
        status.error ? <ErrorAlert error={status.error} /> : (
          <SimpleGrid cols={{ base: 2, sm: 4, lg: 7 }} mb="md" data-testid="securenat-status">
            <Stat label="TCP sessions" value={num(status.data?.NumTcpSessions_u32)} />
            <Stat label="UDP sessions" value={num(status.data?.NumUdpSessions_u32)} />
            <Stat label="ICMP sessions" value={num(status.data?.NumIcmpSessions_u32)} />
            <Stat label="DNS sessions" value={num(status.data?.NumDnsSessions_u32)} />
            <Stat label="DHCP clients" value={num(status.data?.NumDhcpClients_u32)} />
            <Stat label="Kernel mode" value={status.data ? (status.data.IsKernelMode_bool ? "Yes" : "No") : "–"} />
            <Stat label="Raw IP mode" value={status.data ? (status.data.IsRawIpMode_bool ? "Yes" : "No") : "–"} />
          </SimpleGrid>
        )
      )}
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List mb="md">
          <Tabs.Tab value="settings">Settings</Tabs.Tab>
          <Tabs.Tab value="nat" disabled={!enabled}>NAT sessions</Tabs.Tab>
          <Tabs.Tab value="dhcp" disabled={!enabled}>DHCP leases</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="settings">
          <OptionsForm serverId={serverId} hub={hub} canWrite={canWrite} />
        </Tabs.Panel>
        <Tabs.Panel value="nat">
          <QueryState query={nat}>
            <DataTable
              testId="nat-table"
              data={nat.data?.NatTable}
              rowKey={(r) => r.Id_u32}
              initialSort={{ key: "LastCommTime_dt", dir: "desc" }}
              empty="No NAT sessions"
              toolbar={<Button size="sm" variant="default" leftSection={<IconRefresh size={14} />} onClick={() => nat.refetch()} loading={nat.isFetching}>Refresh</Button>}
              columns={[
                { key: "Id_u32", title: "ID", align: "right" },
                { key: "Protocol_u32", title: "Protocol", value: (r) => NAT_PROTO[r.Protocol_u32] ?? r.Protocol_u32, render: (r) => <Badge variant="light">{NAT_PROTO[r.Protocol_u32] ?? r.Protocol_u32}</Badge> },
                { key: "src", title: "Source", value: (r) => `${r.SrcIp_ip}:${r.SrcPort_u32} ${r.SrcHost_str}`, render: (r) => (
                  <Stack gap={0}><Text size="sm" ff="monospace">{r.SrcIp_ip}{r.SrcPort_u32 ? `:${r.SrcPort_u32}` : ""}</Text>{r.SrcHost_str && <Text size="xs" c="dimmed">{r.SrcHost_str}</Text>}</Stack>
                ) },
                { key: "dst", title: "Destination", value: (r) => `${r.DestIp_ip}:${r.DestPort_u32} ${r.DestHost_str}`, render: (r) => (
                  <Stack gap={0}><Text size="sm" ff="monospace">{r.DestIp_ip}{r.DestPort_u32 ? `:${r.DestPort_u32}` : ""}</Text>{r.DestHost_str && <Text size="xs" c="dimmed">{r.DestHost_str}</Text>}</Stack>
                ) },
                { key: "TcpStatus_u32", title: "TCP state", value: (r) => (r.Protocol_u32 === 0 ? TCP_STATE[r.TcpStatus_u32]?.label : ""),
                  render: (r) => (r.Protocol_u32 === 0 ? <Badge size="sm" variant="outline" color={TCP_STATE[r.TcpStatus_u32]?.color}>{TCP_STATE[r.TcpStatus_u32]?.label ?? r.TcpStatus_u32}</Badge> : "–") },
                { key: "SendSize_u64", title: "Sent", align: "right", render: (r) => bytes(r.SendSize_u64) },
                { key: "RecvSize_u64", title: "Received", align: "right", render: (r) => bytes(r.RecvSize_u64) },
                { key: "CreatedTime_dt", title: "Created", render: (r) => <Tooltip label={dt(r.CreatedTime_dt)}><span>{ago(r.CreatedTime_dt)}</span></Tooltip> },
                { key: "LastCommTime_dt", title: "Last activity", render: (r) => <Tooltip label={dt(r.LastCommTime_dt)}><span>{ago(r.LastCommTime_dt)}</span></Tooltip> },
              ]}
            />
          </QueryState>
        </Tabs.Panel>
        <Tabs.Panel value="dhcp">
          <QueryState query={dhcp}>
            <DataTable
              testId="dhcp-table"
              data={dhcp.data?.DhcpTable}
              rowKey={(r) => r.Id_u32}
              initialSort={{ key: "IpAddress_ip", dir: "asc" }}
              empty="No DHCP leases"
              toolbar={<Button size="sm" variant="default" leftSection={<IconRefresh size={14} />} onClick={() => dhcp.refetch()} loading={dhcp.isFetching}>Refresh</Button>}
              columns={[
                { key: "IpAddress_ip", title: "IP address", render: (r) => <Text size="sm" ff="monospace">{r.IpAddress_ip}</Text> },
                { key: "Mask_u32", title: "Mask", render: (r) => <Text size="sm" ff="monospace">{maskU32(r.Mask_u32)}</Text> },
                { key: "MacAddress_bin", title: "MAC address", value: (r) => macFromB64(r.MacAddress_bin), render: (r) => <Text size="sm" ff="monospace">{macFromB64(r.MacAddress_bin)}</Text> },
                { key: "Hostname_str", title: "Host name" },
                { key: "LeasedTime_dt", title: "Leased", render: (r) => <Tooltip label={dt(r.LeasedTime_dt)}><span>{ago(r.LeasedTime_dt)}</span></Tooltip> },
                { key: "ExpireTime_dt", title: "Expires", render: (r) => <Tooltip label={dt(r.ExpireTime_dt)}><span>{ago(r.ExpireTime_dt)}</span></Tooltip> },
              ]}
            />
          </QueryState>
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
