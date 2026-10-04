import { useEffect, useState } from "react";
import { Alert, Badge, Button, Group, Modal, NumberInput, Stack, Switch, TagsInput, Text, Tooltip } from "@mantine/core";
import { IconAlertTriangle, IconDeviceFloppy, IconPlus, IconTrash } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, ErrorAlert, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { can, useCaps, useRpc, useRpcMutation, useScope, useServer } from "../../lib/hooks";

interface ListenerItem { Ports_u32: number; Enables_bool: boolean; Errors_bool: boolean }

const WELL_KNOWN: Record<number, string> = {
  443: "HTTPS / SSTP / OpenVPN-TCP compatible",
  992: "SoftEther default (TLS)",
  1194: "OpenVPN default",
  5555: "SoftEther default",
  8888: "SoftEther alternative",
};

function CreateListenerModal({ serverId, opened, onClose, existing }: { serverId: number; opened: boolean; onClose: () => void; existing: number[] }) {
  const [port, setPort] = useState<number | string>("");
  const [enable, setEnable] = useState(true);
  const create = useRpcMutation(serverId, "CreateListener", { success: "TCP listener created", onSuccess: onClose });
  useEffect(() => { if (opened) { setPort(""); setEnable(true); } }, [opened]);
  const p = Number(port);
  const err = port === "" ? null : !Number.isInteger(p) || p < 1 || p > 65535 ? "Port must be 1–65535" : existing.includes(p) ? "A listener on this port already exists" : null;
  return (
    <Modal opened={opened} onClose={onClose} title="Create TCP listener" centered>
      <form onSubmit={(e) => { e.preventDefault(); if (!err && port !== "") create.mutate({ Port_u32: p, Enable_bool: enable }); }}>
        <Stack>
          <NumberInput label="TCP port" description="Port number (range 1 – 65535). The server starts accepting VPN and admin connections on this port."
            min={1} max={65535} allowDecimal={false} value={port} onChange={setPort} error={err} required data-autofocus data-testid="listener-port" />
          <Switch label="Start listening immediately (active state)" checked={enable} onChange={(e) => setEnable(e.currentTarget.checked)} />
          <Text size="xs" c="dimmed">Make sure no other process on the host uses this port and that the firewall allows inbound TCP on it.</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={create.isPending} disabled={!!err || port === ""} data-testid="listener-create-submit">Create</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function TcpListeners({ serverId, mgmtPort, canWrite, isAdmin }: { serverId: number; mgmtPort: number | undefined; canWrite: boolean; isAdmin: boolean }) {
  const list = useRpc<{ ListenerList?: ListenerItem[] }>(serverId, "EnumListener", {}, { refetchInterval: 15_000 });
  const enable = useRpcMutation(serverId, "EnableListener", { success: false });
  const del = useRpcMutation(serverId, "DeleteListener", { success: "TCP listener deleted" });
  const [creating, setCreating] = useState(false);
  const ports = (list.data?.ListenerList ?? []).map((l) => l.Ports_u32);
  const errored = (list.data?.ListenerList ?? []).filter((l) => l.Enables_bool && l.Errors_bool);

  return (
    <Section
      title="TCP listeners"
      description="TCP ports on which the server accepts SoftEther VPN, SSTP, OpenVPN-over-TCP and administration connections."
      actions={canWrite && <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} data-testid="create-listener">Add listener</Button>}
    >
      {errored.length > 0 && (
        <Alert color="orange" icon={<IconAlertTriangle size={16} />} mb="sm" title="Listener error">
          The server could not bind to port{errored.length > 1 ? "s" : ""} {errored.map((l) => l.Ports_u32).join(", ")}. Another process may be using {errored.length > 1 ? "them" : "it"}, or the server lacks privileges for ports below 1024.
        </Alert>
      )}
      {list.error ? <ErrorAlert error={list.error} /> : (
        <QueryState query={list}>
          <DataTable
            testId="listeners-table"
            data={list.data?.ListenerList}
            rowKey={(l) => l.Ports_u32}
            searchable={false}
            initialSort={{ key: "Ports_u32", dir: "asc" }}
            empty="No TCP listeners"
            columns={[
              {
                key: "Ports_u32", title: "Port",
                render: (l) => (
                  <Group gap={6}>
                    <Text fw={600} ff="monospace">{l.Ports_u32}</Text>
                    {l.Ports_u32 === mgmtPort && <Tooltip label="The management server connects to this VPN server through this port"><Badge size="xs" color="grape" variant="light">management</Badge></Tooltip>}
                  </Group>
                ),
              },
              { key: "note", title: "Typical use", sortable: false, render: (l) => <Text size="sm" c="dimmed">{WELL_KNOWN[l.Ports_u32] ?? "Custom"}</Text> },
              {
                key: "state", title: "Status", value: (l) => (l.Enables_bool ? (l.Errors_bool ? 1 : 2) : 0),
                render: (l) => !l.Enables_bool ? <Badge color="gray" variant="light">Stopped</Badge>
                  : l.Errors_bool ? <Tooltip label="Enabled but failed to bind to the port"><Badge color="red" variant="light">Error</Badge></Tooltip>
                  : <Badge color="green" variant="light">Listening</Badge>,
              },
              {
                key: "actions", title: "", sortable: false, align: "right",
                render: (l) => {
                  const isMgmt = l.Ports_u32 === mgmtPort;
                  const lastActive = l.Enables_bool && (list.data?.ListenerList ?? []).filter((x) => x.Enables_bool).length === 1;
                  return (
                    <Group gap={6} justify="flex-end" wrap="nowrap">
                      {canWrite && (l.Enables_bool ? (
                        <ConfirmButton
                          title={`Stop listener on port ${l.Ports_u32}?`}
                          color={isMgmt ? "red" : "orange"}
                          message={isMgmt
                            ? <><b>This is the port the management server uses to reach this VPN server.</b> Stopping it will cut off management access (including this console) unless another listener is reachable. Clients connected on this port will be disconnected.</>
                            : <>The server stops accepting new connections on TCP port {l.Ports_u32}.{lastActive && <> <b>This is the last active listener.</b></>}</>}
                          typeToConfirm={isMgmt || lastActive ? String(l.Ports_u32) : undefined}
                          confirmLabel="Stop listener"
                          onConfirm={() => enable.mutateAsync({ Port_u32: l.Ports_u32, Enable_bool: false })}
                        >Stop</ConfirmButton>
                      ) : (
                        <Button size="xs" variant="light" color="green" loading={enable.isPending && enable.variables?.Port_u32 === l.Ports_u32}
                          onClick={() => enable.mutate({ Port_u32: l.Ports_u32, Enable_bool: true })}>Start</Button>
                      ))}
                      {isAdmin && (
                        <ConfirmButton
                          title={`Delete listener on port ${l.Ports_u32}?`}
                          message={isMgmt
                            ? <><b>Warning: this is the port the management server connects through ({mgmtPort}).</b> Deleting it will immediately break management of this server from here. Only continue if another reachable listener exists and you will update the server's port in the inventory.</>
                            : <>The TCP listener on port {l.Ports_u32} is removed. Clients using this port will no longer be able to connect.</>}
                          typeToConfirm={String(l.Ports_u32)}
                          confirmLabel="Delete listener"
                          leftSection={<IconTrash size={14} />}
                          onConfirm={() => del.mutateAsync({ Port_u32: l.Ports_u32 })}
                        >Delete</ConfirmButton>
                      )}
                    </Group>
                  );
                },
              },
            ]}
          />
        </QueryState>
      )}
      <CreateListenerModal serverId={serverId} opened={creating} onClose={() => setCreating(false)} existing={ports} />
    </Section>
  );
}

function UdpPorts({ serverId, isAdmin }: { serverId: number; isAdmin: boolean }) {
  const q = useRpc<{ Ports_u32?: number[] }>(serverId, "GetPortsUDP");
  const save = useRpcMutation(serverId, "SetPortsUDP", { success: "UDP ports updated" });
  const current = (q.data?.Ports_u32 ?? []).map(String);
  const [value, setValue] = useState<string[]>([]);
  const [initKey, setInitKey] = useState("");
  const key = current.join(",");
  useEffect(() => { if (q.data && key !== initKey) { setValue(current); setInitKey(key); } }, [q.data, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalid = value.filter((v) => !/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535);
  const nums = [...new Set(value.filter((v) => !invalid.includes(v)).map(Number))].sort((a, b) => a - b);
  const added = nums.filter((p) => !current.includes(String(p)));
  const removed = current.map(Number).filter((p) => !nums.includes(p));
  const dirty = added.length > 0 || removed.length > 0;

  return (
    <Section
      title="UDP ports"
      description="UDP ports the server listens on for UDP-based protocols (OpenVPN over UDP, WireGuard and others). Saving replaces the entire list."
    >
      {q.error ? <ErrorAlert error={q.error} /> : (
        <QueryState query={q}>
          <Stack>
            <TagsInput
              label="Listening UDP ports"
              description={isAdmin ? "Type a port and press Enter or comma. Range 1 – 65535." : undefined}
              value={value}
              onChange={(v) => setValue(v.map((x) => x.trim()).filter(Boolean))}
              splitChars={[",", " ", ";"]}
              readOnly={!isAdmin}
              clearable={isAdmin}
              error={invalid.length ? `Invalid port(s): ${invalid.join(", ")}` : undefined}
              placeholder={isAdmin ? "Add port…" : undefined}
              data-testid="udp-ports-input"
            />
            {value.length === 0 && current.length > 0 && isAdmin && (
              <Alert color="orange" icon={<IconAlertTriangle size={16} />}>An empty list stops all UDP-based protocols (OpenVPN UDP, WireGuard…).</Alert>
            )}
            {isAdmin && (
              <Group justify="space-between">
                <Text size="xs" c="dimmed">
                  {dirty ? <>Changes: {added.length > 0 && <>add <b>{added.join(", ")}</b></>}{added.length > 0 && removed.length > 0 && "; "}{removed.length > 0 && <>remove <b>{removed.join(", ")}</b></>}</> : "No unsaved changes."}
                </Text>
                <Group gap="xs">
                  <Button variant="default" size="xs" disabled={!dirty} onClick={() => setValue(current)}>Reset</Button>
                  <ConfirmButton
                    title="Replace UDP port list?"
                    color="orange"
                    variant="filled"
                    size="xs"
                    disabled={!dirty || invalid.length > 0}
                    leftSection={<IconDeviceFloppy size={14} />}
                    message={<>The server's UDP listening ports become: <b>{nums.length ? nums.join(", ") : "(none)"}</b>. Clients using removed ports over UDP will be disconnected.</>}
                    confirmLabel="Save UDP ports"
                    onConfirm={() => save.mutateAsync({ Ports_u32: nums })}
                  >Save</ConfirmButton>
                </Group>
              </Group>
            )}
          </Stack>
        </QueryState>
      )}
    </Section>
  );
}

function SpecialListeners({ serverId, isAdmin, supported }: { serverId: number; isAdmin: boolean; supported: boolean }) {
  const q = useRpc<{ VpnOverIcmpListener_bool: boolean; VpnOverDnsListener_bool: boolean }>(serverId, "GetSpecialListener");
  const save = useRpcMutation(serverId, "SetSpecialListener", { success: "Special listeners updated" });
  const [icmp, setIcmp] = useState(false);
  const [dns, setDns] = useState(false);
  useEffect(() => {
    if (q.data) { setIcmp(!!q.data.VpnOverIcmpListener_bool); setDns(!!q.data.VpnOverDnsListener_bool); }
  }, [q.data]);
  const dirty = !!q.data && (icmp !== !!q.data.VpnOverIcmpListener_bool || dns !== !!q.data.VpnOverDnsListener_bool);
  return (
    <Section
      title="VPN over ICMP / DNS"
      description="Special listeners that let clients establish a VPN using only ICMP (ping) or DNS packets, even when a firewall blocks TCP/IP and UDP."
    >
      {!supported && <Alert color="gray" mb="sm">This server does not report support for VPN over ICMP / DNS (b_support_special_listener).</Alert>}
      {q.error ? <ErrorAlert error={q.error} /> : (
        <QueryState query={q}>
          <Stack>
            <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
              Use these functions for emergencies only — e.g. when a misconfigured firewall blocks TCP/IP but lets ICMP or DNS through. They are not intended for long-term stable use.
            </Alert>
            <Switch label="VPN over ICMP" description="Activate the VPN over ICMP server function (VpnOverIcmpListener_bool)." checked={icmp} onChange={(e) => setIcmp(e.currentTarget.checked)} disabled={!isAdmin} data-testid="special-icmp" />
            <Switch label="VPN over DNS" description="Activate the VPN over DNS server function; the server listens on UDP port 53 (VpnOverDnsListener_bool)." checked={dns} onChange={(e) => setDns(e.currentTarget.checked)} disabled={!isAdmin} data-testid="special-dns" />
            {isAdmin && (
              <Group justify="flex-end">
                <Button variant="default" size="xs" disabled={!dirty} onClick={() => { setIcmp(!!q.data?.VpnOverIcmpListener_bool); setDns(!!q.data?.VpnOverDnsListener_bool); }}>Reset</Button>
                <ConfirmButton
                  title="Apply VPN over ICMP / DNS settings?"
                  color="orange" variant="filled" size="xs" disabled={!dirty}
                  leftSection={<IconDeviceFloppy size={14} />}
                  message={<>VPN over ICMP will be <b>{icmp ? "enabled" : "disabled"}</b> and VPN over DNS will be <b>{dns ? "enabled" : "disabled"}</b>.</>}
                  confirmLabel="Apply"
                  onConfirm={() => save.mutateAsync({ VpnOverIcmpListener_bool: icmp, VpnOverDnsListener_bool: dns })}
                >Save</ConfirmButton>
              </Group>
            )}
          </Stack>
        </QueryState>
      )}
    </Section>
  );
}

export default function ListenersPage() {
  const { serverId } = useScope();
  const server = useServer(serverId);
  const role = server.data?.myRole;
  const caps = useCaps(serverId);
  const canWrite = can(role, "operator");
  const isAdmin = can(role, "admin");
  return (
    <>
      <PageHeader title="Listeners & ports" description="TCP listeners, UDP ports and the special VPN-over-ICMP/DNS listeners of this server." />
      {!canWrite && <ReadOnlyNotice role={role ?? "none"} />}
      {canWrite && !isAdmin && (
        <Alert color="gray" variant="light" mb="md">Deleting listeners and changing UDP ports or special listeners requires the <b>admin</b> role.</Alert>
      )}
      <TcpListeners serverId={serverId} mgmtPort={server.data?.port} canWrite={canWrite} isAdmin={isAdmin} />
      <UdpPorts serverId={serverId} isAdmin={isAdmin} />
      <SpecialListeners serverId={serverId} isAdmin={isAdmin} supported={caps.isLoading || caps.error ? true : caps.has("b_support_special_listener")} />
    </>
  );
}
