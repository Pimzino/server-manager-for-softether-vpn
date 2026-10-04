// Server › OpenVPN & SSTP: the OpenVPN / Microsoft SSTP clone servers (Get/SetOpenVpnSstpConfig), the sample
// OpenVPN client configuration (MakeOpenVpnConfigFile) and the low-level per-protocol options (Get/SetProtoOptions).
import { useEffect, useState } from "react";
import { Button, Group, SegmentedControl, Switch, TextInput } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { rpc } from "../../lib/api";
import { downloadB64 } from "../../lib/format";
import { notifyError, notifySuccess, useRpc, useRpcMutation } from "../../lib/hooks";
import { ErrorState, FormRow, FormSection, PageHeader, PropertySkeleton, Section } from "../../design";
import { ProtoOptionsEditor } from "../../components/domain/ProtoOptionsEditor";
import { HelpLabel } from "../../components/domain/ui";
import { HubModeNotice, Notes, UdpPorts, Unreachable, safeName, useServerPage } from "./_server-protocols-security/shared";

interface OvpnSstp { EnableOpenVPN_bool?: boolean; OpenVPNPortList_str?: string; EnableSSTP_bool?: boolean; [k: string]: unknown }

const DOC = {
  EnableOpenVPN: "OpenVPN Clone Server Function: any OpenVPN client can connect to this VPN Server. User names and the default hub work as for L2TP/IPsec (user@HUB).",
  OpenVPNPortList: "UDP ports for OpenVPN, separated by spaces or commas, e.g. “1194, 2001”. The default is UDP 1194. OpenVPN over TCP is accepted on every TCP listener.",
  EnableSSTP: "Microsoft SSTP VPN Clone Server Function: Windows clients connect over HTTPS (TCP 443). The certificate’s common name must match the host name the client dials.",
};

function parsePorts(s: string): { ports: number[]; bad: string[] } {
  const ports: number[] = [];
  const bad: string[] = [];
  for (const p of s.split(/[\s,]+/).filter(Boolean)) {
    const n = Number(p);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) ports.push(n); else bad.push(p);
  }
  return { ports, bad };
}

function CloneServers({ serverId, enabled }: { serverId: number; enabled: boolean }) {
  const q = useRpc<OvpnSstp>(serverId, "GetOpenVpnSstpConfig", {}, { enabled });
  const [form, setForm] = useState<OvpnSstp>({});
  useEffect(() => { if (q.data) setForm(q.data); }, [q.data]);
  const save = useRpcMutation(serverId, "SetOpenVpnSstpConfig", { success: "OpenVPN and SSTP settings saved" });
  const d = q.data;
  const hasPortList = !!d && "OpenVPNPortList_str" in d;
  const ports = parsePorts(form.OpenVPNPortList_str ?? "");
  const dirty = !!d && (form.EnableOpenVPN_bool !== d.EnableOpenVPN_bool || form.EnableSSTP_bool !== d.EnableSSTP_bool
    || (hasPortList && form.OpenVPNPortList_str !== d.OpenVPNPortList_str));
  const portError = hasPortList && !!form.EnableOpenVPN_bool && (ports.bad.length || !ports.ports.length)
    ? (ports.bad.length ? `Not a port number: ${ports.bad.join(", ")}` : "Enter at least one UDP port.") : undefined;

  if (q.isLoading || (!d && !q.error)) return <FormSection title="Clone servers"><PropertySkeleton rows={3} /></FormSection>;
  if (q.error) return <Section title="Clone servers"><ErrorState error={q.error} inline onRetry={() => void q.refetch()} /></Section>;

  return (
    <FormSection
      title="Clone servers"
      testId="clone-servers"
      footer={(
        <Group justify="flex-end" gap={8}>
          <Button variant="default" disabled={!dirty || save.isPending} onClick={() => setForm(d!)} data-testid="save-openvpn-sstp-reset">Revert</Button>
          <Button disabled={!dirty || !!portError} loading={save.isPending} data-testid="save-openvpn-sstp"
            onClick={() => save.mutate({ ...d, ...form, ...(hasPortList ? { OpenVPNPortList_str: ports.ports.join(", ") } : {}) })}>
            Save
          </Button>
        </Group>
      )}
    >
      <FormRow label={<HelpLabel label="OpenVPN" doc={DOC.EnableOpenVPN} />} description="Accept stock OpenVPN clients over UDP and TCP.">
        {(id) => (
          <Switch id={id} checked={!!form.EnableOpenVPN_bool} onChange={(e) => setForm((f) => ({ ...f, EnableOpenVPN_bool: e.currentTarget.checked }))}
              aria-label="OpenVPN clone server" data-testid="enable-openvpn" />
        )}
      </FormRow>
      {hasPortList ? (
        <FormRow label={<HelpLabel label="OpenVPN UDP ports" doc={DOC.OpenVPNPortList} />} description="Separate ports with commas or spaces." error={portError}>
          {(id) => (
            <TextInput id={id} w={260} value={form.OpenVPNPortList_str ?? ""} disabled={!form.EnableOpenVPN_bool} error={!!portError}
              onChange={(e) => setForm((f) => ({ ...f, OpenVPNPortList_str: e.currentTarget.value }))} data-testid="openvpn-ports" spellCheck={false} />
          )}
        </FormRow>
      ) : (
        <FormRow label="UDP ports" description="SoftEther 5 listens for OpenVPN, WireGuard and other UDP protocols on the server-wide UDP ports. TCP works on every listener.">
          <UdpPorts serverId={serverId} enabled={enabled} testId="openvpn-udp-ports" />
        </FormRow>
      )}
      <FormRow label={<HelpLabel label="Microsoft SSTP" doc={DOC.EnableSSTP} />} description="Accept the Windows built-in VPN client over HTTPS.">
        {(id) => (
          <Switch id={id} checked={!!form.EnableSSTP_bool} onChange={(e) => setForm((f) => ({ ...f, EnableSSTP_bool: e.currentTarget.checked }))}
              aria-label="SSTP clone server" data-testid="enable-sstp" />
        )}
      </FormRow>
    </FormSection>
  );
}

const PROTOCOLS = ["OpenVPN", "SSTP", "WireGuard"] as const;

export default function ProtocolsPage() {
  const { serverId, s, reachable, hubMode, ready } = useServerPage();
  const [proto, setProto] = useState<string>("OpenVPN");
  const [busy, setBusy] = useState(false);
  const enabled = ready && !hubMode;

  const saveConfig = async () => {
    setBusy(true);
    try {
      const r = await rpc<{ Buffer_bin?: string }>(serverId, "MakeOpenVpnConfigFile");
      if (!r.Buffer_bin) throw new Error("The server returned an empty file.");
      const res = await downloadB64(`${safeName(s?.name ?? "server")}-openvpn-config.zip`, r.Buffer_bin, "application/zip");
      if (res.saved) notifySuccess("OpenVPN sample configuration saved");
    } catch (e) {
      notifyError(e, "Couldn’t create the OpenVPN configuration");
    } finally {
      setBusy(false);
    }
  };

  if (!s) return null;
  return (
    <>
      <PageHeader
        title="OpenVPN & SSTP"
        description="Let stock OpenVPN clients and the Windows built-in SSTP client connect without the SoftEther client."
        actions={enabled && (
          <Button variant="default" leftSection={<IconDownload size={14} />} loading={busy} onClick={saveConfig} data-testid="download-openvpn-config">
            Save OpenVPN Sample Config…
          </Button>
        )}
      />
      {!reachable && <Unreachable serverId={serverId} name={s.name} error={s.state?.error} checkedAt={s.state?.checkedAt} />}
      {reachable && hubMode && <HubModeNotice hub={s.hub!} what="OpenVPN and SSTP settings aren’t available." />}
      {enabled && (
        <>
          <CloneServers serverId={serverId} enabled={enabled} />

          <Section title="OpenVPN client configuration" description="The sample ZIP has routed (L3) and bridged (L2) .ovpn files and a readme.">
            <Notes>{[
              <>The files embed the server certificate and the address the server believes is public. Check the <span className="sem-code-inline">remote</span> line before you hand them out.</>,
              <>Users sign in as <span className="sem-code-inline">user@HUB</span>, or just <span className="sem-code-inline">user</span> for the default hub, with their Virtual Hub password.</>,
              <>Save a new sample after replacing the server certificate.</>,
            ]}</Notes>
          </Section>

          <Section
            title="Protocol options"
            description="Low-level options of each protocol. All options of a protocol are written back together."
            actions={(
              <SegmentedControl size="xs" value={proto} onChange={setProto} aria-label="Protocol" data-testid="proto-tabs"
                data={PROTOCOLS.map((p) => ({ value: p, label: <span data-testid={`proto-tab-${p}`}>{p}</span> }))} />
            )}
          >
            <ProtoOptionsEditor key={proto} serverId={serverId} protocol={proto} title={null} testId={`proto-options-${proto}`}
              saveWarning={proto === "WireGuard" ? "Changing the WireGuard private or pre-shared key disconnects every WireGuard client until its configuration is updated." : undefined} />
          </Section>
        </>
      )}
    </>
  );
}
