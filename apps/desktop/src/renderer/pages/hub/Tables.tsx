// Hub › MAC & IP Tables. Address-learning tables of the Virtual Hub's virtual switch, filterable by session
// (?session=… from the Sessions page), with multi-select delete. ?tab=ip scrolls to the IP table.
// Ported from apps/web/src/pages/hub/Tables.tsx.
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Select, Switch, UnstyledButton } from "@mantine/core";
import { IconCopy, IconFilter, IconFilterOff, IconTable, IconTrash } from "@tabler/icons-react";
import { rpc } from "../../lib/api";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import { agoShort, dt, plural } from "../../lib/format";
import { DataTable, PageHeader, Section, Tag, confirmAction, type ContextMenuItem, type RowKey } from "../../design";
import { macFromB64, runSequential } from "../../components/domain/util";
import { Unreachable, notifyBulk, useHubScope } from "./_hub-identity-traffic/shared";

interface MacItem { Key_u32: number; SessionName_str: string; MacAddress_bin: string; CreatedTime_dt: string; UpdatedTime_dt: string; RemoteItem_bool: boolean; RemoteHostname_str: string; VlanId_u32: number }
interface IpItem { Key_u32: number; SessionName_str: string; IpAddress_ip: string; DhcpAllocated_bool: boolean; CreatedTime_dt: string; UpdatedTime_dt: string; RemoteItem_bool: boolean; RemoteHostname_str: string }

// Session names act as filter links; the dotted underline keeps the row's own text colour (readable when selected).
const LINK = { color: "inherit", font: "inherit", textDecoration: "underline dotted", textUnderlineOffset: 3, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" } as const;
const when = (v: string) => <span className="sem-dim" title={dt(v)}>{agoShort(v)}</span>;

export default function TablesPage() {
  const { serverId, hub, reachable, ready } = useHubScope();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const session = params.get("session") ?? "";
  const tab = params.get("tab") ?? "mac";
  const [auto, setAuto] = useState(false);
  const refetchInterval = auto ? 5000 : false;
  const mac = useRpc<{ MacTable?: MacItem[] }>(serverId, "EnumMacTable", { HubName_str: hub }, { enabled: ready, refetchInterval });
  const ip = useRpc<{ IpTable?: IpItem[] }>(serverId, "EnumIpTable", { HubName_str: hub }, { enabled: ready, refetchInterval });
  const [macSel, setMacSel] = useState<RowKey[]>([]);
  const [ipSel, setIpSel] = useState<RowKey[]>([]);
  const [dhcpOnly, setDhcpOnly] = useState(false);
  const ipRef = useRef<HTMLDivElement>(null);
  // The confirmation names the address; it is looked up from the key so that only real RPC fields
  // (HubName_str, Key_u32) are sent to the server.
  const delMac = useRpcMutation<{ HubName_str: string; Key_u32: number }>(serverId, "DeleteMacTable", {
    success: "MAC table entry deleted",
    confirm: (p) => {
      const r = mac.data?.MacTable?.find((x) => x.Key_u32 === p.Key_u32);
      return { title: <>Delete MAC entry {r ? macFromB64(r.MacAddress_bin) : `#${p.Key_u32}`}?</>, message: "The entry is re-learned as soon as the address sends traffic again. The session stays connected.", confirmLabel: "Delete Entry", testId: "delete-mac" };
    },
  });
  const delIp = useRpcMutation<{ HubName_str: string; Key_u32: number }>(serverId, "DeleteIpTable", {
    success: "IP table entry deleted",
    confirm: (p) => {
      const r = ip.data?.IpTable?.find((x) => x.Key_u32 === p.Key_u32);
      return { title: <>Delete IP entry {r ? r.IpAddress_ip : `#${p.Key_u32}`}?</>, message: "The entry is re-learned as soon as the address sends traffic again. The session stays connected.", confirmLabel: "Delete Entry", testId: "delete-ip" };
    },
  });

  // The Sessions page links here with ?tab=ip: bring the IP table into view once it has loaded.
  useEffect(() => { if (tab === "ip" && ip.data) ipRef.current?.scrollIntoView({ block: "start" }); }, [tab, !!ip.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const setParam = (k: string, v: string) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const bySession = <T extends { SessionName_str: string }>(l: T[] | undefined) => l?.filter((r) => !session || r.SessionName_str === session);
  const macRows = bySession(mac.data?.MacTable);
  const ipRows = bySession(ip.data?.IpTable)?.filter((r) => !dhcpOnly || r.DhcpAllocated_bool);
  const sessions = [...new Set([...(mac.data?.MacTable ?? []), ...(ip.data?.IpTable ?? [])].map((r) => r.SessionName_str).concat(session ? [session] : []))].sort();
  const anyVlan = (mac.data?.MacTable ?? []).some((r) => r.VlanId_u32);
  const anyRemote = [...(mac.data?.MacTable ?? []), ...(ip.data?.IpTable ?? [])].some((r) => r.RemoteItem_bool);

  // Keys are only unique per table, and an entry's key is its handle for Delete*Table.
  const bulk = async (method: "DeleteMacTable" | "DeleteIpTable", rows: { key: number; label: string }[], done: () => void) => {
    const noun: [string, string] = method === "DeleteMacTable" ? ["MAC entry", "MAC entries"] : ["IP entry", "IP entries"];
    const ok = await confirmAction({
      title: <>Delete {rows.length} {rows.length === 1 ? noun[0] : noun[1]}?</>,
      message: "The entries are removed and re-learned from traffic. Sessions stay connected.",
      details: <div className="sem-dim sem-mono" style={{ fontSize: "var(--sem-fz-small)" }}>{rows.slice(0, 10).map((r) => r.label).join(", ")}{rows.length > 10 ? ` and ${rows.length - 10} more` : ""}</div>,
      confirmLabel: "Delete Entries",
      testId: `bulk-${method}`,
    });
    if (!ok) return;
    const res = await runSequential(rows, (r) => rpc(serverId, method, { HubName_str: hub, Key_u32: r.key }));
    notifyBulk("Deleted", noun, res.map((r) => ({ ok: r.ok, label: r.item.label, error: r.error })));
    done();
    void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
  };

  const sessionCell = (name: string) => (
    <UnstyledButton style={LINK} title={session === name ? "Show all sessions" : `Show only ${name}`} data-testid="tables-session-link"
      onClick={(e) => { e.stopPropagation(); setParam("session", session === name ? "" : name); }}>{name}</UnstyledButton>
  );
  const sessionItems = (name: string): ContextMenuItem[] => session === name
    ? [{ label: "Show All Sessions", icon: <IconFilterOff size={14} />, onClick: () => setParam("session", "") }]
    : [{ label: "Show Only This Session", icon: <IconFilter size={14} />, onClick: () => setParam("session", name) }];

  const macLabel = (r: MacItem) => macFromB64(r.MacAddress_bin);

  return (
    <>
      <PageHeader
        title="MAC & IP Tables"
        meta={reachable && mac.data && ip.data ? <>
          <span>{plural(mac.data.MacTable?.length ?? 0, "MAC entry", "MAC entries")}</span><span className="sem-dim">·</span>
          <span>{plural(ip.data.IpTable?.length ?? 0, "IP entry", "IP entries")}</span>
          {session && <><span className="sem-dim">·</span><Tag color="accent" icon={<IconFilter size={11} />}>Session {session}</Tag></>}
        </> : undefined}
        description="Addresses the hub’s virtual switch has learned. Deleting an entry makes the hub learn it again; it doesn’t disconnect the session."
        actions={reachable && (
          <div className="sem-row-inline" style={{ flexWrap: "nowrap" }}>
            <Select size="xs" w={220} placeholder="All sessions" clearable searchable value={session || null} onChange={(v) => setParam("session", v ?? "")}
              data={sessions} aria-label="Show entries of session" leftSection={<IconFilter size={12} />} data-testid="tables-session-filter" nothingFoundMessage="No sessions" />
            <Switch size="xs" label="Auto-refresh" checked={auto} onChange={(e) => setAuto(e.currentTarget.checked)} data-testid="tables-autorefresh" />
          </div>
        )}
      />
      {!reachable ? <Unreachable serverId={serverId} /> : <>
        <Section title="MAC address table" description="Which session each Ethernet address was last seen on." testId="mac-section">
          <DataTable
            testId="mac-table" aria-label="MAC address table"
            data={macRows} loading={mac.isLoading} error={mac.error} onRetry={() => void mac.refetch()}
            rowKey={(r) => r.Key_u32} rowTestId={(r) => `mac-row-${macLabel(r)}`}
            selectable="multi" selection={macSel} onSelectionChange={(k) => setMacSel(k)}
            initialSort={{ key: "SessionName_str", dir: "asc" }} maxHeight={360} searchPlaceholder="Filter MAC addresses"
            empty={{ title: session ? "No MAC Addresses for This Session" : "No MAC Addresses Learned", description: session ? "Show all sessions to see the rest of the table." : "Entries appear as sessions send traffic.", icon: <IconTable size={26} stroke={1.4} />,
              action: session ? <Button size="xs" variant="default" onClick={() => setParam("session", "")}>Show All Sessions</Button> : undefined }}
            toolbar={macSel.length > 0 && (
              <Button size="xs" variant="default" c="var(--sem-red)" leftSection={<IconTrash size={13} />} data-testid="mac-delete-selected"
                onClick={() => {
                  const rows = (mac.data?.MacTable ?? []).filter((r) => macSel.includes(r.Key_u32)).map((r) => ({ key: r.Key_u32, label: macLabel(r) }));
                  void bulk("DeleteMacTable", rows, () => setMacSel([]));
                }}>Delete {macSel.length}…</Button>
            )}
            contextMenu={(r, sel) => sel.length > 1 ? [
              { label: `Delete ${sel.length} Entries…`, icon: <IconTrash size={14} />, danger: true, onClick: () => void bulk("DeleteMacTable", sel.map((x) => ({ key: x.Key_u32, label: macLabel(x) })), () => setMacSel([])) },
            ] : [
              ...sessionItems(r.SessionName_str),
              { label: "Copy MAC Address", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(macLabel(r)) },
              "divider",
              { label: "Delete Entry…", icon: <IconTrash size={14} />, danger: true, onClick: () => delMac.mutate({ HubName_str: hub, Key_u32: r.Key_u32 }), testId: `delete-mac-${macLabel(r)}` },
            ]}
            columns={[
              { key: "MacAddress_bin", title: "MAC address", width: 170, mono: true, value: (r) => macLabel(r), render: (r) => macLabel(r) },
              { key: "SessionName_str", title: "Session", truncate: true, render: (r) => sessionCell(r.SessionName_str) },
              ...(anyVlan ? [{ key: "VlanId_u32", title: "VLAN", align: "right" as const, width: 64, render: (r: MacItem) => (r.VlanId_u32 ? <span className="sem-num">{r.VlanId_u32}</span> : <span className="sem-dim">–</span>) }] : []),
              { key: "RemoteHostname_str", title: "Server", width: 150, truncate: true, render: (r) => <span className="sem-row-inline" style={{ flexWrap: "nowrap", gap: "var(--sem-space-2)" }}>{r.RemoteHostname_str}{anyRemote && r.RemoteItem_bool && <Tag variant="outline">Remote</Tag>}</span> },
              { key: "CreatedTime_dt", title: "Created", width: 96, render: (r) => when(r.CreatedTime_dt) },
              { key: "UpdatedTime_dt", title: "Updated", width: 96, render: (r) => when(r.UpdatedTime_dt) },
            ]}
          />
        </Section>

        <div ref={ipRef} style={{ scrollMarginTop: "var(--sem-space-6)" }}>
          <Section title="IP address table" description="Which session each IP address was last seen on, and whether SecureNAT’s DHCP server assigned it." testId="ip-section">
            <DataTable
              testId="ip-table" aria-label="IP address table"
              data={ipRows} loading={ip.isLoading} error={ip.error} onRetry={() => void ip.refetch()}
              rowKey={(r) => r.Key_u32} rowTestId={(r) => `ip-row-${r.IpAddress_ip}`}
              selectable="multi" selection={ipSel} onSelectionChange={(k) => setIpSel(k)}
              initialSort={{ key: "SessionName_str", dir: "asc" }} maxHeight={360} searchPlaceholder="Filter IP addresses"
              filters={<Checkbox size="xs" label="DHCP-assigned only" checked={dhcpOnly} onChange={(e) => setDhcpOnly(e.currentTarget.checked)} data-testid="tables-dhcp-only" />}
              empty={{ title: session ? "No IP Addresses for This Session" : "No IP Addresses Learned", description: session ? "Show all sessions to see the rest of the table." : "Entries appear as sessions send IP traffic.", icon: <IconTable size={26} stroke={1.4} />,
                action: session ? <Button size="xs" variant="default" onClick={() => setParam("session", "")}>Show All Sessions</Button> : undefined }}
              toolbar={ipSel.length > 0 && (
                <Button size="xs" variant="default" c="var(--sem-red)" leftSection={<IconTrash size={13} />} data-testid="ip-delete-selected"
                  onClick={() => {
                    const rows = (ip.data?.IpTable ?? []).filter((r) => ipSel.includes(r.Key_u32)).map((r) => ({ key: r.Key_u32, label: r.IpAddress_ip }));
                    void bulk("DeleteIpTable", rows, () => setIpSel([]));
                  }}>Delete {ipSel.length}…</Button>
              )}
              contextMenu={(r, sel) => sel.length > 1 ? [
                { label: `Delete ${sel.length} Entries…`, icon: <IconTrash size={14} />, danger: true, onClick: () => void bulk("DeleteIpTable", sel.map((x) => ({ key: x.Key_u32, label: x.IpAddress_ip })), () => setIpSel([])) },
              ] : [
                ...sessionItems(r.SessionName_str),
                { label: "Copy IP Address", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(r.IpAddress_ip) },
                "divider",
                { label: "Delete Entry…", icon: <IconTrash size={14} />, danger: true, onClick: () => delIp.mutate({ HubName_str: hub, Key_u32: r.Key_u32 }), testId: `delete-ip-${r.IpAddress_ip}` },
              ]}
              columns={[
                { key: "IpAddress_ip", title: "IP address", width: 170, mono: true },
                { key: "DhcpAllocated_bool", title: "Source", width: 110, value: (r) => (r.DhcpAllocated_bool ? "DHCP" : "Learned"),
                  render: (r) => r.DhcpAllocated_bool ? <Tag color="teal">DHCP</Tag> : <Tag>Learned</Tag> },
                { key: "SessionName_str", title: "Session", truncate: true, render: (r) => sessionCell(r.SessionName_str) },
                { key: "RemoteHostname_str", title: "Server", width: 150, truncate: true, render: (r) => <span className="sem-row-inline" style={{ flexWrap: "nowrap", gap: "var(--sem-space-2)" }}>{r.RemoteHostname_str}{anyRemote && r.RemoteItem_bool && <Tag variant="outline">Remote</Tag>}</span> },
                { key: "CreatedTime_dt", title: "Created", width: 96, render: (r) => when(r.CreatedTime_dt) },
                { key: "UpdatedTime_dt", title: "Updated", width: 96, render: (r) => when(r.UpdatedTime_dt) },
              ]}
            />
          </Section>
        </div>
      </>}
    </>
  );
}
