import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  Alert, Badge, Button, Group, NumberInput, PasswordInput, SimpleGrid, Stack, Switch, Text, TextInput,
} from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle, IconKey, IconTrash } from "@tabler/icons-react";
import { ConfirmButton, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { HUB_TYPE_LABELS, SaveBar, useDocs, useHubAccess } from "../../components/hub-a/shared";
import { useRpc, useRpcMutation } from "../../lib/hooks";

interface HubConfig {
  HubName_str: string;
  AdminPasswordPlainText_str?: string;
  HashedPassword_bin?: string;
  SecurePassword_bin?: string;
  Online_bool: boolean;
  MaxSession_u32: number;
  NoEnum_bool: boolean;
  HubType_u32: number;
  DefaultGateway_u32?: number;
  DefaultSubnet_u32?: number;
  [k: string]: unknown;
}

interface Form { Online_bool: boolean; MaxSession_u32: number; NoEnum_bool: boolean }

/** Build a SetHub payload from the GetHub result, overwriting only edited fields. */
function buildPayload(base: HubConfig, patch: Partial<HubConfig>): HubConfig {
  const p: HubConfig = { ...base, ...patch };
  // Password hashes returned by GetHub are zero-filled; omitting them keeps the password unchanged.
  delete p.HashedPassword_bin;
  delete p.SecurePassword_bin;
  if (!patch.AdminPasswordPlainText_str) p.AdminPasswordPlainText_str = "";
  return p;
}

function PasswordSection({ serverId, base, disabled }: { serverId: number; base: HubConfig; disabled: boolean }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const set = useRpcMutation(serverId, "SetHub", { success: "Hub administrator password updated", onSuccess: () => { setPw(""); setPw2(""); } });
  const mismatch = pw2.length > 0 && pw !== pw2;
  const weak = pw.length > 0 && pw.length < 8;
  return (
    <Section
      title="Hub administrator password"
      description="Lets a delegated administrator manage only this Virtual Hub (connect with the hub name and this password, no server-admin rights). Setting a password replaces the existing one; leaving the fields empty keeps it unchanged."
    >
      <form onSubmit={(e) => { e.preventDefault(); set.mutate(buildPayload(base, { AdminPasswordPlainText_str: pw })); }}>
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
          <PasswordInput label="New password" value={pw} onChange={(e) => setPw(e.currentTarget.value)} autoComplete="new-password"
            disabled={disabled} data-testid="hub-admin-password" error={weak ? "Use at least 8 characters" : undefined} />
          <PasswordInput label="Confirm password" value={pw2} onChange={(e) => setPw2(e.currentTarget.value)} autoComplete="new-password"
            disabled={disabled} data-testid="hub-admin-password-confirm" error={mismatch ? "Passwords do not match" : undefined} />
        </SimpleGrid>
        {!disabled && (
          <Group justify="flex-end" mt="md">
            <Button type="submit" leftSection={<IconKey size={16} />} loading={set.isPending}
              disabled={!pw || pw !== pw2 || weak} data-testid="hub-admin-password-save">Set password</Button>
          </Group>
        )}
      </form>
    </Section>
  );
}

function DangerZone({ serverId, hub }: { serverId: number; hub: string }) {
  const nav = useNavigate();
  const del = useRpcMutation(serverId, "DeleteHub", {
    success: `Virtual Hub ${hub} deleted`,
    onSuccess: () => nav(`/servers/${serverId}/hubs`),
  });
  return (
    <Section title={<Group gap={6}><IconAlertTriangle size={18} color="var(--mantine-color-red-6)" />Danger zone</Group>}>
      <Group justify="space-between" wrap="wrap">
        <div style={{ maxWidth: 620 }}>
          <Text fw={600} size="sm">Delete this Virtual Hub</Text>
          <Text size="sm" c="dimmed">
            All connected sessions are disconnected and every user, group, access list, certificate, cascade connection, SecureNAT
            and log setting of this hub is permanently removed. This cannot be undone.
          </Text>
        </div>
        <ConfirmButton
          title={`Delete Virtual Hub ${hub}?`}
          message={<>This permanently deletes <b>{hub}</b> and all of its configuration. Connected users are disconnected immediately.</>}
          typeToConfirm={hub}
          confirmLabel="Delete hub"
          size="sm"
          leftSection={<IconTrash size={16} />}
          onConfirm={() => del.mutateAsync({ HubName_str: hub })}
        >
          <span data-testid="delete-hub">Delete hub</span>
        </ConfirmButton>
      </Group>
    </Section>
  );
}

export default function HubSettingsPage() {
  const { serverId, hub, role, canWrite, canAdmin, hubAdminMode } = useHubAccess();
  const doc = useDocs("VpnRpcCreateHub");
  const q = useRpc<HubConfig>(serverId, "GetHub", { HubName_str: hub }, { enabled: !!hub });
  const initial = useMemo<Form | null>(() => q.data ? {
    Online_bool: !!q.data.Online_bool, MaxSession_u32: Number(q.data.MaxSession_u32 ?? 0), NoEnum_bool: !!q.data.NoEnum_bool,
  } : null, [q.data]);
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => setForm(initial), [initial]);
  const save = useRpcMutation(serverId, "SetHub", { success: "Virtual Hub properties saved" });
  const dirty = !!form && !!initial && JSON.stringify(form) !== JSON.stringify(initial);
  const clustered = (q.data?.HubType_u32 ?? 0) !== 0;

  return (
    <>
      <PageHeader title="Hub properties" description="Basic configuration of this Virtual Hub. Changes are applied immediately after saving." />
      {!canWrite && <ReadOnlyNotice role={role} />}
      <QueryState query={q}>
        {q.data && form && (
          <Stack gap={0}>
            <Section title="General">
              <Stack gap="md" data-testid="hub-settings-form">
                <TextInput label="Virtual Hub name" value={q.data.HubName_str} readOnly
                  description="Hub names cannot be changed after creation." />
                <Switch
                  label="Online"
                  description="An offline hub refuses all VPN connections; switching offline disconnects every current session."
                  checked={form.Online_bool}
                  disabled={!canWrite}
                  onChange={(e) => setForm({ ...form, Online_bool: e.currentTarget.checked })}
                  data-testid="hub-online-switch"
                />
                <NumberInput
                  label="Maximum number of sessions"
                  description={`${doc("MaxSession_u32", "Maximum number of VPN sessions")}. 0 = unlimited. Sessions created by the server itself (SecureNAT, local bridge, cascades) are not counted.`}
                  min={0} max={4294967295} allowDecimal={false} allowNegative={false} thousandSeparator=","
                  value={form.MaxSession_u32}
                  disabled={!canWrite}
                  onChange={(v) => setForm({ ...form, MaxSession_u32: Number(v) || 0 })}
                  data-testid="hub-max-sessions"
                  w={320}
                />
                <Switch
                  label="Hide from hub enumeration (NoEnum)"
                  description={doc("NoEnum_bool", "VPN Clients will be unable to enumerate this hub.")}
                  checked={form.NoEnum_bool}
                  disabled={!canWrite}
                  onChange={(e) => setForm({ ...form, NoEnum_bool: e.currentTarget.checked })}
                  data-testid="hub-noenum-switch"
                />
                <div>
                  <Text size="sm" fw={500}>Hub type</Text>
                  <Group gap="xs" mt={4}>
                    <Badge variant="outline" color="gray" size="lg">{HUB_TYPE_LABELS[q.data.HubType_u32] ?? q.data.HubType_u32}</Badge>
                  </Group>
                  <Text size="xs" c="dimmed" mt={4}>
                    {clustered
                      ? "Static hubs run on every cluster member; dynamic hubs are created on members on demand. The type is fixed when the hub is created — to change it, re-create the hub."
                      : "Standalone server: cluster hub types (static / dynamic) are only available on a cluster controller."}
                  </Text>
                </div>
              </Stack>
              {canWrite && (
                <SaveBar
                  dirty={dirty}
                  saving={save.isPending}
                  onReset={() => setForm(initial)}
                  onSave={() => save.mutate(buildPayload(q.data!, { ...form }))}
                  testId="hub-settings-save"
                />
              )}
            </Section>

            <PasswordSection serverId={serverId} base={q.data} disabled={!canWrite} />

            {canAdmin && !hubAdminMode && <DangerZone serverId={serverId} hub={hub} />}
            {canWrite && !canAdmin && (
              <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />}>Deleting a Virtual Hub requires the admin role.</Alert>
            )}
          </Stack>
        )}
      </QueryState>
    </>
  );
}
