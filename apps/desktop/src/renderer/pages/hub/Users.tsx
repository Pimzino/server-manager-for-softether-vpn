// Hub › Users. Security account database of a Virtual Hub: list with filters, multi-select delete,
// CSV import/export through native dialogs, and a multi-pane edit sheet (general, authentication of every
// type, security policy, statistics). Ported from apps/web/src/pages/hub/Users.tsx.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, PasswordInput, Radio, Select, Switch, TextInput, Textarea, Tooltip } from "@mantine/core";
import {
  IconCertificate, IconCopy, IconDeviceDesktopPlus, IconDownload, IconFileExport, IconFileImport, IconFileUpload, IconPencil, IconPlus,
  IconShieldLock, IconTrash, IconUser, IconUsers, IconWand,
} from "@tabler/icons-react";
import { rpc, saveFile } from "../../lib/api";
import { notifyError, useRpc, useRpcMutation } from "../../lib/hooks";
import { agoShort, bytes, dateShort, dt, isNever, num, plural } from "../../lib/format";
import { hubBase } from "../../sections";
import {
  CopyField, DataTable, ErrorState, FormRow, FormSection, PageHeader, PropertyList, PropertySkeleton, Section, Sheet, StatusBadge, Tag,
  confirmAction, type RowKey,
} from "../../design";
import { AuthTag, Callout } from "../../components/domain/ui";
import { PolicyEditor, hasPolicyFields, policySummary, withPolicyDefaults } from "../../components/domain/PolicyEditor";
import { fmtField } from "../../components/domain/StatusView";
import { useDocs } from "../../components/domain/hooks";
import { CSV_FILTERS, openText, pickCertDerB64 } from "../../components/domain/files";
import { parseCert, dnGet, dnToString } from "../../components/domain/x509";
import {
  AUTH_TYPES, ZERO_DT, authLabel, b64ToBytes, b64ToHex, derB64ToPem, generatePassword, hexToB64, isoToLocalInput, localInputToIso,
  parseCsv, runSequential, toCsv,
} from "../../components/domain/util";
import { PaneSwitcher, SheetFooter, TRAFFIC_ROWS, Unreachable, notifyBulk, trafficOf, useHubScope } from "./_hub-identity-traffic/shared";

type Struct = Record<string, any>;

interface UserItem {
  Name_str: string; GroupName_str: string; Realname_utf: string; Note_utf: string; AuthType_u32: number; NumLogin_u32: number;
  LastLoginTime_dt: string; DenyAccess_bool: boolean; IsTrafficFilled_bool: boolean; IsExpiresFilled_bool: boolean; Expires_dt: string;
  [k: string]: unknown;
}
interface GroupItem { Name_str: string; Realname_utf: string; Note_utf: string; NumUsers_u32: number; DenyAccess_bool: boolean }

const CSV_SAVE = [{ name: "CSV", extensions: ["csv"] }];

function isExpired(u: UserItem) {
  return u.IsExpiresFilled_bool && !isNever(u.Expires_dt) && new Date(u.Expires_dt).getTime() < Date.now();
}
function userStatus(u: UserItem): { status: "ok" | "error" | "warning"; label: string } {
  if (u.DenyAccess_bool) return { status: "error", label: "Denied" };
  if (isExpired(u)) return { status: "warning", label: "Expired" };
  return { status: "ok", label: "Active" };
}

/* ======================================================================== page */

export default function UsersPage() {
  const { serverId, hub, reachable, ready } = useHubScope();
  const nav = useNavigate();
  const qc = useQueryClient();
  const users = useRpc<{ UserList?: UserItem[] }>(serverId, "EnumUser", { HubName_str: hub }, { enabled: ready });
  const groups = useRpc<{ GroupList?: GroupItem[] }>(serverId, "EnumGroup", { HubName_str: hub }, { enabled: ready });
  const [editing, setEditing] = useState<{ name: string | null; pane?: Pane } | null>(null);
  // Keep the last user while the sheet slides out, so its title doesn't flip to "New User" mid-animation.
  const lastEditing = useRef(editing);
  if (editing) lastEditing.current = editing;
  const [importing, setImporting] = useState(false);
  const [selection, setSelection] = useState<RowKey[]>([]);
  const [authFilter, setAuthFilter] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const del = useRpcMutation<{ HubName_str: string; Name_str: string }>(serverId, "DeleteUser", {
    success: "User deleted",
    confirm: (p) => ({
      title: <>Delete user “{p.Name_str}”?</>,
      message: "The user is removed from the hub and can no longer connect. Sessions already connected stay up until they disconnect. To block someone temporarily, deny access in their security policy instead.",
      confirmLabel: "Delete User",
      testId: "delete-user",
    }),
  });

  const list = users.data?.UserList ?? [];
  const groupList = groups.data?.GroupList ?? [];
  const filtered = users.data ? list.filter((u) =>
    (authFilter === null || String(u.AuthType_u32) === authFilter)
    && (groupFilter === null || (groupFilter === "" ? !u.GroupName_str : u.GroupName_str.toLowerCase() === groupFilter.toLowerCase()))) : undefined;
  const denied = list.filter((u) => u.DenyAccess_bool).length;
  const expired = list.filter((u) => !u.DenyAccess_bool && isExpired(u)).length;

  const bulkDelete = async (names: string[]) => {
    const ok = await confirmAction({
      title: <>Delete {plural(names.length, "user")}?</>,
      message: "These users are removed from the hub and can no longer connect. This can’t be undone.",
      details: <div className="sem-dim" style={{ fontSize: "var(--sem-fz-small)" }}>{names.slice(0, 20).join(", ")}{names.length > 20 ? ` and ${names.length - 20} more` : ""}</div>,
      confirmLabel: "Delete Users",
      typeToConfirm: names.length > 1 ? `delete ${names.length} users` : undefined,
      testId: "bulk-delete-users",
    });
    if (!ok) return;
    const res = await runSequential(names, (n) => rpc(serverId, "DeleteUser", { HubName_str: hub, Name_str: n }));
    notifyBulk("Deleted", ["user", "users"], res.map((r) => ({ ok: r.ok, label: r.item, error: r.error })));
    setSelection([]);
    void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
  };

  const exportCsv = async () => {
    const rows = [["name", "password", "group", "realname", "note", "auth_type", "expires", "num_logins", "last_login", "access_denied", "bytes_received", "bytes_sent"],
      ...list.map((u) => {
        const t = trafficOf(u, "Ex.");
        return [u.Name_str, "", u.GroupName_str, u.Realname_utf, u.Note_utf, authLabel(u.AuthType_u32)?.label ?? u.AuthType_u32,
          u.IsExpiresFilled_bool && !isNever(u.Expires_dt) ? u.Expires_dt : "", u.NumLogin_u32, isNever(u.LastLoginTime_dt) ? "" : u.LastLoginTime_dt,
          u.DenyAccess_bool, t.rx, t.tx];
      })];
    try {
      await saveFile({ suggestedName: `${hub}-users.csv`, content: toCsv(rows), filters: CSV_SAVE });
    } catch (e) { notifyError(e, "Couldn’t export the users"); }
  };

  const menu = (u: UserItem, sel: UserItem[]) => {
    if (sel.length > 1) {
      return [
        { label: `Delete ${plural(sel.length, "User")}…`, icon: <IconTrash size={14} />, danger: true, onClick: () => void bulkDelete(sel.map((x) => x.Name_str)), testId: "menu-delete-users" },
      ];
    }
    return [
      { label: "Edit User…", icon: <IconPencil size={14} />, onClick: () => setEditing({ name: u.Name_str }), shortcut: "↩", testId: `edit-user-${u.Name_str}` },
      { label: "Authentication…", icon: <IconUser size={14} />, onClick: () => setEditing({ name: u.Name_str, pane: "auth" as Pane }) },
      { label: "Security Policy…", icon: <IconShieldLock size={14} />, onClick: () => setEditing({ name: u.Name_str, pane: "policy" as Pane }) },
      { label: "Create Connection Profile…", icon: <IconDeviceDesktopPlus size={14} />, onClick: () => nav(`${hubBase(serverId, hub)}/deploy`), testId: `profile-user-${u.Name_str}` },
      { label: "Copy User Name", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(u.Name_str) },
      "divider" as const,
      { label: "Delete User…", icon: <IconTrash size={14} />, danger: true, onClick: () => del.mutate({ HubName_str: hub, Name_str: u.Name_str }), testId: `delete-user-${u.Name_str}` },
    ];
  };

  return (
    <>
      <PageHeader
        title="Users"
        meta={reachable && users.data ? <>
          <span>{plural(list.length, "user")}</span>
          {denied > 0 && <><span className="sem-dim">·</span><span className="sem-dim">{num(denied)} denied</span></>}
          {expired > 0 && <><span className="sem-dim">·</span><span className="sem-dim">{num(expired)} expired</span></>}
          <span className="sem-dim">·</span><span className="sem-dim">{plural(groupList.length, "group")}</span>
        </> : undefined}
        description="Accounts in this Virtual Hub’s security database. Each signs in with a password, a certificate, RADIUS or an NT domain."
        actions={reachable && <>
          <Button variant="default" leftSection={<IconFileImport size={14} />} onClick={() => setImporting(true)} data-testid="import-users">Import…</Button>
          <Button variant="default" leftSection={<IconFileExport size={14} />} onClick={() => void exportCsv()} disabled={!list.length} data-testid="export-users">Export…</Button>
          <Button leftSection={<IconPlus size={14} />} onClick={() => setEditing({ name: null })} data-testid="create-user">Add User…</Button>
        </>}
      />
      {!reachable ? <Unreachable serverId={serverId} /> : (
        <DataTable
          testId="users-table"
          aria-label="Users"
          data={filtered}
          loading={users.isLoading}
          error={users.error}
          onRetry={() => void users.refetch()}
          rowKey={(u) => u.Name_str}
          rowTestId={(u) => `user-row-${u.Name_str}`}
          selectable="multi"
          selection={selection}
          onSelectionChange={(k) => setSelection(k)}
          onRowOpen={(u) => setEditing({ name: u.Name_str })}
          contextMenu={menu}
          rowTone={(u) => (u.DenyAccess_bool ? "dim" : undefined)}
          initialSort={{ key: "Name_str", dir: "asc" }}
          searchPlaceholder="Filter users"
          filterFn={(u, q) => [u.Name_str, u.Realname_utf, u.Note_utf, u.GroupName_str, authLabel(u.AuthType_u32)?.label].some((v) => String(v ?? "").toLowerCase().includes(q))}
          filters={<>
            <Select size="xs" w={168} placeholder="All authentication" clearable value={authFilter} onChange={setAuthFilter} aria-label="Filter by authentication type"
              data={AUTH_TYPES.map((a) => ({ value: String(a.value), label: a.label }))} data-testid="users-auth-filter" comboboxProps={{ width: 220 }} />
            <Select size="xs" w={140} placeholder="All groups" clearable value={groupFilter} onChange={setGroupFilter} aria-label="Filter by group" searchable
              data={[{ value: "", label: "No group" }, ...[...new Set([...groupList.map((g) => g.Name_str), ...(groupFilter ? [groupFilter] : [])])].map((g) => ({ value: g, label: g }))]} data-testid="users-group-filter" />
          </>}
          toolbar={selection.length > 0 && (
            <Button size="xs" variant="default" c="var(--sem-red)" leftSection={<IconTrash size={13} />} onClick={() => void bulkDelete(selection.map(String))} data-testid="bulk-delete-users-button">
              <span data-testid="bulk-delete-users">Delete {selection.length === 1 ? "User" : `${selection.length} Users`}…</span>
            </Button>
          )}
          empty={{
            title: "No Users",
            description: "Add a user, or import a list from a CSV file.",
            icon: <IconUsers size={28} stroke={1.4} />,
            action: <div className="sem-row-inline">
              <Button size="xs" variant="default" onClick={() => setImporting(true)}>Import…</Button>
              <Button size="xs" onClick={() => setEditing({ name: null })}>Add User…</Button>
            </div>,
          }}
          columns={[
            { key: "Name_str", title: "Name", width: 130, truncate: true, render: (u) => <span className="sem-strong" title={u.Name_str}>{u.Name_str}</span> },
            // The web page had a separate Note column; at the default window width it squeezed the names, so the
            // note follows the full name in secondary colour (and is searchable).
            { key: "Realname_utf", title: "Full name & note", truncate: true, value: (u) => `${u.Realname_utf} ${u.Note_utf}`,
              render: (u) => (u.Realname_utf || u.Note_utf)
                ? <span title={[u.Realname_utf, u.Note_utf].filter(Boolean).join(" — ")} data-testid={`user-realname-${u.Name_str}`}>{u.Realname_utf}{u.Note_utf ? <span className="sem-dim">{u.Realname_utf ? " — " : ""}{u.Note_utf}</span> : null}</span>
                : <span className="sem-dim">–</span> },
            { key: "GroupName_str", title: "Group", width: 100, truncate: true, render: (u) => u.GroupName_str ? <span title={u.GroupName_str}>{u.GroupName_str}</span> : <span className="sem-dim">–</span> },
            { key: "AuthType_u32", title: "Authentication", width: 114, value: (u) => authLabel(u.AuthType_u32)?.label ?? u.AuthType_u32, render: (u) => <AuthTag type={u.AuthType_u32} /> },
            { key: "status", title: "Status", width: 84, value: (u) => userStatus(u).label, render: (u) => { const s = userStatus(u); return <StatusBadge status={s.status}>{s.label}</StatusBadge>; } },
            { key: "NumLogin_u32", title: "Logins", align: "right", width: 60, render: (u) => {
              // Traffic totals live in the tooltip (full counters: Statistics pane and Export…) to keep the table readable.
              const t = trafficOf(u, "Ex.");
              return <span className="sem-num" title={u.IsTrafficFilled_bool ? `Received ${bytes(t.rx)} · Sent ${bytes(t.tx)}` : undefined}>{num(u.NumLogin_u32)}</span>;
            } },
            { key: "LastLoginTime_dt", title: "Last login", width: 92, value: (u) => (isNever(u.LastLoginTime_dt) ? "" : u.LastLoginTime_dt),
              render: (u) => <span className="sem-dim" title={dt(u.LastLoginTime_dt)}>{agoShort(u.LastLoginTime_dt)}</span> },
            { key: "Expires_dt", title: "Expires", width: 96, value: (u) => (u.IsExpiresFilled_bool && !isNever(u.Expires_dt) ? u.Expires_dt : "9999"),
              render: (u) => (u.IsExpiresFilled_bool && !isNever(u.Expires_dt) ? <span title={dt(u.Expires_dt)} className={isExpired(u) ? "sem-text-red" : undefined}>{dateShort(u.Expires_dt)}</span> : <span className="sem-dim">Never</span>) },
          ]}
        />
      )}
      <UserSheet serverId={serverId} hub={hub} name={lastEditing.current?.name ?? null} initialPane={lastEditing.current?.pane} opened={!!editing} onClose={() => setEditing(null)} groups={groupList}
        onCreated={(n) => setSelection([n])} />
      <ImportSheet serverId={serverId} hub={hub} opened={importing} onClose={() => setImporting(false)} users={list} groups={groupList} />
    </>
  );
}

/* ======================================================================== user sheet */

type Pane = "general" | "auth" | "policy" | "stats";

const NEW_USER: Struct = {
  Name_str: "", GroupName_str: "", Realname_utf: "", Note_utf: "", ExpireTime_dt: ZERO_DT, AuthType_u32: 1,
  UserX_bin: "", Serial_bin: "", CommonName_utf: "", RadiusUsername_utf: "", NtUsername_utf: "", UsePolicy_bool: false,
};

function UserSheet({ serverId, hub, name, initialPane, opened, onClose, groups, onCreated }: {
  serverId: number; hub: string; name: string | null; initialPane?: Pane; opened: boolean; onClose: () => void; groups: GroupItem[]; onCreated: (name: string) => void;
}) {
  const isNew = name === null;
  const doc = useDocs("VpnRpcSetUser");
  const q = useRpc<Struct>(serverId, "GetUser", { HubName_str: hub, Name_str: name ?? "" }, { enabled: opened && !isNew, staleTime: 0 });
  const [form, setForm] = useState<Struct>(NEW_USER);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [shownPw, setShownPw] = useState<string | null>(null);
  const [serialHex, setSerialHex] = useState("");
  const [pane, setPane] = useState<Pane>("general");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!opened) { setLoaded(false); return; }
    // Wait for a fresh GetUser: on reopen the cache still holds the pre-save copy while it refetches, and
    // filling the form from it would write stale values back on the next Save.
    const base = isNew ? { ...NEW_USER } : q.data && !q.isFetching ? { ...q.data } : null;
    if (!base || loaded) return;
    setForm(base);
    setSerialHex(b64ToHex(base.Serial_bin as string, ":"));
    setPassword(""); setPassword2(""); setShownPw(null);
    setLoaded(true);
  }, [opened, isNew, q.data, q.isFetching, loaded]);
  useEffect(() => { if (opened) setPane(initialPane ?? "general"); }, [opened, name, initialPane]);

  const origAuth = isNew ? -1 : Number(q.data?.AuthType_u32 ?? -1);
  const set = (patch: Struct) => setForm((f) => ({ ...f, ...patch }));
  const auth = Number(form.AuthType_u32 ?? 0);
  const neverExpires = isNever(form.ExpireTime_dt as string);
  const certBytes = b64ToBytes(form.UserX_bin as string);
  const cert = useMemo(() => { try { return certBytes.length ? parseCert(certBytes) : null; } catch { return null; } }, [form.UserX_bin]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useRpcMutation(serverId, "CreateUser", { success: "User created", onSuccess: (_r, p) => { onClose(); onCreated(String(p.Name_str)); } });
  const save = useRpcMutation(serverId, "SetUser", { success: "User saved", onSuccess: () => onClose() });

  const errors: { pane: Pane; text: string }[] = [];
  const nameTrim = String(form.Name_str ?? "").trim();
  if (isNew && !nameTrim) errors.push({ pane: "general", text: "Enter a user name." });
  if (isNew && /\s/.test(nameTrim)) errors.push({ pane: "general", text: "User names can’t contain spaces." });
  if (auth === 1 && (isNew || origAuth !== 1) && !password) errors.push({ pane: "auth", text: "Enter a password for password authentication." });
  if (auth === 1 && password !== password2) errors.push({ pane: "auth", text: "The passwords don’t match." });
  if (auth === 2 && certBytes.length === 0) errors.push({ pane: "auth", text: "Choose the user’s X.509 certificate." });
  if (auth === 3 && hexToB64(serialHex) === null) errors.push({ pane: "auth", text: "The serial number must be hexadecimal bytes, e.g. 01:A2:FF." });
  if (!neverExpires && Number.isNaN(new Date(form.ExpireTime_dt as string).getTime())) errors.push({ pane: "general", text: "Enter a valid expiration date." });

  const submit = () => {
    if (errors.length) { setPane(errors[0].pane); return; }
    let p: Struct = { ...form, HubName_str: hub, Name_str: isNew ? nameTrim : name };
    delete p.Auth_Password_str;
    if (auth === 1 && password) p.Auth_Password_str = password;
    // Blank password on edit: HashedKey_bin / NtLmSecureHash_bin from GetUser go back unchanged, which keeps
    // the current password (the main process also guards this; see normalizeUserPassword).
    if (auth === 3) p.Serial_bin = hexToB64(serialHex) ?? "";
    p.UsePolicy_bool = !!form.UsePolicy_bool;
    if (p.UsePolicy_bool) p = withPolicyDefaults(p);
    if (isNew) create.mutate(p); else save.mutate(p);
  };

  const pending = create.isPending || save.isPending;
  const policyOn = !!form.UsePolicy_bool;
  const groupData = [...new Set([...groups.map((g) => g.Name_str), ...(form.GroupName_str ? [String(form.GroupName_str)] : [])])].map((g) => {
    const gi = groups.find((x) => x.Name_str === g);
    return { value: g, label: gi?.Realname_utf ? `${g} — ${gi.Realname_utf}` : g };
  });
  const loading = !isNew && !loaded;

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={pending} size={740} testId="user-sheet"
      title={isNew ? "New User" : <>Edit “{name}”</>}
      subtitle={isNew ? <>Virtual Hub {hub}</> : q.data ? <>{authLabel(auth)?.label ?? "User"} · Virtual Hub {hub}</> : <>Virtual Hub {hub}</>}
      icon={<IconUser size={19} stroke={1.5} />}
      footer={(
        <SheetFooter note={loading ? null : errors[0]?.text}>
          <Button variant="default" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" form="sem-user-form" loading={pending} disabled={loading || errors.length > 0} data-testid="user-save">{isNew ? "Create User" : "Save"}</Button>
        </SheetFooter>
      )}
    >
      {!isNew && q.error ? <ErrorState error={q.error} inline onRetry={() => void q.refetch()} /> : loading ? <PropertySkeleton rows={6} /> : (
        <form id="sem-user-form" onSubmit={(e) => { e.preventDefault(); submit(); }} data-testid="user-form">
          <PaneSwitcher value={pane} onChange={setPane} testId="user-panes" panes={[
            { value: "general", label: "General" },
            { value: "auth", label: "Authentication" },
            { value: "policy", label: policyOn ? "Security Policy ●" : "Security Policy" },
            ...(!isNew ? [{ value: "stats" as Pane, label: "Statistics" }] : []),
          ]} />

          {pane === "general" && <>
            <FormSection>
              <FormRow label="User name" description={isNew ? <>Can’t be changed later. “*” creates the default user for RADIUS or NT domain sign-in of unknown users.</> : "User names can’t be changed."}>{(id) => (
                <TextInput id={id} value={String(form.Name_str ?? "")} readOnly={!isNew} data-autofocus={isNew || undefined} autoComplete="off" spellCheck={false}
                  error={isNew && /\s/.test(nameTrim) ? "No spaces" : undefined}
                  onChange={(e) => set({ Name_str: e.currentTarget.value })} data-testid="user-name" />
              )}</FormRow>
              <FormRow label="Full name">{(id) => (
                <TextInput id={id} value={String(form.Realname_utf ?? "")} onChange={(e) => set({ Realname_utf: e.currentTarget.value })} data-testid="user-realname" data-autofocus={!isNew || undefined} />
              )}</FormRow>
              <FormRow label="Note" align="start">{(id) => (
                <Textarea id={id} value={String(form.Note_utf ?? "")} autosize minRows={2} maxRows={5} onChange={(e) => set({ Note_utf: e.currentTarget.value })} data-testid="user-note" />
              )}</FormRow>
              <FormRow label="Group" description="The group’s security policy applies when the user has none of its own.">{(id) => (
                <Select id={id} placeholder="No group" clearable searchable data={groupData} nothingFoundMessage="No groups"
                  value={form.GroupName_str ? String(form.GroupName_str) : null} onChange={(v) => set({ GroupName_str: v ?? "" })} data-testid="user-group" />
              )}</FormRow>
            </FormSection>
            <FormSection title="Expiration">
              <FormRow label="Never expires" description="After the expiration date the user can no longer sign in.">
                <Switch checked={neverExpires} aria-label="Never expires"
                  onChange={(e) => set({ ExpireTime_dt: e.currentTarget.checked ? ZERO_DT : new Date(Date.now() + 30 * 86400_000).toISOString() })}
                  data-testid="user-never-expires" />
              </FormRow>
              {!neverExpires && (
                <FormRow label="Expires on" description="Your local time.">{(id) => (
                  <TextInput id={id} type="datetime-local" w={220} value={isoToLocalInput(form.ExpireTime_dt as string)}
                    onChange={(e) => set({ ExpireTime_dt: localInputToIso(e.currentTarget.value) })} data-testid="user-expiry" />
                )}</FormRow>
              )}
            </FormSection>
          </>}

          {pane === "auth" && <>
            <FormSection title="Authentication type" description="How the user proves who they are when connecting.">
              <Radio.Group value={String(auth)} onChange={(v) => set({ AuthType_u32: Number(v) })} data-testid="user-authtype" aria-label="Authentication type">
                {AUTH_TYPES.map((a) => (
                  <div className="sem-form-row" data-stacked key={a.value}>
                    <Radio value={String(a.value)} label={a.label} description={a.description} data-testid={`user-authtype-${a.value}`} />
                  </div>
                ))}
              </Radio.Group>
            </FormSection>

            {auth === 1 && (
              <FormSection title="Password" description={!isNew && origAuth === 1 ? "Leave both fields empty to keep the current password." : undefined}>
                <FormRow label={isNew || origAuth !== 1 ? "Password" : "New password"}>{(id) => (
                  <div className="sem-row-inline" style={{ width: "100%", flexWrap: "nowrap" }}>
                    <PasswordInput id={id} style={{ flex: 1 }} value={password} autoComplete="new-password" data-testid="user-password"
                      onChange={(e) => { setPassword(e.currentTarget.value); setShownPw(null); }} />
                    <Tooltip label="Generate a strong random password" openDelay={300}>
                      <Button variant="default" leftSection={<IconWand size={14} />} data-testid="user-generate-password"
                        onClick={() => { const pw = generatePassword(); setPassword(pw); setPassword2(pw); setShownPw(pw); }}>Generate</Button>
                    </Tooltip>
                  </div>
                )}</FormRow>
                <FormRow label="Confirm password" error={password2 && password !== password2 ? "The passwords don’t match." : undefined}>{(id) => (
                  <PasswordInput id={id} value={password2} autoComplete="new-password" onChange={(e) => setPassword2(e.currentTarget.value)} data-testid="user-password2" />
                )}</FormRow>
                {shownPw && (
                  <div className="sem-form-row" data-stacked>
                    <Callout tone="yellow" title="Copy the generated password now" testId="user-generated-password">
                      It can’t be shown again after you save.
                      <div style={{ marginTop: "var(--sem-space-3)" }}><CopyField value={shownPw} /></div>
                    </Callout>
                  </div>
                )}
              </FormSection>
            )}

            {auth === 2 && (
              <FormSection title="User certificate" description="The exact certificate the client must present. PEM or DER files (.cer, .crt, .pem).">
                <FormRow label="Certificate" align="start">
                  <div className="sem-stack" style={{ gap: "var(--sem-space-4)", width: "100%" }}>
                    {certBytes.length > 0 ? (
                      <div data-testid="user-cert-info">
                        <div className="sem-row-inline"><IconCertificate size={15} stroke={1.6} className="sem-dim" /><span className="sem-strong">{cert ? (dnGet(cert.subject, "CN") || dnToString(cert.subject)) : "Certificate loaded"}</span></div>
                        <PropertyList dense labelWidth={90} items={cert ? [
                          { label: "Issuer", value: dnGet(cert.issuer, "CN") || dnToString(cert.issuer) || "–" },
                          { label: "Expires", value: cert.notAfter ? dateShort(cert.notAfter.toISOString()) : "–" },
                          { label: "Size", value: `${num(certBytes.length)} bytes` },
                        ] : [{ label: "Size", value: `${num(certBytes.length)} bytes` }]} />
                      </div>
                    ) : <span className="sem-dim">No certificate yet.</span>}
                    <div className="sem-row-inline">
                      <Button size="xs" variant="default" leftSection={<IconFileUpload size={13} />} data-testid="user-cert-upload" onClick={async () => {
                        try {
                          const f = await pickCertDerB64("cert", "Choose the User’s Certificate");
                          if (f) set({ UserX_bin: f.derB64 });
                        } catch (e) { notifyError(e, "Couldn’t read the certificate"); }
                      }}>{certBytes.length ? "Replace…" : "Choose Certificate…"}</Button>
                      {certBytes.length > 0 && (
                        <Button size="xs" variant="default" leftSection={<IconDownload size={13} />} data-testid="user-cert-save"
                          onClick={() => saveFile({ suggestedName: `${nameTrim || "user"}.pem`, content: derB64ToPem(String(form.UserX_bin)), filters: [{ name: "PEM Certificate", extensions: ["pem", "cer", "crt"] }] }).catch((e) => notifyError(e, "Couldn’t save the certificate"))}>Save PEM…</Button>
                      )}
                    </div>
                  </div>
                </FormRow>
              </FormSection>
            )}

            {auth === 3 && (
              <FormSection title="Certificate limits" description="The hub must trust the issuing CA (Trusted CAs). Leave a field empty to accept any value.">
                <FormRow label="Common name (CN)" description={doc("CommonName_utf") || undefined}>{(id) => (
                  <TextInput id={id} value={String(form.CommonName_utf ?? "")} placeholder="Any" onChange={(e) => set({ CommonName_utf: e.currentTarget.value })} data-testid="user-cn" />
                )}</FormRow>
                <FormRow label="Serial number" description="Hex bytes, e.g. 01:A2:FF." error={hexToB64(serialHex) === null ? "Not valid hexadecimal bytes." : undefined}>{(id) => (
                  <TextInput id={id} value={serialHex} placeholder="Any" ff="var(--sem-font-mono)" spellCheck={false} onChange={(e) => setSerialHex(e.currentTarget.value)} data-testid="user-serial" />
                )}</FormRow>
              </FormSection>
            )}

            {auth === 4 && (
              <FormSection title="RADIUS" footer="Set up the RADIUS server on the hub’s RADIUS page.">
                <FormRow label="User name on the RADIUS server" description="Leave empty to use the same user name.">{(id) => (
                  <TextInput id={id} value={String(form.RadiusUsername_utf ?? "")} placeholder={nameTrim || "Same user name"} onChange={(e) => set({ RadiusUsername_utf: e.currentTarget.value })} data-testid="user-radius-name" />
                )}</FormRow>
              </FormSection>
            )}
            {auth === 5 && (
              <FormSection title="NT domain / Active Directory" footer="Works only when the VPN Server runs on Windows and belongs to the domain.">
                <FormRow label="User name in the domain" description="Leave empty to use the same user name.">{(id) => (
                  <TextInput id={id} value={String(form.NtUsername_utf ?? "")} placeholder={nameTrim || "Same user name"} onChange={(e) => set({ NtUsername_utf: e.currentTarget.value })} data-testid="user-nt-name" />
                )}</FormRow>
              </FormSection>
            )}
          </>}

          {pane === "policy" && <>
            <FormSection>
              <FormRow label="Use a security policy for this user" description="When off, the group’s policy (if any) or the hub’s default applies.">
                <Switch checked={policyOn} aria-label="Use a security policy for this user" data-testid="user-use-policy"
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setForm((f) => (on && !hasPolicyFields(f) ? withPolicyDefaults({ ...f, UsePolicy_bool: true }) : { ...f, UsePolicy_bool: on }));
                  }} />
              </FormRow>
              {policyOn && policySummary(form).length > 0 && (
                <FormRow label="Summary"><span className="sem-row-inline">{policySummary(form).map((s) => <Tag key={s} color={s === "Access denied" ? "red" : "gray"}>{s}</Tag>)}</span></FormRow>
              )}
            </FormSection>
            {policyOn && <PolicyEditor value={form} onChange={set} />}
          </>}

          {pane === "stats" && q.data && (
            <Section variant="inset" testId="user-stats">
              <PropertyList labelWidth={200} dense items={[
                { label: "Created", value: dt(q.data.CreatedTime_dt) },
                { label: "Last modified", value: dt(q.data.UpdatedTime_dt) },
                { label: "Number of sign-ins", value: num(q.data.NumLogin_u32) },
                ...TRAFFIC_ROWS.map(([label, k]) => ({ label, value: fmtField(k, q.data![k]) })),
              ]} />
            </Section>
          )}
        </form>
      )}
    </Sheet>
  );
}

/* ======================================================================== CSV import */

interface ImportRow { line: number; name: string; password: string; group: string; realname: string; note: string; error?: string; exists?: boolean }
interface ImportResult { name: string; ok: boolean; action: string; error?: string; password?: string }

const TEMPLATE = [["name", "password", "group", "realname", "note"], ["jdoe", "", "staff", "John Doe", "Laptop"]];

function ImportSheet({ serverId, hub, opened, onClose, users, groups }: {
  serverId: number; hub: string; opened: boolean; onClose: () => void; users: UserItem[]; groups: GroupItem[];
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [existing, setExisting] = useState<"skip" | "update">("skip");
  const [createGroups, setCreateGroups] = useState(true);
  const [genPw, setGenPw] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ImportResult[] | null>(null);

  useEffect(() => { if (opened) { setText(""); setFileName(null); setResult(null); setProgress(0); } }, [opened]);

  const rows = useMemo<ImportRow[]>(() => {
    const parsed = parseCsv(text);
    if (!parsed.length) return [];
    const header = parsed[0].map((h) => h.trim().toLowerCase());
    const hasHeader = header.includes("name") || header.includes("username");
    const idx = (keys: string[], pos: number) => (hasHeader ? header.findIndex((h) => keys.includes(h)) : pos);
    const cName = idx(["name", "username", "user"], 0), cPw = idx(["password", "pass"], 1), cGroup = idx(["group", "groupname"], 2),
      cReal = idx(["realname", "fullname", "full name", "real name"], 3), cNote = idx(["note", "description"], 4);
    const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    const seen = new Set<string>();
    const existingNames = new Set(users.map((u) => u.Name_str.toLowerCase()));
    return parsed.slice(hasHeader ? 1 : 0).map((r, i) => {
      const row: ImportRow = { line: i + (hasHeader ? 2 : 1), name: cell(r, cName), password: cPw >= 0 ? r[cPw] ?? "" : "", group: cell(r, cGroup), realname: cell(r, cReal), note: cell(r, cNote) };
      const k = row.name.toLowerCase();
      if (!row.name) row.error = "Missing user name";
      else if (/\s/.test(row.name)) row.error = "User name contains spaces";
      else if (seen.has(k)) row.error = "Duplicate name in the file";
      else if (!row.password && !genPw && !existingNames.has(k)) row.error = "Missing password";
      seen.add(k);
      row.exists = existingNames.has(k);
      return row;
    });
  }, [text, users, genPw]);

  const valid = rows.filter((r) => !r.error && !(r.exists && existing === "skip"));
  const invalid = rows.filter((r) => r.error).length;
  const missingGroups = [...new Set(valid.map((r) => r.group).filter((g) => g && !groups.some((x) => x.Name_str.toLowerCase() === g.toLowerCase())))];

  const run = async () => {
    setRunning(true); setProgress(0);
    try {
      if (missingGroups.length && createGroups) {
        for (const g of missingGroups) {
          try { await rpc(serverId, "CreateGroup", { HubName_str: hub, Name_str: g, Realname_utf: "", Note_utf: "" }); } catch { /* reported per user below */ }
        }
      }
      const res = await runSequential(valid, async (r) => {
        const password = r.password || (r.exists ? "" : generatePassword());
        if (r.exists) {
          const cur = await rpc<Struct>(serverId, "GetUser", { HubName_str: hub, Name_str: r.name });
          const p: Struct = { ...cur, HubName_str: hub };
          delete p.Auth_Password_str;
          if (r.group) p.GroupName_str = r.group;
          if (r.realname) p.Realname_utf = r.realname;
          if (r.note) p.Note_utf = r.note;
          if (password) { p.AuthType_u32 = 1; p.Auth_Password_str = password; }
          await rpc(serverId, "SetUser", p);
          return { action: "Updated", password };
        }
        await rpc(serverId, "CreateUser", {
          HubName_str: hub, Name_str: r.name, GroupName_str: r.group, Realname_utf: r.realname, Note_utf: r.note,
          AuthType_u32: 1, Auth_Password_str: password, ExpireTime_dt: ZERO_DT,
        });
        return { action: "Created", password };
      }, setProgress);
      setResult(res.map((x) => ({
        name: x.item.name, ok: x.ok, action: x.result?.action ?? "Failed", error: x.error,
        password: x.ok && x.item.password === "" && x.result?.password ? x.result.password : undefined,
      })));
      notifyBulk("Imported", ["user", "users"], res.map((x) => ({ ok: x.ok, label: x.item.name, error: x.error })));
    } finally {
      setRunning(false);
      void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
    }
  };

  const generated = result?.filter((r) => r.password) ?? [];
  const chooseFile = async () => {
    try {
      const f = await openText({ filters: CSV_FILTERS, title: "Import Users from CSV" });
      if (f) { setText(f.text); setFileName(f.name); }
    } catch (e) { notifyError(e, "Couldn’t read the file"); }
  };

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={running} size={780} testId="import-sheet"
      title="Import Users" subtitle={<>From a CSV file into Virtual Hub {hub}</>} icon={<IconFileImport size={19} stroke={1.5} />}
      footer={result ? (
        <SheetFooter note={`${result.filter((r) => r.ok).length} succeeded, ${result.filter((r) => !r.ok).length} failed.`}>
          <Button onClick={onClose} data-testid="import-done">Done</Button>
        </SheetFooter>
      ) : (
        <SheetFooter note={rows.length ? <>{plural(rows.length, "row")}{invalid ? ` · ${num(invalid)} with problems` : ""}{rows.filter((r) => r.exists).length ? ` · ${num(rows.filter((r) => r.exists).length)} existing` : ""}</> : "Choose a file or paste CSV text."}>
          <Button variant="default" onClick={onClose} disabled={running}>Cancel</Button>
          <Button onClick={() => void run()} loading={running} disabled={valid.length === 0} data-testid="import-run">
            {running ? `Importing ${progress} of ${valid.length}…` : valid.length ? `Import ${plural(valid.length, "User")}` : "Import"}
          </Button>
        </SheetFooter>
      )}
    >
      {result ? (
        <div className="sem-stack" style={{ gap: "var(--sem-space-5)" }}>
          {generated.length > 0 && (
            <Callout tone="yellow" title={`${plural(generated.length, "user")} received a generated password`} testId="import-generated"
              action={<Button size="xs" variant="default" leftSection={<IconDownload size={13} />} data-testid="import-download-passwords"
                onClick={() => saveFile({ suggestedName: `${hub}-imported-passwords.csv`, content: toCsv([["name", "password"], ...generated.map((g) => [g.name, g.password!])]), filters: CSV_SAVE }).catch((e) => notifyError(e, "Couldn’t save the passwords"))}>
                Save Passwords…</Button>}>
              Save them now: they can’t be shown again.
            </Callout>
          )}
          <DataTable
            testId="import-results" aria-label="Import results" data={result} rowKey={(r) => r.name} searchable={false} maxHeight={380}
            rowTone={(r) => (r.ok ? undefined : "danger")}
            columns={[
              { key: "name", title: "User", render: (r) => <span className="sem-strong">{r.name}</span> },
              { key: "action", title: "Result", width: 110, render: (r) => <StatusBadge status={r.ok ? "ok" : "error"}>{r.action}</StatusBadge> },
              { key: "error", title: "Details", wrap: true, render: (r) => r.error ? <span className="sem-text-red">{r.error}</span> : r.password ? <span className="sem-dim">Generated password</span> : <span className="sem-dim">–</span> },
            ]}
          />
        </div>
      ) : (
        <>
          <FormSection title="Source" description={<>Columns <code className="sem-code-inline">name,password,group,realname,note</code>. A header row is optional; when present, columns are matched by name. Imported users sign in with a password.</>}>
            <FormRow label="CSV file" description={fileName ?? "Or paste the text below."}>
              <div className="sem-row-inline">
                <Button size="xs" variant="default" leftSection={<IconFileUpload size={13} />} onClick={() => void chooseFile()} data-testid="import-file">Choose File…</Button>
                <Button size="xs" variant="subtle" onClick={() => saveFile({ suggestedName: "users-template.csv", content: toCsv(TEMPLATE), filters: CSV_SAVE }).catch((e) => notifyError(e, "Couldn’t save the template"))} data-testid="import-template">Save Template…</Button>
              </div>
            </FormRow>
            <FormRow label="CSV text" stacked>{(id) => (
              <Textarea id={id} value={text} onChange={(e) => { setText(e.currentTarget.value); setFileName(null); }} autosize minRows={3} maxRows={8}
                ff="var(--sem-font-mono)" spellCheck={false} placeholder={"name,password,group,realname,note\njdoe,,staff,John Doe,Laptop"} data-testid="import-text" />
            )}</FormRow>
          </FormSection>
          <FormSection title="Options">
            <FormRow label="Existing users">
              <Radio.Group value={existing} onChange={(v) => setExisting(v as "skip" | "update")} aria-label="Existing users" data-testid="import-existing">
                <div className="sem-stack" style={{ gap: "var(--sem-space-3)" }}>
                  <Radio value="skip" label="Skip them" />
                  <Radio value="update" label="Update group, full name and note (and the password, if given)" />
                </div>
              </Radio.Group>
            </FormRow>
            <FormRow label="Empty password cells">
              <Checkbox label="Generate a random password" checked={genPw} onChange={(e) => setGenPw(e.currentTarget.checked)} data-testid="import-genpw" />
            </FormRow>
            <FormRow label="Unknown groups" description={missingGroups.length ? missingGroups.join(", ") : undefined}>
              <Checkbox label="Create missing groups" checked={createGroups} onChange={(e) => setCreateGroups(e.currentTarget.checked)} data-testid="import-create-groups" />
            </FormRow>
          </FormSection>
          {missingGroups.length > 0 && !createGroups && (
            <div style={{ marginTop: "var(--sem-space-5)" }}>
              <Callout tone="orange">Groups {missingGroups.join(", ")} don’t exist, so importing their users will fail.</Callout>
            </div>
          )}
          {rows.length > 0 && (
            <Section title="Preview" testId="import-preview-section">
              <DataTable
                testId="import-preview" aria-label="Import preview" data={rows} rowKey={(r) => r.line} searchable={false} maxHeight={260} footer={false}
                rowTone={(r) => (r.error ? "danger" : r.exists && existing === "skip" ? "dim" : undefined)}
                columns={[
                  { key: "line", title: "Line", width: 50, align: "right", render: (r) => <span className="sem-num sem-dim">{r.line}</span> },
                  { key: "name", title: "Name", render: (r) => <span className="sem-strong">{r.name || "–"}</span> },
                  { key: "group", title: "Group", width: 110, truncate: true },
                  { key: "realname", title: "Full name", truncate: true },
                  { key: "password", title: "Password", width: 90, sortable: false, render: (r) => r.password ? "••••••" : <span className="sem-dim">{r.exists ? "Keep" : genPw ? "Generate" : "–"}</span> },
                  { key: "status", title: "Status", width: 150, value: (r) => r.error ?? (r.exists ? "exists" : "new"),
                    render: (r) => r.error ? <span className="sem-text-red">{r.error}</span>
                      : r.exists ? <Tag color={existing === "skip" ? "gray" : "orange"}>{existing === "skip" ? "Exists · skip" : "Update"}</Tag>
                      : <Tag color="green">New</Tag> },
                ]}
              />
            </Section>
          )}
        </>
      )}
    </Sheet>
  );
}
