import { useEffect, useMemo, useState } from "react";
import {
  Alert, Badge, Button, Code, Group, List, Modal, NumberInput, PasswordInput, SegmentedControl, SimpleGrid, Stack, Switch, TagsInput, Text, TextInput,
} from "@mantine/core";
import { IconAlertTriangle, IconDeviceFloppy, IconServer2, IconTopologyStar3 } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, Copyable, Empty, ErrorAlert, KeyValue, OnlineBadge, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { HelpLabel, useServerAccess } from "../../components/server-b/ui";
import { b64ToBytes, fingerprint256 } from "../../components/server-b/x509";
import { useCatalog, useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import { ago, dt, isIPv4, num } from "../../lib/format";

interface Farm {
  ServerType_u32?: number;
  NumPort_u32?: number;
  Ports_u32?: number[];
  PublicIp_ip?: string;
  ControllerName_str?: string;
  ControllerPort_u32?: number;
  MemberPasswordPlaintext_str?: string;
  Weight_u32?: number;
  ControllerOnly_bool?: boolean;
  [k: string]: unknown;
}

interface FarmItem {
  Id_u32: number; Controller_bool: boolean; ConnectedTime_dt: string; Ip_ip: string; Hostname_str: string; Point_u32: number;
  NumSessions_u32: number; NumTcpConnections_u32: number; NumHubs_u32: number; AssignedClientLicense_u32: number; AssignedBridgeLicense_u32: number;
}

interface FarmInfo {
  Id_u32: number; Controller_bool: boolean; ConnectedTime_dt: string; Ip_ip: string; Hostname_str: string; Point_u32: number;
  NumPort_u32: number; Ports_u32?: number[]; ServerCert_bin?: string; NumFarmHub_u32: number; HubsList?: { HubName_str: string; DynamicHub_bool: boolean }[];
  NumSessions_u32: number; NumTcpConnections_u32: number; Weight_u32: number;
}

interface FarmConn {
  Ip_ip: string; Port_u32: number; Online_bool: boolean; LastError_u32: number; StartedTime_dt: string; FirstConnectedTime_dt: string;
  CurrentConnectedTime_dt: string; NumTry_u32: number; NumConnected_u32: number; NumFailed_u32: number;
}

const TYPES = [
  { value: "0", label: "Standalone server" },
  { value: "1", label: "Cluster controller" },
  { value: "2", label: "Cluster member" },
];

const DOC = {
  type: "Standalone: not part of any cluster (default). Controller: the central server of a cluster, distributing sessions to members. Member: joins a controller and hosts sessions for it.",
  PublicIp: "Valid only for cluster members. The public IP address of this server. Leave empty to use the IP address of the interface used to connect to the controller.",
  Ports: "Valid only for cluster members. Public port numbers on this server that clients will be redirected to. At least one port is required.",
  ControllerName: "Valid only for cluster members. Host name or IP address of the cluster controller.",
  ControllerPort: "Valid only for cluster members. TCP port of the cluster controller.",
  MemberPassword: "Valid only for cluster members. Password required to connect to the controller — the same as the administrator password of the controller.",
  Weight: "Performance standard ratio used for load balancing. A member with 200 receives twice as many connections as members with 100. 1 or higher; default 100.",
  ControllerOnly: "Valid only for the cluster controller. The controller then only coordinates and always distributes VPN client sessions to other members. For high-load environments.",
};

function FarmSettingSection({ serverId, serverName, isAdmin }: { serverId: number; serverName: string; isAdmin: boolean }) {
  const q = useRpc<Farm>(serverId, "GetFarmSetting");
  const listeners = useRpc<{ ListenerList?: { Ports_u32: number; Enables_bool: boolean }[] }>(serverId, "EnumListener", {}, { retry: false });
  const [f, setF] = useState<Farm>({});
  const [ports, setPorts] = useState<string[]>([]);
  const [changePw, setChangePw] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setF({ ...q.data, PublicIp_ip: q.data.PublicIp_ip === "0.0.0.0" ? "" : q.data.PublicIp_ip, MemberPasswordPlaintext_str: "" });
    setPorts((q.data.Ports_u32 ?? []).map(String));
    setChangePw(false);
  }, [q.data]);
  const save = useRpcMutation(serverId, "SetFarmSetting", { success: "Clustering configuration applied — the VPN Server is restarting" });

  const type = f.ServerType_u32 ?? 0;
  const orig = q.data;
  const portNums = ports.map(Number);
  const badPorts = ports.filter((p) => !/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535);
  const errors: string[] = [];
  if (type === 2) {
    if (!f.ControllerName_str?.trim()) errors.push("Controller host name is required");
    if (!f.ControllerPort_u32 || f.ControllerPort_u32 < 1 || f.ControllerPort_u32 > 65535) errors.push("Controller port must be 1–65535");
    if (portNums.length === 0) errors.push("At least one public port is required");
    if (badPorts.length) errors.push(`Invalid port(s): ${badPorts.join(", ")}`);
    if (f.PublicIp_ip && !isIPv4(f.PublicIp_ip)) errors.push("Public IP must be an IPv4 address or empty");
    if ((orig?.ServerType_u32 !== 2 || changePw) && !f.MemberPasswordPlaintext_str) errors.push("The controller's administrator password is required");
  }
  if (!f.Weight_u32 || f.Weight_u32 < 1) errors.push("Weight must be 1 or higher");

  const dirty = !!orig && (
    type !== orig.ServerType_u32 || f.Weight_u32 !== orig.Weight_u32 || !!f.ControllerOnly_bool !== !!orig.ControllerOnly_bool ||
    (type === 2 && (f.ControllerName_str !== orig.ControllerName_str || f.ControllerPort_u32 !== orig.ControllerPort_u32 ||
      (f.PublicIp_ip || "0.0.0.0") !== (orig.PublicIp_ip || "0.0.0.0") || portNums.join(",") !== (orig.Ports_u32 ?? []).join(",") || !!f.MemberPasswordPlaintext_str))
  );

  const payload = (): Farm => {
    // Start from the server's struct (keeps MemberPassword_bin when the password is not changed).
    const p: Farm = { ...orig, ServerType_u32: type, Weight_u32: f.Weight_u32, ControllerOnly_bool: type === 1 ? !!f.ControllerOnly_bool : false };
    if (type === 2) {
      Object.assign(p, {
        ControllerName_str: f.ControllerName_str?.trim(), ControllerPort_u32: f.ControllerPort_u32,
        PublicIp_ip: f.PublicIp_ip || "0.0.0.0", Ports_u32: portNums, NumPort_u32: portNums.length,
        MemberPasswordPlaintext_str: f.MemberPasswordPlaintext_str ?? "",
      });
    } else {
      p.MemberPasswordPlaintext_str = "";
    }
    return p;
  };

  const suggested = (listeners.data?.ListenerList ?? []).filter((l) => l.Enables_bool).map((l) => String(l.Ports_u32));

  return (
    <Section title="Clustering configuration" description="Server type within a SoftEther cluster (server farm). Clustering distributes VPN sessions across several servers for load balancing and redundancy.">
      <QueryState query={q}>
        <form onSubmit={(e) => e.preventDefault()}>
          <Stack>
            <div>
              <Text size="sm" fw={500} mb={4}><HelpLabel label="Server type" doc={DOC.type} /></Text>
              <SegmentedControl data={TYPES} value={String(type)} disabled={!isAdmin} onChange={(v) => {
                const t = Number(v);
                setF((s) => ({ ...s, ServerType_u32: t, ControllerPort_u32: t === 2 && !s.ControllerPort_u32 ? 443 : s.ControllerPort_u32 }));
                if (t === 2 && ports.length === 0) setPorts(suggested.length ? suggested : ["443"]);
              }} data-testid="farm-type" />
            </div>
            {type === 2 && (
              <SimpleGrid cols={{ base: 1, md: 2 }}>
                <TextInput label={<HelpLabel label="Controller host name or IP" doc={DOC.ControllerName} />} required value={f.ControllerName_str ?? ""} readOnly={!isAdmin}
                  onChange={(e) => setF((s) => ({ ...s, ControllerName_str: e.currentTarget.value }))} data-testid="farm-controller-name" />
                <NumberInput label={<HelpLabel label="Controller port" doc={DOC.ControllerPort} />} required min={1} max={65535} allowDecimal={false} value={f.ControllerPort_u32 ?? 443} readOnly={!isAdmin}
                  onChange={(v) => setF((s) => ({ ...s, ControllerPort_u32: Number(v) || 0 }))} data-testid="farm-controller-port" />
                <TextInput label={<HelpLabel label="Public IP address" doc={DOC.PublicIp} />} placeholder="Automatic" value={f.PublicIp_ip ?? ""} readOnly={!isAdmin}
                  onChange={(e) => setF((s) => ({ ...s, PublicIp_ip: e.currentTarget.value.trim() }))} data-testid="farm-public-ip" />
                <TagsInput label={<HelpLabel label="Public ports" doc={DOC.Ports} />} value={ports} onChange={setPorts} data={suggested} readOnly={!isAdmin}
                  description="Press Enter after each port" error={badPorts.length ? `Invalid: ${badPorts.join(", ")}` : undefined} data-testid="farm-ports" />
                {orig?.ServerType_u32 === 2 && !changePw ? (
                  <div>
                    <Text size="sm" fw={500} mb={4}><HelpLabel label="Controller password" doc={DOC.MemberPassword} /></Text>
                    <Group gap="xs"><Badge variant="light" color="gray">Stored</Badge>{isAdmin && <Button size="xs" variant="subtle" onClick={() => setChangePw(true)}>Change</Button>}</Group>
                  </div>
                ) : (
                  <PasswordInput label={<HelpLabel label="Controller password" doc={DOC.MemberPassword} />} required autoComplete="new-password"
                    value={f.MemberPasswordPlaintext_str ?? ""} onChange={(e) => setF((s) => ({ ...s, MemberPasswordPlaintext_str: e.currentTarget.value }))} data-testid="farm-member-password" />
                )}
              </SimpleGrid>
            )}
            <SimpleGrid cols={{ base: 1, md: 2 }}>
              <NumberInput label={<HelpLabel label="Performance weight" doc={DOC.Weight} />} min={1} max={10000} allowDecimal={false} value={f.Weight_u32 ?? 100} readOnly={!isAdmin}
                onChange={(v) => setF((s) => ({ ...s, Weight_u32: Number(v) || 0 }))} description="Relative capacity for load balancing (default 100)" data-testid="farm-weight" />
              {type === 1 && (
                <Switch mt="lg" label={<HelpLabel label="Controller only (do not host sessions)" doc={DOC.ControllerOnly} />} checked={!!f.ControllerOnly_bool} disabled={!isAdmin}
                  onChange={(e) => setF((s) => ({ ...s, ControllerOnly_bool: e.currentTarget.checked }))} data-testid="farm-controller-only" />
              )}
            </SimpleGrid>
            {isAdmin && dirty && errors.length > 0 && <Alert color="red" variant="light"><List size="sm">{errors.map((e) => <List.Item key={e}>{e}</List.Item>)}</List></Alert>}
            {isAdmin && (
              <Group justify="flex-end">
                <Button variant="default" disabled={!dirty} onClick={() => { if (orig) { setF({ ...orig, PublicIp_ip: orig.PublicIp_ip === "0.0.0.0" ? "" : orig.PublicIp_ip, MemberPasswordPlaintext_str: "" }); setPorts((orig.Ports_u32 ?? []).map(String)); setChangePw(false); } }}>Reset</Button>
                <ConfirmButton
                  title="Apply clustering configuration?"
                  color="red" variant="filled" size="sm" confirmLabel="Apply and restart"
                  disabled={!dirty || errors.length > 0} typeToConfirm={serverName}
                  leftSection={<IconDeviceFloppy size={16} />}
                  message={<Stack gap="xs">
                    <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} p="xs">
                      <b>The VPN Server restarts automatically</b> when the clustering configuration is changed. All VPN sessions are disconnected and the manager loses the connection for a short time.
                    </Alert>
                    <Text size="sm">New type: <b>{TYPES[type]?.label}</b>{type === 2 && <> joining <Code>{f.ControllerName_str}:{f.ControllerPort_u32}</Code></>}</Text>
                    {type !== 0 && orig?.ServerType_u32 === 0 && <Text size="sm">Virtual Hubs become cluster hubs (static / dynamic); on a member, local hubs are replaced by the controller's hubs.</Text>}
                  </Stack>}
                  onConfirm={() => save.mutateAsync(payload())}
                >
                  <span data-testid="save-farm">Apply…</span>
                </ConfirmButton>
              </Group>
            )}
          </Stack>
        </form>
      </QueryState>
    </Section>
  );
}

function FarmInfoModal({ serverId, id, onClose }: { serverId: number; id: number | null; onClose: () => void }) {
  const q = useRpc<FarmInfo>(serverId, "GetFarmInfo", { Id_u32: id ?? 0 }, { enabled: id !== null });
  const [fp, setFp] = useState("");
  useEffect(() => {
    setFp("");
    if (q.data?.ServerCert_bin) { try { void fingerprint256(b64ToBytes(q.data.ServerCert_bin)).then(setFp); } catch { /* ignore */ } }
  }, [q.data]);
  const d = q.data;
  return (
    <Modal opened={id !== null} onClose={onClose} title="Cluster member details" size="lg" centered>
      <QueryState query={q}>
        {d && (
          <Stack>
            <KeyValue rows={[
              ["Role", d.Controller_bool ? <Badge>Controller</Badge> : <Badge variant="light" color="gray">Member</Badge>],
              ["Host name", d.Hostname_str],
              ["IP address", d.Ip_ip],
              ["Public ports", (d.Ports_u32 ?? []).map((p) => <Badge key={p} variant="outline" mr={4}>{p}</Badge>)],
              ["Connected since", `${dt(d.ConnectedTime_dt)} (${ago(d.ConnectedTime_dt)})`],
              ["Point (load score)", num(d.Point_u32)],
              ["Weight", num(d.Weight_u32)],
              ["Sessions", num(d.NumSessions_u32)],
              ["TCP connections", num(d.NumTcpConnections_u32)],
              ["Server certificate SHA-256", fp ? <Copyable value={fp} /> : "–"],
            ]} />
            <div>
              <Text size="sm" fw={600} mb={4}>Hosted Virtual Hubs ({num(d.NumFarmHub_u32)})</Text>
              {(d.HubsList ?? []).length === 0 ? <Text size="sm" c="dimmed">None</Text> : (
                <Group gap={6}>{d.HubsList!.map((h) => <Badge key={h.HubName_str} variant="light" color={h.DynamicHub_bool ? "grape" : "blue"}>{h.HubName_str}{h.DynamicHub_bool ? " (dynamic)" : " (static)"}</Badge>)}</Group>
              )}
            </div>
          </Stack>
        )}
      </QueryState>
    </Modal>
  );
}

function MembersSection({ serverId }: { serverId: number }) {
  const q = useRpc<{ FarmMemberList?: FarmItem[] }>(serverId, "EnumFarmMember", {}, { refetchInterval: 15_000, retry: false });
  const [sel, setSel] = useState<number | null>(null);
  return (
    <Section title="Cluster members" description="All servers of this cluster, including the controller itself. Click a row for details.">
      {q.error ? <ErrorAlert error={q.error} /> : (
        <DataTable
          testId="farm-members-table"
          data={q.data?.FarmMemberList}
          loading={q.isLoading}
          rowKey={(r) => r.Id_u32}
          onRowClick={(r) => setSel(r.Id_u32)}
          initialSort={{ key: "Controller_bool", dir: "desc" }}
          empty="No cluster members connected"
          columns={[
            { key: "Controller_bool", title: "Role", value: (r) => (r.Controller_bool ? 1 : 0), render: (r) => r.Controller_bool ? <Badge leftSection={<IconTopologyStar3 size={12} />}>Controller</Badge> : <Badge variant="light" color="gray" leftSection={<IconServer2 size={12} />}>Member</Badge> },
            { key: "Hostname_str", title: "Host name", render: (r) => <Text fw={600} size="sm">{r.Hostname_str}</Text> },
            { key: "Ip_ip", title: "IP address" },
            { key: "ConnectedTime_dt", title: "Connected", render: (r) => ago(r.ConnectedTime_dt) },
            { key: "Point_u32", title: "Point", align: "right", render: (r) => num(r.Point_u32) },
            { key: "NumSessions_u32", title: "Sessions", align: "right", render: (r) => num(r.NumSessions_u32) },
            { key: "NumTcpConnections_u32", title: "TCP conns", align: "right", render: (r) => num(r.NumTcpConnections_u32) },
            { key: "NumHubs_u32", title: "Hubs", align: "right", render: (r) => num(r.NumHubs_u32) },
            { key: "AssignedClientLicense_u32", title: "Client / bridge licenses", align: "right", render: (r) => `${num(r.AssignedClientLicense_u32)} / ${num(r.AssignedBridgeLicense_u32)}` },
          ]}
        />
      )}
      <FarmInfoModal serverId={serverId} id={sel} onClose={() => setSel(null)} />
    </Section>
  );
}

function ControllerConnectionSection({ serverId }: { serverId: number }) {
  const q = useRpc<FarmConn>(serverId, "GetFarmConnectionStatus", {}, { refetchInterval: 10_000, retry: false });
  const catalog = useCatalog();
  const d = q.data;
  const errText = (c: number) => (c ? `${catalog.data?.errors[String(c)] ?? "Error"} (code ${c})` : "None");
  return (
    <Section title="Connection to the controller" description="Status of this member's connection to its cluster controller (refreshes every 10 seconds).">
      <QueryState query={q}>
        {d && (
          <KeyValue rows={[
            ["Status", <OnlineBadge online={d.Online_bool} onLabel="Connected" offLabel="Disconnected" />],
            ["Controller", <Code>{d.Ip_ip}:{d.Port_u32}</Code>],
            ["Last error", d.LastError_u32 ? <Text size="sm" c="red">{errText(d.LastError_u32)}</Text> : "None"],
            ["Connection attempts started", dt(d.StartedTime_dt)],
            ["First connected", dt(d.FirstConnectedTime_dt)],
            ["Current connection since", d.Online_bool ? `${dt(d.CurrentConnectedTime_dt)} (${ago(d.CurrentConnectedTime_dt)})` : "–"],
            ["Attempts / successes / failures", `${num(d.NumTry_u32)} / ${num(d.NumConnected_u32)} / ${num(d.NumFailed_u32)}`],
          ]} />
        )}
      </QueryState>
    </Section>
  );
}

export default function ClusterPage() {
  const { serverId } = useScope();
  const { server, role, isAdmin } = useServerAccess(serverId);
  const farm = useRpc<Farm>(serverId, "GetFarmSetting");
  const type = farm.data?.ServerType_u32;
  const typeLabel = useMemo(() => TYPES.find((t) => Number(t.value) === type)?.label, [type]);
  return (
    <>
      <PageHeader
        title="Clustering"
        badge={typeLabel && <Badge variant="light" data-testid="farm-current-type">{typeLabel}</Badge>}
        description="Configure this VPN Server as a standalone server, a cluster controller, or a cluster member."
      />
      {!isAdmin && <ReadOnlyNotice role={role} />}
      <FarmSettingSection serverId={serverId} serverName={server.data?.name ?? ""} isAdmin={isAdmin} />
      {type === 1 && <MembersSection serverId={serverId} />}
      {type === 2 && <ControllerConnectionSection serverId={serverId} />}
      {type === 0 && (
        <Section title="Cluster status">
          <Empty>This server is standalone. Member lists and controller connection status appear here once it is part of a cluster.</Empty>
        </Section>
      )}
    </>
  );
}
