// Hub › Groups. Groups bundle users under one security policy. List + edit sheet (general, security
// policy, members, statistics). Membership lives on the user (GroupName_str), so adding or removing a member
// is GetUser + SetUser with the full struct (the password hash goes back unchanged).
// Ported from apps/web/src/pages/hub/Groups.tsx.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Select, Switch, TextInput, Textarea } from "@mantine/core";
import { IconCopy, IconPencil, IconPlus, IconShieldLock, IconTrash, IconUserMinus, IconUserPlus, IconUsersGroup } from "@tabler/icons-react";
import { rpc } from "../../lib/api";
import { notifyError, notifySuccess, useRpc, useRpcMutation } from "../../lib/hooks";
import { num, plural } from "../../lib/format";
import {
  DataTable, ErrorState, FormRow, FormSection, PageHeader, PropertyList, PropertySkeleton, Section, Sheet, StatusBadge, Tag,
} from "../../design";
import { AuthTag } from "../../components/domain/ui";
import { PolicyEditor, hasPolicyFields, policySummary, withPolicyDefaults } from "../../components/domain/PolicyEditor";
import { fmtField } from "../../components/domain/StatusView";
import { PaneSwitcher, SheetFooter, TRAFFIC_ROWS, Unreachable, useHubScope } from "./_hub-identity-traffic/shared";

type Struct = Record<string, any>;
interface GroupItem { Name_str: string; Realname_utf: string; Note_utf: string; NumUsers_u32: number; DenyAccess_bool: boolean }
interface UserItem { Name_str: string; GroupName_str: string; Realname_utf: string; AuthType_u32: number }
type Pane = "general" | "policy" | "members" | "stats";

const NEW_GROUP: Struct = { Name_str: "", Realname_utf: "", Note_utf: "", UsePolicy_bool: false };
const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export default function GroupsPage() {
  const { serverId, hub, reachable, ready } = useHubScope();
  const groups = useRpc<{ GroupList?: GroupItem[] }>(serverId, "EnumGroup", { HubName_str: hub }, { enabled: ready });
  const users = useRpc<{ UserList?: UserItem[] }>(serverId, "EnumUser", { HubName_str: hub }, { enabled: ready });
  const [editing, setEditing] = useState<{ name: string | null; pane?: Pane } | null>(null);
  // Keep the last group while the sheet slides out, so its title doesn't flip to "New Group" mid-animation.
  const lastEditing = useRef(editing);
  if (editing) lastEditing.current = editing;
  const [selection, setSelection] = useState<(string | number)[]>([]);
  const userList = users.data?.UserList ?? [];
  const members = (g: string) => userList.filter((u) => sameName(u.GroupName_str, g));
  const del = useRpcMutation<{ HubName_str: string; Name_str: string }>(serverId, "DeleteGroup", {
    success: "Group deleted",
    confirm: (p) => {
      const n = members(p.Name_str).length;
      return {
        title: <>Delete group “{p.Name_str}”?</>,
        message: n
          ? <>Its {plural(n, "member")} become ungrouped (the users themselves are kept) and the group’s security policy no longer applies to them.</>
          : "The group has no members. Its security policy is deleted with it.",
        confirmLabel: "Delete Group",
        testId: "delete-group",
      };
    },
  });
  const list = groups.data?.GroupList ?? [];
  const denied = list.filter((g) => g.DenyAccess_bool).length;

  return (
    <>
      <PageHeader
        title="Groups"
        meta={reachable && groups.data ? <>
          <span>{plural(list.length, "group")}</span>
          {users.data && <><span className="sem-dim">·</span><span className="sem-dim">{num(userList.filter((u) => u.GroupName_str).length)} of {plural(userList.length, "user")} grouped</span></>}
          {denied > 0 && <><span className="sem-dim">·</span><span className="sem-dim">{num(denied)} denied</span></>}
        </> : undefined}
        description="Groups apply one security policy to many users. A user’s own policy takes precedence over its group’s."
        actions={reachable && <Button leftSection={<IconPlus size={14} />} onClick={() => setEditing({ name: null })} data-testid="create-group">Add Group…</Button>}
      />
      {!reachable ? <Unreachable serverId={serverId} /> : (
        <DataTable
          testId="groups-table"
          aria-label="Groups"
          data={groups.data?.GroupList}
          loading={groups.isLoading}
          error={groups.error}
          onRetry={() => void groups.refetch()}
          rowKey={(g) => g.Name_str}
          rowTestId={(g) => `group-row-${g.Name_str}`}
          selectable="single"
          selection={selection}
          onSelectionChange={setSelection}
          onRowOpen={(g) => setEditing({ name: g.Name_str })}
          initialSort={{ key: "Name_str", dir: "asc" }}
          searchPlaceholder="Filter groups"
          empty={{
            title: "No Groups",
            description: "Create a group to give several users the same security policy.",
            icon: <IconUsersGroup size={28} stroke={1.4} />,
            action: <Button size="xs" onClick={() => setEditing({ name: null })}>Add Group…</Button>,
          }}
          contextMenu={(g) => [
            { label: "Edit Group…", icon: <IconPencil size={14} />, onClick: () => setEditing({ name: g.Name_str }), shortcut: "↩", testId: `edit-group-${g.Name_str}` },
            { label: "Security Policy…", icon: <IconShieldLock size={14} />, onClick: () => setEditing({ name: g.Name_str, pane: "policy" }) },
            { label: "Members…", icon: <IconUserPlus size={14} />, onClick: () => setEditing({ name: g.Name_str, pane: "members" }), testId: `members-group-${g.Name_str}` },
            { label: "Copy Group Name", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(g.Name_str) },
            "divider",
            { label: "Delete Group…", icon: <IconTrash size={14} />, danger: true, onClick: () => del.mutate({ HubName_str: hub, Name_str: g.Name_str }), testId: `delete-group-${g.Name_str}` },
          ]}
          columns={[
            { key: "Name_str", title: "Name", width: "22%", render: (g) => <span className="sem-strong">{g.Name_str}</span> },
            { key: "Realname_utf", title: "Full name", width: "22%", truncate: true, render: (g) => g.Realname_utf || <span className="sem-dim">–</span> },
            { key: "Note_utf", title: "Note", truncate: true, render: (g) => g.Note_utf ? <span title={g.Note_utf}>{g.Note_utf}</span> : <span className="sem-dim">–</span> },
            { key: "NumUsers_u32", title: "Members", align: "right", width: 90, value: (g) => (users.data ? members(g.Name_str).length : g.NumUsers_u32), render: (g) => {
              const m = members(g.Name_str);
              const n = users.data ? m.length : g.NumUsers_u32;
              return <span className="sem-num" title={m.length ? m.slice(0, 15).map((u) => u.Name_str).join(", ") + (m.length > 15 ? "…" : "") : "No members"}>{num(n)}</span>;
            } },
            { key: "DenyAccess_bool", title: "Access", width: 150, value: (g) => (g.DenyAccess_bool ? "denied" : "allowed"),
              render: (g) => g.DenyAccess_bool ? <StatusBadge status="error">Denied by policy</StatusBadge> : <StatusBadge status="ok">Allowed</StatusBadge> },
          ]}
        />
      )}
      <GroupSheet serverId={serverId} hub={hub} name={lastEditing.current?.name ?? null} initialPane={lastEditing.current?.pane} opened={!!editing} onClose={() => setEditing(null)}
        users={userList} onCreated={(n) => setSelection([n])} />
    </>
  );
}

/* ======================================================================== group sheet */

function GroupSheet({ serverId, hub, name, initialPane, opened, onClose, users, onCreated }: {
  serverId: number; hub: string; name: string | null; initialPane?: Pane; opened: boolean; onClose: () => void; users: UserItem[]; onCreated: (n: string) => void;
}) {
  const isNew = name === null;
  const q = useRpc<Struct>(serverId, "GetGroup", { HubName_str: hub, Name_str: name ?? "" }, { enabled: opened && !isNew, staleTime: 0 });
  const [form, setForm] = useState<Struct>(NEW_GROUP);
  const [pane, setPane] = useState<Pane>("general");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!opened) { setLoaded(false); return; }
    if (loaded) return;
    if (isNew) { setForm({ ...NEW_GROUP }); setLoaded(true); }
    // Wait for a fresh GetGroup: on reopen the cache still holds the pre-save copy while it refetches.
    else if (q.data && !q.isFetching) { setForm({ ...q.data }); setLoaded(true); }
  }, [opened, isNew, q.data, q.isFetching, loaded]);
  useEffect(() => { if (opened) setPane(initialPane ?? "general"); }, [opened, name, initialPane]);
  const set = (patch: Struct) => setForm((f) => ({ ...f, ...patch }));

  const create = useRpcMutation(serverId, "CreateGroup", { success: "Group created", onSuccess: (_r, p) => { onClose(); onCreated(String(p.Name_str)); } });
  const save = useRpcMutation(serverId, "SetGroup", { success: "Group saved", onSuccess: () => onClose() });
  const nameTrim = String(form.Name_str ?? "").trim();
  const error = isNew && !nameTrim ? "Enter a group name." : isNew && /\s/.test(nameTrim) ? "Group names can’t contain spaces." : null;
  const policyOn = !!form.UsePolicy_bool;
  const loading = !isNew && !loaded;
  const memberCount = name ? users.filter((u) => sameName(u.GroupName_str, name)).length : 0;

  const submit = () => {
    if (error) { setPane("general"); return; }
    let p: Struct = { ...form, HubName_str: hub, Name_str: isNew ? nameTrim : name };
    p.UsePolicy_bool = policyOn;
    if (p.UsePolicy_bool) p = withPolicyDefaults(p);
    if (isNew) create.mutate(p); else save.mutate(p);
  };
  const pending = create.isPending || save.isPending;

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={pending} size={740} testId="group-sheet"
      title={isNew ? "New Group" : <>Edit “{name}”</>}
      subtitle={isNew ? <>Virtual Hub {hub}</> : <>{plural(memberCount, "member")} · Virtual Hub {hub}</>}
      icon={<IconUsersGroup size={19} stroke={1.5} />}
      footer={(
        <SheetFooter note={loading ? null : pane === "members" ? "Membership changes apply immediately." : error}>
          <Button variant="default" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button type="submit" form="sem-group-form" loading={pending} disabled={loading || !!error} data-testid="group-save">{isNew ? "Create Group" : "Save"}</Button>
        </SheetFooter>
      )}
    >
      {!isNew && q.error ? <ErrorState error={q.error} inline onRetry={() => void q.refetch()} /> : loading ? <PropertySkeleton rows={4} /> : (
        <form id="sem-group-form" onSubmit={(e) => { e.preventDefault(); submit(); }} data-testid="group-form">
          <PaneSwitcher value={pane} onChange={setPane} testId="group-panes" panes={[
            { value: "general", label: "General" },
            { value: "policy", label: policyOn ? "Security Policy ●" : "Security Policy" },
            ...(!isNew ? [{ value: "members" as Pane, label: `Members (${memberCount})` }, { value: "stats" as Pane, label: "Statistics" }] : []),
          ]} />

          {pane === "general" && (
            <FormSection>
              <FormRow label="Group name" description={isNew ? "Can’t be changed later." : "Group names can’t be changed."}>{(id) => (
                <TextInput id={id} value={String(form.Name_str ?? "")} readOnly={!isNew} data-autofocus={isNew || undefined} autoComplete="off" spellCheck={false}
                  error={isNew && nameTrim && error ? "No spaces" : undefined} onChange={(e) => set({ Name_str: e.currentTarget.value })} data-testid="group-name" />
              )}</FormRow>
              <FormRow label="Full name">{(id) => (
                <TextInput id={id} value={String(form.Realname_utf ?? "")} data-autofocus={!isNew || undefined} onChange={(e) => set({ Realname_utf: e.currentTarget.value })} data-testid="group-realname" />
              )}</FormRow>
              <FormRow label="Note" align="start">{(id) => (
                <Textarea id={id} value={String(form.Note_utf ?? "")} autosize minRows={2} maxRows={5} onChange={(e) => set({ Note_utf: e.currentTarget.value })} data-testid="group-note" />
              )}</FormRow>
            </FormSection>
          )}

          {pane === "policy" && <>
            <FormSection>
              <FormRow label="Use a security policy for this group" description="Applies to members that have no policy of their own.">
                <Switch checked={policyOn} aria-label="Use a security policy for this group" data-testid="group-use-policy"
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

          {pane === "members" && name && <Members serverId={serverId} hub={hub} group={name} users={users} />}

          {pane === "stats" && q.data && (
            <Section variant="inset" testId="group-stats">
              <PropertyList labelWidth={200} dense items={TRAFFIC_ROWS.map(([label, k]) => ({ label, value: fmtField(k, q.data![k]) }))} />
            </Section>
          )}
        </form>
      )}
    </Sheet>
  );
}

function Members({ serverId, hub, group, users }: { serverId: number; hub: string; group: string; users: UserItem[] }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const members = users.filter((u) => sameName(u.GroupName_str, group));
  const others = users.filter((u) => !sameName(u.GroupName_str, group));

  // Membership lives on the user: GetUser, change GroupName_str, SetUser with the full struct.
  const setGroup = async (user: string, newGroup: string) => {
    setBusy(user);
    try {
      const cur = await rpc<Struct>(serverId, "GetUser", { HubName_str: hub, Name_str: user });
      const p: Struct = { ...cur, HubName_str: hub, GroupName_str: newGroup };
      delete p.Auth_Password_str;
      await rpc(serverId, "SetUser", p);
      notifySuccess(newGroup ? `Added ${user} to ${newGroup}` : `Removed ${user} from ${group}`);
      setAdding(null);
    } catch (e) {
      notifyError(e, "Couldn’t change the group");
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
    }
  };

  return (
    <>
      <FormSection>
        <FormRow label="Add a user" description="A user belongs to one group; adding moves them out of their current group.">{(id) => (
          <div className="sem-row-inline" style={{ width: "100%", flexWrap: "nowrap" }}>
            <Select id={id} style={{ flex: 1 }} searchable placeholder={others.length ? "Choose a user" : "Every user is a member"} value={adding} onChange={setAdding}
              disabled={!others.length} nothingFoundMessage="No matching users"
              data={others.map((u) => ({ value: u.Name_str, label: u.GroupName_str ? `${u.Name_str} (in ${u.GroupName_str})` : u.Name_str }))}
              data-testid="group-add-member-select" />
            <Button variant="default" leftSection={<IconUserPlus size={14} />} disabled={!adding} loading={!!busy && busy === adding}
              onClick={() => adding && void setGroup(adding, group)} data-testid="group-add-member">Add</Button>
          </div>
        )}</FormRow>
      </FormSection>
      <Section title="Members" testId="group-members">
        <DataTable
          testId="group-members-table" aria-label={`Members of ${group}`} data={members} rowKey={(u) => u.Name_str} searchable={members.length > 8}
          maxHeight={300} selectable="single" initialSort={{ key: "Name_str", dir: "asc" }}
          empty={{ title: "No Members", description: "Choose a user above to add them to this group." }}
          contextMenu={(u) => [
            { label: `Remove from ${group}`, icon: <IconUserMinus size={14} />, danger: true, onClick: () => void setGroup(u.Name_str, ""), testId: `remove-member-${u.Name_str}` },
          ]}
          columns={[
            { key: "Name_str", title: "User", render: (u) => <span className="sem-strong">{u.Name_str}</span> },
            { key: "Realname_utf", title: "Full name", truncate: true, render: (u) => u.Realname_utf || <span className="sem-dim">–</span> },
            { key: "AuthType_u32", title: "Authentication", width: 120, render: (u) => <AuthTag type={u.AuthType_u32} /> },
            { key: "remove", title: "", sortable: false, width: 90, align: "right", render: (u) => (
              <Button size="compact-xs" variant="subtle" color="gray" loading={busy === u.Name_str} onClick={(e) => { e.stopPropagation(); void setGroup(u.Name_str, ""); }}
                aria-label={`Remove ${u.Name_str}`} data-testid={`group-remove-${u.Name_str}`}>Remove</Button>
            ) },
          ]}
        />
      </Section>
    </>
  );
}
