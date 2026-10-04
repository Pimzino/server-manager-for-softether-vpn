import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Checkbox, CloseButton, Group, Switch, Tabs, Text, TextInput, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconRefresh, IconTrash } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, PageHeader, QueryState } from "../../components/common";
import { macFromB64, runSequential } from "../../components/hub/util";
import { rpc } from "../../lib/api";
import { ago, dt } from "../../lib/format";
import { can, useRpc, useRpcMutation, useScope, useServer } from "../../lib/hooks";

interface MacItem { Key_u32: number; SessionName_str: string; MacAddress_bin: string; CreatedTime_dt: string; UpdatedTime_dt: string; RemoteItem_bool: boolean; RemoteHostname_str: string; VlanId_u32: number }
interface IpItem { Key_u32: number; SessionName_str: string; IpAddress_ip: string; DhcpAllocated_bool: boolean; CreatedTime_dt: string; UpdatedTime_dt: string; RemoteItem_bool: boolean; RemoteHostname_str: string }

function useSelection<K>(deps: unknown) {
  const [sel, setSel] = useState<Set<K>>(new Set());
  useEffect(() => { setSel(new Set()); }, [deps]);
  const toggle = (k: K, on: boolean) => setSel((s) => { const x = new Set(s); if (on) x.add(k); else x.delete(k); return x; });
  return { sel, setSel, toggle };
}

function selectColumn<T>(rows: T[], keyOf: (r: T) => number, s: ReturnType<typeof useSelection<number>>) {
  const all = rows.length > 0 && rows.every((r) => s.sel.has(keyOf(r)));
  return {
    key: "sel", sortable: false, width: 36, value: () => "",
    title: <Checkbox size="xs" aria-label="Select all" checked={all} indeterminate={!all && s.sel.size > 0}
      onChange={(e) => s.setSel(e.currentTarget.checked ? new Set(rows.map(keyOf)) : new Set())} />,
    render: (r: T) => <Checkbox size="xs" aria-label="Select row" checked={s.sel.has(keyOf(r))} onChange={(e) => s.toggle(keyOf(r), e.currentTarget.checked)} />,
  };
}

function when(v: string) {
  return <Tooltip label={dt(v)}><span>{ago(v)}</span></Tooltip>;
}

export default function TablesPage() {
  const { serverId, hub = "" } = useScope();
  const role = useServer(serverId).data?.myRole;
  const canWrite = can(role, "operator");
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const session = params.get("session") ?? "";
  const tab = params.get("tab") ?? "mac";
  const [auto, setAuto] = useState(false);
  const refetchInterval = auto ? 5000 : false;
  const mac = useRpc<{ MacTable?: MacItem[] }>(serverId, "EnumMacTable", { HubName_str: hub }, { refetchInterval });
  const ip = useRpc<{ IpTable?: IpItem[] }>(serverId, "EnumIpTable", { HubName_str: hub }, { refetchInterval });
  const delMac = useRpcMutation(serverId, "DeleteMacTable", { success: "MAC table entry deleted" });
  const delIp = useRpcMutation(serverId, "DeleteIpTable", { success: "IP table entry deleted" });
  const macSel = useSelection<number>(mac.data);
  const ipSel = useSelection<number>(ip.data);
  const [dhcpOnly, setDhcpOnly] = useState(false);

  const setParam = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const bySession = <T extends { SessionName_str: string }>(l: T[] | undefined) => (l ?? []).filter((r) => !session || r.SessionName_str === session);
  const macRows = bySession(mac.data?.MacTable);
  const ipRows = bySession(ip.data?.IpTable).filter((r) => !dhcpOnly || r.DhcpAllocated_bool);

  const bulk = async (method: string, keys: number[], done: () => void) => {
    const res = await runSequential(keys, (k) => rpc(serverId, method, { HubName_str: hub, Key_u32: k }));
    const failed = res.filter((r) => !r.ok).length;
    notifications.show({ color: failed ? "orange" : "green", message: `Deleted ${res.length - failed} of ${res.length} entr${res.length === 1 ? "y" : "ies"}` });
    done();
    void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
  };

  return (
    <>
      <PageHeader
        title="MAC & IP tables"
        description="Address learning tables of the Virtual Hub's virtual switch. Deleting an entry forces it to be re-learned; it does not disconnect the session."
        actions={<>
          <Switch label="Auto-refresh" checked={auto} onChange={(e) => setAuto(e.currentTarget.checked)} />
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => { void mac.refetch(); void ip.refetch(); }} loading={mac.isFetching || ip.isFetching}>Refresh</Button>
        </>}
      />
      <Group mb="sm" gap="xs">
        <TextInput size="sm" w={280} label="Session filter" placeholder="All sessions" value={session} onChange={(e) => setParam("session", e.currentTarget.value)}
          rightSection={session ? <CloseButton size="sm" onClick={() => setParam("session", "")} aria-label="Clear session filter" /> : null} data-testid="tables-session-filter" />
      </Group>
      <Tabs value={tab} onChange={(v) => setParam("tab", v === "mac" ? "" : v ?? "")}>
        <Tabs.List mb="md">
          <Tabs.Tab value="mac">MAC table <Badge size="xs" variant="light" ml={4}>{macRows.length}</Badge></Tabs.Tab>
          <Tabs.Tab value="ip">IP table <Badge size="xs" variant="light" ml={4}>{ipRows.length}</Badge></Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="mac">
          <QueryState query={mac}>
            <DataTable
              testId="mac-table"
              data={macRows}
              rowKey={(r) => r.Key_u32}
              initialSort={{ key: "SessionName_str", dir: "asc" }}
              empty="No MAC addresses learned"
              toolbar={canWrite && macSel.sel.size > 0 && (
                <ConfirmButton size="sm" title={`Delete ${macSel.sel.size} MAC entr${macSel.sel.size === 1 ? "y" : "ies"}?`} confirmLabel="Delete" leftSection={<IconTrash size={14} />}
                  message="The entries are removed from the MAC table and will be re-learned from traffic."
                  onConfirm={() => bulk("DeleteMacTable", [...macSel.sel], () => macSel.setSel(new Set()))}>Delete selected ({macSel.sel.size})</ConfirmButton>
              )}
              columns={[
                ...(canWrite ? [selectColumn(macRows, (r) => r.Key_u32, macSel)] : []),
                { key: "MacAddress_bin", title: "MAC address", value: (r) => macFromB64(r.MacAddress_bin), render: (r) => <Text ff="monospace" size="sm">{macFromB64(r.MacAddress_bin)}</Text> },
                { key: "SessionName_str", title: "Session", render: (r) => <Text size="sm" ff="monospace" style={{ cursor: "pointer" }} td="underline dotted" onClick={() => setParam("session", r.SessionName_str)}>{r.SessionName_str}</Text> },
                { key: "VlanId_u32", title: "VLAN", align: "right", render: (r) => (r.VlanId_u32 ? r.VlanId_u32 : "–") },
                { key: "RemoteHostname_str", title: "Server", render: (r) => <Group gap={4}>{r.RemoteHostname_str}{r.RemoteItem_bool && <Badge size="xs" variant="outline">remote</Badge>}</Group> },
                { key: "CreatedTime_dt", title: "Created", render: (r) => when(r.CreatedTime_dt) },
                { key: "UpdatedTime_dt", title: "Updated", render: (r) => when(r.UpdatedTime_dt) },
                { key: "actions", title: "", sortable: false, align: "right", render: (r) => canWrite && (
                  <ConfirmButton title="Delete MAC table entry?" confirmLabel="Delete" leftSection={<IconTrash size={14} />}
                    message={<>Remove <b>{macFromB64(r.MacAddress_bin)}</b> (session {r.SessionName_str}) from the MAC table?</>}
                    onConfirm={() => delMac.mutateAsync({ HubName_str: hub, Key_u32: r.Key_u32 })}>Delete</ConfirmButton>
                ) },
              ]}
            />
          </QueryState>
        </Tabs.Panel>
        <Tabs.Panel value="ip">
          <QueryState query={ip}>
            <DataTable
              testId="ip-table"
              data={ipRows}
              rowKey={(r) => r.Key_u32}
              initialSort={{ key: "SessionName_str", dir: "asc" }}
              empty="No IP addresses learned"
              toolbar={<>
                <Switch size="sm" label="DHCP-assigned only" checked={dhcpOnly} onChange={(e) => setDhcpOnly(e.currentTarget.checked)} />
                {canWrite && ipSel.sel.size > 0 && (
                  <ConfirmButton size="sm" title={`Delete ${ipSel.sel.size} IP entr${ipSel.sel.size === 1 ? "y" : "ies"}?`} confirmLabel="Delete" leftSection={<IconTrash size={14} />}
                    message="The entries are removed from the IP table and will be re-learned from traffic."
                    onConfirm={() => bulk("DeleteIpTable", [...ipSel.sel], () => ipSel.setSel(new Set()))}>Delete selected ({ipSel.sel.size})</ConfirmButton>
                )}
              </>}
              columns={[
                ...(canWrite ? [selectColumn(ipRows, (r) => r.Key_u32, ipSel)] : []),
                { key: "IpAddress_ip", title: "IP address", render: (r) => <Text ff="monospace" size="sm">{r.IpAddress_ip}</Text> },
                { key: "DhcpAllocated_bool", title: "Source", value: (r) => (r.DhcpAllocated_bool ? "DHCP" : "Static"),
                  render: (r) => r.DhcpAllocated_bool ? <Badge variant="light" color="teal">DHCP</Badge> : <Badge variant="light" color="gray">Static / learned</Badge> },
                { key: "SessionName_str", title: "Session", render: (r) => <Text size="sm" ff="monospace" style={{ cursor: "pointer" }} td="underline dotted" onClick={() => setParam("session", r.SessionName_str)}>{r.SessionName_str}</Text> },
                { key: "RemoteHostname_str", title: "Server", render: (r) => <Group gap={4}>{r.RemoteHostname_str}{r.RemoteItem_bool && <Badge size="xs" variant="outline">remote</Badge>}</Group> },
                { key: "CreatedTime_dt", title: "Created", render: (r) => when(r.CreatedTime_dt) },
                { key: "UpdatedTime_dt", title: "Updated", render: (r) => when(r.UpdatedTime_dt) },
                { key: "actions", title: "", sortable: false, align: "right", render: (r) => canWrite && (
                  <ConfirmButton title="Delete IP table entry?" confirmLabel="Delete" leftSection={<IconTrash size={14} />}
                    message={<>Remove <b>{r.IpAddress_ip}</b> (session {r.SessionName_str}) from the IP table?</>}
                    onConfirm={() => delIp.mutateAsync({ HubName_str: hub, Key_u32: r.Key_u32 })}>Delete</ConfirmButton>
                ) },
              ]}
            />
          </QueryState>
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
