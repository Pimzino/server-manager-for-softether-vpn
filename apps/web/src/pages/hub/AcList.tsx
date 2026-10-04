import { useEffect, useMemo, useState } from "react";
import {
  ActionIcon, Alert, Badge, Button, Group, Modal, NumberInput, SegmentedControl, Stack, Switch, Table, Text, TextInput, Tooltip,
} from "@mantine/core";
import {
  IconArrowDown, IconArrowUp, IconInfoCircle, IconListNumbers, IconPencil, IconPlus, IconTrash,
} from "@tabler/icons-react";
import { Empty, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { SaveBar, useDocs, useHubAccess } from "../../components/hub-a/shared";
import { useRpc, useRpcMutation } from "../../lib/hooks";
import { isIPv4 } from "../../lib/format";

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

function RuleModal({ state, onClose, onSave }: { state: EditState | null; onClose: () => void; onSave: (s: EditState) => void }) {
  const doc = useDocs("VpnAc");
  const [s, setS] = useState<EditState | null>(state);
  useEffect(() => setS(state), [state]);
  if (!s) return <Modal opened={false} onClose={onClose}>{null}</Modal>;
  const v6 = isIPv6(s.ip.trim());
  const ipOk = isIPv4(s.ip.trim()) || v6;
  const maskInput = s.mask.trim().replace(/^\//, "");
  const maskIsPrefix = /^\d{1,3}$/.test(maskInput);
  const maskOk = !s.masked || (maskIsPrefix
    ? Number(maskInput) <= (v6 ? 128 : 32)
    : (v6 ? isIPv6(maskInput) : isIPv4(maskInput)) && maskToPrefix(maskInput) !== null);
  const valid = ipOk && maskOk && s.priority >= 1;
  return (
    <Modal opened onClose={onClose} title={s.key === null ? "Add source IP rule" : "Edit source IP rule"} centered>
      <form onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const mask = !s.masked ? "" : maskIsPrefix ? prefixToMask(Number(maskInput), v6) : maskInput;
        onSave({ ...s, ip: s.ip.trim(), mask });
      }}>
        <Stack>
          <SegmentedControl
            data={[{ value: "allow", label: "Allow" }, { value: "deny", label: "Deny" }]}
            value={s.deny ? "deny" : "allow"}
            color={s.deny ? "red" : "green"}
            onChange={(v) => setS({ ...s, deny: v === "deny" })}
            data-testid="acl-action"
          />
          <NumberInput
            label="Priority"
            description={`${doc("Priority_u32", "Priority")}. 1 or greater; smaller numbers are evaluated first.`}
            min={1} max={4294967295} allowDecimal={false} allowNegative={false}
            value={s.priority} onChange={(v) => setS({ ...s, priority: Number(v) || 0 })}
            error={s.priority < 1 ? "Priority must be 1 or greater" : undefined}
            data-testid="acl-priority"
          />
          <TextInput
            label="IP address"
            description="IPv4 or IPv6 address of the client (or the network address when a subnet is used)"
            value={s.ip} onChange={(e) => setS({ ...s, ip: e.currentTarget.value })}
            placeholder="192.168.10.0 or 2001:db8::"
            error={s.ip && !ipOk ? "Enter a valid IPv4 or IPv6 address" : undefined}
            required data-autofocus
            data-testid="acl-ip"
          />
          <Switch
            label="Match a subnet"
            description={doc("Masked_bool", "Set true to specify a subnet mask")}
            checked={s.masked} onChange={(e) => setS({ ...s, masked: e.currentTarget.checked })}
            data-testid="acl-masked"
          />
          {s.masked && (
            <TextInput
              label="Subnet mask or prefix length"
              description={v6 ? "e.g. 64 or ffff:ffff:ffff:ffff::" : "e.g. 24 or 255.255.255.0"}
              value={s.mask} onChange={(e) => setS({ ...s, mask: e.currentTarget.value })}
              placeholder={v6 ? "64" : "24"}
              error={s.mask && !maskOk ? `Enter a prefix length (0–${v6 ? 128 : 32}) or a contiguous ${v6 ? "IPv6" : "IPv4"} mask` : undefined}
              required
              data-testid="acl-mask"
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!valid} data-testid="acl-rule-submit">{s.key === null ? "Add rule" : "Apply"}</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

const sortRows = (rows: Row[]) => [...rows].sort((a, b) => a.Priority_u32 - b.Priority_u32);
const strip = (rows: Row[]) => JSON.stringify(rows.map(({ _k, Id_u32, ...r }) => ({ ...r, SubnetMask_ip: r.Masked_bool ? r.SubnetMask_ip : "" })));

export default function HubAcListPage() {
  const { serverId, hub, role, canWrite } = useHubAccess();
  const q = useRpc<{ ACList?: Ac[] }>(serverId, "GetAcList", { HubName_str: hub }, { enabled: !!hub });
  const initial = useMemo(() => sortRows((q.data?.ACList ?? []).map(withKey)), [q.data]);
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => setRows(initial), [initial]);
  const [edit, setEdit] = useState<EditState | null>(null);
  const save = useRpcMutation(serverId, "SetAcList", { success: "Source IP access control list saved" });
  const dirty = strip(rows) !== strip(initial);
  const sorted = sortRows(rows);

  const nextPriority = () => (rows.length ? Math.max(...rows.map((r) => r.Priority_u32)) + 10 : 100);

  const applyEdit = (s: EditState) => {
    const rule: Ac = { Priority_u32: s.priority, Deny_bool: s.deny, Masked_bool: s.masked, IpAddress_ip: s.ip, SubnetMask_ip: s.masked ? s.mask : "0.0.0.0" };
    setRows((rs) => s.key === null ? [...rs, withKey(rule)] : rs.map((r) => (r._k === s.key ? { ...r, ...rule } : r)));
    setEdit(null);
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

  const denyAllDefault = sorted.length > 0 && sorted.every((r) => !r.Deny_bool);

  return (
    <>
      <PageHeader
        title="Source IP access control"
        description="Allow or deny VPN connections to this Virtual Hub based on the client computer's source IP address. Rules are evaluated in priority order (smallest number first); the first matching rule decides. If no rule matches, the connection is allowed."
      />
      {!canWrite && <ReadOnlyNotice role={role} />}
      <QueryState query={q}>
        <Section
          title="Rules"
          actions={canWrite && (
            <>
              <Button size="sm" variant="default" leftSection={<IconListNumbers size={16} />} onClick={renumber} disabled={rows.length < 2} data-testid="acl-renumber">Renumber</Button>
              <Button size="sm" leftSection={<IconPlus size={16} />} data-testid="acl-add"
                onClick={() => setEdit({ key: null, priority: nextPriority(), deny: true, ip: "", masked: true, mask: "" })}>Add rule</Button>
            </>
          )}
        >
          {denyAllDefault && (
            <Alert color="yellow" variant="light" icon={<IconInfoCircle size={16} />} mb="sm">
              All rules are “allow”, but unmatched addresses are also allowed. To permit only these addresses, add a final
              <b> deny</b> rule for <code>0.0.0.0/0</code> (and <code>::/0</code> for IPv6) with the highest priority number.
            </Alert>
          )}
          {sorted.length === 0 ? <Empty>No rules — connections are accepted from any source IP address.</Empty> : (
            <Table data-testid="acl-table" striped verticalSpacing="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={90}>Priority</Table.Th>
                  <Table.Th w={100}>Action</Table.Th>
                  <Table.Th>Source address</Table.Th>
                  <Table.Th>Subnet mask</Table.Th>
                  <Table.Th w={70}>Family</Table.Th>
                  {canWrite && <Table.Th w={150} />}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {sorted.map((r, idx) => (
                  <Table.Tr key={r._k} data-testid="acl-row">
                    <Table.Td><Text size="sm" ff="monospace">{r.Priority_u32}</Text></Table.Td>
                    <Table.Td><Badge color={r.Deny_bool ? "red" : "green"} variant="light">{r.Deny_bool ? "Deny" : "Allow"}</Badge></Table.Td>
                    <Table.Td><Text size="sm" ff="monospace" fw={600}>{describe(r)}</Text></Table.Td>
                    <Table.Td><Text size="sm" ff="monospace" c="dimmed">{r.Masked_bool ? r.SubnetMask_ip : "single host"}</Text></Table.Td>
                    <Table.Td><Badge variant="outline" color="gray" size="sm">{isIPv6(r.IpAddress_ip) ? "IPv6" : "IPv4"}</Badge></Table.Td>
                    {canWrite && (
                      <Table.Td>
                        <Group gap={2} justify="flex-end" wrap="nowrap">
                          <Tooltip label="Move up"><ActionIcon variant="subtle" disabled={idx === 0} onClick={() => move(r._k, -1)} aria-label="Move up"><IconArrowUp size={16} /></ActionIcon></Tooltip>
                          <Tooltip label="Move down"><ActionIcon variant="subtle" disabled={idx === sorted.length - 1} onClick={() => move(r._k, 1)} aria-label="Move down"><IconArrowDown size={16} /></ActionIcon></Tooltip>
                          <Tooltip label="Edit"><ActionIcon variant="subtle" aria-label="Edit rule" data-testid="acl-edit"
                            onClick={() => {
                              const p = r.Masked_bool ? maskToPrefix(r.SubnetMask_ip) : null;
                              setEdit({ key: r._k, priority: r.Priority_u32, deny: r.Deny_bool, ip: r.IpAddress_ip, masked: r.Masked_bool, mask: r.Masked_bool ? (p === null ? r.SubnetMask_ip : String(p)) : "" });
                            }}><IconPencil size={16} /></ActionIcon></Tooltip>
                          <Tooltip label="Remove"><ActionIcon variant="subtle" color="red" aria-label="Remove rule" data-testid="acl-delete"
                            onClick={() => setRows((rs) => rs.filter((x) => x._k !== r._k))}><IconTrash size={16} /></ActionIcon></Tooltip>
                        </Group>
                      </Table.Td>
                    )}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
          {canWrite && (
            <>
              <Text size="xs" c="dimmed" mt="sm">Edits are local until you save; saving replaces the hub's entire list.</Text>
              <SaveBar dirty={dirty} saving={save.isPending} onReset={() => setRows(initial)} onSave={onSave} saveLabel="Save list" testId="acl-save" />
            </>
          )}
        </Section>
      </QueryState>
      <RuleModal state={edit} onClose={() => setEdit(null)} onSave={applyEdit} />
    </>
  );
}
