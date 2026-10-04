// Server › DDNS & VPN Azure: SoftEther's free cloud services. Dynamic DNS status and hostname
// (GetDDnsClientStatus / ChangeDDnsClientHostname), VPN Azure (Get/SetAzureStatus) and how the server reaches
// both services (Get/SetDDnsInternetSetting).
import { useEffect, useState } from "react";
import { Button, NumberInput, PasswordInput, SegmentedControl, Switch, TextInput } from "@mantine/core";
import { IconCloud, IconCloudOff, IconPencil, IconWorld } from "@tabler/icons-react";
import { fieldDoc, notifySuccess, useCaps, useCatalog, useRpc, useRpcMutation, useScope } from "../../lib/hooks";
import {
  CopyField, EmptyState, ErrorState, FormRow, FormSection, Mono, PageHeader, PropertyList, PropertySkeleton, QueryState, Section, SectionGrid, StatusBadge,
  confirmAction,
} from "../../design";
import { Callout } from "../../components/domain/ui";
import { ApplyBar, FormSheet, Unreachable, useServerPage } from "./_server-network/shared";

interface DdnsStatus {
  Err_IPv4_u32: number; ErrStr_IPv4_utf: string; Err_IPv6_u32: number; ErrStr_IPv6_utf: string;
  CurrentHostName_str: string; CurrentFqdn_str: string; DnsSuffix_str: string; CurrentIPv4_str: string; CurrentIPv6_str: string;
}
interface Azure { IsEnabled_bool: boolean; IsConnected_bool: boolean }
interface InternetSetting {
  ProxyType_u32: number; ProxyHostName_str: string; ProxyPort_u32: number; ProxyUsername_str: string; ProxyPassword_str: string;
  CustomHttpHeader_str?: string; [k: string]: unknown;
}

const PROXY_TYPES = [
  { value: "0", label: "Direct" },
  { value: "1", label: "HTTP Proxy" },
  { value: "2", label: "SOCKS Proxy" },
];
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,29}[A-Za-z0-9]$/;

/** Registration result for one address family: OK, or the server's error text with its code. */
function Registration({ code, text, testId }: { code: number; text: string; testId?: string }) {
  if (!code) return <StatusBadge status="ok" testId={testId}>Registered</StatusBadge>;
  return <StatusBadge status={code === 47 ? "busy" : "error"} tooltip={`SoftEther error ${code}`} testId={testId}>{text || `Error ${code}`}</StatusBadge>;
}

export default function DdnsPage() {
  const { serverId } = useScope();
  const { s, reachable, live } = useServerPage(serverId);
  const caps = useCaps(serverId);
  // true / false once GetCaps answered; undefined while it loads. If GetCaps fails, assume support (the calls then
  // show their own errors). SoftEther reports b_support_ddns only while its DDNS client exists: with
  // "bool Disabled true" in the DDnsClient section there is no DDNS client, no VPN Azure client and no proxy setting,
  // and every call below would fail with "not supported", so they aren't made.
  const cap = (n: string): boolean | undefined => (caps.error ? true : caps.isLoading || !caps.data ? undefined : caps.has(n));
  const ddnsOn = cap("b_support_ddns");
  const ddns = useRpc<DdnsStatus>(serverId, "GetDDnsClientStatus", {}, { refetchInterval: 30_000, enabled: live && ddnsOn === true });
  if (!s) return null;
  return (
    <>
      <PageHeader
        title="DDNS & VPN Azure"
        meta={ddns.data?.CurrentFqdn_str ? <>Reachable as <Mono>{ddns.data.CurrentFqdn_str}</Mono></> : ddnsOn === false ? "Turned off" : undefined}
        description="Free SoftEther cloud services that give the server a permanent name and let clients reach it through NAT and firewalls without port forwarding."
      />
      {!reachable ? <Unreachable serverId={serverId} /> : ddnsOn === false ? (
        <div className="sem-unreachable" data-testid="ddns-disabled">
          <EmptyState
            icon={<IconCloudOff size={30} stroke={1.4} />}
            title="Dynamic DNS is turned off on this server"
            description={<>
              Its configuration disables the Dynamic DNS client (<Mono>bool Disabled true</Mono> in the <Mono>DDnsClient</Mono> section),
              so VPN Azure and the cloud connection settings aren’t available either. To turn it on, set it to <Mono>false</Mono> in
              Configuration and restart the server.
            </>}
          />
        </div>
      ) : (
        <>
          <SectionGrid>
            <DdnsSection serverId={serverId} q={ddns} />
            <AzureSection serverId={serverId} live={live} supported={cap("b_support_azure")} hostname={ddns.data?.CurrentHostName_str} />
          </SectionGrid>
          <ProxySection serverId={serverId} live={live} supported={cap("b_support_ddns_proxy")} />
        </>
      )}
    </>
  );
}

function DdnsSection({ serverId, q }: { serverId: number; q: ReturnType<typeof useRpc<DdnsStatus>> }) {
  const [editing, setEditing] = useState(false);
  const d = q.data;
  return (
    <Section
      title={<span className="sem-row-inline" style={{ flexWrap: "nowrap" }}><IconWorld size={15} stroke={1.7} className="sem-dim" />Dynamic DNS</span>}
      description="A permanent hostname that follows the server’s public IP address."
      actions={d && <Button size="xs" variant="default" leftSection={<IconPencil size={13} />} onClick={() => setEditing(true)} data-testid="ddns-change-hostname">Change Hostname…</Button>}
      variant="inset" testId="ddns-status"
    >
      {q.error ? <ErrorState error={q.error} inline onRetry={() => void q.refetch()} /> : !d ? <PropertySkeleton rows={7} /> : (
        <PropertyList labelWidth={124} items={[
          { label: "Hostname", value: d.CurrentHostName_str ? <span className="sem-strong">{d.CurrentHostName_str}</span> : <span className="sem-dim">Not assigned yet</span> },
          { label: "Full name", value: d.CurrentFqdn_str ? <CopyField value={d.CurrentFqdn_str} size="sm" /> : undefined },
          { label: "DNS suffix", value: d.DnsSuffix_str ? <Mono>{d.DnsSuffix_str}</Mono> : undefined },
          { label: "Public IPv4", value: d.CurrentIPv4_str ? <CopyField value={d.CurrentIPv4_str} size="sm" /> : <span className="sem-dim">None detected</span> },
          { label: "Public IPv6", value: d.CurrentIPv6_str ? <CopyField value={d.CurrentIPv6_str} size="sm" /> : <span className="sem-dim">None detected</span> },
          { label: "IPv4 status", value: <Registration code={d.Err_IPv4_u32} text={d.ErrStr_IPv4_utf} testId="ddns-ipv4" /> },
          { label: "IPv6 status", value: <Registration code={d.Err_IPv6_u32} text={d.ErrStr_IPv6_utf} /> },
        ]} />
      )}
      {d && <ChangeHostnameSheet serverId={serverId} d={d} opened={editing} onClose={() => setEditing(false)} />}
    </Section>
  );
}

function ChangeHostnameSheet({ serverId, d, opened, onClose }: { serverId: number; d: DdnsStatus; opened: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  useEffect(() => { if (opened) setName(d.CurrentHostName_str ?? ""); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = useRpcMutation<{ StrValue_str: string }>(serverId, "ChangeDDnsClientHostname", {
    success: "Dynamic DNS hostname changed", onSuccess: onClose,
    confirm: (p) => ({
      title: "Change the Dynamic DNS hostname?",
      message: <>The server’s name changes from <b>{d.CurrentFqdn_str || "(none)"}</b> to <b>{p.StrValue_str}{d.DnsSuffix_str}</b>, and the old name is released. Clients, bridges and VPN Azure settings that use the old name must be updated.</>,
      confirmLabel: "Change Hostname", tone: "warning", testId: "ddns-change",
    }),
  });
  const n = name.trim();
  const err = !n ? null : !HOST_RE.test(n) ? "Use 3–31 letters, digits and hyphens, not starting or ending with a hyphen." : null;
  const same = n.toLowerCase() === (d.CurrentHostName_str ?? "").toLowerCase();
  return (
    <FormSheet
      opened={opened} onClose={onClose} busy={change.isPending} size={520}
      title="Change Dynamic DNS Hostname" subtitle="The name must not be registered by another server."
      icon={<IconWorld size={19} stroke={1.5} />}
      submitLabel="Change Hostname" submitTestId="ddns-hostname-submit" testId="ddns-hostname-sheet" valid={!!n && !err && !same}
      onSubmit={() => change.mutate({ StrValue_str: n })}
    >
      <FormSection>
        <FormRow label="Hostname" description={<>The full name becomes <Mono>{n || "hostname"}{d.DnsSuffix_str || ".softether.net"}</Mono>.</>} error={err}>
          {(id) => <TextInput id={id} value={name} onChange={(e) => setName(e.currentTarget.value)} error={!!err} data-autofocus spellCheck={false}
            rightSection={d.DnsSuffix_str ? <span className="sem-dim" style={{ fontSize: "var(--sem-fz-small)", whiteSpace: "nowrap" }}>{d.DnsSuffix_str}</span> : undefined}
            rightSectionWidth={d.DnsSuffix_str ? 120 : undefined} data-testid="ddns-hostname" />}
        </FormRow>
      </FormSection>
      <p className="sem-form-section-footer">
        To turn Dynamic DNS off entirely, set <Mono>bool Disabled true</Mono> in the <Mono>DDnsClient</Mono> section of the server configuration and restart the server.
      </p>
    </FormSheet>
  );
}

function AzureSection({ serverId, live, supported, hostname }: { serverId: number; live: boolean; supported: boolean | undefined; hostname?: string }) {
  // Clustered servers (and bridges) have no VPN Azure client: GetAzureStatus would only fail with "not supported".
  const q = useRpc<Azure>(serverId, "GetAzureStatus", {}, { refetchInterval: 15_000, enabled: live && supported === true });
  const set = useRpcMutation<{ IsEnabled_bool: boolean }>(serverId, "SetAzureStatus", { success: false, confirm: false });
  const a = q.data;
  const azureName = hostname ? `${hostname}.vpnazure.net` : undefined;
  const toggle = async (on: boolean) => {
    const ok = await confirmAction(on ? {
      title: "Turn on VPN Azure?",
      message: <>The server keeps an outbound connection to the VPN Azure cloud and accepts VPN connections at <b>{azureName ?? "<hostname>.vpnazure.net"}</b>. Not available for clustered servers.</>,
      confirmLabel: "Turn On", tone: "default", testId: "azure-toggle",
    } : {
      title: "Turn off VPN Azure?",
      message: "Clients that connect through the VPN Azure relay are disconnected and can’t reach the server that way any more.",
      confirmLabel: "Turn Off", tone: "warning", testId: "azure-toggle",
    });
    if (!ok) return;
    set.mutate({ IsEnabled_bool: on }, { onSuccess: () => notifySuccess(on ? "VPN Azure turned on" : "VPN Azure turned off") });
  };
  return (
    <Section
      title={<span className="sem-row-inline" style={{ flexWrap: "nowrap" }}><IconCloud size={15} stroke={1.7} className="sem-dim" />VPN Azure</span>}
      description="A cloud relay: clients, including Windows’ built-in SSTP client, reach the server without a public IP address."
      variant="inset" testId="azure-status"
    >
      {supported === false ? (
        <div className="sem-callouts" style={{ marginTop: 0 }}>
          <Callout tone="gray" testId="azure-unsupported">VPN Azure isn’t available on this server. It works only on a standalone VPN Server, not in a cluster.</Callout>
        </div>
      ) : q.error ? <ErrorState error={q.error} inline onRetry={() => void q.refetch()} /> : !a ? <PropertySkeleton rows={3} /> : (
        <PropertyList labelWidth={124} items={[
          {
            label: "VPN Azure",
            value: (
              <Switch checked={a.IsEnabled_bool} disabled={set.isPending} onChange={(e) => void toggle(e.currentTarget.checked)}
                label={a.IsEnabled_bool ? "On" : "Off"} aria-label="VPN Azure" data-testid="azure-toggle" />
            ),
          },
          {
            label: "Cloud relay",
            value: !a.IsEnabled_bool ? <span className="sem-dim">–</span>
              : a.IsConnected_bool ? <StatusBadge status="ok">Connected</StatusBadge> : <StatusBadge status="busy">Connecting…</StatusBadge>,
          },
          { label: "Hostname", value: azureName ? <CopyField value={azureName} size="sm" /> : <span className="sem-dim">Needs a Dynamic DNS hostname</span> },
        ]} />
      )}
    </Section>
  );
}

function ProxySection({ serverId, live, supported }: { serverId: number; live: boolean; supported: boolean | undefined }) {
  const catalog = useCatalog();
  const q = useRpc<InternetSetting>(serverId, "GetDDnsInternetSetting", {}, { enabled: live && supported === true });
  const [v, setV] = useState<InternetSetting | null>(null);
  useEffect(() => { if (q.data) setV({ ...q.data }); }, [q.data]);
  const doc = (f: string) => fieldDoc(catalog.data, "VpnInternetSetting", f);
  const direct = v?.ProxyType_u32 === 0;
  const kind = v?.ProxyType_u32 === 2 ? "SOCKS" : "HTTP";
  const hostErr = v && !direct && !v.ProxyHostName_str.trim() ? "Enter the proxy’s host name." : null;
  const portErr = v && !direct && !(v.ProxyPort_u32 >= 1 && v.ProxyPort_u32 <= 65535) ? "Enter a port from 1 to 65535." : null;
  const dirty = !!v && !!q.data && JSON.stringify(v) !== JSON.stringify(q.data);
  const up = (patch: Partial<InternetSetting>) => setV((x) => (x ? { ...x, ...patch } : x));
  const save = useRpcMutation(serverId, "SetDDnsInternetSetting", {
    success: "Internet connection settings saved",
    confirm: () => ({
      title: "Change how the server reaches the cloud services?",
      message: <>Dynamic DNS and VPN Azure will connect {direct ? <b>directly</b> : <>through the {kind} proxy <b>{v?.ProxyHostName_str}:{v?.ProxyPort_u32}</b></>}. A wrong setting makes DDNS registration and VPN Azure fail.</>,
      confirmLabel: "Save", tone: "default", testId: "ddns-proxy-save",
    }),
  });

  return (
    <Section title="Internet connection" description="How the server reaches the Dynamic DNS and VPN Azure services. Use a proxy when it has no direct Internet access.">
      {supported === undefined ? <PropertySkeleton rows={4} /> : supported === false ? (
        <div className="sem-callouts" style={{ marginTop: 0 }}>
          <Callout tone="gray" testId="ddns-proxy-unsupported">This server doesn’t support reaching the cloud services through a proxy.</Callout>
        </div>
      ) : (
      <QueryState query={q} inline skeleton={<PropertySkeleton rows={4} />}>
        {v && (
          <>
            <FormSection>
              <FormRow label="Connect" description={doc("ProxyType_u32")}>
                <SegmentedControl data={PROXY_TYPES} value={String(v.ProxyType_u32)} onChange={(x) => up({ ProxyType_u32: Number(x) })} aria-label="Connection method" data-testid="ddns-proxy-type" />
              </FormRow>
              {!direct && (
                <>
                  <FormRow label="Proxy server" error={hostErr ?? portErr}>
                    {(id) => (
                      <div className="sem-row-inline" style={{ flexWrap: "nowrap", width: "100%" }}>
                        <TextInput id={id} style={{ flex: 1 }} value={v.ProxyHostName_str} onChange={(e) => up({ ProxyHostName_str: e.currentTarget.value })}
                          error={!!hostErr} placeholder="proxy.example.com" spellCheck={false} aria-label="Proxy host name" data-testid="ddns-proxy-host" />
                        <span className="sem-dim">:</span>
                        <NumberInput w={96} value={v.ProxyPort_u32 || ""} min={1} max={65535} allowDecimal={false} allowNegative={false}
                          onChange={(x) => up({ ProxyPort_u32: Number(x) || 0 })} error={!!portErr} placeholder={v.ProxyType_u32 === 2 ? "1080" : "8080"}
                          aria-label="Proxy port" hideControls data-testid="ddns-proxy-port" />
                      </div>
                    )}
                  </FormRow>
                  <FormRow label="User name" description="Optional.">
                    {(id) => <TextInput id={id} value={v.ProxyUsername_str} onChange={(e) => up({ ProxyUsername_str: e.currentTarget.value })} autoComplete="off" spellCheck={false} data-testid="ddns-proxy-user" />}
                  </FormRow>
                  <FormRow label="Password" description="Optional.">
                    {(id) => <PasswordInput id={id} value={v.ProxyPassword_str} onChange={(e) => up({ ProxyPassword_str: e.currentTarget.value })} autoComplete="new-password" data-testid="ddns-proxy-password" />}
                  </FormRow>
                  {"CustomHttpHeader_str" in v && v.ProxyType_u32 === 1 && (
                    <FormRow label="Custom HTTP header" description="Sent to the HTTP proxy, for proxies that require a specific header. Leave empty if unsure.">
                      {(id) => <TextInput id={id} value={String(v.CustomHttpHeader_str ?? "")} onChange={(e) => up({ CustomHttpHeader_str: e.currentTarget.value })}
                        spellCheck={false} placeholder="X-Header: value" data-testid="ddns-proxy-header" />}
                    </FormRow>
                  )}
                </>
              )}
            </FormSection>
            <ApplyBar
              dirty={dirty} valid={!hostErr && !portErr} saving={save.isPending} applyLabel="Save" testId="ddns-proxy-save"
              onRevert={() => q.data && setV({ ...q.data })}
              onApply={() => save.mutate({ ...q.data, ...v })}
            />
          </>
        )}
      </QueryState>
      )}
    </Section>
  );
}
