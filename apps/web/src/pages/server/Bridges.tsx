import { useEffect, useState } from "react";
import { Alert, Autocomplete, Badge, Button, Group, Modal, Select, Stack, Switch, Text, TextInput, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, ErrorAlert, KeyValue, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { can, useCaps, useRpc, useRpcMutation, useScope, useServer } from "../../lib/hooks";
import type { HubListItem } from "../../lib/types";

interface Bridge { DeviceName_str: string; HubNameLB_str: string; Online_bool: boolean; Active_bool: boolean; TapMode_bool: boolean }
interface EthItem { DeviceName_str: string; NetworkConnectionName_utf: string }

function YesNo({ v, yes = "Yes", no = "No" }: { v: boolean | undefined; yes?: string; no?: string }) {
  if (v === undefined) return <>–</>;
  return <Badge color={v ? "green" : "gray"} variant="light" leftSection={v ? <IconCheck size={12} /> : <IconX size={12} />}>{v ? yes : no}</Badge>;
}

function AddBridgeModal({ serverId, opened, onClose, tapSupported, existing }: {
  serverId: number; opened: boolean; onClose: () => void; tapSupported: boolean; existing: Bridge[];
}) {
  const hubs = useRpc<{ HubList?: HubListItem[] }>(serverId, "EnumHub", {}, { enabled: opened });
  const eth = useRpc<{ EthList?: EthItem[] }>(serverId, "EnumEthernet", {}, { enabled: opened });
  const [hub, setHub] = useState("");
  const [tap, setTap] = useState(false);
  const [device, setDevice] = useState<string | null>(null);
  const [tapName, setTapName] = useState("");
  const [custom, setCustom] = useState("");
  const add = useRpcMutation(serverId, "AddLocalBridge", { success: "Local bridge created", onSuccess: onClose });
  useEffect(() => { if (opened) { setHub(""); setTap(false); setDevice(null); setTapName(""); setCustom(""); } }, [opened]);

  const ethList = eth.data?.EthList ?? [];
  const devName = tap ? tapName.trim() : (device === "__custom" ? custom.trim() : device ?? "");
  const tapErr = tap && tapName && !/^[A-Za-z0-9_-]{1,11}$/.test(tapName.trim()) ? "Use up to 11 letters, digits, - or _" : null;
  const dup = existing.some((b) => b.HubNameLB_str.toLowerCase() === hub.trim().toLowerCase() && b.DeviceName_str === devName);
  const valid = !!hub.trim() && !!devName && !tapErr && !dup;

  return (
    <Modal opened={opened} onClose={onClose} title="New local bridge" centered size="lg">
      <form onSubmit={(e) => { e.preventDefault(); if (valid) add.mutate({ HubNameLB_str: hub.trim(), DeviceName_str: devName, TapMode_bool: tap }); }}>
        <Stack>
          <Autocomplete
            label="Virtual Hub"
            description="The Virtual Hub to bridge. You may also type the name of a hub that does not exist yet."
            data={(hubs.data?.HubList ?? []).map((h) => h.HubName_str).sort()}
            value={hub}
            onChange={setHub}
            required
            data-testid="bridge-hub"
          />
          {tapSupported && (
            <Switch
              label="Bridge to a new tap device"
              description="Create a virtual network interface (tap device) on the host instead of using a physical adapter (Linux only)."
              checked={tap} onChange={(e) => setTap(e.currentTarget.checked)}
            />
          )}
          {tap ? (
            <TextInput label="Tap device name" description="Name of the tap interface to create; the OS interface becomes tap_<name>."
              value={tapName} onChange={(e) => setTapName(e.currentTarget.value)} error={tapErr} required />
          ) : (
            <>
              {eth.error ? <ErrorAlert error={eth.error} /> : (
                <Select
                  label="Ethernet device"
                  description="Physical network adapter used as the bridge destination. A dedicated adapter is recommended under high load."
                  data={[
                    ...ethList.map((e) => ({ value: e.DeviceName_str, label: e.NetworkConnectionName_utf && e.NetworkConnectionName_utf !== e.DeviceName_str ? `${e.DeviceName_str} — ${e.NetworkConnectionName_utf}` : e.DeviceName_str })),
                    { value: "__custom", label: "Other (enter device name)…" },
                  ]}
                  value={device}
                  onChange={setDevice}
                  searchable
                  required
                  nothingFoundMessage="No adapters"
                  data-testid="bridge-device"
                />
              )}
              {!eth.isLoading && ethList.length === 0 && !eth.error && (
                <Text size="xs" c="dimmed">The server reported no usable network adapters. You can still enter a device name manually.</Text>
              )}
              {device === "__custom" && (
                <TextInput label="Device name" description="Exact OS device name, e.g. eth1 or en0" value={custom} onChange={(e) => setCustom(e.currentTarget.value)} required />
              )}
            </>
          )}
          {dup && <Text size="sm" c="red">This hub is already bridged to that device.</Text>}
          <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
            Bridging a hub to the adapter you use to reach the server can cause loops or loss of connectivity. The adapter is put in promiscuous mode.
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!valid} loading={add.isPending} data-testid="bridge-create-submit">Create bridge</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export default function BridgesPage() {
  const { serverId } = useScope();
  const server = useServer(serverId);
  const role = server.data?.myRole;
  const canWrite = can(role, "operator");
  const caps = useCaps(serverId);
  const support = useRpc<{ IsBridgeSupportedOs_bool: boolean; IsWinPcapNeeded_bool: boolean }>(serverId, "GetBridgeSupport");
  const list = useRpc<{ LocalBridgeList?: Bridge[] }>(serverId, "EnumLocalBridge", {}, { refetchInterval: 10_000 });
  const eth = useRpc<{ EthList?: EthItem[] }>(serverId, "EnumEthernet");
  const del = useRpcMutation(serverId, "DeleteLocalBridge", { success: "Local bridge deleted" });
  const [adding, setAdding] = useState(false);
  const supported = support.data?.IsBridgeSupportedOs_bool;
  const tapSupported = caps.has("b_tap_supported");

  return (
    <>
      <PageHeader
        title="Local bridges"
        description="A local bridge connects a Virtual Hub at Layer 2 to a physical network adapter (or a tap device) of the server host, joining the VPN to the physical LAN."
        actions={canWrite && <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)} disabled={supported === false} data-testid="create-bridge">New bridge</Button>}
      />
      {!canWrite && <ReadOnlyNotice role={role ?? "none"} />}

      <Section title="Host support">
        {support.error ? <ErrorAlert error={support.error} /> : (
          <QueryState query={support}>
            <KeyValue rows={[
              ["Local bridge supported by the OS", <YesNo v={supported} />],
              ["Packet capture driver (WinPcap) must be installed", <YesNo v={support.data?.IsWinPcapNeeded_bool} yes="Required" no="Not required" />],
              ["Tap devices supported", <YesNo v={caps.isLoading ? undefined : tapSupported} />],
            ]} />
            {supported === false && <Alert color="gray" mt="sm">This operating system does not support local bridging.</Alert>}
            {support.data?.IsWinPcapNeeded_bool && (
              <Alert color="orange" mt="sm" icon={<IconAlertTriangle size={16} />}>A packet capture driver must be installed on the server host before local bridges can operate.</Alert>
            )}
          </QueryState>
        )}
      </Section>

      <Section title="Bridges" description="Status refreshes every 10 seconds. A bridge is operating when the hub is online and the device could be opened.">
        {list.error ? <ErrorAlert error={list.error} /> : (
          <QueryState query={list}>
            <DataTable
              testId="bridges-table"
              data={list.data?.LocalBridgeList}
              rowKey={(b) => `${b.HubNameLB_str}|${b.DeviceName_str}`}
              initialSort={{ key: "HubNameLB_str", dir: "asc" }}
              empty="No local bridges defined"
              columns={[
                { key: "HubNameLB_str", title: "Virtual Hub", render: (b) => <Text fw={600}>{b.HubNameLB_str}</Text> },
                { key: "DeviceName_str", title: "Device", render: (b) => <Text ff="monospace" size="sm">{b.DeviceName_str}</Text> },
                { key: "TapMode_bool", title: "Kind", render: (b) => <Badge variant="outline" color={b.TapMode_bool ? "grape" : "gray"}>{b.TapMode_bool ? "Tap device" : "Network adapter"}</Badge> },
                {
                  key: "status", title: "Status", value: (b) => (b.Online_bool ? (b.Active_bool ? 2 : 1) : 0),
                  render: (b) => !b.Online_bool ? <Tooltip label="The bridge is offline (hub offline or bridge disabled)"><Badge color="gray" variant="light">Offline</Badge></Tooltip>
                    : b.Active_bool ? <Badge color="green" variant="light">Operating</Badge>
                    : <Tooltip label="Online but not running — the device could not be opened or the hub does not exist"><Badge color="red" variant="light">Error</Badge></Tooltip>,
                },
                {
                  key: "actions", title: "", sortable: false, align: "right",
                  render: (b) => canWrite && (
                    <ConfirmButton
                      title="Delete local bridge?"
                      message={<>The bridge between hub <b>{b.HubNameLB_str}</b> and device <b>{b.DeviceName_str}</b> is removed; traffic between the VPN and that network stops.</>}
                      confirmLabel="Delete bridge"
                      leftSection={<IconTrash size={14} />}
                      onConfirm={() => del.mutateAsync({ HubNameLB_str: b.HubNameLB_str, DeviceName_str: b.DeviceName_str, TapMode_bool: b.TapMode_bool })}
                    >Delete</ConfirmButton>
                  ),
                },
              ]}
            />
          </QueryState>
        )}
      </Section>

      <Section title="Host network adapters" description="Ethernet devices the server can use as a bridge destination (EnumEthernet).">
        {eth.error ? <ErrorAlert error={eth.error} /> : (
          <QueryState query={eth}>
            <DataTable
              testId="ethernet-table"
              data={eth.data?.EthList}
              rowKey={(e) => e.DeviceName_str}
              searchable={(eth.data?.EthList?.length ?? 0) > 8}
              empty="The server reported no usable network adapters"
              columns={[
                { key: "DeviceName_str", title: "Device name", render: (e) => <Text ff="monospace" size="sm">{e.DeviceName_str}</Text> },
                { key: "NetworkConnectionName_utf", title: "Network connection name" },
                {
                  key: "used", title: "Bridged to", value: (e) => (list.data?.LocalBridgeList ?? []).filter((b) => b.DeviceName_str === e.DeviceName_str).map((b) => b.HubNameLB_str).join(", "),
                  render: (e) => (list.data?.LocalBridgeList ?? []).filter((b) => b.DeviceName_str === e.DeviceName_str).map((b) => <Badge key={b.HubNameLB_str} variant="light" mr={4}>{b.HubNameLB_str}</Badge>),
                },
              ]}
            />
          </QueryState>
        )}
      </Section>

      <AddBridgeModal serverId={serverId} opened={adding} onClose={() => setAdding(false)} tapSupported={tapSupported} existing={list.data?.LocalBridgeList ?? []} />
    </>
  );
}
