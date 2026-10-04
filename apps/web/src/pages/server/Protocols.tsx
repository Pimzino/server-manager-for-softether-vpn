import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Alert, Anchor, Badge, Button, Group, List, Stack, Switch, Tabs, Text, TextInput } from "@mantine/core";
import { IconDeviceFloppy, IconDownload, IconInfoCircle } from "@tabler/icons-react";
import { PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { ProtoOptionsEditor } from "../../components/server-b/ProtoOptionsEditor";
import { HelpLabel, useServerAccess } from "../../components/server-b/ui";
import { notifyError, useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import { rpc } from "../../lib/api";
import { downloadB64 } from "../../lib/format";

interface OvpnSstp { EnableOpenVPN_bool?: boolean; OpenVPNPortList_str?: string; EnableSSTP_bool?: boolean }

const DOC = {
  EnableOpenVPN: "Enable the OpenVPN Clone Server Function. Any OpenVPN client can then connect to this VPN Server. The username / default hub selection rules are the same as for the IPsec (L2TP) server.",
  OpenVPNPortList: "UDP ports to listen on for OpenVPN. Multiple ports can be separated by spaces or commas, e.g. \"1194, 2001, 2010\". The default is UDP 1194. (TCP OpenVPN connections are accepted on every TCP listener.)",
  EnableSSTP: "Enable the Microsoft SSTP VPN Clone Server Function. Windows clients connect over HTTPS (TCP 443); the certificate CN must match the host name the client dials.",
};

function parsePorts(s: string): { ports: number[]; bad: string[] } {
  const parts = s.split(/[\s,]+/).filter(Boolean);
  const ports: number[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) ports.push(n); else bad.push(p);
  }
  return { ports, bad };
}

function OpenVpnSstpSection({ serverId, canEdit }: { serverId: number; canEdit: boolean }) {
  const q = useRpc<OvpnSstp>(serverId, "GetOpenVpnSstpConfig");
  const udp = useRpc<{ Ports_u32?: number[] }>(serverId, "GetPortsUDP", {}, { retry: false });
  const [form, setForm] = useState<OvpnSstp>({});
  useEffect(() => { if (q.data) setForm(q.data); }, [q.data]);
  const save = useRpcMutation(serverId, "SetOpenVpnSstpConfig", { success: "OpenVPN / SSTP settings saved" });
  const hasPortList = q.data ? "OpenVPNPortList_str" in q.data : false;
  const ports = parsePorts(form.OpenVPNPortList_str ?? "");
  const dirty = !!q.data && (form.EnableOpenVPN_bool !== q.data.EnableOpenVPN_bool || form.EnableSSTP_bool !== q.data.EnableSSTP_bool
    || (hasPortList && form.OpenVPNPortList_str !== q.data.OpenVPNPortList_str));
  const invalid = hasPortList && !!form.EnableOpenVPN_bool && (ports.bad.length > 0 || ports.ports.length === 0);

  return (
    <Section title="OpenVPN & SSTP clone servers" description="Let stock OpenVPN clients and the Windows built-in SSTP client connect without the SoftEther client.">
      <QueryState query={q}>
        <form onSubmit={(e) => {
          e.preventDefault();
          // Start from the server's struct so fields this UI does not know about are preserved.
          save.mutate({ ...q.data, ...form, ...(hasPortList ? { OpenVPNPortList_str: ports.ports.join(", ") } : {}) });
        }}>
          <Stack gap="md">
            <Switch
              label={<HelpLabel label="Enable OpenVPN clone server" doc={DOC.EnableOpenVPN} />}
              description="Accept OpenVPN clients (UDP and TCP)."
              checked={!!form.EnableOpenVPN_bool} disabled={!canEdit}
              onChange={(e) => setForm((f) => ({ ...f, EnableOpenVPN_bool: e.currentTarget.checked }))}
              data-testid="enable-openvpn"
            />
            {hasPortList ? (
              <TextInput
                label={<HelpLabel label="OpenVPN UDP ports" doc={DOC.OpenVPNPortList} />}
                description="Separate multiple ports with commas or spaces."
                value={form.OpenVPNPortList_str ?? ""} readOnly={!canEdit} disabled={!form.EnableOpenVPN_bool}
                onChange={(e) => setForm((f) => ({ ...f, OpenVPNPortList_str: e.currentTarget.value }))}
                error={invalid ? (ports.bad.length ? `Invalid port(s): ${ports.bad.join(", ")}` : "Specify at least one UDP port") : undefined}
                maw={420} data-testid="openvpn-ports"
              />
            ) : (
              <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />}>
                This server (SoftEther 5.x) does not use a separate OpenVPN port list: OpenVPN, WireGuard and other UDP protocols
                listen on the server-wide UDP ports{" "}
                {udp.data?.Ports_u32?.length ? <>({udp.data.Ports_u32.map((p) => <Badge key={p} variant="outline" size="sm" mr={4}>{p}</Badge>)})</> : null}
                {" "}which are managed on the <Anchor component={Link} to={`/servers/${serverId}/listeners`} size="sm">Listeners & ports</Anchor> page.
                OpenVPN over TCP is accepted on every TCP listener.
              </Alert>
            )}
            <Switch
              label={<HelpLabel label="Enable Microsoft SSTP clone server" doc={DOC.EnableSSTP} />}
              description="Accept SSTP (HTTPS) connections from the Windows built-in VPN client."
              checked={!!form.EnableSSTP_bool} disabled={!canEdit}
              onChange={(e) => setForm((f) => ({ ...f, EnableSSTP_bool: e.currentTarget.checked }))}
              data-testid="enable-sstp"
            />
            {canEdit && (
              <Group justify="flex-end">
                <Button variant="default" disabled={!dirty} onClick={() => q.data && setForm(q.data)}>Reset</Button>
                <Button type="submit" loading={save.isPending} disabled={!dirty || invalid} leftSection={<IconDeviceFloppy size={16} />} data-testid="save-openvpn-sstp">Save</Button>
              </Group>
            )}
          </Stack>
        </form>
      </QueryState>
    </Section>
  );
}

function OpenVpnConfigDownload({ serverId, serverName }: { serverId: number; serverName: string }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await rpc<{ Buffer_bin?: string }>(serverId, "MakeOpenVpnConfigFile");
      if (!r.Buffer_bin) throw new Error("The server returned an empty file");
      downloadB64(`${serverName.replace(/[^\w.-]/g, "_")}-openvpn-config.zip`, r.Buffer_bin, "application/zip");
    } catch (e) {
      notifyError(e, "MakeOpenVpnConfigFile");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="OpenVPN client configuration"
      description="Generate sample .ovpn configuration files for OpenVPN clients (a ZIP with L3 / routed and L2 / bridged variants and a readme)."
      actions={<Button leftSection={<IconDownload size={16} />} loading={busy} onClick={go} data-testid="download-openvpn-config">Download OpenVPN client config</Button>}
    >
      <List size="sm" c="dimmed" spacing={4}>
        <List.Item>The generated files embed the server certificate and the host name / IP the server believes is its public address — check the <code>remote</code> line before distributing.</List.Item>
        <List.Item>Users authenticate with <code>username@HUB</code> (or just <code>username</code> for the default hub) and their Virtual Hub password.</List.Item>
        <List.Item>Regenerate the ZIP after replacing the server certificate.</List.Item>
      </List>
    </Section>
  );
}

const PROTOCOLS = ["OpenVPN", "SSTP", "WireGuard"] as const;

export default function ProtocolsPage() {
  const { serverId } = useScope();
  const { server, role, isOperator, isAdmin } = useServerAccess(serverId);
  const [tab, setTab] = useState<string | null>("OpenVPN");
  return (
    <>
      <PageHeader
        title="OpenVPN / SSTP"
        description="SoftEther VPN Server can emulate OpenVPN and Microsoft SSTP servers, so clients can connect with their native software. Per-protocol tuning options are also available below."
      />
      {!isOperator && <ReadOnlyNotice role={role} />}
      <OpenVpnSstpSection serverId={serverId} canEdit={isOperator} />
      <OpenVpnConfigDownload serverId={serverId} serverName={server.data?.name ?? "server"} />
      <Section
        title="Protocol options"
        description="Low-level per-protocol options (GetProtoOptions / SetProtoOptions). Changing them requires the admin role. All options of a protocol are written back together."
      >
        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List mb="md">
            {PROTOCOLS.map((p) => <Tabs.Tab key={p} value={p} data-testid={`proto-tab-${p}`}>{p}</Tabs.Tab>)}
          </Tabs.List>
          {PROTOCOLS.map((p) => (
            <Tabs.Panel key={p} value={p}>
              <ProtoOptionsEditor serverId={serverId} protocol={p} canEdit={isAdmin} canReveal={isAdmin} testId={`proto-options-${p}`}
                saveWarning={p === "WireGuard" ? "Changing the WireGuard private or pre-shared key disconnects every WireGuard client until their configuration is updated." : undefined} />
            </Tabs.Panel>
          ))}
        </Tabs>
      </Section>
    </>
  );
}
