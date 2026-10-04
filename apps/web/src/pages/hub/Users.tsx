import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ActionIcon, Alert, Badge, Button, Checkbox, Code, Drawer, FileButton, Group, Modal, PasswordInput, Radio, Select, SimpleGrid, Stack,
  Switch, Table, Tabs, Text, TextInput, Textarea, Tooltip, ScrollArea,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconCertificate, IconDownload, IconEdit, IconFileImport, IconKey, IconPlus, IconRefresh, IconTrash, IconUpload, IconWand, IconDeviceDesktopPlus,
} from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, Copyable, ErrorAlert, KeyValue, PageHeader, QueryState, ReadOnlyNotice } from "../../components/common";
import { PolicyEditor, hasPolicyFields, withPolicyDefaults } from "../../components/hub/PolicyEditor";
import { fmtField } from "../../components/hub/StatusView";
import {
  AUTH_TYPES, ZERO_DT, authLabel, b64ToBytes, b64ToHex, certFileToDerB64, derB64ToPem, generatePassword, hexToB64, isoToLocalInput, localInputToIso,
  parseCsv, runSequential, toCsv,
} from "../../components/hub/util";
import { rpc } from "../../lib/api";
import { ago, bytes, downloadText, dt, isNever, num } from "../../lib/format";
import { can, useCatalog, useRpc, useRpcMutation, useScope, useServer } from "../../lib/hooks";

type Struct = Record<string, any>;

interface UserItem {
  Name_str: string; GroupName_str: string; Realname_utf: string; Note_utf: string; AuthType_u32: number; NumLogin_u32: number;
  LastLoginTime_dt: string; DenyAccess_bool: boolean; IsTrafficFilled_bool: boolean; IsExpiresFilled_bool: boolean; Expires_dt: string;
  [k: string]: unknown;
}
interface GroupItem { Name_str: string; Realname_utf: string; Note_utf: string; NumUsers_u32: number; DenyAccess_bool: boolean }


function trafficOf(u: Struct, prefix = "Ex.") {
  const n = (k: string) => Number(u[`${prefix}${k}`] ?? 0);
  return {
    rx: n("Recv.UnicastBytes_u64") + n("Recv.BroadcastBytes_u64"),
    tx: n("Send.UnicastBytes_u64") + n("Send.BroadcastBytes_u64"),
  };
}

function isExpired(u: UserItem) {
  return u.IsExpiresFilled_bool && !isNever(u.Expires_dt) && new Date(u.Expires_dt).getTime() < Date.now();
}

/* ======================================================================== user editor */

const NEW_USER: Struct = {
  Name_str: "", GroupName_str: "", Realname_utf: "", Note_utf: "", ExpireTime_dt: ZERO_DT, AuthType_u32: 1,
  UserX_bin: "", Serial_bin: "", CommonName_utf: "", RadiusUsername_utf: "", NtUsername_utf: "", UsePolicy_bool: false,
};

function UserDrawer({
  serverId, hub, name, opened, onClose, canWrite, groups,
}: { serverId: number; hub: string; name: string | null; opened: boolean; onClose: () => void; canWrite: boolean; groups: GroupItem[] }) {
  const isNew = name === null;
  const cat = useCatalog();
  const doc = (f: string) => cat.data?.types["VpnRpcSetUser"]?.fields.find((x) => x.name === f)?.doc;
  const q = useRpc<Struct>(serverId, "GetUser", { HubName_str: hub, Name_str: name ?? "" }, { enabled: opened && !isNew, staleTime: 0 });
  const [form, setForm] = useState<Struct>(NEW_USER);
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [shownPw, setShownPw] = useState<string | null>(null);
  const [serialHex, setSerialHex] = useState("");
  const [tab, setTab] = useState<string | null>("general");
  const [certError, setCertError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    const base = isNew ? { ...NEW_USER } : q.data ? { ...q.data } : null;
    if (!base) return;
    setForm(base);
    setSerialHex(b64ToHex(base.Serial_bin as string, ":"));
    setPassword(""); setPassword2(""); setShownPw(null); setCertError(null);
  }, [opened, isNew, q.data]);
  useEffect(() => { if (opened) setTab("general"); }, [opened, name]);

  const origAuth = isNew ? -1 : Number(q.data?.AuthType_u32 ?? -1);
  const set = (patch: Struct) => setForm((f) => ({ ...f, ...patch }));
  const auth = Number(form.AuthType_u32 ?? 0);
  const neverExpires = isNever(form.ExpireTime_dt as string);

  const create = useRpcMutation(serverId, "CreateUser", { success: "User created", onSuccess: () => onClose() });
  const save = useRpcMutation(serverId, "SetUser", { success: "User saved", onSuccess: () => onClose() });

  const errors: string[] = [];
  const nameTrim = String(form.Name_str ?? "").trim();
  if (isNew && !nameTrim) errors.push("User name is required");
  if (isNew && /\s/.test(nameTrim)) errors.push("User name must not contain spaces");
  if (auth === 1 && (isNew || origAuth !== 1) && !password) errors.push("A password is required for password authentication");
  if (auth === 1 && password !== password2) errors.push("Passwords do not match");
  if (auth === 2 && b64ToBytes(form.UserX_bin as string).length === 0) errors.push("Upload the user's X.509 certificate");
  if (auth === 3 && hexToB64(serialHex) === null) errors.push("Serial number must be hexadecimal bytes (e.g. 01:A2:FF)");
  if (!neverExpires && Number.isNaN(new Date(form.ExpireTime_dt as string).getTime())) errors.push("Invalid expiration date");

  const submit = () => {
    if (errors.length) { notifications.show({ color: "red", message: errors[0] }); return; }
    let p: Struct = { ...form, HubName_str: hub, Name_str: isNew ? nameTrim : name };
    delete p.Auth_Password_str;
    if (auth === 1 && password) p.Auth_Password_str = password;
    // Blank password on edit: HashedKey_bin / NtLmSecureHash_bin from GetUser are passed back unchanged,
    // which keeps the existing password (verified: omitting them zeroes the hash, "" sets an empty password).
    if (auth === 3) p.Serial_bin = hexToB64(serialHex) ?? "";
    p.UsePolicy_bool = !!form.UsePolicy_bool;
    if (p.UsePolicy_bool) p = withPolicyDefaults(p);
    if (isNew) create.mutate(p); else save.mutate(p);
  };

  const pending = create.isPending || save.isPending;
  const ro = !canWrite;

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="xl"
      title={<Text fw={700}>{isNew ? "Create user" : <>User <Code>{name}</Code></>}</Text>}>
      {!isNew && q.isLoading ? <QueryState query={q}>{null}</QueryState> : !isNew && q.error ? <ErrorAlert error={q.error} /> : (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} data-testid="user-form">
          <Tabs value={tab} onChange={setTab} keepMounted={false}>
            <Tabs.List mb="md">
              <Tabs.Tab value="general">General</Tabs.Tab>
              <Tabs.Tab value="auth" leftSection={<IconKey size={14} />}>Authentication</Tabs.Tab>
              <Tabs.Tab value="policy">Security policy {form.UsePolicy_bool ? <Badge size="xs" ml={4}>on</Badge> : null}</Tabs.Tab>
              {!isNew && <Tabs.Tab value="stats">Statistics</Tabs.Tab>}
            </Tabs.List>

            <Tabs.Panel value="general">
              <Stack gap="sm">
                <TextInput label="User name" required={isNew} readOnly={!isNew} value={String(form.Name_str ?? "")} data-autofocus
                  description={isNew ? `${doc("Name_str") ?? ""} Name "*" creates the default user for RADIUS / NT domain authentication of unknown users. User names cannot be renamed later.` : "User names cannot be changed."}
                  onChange={(e) => set({ Name_str: e.currentTarget.value })} data-testid="user-name" />
                <TextInput label="Full name" description={doc("Realname_utf")} value={String(form.Realname_utf ?? "")} readOnly={ro}
                  onChange={(e) => set({ Realname_utf: e.currentTarget.value })} data-testid="user-realname" />
                <Textarea label="Note" description={doc("Note_utf")} value={String(form.Note_utf ?? "")} readOnly={ro} autosize minRows={2}
                  onChange={(e) => set({ Note_utf: e.currentTarget.value })} data-testid="user-note" />
                <Select label="Group" description="Group membership; the group's security policy applies when the user has none of its own."
                  placeholder="No group" clearable searchable readOnly={ro}
                  data={[...new Set([...groups.map((g) => g.Name_str), ...(form.GroupName_str ? [String(form.GroupName_str)] : [])])].map((g) => {
                    const gi = groups.find((x) => x.Name_str === g);
                    return { value: g, label: gi?.Realname_utf ? `${g} — ${gi.Realname_utf}` : g };
                  })}
                  value={form.GroupName_str ? String(form.GroupName_str) : null}
                  onChange={(v) => set({ GroupName_str: v ?? "" })} data-testid="user-group" />
                <Stack gap={4}>
                  <Switch label="Account never expires" checked={neverExpires} disabled={ro}
                    onChange={(e) => set({ ExpireTime_dt: e.currentTarget.checked ? ZERO_DT : new Date(Date.now() + 30 * 86400_000).toISOString() })}
                    data-testid="user-never-expires" />
                  {!neverExpires && (
                    <TextInput type="datetime-local" label="Expiration date and time" description={`${doc("ExpireTime_dt") ?? ""} (your local time). After this moment the user can no longer log in.`}
                      value={isoToLocalInput(form.ExpireTime_dt as string)} readOnly={ro}
                      onChange={(e) => set({ ExpireTime_dt: localInputToIso(e.currentTarget.value) })} data-testid="user-expiry" />
                  )}
                </Stack>
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="auth">
              <Stack gap="sm">
                <Radio.Group label="Authentication type" description={doc("AuthType_u32")} value={String(auth)}
                  onChange={(v) => set({ AuthType_u32: Number(v) })} data-testid="user-authtype">
                  <Stack gap={6} mt={6}>
                    {AUTH_TYPES.map((a) => (
                      <Radio key={a.value} value={String(a.value)} label={a.label} description={a.description} disabled={ro} />
                    ))}
                  </Stack>
                </Radio.Group>

                {auth === 1 && (
                  <Stack gap="xs">
                    {!isNew && origAuth === 1 && <Alert color="blue" variant="light">Leave the password fields blank to keep the current password.</Alert>}
                    <Group align="flex-end" gap="xs" wrap="nowrap">
                      <PasswordInput style={{ flex: 1 }} label={isNew || origAuth !== 1 ? "Password" : "New password"} description={doc("Auth_Password_str")}
                        value={password} onChange={(e) => { setPassword(e.currentTarget.value); setShownPw(null); }} autoComplete="new-password"
                        readOnly={ro} required={isNew || origAuth !== 1} data-testid="user-password" />
                      <Tooltip label="Generate a strong random password">
                        <Button variant="light" leftSection={<IconWand size={14} />} disabled={ro} data-testid="user-generate-password"
                          onClick={() => { const pw = generatePassword(); setPassword(pw); setPassword2(pw); setShownPw(pw); }}>Generate</Button>
                      </Tooltip>
                    </Group>
                    <PasswordInput label="Confirm password" value={password2} onChange={(e) => setPassword2(e.currentTarget.value)} autoComplete="new-password"
                      readOnly={ro} error={password2 && password !== password2 ? "Passwords do not match" : undefined} data-testid="user-password2" />
                    {shownPw && <Alert color="yellow" variant="light" title="Generated password">Copy it now; it cannot be retrieved later. <Copyable value={shownPw} /></Alert>}
                  </Stack>
                )}

                {auth === 2 && (
                  <Stack gap="xs">
                    <Text size="sm" c="dimmed">{doc("UserX_bin")} PEM or DER (.cer/.crt/.pem) files are accepted.</Text>
                    {b64ToBytes(form.UserX_bin as string).length > 0 ? (
                      <Group gap="xs">
                        <Badge leftSection={<IconCertificate size={12} />} variant="light" color="grape">Certificate loaded ({b64ToBytes(form.UserX_bin as string).length} bytes)</Badge>
                        <Button size="xs" variant="subtle" leftSection={<IconDownload size={14} />}
                          onClick={() => downloadText(`${nameTrim || "user"}.pem`, derB64ToPem(String(form.UserX_bin)), "application/x-pem-file")}>Download PEM</Button>
                      </Group>
                    ) : <Text size="sm" c="red">No certificate uploaded yet.</Text>}
                    {!ro && (
                      <FileButton accept=".cer,.crt,.pem,.der,application/x-x509-ca-cert" onChange={async (f) => {
                        if (!f) return;
                        try { set({ UserX_bin: await certFileToDerB64(f, "cert") }); setCertError(null); } catch (e) { setCertError((e as Error).message); }
                      }}>
                        {(props) => <Button {...props} w="fit-content" size="xs" leftSection={<IconUpload size={14} />} data-testid="user-cert-upload">Upload certificate…</Button>}
                      </FileButton>
                    )}
                    {certError && <Text size="sm" c="red">{certError}</Text>}
                  </Stack>
                )}

                {auth === 3 && (
                  <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <TextInput label="Limit to Common Name (CN)" description={`${doc("CommonName_utf") ?? ""} Leave empty to accept any CN.`}
                      value={String(form.CommonName_utf ?? "")} readOnly={ro} onChange={(e) => set({ CommonName_utf: e.currentTarget.value })} data-testid="user-cn" />
                    <TextInput label="Limit to serial number (hex)" description={`${doc("Serial_bin") ?? ""} Hex bytes, e.g. 01:A2:FF. Leave empty to accept any serial.`}
                      value={serialHex} readOnly={ro} error={hexToB64(serialHex) === null ? "Invalid hex" : undefined} ff="monospace"
                      onChange={(e) => setSerialHex(e.currentTarget.value)} data-testid="user-serial" />
                  </SimpleGrid>
                )}

                {auth === 4 && (
                  <TextInput label="User name on the RADIUS server" description={`${doc("RadiusUsername_utf") ?? ""} Leave empty to use the same user name.`}
                    value={String(form.RadiusUsername_utf ?? "")} readOnly={ro} onChange={(e) => set({ RadiusUsername_utf: e.currentTarget.value })} data-testid="user-radius-name" />
                )}
                {auth === 5 && (
                  <TextInput label="User name in the NT domain / Active Directory" description={`${doc("NtUsername_utf") ?? ""} Leave empty to use the same user name.`}
                    value={String(form.NtUsername_utf ?? "")} readOnly={ro} onChange={(e) => set({ NtUsername_utf: e.currentTarget.value })} data-testid="user-nt-name" />
                )}
                {(auth === 4) && <Text size="xs" c="dimmed">Configure the RADIUS server on the hub's RADIUS page.</Text>}
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="policy">
              <Stack gap="sm">
                <Switch label="Use a security policy for this user" checked={!!form.UsePolicy_bool} disabled={ro}
                  description={`${doc("UsePolicy_bool") ?? ""}. When off, the group's policy (if any) or the hub default applies.`}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setForm((f) => (on && !hasPolicyFields(f) ? withPolicyDefaults({ ...f, UsePolicy_bool: true }) : { ...f, UsePolicy_bool: on }));
                  }} data-testid="user-use-policy" />
                {form.UsePolicy_bool ? <PolicyEditor value={form} onChange={set} readOnly={ro} /> : null}
              </Stack>
            </Tabs.Panel>

            {!isNew && q.data && (
              <Tabs.Panel value="stats">
                <KeyValue rows={[
                  ["Created", dt(q.data.CreatedTime_dt)],
                  ["Last modified", dt(q.data.UpdatedTime_dt)],
                  ["Number of logins", num(q.data.NumLogin_u32)],
                  ["Unicast sent", fmtField("Send.UnicastBytes_u64", q.data["Send.UnicastBytes_u64"])],
                  ["Unicast packets sent", num(q.data["Send.UnicastCount_u64"])],
                  ["Broadcast sent", fmtField("Send.BroadcastBytes_u64", q.data["Send.BroadcastBytes_u64"])],
                  ["Broadcast packets sent", num(q.data["Send.BroadcastCount_u64"])],
                  ["Unicast received", fmtField("Recv.UnicastBytes_u64", q.data["Recv.UnicastBytes_u64"])],
                  ["Unicast packets received", num(q.data["Recv.UnicastCount_u64"])],
                  ["Broadcast received", fmtField("Recv.BroadcastBytes_u64", q.data["Recv.BroadcastBytes_u64"])],
                  ["Broadcast packets received", num(q.data["Recv.BroadcastCount_u64"])],
                ]} />
              </Tabs.Panel>
            )}
          </Tabs>

          {canWrite && (
            <Stack gap="xs" mt="lg">
              {errors.length > 0 && <Text size="sm" c="red">{errors[0]}</Text>}
              <Group justify="flex-end">
                <Button variant="default" onClick={onClose}>Cancel</Button>
                <Button type="submit" loading={pending} disabled={errors.length > 0} data-testid="user-save">{isNew ? "Create user" : "Save changes"}</Button>
              </Group>
            </Stack>
          )}
        </form>
      )}
    </Drawer>
  );
}

/* ======================================================================== CSV import */

interface ImportRow { line: number; name: string; password: string; group: string; realname: string; note: string; error?: string; exists?: boolean }

function ImportModal({ serverId, hub, opened, onClose, users, groups }: {
  serverId: number; hub: string; opened: boolean; onClose: () => void; users: UserItem[]; groups: GroupItem[];
}) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [existing, setExisting] = useState<"skip" | "update">("skip");
  const [createGroups, setCreateGroups] = useState(true);
  const [genPw, setGenPw] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ name: string; ok: boolean; action: string; error?: string; password?: string }[] | null>(null);

  useEffect(() => { if (opened) { setText(""); setResult(null); setProgress(0); } }, [opened]);

  const rows = useMemo<ImportRow[]>(() => {
    const parsed = parseCsv(text);
    if (!parsed.length) return [];
    const header = parsed[0].map((h) => h.trim().toLowerCase());
    const hasHeader = header.includes("name") || header.includes("username");
    const idx = (keys: string[], pos: number) => {
      if (!hasHeader) return pos;
      const i = header.findIndex((h) => keys.includes(h));
      return i;
    };
    const cName = idx(["name", "username", "user"], 0), cPw = idx(["password", "pass"], 1), cGroup = idx(["group", "groupname"], 2),
      cReal = idx(["realname", "fullname", "full name", "real name"], 3), cNote = idx(["note", "description"], 4);
    const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    const seen = new Set<string>();
    const existingNames = new Set(users.map((u) => u.Name_str.toLowerCase()));
    return parsed.slice(hasHeader ? 1 : 0).map((r, i) => {
      const row: ImportRow = { line: i + (hasHeader ? 2 : 1), name: cell(r, cName), password: r[cPw] ?? "", group: cell(r, cGroup), realname: cell(r, cReal), note: cell(r, cNote) };
      const k = row.name.toLowerCase();
      if (!row.name) row.error = "Missing user name";
      else if (/\s/.test(row.name)) row.error = "User name contains spaces";
      else if (seen.has(k)) row.error = "Duplicate name in file";
      else if (!row.password && !genPw && !existingNames.has(k)) row.error = "Missing password";
      seen.add(k);
      row.exists = existingNames.has(k);
      return row;
    });
  }, [text, users, genPw]);

  const valid = rows.filter((r) => !r.error && !(r.exists && existing === "skip"));
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
          return { action: "updated", password };
        }
        await rpc(serverId, "CreateUser", {
          HubName_str: hub, Name_str: r.name, GroupName_str: r.group, Realname_utf: r.realname, Note_utf: r.note,
          AuthType_u32: 1, Auth_Password_str: password, ExpireTime_dt: ZERO_DT,
        });
        return { action: "created", password };
      }, setProgress);
      setResult(res.map((x) => ({
        name: x.item.name, ok: x.ok, action: x.result?.action ?? "failed", error: x.error,
        password: x.ok && x.item.password === "" && x.result?.password ? x.result.password : undefined,
      })));
      const ok = res.filter((x) => x.ok).length;
      notifications.show({ color: ok === res.length ? "green" : "orange", message: `Imported ${ok} of ${res.length} user(s)` });
    } finally {
      setRunning(false);
      void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
    }
  };

  const generated = result?.filter((r) => r.password) ?? [];

  return (
    <Modal opened={opened} onClose={() => !running && onClose()} title="Import users from CSV" size="xl">
      {result ? (
        <Stack>
          <Text size="sm">{result.filter((r) => r.ok).length} succeeded, {result.filter((r) => !r.ok).length} failed.</Text>
          {generated.length > 0 && (
            <Alert color="yellow" title="Generated passwords">
              {generated.length} user(s) received a generated password. Download them now; they cannot be retrieved later.
              <Button mt="xs" size="xs" leftSection={<IconDownload size={14} />} data-testid="import-download-passwords"
                onClick={() => downloadText(`${hub}-imported-passwords.csv`, toCsv([["name", "password"], ...generated.map((g) => [g.name, g.password!])]), "text/csv")}>
                Download passwords CSV
              </Button>
            </Alert>
          )}
          <ScrollArea.Autosize mah={360}>
            <Table data-testid="import-results">
              <Table.Thead><Table.Tr><Table.Th>User</Table.Th><Table.Th>Result</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {result.map((r) => (
                  <Table.Tr key={r.name}><Table.Td>{r.name}</Table.Td>
                    <Table.Td>{r.ok ? <Badge color="green" variant="light">{r.action}</Badge> : <Text size="sm" c="red">{r.error}</Text>}</Table.Td></Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
          <Group justify="flex-end"><Button onClick={onClose}>Close</Button></Group>
        </Stack>
      ) : (
        <Stack>
          <Text size="sm" c="dimmed">
            Columns: <Code>name,password,group,realname,note</Code>. A header row is optional (column order is then detected from it).
            Imported users use password authentication.
          </Text>
          <Group>
            <FileButton accept=".csv,text/csv,text/plain" onChange={async (f) => f && setText(await f.text())}>
              {(props) => <Button {...props} variant="light" leftSection={<IconUpload size={14} />} data-testid="import-file">Choose CSV file…</Button>}
            </FileButton>
            <Button variant="subtle" size="xs" onClick={() => downloadText("users-template.csv", toCsv([["name", "password", "group", "realname", "note"], ["jdoe", "", "staff", "John Doe", "Laptop"]]), "text/csv")}>
              Download template
            </Button>
          </Group>
          <Textarea label="…or paste CSV" value={text} onChange={(e) => setText(e.currentTarget.value)} autosize minRows={4} maxRows={10} ff="monospace" data-testid="import-text" />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Radio.Group label="Existing users" value={existing} onChange={(v) => setExisting(v as "skip" | "update")}>
              <Stack gap={4} mt={4}>
                <Radio value="skip" label="Skip" />
                <Radio value="update" label="Update group / name / note (and password if given)" />
              </Stack>
            </Radio.Group>
            <Stack gap={6}>
              <Checkbox label="Generate a random password when the cell is empty" checked={genPw} onChange={(e) => setGenPw(e.currentTarget.checked)} />
              <Checkbox label={`Create missing groups${missingGroups.length ? ` (${missingGroups.join(", ")})` : ""}`} checked={createGroups} onChange={(e) => setCreateGroups(e.currentTarget.checked)} />
            </Stack>
          </SimpleGrid>
          {rows.length > 0 && (
            <ScrollArea.Autosize mah={280}>
              <Table striped data-testid="import-preview">
                <Table.Thead><Table.Tr><Table.Th>Line</Table.Th><Table.Th>Name</Table.Th><Table.Th>Group</Table.Th><Table.Th>Full name</Table.Th><Table.Th>Password</Table.Th><Table.Th>Status</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {rows.map((r) => (
                    <Table.Tr key={r.line}>
                      <Table.Td>{r.line}</Table.Td><Table.Td>{r.name}</Table.Td><Table.Td>{r.group}</Table.Td><Table.Td>{r.realname}</Table.Td>
                      <Table.Td>{r.password ? "••••••" : <Text span size="xs" c="dimmed">{r.exists ? "keep" : genPw ? "generate" : "–"}</Text>}</Table.Td>
                      <Table.Td>{r.error ? <Text size="xs" c="red">{r.error}</Text> : r.exists ? <Badge size="sm" color={existing === "skip" ? "gray" : "orange"} variant="light">{existing === "skip" ? "exists – skip" : "update"}</Badge> : <Badge size="sm" color="green" variant="light">new</Badge>}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
          )}
          {missingGroups.length > 0 && !createGroups && <Alert color="orange" variant="light">Groups {missingGroups.join(", ")} do not exist; those users will fail.</Alert>}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={running}>Cancel</Button>
            <Button onClick={run} loading={running} disabled={valid.length === 0} data-testid="import-run">
              {running ? `Importing ${progress}/${valid.length}` : `Import ${valid.length} user(s)`}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

/* ======================================================================== page */

export default function UsersPage() {
  const { serverId, hub = "" } = useScope();
  const role = useServer(serverId).data?.myRole;
  const canWrite = can(role, "operator");
  const nav = useNavigate();
  const qc = useQueryClient();
  const users = useRpc<{ UserList?: UserItem[] }>(serverId, "EnumUser", { HubName_str: hub });
  const groups = useRpc<{ GroupList?: GroupItem[] }>(serverId, "EnumGroup", { HubName_str: hub });
  const [editing, setEditing] = useState<{ name: string | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [authFilter, setAuthFilter] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const del = useRpcMutation(serverId, "DeleteUser", { success: "User deleted" });

  const list = users.data?.UserList ?? [];
  const groupList = groups.data?.GroupList ?? [];
  const filtered = list.filter((u) => (authFilter === null || String(u.AuthType_u32) === authFilter) && (groupFilter === null || (groupFilter === "" ? !u.GroupName_str : u.GroupName_str === groupFilter)));
  useEffect(() => { setSelected((s) => new Set([...s].filter((n) => list.some((u) => u.Name_str === n)))); }, [users.data]);

  const toggle = (n: string, on: boolean) => setSelected((s) => { const x = new Set(s); if (on) x.add(n); else x.delete(n); return x; });
  const allSelected = filtered.length > 0 && filtered.every((u) => selected.has(u.Name_str));

  const bulkDelete = async () => {
    const names = [...selected];
    const res = await runSequential(names, (n) => rpc(serverId, "DeleteUser", { HubName_str: hub, Name_str: n }));
    const failed = res.filter((r) => !r.ok);
    notifications.show({ color: failed.length ? "orange" : "green", message: `Deleted ${res.length - failed.length} of ${res.length} user(s)${failed.length ? `; failed: ${failed.map((f) => f.item).join(", ")}` : ""}` });
    setSelected(new Set());
    void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
  };

  const exportCsv = () => {
    const rows = [["name", "password", "group", "realname", "note", "auth_type", "expires", "num_logins", "last_login", "access_denied", "bytes_received", "bytes_sent"],
      ...list.map((u) => {
        const t = trafficOf(u);
        return [u.Name_str, "", u.GroupName_str, u.Realname_utf, u.Note_utf, authLabel(u.AuthType_u32)?.label ?? u.AuthType_u32,
          u.IsExpiresFilled_bool && !isNever(u.Expires_dt) ? u.Expires_dt : "", u.NumLogin_u32, isNever(u.LastLoginTime_dt) ? "" : u.LastLoginTime_dt,
          u.DenyAccess_bool, t.rx, t.tx];
      })];
    downloadText(`${hub}-users.csv`, toCsv(rows), "text/csv");
  };

  return (
    <>
      <PageHeader
        title="Users"
        description="Users registered in this Virtual Hub's security account database. Each user authenticates with a password, a certificate, RADIUS or an NT domain, and may carry its own security policy."
        actions={<>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => users.refetch()} loading={users.isFetching}>Refresh</Button>
          <Button variant="default" leftSection={<IconDownload size={16} />} onClick={exportCsv} disabled={!list.length} data-testid="export-users">Export CSV</Button>
          {canWrite && <Button variant="default" leftSection={<IconFileImport size={16} />} onClick={() => setImporting(true)} data-testid="import-users">Import CSV</Button>}
          {canWrite && <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing({ name: null })} data-testid="create-user">Create user</Button>}
        </>}
      />
      {!canWrite && role && <ReadOnlyNotice role={role} />}
      <QueryState query={users}>
        <DataTable
          testId="users-table"
          data={filtered}
          rowKey={(u) => u.Name_str}
          onRowClick={(u) => setEditing({ name: u.Name_str })}
          initialSort={{ key: "Name_str", dir: "asc" }}
          empty="No users yet"
          toolbar={<>
            <Select size="sm" w={170} placeholder="All auth types" clearable value={authFilter} onChange={setAuthFilter}
              data={AUTH_TYPES.map((a) => ({ value: String(a.value), label: a.label }))} aria-label="Filter by auth type" />
            <Select size="sm" w={170} placeholder="All groups" clearable value={groupFilter} onChange={setGroupFilter}
              data={[{ value: "", label: "(no group)" }, ...groupList.map((g) => ({ value: g.Name_str, label: g.Name_str }))]} aria-label="Filter by group" />
            {canWrite && selected.size > 0 && (
              <ConfirmButton title={`Delete ${selected.size} user(s)?`} size="sm" leftSection={<IconTrash size={14} />}
                message={<>The following users will be permanently deleted and can no longer connect: <b>{[...selected].slice(0, 20).join(", ")}{selected.size > 20 ? "…" : ""}</b></>}
                typeToConfirm={selected.size > 1 ? `delete ${selected.size} users` : undefined} confirmLabel="Delete users" onConfirm={bulkDelete}>
                <span data-testid="bulk-delete-users">Delete selected ({selected.size})</span>
              </ConfirmButton>
            )}
          </>}
          columns={[
            ...(canWrite ? [{
              key: "sel", sortable: false, width: 36,
              title: <Checkbox size="xs" aria-label="Select all" checked={allSelected} indeterminate={!allSelected && filtered.some((u) => selected.has(u.Name_str))}
                onChange={(e) => { const on = e.currentTarget.checked; setSelected(on ? new Set(filtered.map((u) => u.Name_str)) : new Set()); }} />,
              render: (u: UserItem) => (
                <div onClick={(e) => e.stopPropagation()}>
                  <Checkbox size="xs" aria-label={`Select ${u.Name_str}`} checked={selected.has(u.Name_str)} onChange={(e) => toggle(u.Name_str, e.currentTarget.checked)} />
                </div>
              ),
              value: () => "",
            }] : []),
            { key: "Name_str", title: "User", render: (u) => <Text fw={600} size="sm">{u.Name_str}</Text> },
            { key: "Realname_utf", title: "Full name" },
            { key: "GroupName_str", title: "Group", render: (u) => u.GroupName_str ? <Badge variant="outline" color="gray">{u.GroupName_str}</Badge> : <Text size="sm" c="dimmed">–</Text> },
            { key: "AuthType_u32", title: "Auth", value: (u) => authLabel(u.AuthType_u32)?.label ?? u.AuthType_u32,
              render: (u) => { const a = authLabel(u.AuthType_u32); return <Badge variant="light" color={a?.color ?? "gray"}>{a?.short ?? u.AuthType_u32}</Badge>; } },
            { key: "status", title: "Status", value: (u) => (u.DenyAccess_bool ? "denied" : isExpired(u) ? "expired" : "active"),
              render: (u) => u.DenyAccess_bool ? <Badge color="red" variant="light">Denied</Badge> : isExpired(u) ? <Badge color="orange" variant="light">Expired</Badge> : <Badge color="green" variant="light">Active</Badge> },
            { key: "NumLogin_u32", title: "Logins", align: "right", render: (u) => num(u.NumLogin_u32) },
            { key: "LastLoginTime_dt", title: "Last login", value: (u) => (isNever(u.LastLoginTime_dt) ? "" : u.LastLoginTime_dt),
              render: (u) => <Tooltip label={dt(u.LastLoginTime_dt)}><span>{ago(u.LastLoginTime_dt)}</span></Tooltip> },
            { key: "Expires_dt", title: "Expires", value: (u) => (u.IsExpiresFilled_bool && !isNever(u.Expires_dt) ? u.Expires_dt : "9999"),
              render: (u) => (u.IsExpiresFilled_bool && !isNever(u.Expires_dt) ? dt(u.Expires_dt) : <Text size="sm" c="dimmed">Never</Text>) },
            { key: "traffic", title: "Traffic (rx / tx)", align: "right", value: (u) => { const t = trafficOf(u); return t.rx + t.tx; },
              render: (u) => { if (!u.IsTrafficFilled_bool) return "–"; const t = trafficOf(u); return `${bytes(t.rx)} / ${bytes(t.tx)}`; } },
            { key: "Note_utf", title: "Note", render: (u) => <Text size="sm" lineClamp={1} maw={200}>{u.Note_utf}</Text> },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (u) => (
                <Group gap={4} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                  <Tooltip label={canWrite ? "Edit" : "View"}><ActionIcon variant="subtle" onClick={() => setEditing({ name: u.Name_str })} aria-label={`Edit ${u.Name_str}`} data-testid={`edit-user-${u.Name_str}`}><IconEdit size={16} /></ActionIcon></Tooltip>
                  <Tooltip label="Create connection profile">
                    <ActionIcon variant="subtle" color="teal" aria-label={`Create connection profile for ${u.Name_str}`} data-testid={`profile-user-${u.Name_str}`}
                      onClick={() => nav(`/servers/${serverId}/hubs/${encodeURIComponent(hub)}/deploy`)}>
                      <IconDeviceDesktopPlus size={16} />
                    </ActionIcon>
                  </Tooltip>
                  {canWrite && (
                    <ConfirmButton title={`Delete user ${u.Name_str}?`} confirmLabel="Delete user" leftSection={<IconTrash size={14} />}
                      message={<>The user <b>{u.Name_str}</b> will be removed from the hub and can no longer connect. Existing sessions stay connected until they disconnect. To block temporarily, deny access in the user's security policy instead.</>}
                      onConfirm={() => del.mutateAsync({ HubName_str: hub, Name_str: u.Name_str })}>Delete</ConfirmButton>
                  )}
                </Group>
              ),
            },
          ]}
        />
      </QueryState>
      <UserDrawer serverId={serverId} hub={hub} name={editing?.name ?? null} opened={!!editing} onClose={() => setEditing(null)} canWrite={canWrite} groups={groupList} />
      <ImportModal serverId={serverId} hub={hub} opened={importing} onClose={() => setImporting(false)} users={list} groups={groupList} />
    </>
  );
}
