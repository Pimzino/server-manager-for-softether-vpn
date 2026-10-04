import { useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Button, Group, Modal, NumberInput, PasswordInput, Select, Stack, Switch, Text, TextInput } from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, PageHeader, QueryState, OnlineBadge } from "../../components/common";
import { can, useRpc, useRpcMutation, useScope, useServer } from "../../lib/hooks";
import { ago, bytes, num } from "../../lib/format";
import type { HubListItem } from "../../lib/types";

const HUB_TYPES = [
  { value: "0", label: "Standalone" },
  { value: "1", label: "Static (cluster)" },
  { value: "2", label: "Dynamic (cluster)" },
];

function CreateHubModal({ serverId, opened, onClose, clustered }: { serverId: number; opened: boolean; onClose: () => void; clustered: boolean }) {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [online, setOnline] = useState(true);
  const [maxSession, setMaxSession] = useState<number>(0);
  const [noEnum, setNoEnum] = useState(false);
  const [type, setType] = useState("0");
  const create = useRpcMutation(serverId, "CreateHub", {
    success: "Virtual Hub created",
    onSuccess: () => { onClose(); nav(`/servers/${serverId}/hubs/${encodeURIComponent(name)}`); },
  });
  return (
    <Modal opened={opened} onClose={onClose} title="Create Virtual Hub" centered>
      <form onSubmit={(e) => {
        e.preventDefault();
        create.mutate({ HubName_str: name, AdminPasswordPlainText_str: password, Online_bool: online, MaxSession_u32: maxSession, NoEnum_bool: noEnum, HubType_u32: Number(type) });
      }}>
        <Stack>
          <TextInput label="Hub name" required value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus
            description="Letters, digits, - and _ ; case-insensitive" />
          <PasswordInput label="Hub administrator password" description="Optional. Enables hub-admin login for delegated administration." value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="new-password" />
          <NumberInput label="Maximum sessions" description="0 = unlimited" min={0} value={maxSession} onChange={(v) => setMaxSession(Number(v) || 0)} />
          {clustered && <Select label="Hub type" data={HUB_TYPES} value={type} onChange={(v) => setType(v ?? "0")} allowDeselect={false} />}
          <Switch label="Online" checked={online} onChange={(e) => setOnline(e.currentTarget.checked)} />
          <Switch label="Hide from hub enumeration (NoEnum)" checked={noEnum} onChange={(e) => setNoEnum(e.currentTarget.checked)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={create.isPending}>Create</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

export default function HubsPage() {
  const { serverId } = useScope();
  const server = useServer(serverId);
  const role = server.data?.myRole;
  const nav = useNavigate();
  const hubs = useRpc<{ HubList?: HubListItem[] }>(serverId, "EnumHub");
  const farm = useRpc<{ ServerType_u32?: number }>(serverId, "GetFarmSetting", {}, { enabled: !server.data?.hub && !server.data?.visibleHubs });
  const [creating, setCreating] = useState(false);
  const setOnline = useRpcMutation(serverId, "SetHubOnline", { success: false });
  const del = useRpcMutation(serverId, "DeleteHub", { success: "Virtual Hub deleted" });
  const isAdmin = can(role, "admin") && !server.data?.hub;

  return (
    <>
      <PageHeader
        title="Virtual Hubs"
        description="Each Virtual Hub is an isolated virtual Ethernet segment with its own users, policies, and security settings."
        actions={isAdmin && <Button leftSection={<IconPlus size={16} />} onClick={() => setCreating(true)}>Create hub</Button>}
      />
      <QueryState query={hubs}>
        <DataTable
          testId="hubs-table"
          data={hubs.data?.HubList}
          rowKey={(h) => h.HubName_str}
          onRowClick={(h) => nav(`/servers/${serverId}/hubs/${encodeURIComponent(h.HubName_str)}`)}
          initialSort={{ key: "HubName_str", dir: "asc" }}
          columns={[
            { key: "HubName_str", title: "Name", render: (h) => <Text fw={600}>{h.HubName_str}</Text> },
            { key: "Online_bool", title: "Status", render: (h) => <OnlineBadge online={h.Online_bool} /> },
            { key: "HubType_u32", title: "Type", render: (h) => <Badge variant="outline" color="gray">{HUB_TYPES[h.HubType_u32]?.label ?? h.HubType_u32}</Badge> },
            { key: "NumUsers_u32", title: "Users", align: "right", render: (h) => num(h.NumUsers_u32) },
            { key: "NumGroups_u32", title: "Groups", align: "right", render: (h) => num(h.NumGroups_u32) },
            { key: "NumSessions_u32", title: "Sessions", align: "right", render: (h) => num(h.NumSessions_u32) },
            { key: "NumMacTables_u32", title: "MACs", align: "right", render: (h) => num(h.NumMacTables_u32) },
            { key: "NumIpTables_u32", title: "IPs", align: "right", render: (h) => num(h.NumIpTables_u32) },
            {
              key: "traffic", title: "Traffic (rx / tx)", align: "right",
              value: (h) => Number(h["Ex.Recv.UnicastBytes_u64"] ?? 0) + Number(h["Ex.Send.UnicastBytes_u64"] ?? 0),
              render: (h) => `${bytes(Number(h["Ex.Recv.UnicastBytes_u64"] ?? 0) + Number(h["Ex.Recv.BroadcastBytes_u64"] ?? 0))} / ${bytes(Number(h["Ex.Send.UnicastBytes_u64"] ?? 0) + Number(h["Ex.Send.BroadcastBytes_u64"] ?? 0))}`,
            },
            { key: "LastCommTime_dt", title: "Last activity", render: (h) => ago(h.LastCommTime_dt) },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (h) => can(role, "operator") && (
                <Group gap={6} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                  <Switch size="xs" checked={h.Online_bool} aria-label={`Toggle ${h.HubName_str} online`}
                    onChange={(e) => setOnline.mutate({ HubName_str: h.HubName_str, Online_bool: e.currentTarget.checked })} />
                  {isAdmin && (
                    <ConfirmButton
                      title={`Delete Virtual Hub ${h.HubName_str}?`}
                      message="All sessions will be disconnected and every user, group, certificate, access list and cascade connection of this hub is permanently removed."
                      typeToConfirm={h.HubName_str}
                      confirmLabel="Delete hub"
                      onConfirm={() => del.mutateAsync({ HubName_str: h.HubName_str })}
                      leftSection={<IconTrash size={14} />}
                    >Delete</ConfirmButton>
                  )}
                </Group>
              ),
            },
          ]}
        />
      </QueryState>
      <CreateHubModal serverId={serverId} opened={creating} onClose={() => setCreating(false)} clustered={(farm.data?.ServerType_u32 ?? 0) !== 0} />
    </>
  );
}
