// Hub › SecureNAT: the hub's built-in virtual NAT router and DHCP server.
// Ported from apps/web/src/pages/hub/SecureNat.tsx: GetHubStatus (enabled flag), Enable/DisableSecureNAT,
// Get/SetSecureNATOption (same validation, MAC and mask normalisation, RFC 3442 push routes), GetSecureNATStatus,
// EnumNAT and EnumDHCP. Redesigned: metric strip, a segmented Settings / NAT Sessions / DHCP Leases switcher,
// System Settings style form groups with a sticky save bar, and dense tables with copy context menus.
import { useEffect, useMemo, useState } from "react";
import { ActionIcon, Button, NumberInput, Switch, TextInput, Tooltip } from "@mantine/core";
import { IconCopy, IconNetwork, IconPlayerPlay, IconPlayerStop, IconPlus, IconTrash } from "@tabler/icons-react";
import { agoShort, bytes, dt, num } from "../../lib/format";
import { notifyError, notifySuccess, useRpc, useRpcMutation } from "../../lib/hooks";
import {
  ConfirmButton, DataTable, ErrorState, FormRow, FormSection, Metric, MetricGrid, MetricSkeleton, Mono, PageHeader, PropertySkeleton, StatusBadge, Tag, type TagColor,
} from "../../design";
import { isIPv4, macFromB64, macToB64, normalizeMask4 } from "../../components/domain/util";
import { useDocs } from "../../components/domain/hooks";
import { Callout, HelpLabel, SaveBar } from "../../components/domain/ui";
import { Fields, Unreachable, useHubPage, ViewSwitcher } from "./_hub-policy-network/shared";

type Struct = Record<string, any>;
interface NatItem { Id_u32: number; Protocol_u32: number; SrcIp_ip: string; SrcHost_str: string; SrcPort_u32: number; DestIp_ip: string; DestHost_str: string; DestPort_u32: number; CreatedTime_dt: string; LastCommTime_dt: string; SendSize_u64: number; RecvSize_u64: number; TcpStatus_u32: number }
interface DhcpItem { Id_u32: number; LeasedTime_dt: string; ExpireTime_dt: string; MacAddress_bin: string; IpAddress_ip: string; Mask_u32: number; Hostname_str: string }

const NAT_PROTO: Record<number, string> = { 0: "TCP", 1: "UDP", 2: "DNS", 3: "ICMP" };
const TCP_STATE: Record<number, { label: string; color: TagColor }> = {
  0: { label: "Connecting", color: "yellow" }, 1: { label: "Sending RST", color: "red" }, 2: { label: "Connected", color: "accent" },
  3: { label: "Established", color: "green" }, 4: { label: "Closing", color: "gray" },
};

/** Mask_u32 is the in-memory (network-order) address read as a little-endian integer. */
function maskU32(n: number) {
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join(".");
}

/** Seconds as words for field descriptions: "30 minutes", "2 hours", "1 day 6 hours". */
function secs(v: number | undefined) {
  const n = Number(v ?? 0);
  if (!n) return "0 seconds";
  const parts: [number, string][] = [[Math.floor(n / 86400), "day"], [Math.floor((n % 86400) / 3600), "hour"], [Math.floor((n % 3600) / 60), "minute"], [n % 60, "second"]];
  return parts.filter(([x]) => x).slice(0, 2).map(([x, u]) => `${num(x)} ${u}${x === 1 ? "" : "s"}`).join(" ");
}
const emptyIp = (v: unknown) => !v || v === "::" || v === "0.0.0.0";
const unit = (u: string) => ({ rightSection: <span className="sem-input-unit">{u}</span>, rightSectionWidth: 30 });

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
    net: isIPv4(r.net) ? undefined : "Enter a network address.",
    mask: normalizeMask4(r.mask) ? undefined : "Mask or prefix length.",
    gw: isIPv4(r.gw) ? undefined : "Enter a gateway address.",
  };
}

function RoutesEditor({ routes, onChange }: { routes: Route[]; onChange: (r: Route[]) => void }) {
  const upd = (i: number, p: Partial<Route>) => onChange(routes.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <div className="hpn-routes" data-testid="dhcp-routes-editor">
      {routes.length > 0 && (
        <>
          <div className="hpn-routes-head"><span>Network</span><span>Subnet mask</span><span>Gateway</span><span /></div>
          {routes.map((r, i) => {
            const e = routeErrors(r);
            return (
              <div className="hpn-routes-row" key={i} data-testid="dhcp-route-row">
                <TextInput ff="monospace" aria-label={`Route ${i + 1} network`} placeholder="192.168.5.0" value={r.net} error={r.net && e.net} onChange={(ev) => upd(i, { net: ev.currentTarget.value })} data-testid={`dhcp-route-net-${i}`} />
                <TextInput ff="monospace" aria-label={`Route ${i + 1} mask`} placeholder="255.255.255.0 or 24" value={r.mask} error={r.mask && e.mask} onChange={(ev) => upd(i, { mask: ev.currentTarget.value })} data-testid={`dhcp-route-mask-${i}`} />
                <TextInput ff="monospace" aria-label={`Route ${i + 1} gateway`} placeholder="192.168.30.254" value={r.gw} error={r.gw && e.gw} onChange={(ev) => upd(i, { gw: ev.currentTarget.value })} data-testid={`dhcp-route-gw-${i}`} />
                <Tooltip label="Remove route" openDelay={400}>
                  <ActionIcon variant="subtle" color="gray" mt={2} onClick={() => onChange(routes.filter((_, j) => j !== i))} aria-label={`Remove route ${i + 1}`}><IconTrash size={14} /></ActionIcon>
                </Tooltip>
              </div>
            );
          })}
        </>
      )}
      <div className="hpn-routes-foot">
        <Button size="xs" variant="default" leftSection={<IconPlus size={13} />} disabled={routes.length >= 64}
          onClick={() => onChange([...routes, { net: "", mask: "255.255.255.0", gw: "" }])} data-testid="dhcp-route-add">Add Route</Button>
        <span className="hpn-routes-preview">Sent as <Mono>{formatRoutes(routes) || "nothing"}</Mono> · up to 64 routes</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ settings */

function normalizeOption(d: Struct): Struct {
  return {
    ...d,
    DhcpDnsServerAddress_ip: emptyIp(d.DhcpDnsServerAddress_ip) ? "" : d.DhcpDnsServerAddress_ip,
    DhcpDnsServerAddress2_ip: emptyIp(d.DhcpDnsServerAddress2_ip) ? "" : d.DhcpDnsServerAddress2_ip,
    DhcpGatewayAddress_ip: emptyIp(d.DhcpGatewayAddress_ip) ? "" : d.DhcpGatewayAddress_ip,
  };
}

function SettingsForm({ serverId, hub }: { serverId: number; hub: string }) {
  const doc = useDocs("VpnVhOption");
  const q = useRpc<Struct>(serverId, "GetSecureNATOption", { RpcHubName_str: hub });
  const [f, setF] = useState<Struct | null>(null);
  const [mac, setMac] = useState("");
  const [routes, setRoutes] = useState<Route[]>([]);
  const base = useMemo(() => (q.data ? { f: normalizeOption(q.data), mac: macFromB64(q.data.MacAddress_bin), routes: parseRoutes(String(q.data.DhcpPushRoutes_str ?? "")) } : null), [q.data]);
  const reset = () => { if (!base) return; setF(base.f); setMac(base.mac); setRoutes(base.routes); };
  useEffect(reset, [base]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useRpcMutation(serverId, "SetSecureNATOption", { success: "SecureNAT settings saved" });

  if (q.error && !q.data) return <div className="hpn-block"><ErrorState error={q.error} onRetry={() => void q.refetch()} serverId={serverId} inline testId="snat-settings-error" /></div>;
  if (!f || !base) return <div className="hpn-block"><PropertySkeleton rows={8} /></div>;
  const set = (p: Struct) => setF((s) => ({ ...s!, ...p }));
  const dirty = JSON.stringify({ f, mac, r: formatRoutes(routes) }) !== JSON.stringify({ f: base.f, mac: base.mac, r: formatRoutes(base.routes) });

  const e: Record<string, string | undefined> = {};
  if (!macToB64(mac)) e.mac = "For example 5E-81-47-62-B3-55.";
  const ipReq = (k: string) => { if (!isIPv4(String(f[k] ?? ""))) e[k] = "Enter an IPv4 address."; };
  const ipOpt = (k: string) => { if (f[k] && !isIPv4(String(f[k]))) e[k] = "Enter an IPv4 address, or leave empty."; };
  ipReq("Ip_ip");
  if (!normalizeMask4(String(f.Mask_ip ?? ""))) e.Mask_ip = "Enter a subnet mask.";
  if (!(f.Mtu_u32 >= 64 && f.Mtu_u32 <= 1500)) e.Mtu_u32 = "64–1500";
  if (f.UseDhcp_bool) {
    ipReq("DhcpLeaseIPStart_ip"); ipReq("DhcpLeaseIPEnd_ip");
    if (!normalizeMask4(String(f.DhcpSubnetMask_ip ?? ""))) e.DhcpSubnetMask_ip = "Enter a subnet mask.";
    ipOpt("DhcpGatewayAddress_ip"); ipOpt("DhcpDnsServerAddress_ip"); ipOpt("DhcpDnsServerAddress2_ip");
    if (!e.DhcpLeaseIPStart_ip && !e.DhcpLeaseIPEnd_ip) {
      const n = (s: string) => s.split(".").reduce((a, o) => a * 256 + Number(o), 0);
      if (n(f.DhcpLeaseIPEnd_ip) < n(f.DhcpLeaseIPStart_ip)) e.DhcpLeaseIPEnd_ip = "Must not be before the first address.";
    }
    if (f.DhcpExpireTimeSpan_u32 < 1) e.DhcpExpireTimeSpan_u32 = "At least 1 second.";
    if (f.ApplyDhcpPushRoutes_bool && routes.some((r) => Object.values(routeErrors(r)).some(Boolean))) e.routes = "Fix the highlighted static routes.";
  }
  const errList = Object.values(e).filter(Boolean) as string[];

  const submit = () => {
    if (errList.length) return;
    const p: Struct = {
      ...q.data, ...f, RpcHubName_str: hub, MacAddress_bin: macToB64(mac),
      Mask_ip: normalizeMask4(String(f.Mask_ip)), DhcpSubnetMask_ip: normalizeMask4(String(f.DhcpSubnetMask_ip)) ?? f.DhcpSubnetMask_ip,
      DhcpGatewayAddress_ip: f.DhcpGatewayAddress_ip || "0.0.0.0", DhcpDnsServerAddress_ip: f.DhcpDnsServerAddress_ip || "0.0.0.0",
      DhcpDnsServerAddress2_ip: f.DhcpDnsServerAddress2_ip || "0.0.0.0", DhcpPushRoutes_str: formatRoutes(routes),
    };
    save.mutate(p);
  };

  const ip = (k: string, label: string, placeholder?: string, w = 180) => (
    <TextInput aria-label={label} w={w} value={String(f[k] ?? "")} error={e[k]} ff="monospace" placeholder={placeholder}
      onChange={(ev) => set({ [k]: ev.currentTarget.value.trim() })} data-testid={`snat-${k}`} />
  );

  return (
    <form onSubmit={(ev) => { ev.preventDefault(); submit(); }} data-testid="securenat-form">
      <FormSection title="Virtual host" description="SecureNAT’s network interface on the hub. With Virtual NAT on, clients use its address as their gateway and DNS server.">
        <FormRow label={<HelpLabel label="MAC address" doc={doc("MacAddress_bin")} />}>
          {(id) => <TextInput id={id} w={200} value={mac} error={e.mac} ff="monospace" onChange={(ev) => setMac(ev.currentTarget.value)} data-testid="snat-mac" />}
        </FormRow>
        <FormRow label={<HelpLabel label="IP address and mask" doc={doc("Ip_ip")} />} align="start">
          <Fields cols="180px 180px">
            {ip("Ip_ip", "IP address")}
            <TextInput aria-label="Subnet mask" value={String(f.Mask_ip ?? "")} error={e.Mask_ip} ff="monospace"
              onChange={(ev) => set({ Mask_ip: ev.currentTarget.value.trim() })} data-testid="snat-Mask_ip" />
          </Fields>
        </FormRow>
      </FormSection>

      <FormSection title="Virtual NAT" description="User-mode NAT that routes traffic from the hub to the networks the VPN server can reach.">
        <FormRow label={<HelpLabel label="Enable Virtual NAT" doc={doc("UseNat_bool")} />}>
          <Switch checked={!!f.UseNat_bool} aria-label="Enable Virtual NAT" onChange={(ev) => set({ UseNat_bool: ev.currentTarget.checked })} data-testid="snat-usenat" />
        </FormRow>
        <FormRow label={<HelpLabel label="MTU" doc={doc("Mtu_u32")} />} description="64 to 1500 bytes.">
          {(id) => <NumberInput id={id} w={120} min={64} max={1500} allowDecimal={false} allowNegative={false} value={f.Mtu_u32} error={e.Mtu_u32}
            onChange={(v) => set({ Mtu_u32: Number(v) || 0 })} data-testid="snat-mtu" />}
        </FormRow>
        <FormRow label={<HelpLabel label="TCP session timeout" doc={doc("NatTcpTimeout_u32")} />} description={secs(f.NatTcpTimeout_u32)}>
          {(id) => <NumberInput id={id} w={120} min={1} allowDecimal={false} allowNegative={false} value={f.NatTcpTimeout_u32} {...unit("s")}
            onChange={(v) => set({ NatTcpTimeout_u32: Number(v) || 0 })} data-testid="snat-tcp-timeout" />}
        </FormRow>
        <FormRow label={<HelpLabel label="UDP session timeout" doc={doc("NatUdpTimeout_u32")} />} description={secs(f.NatUdpTimeout_u32)}>
          {(id) => <NumberInput id={id} w={120} min={1} allowDecimal={false} allowNegative={false} value={f.NatUdpTimeout_u32} {...unit("s")}
            onChange={(v) => set({ NatUdpTimeout_u32: Number(v) || 0 })} data-testid="snat-udp-timeout" />}
        </FormRow>
        <FormRow label={<HelpLabel label="Log NAT and DHCP" doc={doc("SaveLog_bool")} />} description="Write NAT and DHCP events to the hub’s security log.">
          <Switch checked={!!f.SaveLog_bool} aria-label="Log NAT and DHCP" onChange={(ev) => set({ SaveLog_bool: ev.currentTarget.checked })} data-testid="snat-savelog" />
        </FormRow>
      </FormSection>

      <FormSection title="Virtual DHCP server" description="Hands out addresses to VPN clients. Turn it off if a bridged LAN already has a DHCP server.">
        <FormRow label={<HelpLabel label="Enable DHCP server" doc={doc("UseDhcp_bool")} />}>
          <Switch checked={!!f.UseDhcp_bool} aria-label="Enable DHCP server" onChange={(ev) => set({ UseDhcp_bool: ev.currentTarget.checked })} data-testid="snat-usedhcp" />
        </FormRow>
        {f.UseDhcp_bool && (
          <>
            <FormRow label="Address range" align="start">
              <div className="hpn-range" data-fixed style={{ alignItems: "flex-start" }}>
                {ip("DhcpLeaseIPStart_ip", "First address", undefined, 170)}
                <span className="hpn-range-sep" style={{ marginTop: 5 }}>to</span>
                {ip("DhcpLeaseIPEnd_ip", "Last address", undefined, 170)}
              </div>
            </FormRow>
            <FormRow label={<HelpLabel label="Subnet mask" doc={doc("DhcpSubnetMask_ip")} />}>
              {(id) => <TextInput id={id} w={180} value={String(f.DhcpSubnetMask_ip ?? "")} error={e.DhcpSubnetMask_ip} ff="monospace"
                onChange={(ev) => set({ DhcpSubnetMask_ip: ev.currentTarget.value.trim() })} data-testid="snat-DhcpSubnetMask_ip" />}
            </FormRow>
            <FormRow label={<HelpLabel label="Lease time" doc={doc("DhcpExpireTimeSpan_u32")} />} description={secs(f.DhcpExpireTimeSpan_u32)}>
              {(id) => <NumberInput id={id} w={130} min={1} allowDecimal={false} allowNegative={false} value={f.DhcpExpireTimeSpan_u32} error={e.DhcpExpireTimeSpan_u32} {...unit("s")}
                onChange={(v) => set({ DhcpExpireTimeSpan_u32: Number(v) || 0 })} data-testid="snat-lease" />}
            </FormRow>
          </>
        )}
      </FormSection>

      {f.UseDhcp_bool && (
        <FormSection title="Options sent to clients" footer={!f.DhcpGatewayAddress_ip ? "No default gateway is sent: clients keep their own default route (split tunnelling). Use static routes for networks behind the VPN." : undefined}>
          <FormRow label={<HelpLabel label="Default gateway" doc={doc("DhcpGatewayAddress_ip")} />} description="Leave empty to send none.">
            {ip("DhcpGatewayAddress_ip", "Default gateway", "None")}
          </FormRow>
          <FormRow label={<HelpLabel label="DNS servers" doc={doc("DhcpDnsServerAddress_ip")} />} description="Primary and secondary." align="start">
            <Fields cols="180px 180px">
              {ip("DhcpDnsServerAddress_ip", "Primary DNS server", "None")}
              {ip("DhcpDnsServerAddress2_ip", "Secondary DNS server", "None")}
            </Fields>
          </FormRow>
          <FormRow label={<HelpLabel label="Domain name" doc={doc("DhcpDomainName_str")} />}>
            {(id) => <TextInput id={id} w={260} placeholder="corp.example.com" value={String(f.DhcpDomainName_str ?? "")} onChange={(ev) => set({ DhcpDomainName_str: ev.currentTarget.value })} data-testid="snat-domain" />}
          </FormRow>
          <FormRow label={<HelpLabel label="Static routes" doc={doc("ApplyDhcpPushRoutes_bool")} />} description="Classless static routes (RFC 3442) pushed with the lease.">
            <Switch checked={!!f.ApplyDhcpPushRoutes_bool} aria-label="Push static routes" onChange={(ev) => set({ ApplyDhcpPushRoutes_bool: ev.currentTarget.checked })} data-testid="snat-apply-routes" />
          </FormRow>
          {f.ApplyDhcpPushRoutes_bool && (
            <FormRow label="Routes" stacked error={e.routes}>
              <RoutesEditor routes={routes} onChange={setRoutes} />
            </FormRow>
          )}
        </FormSection>
      )}
      <SaveBar dirty={dirty} saving={save.isPending} onReset={reset} onSave={submit} disabled={errList.length > 0} saveLabel="Save Settings" testId="snat-save"
        note={errList.length ? <span className="sem-text-red">{errList[0]}</span> : undefined} />
    </form>
  );
}

/* ------------------------------------------------------------------ page */

type View = "settings" | "nat" | "dhcp";

export default function SecureNatPage() {
  const { serverId, hub, server, reachable } = useHubPage();
  const hubStatus = useRpc<Struct>(serverId, "GetHubStatus", { HubName_str: hub }, { enabled: reachable });
  const enabled = !!hubStatus.data?.SecureNATEnabled_bool;
  const status = useRpc<Struct>(serverId, "GetSecureNATStatus", { HubName_str: hub }, { enabled: reachable && enabled, refetchInterval: 10_000 });
  const [view, setView] = useState<View>("settings");
  const nat = useRpc<{ NatTable?: NatItem[] }>(serverId, "EnumNAT", { HubName_str: hub }, { enabled: reachable && enabled && view === "nat", refetchInterval: 10_000 });
  const dhcp = useRpc<{ DhcpTable?: DhcpItem[] }>(serverId, "EnumDHCP", { HubName_str: hub }, { enabled: reachable && enabled && view === "dhcp", refetchInterval: 10_000 });
  const enable = useRpcMutation(serverId, "EnableSecureNAT", { success: "SecureNAT is on" });
  const disable = useRpcMutation(serverId, "DisableSecureNAT", { success: "SecureNAT is off" });
  useEffect(() => { if (hubStatus.data && !enabled && view !== "settings") setView("settings"); }, [hubStatus.data, enabled, view]);

  if (server && !reachable) return <><PageHeader title="SecureNAT" /><Unreachable server={server} /></>;
  const st = status.data;
  const copy = (text: string, what: string) => {
    navigator.clipboard.writeText(text).then(() => notifySuccess(`${what} copied`), (e) => notifyError(e, `Couldn’t copy the ${what.toLowerCase()}`));
  };
  const hostPort = (ip: string, port: number) => (port ? `${ip}:${port}` : ip);
  const mode = st ? (st.IsKernelMode_bool ? "Kernel mode" : st.IsRawIpMode_bool ? "Raw IP mode" : "User mode") : "–";

  return (
    <>
      <PageHeader
        title="SecureNAT"
        badge={hubStatus.data ? <StatusBadge status={enabled ? "ok" : "off"} testId="securenat-state">{enabled ? "On" : "Off"}</StatusBadge> : null}
        description="Built-in virtual NAT router and DHCP server. VPN clients reach the networks the server can reach, without a bridge or administrator rights on the host."
        actions={hubStatus.data && (enabled ? (
          <ConfirmButton title="Turn off SecureNAT?" confirmLabel="Turn Off" leftSection={<IconPlayerStop size={14} />} testId="securenat-disable"
            message="All NAT sessions are dropped and the DHCP server stops. Clients that rely on it lose connectivity when their lease runs out. The settings are kept."
            onConfirm={() => disable.mutateAsync({ HubName_str: hub })}>
            Turn Off SecureNAT
          </ConfirmButton>
        ) : (
          <ConfirmButton variant="filled" color="blue" tone="warning" title="Turn on SecureNAT?" confirmLabel="Turn On" leftSection={<IconPlayerPlay size={14} />} testId="securenat-enable"
            message="The virtual host, NAT and DHCP server start on this hub with the settings below. Don’t use the DHCP server if the hub is bridged to a LAN that already has one."
            onConfirm={() => enable.mutateAsync({ HubName_str: hub })}>
            Turn On SecureNAT
          </ConfirmButton>
        ))}
      />
      {hubStatus.error && !hubStatus.data ? <ErrorState error={hubStatus.error} onRetry={() => void hubStatus.refetch()} serverId={serverId} inline testId="snat-hubstatus-error" /> : null}
      {enabled && (status.error && !st ? <ErrorState error={status.error} onRetry={() => void status.refetch()} serverId={serverId} inline testId="snat-status-error" /> : !st ? <MetricSkeleton count={6} /> : (
        <MetricGrid testId="securenat-status" min={118}>
          <Metric label="TCP sessions" value={num(st.NumTcpSessions_u32)} testId="snat-stat-tcp" />
          <Metric label="UDP sessions" value={num(st.NumUdpSessions_u32)} />
          <Metric label="ICMP sessions" value={num(st.NumIcmpSessions_u32)} />
          <Metric label="DNS sessions" value={num(st.NumDnsSessions_u32)} />
          <Metric label="DHCP clients" value={num(st.NumDhcpClients_u32)} testId="snat-stat-dhcp" onClick={() => setView("dhcp")} />
          <Metric label="NAT engine" value={<span style={{ fontSize: "var(--sem-fz-headline)" }}>{mode}</span>} />
        </MetricGrid>
      ))}
      {!enabled && hubStatus.data && (
        <div className="hpn-block">
          <Callout tone="gray" icon={<IconNetwork size={16} stroke={1.7} />} testId="securenat-off-note">
            SecureNAT is off. You can prepare its settings now; they take effect when you turn it on.
          </Callout>
        </div>
      )}
      <div className="hpn-block">
        <ViewSwitcher<View>
          value={view} onChange={setView} testId="securenat-view"
          items={[
            { value: "settings", label: "Settings", testId: "snat-tab-settings" },
            { value: "nat", label: <>NAT Sessions{st ? <span className="hpn-seg-count"> {num(Number(st.NumTcpSessions_u32 ?? 0) + Number(st.NumUdpSessions_u32 ?? 0) + Number(st.NumIcmpSessions_u32 ?? 0) + Number(st.NumDnsSessions_u32 ?? 0))}</span> : null}</>, disabled: !enabled, testId: "snat-tab-nat" },
            { value: "dhcp", label: <>DHCP Leases{st ? <span className="hpn-seg-count"> {num(st.NumDhcpClients_u32)}</span> : null}</>, disabled: !enabled, testId: "snat-tab-dhcp" },
          ]}
        />
      </div>

      {/* Kept mounted (hidden) so unsaved edits survive a look at NAT Sessions / DHCP Leases, as the web tabs did. */}
      <div hidden={view !== "settings"} data-testid="snat-settings-view"><SettingsForm serverId={serverId} hub={hub} /></div>

      {view === "nat" && (
        <div className="hpn-block">
          <DataTable
            testId="nat-table"
            aria-label="NAT sessions"
            data={nat.data?.NatTable}
            loading={nat.isLoading}
            error={nat.error}
            onRetry={() => void nat.refetch()}
            rowKey={(r) => r.Id_u32}
            selectable="single"
            initialSort={{ key: "LastCommTime_dt", dir: "desc" }}
            searchPlaceholder="Filter sessions"
            empty={{ title: "No NAT sessions", description: "Sessions appear here while VPN clients use SecureNAT to reach other networks.", icon: <IconNetwork size={28} stroke={1.4} /> }}
            contextMenu={(r) => [
              { label: "Copy Source", icon: <IconCopy size={14} />, onClick: () => copy(hostPort(r.SrcIp_ip, r.SrcPort_u32), "Source") },
              { label: "Copy Destination", icon: <IconCopy size={14} />, onClick: () => copy(hostPort(r.DestIp_ip, r.DestPort_u32), "Destination") },
            ]}
            columns={[
              { key: "Id_u32", title: "ID", align: "right", width: 60 },
              { key: "Protocol_u32", title: "Protocol", width: 84, value: (r) => NAT_PROTO[r.Protocol_u32] ?? r.Protocol_u32, render: (r) => <Tag>{NAT_PROTO[r.Protocol_u32] ?? r.Protocol_u32}</Tag> },
              {
                key: "src", title: "Source", value: (r) => `${r.SrcIp_ip}:${r.SrcPort_u32} ${r.SrcHost_str}`,
                render: (r) => <span title={r.SrcHost_str || undefined}><Mono>{r.SrcIp_ip}{r.SrcPort_u32 ? `:${r.SrcPort_u32}` : ""}</Mono>{r.SrcHost_str && <span className="sem-dim"> · {r.SrcHost_str}</span>}</span>,
              },
              {
                key: "dst", title: "Destination", value: (r) => `${r.DestIp_ip}:${r.DestPort_u32} ${r.DestHost_str}`,
                render: (r) => <span title={r.DestHost_str || undefined}><Mono>{r.DestIp_ip}{r.DestPort_u32 ? `:${r.DestPort_u32}` : ""}</Mono>{r.DestHost_str && <span className="sem-dim"> · {r.DestHost_str}</span>}</span>,
              },
              {
                key: "TcpStatus_u32", title: "TCP state", width: 110, value: (r) => (r.Protocol_u32 === 0 ? TCP_STATE[r.TcpStatus_u32]?.label : ""),
                render: (r) => (r.Protocol_u32 === 0 ? <Tag color={TCP_STATE[r.TcpStatus_u32]?.color ?? "gray"}>{TCP_STATE[r.TcpStatus_u32]?.label ?? r.TcpStatus_u32}</Tag> : <span className="sem-dim">–</span>),
              },
              { key: "SendSize_u64", title: "Sent", align: "right", width: 86, render: (r) => bytes(r.SendSize_u64) },
              { key: "RecvSize_u64", title: "Received", align: "right", width: 86, render: (r) => bytes(r.RecvSize_u64) },
              { key: "CreatedTime_dt", title: "Created", width: 96, render: (r) => <span className="sem-dim" title={dt(r.CreatedTime_dt)}>{agoShort(r.CreatedTime_dt)}</span> },
              { key: "LastCommTime_dt", title: "Last activity", width: 104, render: (r) => <span className="sem-dim" title={dt(r.LastCommTime_dt)}>{agoShort(r.LastCommTime_dt)}</span> },
            ]}
          />
        </div>
      )}

      {view === "dhcp" && (
        <div className="hpn-block">
          <DataTable
            testId="dhcp-table"
            aria-label="DHCP leases"
            data={dhcp.data?.DhcpTable}
            loading={dhcp.isLoading}
            error={dhcp.error}
            onRetry={() => void dhcp.refetch()}
            rowKey={(r) => r.Id_u32}
            selectable="single"
            initialSort={{ key: "IpAddress_ip", dir: "asc" }}
            searchPlaceholder="Filter leases"
            filterFn={(r, needle) => [r.IpAddress_ip, maskU32(r.Mask_u32), macFromB64(r.MacAddress_bin), r.Hostname_str ?? ""].some((x) => x.toLowerCase().includes(needle))}
            empty={{ title: "No DHCP leases", description: "Clients that get an address from the virtual DHCP server are listed here.", icon: <IconNetwork size={28} stroke={1.4} /> }}
            contextMenu={(r) => [
              { label: "Copy IP Address", icon: <IconCopy size={14} />, onClick: () => copy(r.IpAddress_ip, "IP address") },
              { label: "Copy MAC Address", icon: <IconCopy size={14} />, onClick: () => copy(macFromB64(r.MacAddress_bin), "MAC address") },
            ]}
            columns={[
              { key: "IpAddress_ip", title: "IP address", mono: true, value: (r) => r.IpAddress_ip.split(".").reduce((a, o) => a * 256 + Number(o), 0), render: (r) => r.IpAddress_ip },
              { key: "Mask_u32", title: "Mask", mono: true, render: (r) => <span className="sem-dim">{maskU32(r.Mask_u32)}</span> },
              { key: "MacAddress_bin", title: "MAC address", mono: true, value: (r) => macFromB64(r.MacAddress_bin), render: (r) => macFromB64(r.MacAddress_bin) },
              { key: "Hostname_str", title: "Host name", render: (r) => r.Hostname_str || <span className="sem-dim">–</span> },
              { key: "LeasedTime_dt", title: "Leased", width: 100, render: (r) => <span className="sem-dim" title={dt(r.LeasedTime_dt)}>{agoShort(r.LeasedTime_dt)}</span> },
              { key: "ExpireTime_dt", title: "Expires", width: 150, render: (r) => <span title={dt(r.ExpireTime_dt)}>{dt(r.ExpireTime_dt)}</span> },
            ]}
          />
        </div>
      )}
    </>
  );
}
