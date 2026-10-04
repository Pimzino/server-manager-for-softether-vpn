// Server › Layer 3 Switches: virtual routers between Virtual Hubs (EnumL3Switch …). Master–detail: select a
// switch to see its virtual interfaces (one per hub) and static routing table. Interfaces and routes can only
// change while the switch is stopped, as in Server Manager.
import { useEffect, useMemo, useState } from "react";
import { Autocomplete, Button, NumberInput, Select, TextInput } from "@mantine/core";
import {
  IconCopy, IconLock, IconNetwork, IconPlayerPlay, IconPlayerStop, IconPlus, IconRoute, IconTrash,
} from "@tabler/icons-react";
import { notifySuccess, useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import { isIPv4, num, plural } from "../../lib/format";
import {
  DataTable, EmptyState, FormRow, FormSection, Mono, PageHeader, Section, StatusBadge, Tag, confirmAction, type RowKey,
} from "../../design";
import { Callout } from "../../components/domain/ui";
import { useHubNames } from "../../components/domain/hooks";
import { MASK_OPTIONS, intToIp, ipToInt, isMask, maskBits } from "../../components/domain/util";
import { FormSheet, Unreachable, copyText, useServerPage } from "./_server-network/shared";

interface L3Sw { Name_str: string; NumInterfaces_u32: number; NumTables_u32: number; Active_bool: boolean; Online_bool: boolean }
interface L3If { Name_str?: string; HubName_str: string; IpAddress_ip: string; SubnetMask_ip: string }
interface L3Route { Name_str?: string; NetworkAddress_ip: string; SubnetMask_ip: string; GatewayAddress_ip: string; Metric_u32: number }

const netOf = (ip: string, mask: string) => (ipToInt(ip) & ipToInt(mask)) >>> 0;
const routeKey = (r: L3Route) => `${r.NetworkAddress_ip}|${r.SubnetMask_ip}|${r.GatewayAddress_ip}|${r.Metric_u32}`;
const cidr = (ip: string, mask: string) => `${ip}/${maskBits(mask) ?? mask}`;
/** SoftEther's IsHostIPAddress32: AddL3If and AddL3Table refuse 0.0.0.0 and 255.255.255.255 (error 38, invalid parameter). */
const reservedIp = (ip: string) => ip === "0.0.0.0" || ip === "255.255.255.255";
/** AddL3Switch refuses names that fail IsSafeStr (letters, digits, space and ( ) - _ # % & . only); MAX_HUBNAME_LEN 255. */
const SAFE_NAME = /^[A-Za-z0-9 ()\-_#%&.]+$/;

function SwitchStatus({ sw }: { sw: L3Sw }) {
  if (!sw.Online_bool) return <StatusBadge status="off">Stopped</StatusBadge>;
  if (sw.Active_bool) return <StatusBadge status="ok">Running</StatusBadge>;
  return <StatusBadge status="warning" tooltip="Started, but not routing yet. Check that the interfaces’ Virtual Hubs exist and are online.">Starting</StatusBadge>;
}

export default function L3SwitchesPage() {
  const { serverId } = useScope();
  const { s, reachable, live } = useServerPage(serverId);
  const list = useRpc<{ L3SWList?: L3Sw[] }>(serverId, "EnumL3Switch", {}, { refetchInterval: 10_000, enabled: live });
  const [creating, setCreating] = useState(false);
  const [sel, setSel] = useState<RowKey[]>([]);
  const start = useRpcMutation<{ Name_str: string }>(serverId, "StartL3Switch", { success: false, onSuccess: (_r, p) => notifySuccess(`“${p.Name_str}” started`) });
  const stop = useRpcMutation<{ Name_str: string }>(serverId, "StopL3Switch", {
    success: false, onSuccess: (_r, p) => notifySuccess(`“${p.Name_str}” stopped`),
    confirm: (p) => ({
      title: <>Stop “{p.Name_str}”?</>,
      message: "Routing between the connected Virtual Hubs stops until you start the switch again.",
      confirmLabel: "Stop Switch", tone: "warning", testId: "l3-stop",
    }),
  });
  const del = useRpcMutation<{ Name_str: string }>(serverId, "DelL3Switch", {
    success: "Layer 3 switch deleted",
    onSuccess: (_r, p) => { if (sel[0] === p.Name_str) setSel([]); },
    confirm: (p) => ({
      title: <>Delete the Layer 3 switch “{p.Name_str}”?</>,
      message: "The switch, its virtual interfaces and its routing table are deleted. A running switch is stopped first. This can’t be undone.",
      confirmLabel: "Delete Switch", typeToConfirm: p.Name_str, testId: "l3-delete",
    }),
  });
  const switches = useMemo(() => list.data?.L3SWList ?? [], [list.data]);
  const current = switches.find((x) => x.Name_str === sel[0]);

  // Select the first switch so the detail shows something useful straight away, and again when the selected switch
  // disappears (deleted here, from another manager, or by vpncmd).
  useEffect(() => {
    if (switches.length && !switches.some((x) => x.Name_str === sel[0])) setSel([[...switches].sort((a, b) => a.Name_str.localeCompare(b.Name_str))[0].Name_str]);
  }, [switches]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = switches.filter((x) => x.Online_bool).length;
  const startSw = (x: L3Sw) => start.mutate({ Name_str: x.Name_str });
  const stopSw = (x: L3Sw) => stop.mutate({ Name_str: x.Name_str });

  if (!s) return null;
  return (
    <>
      <PageHeader
        title="Layer 3 Switches"
        meta={list.data ? <>{plural(switches.length, "switch", "switches")} · {num(running)} running</> : undefined}
        description="Route IP traffic between Virtual Hubs on this server. Each switch has one virtual interface per hub, acting as that network’s router, and an optional static routing table."
        actions={reachable && <Button leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="create-l3switch">New Switch…</Button>}
      />
      {!reachable ? <Unreachable serverId={serverId} /> : (
        <>
          <DataTable
            testId="l3switches-table"
            aria-label="Layer 3 switches"
            data={list.data ? switches : undefined}
            loading={list.isLoading || list.isFetching}
            error={list.error}
            onRetry={() => void list.refetch()}
            rowKey={(x) => x.Name_str}
            rowTestId={(x) => `l3-row-${x.Name_str}`}
            selectable="single"
            selection={sel}
            onSelectionChange={(k) => setSel(k.length ? k : sel)}
            searchable={switches.length > 6}
            initialSort={{ key: "Name_str", dir: "asc" }}
            onRowOpen={(x) => { setSel([x.Name_str]); requestAnimationFrame(() => document.getElementById("l3-detail")?.scrollIntoView({ behavior: "smooth", block: "start" })); }}
            empty={{
              title: "No Layer 3 switches",
              description: "Create a switch, give it an interface in each Virtual Hub you want to route between, then start it.",
              icon: <IconRoute size={28} stroke={1.4} />,
              action: <Button size="xs" variant="default" leftSection={<IconPlus size={13} />} onClick={() => setCreating(true)}>New Switch…</Button>,
            }}
            toolbar={current && (
              <div className="sem-row-inline" style={{ gap: "var(--sem-space-3)" }}>
                {current.Online_bool ? (
                  <Button size="xs" variant="default" leftSection={<IconPlayerStop size={13} />} onClick={() => stopSw(current)} loading={stop.isPending} data-testid={`l3-stop-${current.Name_str}`}>Stop</Button>
                ) : (
                  <Button size="xs" variant="default" leftSection={<IconPlayerPlay size={13} />} onClick={() => startSw(current)} loading={start.isPending}
                    disabled={current.NumInterfaces_u32 === 0} title={current.NumInterfaces_u32 === 0 ? "Add at least one interface first" : undefined}
                    data-testid={`l3-start-${current.Name_str}`}>Start</Button>
                )}
                <Button size="xs" variant="default" c="var(--sem-red)" leftSection={<IconTrash size={13} />} onClick={() => del.mutate({ Name_str: current.Name_str })} data-testid="l3-delete">Delete…</Button>
              </div>
            )}
            contextMenu={(x) => [
              x.Online_bool
                ? { label: "Stop Switch", icon: <IconPlayerStop size={14} />, onClick: () => stopSw(x) }
                : { label: "Start Switch", icon: <IconPlayerPlay size={14} />, onClick: () => startSw(x), disabled: x.NumInterfaces_u32 === 0 },
              { label: "Copy Name", icon: <IconCopy size={14} />, onClick: () => void copyText(x.Name_str, "Switch name copied") },
              "divider",
              { label: "Delete Switch…", icon: <IconTrash size={14} />, danger: true, onClick: () => del.mutate({ Name_str: x.Name_str }), testId: "l3-menu-delete" },
            ]}
            columns={[
              { key: "Name_str", title: "Name", truncate: true, render: (x) => <span className="sem-strong" title={x.Name_str}>{x.Name_str}</span> },
              { key: "status", title: "Status", width: 110, value: (x) => (x.Online_bool ? (x.Active_bool ? 2 : 1) : 0), render: (x) => <SwitchStatus sw={x} /> },
              { key: "NumInterfaces_u32", title: "Interfaces", align: "right", width: 96, render: (x) => num(x.NumInterfaces_u32) },
              { key: "NumTables_u32", title: "Routes", align: "right", width: 80, render: (x) => num(x.NumTables_u32) },
            ]}
          />
          {current ? (
            <SwitchDetail key={current.Name_str} serverId={serverId} sw={current} onStop={() => stopSw(current)} stopping={stop.isPending} />
          ) : switches.length > 0 && (
            <div className="sem-unreachable" style={{ marginTop: "var(--sem-space-8)" }}>
              <EmptyState compact title="No switch selected" description="Select a switch to see its interfaces and routing table." />
            </div>
          )}
        </>
      )}
      <CreateSwitchSheet serverId={serverId} opened={creating} onClose={() => setCreating(false)} existing={switches.map((x) => x.Name_str)}
        onCreated={(n) => setSel([n])} />
    </>
  );
}

function SwitchDetail({ serverId, sw, onStop, stopping }: { serverId: number; sw: L3Sw; onStop: () => void; stopping: boolean }) {
  const ifs = useRpc<{ L3IFList?: L3If[] }>(serverId, "EnumL3If", { Name_str: sw.Name_str });
  const routes = useRpc<{ L3Table?: L3Route[] }>(serverId, "EnumL3Table", { Name_str: sw.Name_str });
  const delIf = useRpcMutation<{ Name_str: string; HubName_str: string; IpAddress_ip: string; SubnetMask_ip: string }>(serverId, "DelL3If", {
    success: "Interface removed", confirm: false,
  });
  const delRoute = useRpcMutation<{ Name_str: string; NetworkAddress_ip: string; SubnetMask_ip: string; GatewayAddress_ip: string; Metric_u32: number }>(serverId, "DelL3Table", {
    success: "Route removed", confirm: false,
  });
  const [addIf, setAddIf] = useState(false);
  const [addRoute, setAddRoute] = useState(false);
  const [ifSel, setIfSel] = useState<RowKey[]>([]);
  const [rtSel, setRtSel] = useState<RowKey[]>([]);
  const locked = sw.Online_bool;
  const ifList = useMemo(() => ifs.data?.L3IFList ?? [], [ifs.data]);
  const routeList = useMemo(() => routes.data?.L3Table ?? [], [routes.data]);
  const selIf = ifList.find((i) => i.HubName_str === ifSel[0]);
  const selRt = routeList.find((r) => routeKey(r) === rtSel[0]);
  const lockedTip = locked ? "Stop the switch to change it" : undefined;

  const removeIf = async (i: L3If) => {
    const used = routeList.filter((r) => netOf(r.GatewayAddress_ip, i.SubnetMask_ip) === netOf(i.IpAddress_ip, i.SubnetMask_ip));
    const ok = await confirmAction({
      title: <>Remove the interface in “{i.HubName_str}”?</>,
      message: <>The switch stops routing for {cidr(intToIp(netOf(i.IpAddress_ip, i.SubnetMask_ip)), i.SubnetMask_ip)}.{used.length > 0 && <> {plural(used.length, "route")} through this network will stop working.</>}</>,
      confirmLabel: "Remove Interface", testId: "l3if-remove",
    });
    if (ok) delIf.mutate({ Name_str: sw.Name_str, HubName_str: i.HubName_str, IpAddress_ip: i.IpAddress_ip, SubnetMask_ip: i.SubnetMask_ip }, { onSuccess: () => setIfSel([]) });
  };
  const removeRoute = async (r: L3Route) => {
    const ok = await confirmAction({
      title: <>Remove the route to {cidr(r.NetworkAddress_ip, r.SubnetMask_ip)}?</>,
      message: <>Traffic for this network stops going through {r.GatewayAddress_ip} (metric {r.Metric_u32}).</>,
      confirmLabel: "Remove Route", testId: "l3route-remove",
    });
    if (ok) delRoute.mutate({ Name_str: sw.Name_str, NetworkAddress_ip: r.NetworkAddress_ip, SubnetMask_ip: r.SubnetMask_ip, GatewayAddress_ip: r.GatewayAddress_ip, Metric_u32: r.Metric_u32 }, { onSuccess: () => setRtSel([]) });
  };

  return (
    <div id="l3-detail" data-testid="l3-detail">
      <Section
        title={<span className="sem-row-inline" style={{ flexWrap: "nowrap" }}><span>Interfaces of “{sw.Name_str}”</span><SwitchStatus sw={sw} /></span>}
        description="One per Virtual Hub. Its address is the router that hub’s clients use as their gateway."
      >
        {locked && (
          <div className="sem-callouts" style={{ marginTop: 0, marginBottom: "var(--sem-space-4)" }}>
            <Callout tone="accent" icon={<IconLock size={16} stroke={1.7} />} testId="l3-locked"
              action={<Button size="xs" variant="default" leftSection={<IconPlayerStop size={13} />} loading={stopping} onClick={onStop} data-testid="l3-stop-to-edit">Stop Switch</Button>}>
              The switch is running. Stop it to add or remove interfaces and routes.
            </Callout>
          </div>
        )}
        <DataTable
          testId="l3-interfaces-table"
          aria-label="Virtual interfaces"
          data={ifs.data ? ifList : undefined}
          loading={ifs.isLoading}
          error={ifs.error}
          onRetry={() => void ifs.refetch()}
          rowKey={(i) => i.HubName_str}
          searchable={false}
          selectable="single"
          selection={ifSel}
          onSelectionChange={(k) => setIfSel(k)}
          initialSort={{ key: "HubName_str", dir: "asc" }}
          empty={{ title: "No interfaces", description: "Add an interface in each Virtual Hub you want to route between.", icon: <IconNetwork size={26} stroke={1.4} /> }}
          footer={false}
          toolbar={(
            <div className="sem-row-inline" style={{ gap: "var(--sem-space-3)" }}>
              {ifList.length > 0 && (
                <Button size="xs" variant="default" c={locked || !selIf ? undefined : "var(--sem-red)"} leftSection={<IconTrash size={13} />} disabled={locked || !selIf}
                  title={lockedTip} onClick={() => selIf && void removeIf(selIf)} data-testid="l3if-remove">Remove…</Button>
              )}
              <Button size="xs" variant="default" leftSection={<IconPlus size={13} />} disabled={locked} title={lockedTip} onClick={() => setAddIf(true)} data-testid="l3-add-if">Add Interface…</Button>
            </div>
          )}
          contextMenu={(i) => [
            { label: "Copy Address", icon: <IconCopy size={14} />, onClick: () => void copyText(cidr(i.IpAddress_ip, i.SubnetMask_ip), "Address copied") },
            "divider",
            { label: "Remove Interface…", icon: <IconTrash size={14} />, danger: true, disabled: locked, onClick: () => void removeIf(i) },
          ]}
          columns={[
            { key: "HubName_str", title: "Virtual Hub", truncate: true, render: (i) => <span className="sem-strong" title={i.HubName_str}>{i.HubName_str}</span> },
            { key: "IpAddress_ip", title: "Address", width: 150, mono: true, value: (i) => ipToInt(i.IpAddress_ip), render: (i) => i.IpAddress_ip },
            { key: "SubnetMask_ip", title: "Subnet mask", width: 190, mono: true, value: (i) => ipToInt(i.SubnetMask_ip), render: (i) => <>{i.SubnetMask_ip} <span className="sem-dim">/{maskBits(i.SubnetMask_ip) ?? "?"}</span></> },
            {
              key: "network", title: "Network", width: 170, mono: true, sortable: false,
              render: (i) => isMask(i.SubnetMask_ip) ? <span className="sem-dim">{cidr(intToIp(netOf(i.IpAddress_ip, i.SubnetMask_ip)), i.SubnetMask_ip)}</span> : "–",
            },
          ]}
        />
      </Section>

      <Section
        title="Routing table"
        description="Packets for networks that aren’t on an interface go to the gateway of the best matching route. Directly attached networks need no route."
      >
        <DataTable
          testId="l3-routes-table"
          aria-label="Routing table"
          data={routes.data ? routeList : undefined}
          loading={routes.isLoading}
          error={routes.error}
          onRetry={() => void routes.refetch()}
          rowKey={routeKey}
          searchable={false}
          selectable="single"
          selection={rtSel}
          onSelectionChange={(k) => setRtSel(k)}
          initialSort={{ key: "NetworkAddress_ip", dir: "asc" }}
          empty={{ title: "No static routes", description: "Networks directly attached to an interface are routed automatically.", icon: <IconRoute size={26} stroke={1.4} /> }}
          footer={false}
          toolbar={(
            <div className="sem-row-inline" style={{ gap: "var(--sem-space-3)" }}>
              {routeList.length > 0 && (
                <Button size="xs" variant="default" c={locked || !selRt ? undefined : "var(--sem-red)"} leftSection={<IconTrash size={13} />} disabled={locked || !selRt}
                  title={lockedTip} onClick={() => selRt && void removeRoute(selRt)} data-testid="l3route-remove">Remove…</Button>
              )}
              <Button size="xs" variant="default" leftSection={<IconPlus size={13} />} disabled={locked} title={lockedTip} onClick={() => setAddRoute(true)} data-testid="l3-add-route">Add Route…</Button>
            </div>
          )}
          contextMenu={(r) => [
            { label: "Copy Destination", icon: <IconCopy size={14} />, onClick: () => void copyText(cidr(r.NetworkAddress_ip, r.SubnetMask_ip), "Destination copied") },
            "divider",
            { label: "Remove Route…", icon: <IconTrash size={14} />, danger: true, disabled: locked, onClick: () => void removeRoute(r) },
          ]}
          columns={[
            {
              key: "NetworkAddress_ip", title: "Destination", mono: true, value: (r) => ipToInt(r.NetworkAddress_ip),
              render: (r) => (
                <span className="sem-row-inline" style={{ flexWrap: "nowrap" }}>
                  <span className="sem-strong">{cidr(r.NetworkAddress_ip, r.SubnetMask_ip)}</span>
                  {r.NetworkAddress_ip === "0.0.0.0" && r.SubnetMask_ip === "0.0.0.0" && <Tag color="accent">Default</Tag>}
                </span>
              ),
            },
            { key: "SubnetMask_ip", title: "Subnet mask", width: 150, mono: true, value: (r) => ipToInt(r.SubnetMask_ip), render: (r) => r.SubnetMask_ip },
            { key: "GatewayAddress_ip", title: "Gateway", width: 150, mono: true, value: (r) => ipToInt(r.GatewayAddress_ip), render: (r) => r.GatewayAddress_ip },
            { key: "Metric_u32", title: "Metric", align: "right", width: 76, render: (r) => num(r.Metric_u32) },
          ]}
        />
      </Section>
      <AddIfSheet serverId={serverId} sw={sw.Name_str} opened={addIf} onClose={() => setAddIf(false)} ifs={ifList} onAdded={(h) => setIfSel([h])} />
      <AddRouteSheet serverId={serverId} sw={sw.Name_str} opened={addRoute} onClose={() => setAddRoute(false)} ifs={ifList} routes={routeList} onAdded={(k) => setRtSel([k])} />
    </div>
  );
}

function CreateSwitchSheet({ serverId, opened, onClose, existing, onCreated }: {
  serverId: number; opened: boolean; onClose: () => void; existing: string[]; onCreated: (n: string) => void;
}) {
  const [name, setName] = useState("");
  const add = useRpcMutation(serverId, "AddL3Switch", { success: "Layer 3 switch created", onSuccess: (_r, p) => { onCreated(String(p.Name_str)); onClose(); } });
  useEffect(() => { if (opened) setName(""); }, [opened]);
  const n = name.trim();
  const err = !n ? null : existing.some((e) => e.toLowerCase() === n.toLowerCase()) ? `There’s already a switch named “${n}”.`
    : n.length > 255 ? "Use at most 255 characters."
    : !SAFE_NAME.test(n) ? "Use only letters, digits, spaces and ( ) - _ # % & . characters." : null;
  return (
    <FormSheet
      opened={opened} onClose={onClose} busy={add.isPending} size={500}
      title="New Layer 3 Switch" subtitle="A virtual router between Virtual Hubs on this server."
      icon={<IconRoute size={19} stroke={1.5} />}
      submitLabel="Create Switch" submitTestId="l3-create-submit" testId="l3-create-sheet" valid={!!n && !err}
      onSubmit={() => add.mutate({ Name_str: n })}
    >
      <FormSection>
        <FormRow label="Name" description="Unique on this server." error={err}>
          {(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.currentTarget.value)} error={!!err} data-autofocus spellCheck={false} placeholder="core-router" data-testid="l3-name" />}
        </FormRow>
      </FormSection>
      <p className="sem-form-section-footer">Next, add an interface in each Virtual Hub to route between, add static routes if needed, then start the switch.</p>
    </FormSheet>
  );
}

function AddIfSheet({ serverId, sw, opened, onClose, ifs, onAdded }: {
  serverId: number; sw: string; opened: boolean; onClose: () => void; ifs: L3If[]; onAdded: (hub: string) => void;
}) {
  const hubs = useHubNames(serverId);
  const [hub, setHub] = useState("");
  const [ip, setIp] = useState("");
  const [mask, setMask] = useState<string | null>("255.255.255.0");
  const add = useRpcMutation(serverId, "AddL3If", { success: "Interface added", onSuccess: (_r, p) => { onAdded(String(p.HubName_str)); onClose(); } });
  useEffect(() => { if (opened) { setHub(""); setIp(""); setMask("255.255.255.0"); } }, [opened]);
  const ipErr = ip && !isIPv4(ip) ? "Enter an IPv4 address such as 192.168.10.1." : null;
  const maskErr = mask && !isMask(mask) ? "Not a valid subnet mask." : null;
  const hubDup = ifs.some((i) => i.HubName_str.toLowerCase() === hub.trim().toLowerCase()) ? "This hub already has an interface on this switch." : null;
  const overlap = !ipErr && !maskErr && ip && mask
    ? ifs.find((i) => {
      const m = Math.min(ipToInt(mask), ipToInt(i.SubnetMask_ip)) >>> 0;
      return netOf(ip, intToIp(m)) === netOf(i.IpAddress_ip, intToIp(m));
    })
    : undefined;
  const bits = mask ? maskBits(mask) : null;
  const checkable = !ipErr && !maskErr && !!ip && !!mask;
  // StAddL3If refuses an address whose host part is all zeros for ANY mask (so /32, and the even address of a /31,
  // are refused too); a broadcast address is accepted by the server but can't work as a gateway below /31.
  const hostZero = checkable && ((ipToInt(ip) & (~ipToInt(mask!) >>> 0)) >>> 0) === 0;
  const isBcast = checkable && bits !== null && bits < 31 && ipToInt(ip) === ((netOf(ip, mask!) | (~ipToInt(mask!) >>> 0)) >>> 0);
  const addrErr = ipErr
    ?? (checkable && reservedIp(ip) ? "0.0.0.0 and 255.255.255.255 can’t be an interface address."
      : hostZero ? (bits === 32 ? "A /32 mask leaves no host addresses. Choose a shorter mask." : "That’s the network address of the subnet.")
      : isBcast ? "That’s the broadcast address of the subnet." : null);
  const valid = !!hub.trim() && !!ip && !!mask && !addrErr && !maskErr && !hubDup;
  const newHub = !!hub.trim() && hubs.data && !hubs.names.some((x) => x.toLowerCase() === hub.trim().toLowerCase());
  return (
    <FormSheet
      opened={opened} onClose={onClose} busy={add.isPending}
      title="Add Virtual Interface" subtitle={<>To the Layer 3 switch “{sw}”</>}
      icon={<IconNetwork size={19} stroke={1.5} />}
      submitLabel="Add Interface" submitTestId="l3if-submit" testId="l3if-sheet" valid={valid}
      onSubmit={() => add.mutate({ Name_str: sw, HubName_str: hub.trim(), IpAddress_ip: ip, SubnetMask_ip: mask! })}
    >
      <FormSection>
        <FormRow label="Virtual Hub" description={newHub ? "There’s no hub with this name yet; the interface works once it exists." : "The interface is an IP host inside this hub."} error={hubDup}>
          {(id) => <Autocomplete id={id} data={hubs.names} value={hub} onChange={setHub} error={!!hubDup} placeholder="Choose or type a hub" data-autofocus data-testid="l3if-hub" />}
        </FormRow>
        <FormRow label="IP address" description="Usually the gateway address the hub’s clients use." error={addrErr}>
          {(id) => <TextInput id={id} value={ip} onChange={(e) => setIp(e.currentTarget.value.trim())} error={!!addrErr} placeholder="192.168.10.1" spellCheck={false} data-testid="l3if-ip" />}
        </FormRow>
        <FormRow label="Subnet mask" error={maskErr}>
          {(id) => <Select id={id} data={MASK_OPTIONS} value={mask} onChange={setMask} searchable allowDeselect={false} error={!!maskErr} data-testid="l3if-mask" />}
        </FormRow>
      </FormSection>
      {overlap && (
        <div className="sem-callouts">
          <Callout tone="orange">
            This network overlaps the interface <Mono>{cidr(overlap.IpAddress_ip, overlap.SubnetMask_ip)}</Mono> in “{overlap.HubName_str}”. Each interface should be on its own network.
          </Callout>
        </div>
      )}
    </FormSheet>
  );
}

function AddRouteSheet({ serverId, sw, opened, onClose, ifs, routes, onAdded }: {
  serverId: number; sw: string; opened: boolean; onClose: () => void; ifs: L3If[]; routes: L3Route[]; onAdded: (key: string) => void;
}) {
  const [net, setNet] = useState("");
  const [mask, setMask] = useState<string | null>("255.255.255.0");
  const [gw, setGw] = useState("");
  const [metric, setMetric] = useState<number | string>(1);
  const add = useRpcMutation(serverId, "AddL3Table", {
    success: "Route added",
    onSuccess: (_r, p) => { onAdded(routeKey(p as unknown as L3Route)); onClose(); },
  });
  useEffect(() => { if (opened) { setNet(""); setMask("255.255.255.0"); setGw(""); setMetric(1); } }, [opened]);
  const netErr = net && !isIPv4(net) ? "Enter an IPv4 network address such as 10.20.0.0." : null;
  const maskErr = mask && !isMask(mask) ? "Not a valid subnet mask." : null;
  const gwErr = gw && !isIPv4(gw) ? "Enter an IPv4 address." : gw && reservedIp(gw) ? "0.0.0.0 and 255.255.255.255 can’t be a gateway." : null;
  const notNetwork = !netErr && !maskErr && net && mask && netOf(net, mask) !== ipToInt(net) ? `Host bits are set. The network address is ${intToIp(netOf(net, mask))}.` : null;
  const gwReachable = !gw || !!gwErr || ifs.some((i) => netOf(gw, i.SubnetMask_ip) === netOf(i.IpAddress_ip, i.SubnetMask_ip));
  const m = Number(metric);
  const metricErr = !Number.isInteger(m) || m < 1 ? "Enter 1 or more." : null;
  const dup = routes.some((r) => r.NetworkAddress_ip === net && r.SubnetMask_ip === mask && r.GatewayAddress_ip === gw && r.Metric_u32 === m);
  const valid = !!net && !!mask && !!gw && !netErr && !maskErr && !gwErr && !notNetwork && !metricErr && !dup;
  return (
    <FormSheet
      opened={opened} onClose={onClose} busy={add.isPending}
      title="Add Route" subtitle={<>To the routing table of “{sw}”</>}
      icon={<IconRoute size={19} stroke={1.5} />}
      submitLabel="Add Route" submitTestId="l3route-submit" testId="l3route-sheet" valid={valid}
      note={dup ? <span style={{ color: "var(--sem-red)" }}>This route already exists.</span> : undefined}
      onSubmit={() => add.mutate({ Name_str: sw, NetworkAddress_ip: net, SubnetMask_ip: mask!, GatewayAddress_ip: gw, Metric_u32: m })}
    >
      <FormSection description="Use 0.0.0.0 with mask 0.0.0.0 for a default route.">
        <FormRow label="Destination network" error={netErr ?? notNetwork}>
          {(id) => <TextInput id={id} value={net} onChange={(e) => setNet(e.currentTarget.value.trim())} error={!!(netErr || notNetwork)} placeholder="10.20.0.0" spellCheck={false} data-autofocus data-testid="l3route-net" />}
        </FormRow>
        <FormRow label="Subnet mask" error={maskErr}>
          {(id) => <Select id={id} data={MASK_OPTIONS} value={mask} onChange={setMask} searchable allowDeselect={false} error={!!maskErr} data-testid="l3route-mask" />}
        </FormRow>
        <FormRow label="Gateway" description="The next router. It must be on the network of one of this switch’s interfaces." error={gwErr}>
          {(id) => <TextInput id={id} value={gw} onChange={(e) => setGw(e.currentTarget.value.trim())} error={!!gwErr} placeholder="192.168.10.254" spellCheck={false} data-testid="l3route-gw" />}
        </FormRow>
        <FormRow label="Metric" description="When several routes match, the lowest metric wins." error={metricErr}>
          {(id) => <NumberInput id={id} w={110} min={1} allowDecimal={false} allowNegative={false} value={metric} onChange={setMetric} data-testid="l3route-metric" />}
        </FormRow>
      </FormSection>
      {!gwReachable && (
        <div className="sem-callouts">
          <Callout tone="orange" testId="l3route-unreachable">The gateway isn’t on any interface network of this switch, so the route won’t be usable.</Callout>
        </div>
      )}
    </FormSheet>
  );
}
