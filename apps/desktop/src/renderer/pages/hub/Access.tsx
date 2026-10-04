// Hub › Access Lists: the Virtual Hub's packet filter. Rules are checked from the lowest priority number;
// the first match decides Pass or Discard, and packets that match no rule pass.
// Ported from apps/web/src/pages/hub/Access.tsx: same RPCs (EnumAccess, AddAccess, SetAccessList, DeleteAccess),
// same form model and validation, redesigned as a dense table (context menu, double-click to edit) + a Sheet.
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Button, NumberInput, SegmentedControl, Select, Switch, TextInput } from "@mantine/core";
import {
  IconArrowDown, IconArrowUp, IconCopy, IconDownload, IconFilter, IconListNumbers, IconPencil, IconPlus, IconToggleLeft, IconTrash,
} from "@tabler/icons-react";
import { downloadText, num, plural } from "../../lib/format";
import { notifyError, notifySuccess, useCaps, useRpc, useRpcMutation } from "../../lib/hooks";
import {
  confirmAction, DataTable, FormRow, FormSection, Mono, PageHeader, Sheet, Tag, ToolbarButton, ToolbarGroup, type ContextMenuItem, type RowKey,
} from "../../design";
import { Callout, HelpLabel } from "../../components/domain/ui";
import { useDocs } from "../../components/domain/hooks";
import {
  endpoint, extras, fromForm, PROTOCOLS, service, toForm, validate, FULL_MAC_MASK, type Access, type RuleForm,
} from "./_hub-policy-network/access-model";
import { Fields, Unreachable, useHubPage } from "./_hub-policy-network/shared";

const unit = (u: string) => ({ rightSection: <span className="sem-input-unit">{u}</span>, rightSectionWidth: 38 });

/* ------------------------------------------------------------------ editor sheet */

function RuleSheet({ opened, onClose, initial, mode, onSave, saving, nextPriority }: {
  opened: boolean; onClose: () => void; initial: Access | null; mode: "create" | "edit"; onSave: (a: Access) => void; saving: boolean; nextPriority: number;
}) {
  const doc = useDocs("VpnAccess");
  const [f, setF] = useState<RuleForm>(() => toForm(initial, nextPriority));
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (opened) { setF(toForm(initial, nextPriority)); setTouched(false); } }, [opened, initial, nextPriority]);
  const set = (p: Partial<RuleForm>) => setF((s) => ({ ...s, ...p }));
  const errs = validate(f);
  const errList = Object.values(errs);
  const proto = f.proto === "custom" ? f.customProto : Number(f.proto);
  const portsApply = proto === 0 || proto === 6 || proto === 17;
  const submit = () => { setTouched(true); if (!errList.length) onSave(fromForm(f, mode === "edit" ? initial : null)); };

  const endpointSection = (side: "src" | "dst") => {
    const S = side === "src";
    const ipK = S ? "srcIp" : "dstIp", mK = S ? "srcMask" : "dstMask";
    const psK = S ? "srcPortStart" : "dstPortStart", peK = S ? "srcPortEnd" : "dstPortEnd";
    const uK = S ? "srcUser" : "dstUser";
    const cK = S ? "checkSrcMac" : "checkDstMac", macK = S ? "srcMac" : "dstMac", mmK = S ? "srcMacMask" : "dstMacMask";
    return (
      <FormSection title={S ? "Source" : "Destination"} testId={`rule-${side}`}>
        <FormRow label={f.ipv6 ? "IPv6 network" : "IPv4 network"} align="start"
          description={f.ipv6 ? "Empty matches any address; no prefix means one host." : "Empty matches any address; no mask means one host."}>
          <Fields cols="minmax(0, 1.4fr) minmax(0, 1fr)">
            <TextInput aria-label={`${S ? "Source" : "Destination"} address`} placeholder="Any" value={f[ipK]} error={errs[ipK]} ff="monospace"
              onChange={(e) => set({ [ipK]: e.currentTarget.value } as Partial<RuleForm>)} data-testid={`rule-${side}-ip`} />
            <TextInput aria-label={f.ipv6 ? "Prefix length" : "Subnet mask"} placeholder={f.ipv6 ? "Prefix (128)" : "Mask or prefix"} value={f[mK]} error={errs[mK]} ff="monospace"
              onChange={(e) => set({ [mK]: e.currentTarget.value } as Partial<RuleForm>)} data-testid={`rule-${side}-mask`} />
          </Fields>
        </FormRow>
        {portsApply && (
          <FormRow label="Ports" align="start" description="0 matches any port.">
            <div className="hpn-range">
              <NumberInput aria-label={`${S ? "Source" : "Destination"} first port`} min={0} max={65535} allowDecimal={false} allowNegative={false} value={f[psK]} error={errs[psK]}
                onChange={(v) => set({ [psK]: Number(v) || 0 } as Partial<RuleForm>)} data-testid={`rule-${side}-port-start`} />
              <span className="hpn-range-sep">to</span>
              <NumberInput aria-label={`${S ? "Source" : "Destination"} last port`} min={0} max={65535} allowDecimal={false} allowNegative={false} value={f[peK]} error={errs[peK]}
                onChange={(v) => set({ [peK]: Number(v) || 0 } as Partial<RuleForm>)} data-testid={`rule-${side}-port-end`} />
            </div>
          </FormRow>
        )}
        <FormRow label={<HelpLabel label="User name" doc={doc(S ? "SrcUsername_str" : "DestUsername_str")} />} description="Only this user’s sessions. Empty matches everyone.">
          {(id) => <TextInput id={id} placeholder="Any user" value={f[uK]} onChange={(e) => set({ [uK]: e.currentTarget.value } as Partial<RuleForm>)} data-testid={`rule-${side}-user`} />}
        </FormRow>
        <FormRow label="Match MAC address" description={f[cK] ? "FF-FF-FF-FF-FF-FF as the mask matches the address exactly." : undefined} align={f[cK] ? "start" : "center"}>
          <Switch checked={f[cK]} aria-label={`Match ${S ? "source" : "destination"} MAC address`} onChange={(e) => set({ [cK]: e.currentTarget.checked } as Partial<RuleForm>)}
            data-testid={`rule-${side}-checkmac`} />
          {f[cK] && (
            <Fields cols="minmax(0, 1fr) minmax(0, 1fr)">
              <TextInput aria-label="MAC address" value={f[macK]} error={errs[macK]} placeholder="00-AC-01-23-45-67" ff="monospace"
                onChange={(e) => set({ [macK]: e.currentTarget.value } as Partial<RuleForm>)} data-testid={`rule-${side}-mac`} />
              <TextInput aria-label="MAC mask" value={f[mmK]} error={errs[mmK]} placeholder={FULL_MAC_MASK} ff="monospace"
                onChange={(e) => set({ [mmK]: e.currentTarget.value } as Partial<RuleForm>)} data-testid={`rule-${side}-macmask`} />
            </Fields>
          )}
        </FormRow>
      </FormSection>
    );
  };

  const note: ReactNode = touched && errList.length ? errList[0]
    : mode === "edit" && initial?.UniqueId_u32 !== undefined ? <>Rule {initial.Id_u32} · unique ID <Mono>{String(initial.UniqueId_u32)}</Mono></> : null;

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={saving} size={680} testId="access-rule-sheet"
      icon={<IconFilter size={19} stroke={1.5} />}
      title={mode === "create" ? "New Access Rule" : <>Edit Rule {initial?.Id_u32}</>}
      subtitle={mode === "edit" && initial?.Note_utf ? initial.Note_utf : "Checked in priority order; the first matching rule decides."}
      footer={(
        <div className="hpn-footer">
          <span className="hpn-footer-note" data-error={touched && errList.length ? true : undefined}>{note}</span>
          <div className="hpn-footer-buttons">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} loading={saving} disabled={touched && errList.length > 0} data-testid="rule-save">{mode === "create" ? "Add Rule" : "Save"}</Button>
          </div>
        </div>
      )}
    >
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} data-testid="access-rule-form">
        <FormSection title="Rule">
          <FormRow label="Action" description={f.discard ? "Matching packets are dropped." : "Matching packets are let through; later rules are skipped."}>
            <SegmentedControl value={f.discard ? "discard" : "pass"} onChange={(v) => set({ discard: v === "discard" })} w={180} aria-label="Action"
              data={[{ value: "pass", label: "Pass" }, { value: "discard", label: "Discard" }]} data-testid="rule-action" />
          </FormRow>
          <FormRow label="Priority" description="Lower numbers are checked first.">
            {(id) => <NumberInput id={id} w={120} min={1} value={f.priority} error={errs.priority} allowDecimal={false} allowNegative={false}
              onChange={(v) => set({ priority: Number(v) || 0 })} data-testid="rule-priority" />}
          </FormRow>
          <FormRow label="Enabled">
            <Switch checked={f.active} aria-label="Enabled" onChange={(e) => set({ active: e.currentTarget.checked })} data-testid="rule-active" />
          </FormRow>
          <FormRow label="Note">
            {(id) => <TextInput id={id} placeholder="What this rule is for" value={f.note} onChange={(e) => set({ note: e.currentTarget.value })} data-testid="rule-note" data-autofocus />}
          </FormRow>
        </FormSection>

        <FormSection title="Packets">
          <FormRow label="IP version">
            <SegmentedControl value={f.ipv6 ? "6" : "4"} w={140} aria-label="IP version" onChange={(v) => set({ ipv6: v === "6", srcIp: "", srcMask: "", dstIp: "", dstMask: "" })}
              data={[{ value: "4", label: "IPv4" }, { value: "6", label: "IPv6" }]} data-testid="rule-ipver" />
          </FormRow>
          <FormRow label="Protocol" align={f.proto === "custom" ? "start" : "center"} description={!portsApply ? "Port conditions only apply to TCP and UDP." : undefined}>
            <Fields cols={f.proto === "custom" ? "minmax(0, 1fr) 150px" : "minmax(0, 220px)"}>
              <Select aria-label="IP protocol" data={PROTOCOLS} value={f.proto} allowDeselect={false} onChange={(v) => set({ proto: v ?? "0" })} data-testid="rule-protocol" />
              {f.proto === "custom" && (
                <NumberInput aria-label="Protocol number" placeholder="47" min={0} max={255} value={f.customProto} error={errs.customProto} allowDecimal={false} allowNegative={false}
                  onChange={(v) => set({ customProto: Number(v) || 0 })} data-testid="rule-protocol-number" />
              )}
            </Fields>
            {f.proto === "custom" && <div className="hpn-hint">IANA protocol number, e.g. 47 for GRE or 50 for ESP.</div>}
          </FormRow>
          {proto === 6 && (
            <FormRow label={<HelpLabel label="TCP connection state" doc={doc("CheckTcpState_bool")} />}>
              <div className="sem-row-inline" style={{ flexWrap: "nowrap" }}>
                <Switch checked={f.checkTcpState} aria-label="Check TCP connection state" onChange={(e) => set({ checkTcpState: e.currentTarget.checked })} data-testid="rule-tcpstate" />
                {f.checkTcpState && (
                  <SegmentedControl value={f.established ? "est" : "new"} onChange={(v) => set({ established: v === "est" })} aria-label="TCP state"
                    data={[{ value: "est", label: "Established" }, { value: "new", label: "Not established" }]} data-testid="rule-tcpstate-value" />
                )}
              </div>
            </FormRow>
          )}
        </FormSection>

        {endpointSection("src")}
        {endpointSection("dst")}

        <FormSection title="Network simulation" description="Delay, jitter and loss affect packets that pass this rule, for testing applications on a poor link.">
          <FormRow label={<HelpLabel label="Delay" doc={doc("Delay_u32")} />}>
            {(id) => <NumberInput id={id} w={140} min={0} max={10000} value={f.delay} error={errs.delay} allowDecimal={false} allowNegative={false} {...unit("ms")}
              onChange={(v) => set({ delay: Number(v) || 0 })} data-testid="rule-delay" />}
          </FormRow>
          <FormRow label={<HelpLabel label="Jitter" doc={doc("Jitter_u32")} />}>
            {(id) => <NumberInput id={id} w={140} min={0} max={100} value={f.jitter} error={errs.jitter} allowDecimal={false} allowNegative={false} {...unit("%")}
              onChange={(v) => set({ jitter: Number(v) || 0 })} data-testid="rule-jitter" />}
          </FormRow>
          <FormRow label={<HelpLabel label="Packet loss" doc={doc("Loss_u32")} />}>
            {(id) => <NumberInput id={id} w={140} min={0} max={100} value={f.loss} error={errs.loss} allowDecimal={false} allowNegative={false} {...unit("%")}
              onChange={(v) => set({ loss: Number(v) || 0 })} data-testid="rule-loss" />}
          </FormRow>
          <FormRow label={<HelpLabel label="HTTP redirect" doc={doc("RedirectUrl_str")} />} description="Answers matching HTTP requests with a redirect to this URL." align="start">
            {(id) => <TextInput id={id} placeholder="https://portal.example.com/" value={f.redirectUrl} error={errs.redirectUrl}
              onChange={(e) => set({ redirectUrl: e.currentTarget.value })} data-testid="rule-redirect" />}
          </FormRow>
        </FormSection>
        {f.redirectUrl && f.discard && (
          <div className="hpn-block"><Callout tone="orange" testId="rule-redirect-warning">Redirects only take effect on Pass rules.</Callout></div>
        )}
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ page */

export default function AccessPage() {
  const { serverId, hub, server, reachable } = useHubPage();
  const q = useRpc<{ AccessList?: Access[] }>(serverId, "EnumAccess", { HubName_str: hub }, { enabled: reachable });
  const caps = useCaps(serverId);
  const [editor, setEditor] = useState<{ mode: "create" | "edit"; rule: Access | null } | null>(null);
  const [selection, setSelection] = useState<RowKey[]>([]);
  const add = useRpcMutation(serverId, "AddAccess", { success: "Access rule added", onSuccess: () => setEditor(null) });
  const setList = useRpcMutation(serverId, "SetAccessList", { success: "Access list updated", onSuccess: () => setEditor(null) });
  const quiet = useRpcMutation(serverId, "SetAccessList", { success: false });
  const del = useRpcMutation(serverId, "DeleteAccess", {
    success: "Access rule deleted",
    confirm: (p) => {
      const r = q.data?.AccessList?.find((x) => x.Id_u32 === p.Id_u32);
      return {
        title: <>Delete rule {String(p.Id_u32)}{r?.Note_utf ? <> “{r.Note_utf}”</> : null}?</>,
        message: `This ${r?.Discard_bool ? "Discard" : "Pass"} rule is removed from the hub’s access list immediately. This can’t be undone.`,
        confirmLabel: "Delete Rule", tone: "danger", testId: "delete-access",
      };
    },
  });

  const sorted = useMemo(() => [...(q.data?.AccessList ?? [])].sort((a, b) => a.Priority_u32 - b.Priority_u32 || a.Id_u32 - b.Id_u32), [q.data]);
  const nextPriority = (sorted.at(-1)?.Priority_u32 ?? 0) + 10;
  const busy = setList.isPending || quiet.isPending || add.isPending || del.isPending;
  const max = caps.caps.get("i_max_access_lists");
  const enabledCount = sorted.filter((a) => a.Active_bool).length;
  const selectedRules = sorted.filter((a) => selection.includes(a.Id_u32));
  const single = selectedRules.length === 1 ? selectedRules[0] : null;
  const singleIdx = single ? sorted.indexOf(single) : -1;

  const push = (list: Access[], silent = false) => (silent ? quiet : setList).mutateAsync({ HubName_str: hub, AccessList: list }).catch(() => undefined);

  const move = (a: Access, dir: -1 | 1) => {
    const idx = sorted.indexOf(a);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= sorted.length) return;
    const list = sorted.map((r) => ({ ...r }));
    const [x, y] = [list[idx], list[j]];
    if (x.Priority_u32 !== y.Priority_u32) {
      [x.Priority_u32, y.Priority_u32] = [y.Priority_u32, x.Priority_u32];
    } else {
      [list[idx], list[j]] = [list[j], list[idx]];
      list.forEach((r, i) => (r.Priority_u32 = (i + 1) * 10));
    }
    void push(list);
  };
  const renumber = () => void push(sorted.map((a, i) => ({ ...a, Priority_u32: (i + 1) * 10 })));
  const toggle = (id: number, on: boolean) => void push(sorted.map((a) => (a.Id_u32 === id ? { ...a, Active_bool: on } : a)), true);
  const duplicate = (a: Access) => setEditor({ mode: "create", rule: { ...a, Note_utf: a.Note_utf ? `${a.Note_utf} (copy)` : "copy" } });

  const deleteRules = async (rules: Access[]) => {
    if (!rules.length) return;
    if (rules.length === 1) { del.mutate({ HubName_str: hub, Id_u32: rules[0].Id_u32 }); return; }
    const ok = await confirmAction({
      title: <>Delete {rules.length} access rules?</>,
      message: "The selected rules are removed in one update of the hub’s access list. This can’t be undone.",
      confirmLabel: "Delete Rules", tone: "danger", testId: "bulk-delete-access",
    });
    if (ok) void push(sorted.filter((a) => !rules.some((r) => r.Id_u32 === a.Id_u32)));
  };

  const save = (rule: Access) => {
    if (editor?.mode === "edit") void push(sorted.map((a) => (a.Id_u32 === rule.Id_u32 ? rule : a)));
    else {
      const { Id_u32: _id, UniqueId_u32: _uid, ...r } = rule;
      add.mutate({ HubName_str: hub, AccessListSingle: [r] });
    }
  };

  const exportJson = async () => {
    try {
      const r = await downloadText(`${hub}-access-list.json`, JSON.stringify(sorted, null, 2), "application/json");
      if (r.saved) notifySuccess("Access list exported");
    } catch (e) { notifyError(e, "Couldn’t export the access list"); }
  };

  const menu = (a: Access, sel: Access[]): ContextMenuItem[] => {
    if (sel.length > 1) {
      return [
        { label: "Enable", icon: <IconToggleLeft size={14} />, onClick: () => void push(sorted.map((r) => (sel.includes(r) ? { ...r, Active_bool: true } : r))) },
        { label: "Disable", icon: <IconToggleLeft size={14} />, onClick: () => void push(sorted.map((r) => (sel.includes(r) ? { ...r, Active_bool: false } : r))) },
        "divider",
        { label: `Delete ${sel.length} Rules…`, icon: <IconTrash size={14} />, danger: true, onClick: () => void deleteRules(sel), testId: "ctx-delete-access" },
      ];
    }
    const idx = sorted.indexOf(a);
    return [
      { label: "Edit…", icon: <IconPencil size={14} />, onClick: () => setEditor({ mode: "edit", rule: a }), shortcut: "↩", testId: `edit-access-${a.Id_u32}` },
      { label: "Duplicate…", icon: <IconCopy size={14} />, onClick: () => duplicate(a), testId: `dup-access-${a.Id_u32}` },
      "divider",
      { label: "Move Up", icon: <IconArrowUp size={14} />, disabled: idx <= 0 || busy, onClick: () => move(a, -1), testId: `up-access-${a.Id_u32}` },
      { label: "Move Down", icon: <IconArrowDown size={14} />, disabled: idx >= sorted.length - 1 || busy, onClick: () => move(a, 1), testId: `down-access-${a.Id_u32}` },
      { label: a.Active_bool ? "Disable" : "Enable", icon: <IconToggleLeft size={14} />, onClick: () => toggle(a.Id_u32, !a.Active_bool) },
      "divider",
      { label: "Delete Rule…", icon: <IconTrash size={14} />, danger: true, shortcut: "⌫", onClick: () => void deleteRules([a]), testId: `delete-access-${a.Id_u32}` },
    ];
  };

  // Delete / Backspace in the table deletes the selection (after confirmation), like a Finder list.
  const onTableKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "Delete" || e.key === "Backspace") && selectedRules.length && (e.target as HTMLElement).classList.contains("sem-table-scroll")) {
      e.preventDefault();
      void deleteRules(selectedRules);
    }
  };

  if (server && !reachable) return <><PageHeader title="Access Lists" /><Unreachable server={server} /></>;

  return (
    <>
      <PageHeader
        title="Access Lists"
        meta={q.data ? (
          <span data-testid="access-meta">
            {sorted.length ? <>{plural(sorted.length, "rule")} · {num(enabledCount)} enabled</> : "No rules"}
            {max ? <> · limit {num(max)}</> : null}
          </span>
        ) : undefined}
        description="Packet filter rules for this hub, checked from the lowest priority number. The first match decides; packets that match no rule pass."
        actions={<>
          <Button variant="default" leftSection={<IconDownload size={14} />} disabled={!sorted.length} onClick={() => void exportJson()} data-testid="export-access">Export…</Button>
          <Button variant="default" leftSection={<IconListNumbers size={14} />} disabled={sorted.length < 2 || busy} onClick={renumber} data-testid="renumber-access">Renumber</Button>
          <Button leftSection={<IconPlus size={14} />} onClick={() => setEditor({ mode: "create", rule: null })} data-testid="create-access">Add Rule…</Button>
        </>}
      />
      <div onKeyDown={onTableKey}>
        <DataTable
          testId="access-table"
          aria-label="Access rules"
          data={q.data ? sorted : undefined}
          loading={q.isLoading || q.isFetching}
          error={q.error}
          onRetry={() => void q.refetch()}
          rowKey={(a) => a.Id_u32}
          rowTestId={(a) => `access-row-${a.Id_u32}`}
          selectable="multi"
          selection={selection}
          onSelectionChange={(k) => setSelection(k)}
          initialSort={{ key: "Priority_u32", dir: "asc" }}
          onRowOpen={(a) => setEditor({ mode: "edit", rule: a })}
          contextMenu={menu}
          rowTone={(a) => (a.Active_bool ? undefined : "dim")}
          searchPlaceholder="Filter rules"
          empty={{
            title: "No access rules",
            description: "Every packet passes. Add a rule to discard or allow traffic by address, port, protocol or user.",
            icon: <IconFilter size={28} stroke={1.4} />,
            action: <Button size="xs" variant="default" onClick={() => setEditor({ mode: "create", rule: null })}>Add Rule…</Button>,
          }}
          toolbar={<>
            {selectedRules.length > 1 && (
              <Button size="xs" variant="default" c="var(--sem-red)" leftSection={<IconTrash size={13} />} onClick={() => void deleteRules(selectedRules)} data-testid="bulk-delete-access">
                Delete {selectedRules.length} Rules…
              </Button>
            )}
            <ToolbarGroup label="Order">
              <ToolbarButton icon={<IconArrowUp size={15} />} label="Move Up" disabled={!single || singleIdx <= 0 || busy} onClick={() => single && move(single, -1)} testId="access-move-up" />
              <ToolbarButton icon={<IconArrowDown size={15} />} label="Move Down" disabled={!single || singleIdx >= sorted.length - 1 || busy} onClick={() => single && move(single, 1)} testId="access-move-down" />
            </ToolbarGroup>
          </>}
          columns={[
            { key: "Priority_u32", title: "Priority", align: "right", width: 72, render: (a) => <span className="sem-num">{a.Priority_u32}</span> },
            {
              key: "Active_bool", title: "On", width: 52, align: "center",
              render: (a) => (
                <span onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} style={{ display: "inline-flex" }}>
                  <Switch size="xs" checked={a.Active_bool} disabled={busy} aria-label={`Rule ${a.Id_u32} enabled`}
                    onChange={(e) => toggle(a.Id_u32, e.currentTarget.checked)} data-testid={`toggle-access-${a.Id_u32}`} />
                </span>
              ),
            },
            {
              key: "Discard_bool", title: "Action", width: 86, value: (a) => (a.Discard_bool ? "Discard" : "Pass"),
              render: (a) => <Tag color={!a.Active_bool ? "gray" : a.Discard_bool ? "red" : "green"}>{a.Discard_bool ? "Discard" : "Pass"}</Tag>,
            },
            {
              key: "Note_utf", title: "Note", width: "22%", truncate: true,
              render: (a) => (a.Note_utf ? <span className="sem-strong" title={a.Note_utf}>{a.Note_utf}</span> : <span className="sem-dim">–</span>),
            },
            {
              key: "service", title: "Service", width: 100, value: (a) => `${service(a)} ${a.IsIPv6_bool ? "IPv6" : "IPv4"}`,
              render: (a) => <span title={a.IsIPv6_bool ? "IPv6 rule" : "IPv4 rule"}>{service(a)}{a.IsIPv6_bool && <span className="sem-dim"> · v6</span>}</span>,
            },
            { key: "src", title: "Source", width: "20%", truncate: true, value: (a) => endpoint(a, "src"), render: (a) => <Endpoint text={endpoint(a, "src")} /> },
            { key: "dst", title: "Destination", width: "20%", truncate: true, value: (a) => endpoint(a, "dst", false), render: (a) => <Endpoint text={endpoint(a, "dst", false)} /> },
            {
              key: "extras", title: "Options", sortable: false, truncate: true, width: "13%", value: (a) => extras(a).join(" "),
              render: (a) => { const x = extras(a); return x.length ? <span className="sem-dim" title={x.join(" · ")}>{x.join(" · ")}</span> : null; },
            },
          ]}
        />
      </div>
      <RuleSheet opened={!!editor} onClose={() => setEditor(null)} initial={editor?.rule ?? null} mode={editor?.mode ?? "create"}
        onSave={save} saving={add.isPending || setList.isPending} nextPriority={nextPriority} />
    </>
  );
}

function Endpoint({ text }: { text: string }) {
  if (text === "any") return <span className="hpn-ep-any">Any</span>;
  return <span className="sem-mono" title={text}>{text}</span>;
}
