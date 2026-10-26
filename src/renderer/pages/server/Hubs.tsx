// Server › Virtual Hubs. Like Server Manager's main window: a table of hubs with Manage / Online / Offline /
// Delete acting on the selected hub, plus a "New Virtual Hub" sheet.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button, Checkbox, NumberInput, PasswordInput, SegmentedControl, Switch, TextInput } from "@mantine/core";
import {
  IconCopy, IconExternalLink, IconPlayerPause, IconPlayerPlay, IconPlus, IconSettings, IconStack2, IconTrash,
} from "@tabler/icons-react";
import { rpc } from "../../lib/api";
import { notifyError, notifySuccess, useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import { agoShort, bytes, dt, num, plural, trafficOf } from "../../lib/format";
import type { HubListItem } from "../../lib/types";
import { hubBase } from "../../sections";
import { DataTable, FormRow, FormSection, Mono, PageHeader, StatusBadge, Tag, confirmAction, type RowKey } from "../../design";
import { HUB_TYPE_LABELS } from "../../components/domain/util";
import { Callout } from "../../components/domain/ui";
import { FormSheet, Unreachable, copyText, useServerPage } from "./_server-network/shared";

const HUB_TYPES = [
  { value: "0", label: "Standalone" },
  { value: "1", label: "Static" },
  { value: "2", label: "Dynamic" },
];

/**
 * CreateHub refuses names that fail Mayaqua's IsSafeStr (error 38, "invalid parameter"): only ASCII letters, digits,
 * space and ( ) - _ # % & . are allowed, with no leading or trailing space. MAX_HUBNAME_LEN is 255.
 */
const SAFE = /^[A-Za-z0-9 ()\-_#%&.]+$/;

function hubNameError(name: string, existing: string[]): string | null {
  const n = name.trim();
  if (!n) return null;
  if (n.length > 255) return "Use at most 255 characters.";
  if (!SAFE.test(n)) return "Use only letters, digits, spaces and ( ) - _ # % & . characters.";
  if (existing.some((e) => e.toLowerCase() === n.toLowerCase())) return `There’s already a hub named “${n}”.`;
  return null;
}

export default function HubsPage() {
  const { serverId } = useScope();
  const nav = useNavigate();
  const { s, hubMode, reachable, live } = useServerPage(serverId);
  const hubs = useRpc<{ HubList?: HubListItem[] }>(serverId, "EnumHub", {}, { refetchInterval: 10_000, enabled: live });
  const farm = useRpc<{ ServerType_u32?: number }>(serverId, "GetFarmSetting", {}, { enabled: live && !hubMode, staleTime: 60_000 });
  const setOnline = useRpcMutation<{ HubName_str: string; Online_bool: boolean }>(serverId, "SetHubOnline", {
    success: false,
    onSuccess: (_r, p) => notifySuccess(p.Online_bool ? `“${p.HubName_str}” is online` : `“${p.HubName_str}” is offline`),
  });
  const del = useRpcMutation<{ HubName_str: string }>(serverId, "DeleteHub", { success: "Virtual Hub deleted" }); // danger: typed name
  const [creating, setCreating] = useState(false);
  const [sel, setSel] = useState<RowKey[]>([]);

  const list = useMemo(() => hubs.data?.HubList ?? [], [hubs.data]);
  const selected = list.find((h) => h.HubName_str === sel[0]);
  const clustered = (farm.data?.ServerType_u32 ?? 0) !== 0 || list.some((h) => h.HubType_u32 !== 0);
  const online = list.filter((h) => h.Online_bool).length;
  const sessions = list.reduce((a, h) => a + h.NumSessions_u32, 0);
  const open = (h: HubListItem) => nav(hubBase(serverId, h.HubName_str));
  const toggle = async (h: HubListItem) => {
    // Going offline drops every session on the hub: ask first. Going online is harmless.
    if (h.Online_bool && !(await confirmAction({
      title: <>Take “{h.HubName_str}” offline?</>,
      message: "Every session on this hub is disconnected, and new connections are refused until you bring it online again.",
      confirmLabel: "Take Offline", tone: "warning", testId: "hub-offline",
    }))) return;
    setOnline.mutate({ HubName_str: h.HubName_str, Online_bool: !h.Online_bool });
  };

  if (!s) return null;
  return (
    <>
      <PageHeader
        title="Virtual Hubs"
        meta={hubs.data ? <>{plural(list.length, "hub")} · {num(online)} online · {plural(sessions, "session")}</> : undefined}
        description="Each Virtual Hub is an isolated virtual Ethernet segment with its own users, policies and security settings."
        actions={!hubMode && reachable && (
          <Button leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="hub-create">New Virtual Hub…</Button>
        )}
      />
      {!reachable ? <Unreachable serverId={serverId} /> : (
        <>
          {hubMode && (
            <div className="sem-callouts" style={{ marginBottom: "var(--sem-space-5)" }}>
              <Callout tone="purple" icon={<IconStack2 size={16} stroke={1.7} />}>
                Connected as the administrator of <b>{s.hub}</b>: other hubs aren’t listed, and hubs can’t be created or deleted.
              </Callout>
            </div>
          )}
          <DataTable
            testId="hubs-table"
            aria-label="Virtual Hubs"
            data={hubs.data ? list : undefined}
            loading={hubs.isLoading || hubs.isFetching}
            error={hubs.error}
            onRetry={() => void hubs.refetch()}
            rowKey={(h) => h.HubName_str}
            rowTestId={(h) => `hub-row-${h.HubName_str}`}
            selectable="single"
            selection={sel}
            onSelectionChange={(k) => setSel(k)}
            initialSort={{ key: "HubName_str", dir: "asc" }}
            searchable={list.length > 6}
            searchPlaceholder="Filter Hubs"
            onRowOpen={open}
            rowTone={(h) => (h.Online_bool ? undefined : "dim")}
            empty={{
              title: "No Virtual Hubs",
              description: "Create a hub to start accepting VPN connections.",
              icon: <IconStack2 size={28} stroke={1.4} />,
              action: !hubMode ? <Button size="xs" variant="default" leftSection={<IconPlus size={13} />} onClick={() => setCreating(true)}>New Virtual Hub…</Button> : undefined,
            }}
            toolbar={(
              <div className="sem-row-inline" style={{ gap: "var(--sem-space-3)" }}>
                <Button size="xs" variant="default" leftSection={<IconExternalLink size={13} />} disabled={!selected} onClick={() => selected && open(selected)} data-testid="hub-open">Manage</Button>
                <Button size="xs" variant="default" disabled={!selected || setOnline.isPending}
                  leftSection={selected && !selected.Online_bool ? <IconPlayerPlay size={13} /> : <IconPlayerPause size={13} />}
                  onClick={() => selected && void toggle(selected)} data-testid="hub-toggle-online">
                  {selected && !selected.Online_bool ? "Bring Online" : "Take Offline"}
                </Button>
                {!hubMode && (
                  <Button size="xs" variant="default" c={selected ? "var(--sem-red)" : undefined} leftSection={<IconTrash size={13} />} disabled={!selected}
                    onClick={() => selected && del.mutate({ HubName_str: selected.HubName_str })} data-testid="hub-delete">Delete…</Button>
                )}
              </div>
            )}
            contextMenu={(h) => [
              { label: "Manage Hub", icon: <IconExternalLink size={14} />, onClick: () => open(h), shortcut: "↩" },
              { label: "Properties…", icon: <IconSettings size={14} />, onClick: () => nav(`${hubBase(serverId, h.HubName_str)}/settings`) },
              "divider",
              h.Online_bool
                ? { label: "Take Offline", icon: <IconPlayerPause size={14} />, onClick: () => void toggle(h), testId: "hub-menu-offline" }
                : { label: "Bring Online", icon: <IconPlayerPlay size={14} />, onClick: () => void toggle(h), testId: "hub-menu-online" },
              { label: "Copy Name", icon: <IconCopy size={14} />, onClick: () => void copyText(h.HubName_str, "Hub name copied") },
              "divider",
              { label: "Delete Hub…", icon: <IconTrash size={14} />, danger: true, disabled: hubMode, onClick: () => del.mutate({ HubName_str: h.HubName_str }), testId: "hub-menu-delete" },
            ]}
            columns={[
              { key: "HubName_str", title: "Name", truncate: true, render: (h) => <span className="sem-strong" title={h.HubName_str}>{h.HubName_str}</span> },
              {
                key: "Online_bool", title: "Status", width: 92,
                render: (h) => <StatusBadge status={h.Online_bool ? "ok" : "off"}>{h.Online_bool ? "Online" : "Offline"}</StatusBadge>,
              },
              ...(clustered ? [{
                key: "HubType_u32", title: "Type", width: 96,
                value: (h: HubListItem) => HUB_TYPE_LABELS[h.HubType_u32] ?? String(h.HubType_u32),
                render: (h: HubListItem) => <Tag color={h.HubType_u32 ? "purple" : "gray"}>{HUB_TYPES[h.HubType_u32]?.label ?? h.HubType_u32}</Tag>,
              }] : []),
              { key: "NumUsers_u32", title: "Users", align: "right", width: 66, render: (h) => num(h.NumUsers_u32) },
              { key: "NumGroups_u32", title: "Groups", align: "right", width: 70, render: (h) => num(h.NumGroups_u32) },
              { key: "NumSessions_u32", title: "Sessions", align: "right", width: 80, render: (h) => num(h.NumSessions_u32) },
              {
                key: "tables", title: "MAC / IP", align: "right", width: 84,
                value: (h) => h.NumMacTables_u32 + h.NumIpTables_u32,
                render: (h) => <span className="sem-num" title="Learned MAC addresses / IP addresses">{num(h.NumMacTables_u32)} / {num(h.NumIpTables_u32)}</span>,
              },
              {
                key: "traffic", title: "Received / Sent", align: "right", width: 150,
                value: (h) => { const t = trafficOf(h, "Ex."); return t.recv + t.send; },
                render: (h) => { const t = trafficOf(h, "Ex."); return <span className="sem-num">{bytes(t.recv)} / {bytes(t.send)}</span>; },
              },
              {
                key: "LastCommTime_dt", title: "Last activity", width: 108,
                render: (h) => <span className="sem-dim" title={dt(h.LastCommTime_dt)}>{agoShort(h.LastCommTime_dt)}</span>,
              },
            ]}
          />
        </>
      )}
      <CreateHubSheet
        serverId={serverId} opened={creating} onClose={() => setCreating(false)} clustered={clustered}
        existing={list.map((h) => h.HubName_str)}
        onCreated={(name) => nav(hubBase(serverId, name))}
      />
    </>
  );
}

function CreateHubSheet({ serverId, opened, onClose, onCreated, clustered, existing }: {
  serverId: number; opened: boolean; onClose: () => void; onCreated: (name: string) => void; clustered: boolean; existing: string[];
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [maxSession, setMaxSession] = useState<number | string>(0);
  const [online, setOnline] = useState(true);
  const [noEnum, setNoEnum] = useState(false);
  const [type, setType] = useState("0");
  const [openAfter, setOpenAfter] = useState(true);
  const create = useRpcMutation(serverId, "CreateHub", { success: false });
  const setHub = useRpcMutation(serverId, "SetHub", { success: false, confirm: false });
  const busy = create.isPending || setHub.isPending;
  const reset = () => { setName(""); setPassword(""); setConfirm(""); setMaxSession(0); setOnline(true); setNoEnum(false); setType("0"); };
  const close = () => { reset(); onClose(); };

  const n = name.trim();
  const nameErr = hubNameError(name, existing);
  const pwErr = password && confirm && password !== confirm ? "The passwords don’t match." : null;
  const ms = Number(maxSession);
  const msErr = !Number.isInteger(ms) || ms < 0 ? "Enter 0 or a positive whole number." : null;
  const valid = !!n && !nameErr && !pwErr && (!password || password === confirm) && !msErr;

  const submit = async () => {
    try {
      await create.mutateAsync({
        HubName_str: n, AdminPasswordPlainText_str: password, Online_bool: online, MaxSession_u32: ms, NoEnum_bool: noEnum,
        HubType_u32: clustered ? Number(type) : 0,
      });
    } catch { return; /* toasted by the hook */ }
    if (ms > 0) {
      // SoftEther quirk: CreateHub resets the hub options to their defaults, so MaxSession is lost (always 0).
      // Apply the limit with SetHub, sending back what GetHub returns (zero password hashes keep the password).
      try {
        const cur = await rpc<Record<string, unknown>>(serverId, "GetHub", { HubName_str: n });
        await setHub.mutateAsync({ ...cur, AdminPasswordPlainText_str: "", MaxSession_u32: ms });
      } catch (e) {
        notifyError(e, `“${n}” was created, but its session limit couldn’t be set`);
      }
    }
    notifySuccess("Virtual Hub created");
    const go = openAfter;
    close();
    if (go) onCreated(n);
  };

  return (
    <FormSheet
      opened={opened} onClose={close} busy={busy}
      title="New Virtual Hub" subtitle="Creates an isolated virtual Ethernet segment on this server."
      icon={<IconStack2 size={19} stroke={1.5} />}
      submitLabel="Create Hub" submitTestId="hub-create-submit" testId="hub-create-sheet" valid={valid}
      note={<Checkbox size="xs" label="Open the hub after creating it" checked={openAfter} onChange={(e) => setOpenAfter(e.currentTarget.checked)} />}
      onSubmit={() => void submit()}
    >
      <FormSection>
        <FormRow label="Name" description="Letters, digits, hyphens and underscores work with every client. Not case-sensitive." error={nameErr}>
          {(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus autoComplete="off" spellCheck={false}
            placeholder="SALES" error={!!nameErr} data-testid="hub-name" />}
        </FormRow>
        {clustered && (
          <FormRow label="Type" description="Static hubs exist on every cluster member; dynamic hubs only where sessions are.">
            <SegmentedControl data={HUB_TYPES} value={type} onChange={setType} aria-label="Hub type" data-testid="hub-type" />
          </FormRow>
        )}
        <FormRow label="Online" description="An offline hub refuses connections.">
          <Switch checked={online} onChange={(e) => setOnline(e.currentTarget.checked)} aria-label="Online" data-testid="hub-online" />
        </FormRow>
      </FormSection>

      <FormSection title="Hub administrator" description="Optional. With this password someone can manage just this hub, for example with Server Manager in hub admin mode.">
        <FormRow label="Password">
          {(id) => <PasswordInput id={id} value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="new-password" data-testid="hub-password" />}
        </FormRow>
        <FormRow label="Confirm password" error={pwErr}>
          {(id) => <PasswordInput id={id} value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} autoComplete="new-password" disabled={!password}
            error={!!pwErr} data-testid="hub-password-confirm" />}
        </FormRow>
      </FormSection>

      <FormSection title="Limits">
        <FormRow label="Maximum sessions" description="0 means no limit." error={msErr}>
          {(id) => <NumberInput id={id} w={130} min={0} allowDecimal={false} allowNegative={false} value={maxSession} onChange={setMaxSession} data-testid="hub-max-sessions" />}
        </FormRow>
        <FormRow label="Hide from hub list" description="Clients that list hubs on this server won’t see it (NoEnum). They can still connect by name.">
          <Switch checked={noEnum} onChange={(e) => setNoEnum(e.currentTarget.checked)} aria-label="Hide from hub list" data-testid="hub-noenum" />
        </FormRow>
      </FormSection>
      {n && !nameErr && <p className="sem-form-section-footer">The hub will be created as <Mono>{n}</Mono>.</p>}
    </FormSheet>
  );
}
