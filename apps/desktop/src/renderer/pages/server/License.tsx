// Server › License & VLAN: commercial-edition licensing (GetLicenseStatus, Enum/Add/DelLicenseKey) and the
// Windows-only VLAN tag pass-through driver setting (EnumEthVLan / SetEnableEthVLan). Both are "not applicable"
// on SoftEther open-source builds and non-Windows servers, which the page explains instead of showing errors.
import { useEffect, useState } from "react";
import { Button, Group, Textarea } from "@mantine/core";
import { IconCopy, IconKey, IconLicense, IconNetwork, IconPlus, IconToggleLeft, IconTrash } from "@tabler/icons-react";
import { dt, isNever, num } from "../../lib/format";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import {
  DataTable, FormRow, FormSection, Mono, PageHeader, PropertyList, PropertySkeleton, Section, Sheet, StatusBadge, Tag, type ContextMenuItem, type RowKey,
} from "../../design";
import { NotApplicable, isUnsupported } from "../../components/domain/ui";
import { HubModeNotice, Unreachable, useServerPage } from "./_server-protocols-security/shared";

interface LicenseKey {
  Id_u32: number; LicenseKey_str: string; LicenseId_str: string; LicenseName_str: string; Expires_dt: string; Status_u32: number;
  ProductId_u32: number; SystemId_u64: number; SerialId_u32: number;
}
interface LicenseStatus {
  EditionId_u32: number; EditionStr_str: string; SystemId_u64: number; SystemExpires_dt: string; NumClientConnectLicense_u32: number;
  NumBridgeConnectLicense_u32: number; NeedSubscription_bool: boolean; AllowEnterpriseFunction_bool: boolean; SubscriptionExpires_dt: string;
  IsSubscriptionExpired_bool: boolean; NumUserCreationLicense_u32: number; ReleaseDate_dt: string;
}
interface VlanDev { DeviceName_str: string; Guid_str: string; DeviceInstanceId_str: string; DriverName_str: string; DriverType_str: string; Support_bool: boolean; Enabled_bool: boolean }

const unlimited = (n: number) => (n >= 0x7fffffff ? "Unlimited" : num(n));
const KEY_RE = /^[0-9A-Za-z]{6}(-[0-9A-Za-z]{6}){5}$/;

function AddKeySheet({ serverId, opened, onClose }: { serverId: number; opened: boolean; onClose: () => void }) {
  const [key, setKey] = useState("");
  useEffect(() => { if (opened) setKey(""); }, [opened]);
  const add = useRpcMutation<{ StrValue_str: string }>(serverId, "AddLicenseKey", { success: "License key added", onSuccess: () => onClose() });
  const k = key.trim();
  const ok = KEY_RE.test(k) || k.length >= 16;
  return (
    <Sheet opened={opened} onClose={onClose} busy={add.isPending} title="Add License Key" subtitle="The server checks the key against its System ID."
      icon={<IconLicense size={19} stroke={1.5} />} testId="license-add-sheet"
      footer={(
        <Group justify="flex-end" gap={8}>
          <Button variant="default" onClick={onClose} disabled={add.isPending}>Cancel</Button>
          <Button onClick={() => ok && add.mutate({ StrValue_str: k })} loading={add.isPending} disabled={!ok} data-testid="add-license-key">Add Key…</Button>
        </Group>
      )}>
      <FormSection>
        <FormRow stacked label="License key" description="Six groups of six characters, separated by hyphens.">
          {(id) => <Textarea id={id} autosize minRows={2} value={key} onChange={(e) => setKey(e.currentTarget.value)} spellCheck={false} data-autofocus
            styles={{ input: { fontFamily: "var(--sem-font-mono)" } }} placeholder="XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX" data-testid="license-key-input" />}
        </FormRow>
      </FormSection>
    </Sheet>
  );
}

function Licensing({ serverId, enabled }: { serverId: number; enabled: boolean }) {
  const status = useRpc<LicenseStatus>(serverId, "GetLicenseStatus", {}, { enabled, retry: false });
  const keys = useRpc<{ LicenseKeyList?: LicenseKey[] }>(serverId, "EnumLicenseKey", {}, { enabled, retry: false });
  const del = useRpcMutation<{ IntValue_u32: number }>(serverId, "DelLicenseKey", {
    success: "License key removed",
    confirm: (p) => {
      const r = keys.data?.LicenseKeyList?.find((x) => x.Id_u32 === p.IntValue_u32);
      return {
        title: <>Remove the license “{r?.LicenseName_str ?? p.IntValue_u32}”?</>,
        message: "Features and connection counts granted by this license stop working immediately. To undo it, enter the key again.",
        confirmLabel: "Remove License",
        typeToConfirm: String(p.IntValue_u32),
        typeLabel: <>To confirm, type the license ID <span className="sem-code-inline">{p.IntValue_u32}</span></>,
        testId: "remove-license",
      };
    },
  });
  const [adding, setAdding] = useState(false);
  const [sel, setSel] = useState<RowKey[]>([]);
  const selectedKey = keys.data?.LicenseKeyList?.find((r) => sel.includes(r.Id_u32));
  const d = status.data;

  // The open-source edition answers both calls with "not supported": one explanation is enough.
  if (isUnsupported(status.error) && isUnsupported(keys.error)) {
    return (
      <Section title="License" testId="license-section">
        <NotApplicable error={status.error} title="Licenses don’t apply to this server" testId="license-not-applicable">
          SoftEther VPN open-source builds have no license keys: every feature is available without limits. Licensing only exists on the
          commercial PacketiX VPN Server editions.
        </NotApplicable>
      </Section>
    );
  }

  const menu = (r: LicenseKey): ContextMenuItem[] => [
    { label: "Copy Key", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(r.LicenseKey_str) },
    "divider",
    { label: "Remove License…", icon: <IconTrash size={14} />, danger: true, onClick: () => del.mutate({ IntValue_u32: r.Id_u32 }), testId: `remove-license-${r.Id_u32}` },
  ];

  return (
    <>
      <Section title="License status" variant="inset" testId="license-status">
        {status.error ? (
          <NotApplicable error={status.error} title="The server doesn’t report a license status" onRetry={() => void status.refetch()}>
            License status is only available on commercial PacketiX VPN editions.
          </NotApplicable>
        ) : !d ? <PropertySkeleton rows={6} /> : (
          <PropertyList labelWidth={200} items={[
            { label: "Edition", value: <span className="sem-cell-title"><span className="sem-strong">{d.EditionStr_str}</span><Tag variant="outline">ID {d.EditionId_u32}</Tag></span> },
            { label: "System ID", value: <Mono>{String(d.SystemId_u64)}</Mono> },
            { label: "System expires", value: isNever(d.SystemExpires_dt) ? "Never" : dt(d.SystemExpires_dt) },
            { label: "Client connections", value: unlimited(d.NumClientConnectLicense_u32) },
            { label: "Bridge connections", value: unlimited(d.NumBridgeConnectLicense_u32) },
            { label: "User creation", value: unlimited(d.NumUserCreationLicense_u32) },
            { label: "Enterprise functions", value: <StatusBadge status={d.AllowEnterpriseFunction_bool ? "ok" : "off"}>{d.AllowEnterpriseFunction_bool ? "Allowed" : "Not allowed"}</StatusBadge> },
            { label: "Subscription", value: d.NeedSubscription_bool
              ? <span className="sem-cell-title">{dt(d.SubscriptionExpires_dt)}<StatusBadge status={d.IsSubscriptionExpired_bool ? "error" : "ok"}>{d.IsSubscriptionExpired_bool ? "Expired" : "Active"}</StatusBadge></span>
              : "Not required" },
            { label: "Build release date", value: dt(d.ReleaseDate_dt) },
          ]} />
        )}
      </Section>
      <Section
        title="License keys"
        description="Keys registered on this server."
        actions={!keys.error && <Button size="xs" variant="default" leftSection={<IconPlus size={13} />} onClick={() => setAdding(true)} data-testid="open-add-license">Add License Key…</Button>}
      >
        {keys.error ? (
          <NotApplicable error={keys.error} title="This edition doesn’t use license keys" onRetry={() => void keys.refetch()}>
            The server reports that license keys aren’t supported, as expected on SoftEther VPN open-source builds.
          </NotApplicable>
        ) : (
          <DataTable
            testId="license-keys-table" aria-label="License keys"
            data={keys.data?.LicenseKeyList} loading={keys.isLoading} rowKey={(r) => r.Id_u32} selectable="single" searchable={false}
            initialSort={{ key: "Id_u32", dir: "asc" }} contextMenu={menu} selection={sel} onSelectionChange={setSel}
            rowTestId={(r) => `license-row-${r.Id_u32}`}
            toolbar={selectedKey && (
              <Button size="xs" variant="default" c="var(--sem-red)" leftSection={<IconTrash size={13} />} data-testid="remove-license-selected"
                onClick={() => del.mutate({ IntValue_u32: selectedKey.Id_u32 })}>Remove License…</Button>
            )}
            empty={{ title: "No license keys", icon: <IconKey size={28} stroke={1.4} />, description: "Add a key to unlock the features of your edition." }}
            columns={[
              { key: "Id_u32", title: "ID", width: 60, align: "right" },
              { key: "LicenseName_str", title: "License", render: (r) => <span className="sem-cell-title"><span className="sem-strong">{r.LicenseName_str}</span><span className="sem-dim">{r.LicenseId_str}</span></span> },
              { key: "LicenseKey_str", title: "Key", mono: true },
              { key: "Status_u32", title: "Status", width: 110, render: (r) => <StatusBadge status={r.Status_u32 === 0 ? "ok" : "warning"}>{r.Status_u32 === 0 ? "Valid" : `Code ${r.Status_u32}`}</StatusBadge> },
              { key: "Expires_dt", title: "Expires", width: 150, render: (r) => (isNever(r.Expires_dt) ? "Never" : dt(r.Expires_dt)) },
              { key: "ProductId_u32", title: "Product / serial", width: 130, render: (r) => <span className="sem-num">{r.ProductId_u32} / {r.SerialId_u32}</span> },
            ]}
          />
        )}
      </Section>
      <AddKeySheet serverId={serverId} opened={adding} onClose={() => setAdding(false)} />
    </>
  );
}

function Vlan({ serverId, enabled }: { serverId: number; enabled: boolean }) {
  const q = useRpc<{ Devices?: VlanDev[] }>(serverId, "EnumEthVLan", {}, { enabled, retry: false });
  const [sel, setSel] = useState<RowKey[]>([]);
  const devKey = (r: VlanDev) => r.Guid_str || r.DeviceName_str;
  const selectedDev = q.data?.Devices?.find((r) => sel.includes(devKey(r)));
  const set = useRpcMutation<{ StrValue_str: string; IntValue_u32: number }>(serverId, "SetEnableEthVLan", {
    success: "VLAN pass-through changed",
    confirm: (p) => ({
      title: <>{p.IntValue_u32 ? "Turn on" : "Turn off"} VLAN pass-through on “{q.data?.Devices?.find((r) => devKey(r) === p.StrValue_str)?.DeviceName_str ?? p.StrValue_str}”?</>,
      message: "Windows restarts the network adapter, which briefly interrupts all traffic through it, including remote management if it uses this adapter.",
      confirmLabel: p.IntValue_u32 ? "Turn On" : "Turn Off",
      tone: "warning",
      testId: "vlan-toggle",
    }),
  });
  const toggle = (r: VlanDev) => set.mutate({ StrValue_str: devKey(r), IntValue_u32: r.Enabled_bool ? 0 : 1 });
  return (
    <Section
      title="VLAN tag pass-through"
      description="On Windows, most network drivers strip 802.1Q VLAN tags. For supported Intel and Broadcom adapters the server can change the driver setting so tagged frames reach local bridges."
      testId="vlan-section"
    >
      {q.error ? (
        <NotApplicable error={q.error} title="Only available on Windows servers" onRetry={() => void q.refetch()} testId="vlan-not-applicable">
          This is a Windows driver setting. On Linux, macOS and BSD servers VLAN tags pass through natively when bridging to an interface.
        </NotApplicable>
      ) : (
        <DataTable
          testId="vlan-table" aria-label="Network adapters"
          data={q.data?.Devices} loading={q.isLoading} rowKey={devKey} selectable="single" selection={sel} onSelectionChange={setSel}
          toolbar={selectedDev && (
            <Button size="xs" variant="default" leftSection={<IconToggleLeft size={13} />} disabled={!selectedDev.Support_bool} onClick={() => toggle(selectedDev)} data-testid="vlan-toggle-selected">
              {selectedDev.Enabled_bool ? "Turn Off Pass-Through…" : "Turn On Pass-Through…"}
            </Button>
          )}
          initialSort={{ key: "DeviceName_str", dir: "asc" }}
          contextMenu={(r) => [{ label: r.Enabled_bool ? "Turn Off Pass-Through…" : "Turn On Pass-Through…", icon: <IconToggleLeft size={14} />, disabled: !r.Support_bool, onClick: () => toggle(r) }]}
          rowTone={(r) => (r.Support_bool ? undefined : "dim")}
          empty={{ title: "No network adapters", icon: <IconNetwork size={28} stroke={1.4} />, description: "The server didn’t report any adapters." }}
          columns={[
            { key: "DeviceName_str", title: "Adapter", truncate: true, render: (r) => <span className="sem-cell-title" title={r.Guid_str}><span className="sem-strong">{r.DeviceName_str}</span>{r.Guid_str && <Mono dim>{r.Guid_str}</Mono>}</span> },
            { key: "DriverName_str", title: "Driver", render: (r) => <span className="sem-cell-title">{r.DriverName_str}<span className="sem-dim">{r.DriverType_str}</span></span> },
            { key: "Support_bool", title: "Supported", width: 100, render: (r) => (r.Support_bool ? "Yes" : <span className="sem-dim">No</span>) },
            { key: "Enabled_bool", title: "Pass-through", width: 120, render: (r) => <StatusBadge status={r.Enabled_bool ? "ok" : "off"}>{r.Enabled_bool ? "On" : "Off"}</StatusBadge> },
          ]}
        />
      )}
    </Section>
  );
}

export default function LicensePage() {
  const { serverId, s, reachable, hubMode, ready } = useServerPage();
  const enabled = ready && !hubMode;
  if (!s) return null;
  return (
    <>
      <PageHeader title="License & VLAN" description="Commercial-edition licensing and the Windows-only VLAN tag pass-through setting." />
      {!reachable && <Unreachable serverId={serverId} name={s.name} error={s.state?.error} checkedAt={s.state?.checkedAt} />}
      {reachable && hubMode && <HubModeNotice hub={s.hub!} what="licensing isn’t available." />}
      {enabled && (
        <>
          <Licensing serverId={serverId} enabled={enabled} />
          <Vlan serverId={serverId} enabled={enabled} />
        </>
      )}
    </>
  );
}
