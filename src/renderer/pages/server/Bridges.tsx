// Server › Local Bridges: Layer 2 bridges between a Virtual Hub and a network adapter or tap device of the
// server host (EnumLocalBridge / AddLocalBridge / DeleteLocalBridge), plus what the host supports.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Autocomplete, Button, SegmentedControl, Select, TextInput } from "@mantine/core";
import { IconArrowsExchange, IconDeviceDesktopAnalytics, IconExternalLink, IconPlus, IconTrash } from "@tabler/icons-react";
import { useCaps, useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import { num, plural } from "../../lib/format";
import { hubBase } from "../../sections";
import {
  DataTable, ErrorState, FormRow, FormSection, Mono, PageHeader, PropertyList, PropertySkeleton, Section, SectionGrid, StatusBadge, Tag, type RowKey,
} from "../../design";
import { Callout } from "../../components/domain/ui";
import { useHubNames } from "../../components/domain/hooks";
import { FormSheet, Unreachable, useServerPage } from "./_server-network/shared";

interface Bridge { DeviceName_str: string; HubNameLB_str: string; Online_bool: boolean; Active_bool: boolean; TapMode_bool: boolean }
interface EthItem { DeviceName_str: string; NetworkConnectionName_utf: string }

const bridgeKey = (b: Bridge) => `${b.HubNameLB_str}|${b.DeviceName_str}|${b.TapMode_bool ? 1 : 0}`;
const OTHER = "__other";

function BridgeStatus({ b }: { b: Bridge }) {
  if (!b.Online_bool) return <StatusBadge status="off" tooltip="The bridge is offline: the hub is offline or the bridge is disabled.">Offline</StatusBadge>;
  if (b.Active_bool) return <StatusBadge status="ok">Operating</StatusBadge>;
  return <StatusBadge status="error" tooltip="Online but not running: the device couldn’t be opened, or the hub doesn’t exist. Status refreshes every 10 seconds.">Error</StatusBadge>;
}

export default function BridgesPage() {
  const { serverId } = useScope();
  const nav = useNavigate();
  const { s, reachable, live } = useServerPage(serverId);
  const caps = useCaps(serverId);
  const support = useRpc<{ IsBridgeSupportedOs_bool: boolean; IsWinPcapNeeded_bool: boolean }>(serverId, "GetBridgeSupport", {}, { enabled: live, staleTime: 60_000 });
  const list = useRpc<{ LocalBridgeList?: Bridge[] }>(serverId, "EnumLocalBridge", {}, { refetchInterval: 10_000, enabled: live });
  const eth = useRpc<{ EthList?: EthItem[] }>(serverId, "EnumEthernet", {}, { enabled: live, staleTime: 30_000 });
  const del = useRpcMutation<{ HubNameLB_str: string; DeviceName_str: string; TapMode_bool: boolean }>(serverId, "DeleteLocalBridge", {
    success: "Local bridge deleted",
    confirm: (p) => ({
      title: <>Delete the bridge between “{p.HubNameLB_str}” and {p.DeviceName_str}?</>,
      message: "Traffic between the Virtual Hub and that network stops. You can create the bridge again later.",
      confirmLabel: "Delete Bridge", testId: "bridge-delete",
    }),
  });
  const [adding, setAdding] = useState<{ device?: string } | null>(null);
  const [sel, setSel] = useState<RowKey[]>([]);

  const bridges = useMemo(() => list.data?.LocalBridgeList ?? [], [list.data]);
  const adapters = useMemo(() => eth.data?.EthList ?? [], [eth.data]);
  const selected = bridges.find((b) => bridgeKey(b) === sel[0]);
  const supported = support.data?.IsBridgeSupportedOs_bool;
  const tapSupported = caps.has("b_tap_supported");
  const operating = bridges.filter((b) => b.Online_bool && b.Active_bool).length;
  const remove = (b: Bridge) => del.mutate({ HubNameLB_str: b.HubNameLB_str, DeviceName_str: b.DeviceName_str, TapMode_bool: b.TapMode_bool });

  if (!s) return null;
  return (
    <>
      <PageHeader
        title="Local Bridges"
        meta={list.data ? <>{plural(bridges.length, "bridge")} · {num(operating)} operating</> : undefined}
        description="A local bridge joins a Virtual Hub to a network adapter or tap device of the server host at Layer 2, putting VPN clients on that LAN."
        actions={reachable && (
          <Button leftSection={<IconPlus size={14} />} onClick={() => setAdding({})} disabled={supported === false} data-testid="create-bridge">New Local Bridge…</Button>
        )}
      />
      {!reachable ? <Unreachable serverId={serverId} /> : (
        <>
          {(supported === false || support.data?.IsWinPcapNeeded_bool) && (
            <div className="sem-callouts" style={{ marginBottom: "var(--sem-space-5)" }}>
              {supported === false && <Callout tone="gray" testId="bridge-unsupported">This server’s operating system doesn’t support local bridges.</Callout>}
              {support.data?.IsWinPcapNeeded_bool && (
                <Callout tone="orange" title="A packet capture driver is required">Install WinPcap or Npcap on the server host before local bridges can operate.</Callout>
              )}
            </div>
          )}

          <DataTable
              testId="bridges-table"
              aria-label="Local bridges"
              data={list.data ? bridges : undefined}
              loading={list.isLoading || list.isFetching}
              error={list.error}
              onRetry={() => void list.refetch()}
              rowKey={bridgeKey}
              rowTestId={(b) => `bridge-row-${b.HubNameLB_str}-${b.DeviceName_str}`}
              selectable="single"
              selection={sel}
              onSelectionChange={(k) => setSel(k)}
              searchable={bridges.length > 6}
              initialSort={{ key: "HubNameLB_str", dir: "asc" }}
              onRowOpen={(b) => nav(hubBase(serverId, b.HubNameLB_str))}
              empty={{
                title: "No local bridges",
                description: supported === false ? "This server can’t bridge to its network adapters." : "Bridge a Virtual Hub to a network adapter to put VPN clients on that LAN.",
                icon: <IconArrowsExchange size={28} stroke={1.4} />,
                action: supported !== false ? <Button size="xs" variant="default" leftSection={<IconPlus size={13} />} onClick={() => setAdding({})}>New Local Bridge…</Button> : undefined,
              }}
              toolbar={(
                <Button size="xs" variant="default" c={selected ? "var(--sem-red)" : undefined} leftSection={<IconTrash size={13} />} disabled={!selected}
                  onClick={() => selected && remove(selected)} data-testid="bridge-delete">Delete…</Button>
              )}
              contextMenu={(b) => [
                { label: "Open Hub", icon: <IconExternalLink size={14} />, onClick: () => nav(hubBase(serverId, b.HubNameLB_str)), shortcut: "↩" },
                "divider",
                { label: "Delete Bridge…", icon: <IconTrash size={14} />, danger: true, onClick: () => remove(b), testId: "bridge-menu-delete" },
              ]}
              columns={[
                { key: "HubNameLB_str", title: "Virtual Hub", truncate: true, render: (b) => <span className="sem-strong" title={b.HubNameLB_str}>{b.HubNameLB_str}</span> },
                { key: "DeviceName_str", title: "Device", mono: true, truncate: true, render: (b) => b.DeviceName_str },
                {
                  key: "TapMode_bool", title: "Kind", width: 130,
                  render: (b) => <Tag color={b.TapMode_bool ? "purple" : "gray"}>{b.TapMode_bool ? "Tap device" : "Network adapter"}</Tag>,
                },
                { key: "status", title: "Status", width: 110, value: (b) => (b.Online_bool ? (b.Active_bool ? 2 : 1) : 0), render: (b) => <BridgeStatus b={b} /> },
              ]}
            />

          <SectionGrid>
            <Section title="Network adapters" description="Devices the server can bridge to (EnumEthernet).">
              <DataTable
                testId="ethernet-table"
                aria-label="Network adapters"
                data={eth.data ? adapters : undefined}
                loading={eth.isLoading}
                error={eth.error}
                onRetry={() => void eth.refetch()}
                rowKey={(e) => e.DeviceName_str}
                searchable={adapters.length > 8}
                footer={adapters.length > 8}
                selectable="single"
                onRowOpen={(e) => setAdding({ device: e.DeviceName_str })}
                empty={{ title: "No adapters reported", description: "The server listed no usable network adapters. You can still type a device name in New Local Bridge." }}
                contextMenu={(e) => [
                  { label: "New Bridge to This Adapter…", icon: <IconPlus size={14} />, onClick: () => setAdding({ device: e.DeviceName_str }) },
                ]}
                columns={[
                  { key: "DeviceName_str", title: "Device", mono: true, truncate: true },
                  { key: "NetworkConnectionName_utf", title: "Connection name", truncate: true, render: (e) => e.NetworkConnectionName_utf || <span className="sem-dim">–</span> },
                  {
                    key: "used", title: "Bridged to", width: 150,
                    value: (e) => bridges.filter((b) => b.DeviceName_str === e.DeviceName_str).map((b) => b.HubNameLB_str).join(", "),
                    render: (e) => {
                      const hubs = bridges.filter((b) => b.DeviceName_str === e.DeviceName_str);
                      return hubs.length ? <span className="sem-row-inline" style={{ gap: "var(--sem-space-2)" }}>{hubs.map((b) => <Tag key={b.HubNameLB_str} color="accent">{b.HubNameLB_str}</Tag>)}</span>
                        : <span className="sem-dim">–</span>;
                    },
                  },
                ]}
              />
            </Section>
            <Section title="Host support" description="What the server’s operating system allows." variant="inset" testId="bridge-support">
              {support.error ? <ErrorState error={support.error} inline onRetry={() => void support.refetch()} /> : !support.data ? <PropertySkeleton rows={3} /> : (
                <PropertyList labelWidth={170} items={[
                  { label: "Local bridges", value: supported ? <StatusBadge status="ok">Supported</StatusBadge> : <StatusBadge status="off">Not supported</StatusBadge> },
                  { label: "Packet capture driver", value: support.data.IsWinPcapNeeded_bool ? <StatusBadge status="warning">Required</StatusBadge> : "Not required" },
                  { label: "Tap devices", hint: "Virtual network interfaces created on the host. Linux only.", value: caps.isLoading ? undefined : tapSupported ? <StatusBadge status="ok">Supported</StatusBadge> : <span className="sem-dim">Not supported (Linux only)</span> },
                ]} />
              )}
            </Section>
          </SectionGrid>
        </>
      )}
      <NewBridgeSheet
        serverId={serverId} opened={!!adding} initialDevice={adding?.device} onClose={() => setAdding(null)}
        tapSupported={tapSupported} existing={bridges} adapters={adapters} adaptersError={eth.error}
        onCreated={(b) => setSel([bridgeKey(b)])}
      />
    </>
  );
}

function NewBridgeSheet({ serverId, opened, onClose, initialDevice, tapSupported, existing, adapters, adaptersError, onCreated }: {
  serverId: number; opened: boolean; onClose: () => void; initialDevice?: string; tapSupported: boolean; existing: Bridge[];
  adapters: EthItem[]; adaptersError: unknown; onCreated: (b: Bridge) => void;
}) {
  const hubs = useHubNames(serverId);
  const [hub, setHub] = useState("");
  const [mode, setMode] = useState<"adapter" | "tap">("adapter");
  const [device, setDevice] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [tapName, setTapName] = useState("");
  const add = useRpcMutation(serverId, "AddLocalBridge", {
    success: "Local bridge created",
    onSuccess: (_r, p) => { onCreated({ HubNameLB_str: String(p.HubNameLB_str), DeviceName_str: String(p.DeviceName_str), TapMode_bool: !!p.TapMode_bool, Online_bool: true, Active_bool: false }); onClose(); },
  });
  useEffect(() => {
    if (!opened) return;
    setHub(""); setMode("adapter"); setTapName(""); setCustom("");
    const known = initialDevice && adapters.some((a) => a.DeviceName_str === initialDevice);
    setDevice(initialDevice ? (known ? initialDevice : OTHER) : adapters.length ? null : OTHER);
    if (initialDevice && !known) setCustom(initialDevice);
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps

  const tap = mode === "tap";
  const devName = tap ? tapName.trim() : device === OTHER ? custom.trim() : device ?? "";
  const tapErr = tap && tapName.trim() && !/^[A-Za-z0-9_-]{1,11}$/.test(tapName.trim()) ? "Use up to 11 letters, digits, hyphens or underscores." : null;
  const dup = existing.some((b) => b.HubNameLB_str.toLowerCase() === hub.trim().toLowerCase() && b.DeviceName_str === devName && b.TapMode_bool === tap);
  const valid = !!hub.trim() && !!devName && !tapErr && !dup;
  const newHub = !!hub.trim() && hubs.data && !hubs.names.some((n) => n.toLowerCase() === hub.trim().toLowerCase());

  return (
    <FormSheet
      opened={opened} onClose={onClose} busy={add.isPending} size={580}
      title="New Local Bridge" subtitle="Joins a Virtual Hub to a network of the server host at Layer 2."
      icon={<IconArrowsExchange size={19} stroke={1.5} />}
      submitLabel="Create Bridge" submitTestId="bridge-create-submit" testId="bridge-create-sheet" valid={valid}
      note={dup ? <span style={{ color: "var(--sem-red)" }}>This hub is already bridged to that device.</span> : undefined}
      onSubmit={() => add.mutate({ HubNameLB_str: hub.trim(), DeviceName_str: devName, TapMode_bool: tap })}
    >
      <FormSection>
        <FormRow label="Virtual Hub" description={newHub ? "There’s no hub with this name yet. The bridge starts working once you create it." : "The hub whose traffic is bridged."}>
          {(id) => (
            <Autocomplete id={id} data={hubs.names} value={hub} onChange={setHub} placeholder="Choose or type a hub" data-autofocus
              data-testid="bridge-hub" comboboxProps={{ withinPortal: true }} />
          )}
        </FormRow>
        {tapSupported && (
          <FormRow label="Bridge to">
            <SegmentedControl value={mode} onChange={(v) => setMode(v as typeof mode)} data-testid="bridge-mode"
              data={[{ value: "adapter", label: "Network Adapter" }, { value: "tap", label: "New Tap Device" }]} />
          </FormRow>
        )}
        {tap ? (
          <FormRow label="Tap device name" description={<>The host interface is created as <Mono>tap_{tapName.trim() || "name"}</Mono>.</>} error={tapErr}>
            {(id) => <TextInput id={id} value={tapName} onChange={(e) => setTapName(e.currentTarget.value)} error={!!tapErr} maxLength={11} spellCheck={false} data-testid="bridge-tap-name" />}
          </FormRow>
        ) : (
          <>
            <FormRow label="Network adapter" description="A dedicated adapter is recommended under heavy load.">
              {(id) => adaptersError ? <ErrorState error={adaptersError} inline /> : (
                <Select
                  id={id} value={device} onChange={setDevice} searchable allowDeselect={false} nothingFoundMessage="No adapters" data-testid="bridge-device"
                  placeholder={adapters.length ? "Choose an adapter" : undefined}
                  data={[
                    ...adapters.map((e) => ({ value: e.DeviceName_str, label: e.NetworkConnectionName_utf && e.NetworkConnectionName_utf !== e.DeviceName_str ? `${e.DeviceName_str} — ${e.NetworkConnectionName_utf}` : e.DeviceName_str })),
                    { value: OTHER, label: "Other Device…" },
                  ]}
                />
              )}
            </FormRow>
            {device === OTHER && (
              <FormRow label="Device name" description={adapters.length ? "The exact device name on the host, for example eth1." : "The server listed no adapters, so enter the exact device name, for example eth1 or en0."}>
                {(id) => <TextInput id={id} value={custom} onChange={(e) => setCustom(e.currentTarget.value)} spellCheck={false} placeholder="eth1" data-testid="bridge-device-name" />}
              </FormRow>
            )}
          </>
        )}
      </FormSection>
      <div className="sem-callouts">
        <Callout tone="yellow" icon={<IconDeviceDesktopAnalytics size={16} stroke={1.7} />}>
          The adapter is put in promiscuous mode. Bridging the adapter you reach the server through can cause loops or cut you off.
        </Callout>
      </div>
    </FormSheet>
  );
}
