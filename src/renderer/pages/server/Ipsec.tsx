// Server › IPsec, L2TP & EtherIP: the built-in IPsec server (Get/SetIPsecServices) and the EtherIP / L2TPv3
// client-device table (Enum/Get/Add/DeleteEtherIpId).
import { useEffect, useState } from "react";
import { Button, Group, PasswordInput, Switch, TextInput } from "@mantine/core";
import { IconEye, IconPencil, IconPlus, IconRouter, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { rpc } from "../../lib/api";
import { notifyError, notifySuccess, useRpc, useRpcMutation } from "../../lib/hooks";
import {
  DataTable, ErrorState, FormRow, FormSection, Inspector, Mono, PageHeader, PropertyList, PropertySkeleton, Section, Sheet, Tag, type ContextMenuItem,
} from "../../design";
import { HubSelect, HubUserInput } from "../../components/domain/HubPicker";
import { Callout, HelpLabel, SecretText } from "../../components/domain/ui";
import { HubModeNotice, Unreachable, useServerPage } from "./_server-protocols-security/shared";

interface IpsecServices { L2TP_Raw_bool?: boolean; L2TP_IPsec_bool?: boolean; EtherIP_IPsec_bool?: boolean; IPsec_Secret_str?: string; L2TP_DefaultHub_str?: string }
interface EtherIpId { Id_str: string; HubName_str: string; UserName_str: string; Password_str: string }

const DOC = {
  L2TP_IPsec: "L2TP over IPsec server function. Turn it on to accept VPN connections from the built-in clients of iPhone, iPad, Android, Windows and macOS.",
  L2TP_Raw: "Raw L2TP server function, without any encryption. Only needed for special VPN clients.",
  EtherIP: "EtherIP / L2TPv3 over IPsec server function (site-to-site). Compatible routers connect to a Virtual Hub and bridge Ethernet. Each router needs an entry in the device table.",
  Secret: "The IPsec pre-shared key (PSK), given to every user who connects with L2TP/IPsec or EtherIP. Android 4.0 fails with 10 or more characters, so 9 or fewer are recommended.",
  DefaultHub: "Virtual Hub used when the user name has no hub. Otherwise users sign in as “user@HUB”.",
  Id: "ISAKMP Phase 1 ID the router presents. It must equal the ID configured on the router. An IP address works when the router uses its IP as Phase 1 ID. “*” matches any router no other entry matches.",
};

const EMPTY: EtherIpId = { Id_str: "", HubName_str: "", UserName_str: "", Password_str: "" };

function ServicesForm({ serverId, enabled }: { serverId: number; enabled: boolean }) {
  const q = useRpc<IpsecServices>(serverId, "GetIPsecServices", {}, { enabled });
  const [form, setForm] = useState<IpsecServices>({});
  useEffect(() => { if (q.data) setForm(q.data); }, [q.data]);
  const save = useRpcMutation(serverId, "SetIPsecServices", { success: "IPsec settings saved" });
  const upd = (patch: IpsecServices) => setForm((f) => ({ ...f, ...patch }));
  const d = q.data;
  const dirty = !!d && (Object.keys(form) as (keyof IpsecServices)[]).some((k) => form[k] !== d[k]);
  const psk = form.IPsec_Secret_str ?? "";
  const needsPsk = !!(form.L2TP_IPsec_bool || form.EtherIP_IPsec_bool);
  const pskError = needsPsk && !psk ? "Enter a pre-shared key while an IPsec function is on." : undefined;
  const anyOn = !!(form.L2TP_IPsec_bool || form.L2TP_Raw_bool || form.EtherIP_IPsec_bool);

  if (q.error) return <Section title="Services"><ErrorState error={q.error} inline onRetry={() => void q.refetch()} /></Section>;
  if (!d) return <FormSection title="Services"><PropertySkeleton rows={3} /></FormSection>;

  return (
    <>
      <FormSection title="Services" description="Clients need UDP 500 and 4500 open to the server." testId="ipsec-services">
        <FormRow label={<HelpLabel label="L2TP over IPsec" doc={DOC.L2TP_IPsec} />} description="Remote access from phones and OS built-in VPN clients.">
          {(id) => <Switch id={id} checked={!!form.L2TP_IPsec_bool} onChange={(e) => upd({ L2TP_IPsec_bool: e.currentTarget.checked })} aria-label="L2TP over IPsec" data-testid="ipsec-l2tp" />}
        </FormRow>
        <FormRow label={<HelpLabel label="Raw L2TP" doc={DOC.L2TP_Raw} />} description="For special clients only. Traffic isn’t encrypted.">
          {(id) => <Switch id={id} checked={!!form.L2TP_Raw_bool} onChange={(e) => upd({ L2TP_Raw_bool: e.currentTarget.checked })} aria-label="Raw L2TP" data-testid="ipsec-l2tp-raw" />}
        </FormRow>
        <FormRow label={<HelpLabel label="EtherIP / L2TPv3 over IPsec" doc={DOC.EtherIP} />} description="Site-to-site Layer 2 bridging from routers.">
          {(id) => <Switch id={id} checked={!!form.EtherIP_IPsec_bool} onChange={(e) => upd({ EtherIP_IPsec_bool: e.currentTarget.checked })} aria-label="EtherIP / L2TPv3 over IPsec" data-testid="ipsec-etherip" />}
        </FormRow>
      </FormSection>
      {form.L2TP_Raw_bool && (
        <Callout tone="orange" testId="ipsec-raw-warning">Raw L2TP carries user traffic without encryption. Turn it on only for clients that can’t use IPsec.</Callout>
      )}
      <FormSection
        title="Authentication"
        testId="ipsec-auth"
        footer={(
          <Group justify="space-between" gap={8} wrap="nowrap">
            <span className="sem-dim" style={{ fontSize: "var(--sem-fz-small)" }} data-testid="ipsec-login-hint">
              {dirty && <span className="sem-strong" data-testid="ipsec-unsaved">Unsaved changes to services or authentication. </span>}
              {anyOn && <>Clients sign in as <span className="sem-code-inline">user@{form.L2TP_DefaultHub_str || "HUB"}</span>{form.L2TP_DefaultHub_str ? <>, or just <span className="sem-code-inline">user</span> for {form.L2TP_DefaultHub_str}</> : null}.</>}
            </span>
            <Group gap={8} wrap="nowrap">
              <Button variant="default" disabled={!dirty || save.isPending} onClick={() => setForm(d)} data-testid="save-ipsec-reset">Revert</Button>
              <Button disabled={!dirty || !!pskError} loading={save.isPending} onClick={() => save.mutate({ ...d, ...form })} data-testid="save-ipsec">Save</Button>
            </Group>
          </Group>
        )}
      >
        <FormRow
          label={<HelpLabel label="Pre-shared key" doc={DOC.Secret} />}
          description={psk.length > 9
            ? <span style={{ color: "var(--sem-orange)" }}>{psk.length} characters. Some Android versions fail with 10 or more.</span>
            : "Shared by every L2TP/IPsec and EtherIP client. 9 characters or fewer is safest."}
          error={pskError}
        >
          {(id) => <PasswordInput id={id} w={260} value={psk} autoComplete="off" error={!!pskError} onChange={(e) => upd({ IPsec_Secret_str: e.currentTarget.value })} data-testid="ipsec-psk" />}
        </FormRow>
        <FormRow label={<HelpLabel label="Default Virtual Hub" doc={DOC.DefaultHub} />} description="Used when a user name has no @HUB suffix.">
          {(id) => <HubSelect id={id} serverId={serverId} value={form.L2TP_DefaultHub_str ?? ""} onChange={(v) => upd({ L2TP_DefaultHub_str: v })} clearable testId="ipsec-default-hub" />}
        </FormRow>
      </FormSection>
    </>
  );
}

function EtherIpSheet({ serverId, opened, onClose, initial, existingIds }: {
  serverId: number; opened: boolean; onClose: () => void; initial: EtherIpId | null; existingIds: string[];
}) {
  const qc = useQueryClient();
  const [f, setF] = useState<EtherIpId>(EMPTY);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (opened) setF(initial ?? EMPTY); }, [opened, initial]);
  const editing = !!initial;
  const id = f.Id_str.trim();
  const idTaken = !!id && existingIds.some((x) => x.toLowerCase() === id.toLowerCase()) && (!editing || id.toLowerCase() !== initial!.Id_str.toLowerCase());
  const valid = !!id && !!f.HubName_str && !!f.UserName_str.trim() && !idTaken;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const entry = { ...f, Id_str: id, UserName_str: f.UserName_str.trim() };
      // AddEtherIpId replaces an entry with the same ID. When the ID changes, add the new entry first, then delete the old one.
      await rpc(serverId, "AddEtherIpId", entry);
      if (editing && initial!.Id_str.toLowerCase() !== id.toLowerCase()) await rpc(serverId, "DeleteEtherIpId", { Id_str: initial!.Id_str });
      notifySuccess(editing ? `Updated device “${id}”` : `Added device “${id}”`);
      onClose();
    } catch (e) {
      notifyError(e, editing ? "Couldn’t update the device" : "Couldn’t add the device");
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
    }
  };

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={busy} testId="etherip-sheet"
      title={editing ? <>Edit “{initial!.Id_str}”</> : "New EtherIP / L2TPv3 Device"}
      subtitle="The router signs in to the Virtual Hub as this user."
      icon={<IconRouter size={19} stroke={1.5} />}
      footer={(
        <Group justify="flex-end" gap={8}>
          <Button variant="default" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={!valid} data-testid="etherip-submit">{editing ? "Save" : "Add Device"}</Button>
        </Group>
      )}
    >
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <FormSection>
          <FormRow label={<HelpLabel label="Phase 1 ID" doc={DOC.Id} />} description="Exactly as configured on the router, an IP address, or * for any router."
            error={idTaken ? "A device with this ID already exists." : undefined}>
            {(rid) => <TextInput id={rid} w={260} value={f.Id_str} data-autofocus spellCheck={false} error={idTaken}
              onChange={(e) => { const v = e.currentTarget.value; setF((s) => ({ ...s, Id_str: v })); }} data-testid="etherip-id" />}
          </FormRow>
          <FormRow label="Virtual Hub" description="The hub the router connects to.">
            {(rid) => <HubSelect id={rid} serverId={serverId} value={f.HubName_str} testId="etherip-hub"
              onChange={(v) => setF((s) => ({ ...s, HubName_str: v, UserName_str: v === s.HubName_str ? s.UserName_str : "" }))} />}
          </FormRow>
          <FormRow label="User" description="A user registered on that hub.">
            {(rid) => <HubUserInput id={rid} serverId={serverId} hub={f.HubName_str} value={f.UserName_str} testId="etherip-user"
              onChange={(v) => setF((s) => ({ ...s, UserName_str: v }))} />}
          </FormRow>
          <FormRow label="Password" description="That user’s password on the hub.">
            {(rid) => <PasswordInput id={rid} w={260} value={f.Password_str} autoComplete="new-password"
              onChange={(e) => { const v = e.currentTarget.value; setF((s) => ({ ...s, Password_str: v })); }} data-testid="etherip-password" />}
          </FormRow>
        </FormSection>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Sheet>
  );
}

function EtherIpInspector({ serverId, id, onClose, onEdit, onDelete }: {
  serverId: number; id: string | null; onClose: () => void; onEdit: (e: EtherIpId) => void; onDelete: (e: EtherIpId) => void;
}) {
  const q = useRpc<EtherIpId>(serverId, "GetEtherIpId", { Id_str: id ?? "" }, { enabled: !!id });
  const e = q.data;
  return (
    <Inspector
      opened={!!id} onClose={onClose} title={id ?? ""} subtitle="EtherIP / L2TPv3 device" icon={<IconRouter size={18} stroke={1.5} />}
      testId="etherip-inspector"
      actions={e && (
        <Group gap={8}>
          <Button size="xs" variant="default" leftSection={<IconPencil size={13} />} onClick={() => onEdit(e)} data-testid="etherip-inspector-edit">Edit…</Button>
          <Button size="xs" variant="default" c="var(--sem-red)" leftSection={<IconTrash size={13} />} onClick={() => onDelete(e)} data-testid="etherip-inspector-delete">Delete…</Button>
        </Group>
      )}
    >
      {q.error ? <ErrorState error={q.error} inline onRetry={() => void q.refetch()} /> : !e ? <PropertySkeleton rows={4} /> : (
        <PropertyList labelWidth={110} testId="etherip-detail" items={[
          { label: "Phase 1 ID", value: <Mono>{e.Id_str}</Mono> },
          { label: "Virtual Hub", value: e.HubName_str },
          { label: "User", value: e.UserName_str },
          { label: "Password", value: <SecretText value={e.Password_str} testId="etherip-detail-password" /> },
        ]} />
      )}
    </Inspector>
  );
}

function Devices({ serverId, enabled, etherIpOn }: { serverId: number; enabled: boolean; etherIpOn: boolean | undefined }) {
  const q = useRpc<{ Settings?: EtherIpId[] }>(serverId, "EnumEtherIpId", {}, { enabled });
  const del = useRpcMutation<{ Id_str: string }>(serverId, "DeleteEtherIpId", {
    success: "Device deleted",
    confirm: (p) => ({
      title: <>Delete the device “{p.Id_str}”?</>,
      message: "A router presenting this Phase 1 ID can no longer connect. The hub user isn’t changed.",
      confirmLabel: "Delete Device",
      testId: "delete-etherip",
    }),
  });
  const [sheet, setSheet] = useState<{ open: boolean; entry: EtherIpId | null }>({ open: false, entry: null });
  const [detail, setDetail] = useState<string | null>(null);
  const rows = q.data?.Settings ?? [];
  const remove = (r: EtherIpId) => del.mutate({ Id_str: r.Id_str }, { onSuccess: () => setDetail((d) => (d === r.Id_str ? null : d)) });

  const menu = (r: EtherIpId): ContextMenuItem[] => [
    { label: "Show Details", icon: <IconEye size={14} />, onClick: () => setDetail(r.Id_str), testId: `show-etherip-${r.Id_str}` },
    { label: "Edit…", icon: <IconPencil size={14} />, onClick: () => setSheet({ open: true, entry: r }), testId: `edit-etherip-${r.Id_str}` },
    "divider",
    { label: "Delete…", icon: <IconTrash size={14} />, danger: true, onClick: () => remove(r), testId: `delete-etherip-${r.Id_str}` },
  ];

  return (
    <Section
      title="EtherIP / L2TPv3 devices"
      description="Maps the Phase 1 ID each router presents to the Virtual Hub and user it signs in as."
      actions={<Button size="xs" variant="default" leftSection={<IconPlus size={13} />} onClick={() => setSheet({ open: true, entry: null })} data-testid="add-etherip">Add Device…</Button>}
    >
      {etherIpOn === false && rows.length > 0 && (
        <div style={{ marginBottom: "var(--sem-space-5)" }}>
          <Callout tone="yellow" testId="etherip-disabled">EtherIP / L2TPv3 over IPsec is off, so these devices can’t connect.</Callout>
        </div>
      )}
      <DataTable
        testId="etherip-table" aria-label="EtherIP / L2TPv3 devices"
        data={q.data ? rows : undefined} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}
        rowKey={(r) => r.Id_str} selectable="single" initialSort={{ key: "Id_str", dir: "asc" }}
        searchable={rows.length > 8}
        onRowOpen={(r) => setDetail(r.Id_str)} contextMenu={menu} rowTestId={(r) => `etherip-row-${r.Id_str}`}
        empty={{
          title: "No devices", icon: <IconRouter size={28} stroke={1.4} />,
          description: "Add a device for each router that connects with EtherIP or L2TPv3 over IPsec.",
          action: <Button size="xs" variant="default" onClick={() => setSheet({ open: true, entry: null })}>Add Device…</Button>,
        }}
        columns={[
          { key: "Id_str", title: "Phase 1 ID", render: (r) => <span className="sem-cell-title"><Mono>{r.Id_str}</Mono>{r.Id_str === "*" && <Tag>Any router</Tag>}</span> },
          { key: "HubName_str", title: "Virtual Hub", width: 200 },
          { key: "UserName_str", title: "User", width: 200 },
          { key: "Password_str", title: "Password", width: 120, sortable: false, value: () => "", render: (r) => <span className="sem-dim">{r.Password_str ? "••••••••" : "Not set"}</span> },
        ]}
      />
      <EtherIpSheet serverId={serverId} opened={sheet.open} initial={sheet.entry} existingIds={rows.map((r) => r.Id_str)} onClose={() => setSheet({ open: false, entry: null })} />
      <EtherIpInspector serverId={serverId} id={detail} onClose={() => setDetail(null)} onEdit={(e) => setSheet({ open: true, entry: e })} onDelete={remove} />
    </Section>
  );
}

export default function IpsecPage() {
  const { serverId, s, reachable, hubMode, ready } = useServerPage();
  const enabled = ready && !hubMode;
  const svc = useRpc<IpsecServices>(serverId, "GetIPsecServices", {}, { enabled });
  if (!s) return null;
  return (
    <>
      <PageHeader
        title="IPsec, L2TP & EtherIP"
        description="Remote access for built-in L2TP/IPsec clients, and site-to-site EtherIP / L2TPv3 over IPsec for routers."
      />
      {!reachable && <Unreachable serverId={serverId} name={s.name} error={s.state?.error} checkedAt={s.state?.checkedAt} />}
      {reachable && hubMode && <HubModeNotice hub={s.hub!} what="IPsec settings aren’t available." />}
      {enabled && (
        <>
          <ServicesForm serverId={serverId} enabled={enabled} />
          <Devices serverId={serverId} enabled={enabled} etherIpOn={svc.data?.EtherIP_IPsec_bool} />
        </>
      )}
    </>
  );
}
