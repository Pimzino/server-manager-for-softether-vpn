import { useState } from "react";
import { Badge, Button, Code, Group, Stack, Text, Textarea } from "@mantine/core";
import { IconKey, IconTrash } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, KeyValue, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { NotApplicable, isUnsupported, useServerAccess } from "../../components/server-b/ui";
import { useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import { dt, isNever, num } from "../../lib/format";

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

// Only 0 (OK) is documented in the catalog; other codes are shown raw.
const LICENSE_STATUS: Record<number, { label: string; color: string }> = {
  0: { label: "OK", color: "green" },
};

const unlimited = (n: number) => (n >= 0x7fffffff || n === 0xffffffff ? "Unlimited" : num(n));

function LicenseStatusSection({ serverId }: { serverId: number }) {
  const q = useRpc<LicenseStatus>(serverId, "GetLicenseStatus", {}, { retry: false });
  const d = q.data;
  return (
    <Section title="License status" description="Edition and license counters (commercial PacketiX VPN editions only).">
      {q.error ? (
        <NotApplicable error={q.error} title="Not applicable on the open-source edition">
          SoftEther VPN (open-source / developer edition) has no license keys: every feature is available without limits.
          License management only exists on the commercial PacketiX VPN Server editions.
        </NotApplicable>
      ) : (
        <QueryState query={q}>
          {d && (
            <KeyValue rows={[
              ["Edition", <Group gap={6}><Text size="sm" fw={600}>{d.EditionStr_str}</Text><Badge variant="outline" color="gray">ID {d.EditionId_u32}</Badge></Group>],
              ["System ID", <Code>{String(d.SystemId_u64)}</Code>],
              ["System expires", isNever(d.SystemExpires_dt) ? "Never" : dt(d.SystemExpires_dt)],
              ["Client connection licenses", unlimited(d.NumClientConnectLicense_u32)],
              ["Bridge connection licenses", unlimited(d.NumBridgeConnectLicense_u32)],
              ["User creation licenses", unlimited(d.NumUserCreationLicense_u32)],
              ["Enterprise functions", d.AllowEnterpriseFunction_bool ? <Badge color="green" variant="light">Allowed</Badge> : <Badge color="gray" variant="light">Not allowed</Badge>],
              ["Subscription", d.NeedSubscription_bool
                ? <Group gap={6}><span>{dt(d.SubscriptionExpires_dt)}</span>{d.IsSubscriptionExpired_bool ? <Badge color="red">Expired</Badge> : <Badge color="green" variant="light">Active</Badge>}</Group>
                : "Not required"],
              ["Build release date", dt(d.ReleaseDate_dt)],
            ]} />
          )}
        </QueryState>
      )}
    </Section>
  );
}

function LicenseKeysSection({ serverId, isAdmin }: { serverId: number; isAdmin: boolean }) {
  const q = useRpc<{ LicenseKeyList?: LicenseKey[] }>(serverId, "EnumLicenseKey", {}, { retry: false });
  const add = useRpcMutation(serverId, "AddLicenseKey", { success: "License key added", onSuccess: () => setKey("") });
  const del = useRpcMutation(serverId, "DelLicenseKey", { success: "License key removed" });
  const [key, setKey] = useState("");
  const keyOk = /^[0-9A-Za-z]{6}(-[0-9A-Za-z]{6}){5}$/.test(key.trim()) || key.trim().length >= 16;
  if (q.error) {
    return (
      <Section title="License keys">
        <NotApplicable error={q.error} title="License keys are not used by this edition">
          The server reports that license keys are unsupported. This is expected for SoftEther VPN open-source builds.
        </NotApplicable>
      </Section>
    );
  }
  return (
    <Section title="License keys" description="Registered license keys. Keys are validated by the server against its System ID.">
      <QueryState query={q}>
        <DataTable
          testId="license-keys-table"
          data={q.data?.LicenseKeyList}
          rowKey={(r) => r.Id_u32}
          initialSort={{ key: "Id_u32", dir: "asc" }}
          empty="No license keys registered"
          columns={[
            { key: "Id_u32", title: "ID", width: 60 },
            { key: "LicenseName_str", title: "License", render: (r) => <Stack gap={0}><Text size="sm" fw={600}>{r.LicenseName_str}</Text><Text size="xs" c="dimmed">{r.LicenseId_str}</Text></Stack> },
            { key: "LicenseKey_str", title: "Key", render: (r) => <Code>{r.LicenseKey_str}</Code> },
            { key: "Status_u32", title: "Status", render: (r) => { const s = LICENSE_STATUS[r.Status_u32]; return <Badge color={s?.color ?? "orange"} variant="light">{s?.label ?? `Status code ${r.Status_u32}`}</Badge>; } },
            { key: "Expires_dt", title: "Expires", render: (r) => (isNever(r.Expires_dt) ? "Never" : dt(r.Expires_dt)) },
            { key: "ProductId_u32", title: "Product / serial", render: (r) => `${r.ProductId_u32} / ${r.SerialId_u32}` },
            {
              key: "actions", title: "", sortable: false, align: "right", value: () => "",
              render: (r) => isAdmin && (
                <ConfirmButton title={`Remove license ${r.LicenseName_str}?`} typeToConfirm={String(r.Id_u32)} confirmLabel="Remove" leftSection={<IconTrash size={14} />}
                  message="Features and connection counts granted by this license stop working immediately. Removing a license key cannot be undone without re-entering the key."
                  onConfirm={() => del.mutateAsync({ IntValue_u32: r.Id_u32 })}
                >Remove</ConfirmButton>
              ),
            },
          ]}
        />
        {isAdmin && (
          <form onSubmit={(e) => { e.preventDefault(); add.mutate({ StrValue_str: key.trim() }); }}>
            <Group align="flex-end" mt="md">
              <Textarea label="Add license key" placeholder="XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX" autosize minRows={1} ff="monospace" value={key} onChange={(e) => setKey(e.currentTarget.value)} w={480} data-testid="license-key-input" />
              <Button type="submit" leftSection={<IconKey size={16} />} loading={add.isPending} disabled={!keyOk} data-testid="add-license-key">Add key</Button>
            </Group>
          </form>
        )}
      </QueryState>
    </Section>
  );
}

function VlanSection({ serverId, isAdmin }: { serverId: number; isAdmin: boolean }) {
  const q = useRpc<{ Devices?: VlanDev[] }>(serverId, "EnumEthVLan", {}, { retry: false });
  const set = useRpcMutation(serverId, "SetEnableEthVLan", { success: "VLAN pass-through setting changed" });
  return (
    <Section
      title="VLAN tag pass-through (Windows)"
      description="On Windows, most network adapter drivers strip 802.1Q VLAN tags before SoftEther sees them. For supported Intel / Broadcom adapters the server can change the driver setting so tagged frames are passed to local bridges."
    >
      {q.error ? (
        <NotApplicable error={q.error} title={isUnsupported(q.error) ? "Only available on Windows servers" : "Unavailable"}>
          VLAN tag pass-through is a Windows-only driver setting. On Linux, macOS and BSD servers VLAN tags are passed through natively when bridging to an interface.
        </NotApplicable>
      ) : (
        <QueryState query={q}>
          <DataTable
            testId="vlan-table"
            data={q.data?.Devices}
            rowKey={(r) => r.Guid_str || r.DeviceName_str}
            initialSort={{ key: "DeviceName_str", dir: "asc" }}
            empty="No network adapters reported"
            columns={[
              { key: "DeviceName_str", title: "Adapter", render: (r) => <Stack gap={0}><Text size="sm" fw={600}>{r.DeviceName_str}</Text><Text size="xs" c="dimmed" ff="monospace">{r.Guid_str}</Text></Stack> },
              { key: "DriverName_str", title: "Driver", render: (r) => <Stack gap={0}><Text size="sm">{r.DriverName_str}</Text><Text size="xs" c="dimmed">{r.DriverType_str}</Text></Stack> },
              { key: "Support_bool", title: "Supported", render: (r) => (r.Support_bool ? <Badge color="green" variant="light">Yes</Badge> : <Badge color="gray" variant="light">No</Badge>) },
              { key: "Enabled_bool", title: "Pass-through", render: (r) => (r.Enabled_bool ? <Badge color="blue">Enabled</Badge> : <Badge color="gray" variant="outline">Disabled</Badge>) },
              {
                key: "actions", title: "", sortable: false, align: "right", value: () => "",
                render: (r) => isAdmin && r.Support_bool && (
                  <ConfirmButton
                    title={`${r.Enabled_bool ? "Disable" : "Enable"} VLAN pass-through on ${r.DeviceName_str}?`}
                    color={r.Enabled_bool ? "red" : "blue"} confirmLabel={r.Enabled_bool ? "Disable" : "Enable"}
                    message="The adapter's driver setting is changed; Windows restarts the adapter, briefly interrupting all traffic through it (including remote management if it uses this adapter)."
                    onConfirm={() => set.mutateAsync({ StrValue_str: r.Guid_str || r.DeviceName_str, IntValue_u32: r.Enabled_bool ? 0 : 1 })}
                  >{r.Enabled_bool ? "Disable" : "Enable"}</ConfirmButton>
                ),
              },
            ]}
          />
        </QueryState>
      )}
    </Section>
  );
}

export default function LicensePage() {
  const { serverId } = useScope();
  const { role, isAdmin } = useServerAccess(serverId);
  return (
    <>
      <PageHeader title="License & VLAN" description="Commercial-edition license management and the Windows-only VLAN tag pass-through setting. Both show a “not applicable” state on servers where they do not apply." />
      {!isAdmin && <ReadOnlyNotice role={role} />}
      <LicenseStatusSection serverId={serverId} />
      <LicenseKeysSection serverId={serverId} isAdmin={isAdmin} />
      <VlanSection serverId={serverId} isAdmin={isAdmin} />
    </>
  );
}
