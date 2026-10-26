// Server › Clustering: the server's role in a SoftEther cluster (standalone, controller, member), the
// member list of a controller (double-click a member for its details) and a member's controller link.
import { useEffect, useMemo, useState } from "react";
import { Button, NumberInput, PasswordInput, SegmentedControl, Switch, TagsInput, TextInput } from "@mantine/core";
import { IconCopy, IconInfoCircle, IconServer2, IconTopologyStar3 } from "@tabler/icons-react";
import { useCatalog, useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import { ago, agoShort, dt, isIPv4, num } from "../../lib/format";
import {
  DataTable, ErrorState, FingerprintField, FormRow, FormSection, Inspector, Mono, PageHeader, PropertyList, PropertySkeleton,
  QueryState, Section, StatusBadge, Tag, type ContextMenuItem,
} from "../../design";
import { Callout, HelpLabel, SaveBar } from "../../components/domain/ui";
import { b64ToBytes } from "../../components/domain/util";
import { fingerprint256 } from "../../components/domain/x509";
import { Unreachable, useReachable } from "./_server-advanced/shared";

interface Farm {
  ServerType_u32?: number; NumPort_u32?: number; Ports_u32?: number[]; PublicIp_ip?: string; ControllerName_str?: string;
  ControllerPort_u32?: number; MemberPasswordPlaintext_str?: string; Weight_u32?: number; ControllerOnly_bool?: boolean; [k: string]: unknown;
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
  { value: "0", label: "Standalone", long: "Standalone server" },
  { value: "1", label: "Controller", long: "Cluster controller" },
  { value: "2", label: "Member", long: "Cluster member" },
];
const TYPE_HELP = [
  "Not part of a cluster. This is the default.",
  "The central server of a cluster. It hosts the Virtual Hubs and hands VPN sessions to its members.",
  "Joins a controller and hosts VPN sessions on its behalf. Its own Virtual Hubs are replaced by the controller’s.",
];
const DOC = {
  PublicIp: "The public IP address clients are redirected to. Leave it empty to use the address of the interface that connects to the controller.",
  Ports: "Public TCP ports of this server that clients are redirected to. At least one is required.",
  ControllerName: "Host name or IP address of the cluster controller.",
  ControllerPort: "TCP port of the cluster controller.",
  MemberPassword: "The administrator password of the controller.",
  Weight: "Share of the load for balancing. A member with 200 gets twice as many sessions as one with 100. 1 or more; the default is 100.",
  ControllerOnly: "The controller only coordinates the cluster and always hands VPN sessions to members. For clusters with a high load.",
};

const fromServer = (d: Farm): Farm => ({ ...d, PublicIp_ip: d.PublicIp_ip === "0.0.0.0" ? "" : d.PublicIp_ip, MemberPasswordPlaintext_str: "" });

function FarmSettings({ serverId, serverName, enabled }: { serverId: number; serverName: string; enabled: boolean }) {
  const q = useRpc<Farm>(serverId, "GetFarmSetting", {}, { enabled });
  const listeners = useRpc<{ ListenerList?: { Ports_u32: number; Enables_bool: boolean }[] }>(serverId, "EnumListener", {}, { enabled, retry: false });
  const [f, setF] = useState<Farm>({});
  const [ports, setPorts] = useState<string[]>([]);
  const [changePw, setChangePw] = useState(false);
  const orig = q.data;
  const reset = () => {
    if (!orig) return;
    setF(fromServer(orig));
    setPorts((orig.Ports_u32 ?? []).map(String));
    setChangePw(false);
  };
  useEffect(reset, [orig]); // eslint-disable-line react-hooks/exhaustive-deps

  const type = f.ServerType_u32 ?? 0;
  const save = useRpcMutation<Farm>(serverId, "SetFarmSetting", {
    success: "Clustering configuration applied. The VPN Server is restarting.",
    confirm: (p) => ({
      title: "Change the clustering configuration?",
      message: <>The VPN Server restarts. Every VPN session is disconnected, and this app loses the connection for a few seconds.</>,
      details: (
        <PropertyList dense labelWidth={96} items={[
          { label: "New role", value: TYPES[p.ServerType_u32 ?? 0]?.long },
          ...(p.ServerType_u32 === 2 ? [{ label: "Controller", value: <Mono>{p.ControllerName_str}:{p.ControllerPort_u32}</Mono> }] : []),
          ...(p.ServerType_u32 !== 0 && orig?.ServerType_u32 === 0 ? [{ label: "Hubs", value: "Become cluster hubs. On a member, local hubs are replaced by the controller’s." }] : []),
        ]} />
      ),
      confirmLabel: "Apply and Restart",
      typeToConfirm: serverName,
      typeLabel: <>To confirm, type the connection name <code className="sem-code-inline">{serverName}</code></>,
    }),
  });

  const portNums = ports.map(Number);
  const badPorts = ports.filter((p) => !/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535);
  const member = type === 2;
  const needPw = member && (orig?.ServerType_u32 !== 2 || changePw);
  const err = {
    name: member && !f.ControllerName_str?.trim() ? "Enter the controller’s host name or IP address." : undefined,
    port: member && (!f.ControllerPort_u32 || f.ControllerPort_u32 < 1 || f.ControllerPort_u32 > 65535) ? "Enter a port from 1 to 65535." : undefined,
    ports: !member ? undefined : ports.length === 0 ? "Add at least one public port." : badPorts.length ? `Not a port number: ${badPorts.join(", ")}` : undefined,
    ip: member && f.PublicIp_ip && !isIPv4(f.PublicIp_ip) ? "Enter an IPv4 address, or leave it empty." : undefined,
    pw: needPw && !f.MemberPasswordPlaintext_str ? "Enter the controller’s administrator password." : undefined,
    weight: !f.Weight_u32 || f.Weight_u32 < 1 ? "Enter 1 or more." : undefined,
  };
  const invalid = Object.values(err).some(Boolean);
  const dirty = !!orig && (
    type !== orig.ServerType_u32 || f.Weight_u32 !== orig.Weight_u32 || !!f.ControllerOnly_bool !== !!orig.ControllerOnly_bool ||
    (member && (f.ControllerName_str !== orig.ControllerName_str || f.ControllerPort_u32 !== orig.ControllerPort_u32 ||
      (f.PublicIp_ip || "0.0.0.0") !== (orig.PublicIp_ip || "0.0.0.0") || portNums.join(",") !== (orig.Ports_u32 ?? []).join(",") || !!f.MemberPasswordPlaintext_str))
  );

  const payload = (): Farm => {
    // Start from the server's struct (keeps MemberPassword_bin when the password isn't changed).
    const p: Farm = { ...orig, ServerType_u32: type, Weight_u32: f.Weight_u32, ControllerOnly_bool: type === 1 ? !!f.ControllerOnly_bool : false };
    if (member) {
      Object.assign(p, {
        ControllerName_str: f.ControllerName_str?.trim(), ControllerPort_u32: f.ControllerPort_u32,
        PublicIp_ip: f.PublicIp_ip || "0.0.0.0", Ports_u32: portNums, NumPort_u32: portNums.length,
        MemberPasswordPlaintext_str: f.MemberPasswordPlaintext_str ?? "",
      });
    } else p.MemberPasswordPlaintext_str = "";
    return p;
  };
  const suggested = (listeners.data?.ListenerList ?? []).filter((l) => l.Enables_bool).map((l) => String(l.Ports_u32));

  if (q.error) return <Section title="Role"><ErrorState error={q.error} inline onRetry={() => void q.refetch()} /></Section>;
  if (!orig) return <FormSection title="Role"><div style={{ padding: "10px 0" }}><PropertySkeleton rows={3} /></div></FormSection>;

  return (
    <form onSubmit={(e) => e.preventDefault()} data-testid="farm-form">
      <FormSection title="Role" description="Clustering spreads VPN sessions over several servers for load balancing and redundancy.">
        <FormRow label="Server type" description={TYPE_HELP[type]}>
          <SegmentedControl
            data={TYPES.map((t) => ({ value: t.value, label: t.label }))} value={String(type)} aria-label="Server type" data-testid="farm-type"
            onChange={(v) => {
              const t = Number(v);
              setF((s) => ({ ...s, ServerType_u32: t, ControllerPort_u32: t === 2 && !s.ControllerPort_u32 ? 443 : s.ControllerPort_u32 }));
              if (t === 2 && ports.length === 0) setPorts(suggested.length ? suggested : ["443"]);
            }}
          />
        </FormRow>
        {type === 1 && (
          <FormRow label={<HelpLabel label="Controller only" doc={DOC.ControllerOnly} />} description="Don’t host VPN sessions on the controller itself.">
            <Switch checked={!!f.ControllerOnly_bool} onChange={(e) => { const v = e.currentTarget.checked; setF((s) => ({ ...s, ControllerOnly_bool: v })); }}
              aria-label="Controller only" data-testid="farm-controller-only" />
          </FormRow>
        )}
        <FormRow label={<HelpLabel label="Performance weight" doc={DOC.Weight} />} description="Relative capacity for load balancing." error={err.weight}>{(id) => (
          <NumberInput id={id} w={120} min={1} max={10000} allowDecimal={false} allowNegative={false} value={f.Weight_u32 ?? 100} error={!!err.weight}
            onChange={(v) => setF((s) => ({ ...s, Weight_u32: Number(v) || 0 }))} data-testid="farm-weight" />
        )}</FormRow>
      </FormSection>

      {member && (
        <>
          <FormSection title="Controller" description="The server this member joins.">
            <FormRow label={<HelpLabel label="Host name or IP" doc={DOC.ControllerName} />} error={err.name}>{(id) => (
              <TextInput id={id} w={320} value={f.ControllerName_str ?? ""} spellCheck={false} error={!!err.name} placeholder="controller.example.com"
                onChange={(e) => { const v = e.currentTarget.value; setF((s) => ({ ...s, ControllerName_str: v })); }} data-testid="farm-controller-name" />
            )}</FormRow>
            <FormRow label={<HelpLabel label="Port" doc={DOC.ControllerPort} />} error={err.port}>{(id) => (
              <NumberInput id={id} w={120} min={1} max={65535} allowDecimal={false} allowNegative={false} value={f.ControllerPort_u32 ?? 443} error={!!err.port}
                onChange={(v) => setF((s) => ({ ...s, ControllerPort_u32: Number(v) || 0 }))} data-testid="farm-controller-port" />
            )}</FormRow>
            <FormRow label={<HelpLabel label="Administrator password" doc={DOC.MemberPassword} />} error={err.pw}>{(id) => (
              orig.ServerType_u32 === 2 && !changePw ? (
                <span className="sem-row-inline">
                  <Tag>Saved on the server</Tag>
                  <Button size="xs" variant="default" onClick={() => setChangePw(true)} data-testid="farm-change-password">Change…</Button>
                </span>
              ) : (
                <PasswordInput id={id} w={320} autoComplete="new-password" value={f.MemberPasswordPlaintext_str ?? ""} error={!!err.pw}
                  onChange={(e) => { const v = e.currentTarget.value; setF((s) => ({ ...s, MemberPasswordPlaintext_str: v })); }} data-testid="farm-member-password" />
              )
            )}</FormRow>
          </FormSection>
          <FormSection title="Public Address" description="Where the controller sends clients that are assigned to this member.">
            <FormRow label={<HelpLabel label="Public IP address" doc={DOC.PublicIp} />} error={err.ip}>{(id) => (
              <TextInput id={id} w={200} placeholder="Automatic" value={f.PublicIp_ip ?? ""} spellCheck={false} error={!!err.ip}
                onChange={(e) => { const v = e.currentTarget.value.trim(); setF((s) => ({ ...s, PublicIp_ip: v })); }} data-testid="farm-public-ip" />
            )}</FormRow>
            <FormRow label={<HelpLabel label="Public ports" doc={DOC.Ports} />} description="Press Return after each port." error={err.ports}>{(id) => (
              <TagsInput id={id} w={320} value={ports} onChange={setPorts} data={suggested} error={!!err.ports} data-testid="farm-ports" />
            )}</FormRow>
          </FormSection>
        </>
      )}

      <SaveBar
        dirty={dirty} disabled={invalid} saving={save.isPending} onReset={reset} saveLabel="Apply…" testId="save-farm"
        note={invalid ? "Fix the highlighted settings to apply them." : "Applying restarts the VPN Server."}
        onSave={() => save.mutate(payload())}
      />
    </form>
  );
}

function MemberInspector({ serverId, id, onClose }: { serverId: number; id: number | null; onClose: () => void }) {
  const q = useRpc<FarmInfo>(serverId, "GetFarmInfo", { Id_u32: id ?? 0 }, { enabled: id !== null });
  const [fp, setFp] = useState("");
  useEffect(() => {
    setFp("");
    if (q.data?.ServerCert_bin) void fingerprint256(b64ToBytes(q.data.ServerCert_bin)).then(setFp).catch(() => undefined);
  }, [q.data]);
  const d = q.data;
  return (
    <Inspector opened={id !== null} onClose={onClose} width={400} testId="farm-member-inspector"
      title={d?.Hostname_str ?? "Cluster member"} subtitle={d ? (d.Controller_bool ? "Cluster controller" : "Cluster member") : undefined}
      icon={d?.Controller_bool ? <IconTopologyStar3 size={18} stroke={1.5} /> : <IconServer2 size={18} stroke={1.5} />}>
      <QueryState query={q} skeleton={<PropertySkeleton rows={8} />} inline>
        {d && (
          <div className="sem-stack">
            <PropertyList labelWidth={130} items={[
              { label: "IP address", value: <Mono>{d.Ip_ip}</Mono> },
              { label: "Public ports", value: (d.Ports_u32 ?? []).length ? <span className="sem-chips">{d.Ports_u32!.map((p) => <Tag key={p} variant="outline">{p}</Tag>)}</span> : undefined },
              { label: "Connected", value: <span title={dt(d.ConnectedTime_dt)}>{ago(d.ConnectedTime_dt)}</span> },
              { label: "Free capacity", value: num(d.Point_u32), hint: "SoftEther’s point score: free session capacity scaled by the weight. New sessions go to the server with the highest score." },
              { label: "Weight", value: num(d.Weight_u32) },
              { label: "Sessions", value: num(d.NumSessions_u32) },
              { label: "TCP connections", value: num(d.NumTcpConnections_u32) },
            ]} />
            <div>
              <div className="sem-section-title" style={{ marginBottom: 6 }}>Hosted Virtual Hubs <span className="sem-dim">({num(d.NumFarmHub_u32 ?? d.HubsList?.length ?? 0)})</span></div>
              {(d.HubsList ?? []).length === 0 ? <span className="sem-dim">None</span> : (
                <span className="sem-chips">{d.HubsList!.map((h) => <Tag key={h.HubName_str} color={h.DynamicHub_bool ? "purple" : "accent"} title={h.DynamicHub_bool ? "Dynamic hub" : "Static hub"}>{h.HubName_str}</Tag>)}</span>
              )}
            </div>
            {fp && <FingerprintField value={fp} label="Server certificate (SHA-256)" testId="farm-member-fp" />}
          </div>
        )}
      </QueryState>
    </Inspector>
  );
}

function MembersSection({ serverId, enabled }: { serverId: number; enabled: boolean }) {
  const q = useRpc<{ FarmMemberList?: FarmItem[] }>(serverId, "EnumFarmMember", {}, { enabled, refetchInterval: 15_000, retry: false });
  const [sel, setSel] = useState<number | null>(null);
  const copy = (t: string) => void navigator.clipboard.writeText(t).catch(() => undefined);
  const menu = (r: FarmItem): ContextMenuItem[] => [
    { label: "Show Details", icon: <IconInfoCircle size={14} />, onClick: () => setSel(r.Id_u32), testId: "farm-member-details" },
    "divider",
    { label: "Copy IP Address", icon: <IconCopy size={14} />, onClick: () => copy(r.Ip_ip) },
    { label: "Copy Host Name", icon: <IconCopy size={14} />, onClick: () => copy(r.Hostname_str) },
  ];
  return (
    <Section title="Cluster Members" description="Every server of the cluster, including this controller. Double-click a server for its details.">
      <DataTable
        testId="farm-members-table" aria-label="Cluster members"
        data={q.data?.FarmMemberList} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}
        rowKey={(r) => r.Id_u32} selectable="single" onRowOpen={(r) => setSel(r.Id_u32)} contextMenu={menu}
        searchable={(q.data?.FarmMemberList?.length ?? 0) > 8}
        rowTestId={(r) => `farm-member-${r.Id_u32}`}
        initialSort={{ key: "Controller_bool", dir: "desc" }}
        empty={{ title: "No members connected", description: "Members appear here once they join this controller.", icon: <IconServer2 size={26} stroke={1.4} /> }}
        columns={[
          { key: "Hostname_str", title: "Server", render: (r) => <span className="sem-strong">{r.Hostname_str}</span> },
          { key: "Controller_bool", title: "Role", width: 110, value: (r) => (r.Controller_bool ? 1 : 0),
            render: (r) => r.Controller_bool ? <Tag color="accent" icon={<IconTopologyStar3 size={11} />}>Controller</Tag> : <Tag icon={<IconServer2 size={11} />}>Member</Tag> },
          { key: "Ip_ip", title: "IP address", mono: true, width: 130 },
          { key: "ConnectedTime_dt", title: "Connected", width: 100, render: (r) => <span className="sem-dim" title={dt(r.ConnectedTime_dt)}>{agoShort(r.ConnectedTime_dt)}</span> },
          { key: "Point_u32", title: "Score", align: "right", width: 70, render: (r) => <span className="sem-num" title="Free capacity (point): new sessions go to the server with the highest score">{num(r.Point_u32)}</span> },
          { key: "NumSessions_u32", title: "Sessions", align: "right", width: 80, render: (r) => num(r.NumSessions_u32) },
          { key: "NumTcpConnections_u32", title: "TCP", align: "right", width: 60, render: (r) => num(r.NumTcpConnections_u32) },
          { key: "NumHubs_u32", title: "Hubs", align: "right", width: 60, render: (r) => num(r.NumHubs_u32) },
          { key: "AssignedClientLicense_u32", title: "Licenses", align: "right", width: 90,
            render: (r) => <span title="Client / bridge licenses" className="sem-num">{num(r.AssignedClientLicense_u32)} / {num(r.AssignedBridgeLicense_u32)}</span> },
        ]}
      />
      <MemberInspector serverId={serverId} id={sel} onClose={() => setSel(null)} />
    </Section>
  );
}

function ControllerConnectionSection({ serverId, enabled }: { serverId: number; enabled: boolean }) {
  const q = useRpc<FarmConn>(serverId, "GetFarmConnectionStatus", {}, { enabled, refetchInterval: 10_000, retry: false });
  const catalog = useCatalog();
  const d = q.data;
  const errText = (c: number) => `${catalog.data?.errors[String(c)] ?? "Error"} (SoftEther error ${c})`;
  return (
    <Section title="Connection to Controller" description="Refreshes every 10 seconds." variant="inset" testId="farm-connection">
      {q.error ? <ErrorState error={q.error} inline onRetry={() => void q.refetch()} /> : !d ? <PropertySkeleton rows={6} /> : (
        <PropertyList labelWidth={170} items={[
          { label: "Status", value: <StatusBadge status={d.Online_bool ? "ok" : "error"}>{d.Online_bool ? "Connected" : "Disconnected"}</StatusBadge> },
          { label: "Controller", value: <Mono>{d.Ip_ip}:{d.Port_u32}</Mono> },
          { label: "Last error", value: d.LastError_u32 ? <span className="sem-text-red">{errText(d.LastError_u32)}</span> : "None" },
          { label: "Connected since", value: d.Online_bool ? <span title={dt(d.CurrentConnectedTime_dt)}>{ago(d.CurrentConnectedTime_dt)}</span> : undefined },
          { label: "First connected", value: dt(d.FirstConnectedTime_dt) },
          { label: "Trying since", value: dt(d.StartedTime_dt) },
          { label: "Attempts", value: <span className="sem-num">{num(d.NumTry_u32)} tried · {num(d.NumConnected_u32)} succeeded · {num(d.NumFailed_u32)} failed</span> },
        ]} />
      )}
    </Section>
  );
}

export default function ClusterPage() {
  const { serverId } = useScope();
  const { s, reachable } = useReachable(serverId);
  const enabled = !!s && reachable;
  const farm = useRpc<Farm>(serverId, "GetFarmSetting", {}, { enabled });
  const type = farm.data?.ServerType_u32;
  const label = useMemo(() => TYPES.find((t) => Number(t.value) === type)?.long, [type]);
  return (
    <>
      <PageHeader
        title="Clustering"
        badge={label && <Tag color={type ? "accent" : "gray"} testId="farm-current-type">{label}</Tag>}
        description="Run this VPN Server on its own, as the controller of a cluster, or as a member of one."
      />
      {s && !reachable ? <Unreachable serverId={serverId} /> : (
        <>
          {type === 0 && (
            <div className="sem-callouts">
              <Callout tone="gray" icon={<IconTopologyStar3 size={16} stroke={1.7} />} testId="farm-standalone">
                This server isn’t part of a cluster. Its members, or its link to a controller, appear here once it has a cluster role.
              </Callout>
            </div>
          )}
          {type === 1 && <MembersSection serverId={serverId} enabled={enabled} />}
          {type === 2 && <ControllerConnectionSection serverId={serverId} enabled={enabled} />}
          <FarmSettings serverId={serverId} serverName={s?.name ?? ""} enabled={enabled} />
        </>
      )}
    </>
  );
}
