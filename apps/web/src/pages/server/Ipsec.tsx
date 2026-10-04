import { useEffect, useState } from "react";
import { Alert, Button, Code, Group, Modal, PasswordInput, SimpleGrid, Stack, Switch, Text, TextInput } from "@mantine/core";
import { IconAlertTriangle, IconDeviceFloppy, IconEdit, IconPlus, IconTrash } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, KeyValue, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { HubSelect, HubUserInput } from "../../components/server-b/HubUserPicker";
import { HelpLabel, SecretText, useServerAccess } from "../../components/server-b/ui";
import { notifyError, useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import { rpc } from "../../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";

interface IpsecServices {
  L2TP_Raw_bool?: boolean;
  L2TP_IPsec_bool?: boolean;
  EtherIP_IPsec_bool?: boolean;
  IPsec_Secret_str?: string;
  L2TP_DefaultHub_str?: string;
}

interface EtherIpId { Id_str: string; HubName_str: string; UserName_str: string; Password_str: string }

const DOC = {
  L2TP_IPsec: "Enable or disable the L2TP over IPsec Server Function. To accept VPN connections from iPhone, iPad, Android, Windows or macOS built-in clients, enable this option.",
  L2TP_Raw: "Enable or disable the L2TP Server Function (raw L2TP with no encryption). Only needed for special VPN clients; traffic is NOT encrypted.",
  EtherIP: "Enable or disable the EtherIP / L2TPv3 over IPsec Server Function (site-to-site). Routers compatible with EtherIP over IPsec can connect to Virtual Hubs and establish Layer-2 (Ethernet) bridging. Each router needs an entry in the client ID table below.",
  Secret: "The IPsec Pre-Shared Key (PSK, \"secret\"), distributed to every user who connects via L2TP/IPsec or EtherIP. Google Android 4.0 misbehaves with 10 or more characters, so 9 or fewer characters is recommended.",
  DefaultHub: "Virtual Hub used when the user name omits the hub. Users otherwise log in as \"Username@Target Virtual Hub Name\".",
  Id: "ISAKMP Phase 1 ID presented by the router. Must be exactly the same as the ID configured on the EtherIP / L2TPv3 client. An IP address can be used when the client uses its IP as Phase 1 ID. '*' is a wildcard matching any client not matched by another rule.",
  Hub: "The Virtual Hub the device connects to.",
  User: "User name used to log in to the destination Virtual Hub. The user must be registered on that hub.",
  Password: "Password of that user on the destination Virtual Hub.",
};

function IpsecServicesSection({ serverId, canEdit }: { serverId: number; canEdit: boolean }) {
  const q = useRpc<IpsecServices>(serverId, "GetIPsecServices");
  const [form, setForm] = useState<IpsecServices>({});
  useEffect(() => { if (q.data) setForm(q.data); }, [q.data]);
  const save = useRpcMutation(serverId, "SetIPsecServices", { success: "IPsec settings saved" });
  const upd = (patch: IpsecServices) => setForm((f) => ({ ...f, ...patch }));
  const d = q.data;
  const dirty = !!d && (Object.keys(form) as (keyof IpsecServices)[]).some((k) => form[k] !== d[k]);
  const psk = form.IPsec_Secret_str ?? "";
  const needsPsk = !!(form.L2TP_IPsec_bool || form.EtherIP_IPsec_bool);
  const pskError = needsPsk && !psk ? "A pre-shared key is required while an IPsec function is enabled" : undefined;
  const anyEnabled = !!(form.L2TP_IPsec_bool || form.L2TP_Raw_bool || form.EtherIP_IPsec_bool);

  return (
    <Section title="IPsec / L2TP server" description="Native VPN clients of Windows, macOS, iOS and Android can connect using L2TP over IPsec. Routers can connect site-to-site with EtherIP / L2TPv3 over IPsec. Requires UDP 500 and 4500 reachable from clients.">
      <QueryState query={q}>
        <form onSubmit={(e) => { e.preventDefault(); save.mutate({ ...d, ...form }); }}>
          <Stack gap="md">
            <SimpleGrid cols={{ base: 1, md: 3 }}>
              <Switch label={<HelpLabel label="L2TP over IPsec" doc={DOC.L2TP_IPsec} />} description="Remote access from smartphones and OS built-in clients"
                checked={!!form.L2TP_IPsec_bool} disabled={!canEdit} onChange={(e) => upd({ L2TP_IPsec_bool: e.currentTarget.checked })} data-testid="ipsec-l2tp" />
              <Switch label={<HelpLabel label="Raw L2TP (no encryption)" doc={DOC.L2TP_Raw} />} description="For special clients only — unencrypted"
                checked={!!form.L2TP_Raw_bool} disabled={!canEdit} onChange={(e) => upd({ L2TP_Raw_bool: e.currentTarget.checked })} data-testid="ipsec-l2tp-raw" />
              <Switch label={<HelpLabel label="EtherIP / L2TPv3 over IPsec" doc={DOC.EtherIP} />} description="Site-to-site Layer-2 bridging from routers"
                checked={!!form.EtherIP_IPsec_bool} disabled={!canEdit} onChange={(e) => upd({ EtherIP_IPsec_bool: e.currentTarget.checked })} data-testid="ipsec-etherip" />
            </SimpleGrid>
            {form.L2TP_Raw_bool && (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>Raw L2TP carries user traffic without any encryption. Enable it only for clients that cannot use IPsec.</Alert>
            )}
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              {canEdit ? (
                <PasswordInput label={<HelpLabel label="IPsec pre-shared key" doc={DOC.Secret} />} value={psk} autoComplete="off"
                  onChange={(e) => upd({ IPsec_Secret_str: e.currentTarget.value })}
                  description={psk.length > 9 ? <Text span size="xs" c="orange">{psk.length} characters — some Android versions fail with 10 or more characters</Text> : "Shared by all L2TP/IPsec and EtherIP clients (9 characters or fewer recommended)"}
                  error={pskError} data-testid="ipsec-psk" />
              ) : (
                <div>
                  <Text size="sm" fw={500} mb={4}><HelpLabel label="IPsec pre-shared key" doc={DOC.Secret} /></Text>
                  <SecretText value={psk} canReveal={false} />
                </div>
              )}
              <HubSelect serverId={serverId} value={form.L2TP_DefaultHub_str ?? ""} onChange={(v) => upd({ L2TP_DefaultHub_str: v })} readOnly={!canEdit}
                label={<HelpLabel label="Default Virtual Hub" doc={DOC.DefaultHub} />}
                description="Used when a user name has no @HUB suffix" testId="ipsec-default-hub" />
            </SimpleGrid>
            {anyEnabled && (
              <Text size="xs" c="dimmed">
                Clients log in as <Code>user@{form.L2TP_DefaultHub_str || "HUB"}</Code>; with the default hub set, just <Code>user</Code> works for users of that hub.
              </Text>
            )}
            {canEdit && (
              <Group justify="flex-end">
                <Button variant="default" disabled={!dirty} onClick={() => d && setForm(d)}>Reset</Button>
                <Button type="submit" leftSection={<IconDeviceFloppy size={16} />} loading={save.isPending} disabled={!dirty || !!pskError} data-testid="save-ipsec">Save</Button>
              </Group>
            )}
          </Stack>
        </form>
      </QueryState>
    </Section>
  );
}

function EtherIpModal({ serverId, opened, onClose, initial, existingIds }: {
  serverId: number; opened: boolean; onClose: () => void; initial: EtherIpId | null; existingIds: string[];
}) {
  const qc = useQueryClient();
  const [f, setF] = useState<EtherIpId>({ Id_str: "", HubName_str: "", UserName_str: "", Password_str: "" });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (opened) setF(initial ?? { Id_str: "", HubName_str: "", UserName_str: "", Password_str: "" }); }, [opened, initial]);
  const editing = !!initial;
  const idTaken = f.Id_str.trim() !== "" && existingIds.some((x) => x.toLowerCase() === f.Id_str.trim().toLowerCase()) && (!editing || f.Id_str.trim().toLowerCase() !== initial!.Id_str.toLowerCase());

  const submit = async () => {
    setBusy(true);
    try {
      const entry = { ...f, Id_str: f.Id_str.trim(), UserName_str: f.UserName_str.trim() };
      // AddEtherIpId replaces an entry with the same ID; when the ID changes, add the new one first, then remove the old one.
      await rpc(serverId, "AddEtherIpId", entry);
      if (editing && initial!.Id_str.toLowerCase() !== entry.Id_str.toLowerCase()) {
        await rpc(serverId, "DeleteEtherIpId", { Id_str: initial!.Id_str });
      }
      notifications.show({ color: "green", message: editing ? "EtherIP / L2TPv3 client entry updated" : "EtherIP / L2TPv3 client entry added" });
      onClose();
    } catch (e) {
      notifyError(e, "AddEtherIpId");
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={editing ? `Edit client entry ${initial!.Id_str}` : "Add EtherIP / L2TPv3 client entry"} centered size="lg">
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Stack>
          <TextInput label={<HelpLabel label="ISAKMP Phase 1 ID" doc={DOC.Id} />} required value={f.Id_str} data-autofocus
            description="Exactly as configured on the router; an IP address or '*' (wildcard) is also possible"
            onChange={(e) => setF((s) => ({ ...s, Id_str: e.currentTarget.value }))}
            error={idTaken ? "An entry with this ID already exists (saving would overwrite it)" : undefined} data-testid="etherip-id" />
          <HubSelect serverId={serverId} value={f.HubName_str} onChange={(v) => setF((s) => ({ ...s, HubName_str: v, UserName_str: v === s.HubName_str ? s.UserName_str : "" }))}
            required description={DOC.Hub} testId="etherip-hub" />
          <HubUserInput serverId={serverId} hub={f.HubName_str} value={f.UserName_str} onChange={(v) => setF((s) => ({ ...s, UserName_str: v }))}
            required description={DOC.User} testId="etherip-user" />
          <PasswordInput label="Password" description={DOC.Password} value={f.Password_str} autoComplete="new-password"
            onChange={(e) => setF((s) => ({ ...s, Password_str: e.currentTarget.value }))} data-testid="etherip-password" />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={busy} disabled={!f.Id_str.trim() || !f.HubName_str || !f.UserName_str.trim() || idTaken} data-testid="etherip-submit">
              {editing ? "Save" : "Add entry"}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function EtherIpDetail({ serverId, id, onClose, isAdmin }: { serverId: number; id: string | null; onClose: () => void; isAdmin: boolean }) {
  const q = useRpc<EtherIpId>(serverId, "GetEtherIpId", { Id_str: id ?? "" }, { enabled: !!id });
  return (
    <Modal opened={!!id} onClose={onClose} title={`Client entry ${id ?? ""}`} centered>
      <QueryState query={q}>
        {q.data && (
          <KeyValue rows={[
            ["ISAKMP Phase 1 ID", <Code>{q.data.Id_str}</Code>],
            ["Virtual Hub", q.data.HubName_str],
            ["User name", q.data.UserName_str],
            ["Password", <SecretText value={q.data.Password_str} canReveal={isAdmin} />],
          ]} />
        )}
      </QueryState>
    </Modal>
  );
}

function EtherIpSection({ serverId, canEdit, isAdmin, etherIpEnabled }: { serverId: number; canEdit: boolean; isAdmin: boolean; etherIpEnabled: boolean | undefined }) {
  const q = useRpc<{ Settings?: EtherIpId[] }>(serverId, "EnumEtherIpId");
  const del = useRpcMutation(serverId, "DeleteEtherIpId", { success: "Client entry deleted" });
  const [modal, setModal] = useState<{ open: boolean; entry: EtherIpId | null }>({ open: false, entry: null });
  const [detail, setDetail] = useState<string | null>(null);
  const rows = q.data?.Settings ?? [];
  return (
    <Section
      title="EtherIP / L2TPv3 client devices"
      description="Maps the ISAKMP Phase 1 ID presented by each EtherIP / L2TPv3 over IPsec router to the Virtual Hub and user it logs in as."
      actions={canEdit && <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setModal({ open: true, entry: null })} data-testid="add-etherip">Add entry</Button>}
    >
      {etherIpEnabled === false && rows.length > 0 && (
        <Alert color="yellow" variant="light" mb="sm">The EtherIP / L2TPv3 over IPsec function is currently disabled, so these entries are not in use.</Alert>
      )}
      <QueryState query={q}>
        <DataTable
          testId="etherip-table"
          data={rows}
          rowKey={(r) => r.Id_str}
          initialSort={{ key: "Id_str", dir: "asc" }}
          onRowClick={(r) => setDetail(r.Id_str)}
          empty="No EtherIP / L2TPv3 client devices defined"
          columns={[
            { key: "Id_str", title: "Phase 1 ID", render: (r) => <Group gap={6}><Code>{r.Id_str}</Code>{r.Id_str === "*" && <Text size="xs" c="dimmed">(wildcard)</Text>}</Group> },
            { key: "HubName_str", title: "Virtual Hub" },
            { key: "UserName_str", title: "User" },
            { key: "Password_str", title: "Password", sortable: false, value: () => "", render: (r) => <SecretText value={r.Password_str} canReveal={false} /> },
            {
              key: "actions", title: "", sortable: false, align: "right", value: () => "",
              render: (r) => canEdit && (
                <Group gap={6} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                  <Button size="xs" variant="light" leftSection={<IconEdit size={14} />} onClick={() => setModal({ open: true, entry: r })} data-testid={`edit-etherip-${r.Id_str}`}>Edit</Button>
                  <ConfirmButton
                    title={`Delete client entry ${r.Id_str}?`}
                    message={<>The device presenting Phase 1 ID <Code>{r.Id_str}</Code> will no longer be able to connect to hub <b>{r.HubName_str}</b>.</>}
                    confirmLabel="Delete"
                    leftSection={<IconTrash size={14} />}
                    onConfirm={() => del.mutateAsync({ Id_str: r.Id_str })}
                  >Delete</ConfirmButton>
                </Group>
              ),
            },
          ]}
        />
      </QueryState>
      <EtherIpModal serverId={serverId} opened={modal.open} initial={modal.entry} existingIds={rows.map((r) => r.Id_str)} onClose={() => setModal({ open: false, entry: null })} />
      <EtherIpDetail serverId={serverId} id={detail} onClose={() => setDetail(null)} isAdmin={isAdmin} />
    </Section>
  );
}

export default function IpsecPage() {
  const { serverId } = useScope();
  const { role, isOperator, isAdmin } = useServerAccess(serverId);
  const svc = useRpc<IpsecServices>(serverId, "GetIPsecServices");
  return (
    <>
      <PageHeader
        title="IPsec / L2TP / EtherIP"
        description="Built-in IPsec VPN server: remote access for OS-native L2TP/IPsec clients and site-to-site EtherIP / L2TPv3 over IPsec for routers."
      />
      {!isOperator && <ReadOnlyNotice role={role} />}
      <IpsecServicesSection serverId={serverId} canEdit={isOperator} />
      <EtherIpSection serverId={serverId} canEdit={isOperator} isAdmin={isAdmin} etherIpEnabled={svc.data?.EtherIP_IPsec_bool} />
    </>
  );
}
