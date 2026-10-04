import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon, Alert, Badge, Group, NumberInput, SegmentedControl, Spoiler, Tabs, Text, Tooltip,
} from "@mantine/core";
import { IconAdjustments, IconArrowBackUp, IconInfoCircle, IconShieldLock } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { SaveBar, useHubAccess } from "../../components/hub-a/shared";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import { num } from "../../lib/format";

interface AdminOption { Name_str: string; Value_u32: number; Descrption_utf?: string }
interface AdminOptionList { HubName_str?: string; AdminOptionList?: AdminOption[]; NumItem_u32?: number }

/**
 * Factory defaults of the Virtual Hub Extended Options. SoftEther has no
 * "GetDefaultHubExtOptions" RPC, so these were captured from a freshly created hub
 * (SoftEther VPN 5.x). Options missing here are shown without a default.
 */
const EXT_DEFAULTS: Record<string, number> = {
  NoAddressPollingIPv4: 0, NoAddressPollingIPv6: 0, NoIpTable: 0, NoMacAddressLog: 1, ManageOnlyPrivateIP: 1,
  ManageOnlyLocalUnicastIPv6: 1, DisableIPParsing: 0, YieldAfterStorePacket: 0, NoSpinLockForPacketDelay: 0,
  BroadcastStormDetectionThreshold: 0, ClientMinimumRequiredBuild: 0, FilterPPPoE: 0, FilterOSPF: 0, FilterIPv4: 0,
  FilterIPv6: 0, FilterNonIP: 0, NoIPv4PacketLog: 0, NoIPv6PacketLog: 0, FilterBPDU: 0, NoIPv6DefaultRouterInRAWhenIPv6: 0,
  NoLookBPDUBridgeId: 0, NoManageVlanId: 0, VlanTypeId: 33024, FixForDLinkBPDU: 0, RequiredClientId: 0, AdjustTcpMssValue: 0,
  DisableAdjustTcpMss: 0, NoDhcpPacketLogOutsideHub: 1, DisableHttpParsing: 0, DisableUdpAcceleration: 0,
  DisableUdpFilterForLocalBridgeNic: 0, ApplyIPv4AccessListOnArpPacket: 0, RemoveDefGwOnDhcpForLocalhost: 1,
  SecureNAT_MaxTcpSessionsPerIp: 0, SecureNAT_MaxTcpSynSentPerIp: 0, SecureNAT_MaxUdpSessionsPerIp: 0,
  SecureNAT_MaxDnsSessionsPerIp: 0, SecureNAT_MaxIcmpSessionsPerIp: 0, AccessListIncludeFileCacheLifetime: 30,
  DisableKernelModeSecureNAT: 0, DisableIpRawModeSecureNAT: 0, DisableUserModeSecureNAT: 0, DisableCheckMacOnLocalBridge: 0,
  DisableCorrectIpOffloadChecksum: 0, BroadcastLimiterStrictMode: 0, MaxLoggedPacketsPerMinute: 0, DoNotSaveHeavySecurityLogs: 0,
  DropBroadcastsInPrivacyFilterMode: 1, DropArpInPrivacyFilterMode: 1, AllowSameUserInPrivacyFilterMode: 0,
  SuppressClientUpdateNotification: 0, FloodingSendQueueBufferQuota: 33554432, AssignVLanIdByRadiusAttribute: 0,
  DenyAllRadiusLoginWithNoVlanAssign: 0, SecureNAT_RandomizeAssignIp: 0, DetectDormantSessionInterval: 0,
  NoPhysicalIPOnPacketLog: 0, UseHubNameAsDhcpUserClassOption: 0, UseHubNameAsRadiusNasId: 0, AllowEapMatchUserByCert: 0,
  DhcpDiscoverTimeoutMs: 5000,
};

interface Row { name: string; desc: string; current: number; value: number; def: number | undefined }

type Filter = "all" | "nondefault" | "modified";

function OptionsEditor({
  kind, serverId, hub, canWrite, getMethod, setMethod, defaults, defaultsNote, testId,
}: {
  kind: string; serverId: number; hub: string; canWrite: boolean; getMethod: string; setMethod: string;
  defaults: Record<string, number> | undefined; defaultsNote: string; testId: string;
}) {
  const q = useRpc<AdminOptionList>(serverId, getMethod, { HubName_str: hub }, { enabled: !!hub });
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<Filter>("all");
  useEffect(() => setEdits({}), [q.data]);
  const save = useRpcMutation(serverId, setMethod, { success: `${kind} saved` });

  const allRows = useMemo<Row[]>(() => (q.data?.AdminOptionList ?? []).map((o) => ({
    name: o.Name_str,
    desc: o.Descrption_utf ?? "",
    current: Number(o.Value_u32 ?? 0),
    value: Number(o.Value_u32 ?? 0),
    def: defaults?.[o.Name_str],
  })), [q.data, defaults]);

  const valueOf = (r: Row) => (r.name in edits ? edits[r.name] : r.current);
  const modified = allRows.filter((r) => valueOf(r) !== r.current);
  const nonDefault = allRows.filter((r) => r.def !== undefined && valueOf(r) !== r.def);
  const rows = filter === "modified" ? allRows.filter((r) => valueOf(r) !== r.current)
    : filter === "nondefault" ? allRows.filter((r) => r.def !== undefined && valueOf(r) !== r.def) : allRows;

  const onSave = () => save.mutate({
    HubName_str: hub,
    AdminOptionList: allRows.map((r) => ({ Name_str: r.name, Value_u32: valueOf(r), Descrption_utf: "" })),
  });

  return (
    <QueryState query={q}>
      <DataTable
        testId={testId}
        data={rows}
        rowKey={(r) => r.name}
        initialSort={undefined}
        empty={filter === "all" ? "No options reported by the server" : "No options match this view"}
        toolbar={
          <Group gap="xs">
            <Badge variant="light" color={nonDefault.length ? "yellow" : "gray"}>{nonDefault.length} non-default</Badge>
            <SegmentedControl size="xs" value={filter} onChange={(v) => setFilter(v as Filter)} data-testid={`${testId}-filter`}
              data={[{ value: "all", label: "All" }, { value: "nondefault", label: "Non-default" }, { value: "modified", label: `Unsaved (${modified.length})` }]} />
          </Group>
        }
        columns={[
          {
            key: "name", title: "Option", width: 280,
            render: (r) => {
              const v = valueOf(r);
              return (
                <Group gap={6} wrap="nowrap">
                  <Text size="sm" ff="monospace" fw={r.def !== undefined && v !== r.def ? 700 : 400}>{r.name}</Text>
                  {v !== r.current && <Badge size="xs" color="blue" variant="filled">edited</Badge>}
                  {r.def !== undefined && v !== r.def && v === r.current && <Badge size="xs" color="yellow" variant="light">custom</Badge>}
                </Group>
              );
            },
          },
          {
            key: "desc", title: "Description", sortable: false,
            render: (r) => r.desc
              ? <Spoiler maxHeight={40} showLabel="more" hideLabel="less"><Text size="xs" c="dimmed">{r.desc}</Text></Spoiler>
              : <Text size="xs" c="dimmed">–</Text>,
          },
          {
            key: "def", title: "Default", align: "right", width: 110,
            value: (r) => r.def ?? -1,
            render: (r) => <Text size="sm" c="dimmed">{r.def === undefined ? "–" : num(r.def)}</Text>,
          },
          {
            key: "value", title: "Value", width: 210, align: "right",
            value: (r) => valueOf(r),
            render: (r) => {
              const v = valueOf(r);
              const differs = r.def !== undefined && v !== r.def;
              return (
                <Group gap={4} justify="flex-end" wrap="nowrap">
                  <NumberInput
                    size="xs" w={150} min={0} max={4294967295} allowDecimal={false} allowNegative={false}
                    value={v}
                    readOnly={!canWrite}
                    aria-label={`Value of ${r.name}`}
                    data-testid={`opt-${r.name}`}
                    styles={differs ? { input: { borderColor: "var(--mantine-color-yellow-6)", fontWeight: 700 } } : undefined}
                    onChange={(x) => setEdits((e) => {
                      const nv = Number(x) || 0;
                      const next = { ...e };
                      if (nv === r.current) delete next[r.name]; else next[r.name] = nv;
                      return next;
                    })}
                  />
                  {canWrite && r.def !== undefined && (
                    <Tooltip label={`Reset to default (${r.def})`}>
                      <ActionIcon variant="subtle" size="sm" disabled={v === r.def} aria-label={`Reset ${r.name} to default`}
                        onClick={() => setEdits((e) => {
                          const next = { ...e };
                          if (r.def === r.current) delete next[r.name]; else next[r.name] = r.def!;
                          return next;
                        })}>
                        <IconArrowBackUp size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
              );
            },
          },
        ]}
      />
      <Text size="xs" c="dimmed" mt="xs">{defaultsNote}</Text>
      {canWrite && (
        <SaveBar dirty={modified.length > 0} saving={save.isPending} onReset={() => setEdits({})} onSave={onSave}
          saveLabel={modified.length ? `Save ${modified.length} change(s)` : "Save changes"} testId={`${testId}-save`} />
      )}
    </QueryState>
  );
}

export default function HubOptionsPage() {
  const { serverId, hub, role, canWrite, hubAdminMode } = useHubAccess();
  const [tab, setTab] = useState<string | null>("admin");
  const defaults = useRpc<AdminOptionList>(serverId, "GetDefaultHubAdminOptions", { HubName_str: hub }, { enabled: !!hub, staleTime: 10 * 60_000 });
  const adminDefaults = useMemo(() => {
    const list = defaults.data?.AdminOptionList;
    return list ? Object.fromEntries(list.map((o) => [o.Name_str, Number(o.Value_u32 ?? 0)])) : undefined;
  }, [defaults.data]);

  return (
    <>
      <PageHeader
        title="Hub options"
        description="Fine-grained limits and behaviour switches of this Virtual Hub. Values are integers; for on/off options 0 = disabled and any non-zero value = enabled. Saving sends the complete list."
      />
      {!canWrite && <ReadOnlyNotice role={role} />}
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="admin" leftSection={<IconShieldLock size={16} />} data-testid="tab-admin-options">Administration options</Tabs.Tab>
          <Tabs.Tab value="ext" leftSection={<IconAdjustments size={16} />} data-testid="tab-ext-options">Extended options</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="admin">
          <Section
            title="Virtual Hub administration options"
            description="Limits that the server administrator imposes on this hub and on its delegated hub administrators (e.g. max_users, max_sessions, no_cascade, deny_bridge). 0 means no limit / not restricted."
          >
            <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />} mb="md">
              Only the VPN Server administrator can change these options. Hub administrators can view them, and can edit them only
              when <Text span ff="monospace" size="sm">allow_hub_admin_change_option</Text> is set to 1.
              {hubAdminMode && " You are connected in hub-admin mode, so saving may be refused."}
            </Alert>
            {defaults.error && <Text size="xs" c="dimmed" mb="xs">Default values could not be loaded; differences from defaults are not highlighted.</Text>}
            <OptionsEditor
              kind="Administration options" serverId={serverId} hub={hub} canWrite={canWrite}
              getMethod="GetHubAdminOptions" setMethod="SetHubAdminOptions" defaults={adminDefaults}
              defaultsNote="Defaults come from GetDefaultHubAdminOptions. Values that differ from the default are shown in bold with a highlighted input."
              testId="admin-options-table"
            />
          </Section>
        </Tabs.Panel>
        <Tabs.Panel value="ext">
          <Section
            title="Virtual Hub extended options"
            description="Advanced behaviour tuning (address table maintenance, packet filtering, TCP MSS, SecureNAT limits, RADIUS VLAN assignment, privacy filter, …). Change only when you understand the effect."
          >
            <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />} mb="md">
              Both server and hub administrators may change extended options unless the administration option
              {" "}<Text span ff="monospace" size="sm">deny_hub_admin_change_ext_option</Text> is set.
            </Alert>
            <OptionsEditor
              kind="Extended options" serverId={serverId} hub={hub} canWrite={canWrite}
              getMethod="GetHubExtOptions" setMethod="SetHubExtOptions" defaults={EXT_DEFAULTS}
              defaultsNote="Defaults are the factory values of a newly created hub (SoftEther VPN 5.x). Values that differ are shown in bold with a highlighted input."
              testId="ext-options-table"
            />
          </Section>
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
