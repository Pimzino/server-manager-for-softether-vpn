import { useEffect, useState } from "react";
import {
  Alert, Autocomplete, Badge, Button, Group, Modal, NumberInput, Select, Stack, Tabs, Text, TextInput, Tooltip,
} from "@mantine/core";
import { IconAlertTriangle, IconLock, IconPlayerPlay, IconPlayerStop, IconPlus, IconRoute, IconTrash, IconNetwork } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, Empty, ErrorAlert, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { MASK_OPTIONS, ipToInt, isMask, maskBits } from "../../components/server-a/shared";
import { can, useRpc, useRpcMutation, useScope, useServer } from "../../lib/hooks";
import { isIPv4, num } from "../../lib/format";
import type { HubListItem } from "../../lib/types";

interface L3Sw { Name_str: string; NumInterfaces_u32: number; NumTables_u32: number; Active_bool: boolean; Online_bool: boolean }
interface L3If { Name_str?: string; HubName_str: string; IpAddress_ip: string; SubnetMask_ip: string }
interface L3Route { Name_str?: string; NetworkAddress_ip: string; SubnetMask_ip: string; GatewayAddress_ip: string; Metric_u32: number }

const netOf = (ip: string, mask: string) => (ipToInt(ip) & ipToInt(mask)) >>> 0;
const intToIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

function SwitchStatus({ sw }: { sw: L3Sw }) {
  if (!sw.Online_bool) return <Badge color="gray" variant="light">Stopped</Badge>;
  if (sw.Active_bool) return <Badge color="green" variant="light">Running</Badge>;
  return <Tooltip label="Started, but not operating — check that the interfaces' Virtual Hubs exist and are online"><Badge color="orange" variant="light">Starting / error</Badge></Tooltip>;
}

function CreateSwitchModal({ serverId, opened, onClose, existing, onCreated }: { serverId: number; opened: boolean; onClose: () => void; existing: string[]; onCreated: (n: string) => void }) {
  const [name, setName] = useState("");
  const add = useRpcMutation(serverId, "AddL3Switch", { success: "Layer 3 switch created", onSuccess: (_r, p) => { onCreated(String(p.Name_str)); onClose(); } });
  useEffect(() => { if (opened) setName(""); }, [opened]);
  const n = name.trim();
  const err = !n ? null : existing.some((e) => e.toLowerCase() === n.toLowerCase()) ? "A switch with this name already exists" : n.length > 63 ? "Name too long" : null;
  return (
    <Modal opened={opened} onClose={onClose} title="New Virtual Layer 3 switch" centered>
      <form onSubmit={(e) => { e.preventDefault(); if (n && !err) add.mutate({ Name_str: n }); }}>
        <Stack>
          <TextInput label="Switch name" description="Layer-3 switch name (unique on this server)." value={name} onChange={(e) => setName(e.currentTarget.value)} error={err} required data-autofocus data-testid="l3-name" />
          <Text size="xs" c="dimmed">After creating the switch, add a virtual interface for each Virtual Hub to route between, optionally add static routes, then start the switch.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!n || !!err} loading={add.isPending} data-testid="l3-create-submit">Create</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function AddIfModal({ serverId, sw, opened, onClose, ifs }: { serverId: number; sw: string; opened: boolean; onClose: () => void; ifs: L3If[] }) {
  const hubs = useRpc<{ HubList?: HubListItem[] }>(serverId, "EnumHub", {}, { enabled: opened });
  const [hub, setHub] = useState("");
  const [ip, setIp] = useState("");
  const [mask, setMask] = useState<string | null>("255.255.255.0");
  const add = useRpcMutation(serverId, "AddL3If", { success: "Virtual interface added", onSuccess: onClose });
  useEffect(() => { if (opened) { setHub(""); setIp(""); setMask("255.255.255.0"); } }, [opened]);
  const ipErr = ip && !isIPv4(ip) ? "Invalid IPv4 address" : null;
  const maskErr = mask && !isMask(mask) ? "Invalid subnet mask" : null;
  const hubDup = ifs.some((i) => i.HubName_str.toLowerCase() === hub.trim().toLowerCase()) ? "This hub already has an interface on this switch" : null;
  const overlap = !ipErr && !maskErr && ip && mask
    ? ifs.find((i) => {
      const m = Math.min(ipToInt(mask), ipToInt(i.SubnetMask_ip)) >>> 0;
      return netOf(ip, intToIp(m)) === netOf(i.IpAddress_ip, intToIp(m));
    })
    : undefined;
  const bits = mask ? maskBits(mask) : null;
  const isNetOrBcast = !ipErr && !maskErr && ip && mask && bits !== null && bits < 31 &&
    (ipToInt(ip) === netOf(ip, mask) || ipToInt(ip) === ((netOf(ip, mask) | (~ipToInt(mask) >>> 0)) >>> 0));
  const valid = !!hub.trim() && !!ip && !!mask && !ipErr && !maskErr && !hubDup && !isNetOrBcast;
  return (
    <Modal opened={opened} onClose={onClose} title={`Add virtual interface to ${sw}`} centered>
      <form onSubmit={(e) => { e.preventDefault(); if (valid) add.mutate({ Name_str: sw, HubName_str: hub.trim(), IpAddress_ip: ip, SubnetMask_ip: mask! }); }}>
        <Stack>
          <Autocomplete label="Virtual Hub" description="The interface acts as an IP host inside this hub. The hub does not have to exist yet."
            data={(hubs.data?.HubList ?? []).map((h) => h.HubName_str).sort()} value={hub} onChange={setHub} error={hubDup} required data-testid="l3if-hub" />
          <TextInput label="IP address" description="IP address of the virtual interface in the hub's IP network (usually the gateway address clients use)."
            value={ip} onChange={(e) => setIp(e.currentTarget.value.trim())} error={ipErr || (isNetOrBcast ? "Address is the network or broadcast address of the subnet" : null)} placeholder="192.168.10.1" required data-testid="l3if-ip" />
          <Select label="Subnet mask" description="Subnet mask of the IP network the interface belongs to." data={MASK_OPTIONS} value={mask} onChange={setMask}
            searchable error={maskErr} allowDeselect={false} required />
          {overlap && (
            <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
              This network overlaps interface {overlap.IpAddress_ip}/{maskBits(overlap.SubnetMask_ip)} on hub {overlap.HubName_str}. Each interface should be on a distinct IP network.
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!valid} loading={add.isPending} data-testid="l3if-submit">Add interface</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function AddRouteModal({ serverId, sw, opened, onClose, ifs, routes }: { serverId: number; sw: string; opened: boolean; onClose: () => void; ifs: L3If[]; routes: L3Route[] }) {
  const [net, setNet] = useState("");
  const [mask, setMask] = useState<string | null>("255.255.255.0");
  const [gw, setGw] = useState("");
  const [metric, setMetric] = useState<number | string>(1);
  const add = useRpcMutation(serverId, "AddL3Table", { success: "Route added", onSuccess: onClose });
  useEffect(() => { if (opened) { setNet(""); setMask("255.255.255.0"); setGw(""); setMetric(1); } }, [opened]);
  const netErr = net && !isIPv4(net) ? "Invalid IPv4 address" : null;
  const maskErr = mask && !isMask(mask) ? "Invalid subnet mask" : null;
  const gwErr = gw && !isIPv4(gw) ? "Invalid IPv4 address" : null;
  const notNetwork = !netErr && !maskErr && net && mask && netOf(net, mask) !== ipToInt(net) ? `Host bits set — the network address is ${intToIp(netOf(net, mask))}` : null;
  const gwReachable = !gw || gwErr || ifs.some((i) => netOf(gw, i.SubnetMask_ip) === netOf(i.IpAddress_ip, i.SubnetMask_ip));
  const dup = routes.some((r) => r.NetworkAddress_ip === net && r.SubnetMask_ip === mask && r.GatewayAddress_ip === gw);
  const m = Number(metric);
  const valid = !!net && !!mask && !!gw && !netErr && !maskErr && !gwErr && !notNetwork && Number.isInteger(m) && m >= 1 && !dup;
  return (
    <Modal opened={opened} onClose={onClose} title={`Add route to ${sw}`} centered>
      <form onSubmit={(e) => { e.preventDefault(); if (valid) add.mutate({ Name_str: sw, NetworkAddress_ip: net, SubnetMask_ip: mask!, GatewayAddress_ip: gw, Metric_u32: m }); }}>
        <Stack>
          <Text size="sm" c="dimmed">Packets whose destination is not on any interface network are routed using this table. Use 0.0.0.0 / 0.0.0.0 for a default route.</Text>
          <TextInput label="Network address" description="Destination IP network address." value={net} onChange={(e) => setNet(e.currentTarget.value.trim())}
            error={netErr || notNetwork} placeholder="10.20.0.0" required data-testid="l3route-net" />
          <Select label="Subnet mask" description="Subnet mask of the destination network." data={MASK_OPTIONS} value={mask} onChange={setMask} searchable error={maskErr} allowDeselect={false} required />
          <TextInput label="Gateway address" description="Next-hop router. Must be an IP address on the network of one of this switch's virtual interfaces."
            value={gw} onChange={(e) => setGw(e.currentTarget.value.trim())} error={gwErr} placeholder="192.168.10.254" required data-testid="l3route-gw" />
          {!gwReachable && <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>The gateway is not on any interface network of this switch, so the route will not be usable.</Alert>}
          <NumberInput label="Metric" description="Route cost; when several routes match, the lowest metric wins." min={1} allowDecimal={false} value={metric} onChange={setMetric} required />
          {dup && <Text size="sm" c="red">This route already exists.</Text>}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!valid} loading={add.isPending} data-testid="l3route-submit">Add route</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function SwitchDetail({ serverId, sw, canWrite }: { serverId: number; sw: L3Sw; canWrite: boolean }) {
  const ifs = useRpc<{ L3IFList?: L3If[] }>(serverId, "EnumL3If", { Name_str: sw.Name_str });
  const routes = useRpc<{ L3Table?: L3Route[] }>(serverId, "EnumL3Table", { Name_str: sw.Name_str });
  const delIf = useRpcMutation(serverId, "DelL3If", { success: "Interface removed" });
  const delRoute = useRpcMutation(serverId, "DelL3Table", { success: "Route removed" });
  const stop = useRpcMutation(serverId, "StopL3Switch", { success: `Switch ${sw.Name_str} stopped` });
  const [addIf, setAddIf] = useState(false);
  const [addRoute, setAddRoute] = useState(false);
  const locked = sw.Online_bool;
  const editable = canWrite && !locked;
  const ifList = ifs.data?.L3IFList ?? [];
  const routeList = routes.data?.L3Table ?? [];

  return (
    <Section title={<Group gap="xs"><span>Switch {sw.Name_str}</span><SwitchStatus sw={sw} /></Group>} description="Virtual interfaces and static routing table.">
      {locked && (
        <Alert color="blue" variant="light" icon={<IconLock size={16} />} mb="md" title="Switch is running — configuration is locked">
          <Group justify="space-between" wrap="wrap">
            <Text size="sm">Interfaces and routes can only be added or removed while the switch is stopped.</Text>
            {canWrite && (
              <ConfirmButton title={`Stop ${sw.Name_str}?`} color="orange" size="xs" leftSection={<IconPlayerStop size={14} />}
                message="Routing between the connected Virtual Hubs stops until the switch is started again." confirmLabel="Stop switch"
                onConfirm={() => stop.mutateAsync({ Name_str: sw.Name_str })}>Stop to edit</ConfirmButton>
            )}
          </Group>
        </Alert>
      )}
      <Tabs defaultValue="ifs" keepMounted={false}>
        <Tabs.List mb="sm">
          <Tabs.Tab value="ifs" leftSection={<IconNetwork size={14} />}>Interfaces ({ifList.length})</Tabs.Tab>
          <Tabs.Tab value="routes" leftSection={<IconRoute size={14} />}>Routing table ({routeList.length})</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="ifs">
          {ifs.error ? <ErrorAlert error={ifs.error} /> : (
            <QueryState query={ifs}>
              <DataTable
                testId="l3-interfaces-table"
                data={ifList}
                rowKey={(i) => `${i.HubName_str}|${i.IpAddress_ip}`}
                searchable={false}
                empty="No virtual interfaces. Add one per Virtual Hub you want to route between."
                initialSort={{ key: "HubName_str", dir: "asc" }}
                toolbar={canWrite && <Button size="xs" leftSection={<IconPlus size={14} />} disabled={locked} onClick={() => setAddIf(true)} data-testid="l3-add-if">Add interface</Button>}
                columns={[
                  { key: "HubName_str", title: "Virtual Hub", render: (i) => <Text fw={600}>{i.HubName_str}</Text> },
                  { key: "IpAddress_ip", title: "IP address", value: (i) => ipToInt(i.IpAddress_ip), render: (i) => <Text ff="monospace" size="sm">{i.IpAddress_ip}</Text> },
                  { key: "SubnetMask_ip", title: "Subnet mask", value: (i) => ipToInt(i.SubnetMask_ip), render: (i) => <Text ff="monospace" size="sm">{i.SubnetMask_ip} (/{maskBits(i.SubnetMask_ip) ?? "?"})</Text> },
                  { key: "network", title: "Network", sortable: false, render: (i) => isMask(i.SubnetMask_ip) ? <Text ff="monospace" size="sm" c="dimmed">{intToIp(netOf(i.IpAddress_ip, i.SubnetMask_ip))}/{maskBits(i.SubnetMask_ip)}</Text> : "–" },
                  {
                    key: "actions", title: "", sortable: false, align: "right",
                    render: (i) => editable && (
                      <ConfirmButton title="Remove virtual interface?" leftSection={<IconTrash size={14} />} confirmLabel="Remove"
                        message={<>The interface {i.IpAddress_ip} on hub <b>{i.HubName_str}</b> is removed; routes through it stop working.</>}
                        onConfirm={() => delIf.mutateAsync({ Name_str: sw.Name_str, HubName_str: i.HubName_str, IpAddress_ip: i.IpAddress_ip, SubnetMask_ip: i.SubnetMask_ip })}>Remove</ConfirmButton>
                    ),
                  },
                ]}
              />
            </QueryState>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="routes">
          {routes.error ? <ErrorAlert error={routes.error} /> : (
            <QueryState query={routes}>
              <DataTable
                testId="l3-routes-table"
                data={routeList}
                rowKey={(r) => `${r.NetworkAddress_ip}|${r.SubnetMask_ip}|${r.GatewayAddress_ip}|${r.Metric_u32}`}
                searchable={false}
                empty="No static routes. Networks directly attached to interfaces are routed automatically."
                initialSort={{ key: "NetworkAddress_ip", dir: "asc" }}
                toolbar={canWrite && <Button size="xs" leftSection={<IconPlus size={14} />} disabled={locked} onClick={() => setAddRoute(true)} data-testid="l3-add-route">Add route</Button>}
                columns={[
                  {
                    key: "NetworkAddress_ip", title: "Destination", value: (r) => ipToInt(r.NetworkAddress_ip),
                    render: (r) => <Text ff="monospace" size="sm" fw={600}>{r.NetworkAddress_ip}/{maskBits(r.SubnetMask_ip) ?? r.SubnetMask_ip}{r.NetworkAddress_ip === "0.0.0.0" && r.SubnetMask_ip === "0.0.0.0" && <Badge ml={6} size="xs" variant="light">default</Badge>}</Text>,
                  },
                  { key: "SubnetMask_ip", title: "Subnet mask", value: (r) => ipToInt(r.SubnetMask_ip), render: (r) => <Text ff="monospace" size="sm">{r.SubnetMask_ip}</Text> },
                  { key: "GatewayAddress_ip", title: "Gateway", value: (r) => ipToInt(r.GatewayAddress_ip), render: (r) => <Text ff="monospace" size="sm">{r.GatewayAddress_ip}</Text> },
                  { key: "Metric_u32", title: "Metric", align: "right", render: (r) => num(r.Metric_u32) },
                  {
                    key: "actions", title: "", sortable: false, align: "right",
                    render: (r) => editable && (
                      <ConfirmButton title="Remove route?" leftSection={<IconTrash size={14} />} confirmLabel="Remove"
                        message={<>Route to <b>{r.NetworkAddress_ip}/{maskBits(r.SubnetMask_ip)}</b> via {r.GatewayAddress_ip} (metric {r.Metric_u32}) is removed.</>}
                        onConfirm={() => delRoute.mutateAsync({ Name_str: sw.Name_str, NetworkAddress_ip: r.NetworkAddress_ip, SubnetMask_ip: r.SubnetMask_ip, GatewayAddress_ip: r.GatewayAddress_ip, Metric_u32: r.Metric_u32 })}>Remove</ConfirmButton>
                    ),
                  },
                ]}
              />
            </QueryState>
          )}
        </Tabs.Panel>
      </Tabs>
      <AddIfModal serverId={serverId} sw={sw.Name_str} opened={addIf} onClose={() => setAddIf(false)} ifs={ifList} />
      <AddRouteModal serverId={serverId} sw={sw.Name_str} opened={addRoute} onClose={() => setAddRoute(false)} ifs={ifList} routes={routeList} />
    </Section>
  );
}

export default function L3SwitchesPage() {
  const { serverId } = useScope();
  const server = useServer(serverId);
  const role = server.data?.myRole;
  const canWrite = can(role, "operator");
  const list = useRpc<{ L3SWList?: L3Sw[] }>(serverId, "EnumL3Switch", {}, { refetchInterval: 10_000 });
  const start = useRpcMutation(serverId, "StartL3Switch", { success: "Switch started" });
  const stop = useRpcMutation(serverId, "StopL3Switch", { success: "Switch stopped" });
  const del = useRpcMutation(serverId, "DelL3Switch", { success: "Switch deleted" });
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const switches = list.data?.L3SWList ?? [];
  const current = switches.find((s) => s.Name_str === selected) ?? (switches.length === 1 ? switches[0] : undefined);

  return (
    <>
      <PageHeader
        title="Virtual Layer 3 switches"
        description="Route IP traffic between Virtual Hubs on this server. Each switch has one virtual interface per hub (acting as that network's router) plus an optional static routing table. Intended for administrators with IP routing knowledge."
        actions={canWrite && <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)} data-testid="create-l3switch">New switch</Button>}
      />
      {!canWrite && <ReadOnlyNotice role={role ?? "none"} />}
      <Section title="Switches">
        {list.error ? <ErrorAlert error={list.error} /> : (
          <QueryState query={list}>
            <DataTable
              testId="l3switches-table"
              data={switches}
              rowKey={(s) => s.Name_str}
              onRowClick={(s) => setSelected(s.Name_str)}
              initialSort={{ key: "Name_str", dir: "asc" }}
              empty="No Layer 3 switches defined"
              columns={[
                { key: "Name_str", title: "Name", render: (s) => <Text fw={600} c={current?.Name_str === s.Name_str ? "blue" : undefined}>{s.Name_str}</Text> },
                { key: "status", title: "Status", value: (s) => (s.Online_bool ? (s.Active_bool ? 2 : 1) : 0), render: (s) => <SwitchStatus sw={s} /> },
                { key: "NumInterfaces_u32", title: "Interfaces", align: "right", render: (s) => num(s.NumInterfaces_u32) },
                { key: "NumTables_u32", title: "Routes", align: "right", render: (s) => num(s.NumTables_u32) },
                {
                  key: "actions", title: "", sortable: false, align: "right",
                  render: (s) => canWrite && (
                    <Group gap={6} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                      {s.Online_bool ? (
                        <ConfirmButton title={`Stop ${s.Name_str}?`} color="orange" leftSection={<IconPlayerStop size={14} />} confirmLabel="Stop"
                          message="Routing between the connected Virtual Hubs stops until the switch is started again."
                          onConfirm={() => stop.mutateAsync({ Name_str: s.Name_str })}>Stop</ConfirmButton>
                      ) : (
                        <Tooltip label={s.NumInterfaces_u32 === 0 ? "Add at least one interface first" : "Start routing"}>
                          <Button size="xs" variant="light" color="green" leftSection={<IconPlayerPlay size={14} />} disabled={s.NumInterfaces_u32 === 0}
                            loading={start.isPending && start.variables?.Name_str === s.Name_str}
                            onClick={() => start.mutate({ Name_str: s.Name_str })} data-testid={`l3-start-${s.Name_str}`}>Start</Button>
                        </Tooltip>
                      )}
                      <ConfirmButton title={`Delete switch ${s.Name_str}?`} leftSection={<IconTrash size={14} />} confirmLabel="Delete switch" typeToConfirm={s.Name_str}
                        message="The switch, all of its virtual interfaces and its routing table are permanently removed. A running switch is stopped first."
                        onConfirm={async () => { await del.mutateAsync({ Name_str: s.Name_str }); if (selected === s.Name_str) setSelected(null); }}>Delete</ConfirmButton>
                    </Group>
                  ),
                },
              ]}
            />
          </QueryState>
        )}
      </Section>
      {current ? <SwitchDetail key={current.Name_str} serverId={serverId} sw={current} canWrite={canWrite} />
        : switches.length > 0 && <Empty>Select a switch to view its interfaces and routing table.</Empty>}
      <CreateSwitchModal serverId={serverId} opened={creating} onClose={() => setCreating(false)} existing={switches.map((s) => s.Name_str)} onCreated={setSelected} />
    </>
  );
}
