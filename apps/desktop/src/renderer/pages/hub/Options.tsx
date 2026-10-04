// Hub › Admin & Extended Options. Two editable option lists of a Virtual Hub:
//   * administration options (GetHubAdminOptions / SetHubAdminOptions, defaults from GetDefaultHubAdminOptions)
//   * extended options (GetHubExtOptions / SetHubExtOptions, factory defaults captured from a new hub)
// Values are u32; on/off options use 0 / non-zero. Saving sends the complete list, after one confirmation that
// lists every change. Ported from apps/web/src/pages/hub/Options.tsx.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { NumberInput, SegmentedControl, Tooltip } from "@mantine/core";
import { IconAdjustments, IconArrowBackUp, IconCopy, IconFocus2, IconRestore, IconShieldLock } from "@tabler/icons-react";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import { num } from "../../lib/format";
import { Callout, SaveBar } from "../../components/domain/ui";
import { DataTable, PageHeader, Tag } from "../../design";
import { HubUnreachable, useHubPage } from "./_hub-core/shared";

interface AdminOption { Name_str: string; Value_u32: number; Descrption_utf?: string }
interface AdminOptionList { HubName_str?: string; AdminOptionList?: AdminOption[]; NumItem_u32?: number }

/**
 * Factory defaults of the Virtual Hub extended options. SoftEther has no "GetDefaultHubExtOptions" RPC, so these were
 * captured from a freshly created hub (SoftEther VPN 5.x). Options missing here are shown without a default.
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

interface Row { name: string; desc: string; current: number; def: number | undefined }
type View = "all" | "nondefault" | "modified";
type Kind = "admin" | "ext";

const KINDS: Record<Kind, { title: string; get: string; set: string; testId: string; defaultsNote: string }> = {
  admin: {
    title: "Administration options", get: "GetHubAdminOptions", set: "SetHubAdminOptions", testId: "admin-options-table",
    defaultsNote: "Defaults come from the server (GetDefaultHubAdminOptions).",
  },
  ext: {
    title: "Extended options", get: "GetHubExtOptions", set: "SetHubExtOptions", testId: "ext-options-table",
    defaultsNote: "Defaults are the factory values of a new hub on SoftEther VPN 5.x.",
  },
};

function OptionsEditor({ kind, serverId, hub, defaults, defaultsError, onModified }: {
  kind: Kind; serverId: number; hub: string; defaults: Record<string, number> | undefined; defaultsError?: boolean;
  onModified?: (count: number) => void;
}) {
  const k = KINDS[kind];
  const q = useRpc<AdminOptionList>(serverId, k.get, { HubName_str: hub });
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [view, setView] = useState<View>("all");
  const tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => setEdits({}), [q.data]);

  const rows = useMemo<Row[]>(() => (q.data?.AdminOptionList ?? []).map((o) => ({
    name: o.Name_str, desc: o.Descrption_utf ?? "", current: Number(o.Value_u32 ?? 0), def: defaults?.[o.Name_str],
  })), [q.data, defaults]);
  const valueOf = (r: Row) => (r.name in edits ? edits[r.name] : r.current);
  const modified = rows.filter((r) => valueOf(r) !== r.current);
  const nonDefault = rows.filter((r) => r.def !== undefined && valueOf(r) !== r.def);
  const shown = view === "modified" ? modified : view === "nondefault" ? nonDefault : rows;
  useEffect(() => onModified?.(modified.length), [modified.length, onModified]);

  const setValue = (r: Row, v: number) => setEdits((e) => {
    const next = { ...e };
    if (v === r.current) delete next[r.name]; else next[r.name] = v;
    return next;
  });

  const save = useRpcMutation<Record<string, unknown>>(serverId, k.set, {
    success: `${k.title} saved`,
    confirm: () => ({
      title: <>Save {modified.length === 1 ? "1 change" : `${modified.length} changes`} to “{hub}”?</>,
      message: kind === "admin"
        ? "Administration options limit what the hub and its own administrators can do. The complete list is sent to the server."
        : "Extended options change how the hub handles traffic and sessions. The complete list is sent to the server.",
      details: (
        <ul className="sem-dim" style={{ margin: 0, paddingLeft: 18, fontSize: "var(--sem-fz-small)" }} data-testid={`${k.testId}-changes`}>
          {modified.slice(0, 12).map((r) => <li key={r.name}><span className="sem-mono">{r.name}</span>: {num(r.current)} → {num(valueOf(r))}</li>)}
          {modified.length > 12 && <li>…and {modified.length - 12} more</li>}
        </ul>
      ),
      confirmLabel: "Save Changes", tone: "warning", testId: `${k.testId}-confirm`,
    }),
  });
  const onSave = () => save.mutate({
    HubName_str: hub,
    AdminOptionList: rows.map((r) => ({ Name_str: r.name, Value_u32: valueOf(r), Descrption_utf: "" })),
  });
  const focusInput = (r: Row) => tableRef.current?.querySelector<HTMLInputElement>(`[data-testid="opt-${CSS.escape(r.name)}"]`)?.focus();

  return (
    <div ref={tableRef} data-testid={k.testId}>
      <DataTable
        aria-label={k.title}
        data={q.data ? shown : undefined}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        rowKey={(r) => r.name}
        selectable="single"
        searchPlaceholder="Filter options"
        initialSort={{ key: "name", dir: "asc" }}
        onRowOpen={focusInput}
        rowTestId={(r) => `opt-row-${r.name}`}
        empty={view === "all" ? { title: "No options", description: "The server didn’t report any options for this hub." }
          : { title: view === "modified" ? "No unsaved changes" : "Everything is at its default", description: "Show all options to edit them." }}
        filters={(
          <SegmentedControl
            value={view} onChange={(v) => setView(v as View)} data-testid={`${k.testId}-filter`}
            data={[
              { value: "all", label: "All" },
              { value: "nondefault", label: `Non-Default (${nonDefault.length})` },
              { value: "modified", label: `Unsaved (${modified.length})` },
            ]}
          />
        )}
        contextMenu={(r) => [
          { label: "Edit Value", icon: <IconFocus2 size={14} />, onClick: () => focusInput(r) },
          { label: r.def === undefined ? "Reset to Default" : `Reset to Default (${num(r.def)})`, icon: <IconRestore size={14} />,
            disabled: r.def === undefined || valueOf(r) === r.def, onClick: () => r.def !== undefined && setValue(r, r.def), testId: `opt-reset-${r.name}` },
          { label: "Revert Change", icon: <IconArrowBackUp size={14} />, disabled: valueOf(r) === r.current, onClick: () => setValue(r, r.current) },
          "divider",
          { label: "Copy Name", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(r.name) },
        ]}
        columns={[
          {
            key: "name", title: "Option", width: "30%",
            render: (r) => {
              const v = valueOf(r);
              return (
                <span className="sem-row-inline" style={{ flexWrap: "nowrap", gap: "var(--sem-space-3)", maxWidth: "100%" }}>
                  <span className="sem-mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }} title={r.name}>{r.name}</span>
                  {v !== r.current ? <Tag color="accent" variant="solid">Edited</Tag>
                    : r.def !== undefined && v !== r.def ? <Tag color="orange">Custom</Tag> : null}
                </span>
              );
            },
          },
          {
            key: "desc", title: "Description", sortable: false,
            render: (r) => r.desc
              ? <Tooltip label={r.desc} multiline maw={420} openDelay={400}><span className="sem-dim" style={CLAMP}>{r.desc}</span></Tooltip>
              : <span className="sem-dim">–</span>,
          },
          { key: "def", title: "Default", align: "right", width: 96, value: (r) => r.def ?? -1, render: (r) => <span className="sem-dim sem-num">{r.def === undefined ? "–" : num(r.def)}</span> },
          {
            key: "value", title: "Value", align: "right", width: 150, value: (r) => valueOf(r),
            render: (r) => {
              const v = valueOf(r);
              return (
                <NumberInput
                  size="xs" w={130} ml="auto" min={0} max={4294967295} allowDecimal={false} allowNegative={false} hideControls
                  value={v} aria-label={`Value of ${r.name}`} data-testid={`opt-${r.name}`}
                  styles={{ input: { textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: r.def !== undefined && v !== r.def ? 600 : undefined } }}
                  onChange={(x) => setValue(r, Number(x) || 0)}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                />
              );
            },
          },
        ]}
      />
      <div className="sem-form-section-footer">
        {k.defaultsNote} {defaultsError ? "They couldn’t be loaded, so differences aren’t marked." : "Options that differ from their default are marked Custom."}
      </div>
      <SaveBar dirty={modified.length > 0} saving={save.isPending} onReset={() => setEdits({})} onSave={onSave}
        saveLabel={modified.length > 1 ? `Save ${modified.length} Changes` : modified.length ? "Save 1 Change" : "Save"} testId={`${k.testId}-save`} />
    </div>
  );
}

export default function HubOptionsPage() {
  const { serverId, hub, hubAdminMode, ready, server } = useHubPage();
  const [tab, setTabState] = useState<Kind>("admin");
  // Both editors stay mounted once opened, so unsaved edits survive switching between the two lists.
  const [opened, setOpened] = useState<Record<Kind, boolean>>({ admin: true, ext: false });
  const setTab = (k: Kind) => { setTabState(k); setOpened((o) => ({ ...o, [k]: true })); };
  const [unsaved, setUnsaved] = useState<Record<Kind, number>>({ admin: 0, ext: 0 });
  const onAdmin = useCallback((n: number) => setUnsaved((u) => (u.admin === n ? u : { ...u, admin: n })), []);
  const onExt = useCallback((n: number) => setUnsaved((u) => (u.ext === n ? u : { ...u, ext: n })), []);
  const mark = (k: Kind) => (unsaved[k] && tab !== k ? <span style={{ color: "var(--sem-orange-dot)", fontSize: "var(--sem-fz-caption)" }} title="Unsaved changes" aria-label="Unsaved changes" data-testid={`tab-${k}-unsaved`}>●</span> : null);
  const defaults = useRpc<AdminOptionList>(serverId, "GetDefaultHubAdminOptions", { HubName_str: hub }, { enabled: ready, staleTime: 10 * 60_000 });
  const adminDefaults = useMemo(() => {
    const list = defaults.data?.AdminOptionList;
    return list ? Object.fromEntries(list.map((o) => [o.Name_str, Number(o.Value_u32 ?? 0)])) : undefined;
  }, [defaults.data]);

  if (!server.data) return null;
  return (
    <>
      <PageHeader
        title="Admin & Extended Options"
        description="Limits and switches of this Virtual Hub. For on/off options, 0 is off and any other value is on."
        actions={ready && (
          <SegmentedControl
            size="sm" value={tab} onChange={(v) => setTab(v as Kind)}
            data={[
              { value: "admin", label: <span className="sem-row-inline" style={{ gap: 6, flexWrap: "nowrap" }} data-testid="tab-admin-options"><IconShieldLock size={14} />Administration{mark("admin")}</span> },
              { value: "ext", label: <span className="sem-row-inline" style={{ gap: 6, flexWrap: "nowrap" }} data-testid="tab-ext-options"><IconAdjustments size={14} />Extended{mark("ext")}</span> },
            ]}
          />
        )}
      />
      {!ready ? <HubUnreachable serverId={serverId} /> : (
        <>
          <div className="sem-callouts" style={{ marginTop: 0, marginBottom: "var(--sem-space-6)" }}>
            {tab === "admin" ? (
              <Callout tone="accent" icon={<IconShieldLock size={16} stroke={1.7} />} testId="admin-options-note">
                Limits the server administrator sets for this hub and its own administrators, such as <span className="sem-mono">max_users</span> or{" "}
                <span className="sem-mono">no_cascade</span>. 0 means no limit. Hub administrators can change them only when{" "}
                <span className="sem-mono">allow_hub_admin_change_option</span> is 1.
                {hubAdminMode && <> This connection is in hub admin mode, so the server may refuse to save.</>}
              </Callout>
            ) : (
              <Callout tone="accent" icon={<IconAdjustments size={16} stroke={1.7} />} testId="ext-options-note">
                Advanced tuning: address tables, packet filters, TCP MSS, SecureNAT limits, RADIUS VLANs and the privacy filter. Server and hub
                administrators can change them unless <span className="sem-mono">deny_hub_admin_change_ext_option</span> is set. Change them only if you
                understand the effect.
              </Callout>
            )}
          </div>
          <div hidden={tab !== "admin"}>
            <OptionsEditor kind="admin" serverId={serverId} hub={hub} defaults={adminDefaults} defaultsError={!!defaults.error} onModified={onAdmin} />
          </div>
          {opened.ext && (
            <div hidden={tab !== "ext"}>
              <OptionsEditor kind="ext" serverId={serverId} hub={hub} defaults={EXT_DEFAULTS} onModified={onExt} />
            </div>
          )}
        </>
      )}
    </>
  );
}

// Two-line clamp for long option descriptions (the table never wraps cells by default).
const CLAMP: CSSProperties = {
  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "normal",
  lineHeight: 1.35, fontSize: "var(--sem-fz-small)",
};
