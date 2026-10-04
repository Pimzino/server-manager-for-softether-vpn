import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Badge, Button, Checkbox, Divider, Group, List, Modal, PasswordInput, Select, Stack, Switch, Table, Tabs, Text, TextInput, Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconEdit, IconInfoCircle, IconLock, IconLockOpen, IconPlus, IconShieldOff, IconTrash, IconUserPlus } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, Empty, PageHeader, QueryState, Section } from "../../components/common";
import { del, get, post, put } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { notifyError, useServers } from "../../lib/hooks";
import { ago, dt } from "../../lib/format";
import type { Grant, Role, UserWithGrants } from "../../lib/types";

const ROLES: { value: Role; label: string; description: string }[] = [
  { value: "admin", label: "Admin", description: "Full control: servers, users, settings and dangerous operations on every server." },
  { value: "operator", label: "Operator", description: "Configure hubs, users, sessions and most settings on every server; no dangerous server-wide operations." },
  { value: "viewer", label: "Viewer", description: "Read-only access to every server." },
  { value: "none", label: "None (grants only)", description: "No global access. The user sees only the servers / hubs granted below." },
];
const GRANT_ROLES = ROLES.filter((r) => r.value !== "none");
const ROLE_COLOR: Record<Role, string> = { admin: "red", operator: "blue", viewer: "teal", none: "gray" };

const isLocked = (u: UserWithGrants) => !!u.lockedUntil && u.lockedUntil > Date.now();

function RoleSelect({ value, onChange, disabled, label = "Global role", data = ROLES }: { value: string; onChange: (v: Role) => void; disabled?: boolean; label?: string; data?: typeof ROLES }) {
  return (
    <Select
      label={label} data={data.map((r) => ({ value: r.value, label: r.label }))} value={value} onChange={(v) => v && onChange(v as Role)} allowDeselect={false} disabled={disabled}
      description={data.find((r) => r.value === value)?.description}
    />
  );
}

function ScopingHelp() {
  return (
    <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />} title="How access is resolved">
      <List size="sm" spacing={2}>
        <List.Item>The <b>global role</b> applies to every server registered here.</List.Item>
        <List.Item><b>Grants</b> can only <i>elevate</i> access: on all servers, on one specific server, or on a single Virtual Hub of a server. The highest applicable role wins.</List.Item>
        <List.Item>A user with global role <b>None</b> sees only servers they have a grant on. With only <b>hub grants</b> they see just those Virtual Hubs — ideal for helpdesk-style delegated hub administration.</List.Item>
        <List.Item>Global administration pages (users, settings) always require the global <b>Admin</b> role.</List.Item>
      </List>
    </Alert>
  );
}

// ---------------------------------------------------------------- Create
function CreateUserModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const reset = () => { setUsername(""); setDisplayName(""); setEmail(""); setRole("viewer"); setPassword(""); setConfirm(""); setMustChange(true); };
  const create = useMutation({
    mutationFn: () => post("/api/users", { username: username.trim(), displayName: displayName.trim(), email: email.trim(), role, password, mustChangePassword: mustChange }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["users"] });
      notifications.show({ color: "green", message: `User ${username} created` });
      onClose(); reset();
    },
    onError: (e) => notifyError(e, "Could not create user"),
  });
  const userValid = /^[A-Za-z0-9._@-]+$/.test(username.trim());
  const emailValid = !email || /^[^\s@]+@[^\s@]+$/.test(email.trim());
  return (
    <Modal opened={opened} onClose={onClose} title="Create user" centered size="lg">
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Stack data-testid="create-user-form">
          <TextInput label="Username" required value={username} onChange={(e) => setUsername(e.currentTarget.value)} maxLength={64} data-autofocus data-testid="new-user-username"
            error={username && !userValid ? "Letters, digits and . _ @ - only" : undefined} description="Used to sign in. Cannot be changed later." />
          <Group grow>
            <TextInput label="Display name" value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} maxLength={128} />
            <TextInput label="E-mail" value={email} onChange={(e) => setEmail(e.currentTarget.value)} maxLength={256} error={!emailValid ? "Invalid e-mail address" : undefined} />
          </Group>
          <RoleSelect value={role} onChange={setRole} />
          <PasswordInput label="Initial password" required value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="new-password" data-testid="new-user-password"
            description="Must satisfy the password policy (see Settings) and not contain the username." />
          <PasswordInput label="Confirm password" required value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} autoComplete="new-password"
            error={confirm && confirm !== password ? "Passwords do not match" : undefined} />
          <Checkbox label="Require a password change at first sign-in" checked={mustChange} onChange={(e) => setMustChange(e.currentTarget.checked)} />
          {role === "none" && <Text size="xs" c="dimmed">After creating the user, open it and add server or hub grants — otherwise the user cannot see anything.</Text>}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={create.isPending} disabled={!userValid || !password || password !== confirm || !emailValid} data-testid="create-user-submit">Create user</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- Grants
function GrantsEditor({ user }: { user: UserWithGrants }) {
  const qc = useQueryClient();
  const servers = useServers();
  const [serverId, setServerId] = useState<string>("all");
  const [hub, setHub] = useState<string | null>(null);
  const [role, setRole] = useState<Role>("operator");
  const server = servers.data?.find((s) => String(s.id) === serverId);
  const hubOptions = useMemo(() => {
    if (!server) return [];
    const names = (server.state?.hubs?.HubList ?? []).map((h) => h.HubName_str);
    if (server.hub && !names.includes(server.hub)) names.push(server.hub);
    return [...new Set(names)].sort().map((h) => ({ value: h, label: h }));
  }, [server]);
  useEffect(() => setHub(null), [serverId]);

  const add = useMutation({
    mutationFn: () => post(`/api/users/${user.id}/grants`, { serverId: serverId === "all" ? null : Number(serverId), hub: serverId === "all" ? null : hub, role }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["users"] }); notifications.show({ color: "green", message: "Grant added" }); setHub(null); },
    onError: (e) => notifyError(e, "Could not add grant"),
  });
  const remove = useMutation({
    mutationFn: (g: Grant) => del(`/api/users/${user.id}/grants/${g.id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["users"] }); notifications.show({ color: "green", message: "Grant removed" }); },
    onError: (e) => notifyError(e, "Could not remove grant"),
  });

  const scopeText = (g: Grant) => g.serverId === null ? "All servers" : g.hub ? `Hub ${g.hub} on ${g.serverName ?? `server #${g.serverId}`}` : `Server ${g.serverName ?? `#${g.serverId}`}`;
  const redundant = (g: Grant) => ["none", "viewer", "operator", "admin"].indexOf(user.role) >= ["none", "viewer", "operator", "admin"].indexOf(g.role);
  const duplicate = user.grants.some((g) => (g.serverId === (serverId === "all" ? null : Number(serverId))) && (g.hub ?? null) === (serverId === "all" ? null : hub) && g.role === role);

  return (
    <Stack>
      <ScopingHelp />
      {user.grants.length === 0 ? <Empty>No grants — the user has only their global role ({user.role}).</Empty> : (
        <Table withTableBorder data-testid="grants-table">
          <Table.Thead><Table.Tr><Table.Th>Scope</Table.Th><Table.Th>Role</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {user.grants.map((g) => (
              <Table.Tr key={g.id}>
                <Table.Td>
                  <Text size="sm">{scopeText(g)}</Text>
                  {redundant(g) && <Text size="xs" c="dimmed">No effect: the global role ({user.role}) is already at least {g.role}.</Text>}
                </Table.Td>
                <Table.Td><Badge color={ROLE_COLOR[g.role]} variant="light">{g.role}</Badge></Table.Td>
                <Table.Td ta="right">
                  <ConfirmButton title="Remove grant?" message={`${user.username} loses ${g.role} access on: ${scopeText(g)}.`} confirmLabel="Remove"
                    onConfirm={() => remove.mutateAsync(g)} leftSection={<IconTrash size={14} />}>Remove</ConfirmButton>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <Divider label="Add grant" labelPosition="left" />
      <Group align="flex-end" wrap="wrap" data-testid="grant-form">
        <Select label="Server" w={220} value={serverId} onChange={(v) => setServerId(v ?? "all")} allowDeselect={false} searchable
          data={[{ value: "all", label: "All servers" }, ...(servers.data ?? []).map((s) => ({ value: String(s.id), label: s.name }))]} data-testid="grant-server" />
        <Select label="Virtual Hub" w={220} value={hub} onChange={setHub} disabled={serverId === "all"} clearable searchable
          placeholder={serverId === "all" ? "n/a for all servers" : "Entire server"} data={hubOptions}
          nothingFoundMessage={server && !server.state?.hubs ? "Hub list unavailable (server offline?)" : "No hubs"} data-testid="grant-hub" />
        <Select label="Role" w={160} value={role} onChange={(v) => v && setRole(v as Role)} allowDeselect={false} data={GRANT_ROLES.map((r) => ({ value: r.value, label: r.label }))} data-testid="grant-role" />
        <Button leftSection={<IconPlus size={16} />} onClick={() => add.mutate()} loading={add.isPending} disabled={duplicate} data-testid="grant-add">Add grant</Button>
      </Group>
      <Text size="xs" c="dimmed">
        {serverId === "all" ? `Grants ${role} on every server (same effect as raising the global role, but kept separate for auditing).`
          : hub ? `Grants ${role} on Virtual Hub “${hub}” only. The user will not see other hubs or server-wide settings unless their global role allows it.`
          : `Grants ${role} on every hub and server-wide setting of ${server?.name ?? "this server"}.`}
        {role === "admin" && serverId !== "all" && " Admin on a server allows dangerous operations there (e.g. deleting hubs, changing certificates)."}
      </Text>
    </Stack>
  );
}

// ---------------------------------------------------------------- Edit
function EditUserModal({ user, onClose }: { user: UserWithGrants | null; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useAuth().user;
  const [tab, setTab] = useState<string | null>("profile");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [disabled, setDisabled] = useState(false);
  const [mustChange, setMustChange] = useState(false);
  const [pw, setPw] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwMustChange, setPwMustChange] = useState(true);

  useEffect(() => {
    if (!user) return;
    setDisplayName(user.displayName); setEmail(user.email); setRole(user.role); setDisabled(user.disabled); setMustChange(user.mustChangePassword);
    setPw(""); setPwConfirm(""); setPwMustChange(true);
  }, [user?.id]);
  useEffect(() => { if (user) setTab("profile"); }, [user?.id]);

  const update = useMutation({
    mutationFn: (b: Record<string, unknown>) => put(`/api/users/${user!.id}`, b),
    onSuccess: (_r, b) => {
      void qc.invalidateQueries({ queryKey: ["users"] });
      const msg = b.password ? "Password reset" : b.resetMfa ? "Two-factor authentication reset" : b.unlock ? "Account unlocked" : "User updated";
      notifications.show({ color: "green", message: msg });
      if (b.password) { setPw(""); setPwConfirm(""); }
    },
    onError: (e) => notifyError(e, "Could not update user"),
  });
  const isSelf = !!user && me?.id === user.id;
  if (!user) return <Modal opened={false} onClose={onClose}>{null}</Modal>;
  return (
    <Modal opened={!!user} onClose={onClose} title={<Group gap="xs"><Text fw={700}>{user.username}</Text>{isSelf && <Badge size="xs">you</Badge>}</Group>} size="xl" centered>
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="profile">Profile & role</Tabs.Tab>
          <Tabs.Tab value="security">Security</Tabs.Tab>
          <Tabs.Tab value="grants">Access grants ({user.grants.length})</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="profile" pt="md">
          <form onSubmit={(e) => { e.preventDefault(); update.mutate({ displayName: displayName.trim(), email: email.trim(), role, disabled, mustChangePassword: mustChange }); }}>
            <Stack data-testid="edit-user-profile">
              <Group grow>
                <TextInput label="Display name" value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} maxLength={128} />
                <TextInput label="E-mail" value={email} onChange={(e) => setEmail(e.currentTarget.value)} maxLength={256} />
              </Group>
              <RoleSelect value={role} onChange={setRole} disabled={isSelf} />
              {isSelf && <Text size="xs" c="dimmed">You cannot change your own role or disable your own account.</Text>}
              <Switch label="Account disabled" description="Disabled users cannot sign in; their sessions are ended immediately." checked={disabled} onChange={(e) => setDisabled(e.currentTarget.checked)} disabled={isSelf} color="red" data-testid="edit-user-disabled" />
              <Switch label="Require password change at next sign-in" checked={mustChange} onChange={(e) => setMustChange(e.currentTarget.checked)} />
              <Group justify="flex-end">
                <Button variant="default" onClick={onClose}>Close</Button>
                <Button type="submit" loading={update.isPending} data-testid="edit-user-save">Save</Button>
              </Group>
            </Stack>
          </form>
        </Tabs.Panel>
        <Tabs.Panel value="security" pt="md">
          <Stack data-testid="edit-user-security">
            <Section title="Reset password" description="Sets a new password and signs the user out everywhere.">
              <form onSubmit={(e) => { e.preventDefault(); update.mutate({ password: pw, mustChangePassword: pwMustChange }); }}>
                <Stack maw={420}>
                  <PasswordInput label="New password" value={pw} onChange={(e) => setPw(e.currentTarget.value)} autoComplete="new-password" required data-testid="reset-password" />
                  <PasswordInput label="Confirm" value={pwConfirm} onChange={(e) => setPwConfirm(e.currentTarget.value)} autoComplete="new-password" required
                    error={pwConfirm && pwConfirm !== pw ? "Passwords do not match" : undefined} />
                  <Checkbox label="User must change it at next sign-in" checked={pwMustChange} onChange={(e) => setPwMustChange(e.currentTarget.checked)} />
                  <Group><Button type="submit" disabled={!pw || pw !== pwConfirm} loading={update.isPending && !!update.variables?.password} data-testid="reset-password-submit">Reset password</Button></Group>
                </Stack>
              </form>
            </Section>
            <Section title="Two-factor authentication" description={user.mfaEnabled ? "Enabled. Reset it if the user lost their authenticator device; they can enrol again from My account." : "Not enabled for this user."}>
              <ConfirmButton disabled={!user.mfaEnabled} title={`Reset MFA for ${user.username}?`} message="The user will be able to sign in with the password alone until they enrol a new authenticator."
                confirmLabel="Reset MFA" onConfirm={() => update.mutateAsync({ resetMfa: true })} leftSection={<IconShieldOff size={14} />}>Reset MFA</ConfirmButton>
            </Section>
            <Section title="Lockout" description="Accounts are locked for 15 minutes after 5 failed sign-in attempts.">
              <Group>
                {isLocked(user) ? <Badge color="red" leftSection={<IconLock size={12} />}>Locked until {dt(user.lockedUntil)}</Badge> : <Badge color="green" variant="light">Not locked</Badge>}
                <Button size="xs" variant="light" leftSection={<IconLockOpen size={14} />} disabled={!isLocked(user)} onClick={() => update.mutate({ unlock: true })} data-testid="unlock-user">Unlock now</Button>
              </Group>
            </Section>
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="grants" pt="md">
          <GrantsEditor user={user} />
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

// ---------------------------------------------------------------- Page
export default function UsersPage() {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => get<UserWithGrants[]>("/api/users"), enabled: me?.role === "admin" });
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const editing = users.data?.find((u) => u.id === editingId) ?? null;
  const remove = useMutation({
    mutationFn: (id: number) => del(`/api/users/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["users"] }); notifications.show({ color: "green", message: "User deleted" }); },
    onError: (e) => notifyError(e, "Could not delete user"),
  });

  if (me?.role !== "admin") {
    return <><PageHeader title="Users & access" /><Alert color="gray" icon={<IconLock size={16} />}>Only administrators can manage users.</Alert></>;
  }

  return (
    <>
      <PageHeader
        title="Users & access"
        description="Accounts that can sign in to this management server, their global role, and per-server or per-hub access grants."
        actions={<Button leftSection={<IconUserPlus size={16} />} onClick={() => setCreating(true)} data-testid="create-user">Create user</Button>}
      />
      <QueryState query={users}>
        <DataTable
          testId="users-table"
          data={users.data}
          rowKey={(u) => u.id}
          onRowClick={(u) => setEditingId(u.id)}
          initialSort={{ key: "username", dir: "asc" }}
          columns={[
            { key: "username", title: "User", render: (u) => (
              <div>
                <Group gap={6}><Text fw={600} size="sm">{u.username}</Text>{u.id === me.id && <Badge size="xs">you</Badge>}</Group>
                {(u.displayName || u.email) && <Text size="xs" c="dimmed">{[u.displayName, u.email].filter(Boolean).join(" · ")}</Text>}
              </div>
            ), value: (u) => `${u.username} ${u.displayName} ${u.email}` },
            { key: "role", title: "Role", render: (u) => <Badge color={ROLE_COLOR[u.role]} variant="light">{u.role}</Badge> },
            { key: "grants", title: "Grants", value: (u) => u.grants.length, render: (u) => u.grants.length === 0 ? <Text size="sm" c="dimmed">–</Text> : (
              <Tooltip multiline w={320} label={u.grants.map((g) => `${g.role}: ${g.serverId === null ? "all servers" : g.hub ? `${g.serverName}/${g.hub}` : g.serverName}`).join("\n")} style={{ whiteSpace: "pre-line" }}>
                <Badge variant="outline" color="gray">{u.grants.length} grant(s)</Badge>
              </Tooltip>
            ) },
            { key: "mfaEnabled", title: "MFA", value: (u) => (u.mfaEnabled ? 1 : 0), render: (u) => u.mfaEnabled ? <Badge color="green" variant="light">On</Badge> : <Badge color="gray" variant="light">Off</Badge> },
            { key: "status", title: "Status", value: (u) => (u.disabled ? 0 : isLocked(u) ? 1 : 2), render: (u) => (
              <Group gap={4}>
                {u.disabled ? <Badge color="gray">Disabled</Badge> : isLocked(u) ? <Tooltip label={`Until ${dt(u.lockedUntil)}`}><Badge color="red" leftSection={<IconLock size={10} />}>Locked</Badge></Tooltip> : <Badge color="green" variant="light">Active</Badge>}
                {u.mustChangePassword && <Badge color="orange" variant="light" size="xs">must change pw</Badge>}
              </Group>
            ) },
            { key: "lastLoginAt", title: "Last sign-in", value: (u) => u.lastLoginAt ?? 0, render: (u) => <Tooltip label={dt(u.lastLoginAt)}><Text size="sm">{u.lastLoginAt ? ago(u.lastLoginAt) : "Never"}</Text></Tooltip> },
            { key: "createdAt", title: "Created", render: (u) => <Text size="sm">{dt(u.createdAt).slice(0, 10)}</Text> },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (u) => (
                <Group gap={4} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                  <Button size="xs" variant="subtle" leftSection={<IconEdit size={14} />} onClick={() => setEditingId(u.id)} data-testid={`edit-user-${u.username}`}>Edit</Button>
                  <ConfirmButton disabled={u.id === me.id} title={`Delete user ${u.username}?`}
                    message="The account, its sessions, API tokens and access grants are permanently removed. Audit log entries are kept."
                    typeToConfirm={u.username} confirmLabel="Delete user" onConfirm={() => remove.mutateAsync(u.id)} leftSection={<IconTrash size={14} />}>Delete</ConfirmButton>
                </Group>
              ),
            },
          ]}
        />
      </QueryState>
      <CreateUserModal opened={creating} onClose={() => setCreating(false)} />
      <EditUserModal user={editing} onClose={() => setEditingId(null)} />
    </>
  );
}
