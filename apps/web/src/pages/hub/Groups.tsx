import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ActionIcon, Badge, Button, Code, Drawer, Group, Select, Stack, Switch, Table, Tabs, Text, TextInput, Textarea, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconEdit, IconPlus, IconRefresh, IconTrash, IconUserMinus, IconUserPlus } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, Empty, ErrorAlert, KeyValue, PageHeader, QueryState, ReadOnlyNotice } from "../../components/common";
import { PolicyEditor, hasPolicyFields, withPolicyDefaults } from "../../components/hub/PolicyEditor";
import { fmtField } from "../../components/hub/StatusView";
import { authLabel } from "../../components/hub/util";
import { rpc } from "../../lib/api";
import { num } from "../../lib/format";
import { can, notifyError, useCatalog, useRpc, useRpcMutation, useScope, useServer } from "../../lib/hooks";

type Struct = Record<string, any>;
interface GroupItem { Name_str: string; Realname_utf: string; Note_utf: string; NumUsers_u32: number; DenyAccess_bool: boolean }
interface UserItem { Name_str: string; GroupName_str: string; Realname_utf: string; AuthType_u32: number }

const NEW_GROUP: Struct = { Name_str: "", Realname_utf: "", Note_utf: "", UsePolicy_bool: false };

function Members({ serverId, hub, group, users, canWrite }: { serverId: number; hub: string; group: string; users: UserItem[]; canWrite: boolean }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const members = users.filter((u) => u.GroupName_str.toLowerCase() === group.toLowerCase());
  const others = users.filter((u) => u.GroupName_str.toLowerCase() !== group.toLowerCase());

  // Group membership lives on the user: GetUser, change GroupName_str, SetUser with the full struct
  // (includes the password hashes, so the password is preserved).
  const setGroup = async (user: string, newGroup: string) => {
    setBusy(user);
    try {
      const cur = await rpc<Struct>(serverId, "GetUser", { HubName_str: hub, Name_str: user });
      const p: Struct = { ...cur, HubName_str: hub, GroupName_str: newGroup };
      delete p.Auth_Password_str;
      await rpc(serverId, "SetUser", p);
      notifications.show({ color: "green", message: newGroup ? `${user} added to ${newGroup}` : `${user} removed from ${group}` });
      setAdding(null);
    } catch (e) {
      notifyError(e, "SetUser");
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
    }
  };

  return (
    <Stack gap="sm">
      {canWrite && (
        <Group align="flex-end">
          <Select style={{ flex: 1 }} label="Add a user to this group" description="Users can belong to one group; adding moves them from their current group."
            searchable placeholder="Select user" value={adding} onChange={setAdding}
            data={others.map((u) => ({ value: u.Name_str, label: u.GroupName_str ? `${u.Name_str} (currently in ${u.GroupName_str})` : u.Name_str }))}
            data-testid="group-add-member-select" />
          <Button leftSection={<IconUserPlus size={14} />} disabled={!adding} loading={!!busy && busy === adding} onClick={() => adding && setGroup(adding, group)} data-testid="group-add-member">Add</Button>
        </Group>
      )}
      {members.length === 0 ? <Empty>No users in this group</Empty> : (
        <Table striped data-testid="group-members-table">
          <Table.Thead><Table.Tr><Table.Th>User</Table.Th><Table.Th>Full name</Table.Th><Table.Th>Auth</Table.Th><Table.Th /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {members.map((u) => (
              <Table.Tr key={u.Name_str}>
                <Table.Td><Text fw={600} size="sm">{u.Name_str}</Text></Table.Td>
                <Table.Td>{u.Realname_utf}</Table.Td>
                <Table.Td><Badge variant="light" color={authLabel(u.AuthType_u32)?.color}>{authLabel(u.AuthType_u32)?.short ?? u.AuthType_u32}</Badge></Table.Td>
                <Table.Td align="right">
                  {canWrite && (
                    <Tooltip label="Remove from group">
                      <ActionIcon variant="subtle" color="red" loading={busy === u.Name_str} onClick={() => setGroup(u.Name_str, "")} aria-label={`Remove ${u.Name_str}`}>
                        <IconUserMinus size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}

function GroupDrawer({ serverId, hub, name, opened, onClose, canWrite, users }: {
  serverId: number; hub: string; name: string | null; opened: boolean; onClose: () => void; canWrite: boolean; users: UserItem[];
}) {
  const isNew = name === null;
  const cat = useCatalog();
  const doc = (f: string) => cat.data?.types["VpnRpcSetGroup"]?.fields.find((x) => x.name === f)?.doc;
  const q = useRpc<Struct>(serverId, "GetGroup", { HubName_str: hub, Name_str: name ?? "" }, { enabled: opened && !isNew, staleTime: 0 });
  const [form, setForm] = useState<Struct>(NEW_GROUP);
  const [tab, setTab] = useState<string | null>("general");
  useEffect(() => {
    if (!opened) return;
    if (isNew) setForm({ ...NEW_GROUP });
    else if (q.data) setForm({ ...q.data });
  }, [opened, isNew, q.data]);
  useEffect(() => { if (opened) setTab("general"); }, [opened, name]);
  const set = (patch: Struct) => setForm((f) => ({ ...f, ...patch }));

  const create = useRpcMutation(serverId, "CreateGroup", { success: "Group created", onSuccess: () => onClose() });
  const save = useRpcMutation(serverId, "SetGroup", { success: "Group saved", onSuccess: () => onClose() });
  const nameTrim = String(form.Name_str ?? "").trim();
  const error = isNew && !nameTrim ? "Group name is required" : isNew && /\s/.test(nameTrim) ? "Group name must not contain spaces" : null;

  const submit = () => {
    if (error) return;
    let p: Struct = { ...form, HubName_str: hub, Name_str: isNew ? nameTrim : name };
    p.UsePolicy_bool = !!form.UsePolicy_bool;
    if (p.UsePolicy_bool) p = withPolicyDefaults(p);
    if (isNew) create.mutate(p); else save.mutate(p);
  };
  const ro = !canWrite;

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="xl" title={<Text fw={700}>{isNew ? "Create group" : <>Group <Code>{name}</Code></>}</Text>}>
      {!isNew && q.isLoading ? <QueryState query={q}>{null}</QueryState> : !isNew && q.error ? <ErrorAlert error={q.error} /> : (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} data-testid="group-form">
          <Tabs value={tab} onChange={setTab} keepMounted={false}>
            <Tabs.List mb="md">
              <Tabs.Tab value="general">General</Tabs.Tab>
              <Tabs.Tab value="policy">Security policy {form.UsePolicy_bool ? <Badge size="xs" ml={4}>on</Badge> : null}</Tabs.Tab>
              {!isNew && <Tabs.Tab value="members">Members</Tabs.Tab>}
              {!isNew && <Tabs.Tab value="stats">Statistics</Tabs.Tab>}
            </Tabs.List>
            <Tabs.Panel value="general">
              <Stack gap="sm">
                <TextInput label="Group name" required={isNew} readOnly={!isNew} value={String(form.Name_str ?? "")} data-autofocus
                  description={isNew ? doc("Name_str") : "Group names cannot be changed."} error={isNew && nameTrim && error ? error : undefined}
                  onChange={(e) => set({ Name_str: e.currentTarget.value })} data-testid="group-name" />
                <TextInput label="Full name" description={doc("Realname_utf")} value={String(form.Realname_utf ?? "")} readOnly={ro}
                  onChange={(e) => set({ Realname_utf: e.currentTarget.value })} data-testid="group-realname" />
                <Textarea label="Note" description={doc("Note_utf")} value={String(form.Note_utf ?? "")} readOnly={ro} autosize minRows={2}
                  onChange={(e) => set({ Note_utf: e.currentTarget.value })} data-testid="group-note" />
              </Stack>
            </Tabs.Panel>
            <Tabs.Panel value="policy">
              <Stack gap="sm">
                <Switch label="Use a security policy for this group" checked={!!form.UsePolicy_bool} disabled={ro}
                  description={`${doc("UsePolicy_bool") ?? ""}. Applies to members that have no policy of their own.`}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    setForm((f) => (on && !hasPolicyFields(f) ? withPolicyDefaults({ ...f, UsePolicy_bool: true }) : { ...f, UsePolicy_bool: on }));
                  }} data-testid="group-use-policy" />
                {form.UsePolicy_bool ? <PolicyEditor value={form} onChange={set} readOnly={ro} /> : null}
              </Stack>
            </Tabs.Panel>
            {!isNew && name && (
              <Tabs.Panel value="members">
                <Members serverId={serverId} hub={hub} group={name} users={users} canWrite={canWrite} />
              </Tabs.Panel>
            )}
            {!isNew && q.data && (
              <Tabs.Panel value="stats">
                <KeyValue rows={[
                  "Send.UnicastBytes_u64", "Send.UnicastCount_u64", "Send.BroadcastBytes_u64", "Send.BroadcastCount_u64",
                  "Recv.UnicastBytes_u64", "Recv.UnicastCount_u64", "Recv.BroadcastBytes_u64", "Recv.BroadcastCount_u64",
                ].map((k) => [
                  `${k.startsWith("Send") ? "Sent" : "Received"} ${k.includes("Unicast") ? "unicast" : "broadcast"} ${k.includes("Count") ? "packets" : "bytes"}`,
                  fmtField(k, q.data![k]),
                ])} />
              </Tabs.Panel>
            )}
          </Tabs>
          {canWrite && tab !== "members" && (
            <Group justify="flex-end" mt="lg">
              <Button variant="default" onClick={onClose}>Cancel</Button>
              <Button type="submit" loading={create.isPending || save.isPending} disabled={!!error} data-testid="group-save">{isNew ? "Create group" : "Save changes"}</Button>
            </Group>
          )}
        </form>
      )}
    </Drawer>
  );
}

export default function GroupsPage() {
  const { serverId, hub = "" } = useScope();
  const role = useServer(serverId).data?.myRole;
  const canWrite = can(role, "operator");
  const groups = useRpc<{ GroupList?: GroupItem[] }>(serverId, "EnumGroup", { HubName_str: hub });
  const users = useRpc<{ UserList?: UserItem[] }>(serverId, "EnumUser", { HubName_str: hub });
  const [editing, setEditing] = useState<{ name: string | null } | null>(null);
  const del = useRpcMutation(serverId, "DeleteGroup", { success: "Group deleted" });
  const userList = users.data?.UserList ?? [];
  const members = (g: string) => userList.filter((u) => u.GroupName_str.toLowerCase() === g.toLowerCase());

  return (
    <>
      <PageHeader
        title="Groups"
        description="Groups bundle users so a common security policy can be applied. A user's own policy takes precedence over the group policy."
        actions={<>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => { void groups.refetch(); void users.refetch(); }} loading={groups.isFetching}>Refresh</Button>
          {canWrite && <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing({ name: null })} data-testid="create-group">Create group</Button>}
        </>}
      />
      {!canWrite && role && <ReadOnlyNotice role={role} />}
      <QueryState query={groups}>
        <DataTable
          testId="groups-table"
          data={groups.data?.GroupList}
          rowKey={(g) => g.Name_str}
          onRowClick={(g) => setEditing({ name: g.Name_str })}
          initialSort={{ key: "Name_str", dir: "asc" }}
          empty="No groups yet"
          columns={[
            { key: "Name_str", title: "Group", render: (g) => <Text fw={600} size="sm">{g.Name_str}</Text> },
            { key: "Realname_utf", title: "Full name" },
            { key: "Note_utf", title: "Note", render: (g) => <Text size="sm" lineClamp={1} maw={260}>{g.Note_utf}</Text> },
            { key: "NumUsers_u32", title: "Members", align: "right", render: (g) => {
              const m = members(g.Name_str);
              return (
                <Tooltip label={m.length ? m.slice(0, 15).map((u) => u.Name_str).join(", ") + (m.length > 15 ? "…" : "") : "No members"}>
                  <span>{num(users.data ? m.length : g.NumUsers_u32)}</span>
                </Tooltip>
              );
            } },
            { key: "DenyAccess_bool", title: "Access", render: (g) => g.DenyAccess_bool ? <Badge color="red" variant="light">Denied by policy</Badge> : <Badge color="green" variant="light">Allowed</Badge> },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (g) => (
                <Group gap={4} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                  <Tooltip label={canWrite ? "Edit" : "View"}><ActionIcon variant="subtle" onClick={() => setEditing({ name: g.Name_str })} aria-label={`Edit ${g.Name_str}`} data-testid={`edit-group-${g.Name_str}`}><IconEdit size={16} /></ActionIcon></Tooltip>
                  {canWrite && (
                    <ConfirmButton title={`Delete group ${g.Name_str}?`} confirmLabel="Delete group" leftSection={<IconTrash size={14} />}
                      message={<>The group is deleted and its {members(g.Name_str).length} member(s) become unassigned (the users themselves are kept). The group's security policy no longer applies to them.</>}
                      onConfirm={() => del.mutateAsync({ HubName_str: hub, Name_str: g.Name_str })}>Delete</ConfirmButton>
                  )}
                </Group>
              ),
            },
          ]}
        />
      </QueryState>
      <GroupDrawer serverId={serverId} hub={hub} name={editing?.name ?? null} opened={!!editing} onClose={() => setEditing(null)} canWrite={canWrite} users={userList} />
    </>
  );
}
