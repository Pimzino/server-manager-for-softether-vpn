// Server › Listeners & Ports: TCP listeners (EnumListener/CreateListener/EnableListener/DeleteListener),
// the UDP port list (GetPortsUDP/SetPortsUDP) and VPN over ICMP / DNS (Get/SetSpecialListener).
import { useEffect, useMemo, useState } from "react";
import { Button, NumberInput, Switch, TagsInput } from "@mantine/core";
import { IconAlertTriangle, IconPlayerPause, IconPlayerPlay, IconPlugConnected, IconPlus, IconTrash } from "@tabler/icons-react";
// useRpcMutation's toast is a fixed string; these RPCs put the port in theirs.
import { notifySuccess as notify, useCaps, useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import {
  DataTable, ErrorState, FormRow, FormSection, PageHeader, PropertySkeleton, QueryState, Section, StatusBadge, Tag, confirmAction, isConfirmCancelled, type RowKey,
} from "../../design";
import { Callout } from "../../components/domain/ui";
import { ApplyBar, FormSheet, Unreachable, useServerPage } from "./_server-network/shared";

interface ListenerItem { Ports_u32: number; Enables_bool: boolean; Errors_bool: boolean }

const WELL_KNOWN: Record<number, string> = {
  443: "HTTPS: also serves SSTP and OpenVPN over TCP",
  992: "SoftEther default (TLS)",
  1194: "OpenVPN default",
  5555: "SoftEther default",
  8888: "SoftEther alternative",
};

export default function ListenersPage() {
  const { serverId } = useScope();
  const { s, reachable, live } = useServerPage(serverId);
  const caps = useCaps(serverId);
  if (!s) return null;
  const capOk = (n: string) => caps.isLoading || !!caps.error || caps.has(n);
  return (
    <>
      <PageHeader
        title="Listeners & Ports"
        meta={<>This connection uses TCP port <span className="sem-num">{s.port}</span></>}
        description="The TCP ports the server accepts VPN and management connections on, its UDP ports and the emergency VPN over ICMP and DNS listeners."
      />
      {!reachable ? <Unreachable serverId={serverId} /> : (
        <>
          <TcpListeners serverId={serverId} mgmtPort={s.port} live={live} />
          <UdpPorts serverId={serverId} live={live} />
          <SpecialListeners serverId={serverId} live={live} supported={capOk("b_support_special_listener")} />
        </>
      )}
    </>
  );
}

function TcpListeners({ serverId, mgmtPort, live }: { serverId: number; mgmtPort: number; live: boolean }) {
  const list = useRpc<{ ListenerList?: ListenerItem[] }>(serverId, "EnumListener", {}, { refetchInterval: 15_000, enabled: live });
  const enable = useRpcMutation<{ Port_u32: number; Enable_bool: boolean }>(serverId, "EnableListener", {
    success: false, onSuccess: (_r, p) => notify(p.Enable_bool ? `Listening on port ${p.Port_u32}` : `Stopped listening on port ${p.Port_u32}`),
  });
  const rows = useMemo(() => list.data?.ListenerList ?? [], [list.data]);
  const activeCount = rows.filter((l) => l.Enables_bool).length;
  // DeleteListener is a "danger" RPC; this adds the "last active listener" case to the built-in wording.
  const del = useRpcMutation<{ Port_u32: number }>(serverId, "DeleteListener", {
    success: "TCP listener deleted",
    confirm: (p) => {
      const isMgmt = p.Port_u32 === mgmtPort;
      // Only an active listener can be the "last active" one; deleting a stopped listener changes nothing live.
      const target = rows.find((l) => l.Ports_u32 === p.Port_u32);
      const last = !!target?.Enables_bool && rows.filter((l) => l.Enables_bool && l.Ports_u32 !== p.Port_u32).length === 0;
      return {
        title: <>Delete the listener on port {p.Port_u32}?</>,
        message: isMgmt
          ? <>This app manages the server through port {p.Port_u32}. Deleting it disconnects this app; you’ll have to change the connection’s port to another listener.</>
          : last ? <>This is the server’s last active listener: no client or manager could connect over TCP any more.</>
          : "Clients and managers that connect on this port are refused.",
        confirmLabel: "Delete Listener",
        typeToConfirm: isMgmt || last ? String(p.Port_u32) : undefined,
        testId: "listener-delete",
      };
    },
  });
  const [creating, setCreating] = useState(false);
  const [sel, setSel] = useState<RowKey[]>([]);
  const selected = rows.find((l) => l.Ports_u32 === sel[0]);
  const errored = rows.filter((l) => l.Enables_bool && l.Errors_bool);

  const setEnabled = async (l: ListenerItem, on: boolean) => {
    if (!on) {
      const isMgmt = l.Ports_u32 === mgmtPort;
      const last = activeCount === 1 && l.Enables_bool;
      const ok = await confirmAction({
        title: <>Stop listening on port {l.Ports_u32}?</>,
        message: isMgmt
          ? <>This app manages the server through port {l.Ports_u32}. Stopping it cuts this app off until the listener is started again from another manager.</>
          : <>The server stops accepting new connections on TCP port {l.Ports_u32}, and clients connected through it are disconnected.{last && <> <b>This is the last active listener.</b></>}</>,
        confirmLabel: "Stop Listener",
        tone: isMgmt || last ? "danger" : "warning",
        typeToConfirm: isMgmt || last ? String(l.Ports_u32) : undefined,
        testId: "listener-stop",
      });
      if (!ok) return;
    }
    enable.mutate({ Port_u32: l.Ports_u32, Enable_bool: on });
  };

  return (
    <Section
      title="TCP listeners"
      description="SoftEther VPN, SSTP, OpenVPN over TCP and management connections all arrive on these ports."
    >
      {errored.length > 0 && (
        <div className="sem-callouts" style={{ marginTop: 0, marginBottom: "var(--sem-space-4)" }}>
          <Callout tone="orange" title={`Can’t listen on ${errored.length > 1 ? "ports" : "port"} ${errored.map((l) => l.Ports_u32).join(", ")}`} testId="listener-error">
            Another program may be using {errored.length > 1 ? "them" : "it"}, or the server lacks the privilege to open ports below 1024.
          </Callout>
        </div>
      )}
      <DataTable
        testId="listeners-table"
        aria-label="TCP listeners"
        data={list.data ? rows : undefined}
        loading={list.isLoading || list.isFetching}
        error={list.error}
        onRetry={() => void list.refetch()}
        rowKey={(l) => l.Ports_u32}
        rowTestId={(l) => `listener-row-${l.Ports_u32}`}
        searchable={false}
        footer={rows.length > 8}
        selectable="single"
        selection={sel}
        onSelectionChange={(k) => setSel(k)}
        rowTone={(l) => (l.Enables_bool ? undefined : "dim")}
        initialSort={{ key: "Ports_u32", dir: "asc" }}
        empty={{ title: "No TCP listeners", description: "Nothing can connect to the server over TCP. Add a listener.", icon: <IconPlugConnected size={28} stroke={1.4} /> }}
        toolbar={(
          <div className="sem-row-inline" style={{ gap: "var(--sem-space-3)" }}>
            <Button size="xs" variant="default" leftSection={selected && !selected.Enables_bool ? <IconPlayerPlay size={13} /> : <IconPlayerPause size={13} />}
              disabled={!selected || enable.isPending} onClick={() => selected && void setEnabled(selected, !selected.Enables_bool)} data-testid="listener-toggle">
              {selected && !selected.Enables_bool ? "Start" : "Stop"}
            </Button>
            <Button size="xs" variant="default" c={selected ? "var(--sem-red)" : undefined} leftSection={<IconTrash size={13} />} disabled={!selected}
              onClick={() => selected && del.mutate({ Port_u32: selected.Ports_u32 })} data-testid="listener-delete">Delete…</Button>
            <Button size="xs" variant="default" leftSection={<IconPlus size={13} />} onClick={() => setCreating(true)} data-testid="create-listener">Add Listener…</Button>
          </div>
        )}
        contextMenu={(l) => [
          l.Enables_bool
            ? { label: "Stop Listening", icon: <IconPlayerPause size={14} />, onClick: () => void setEnabled(l, false), testId: "listener-menu-stop" }
            : { label: "Start Listening", icon: <IconPlayerPlay size={14} />, onClick: () => void setEnabled(l, true), testId: "listener-menu-start" },
          "divider",
          { label: "Delete Listener…", icon: <IconTrash size={14} />, danger: true, onClick: () => del.mutate({ Port_u32: l.Ports_u32 }), testId: "listener-menu-delete" },
        ]}
        columns={[
          {
            key: "Ports_u32", title: "Port", width: 190,
            render: (l) => (
              <span className="sem-row-inline" style={{ flexWrap: "nowrap" }}>
                <span className="sem-strong sem-num">{l.Ports_u32}</span>
                {l.Ports_u32 === mgmtPort && <Tag color="purple" title="This app connects to the server through this port">This connection</Tag>}
              </span>
            ),
          },
          {
            key: "state", title: "Status", width: 120, value: (l) => (l.Enables_bool ? (l.Errors_bool ? 1 : 2) : 0),
            render: (l) => !l.Enables_bool ? <StatusBadge status="off">Stopped</StatusBadge>
              : l.Errors_bool ? <StatusBadge status="error" tooltip="Enabled, but the server couldn’t open the port">Error</StatusBadge>
              : <StatusBadge status="ok">Listening</StatusBadge>,
          },
          { key: "note", title: "Typical use", sortable: false, render: (l) => <span className="sem-dim">{WELL_KNOWN[l.Ports_u32] ?? "Custom port"}</span> },
        ]}
      />
      <CreateListenerSheet serverId={serverId} opened={creating} onClose={() => setCreating(false)} existing={rows.map((l) => l.Ports_u32)}
        onCreated={(p) => setSel([p])} />
    </Section>
  );
}

function CreateListenerSheet({ serverId, opened, onClose, existing, onCreated }: {
  serverId: number; opened: boolean; onClose: () => void; existing: number[]; onCreated: (port: number) => void;
}) {
  const [port, setPort] = useState<number | string>("");
  const [enable, setEnable] = useState(true);
  const create = useRpcMutation(serverId, "CreateListener", {
    success: false,
    onSuccess: (_r, p) => { notify(`Listener on port ${p.Port_u32} created`); onCreated(Number(p.Port_u32)); onClose(); },
  });
  useEffect(() => { if (opened) { setPort(""); setEnable(true); } }, [opened]);
  const p = Number(port);
  const err = port === "" ? null : !Number.isInteger(p) || p < 1 || p > 65535 ? "Enter a port from 1 to 65535."
    : existing.includes(p) ? `There’s already a listener on port ${p}.` : null;
  return (
    <FormSheet
      opened={opened} onClose={onClose} busy={create.isPending} size={500}
      title="New TCP Listener" subtitle="The server starts accepting VPN and management connections on this port."
      icon={<IconPlugConnected size={19} stroke={1.5} />}
      submitLabel="Add Listener" submitTestId="listener-create-submit" testId="listener-create-sheet"
      valid={port !== "" && !err}
      onSubmit={() => create.mutate({ Port_u32: p, Enable_bool: enable })}
    >
      <FormSection>
        <FormRow label="TCP port" error={err}>
          {(id) => <NumberInput id={id} w={130} min={1} max={65535} allowDecimal={false} allowNegative={false} value={port} onChange={setPort}
            placeholder="443" error={!!err} data-autofocus data-testid="listener-port" />}
        </FormRow>
        <FormRow label="Start listening now" description="Otherwise the listener is added stopped.">
          <Switch checked={enable} onChange={(e) => setEnable(e.currentTarget.checked)} aria-label="Start listening now" data-testid="listener-enable" />
        </FormRow>
      </FormSection>
      <p className="sem-form-section-footer">Make sure no other program on the host uses this port, and that its firewall allows inbound TCP on it.</p>
    </FormSheet>
  );
}

function UdpPorts({ serverId, live }: { serverId: number; live: boolean }) {
  const q = useRpc<{ Ports_u32?: number[] }>(serverId, "GetPortsUDP", {}, { enabled: live });
  const current = useMemo(() => [...new Set(q.data?.Ports_u32 ?? [])].sort((a, b) => a - b), [q.data]);
  const [value, setValue] = useState<string[]>([]);
  const key = current.join(",");
  useEffect(() => { if (q.data) setValue(current.map(String)); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalid = value.filter((v) => !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535);
  const nums = [...new Set(value.filter((v) => !invalid.includes(v)).map(Number))].sort((a, b) => a - b);
  const added = nums.filter((p) => !current.includes(p));
  const removed = current.filter((p) => !nums.includes(p));
  const dirty = added.length > 0 || removed.length > 0;
  // SetPortsUDP is "danger": confirmed by the hook, with the resulting list spelled out.
  const save = useRpcMutation<{ Ports_u32: number[] }>(serverId, "SetPortsUDP", {
    success: "UDP ports updated",
    confirm: (p) => ({
      title: "Change the UDP ports?",
      message: p.Ports_u32.length
        ? <>The server will listen on UDP {p.Ports_u32.length > 1 ? "ports" : "port"} <b>{p.Ports_u32.join(", ")}</b>.{removed.length > 0 && <> Clients using port {removed.join(", ")} over UDP are disconnected.</>}</>
        : <>The server will stop listening on UDP. <b>OpenVPN over UDP, WireGuard and other UDP protocols stop working.</b></>,
      confirmLabel: "Change Ports", tone: "warning", testId: "udp-save",
    }),
  });

  return (
    <Section title="UDP ports" description="Ports used by UDP protocols such as OpenVPN over UDP and WireGuard. Applying replaces the whole list.">
      <QueryState query={q} inline skeleton={<PropertySkeleton rows={1} />}>
        <FormSection>
          <FormRow label="Listening UDP ports" description="Type a port and press Return. Range 1–65535." align="start"
            error={invalid.length ? `Not a valid port: ${invalid.join(", ")}` : undefined}>
            {(id) => (
              <TagsInput
                id={id} value={value} onChange={(v) => setValue(v.map((x) => x.trim()).filter(Boolean))}
                splitChars={[",", " ", ";"]} clearable placeholder={value.length ? "Add port" : "No UDP ports"} error={invalid.length > 0}
                aria-label="Listening UDP ports" data-testid="udp-ports-input"
              />
            )}
          </FormRow>
        </FormSection>
        {value.length === 0 && current.length > 0 && (
          <div className="sem-callouts" style={{ marginTop: "var(--sem-space-3)" }}>
            <Callout tone="orange">An empty list stops every UDP protocol (OpenVPN over UDP, WireGuard…).</Callout>
          </div>
        )}
        {save.error && !isConfirmCancelled(save.error) && <div style={{ marginTop: "var(--sem-space-4)" }}><ErrorState error={save.error} inline testId="udp-save-error" /></div>}
        <ApplyBar
          dirty={dirty} valid={!invalid.length} saving={save.isPending} testId="udp-save"
          note={<>{added.length > 0 && <>Add {added.join(", ")}</>}{added.length > 0 && removed.length > 0 && " · "}{removed.length > 0 && <>Remove {removed.join(", ")}</>}</>}
          onRevert={() => setValue(current.map(String))}
          onApply={() => save.mutate({ Ports_u32: nums })}
        />
      </QueryState>
    </Section>
  );
}

function SpecialListeners({ serverId, live, supported }: { serverId: number; live: boolean; supported: boolean }) {
  const q = useRpc<{ VpnOverIcmpListener_bool: boolean; VpnOverDnsListener_bool: boolean }>(serverId, "GetSpecialListener", {}, { enabled: live });
  const [icmp, setIcmp] = useState(false);
  const [dns, setDns] = useState(false);
  const revert = () => { setIcmp(!!q.data?.VpnOverIcmpListener_bool); setDns(!!q.data?.VpnOverDnsListener_bool); };
  useEffect(revert, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!q.data && (icmp !== !!q.data.VpnOverIcmpListener_bool || dns !== !!q.data.VpnOverDnsListener_bool);
  const on = (b: boolean) => (b ? "on" : "off");
  const save = useRpcMutation<{ VpnOverIcmpListener_bool: boolean; VpnOverDnsListener_bool: boolean }>(serverId, "SetSpecialListener", {
    success: "VPN over ICMP and DNS updated",
    confirm: (p) => ({
      title: "Change VPN over ICMP and DNS?",
      message: <>VPN over ICMP will be <b>{on(p.VpnOverIcmpListener_bool)}</b> and VPN over DNS <b>{on(p.VpnOverDnsListener_bool)}</b>.
        {(!p.VpnOverIcmpListener_bool && q.data?.VpnOverIcmpListener_bool) || (!p.VpnOverDnsListener_bool && q.data?.VpnOverDnsListener_bool)
          ? " Clients using a listener you turn off are disconnected." : ""}</>,
      confirmLabel: "Apply", tone: "warning", testId: "special-save",
    }),
  });

  return (
    <Section title="VPN over ICMP and DNS" description="Let clients reach the server with only ping (ICMP) or DNS packets when a firewall blocks everything else.">
      {!supported && (
        <div className="sem-callouts" style={{ marginTop: 0, marginBottom: "var(--sem-space-4)" }}>
          <Callout tone="gray">This server doesn’t report support for VPN over ICMP and DNS.</Callout>
        </div>
      )}
      <QueryState query={q} inline skeleton={<PropertySkeleton rows={2} />}>
        <FormSection footer={<span className="sem-row-inline" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
          <IconAlertTriangle size={13} stroke={1.8} style={{ flex: "none", marginTop: 2, color: "var(--sem-orange)" }} />
          <span>For emergencies only, such as a misconfigured firewall that lets only ping or DNS through. Not meant for long-term use.</span>
        </span>}>
          <FormRow label="VPN over ICMP" description="Accept VPN connections carried in ICMP echo packets.">
            <Switch checked={icmp} onChange={(e) => setIcmp(e.currentTarget.checked)} aria-label="VPN over ICMP" data-testid="special-icmp" />
          </FormRow>
          <FormRow label="VPN over DNS" description="Accept VPN connections carried in DNS queries. The server listens on UDP port 53.">
            <Switch checked={dns} onChange={(e) => setDns(e.currentTarget.checked)} aria-label="VPN over DNS" data-testid="special-dns" />
          </FormRow>
        </FormSection>
        {save.error && !isConfirmCancelled(save.error) && <div style={{ marginTop: "var(--sem-space-4)" }}><ErrorState error={save.error} inline testId="special-save-error" /></div>}
        <ApplyBar dirty={dirty} saving={save.isPending} testId="special-save" onRevert={() => { save.reset(); revert(); }}
          onApply={() => save.mutate({ VpnOverIcmpListener_bool: icmp, VpnOverDnsListener_bool: dns })} />
      </QueryState>
    </Section>
  );
}

