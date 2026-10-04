// Hub › Source IP Control: allow or deny VPN connections to the hub by the client's source IP address.
// Ported from apps/web/src/pages/hub/AcList.tsx: GetAcList / SetAcList, same validation and prefix handling.
// SetAcList replaces the whole list, so edits are staged locally and applied with the save bar.
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Button, NumberInput, SegmentedControl, Switch, TextInput } from "@mantine/core";
import { IconAccessPoint, IconArrowDown, IconArrowUp, IconListNumbers, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import { isIPv4 } from "../../lib/format";
import { DataTable, FormRow, FormSection, Mono, PageHeader, Sheet, Tag, ToolbarButton, ToolbarGroup, type ContextMenuItem, type RowKey } from "../../design";
import { Callout, SaveBar } from "../../components/domain/ui";
import { useDocs } from "../../components/domain/hooks";
import { Unreachable, useHubPage } from "./_hub-policy-network/shared";

interface Ac {
  Id_u32?: number;
  Priority_u32: number;
  Deny_bool: boolean;
  Masked_bool: boolean;
  IpAddress_ip: string;
  SubnetMask_ip: string;
}

/** Local row with a stable client-side key. */
interface Row extends Ac { _k: number }

let seq = 1;
const withKey = (a: Ac): Row => ({ ...a, _k: seq++ });

function isIPv6(s: string) {
  if (!s.includes(":")) return false;
  try { new URL(`http://[${s}]/`); return true; } catch { return false; }
}

function prefixToMask(prefix: number, v6: boolean): string {
  if (!v6) {
    const m = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return [24, 16, 8, 0].map((s) => (m >>> s) & 255).join(".");
  }
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    const bits = Math.max(0, Math.min(16, prefix - i * 16));
    groups.push(((0xffff << (16 - bits)) & 0xffff).toString(16));
  }
  return groups.join(":").replace(/(^|:)0(:0)+$/, "::").replace(/^0::$/, "::");
}

/** Count leading 1-bits of an IPv4/IPv6 mask; null when not a contiguous mask. */
function maskToPrefix(mask: string): number | null {
  let bits: string;
  if (isIPv4(mask)) bits = mask.split(".").map((o) => Number(o).toString(2).padStart(8, "0")).join("");
  else if (isIPv6(mask)) {
    const [head, tail] = mask.split("::");
    const h = head ? head.split(":") : [];
    const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
    const full = tail !== undefined ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
    bits = full.map((g) => parseInt(g || "0", 16).toString(2).padStart(16, "0")).join("");
  } else return null;
  const p = bits.indexOf("0") === -1 ? bits.length : bits.indexOf("0");
  return bits.slice(p).includes("1") ? null : p;
}

function describe(a: Ac) {
  if (!a.Masked_bool) return a.IpAddress_ip;
  const p = maskToPrefix(a.SubnetMask_ip);
  return p === null ? `${a.IpAddress_ip} / ${a.SubnetMask_ip}` : `${a.IpAddress_ip}/${p}`;
}

interface EditState { key: number | null; priority: number; deny: boolean; ip: string; masked: boolean; mask: string }

function RuleSheet({ state, onClose, onSave }: { state: EditState | null; onClose: () => void; onSave: (s: EditState) => void }) {
  const doc = useDocs("VpnAc");
  const [s, setS] = useState<EditState | null>(state);
  useEffect(() => { if (state) setS(state); }, [state]);
  const cur = s ?? { key: null, priority: 100, deny: true, ip: "", masked: true, mask: "" };
  const v6 = isIPv6(cur.ip.trim());
  const ipOk = isIPv4(cur.ip.trim()) || v6;
  const maskInput = cur.mask.trim().replace(/^\//, "");
  const maskIsPrefix = /^\d{1,3}$/.test(maskInput);
  const maskOk = !cur.masked || (maskIsPrefix
    ? Number(maskInput) <= (v6 ? 128 : 32)
    : (v6 ? isIPv6(maskInput) : isIPv4(maskInput)) && maskToPrefix(maskInput) !== null);
  const valid = ipOk && maskOk && cur.priority >= 1;
  const submit = () => {
    if (!valid || !s) return;
    const mask = !s.masked ? "" : maskIsPrefix ? prefixToMask(Number(maskInput), v6) : maskInput;
    onSave({ ...s, ip: s.ip.trim(), mask });
  };
  const set = (p: Partial<EditState>) => setS((x) => (x ? { ...x, ...p } : x));
  const isNew = cur.key === null;
  return (
    <Sheet
      opened={!!state} onClose={onClose} size={520} testId="acl-rule-sheet"
      icon={<IconAccessPoint size={19} stroke={1.5} />}
      title={isNew ? "New Source IP Rule" : "Edit Source IP Rule"}
      subtitle="The change is applied when you save the list."
      footer={(
        <div className="hpn-footer">
          <span className="hpn-footer-note" />
          <div className="hpn-footer-buttons">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={!valid} data-testid="acl-rule-submit">{isNew ? "Add Rule" : "Update Rule"}</Button>
          </div>
        </div>
      )}
    >
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} data-testid="acl-rule-form">
        <FormSection>
          <FormRow label="Action" description={cur.deny ? "Connections from this address are refused." : "Connections from this address are accepted."}>
            <SegmentedControl w={160} aria-label="Action"
              data={[{ value: "allow", label: "Allow" }, { value: "deny", label: "Deny" }]}
              value={cur.deny ? "deny" : "allow"}
              onChange={(v) => set({ deny: v === "deny" })}
              data-testid="acl-action"
            />
          </FormRow>
          <FormRow label="Priority" description="1 or higher. Lower numbers are checked first.">
            {(id) => (
              <NumberInput id={id} w={130} min={1} max={4294967295} allowDecimal={false} allowNegative={false}
                value={cur.priority} onChange={(v) => set({ priority: Number(v) || 0 })}
                error={cur.priority < 1 ? "Use 1 or higher." : undefined}
                data-testid="acl-priority"
              />
            )}
          </FormRow>
          <FormRow label="IP address" description="IPv4 or IPv6 address of the client, or the network address of a subnet.">
            {(id) => (
              <TextInput id={id} ff="monospace"
                value={cur.ip} onChange={(e) => set({ ip: e.currentTarget.value })}
                placeholder="192.168.10.0 or 2001:db8::"
                error={cur.ip && !ipOk ? "Enter an IPv4 or IPv6 address." : undefined}
                data-autofocus data-testid="acl-ip"
              />
            )}
          </FormRow>
          <FormRow label="Match a subnet" description={doc("Masked_bool", "Match every address in a subnet, not just one host.")}>
            <Switch checked={cur.masked} aria-label="Match a subnet" onChange={(e) => set({ masked: e.currentTarget.checked })} data-testid="acl-masked" />
          </FormRow>
          {cur.masked && (
            <FormRow label="Mask or prefix length" description={v6 ? "For example 64 or ffff:ffff:ffff:ffff::" : "For example 24 or 255.255.255.0"}>
              {(id) => (
                <TextInput id={id} ff="monospace" w={220}
                  value={cur.mask} onChange={(e) => set({ mask: e.currentTarget.value })}
                  placeholder={v6 ? "64" : "24"}
                  error={cur.mask && !maskOk ? `Prefix length 0–${v6 ? 128 : 32} or a contiguous ${v6 ? "IPv6" : "IPv4"} mask.` : undefined}
                  data-testid="acl-mask"
                />
              )}
            </FormRow>
          )}
        </FormSection>
      </form>
    </Sheet>
  );
}

const sortRows = (rows: Row[]) => [...rows].sort((a, b) => a.Priority_u32 - b.Priority_u32);
const strip = (rows: Row[]) => JSON.stringify(sortRows(rows).map(({ _k, Id_u32, ...r }) => ({ ...r, SubnetMask_ip: r.Masked_bool ? r.SubnetMask_ip : "" })));

export default function HubAcListPage() {
  const { serverId, hub, server, reachable } = useHubPage();
  const q = useRpc<{ ACList?: Ac[] }>(serverId, "GetAcList", { HubName_str: hub }, { enabled: !!hub && reachable });
  const initial = useMemo(() => sortRows((q.data?.ACList ?? []).map(withKey)), [q.data]);
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => setRows(initial), [initial]);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [selection, setSelection] = useState<RowKey[]>([]);
  const save = useRpcMutation(serverId, "SetAcList", { success: "Source IP rules saved" });
  const dirty = strip(rows) !== strip(initial);
  const sorted = sortRows(rows);
  const selectedRows = sorted.filter((r) => selection.includes(r._k));
  const single = selectedRows.length === 1 ? selectedRows[0] : null;
  const singleIdx = single ? sorted.indexOf(single) : -1;

  const nextPriority = () => (rows.length ? Math.max(...rows.map((r) => r.Priority_u32)) + 10 : 100);

  const applyEdit = (s: EditState) => {
    const rule: Ac = { Priority_u32: s.priority, Deny_bool: s.deny, Masked_bool: s.masked, IpAddress_ip: s.ip, SubnetMask_ip: s.masked ? s.mask : "0.0.0.0" };
    if (s.key === null) {
      const r = withKey(rule);
      setRows((rs) => [...rs, r]);
      setSelection([r._k]);
    } else setRows((rs) => rs.map((r) => (r._k === s.key ? { ...r, ...rule } : r)));
    setEdit(null);
  };

  const openEdit = (r: Row) => {
    const p = r.Masked_bool ? maskToPrefix(r.SubnetMask_ip) : null;
    setEdit({ key: r._k, priority: r.Priority_u32, deny: r.Deny_bool, ip: r.IpAddress_ip, masked: r.Masked_bool, mask: r.Masked_bool ? (p === null ? r.SubnetMask_ip : String(p)) : "" });
  };

  /** Move a rule up/down by swapping it with its neighbour, then renumber priorities 10, 20, 30… */
  const move = (k: number, dir: -1 | 1) => {
    const list = sortRows(rows);
    const i = list.findIndex((r) => r._k === k);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setRows(list.map((r, idx) => ({ ...r, Priority_u32: (idx + 1) * 10 })));
  };
  const renumber = () => setRows(sortRows(rows).map((r, idx) => ({ ...r, Priority_u32: (idx + 1) * 10 })));
  const remove = (keys: number[]) => { setRows((rs) => rs.filter((x) => !keys.includes(x._k))); setSelection([]); };

  const onSave = () => save.mutate({
    HubName_str: hub,
    ACList: sortRows(rows).map((r) => ({
      Id_u32: r.Id_u32 ?? 0,
      Priority_u32: r.Priority_u32,
      Deny_bool: r.Deny_bool,
      Masked_bool: r.Masked_bool,
      IpAddress_ip: r.IpAddress_ip,
      SubnetMask_ip: r.Masked_bool ? r.SubnetMask_ip : (isIPv6(r.IpAddress_ip) ? "::" : "0.0.0.0"),
    })),
  });

  const allowOnly = sorted.length > 0 && sorted.every((r) => !r.Deny_bool);
  const denyCount = sorted.filter((r) => r.Deny_bool).length;

  const menu = (r: Row, sel: Row[]): ContextMenuItem[] => {
    if (sel.length > 1) return [{ label: `Remove ${sel.length} Rules`, icon: <IconTrash size={14} />, danger: true, onClick: () => remove(sel.map((x) => x._k)), testId: "acl-delete" }];
    const idx = sorted.indexOf(r);
    return [
      { label: "Edit…", icon: <IconPencil size={14} />, shortcut: "↩", onClick: () => openEdit(r), testId: "acl-edit" },
      "divider",
      { label: "Move Up", icon: <IconArrowUp size={14} />, disabled: idx <= 0, onClick: () => move(r._k, -1), testId: "acl-up" },
      { label: "Move Down", icon: <IconArrowDown size={14} />, disabled: idx >= sorted.length - 1, onClick: () => move(r._k, 1), testId: "acl-down" },
      "divider",
      { label: "Remove Rule", icon: <IconTrash size={14} />, danger: true, shortcut: "⌫", onClick: () => remove([r._k]), testId: "acl-delete" },
    ];
  };

  const onTableKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "Delete" || e.key === "Backspace") && selectedRows.length && (e.target as HTMLElement).classList.contains("sem-table-scroll")) {
      e.preventDefault();
      remove(selectedRows.map((r) => r._k));
    }
  };

  if (server && !reachable) return <><PageHeader title="Source IP Control" /><Unreachable server={server} /></>;

  return (
    <>
      <PageHeader
        title="Source IP Control"
        meta={q.data ? <span data-testid="acl-meta">{sorted.length ? <>{sorted.length} {sorted.length === 1 ? "rule" : "rules"} · {denyCount} deny · {sorted.length - denyCount} allow</> : "No rules"}</span> : undefined}
        description="Allow or deny VPN connections to this hub by the client’s source IP address. The first matching rule decides; addresses that match no rule are allowed."
        actions={<>
          <Button variant="default" leftSection={<IconListNumbers size={14} />} onClick={renumber} disabled={rows.length < 2} data-testid="acl-renumber">Renumber</Button>
          <Button leftSection={<IconPlus size={14} />} data-testid="acl-add"
            onClick={() => setEdit({ key: null, priority: nextPriority(), deny: true, ip: "", masked: true, mask: "" })}>Add Rule…</Button>
        </>}
      />
      {allowOnly && (
        <div className="hpn-callouts">
          <Callout tone="yellow" testId="acl-allow-only" title="Every rule allows, and so does the default.">
            To accept only these addresses, add a last <b>Deny</b> rule for <Mono>0.0.0.0/0</Mono> (and <Mono>::/0</Mono> for IPv6) with the highest priority number.
          </Callout>
        </div>
      )}
      <div onKeyDown={onTableKey}>
        <DataTable
          testId="acl-table"
          aria-label="Source IP rules"
          data={q.data ? sorted : undefined}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          rowKey={(r) => r._k}
          rowTestId={() => "acl-row"}
          selectable="multi"
          selection={selection}
          onSelectionChange={(k) => setSelection(k)}
          onRowOpen={openEdit}
          contextMenu={menu}
          searchPlaceholder="Filter rules"
          initialSort={{ key: "Priority_u32", dir: "asc" }}
          empty={{
            title: "No source IP rules",
            description: "Connections are accepted from any source address.",
            icon: <IconAccessPoint size={28} stroke={1.4} />,
            action: <Button size="xs" variant="default" onClick={() => setEdit({ key: null, priority: nextPriority(), deny: true, ip: "", masked: true, mask: "" })}>Add Rule…</Button>,
          }}
          toolbar={<>
            {selectedRows.length > 1 && (
              <Button size="xs" variant="default" c="var(--sem-red)" leftSection={<IconTrash size={13} />} onClick={() => remove(selectedRows.map((r) => r._k))} data-testid="acl-remove-selected">
                Remove {selectedRows.length} Rules
              </Button>
            )}
            <ToolbarGroup label="Order">
              <ToolbarButton icon={<IconArrowUp size={15} />} label="Move Up" disabled={!single || singleIdx <= 0} onClick={() => single && move(single._k, -1)} testId="acl-move-up" />
              <ToolbarButton icon={<IconArrowDown size={15} />} label="Move Down" disabled={!single || singleIdx >= sorted.length - 1} onClick={() => single && move(single._k, 1)} testId="acl-move-down" />
            </ToolbarGroup>
          </>}
          columns={[
            { key: "Priority_u32", title: "Priority", align: "right", width: 80, render: (r) => <span className="sem-num">{r.Priority_u32}</span> },
            { key: "Deny_bool", title: "Action", width: 90, value: (r) => (r.Deny_bool ? "Deny" : "Allow"), render: (r) => <Tag color={r.Deny_bool ? "red" : "green"}>{r.Deny_bool ? "Deny" : "Allow"}</Tag> },
            { key: "addr", title: "Source address", value: (r) => describe(r), render: (r) => <span className="sem-mono sem-strong">{describe(r)}</span> },
            { key: "SubnetMask_ip", title: "Subnet mask", value: (r) => (r.Masked_bool ? r.SubnetMask_ip : ""), render: (r) => (r.Masked_bool ? <Mono dim>{r.SubnetMask_ip}</Mono> : <span className="sem-dim">Single host</span>) },
            { key: "family", title: "Family", width: 80, value: (r) => (isIPv6(r.IpAddress_ip) ? "IPv6" : "IPv4"), render: (r) => <span className="sem-dim">{isIPv6(r.IpAddress_ip) ? "IPv6" : "IPv4"}</span> },
          ]}
        />
      </div>
      <SaveBar dirty={dirty} saving={save.isPending} onReset={() => { setRows(initial); setSelection([]); }} onSave={onSave} saveLabel="Save Rules" testId="acl-save"
        note="Unsaved changes. Saving replaces the hub’s whole list." />
      <RuleSheet state={edit} onClose={() => setEdit(null)} onSave={applyEdit} />
    </>
  );
}
