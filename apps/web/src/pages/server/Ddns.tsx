import { useEffect, useState } from "react";
import {
  Alert, Badge, Button, Group, NumberInput, PasswordInput, SegmentedControl, SimpleGrid, Stack, Switch, Text, TextInput,
} from "@mantine/core";
import { IconCloud, IconDeviceFloppy, IconPencil, IconRefresh, IconWorld } from "@tabler/icons-react";
import { ConfirmButton, Copyable, ErrorAlert, KeyValue, PageHeader, QueryState, ReadOnlyNotice, Section } from "../../components/common";
import { fieldDoc } from "../../components/server-a/shared";
import { can, useCaps, useCatalog, useRpc, useRpcMutation, useScope, useServer } from "../../lib/hooks";

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
  { value: "0", label: "Direct connection" },
  { value: "1", label: "HTTP proxy" },
  { value: "2", label: "SOCKS proxy" },
];

function ErrLine({ code, text }: { code: number; text: string }) {
  if (!code) return <Badge color="green" variant="light">OK</Badge>;
  return <Group gap={6}><Badge color="red" variant="light">Error {code}</Badge><Text size="sm">{text}</Text></Group>;
}

function DdnsSection({ serverId, canWrite, supported }: { serverId: number; canWrite: boolean; supported: boolean }) {
  const q = useRpc<DdnsStatus>(serverId, "GetDDnsClientStatus", {}, { refetchInterval: 30_000 });
  const change = useRpcMutation(serverId, "ChangeDDnsClientHostname", { success: "DDNS hostname changed", onSuccess: () => setEditing(false) });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const d = q.data;
  const n = name.trim();
  const err = !n ? null : !/^[A-Za-z0-9][A-Za-z0-9-]{1,29}[A-Za-z0-9]$/.test(n) ? "3–31 characters: letters, digits and hyphens (not at the start or end)" : null;

  return (
    <Section
      title={<Group gap="xs"><IconWorld size={18} /><span>Dynamic DNS</span></Group>}
      description="SoftEther's free Dynamic DNS service gives this server a permanent hostname that follows its public IP address, even on a dynamic IP."
      actions={<Button variant="subtle" size="xs" leftSection={<IconRefresh size={14} />} onClick={() => q.refetch()} loading={q.isFetching}>Refresh</Button>}
    >
      {!supported && <Alert color="gray" mb="sm">This server does not report Dynamic DNS support (b_support_ddns).</Alert>}
      {q.error ? <ErrorAlert error={q.error} /> : (
        <QueryState query={q}>
          {d && (
            <Stack>
              <KeyValue rows={[
                ["Hostname", d.CurrentHostName_str ? <Text fw={600} size="sm">{d.CurrentHostName_str}</Text> : <Text c="dimmed" size="sm">Not assigned yet</Text>],
                ["Fully-qualified domain name", d.CurrentFqdn_str ? <Copyable value={d.CurrentFqdn_str} /> : "–"],
                ["DNS suffix", d.DnsSuffix_str || "–"],
                ["VPN Azure hostname", d.CurrentHostName_str ? <Copyable value={`${d.CurrentHostName_str}.vpnazure.net`} /> : "–"],
                ["Public IPv4 address", d.CurrentIPv4_str ? <Copyable value={d.CurrentIPv4_str} /> : <Text c="dimmed" size="sm">None detected</Text>],
                ["Public IPv6 address", d.CurrentIPv6_str ? <Copyable value={d.CurrentIPv6_str} /> : <Text c="dimmed" size="sm">None detected</Text>],
                ["IPv4 registration", <ErrLine code={d.Err_IPv4_u32} text={d.ErrStr_IPv4_utf} />],
                ["IPv6 registration", <ErrLine code={d.Err_IPv6_u32} text={d.ErrStr_IPv6_utf} />],
              ]} />
              {canWrite && !editing && (
                <Group>
                  <Button variant="light" size="xs" leftSection={<IconPencil size={14} />} onClick={() => { setName(d.CurrentHostName_str ?? ""); setEditing(true); }} data-testid="ddns-change-hostname">Change hostname</Button>
                </Group>
              )}
              {editing && (
                <form onSubmit={(e) => { e.preventDefault(); }}>
                  <Stack gap="xs">
                    <TextInput
                      label="New DDNS hostname"
                      description={`The FQDN becomes <hostname>${d.DnsSuffix_str || ".softether.net"}. The name must not be registered by another server.`}
                      value={name} onChange={(e) => setName(e.currentTarget.value)} error={err} rightSection={<Text size="xs" c="dimmed" pr={8}>{d.DnsSuffix_str}</Text>} rightSectionWidth={120}
                      data-autofocus data-testid="ddns-hostname"
                    />
                    <Group justify="flex-end">
                      <Button variant="default" size="xs" onClick={() => setEditing(false)}>Cancel</Button>
                      <ConfirmButton
                        title="Change DDNS hostname?" color="orange" variant="filled" size="xs"
                        disabled={!n || !!err || n.toLowerCase() === d.CurrentHostName_str.toLowerCase()}
                        message={<>The server's DNS name changes from <b>{d.CurrentFqdn_str || "(none)"}</b> to <b>{n}{d.DnsSuffix_str}</b>. VPN clients, bridges and the VPN Azure hostname that use the old name must be updated. The old name is released.</>}
                        confirmLabel="Change hostname"
                        onConfirm={() => change.mutateAsync({ StrValue_str: n })}
                      >Save</ConfirmButton>
                    </Group>
                  </Stack>
                </form>
              )}
              <Text size="xs" c="dimmed">To disable Dynamic DNS entirely, set <code>bool Disable true</code> in the <code>DDnsClient</code> section of the server configuration and restart the server.</Text>
            </Stack>
          )}
        </QueryState>
      )}
    </Section>
  );
}

function AzureSection({ serverId, isAdmin, supported, hostname }: { serverId: number; isAdmin: boolean; supported: boolean; hostname?: string }) {
  const q = useRpc<Azure>(serverId, "GetAzureStatus", {}, { refetchInterval: 15_000 });
  const set = useRpcMutation(serverId, "SetAzureStatus", { success: "VPN Azure setting saved" });
  const a = q.data;
  return (
    <Section
      title={<Group gap="xs"><IconCloud size={18} /><span>VPN Azure</span></Group>}
      description="VPN Azure is a free cloud relay by SoftEther Corporation: clients (including the built-in Windows SSTP client) reach this server through the cloud without a public IP or firewall changes."
    >
      {!supported && <Alert color="gray" mb="sm">This server does not report VPN Azure support (b_support_azure).</Alert>}
      {q.error ? <ErrorAlert error={q.error} /> : (
        <QueryState query={q}>
          {a && (
            <Stack>
              <KeyValue rows={[
                ["Function", <Badge color={a.IsEnabled_bool ? "green" : "gray"} variant="light">{a.IsEnabled_bool ? "Enabled" : "Disabled"}</Badge>],
                ["Cloud connection", a.IsEnabled_bool ? <Badge color={a.IsConnected_bool ? "green" : "orange"} variant="light">{a.IsConnected_bool ? "Connected" : "Connecting / not connected"}</Badge> : "–"],
                ["Hostname", hostname ? <Copyable value={`${hostname}.vpnazure.net`} /> : "–"],
              ]} />
              {isAdmin && (
                <Group>
                  <ConfirmButton
                    title={a.IsEnabled_bool ? "Disable VPN Azure?" : "Enable VPN Azure?"}
                    color={a.IsEnabled_bool ? "red" : "blue"} variant="light" size="xs"
                    message={a.IsEnabled_bool
                      ? "Clients connecting through the VPN Azure relay will be disconnected and can no longer reach this server that way."
                      : <>The server will keep an outbound connection to the VPN Azure cloud and accept VPN connections at <b>{hostname ? `${hostname}.vpnazure.net` : "<ddns-hostname>.vpnazure.net"}</b>. Not available for servers operating in a cluster.</>}
                    confirmLabel={a.IsEnabled_bool ? "Disable" : "Enable"}
                    onConfirm={() => set.mutateAsync({ IsEnabled_bool: !a.IsEnabled_bool })}
                  >{a.IsEnabled_bool ? "Disable VPN Azure" : "Enable VPN Azure"}</ConfirmButton>
                </Group>
              )}
            </Stack>
          )}
        </QueryState>
      )}
    </Section>
  );
}

function ProxySection({ serverId, isAdmin, supported }: { serverId: number; isAdmin: boolean; supported: boolean }) {
  const catalog = useCatalog();
  const q = useRpc<InternetSetting>(serverId, "GetDDnsInternetSetting");
  const save = useRpcMutation(serverId, "SetDDnsInternetSetting", { success: "Proxy settings saved" });
  const [v, setV] = useState<InternetSetting | null>(null);
  useEffect(() => { if (q.data) setV({ ...q.data }); }, [q.data]);
  const doc = (f: string) => fieldDoc(catalog.data, "VpnInternetSetting", f);
  const direct = v?.ProxyType_u32 === 0;
  const hostErr = v && !direct && !v.ProxyHostName_str.trim() ? "Required for a proxy" : null;
  const portErr = v && !direct && !(v.ProxyPort_u32 >= 1 && v.ProxyPort_u32 <= 65535) ? "Port must be 1–65535" : null;
  const dirty = !!v && !!q.data && JSON.stringify(v) !== JSON.stringify(q.data);
  const up = (patch: Partial<InternetSetting>) => setV((s) => (s ? { ...s, ...patch } : s));

  return (
    <Section
      title="Internet connection for DDNS / VPN Azure"
      description="How the server reaches the Dynamic DNS and VPN Azure cloud services. Use a proxy when the server has no direct Internet access."
    >
      {!supported && <Alert color="gray" mb="sm">This server does not report support for DDNS via proxy (b_support_ddns_proxy).</Alert>}
      {q.error ? <ErrorAlert error={q.error} /> : (
        <QueryState query={q}>
          {v && (
            <form onSubmit={(e) => e.preventDefault()}>
              <Stack>
                <div>
                  <Text size="sm" fw={500} mb={4}>Connection method</Text>
                  <SegmentedControl data={PROXY_TYPES} value={String(v.ProxyType_u32)} onChange={(x) => up({ ProxyType_u32: Number(x) })} disabled={!isAdmin} data-testid="ddns-proxy-type" />
                  <Text size="xs" c="dimmed" mt={4}>{doc("ProxyType_u32")}</Text>
                </div>
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput label="Proxy host name" description={doc("ProxyHostName_str")} value={v.ProxyHostName_str} disabled={direct} readOnly={!isAdmin}
                    onChange={(e) => up({ ProxyHostName_str: e.currentTarget.value })} error={hostErr} />
                  <NumberInput label="Proxy port" description={doc("ProxyPort_u32")} value={v.ProxyPort_u32 || ""} disabled={direct} readOnly={!isAdmin}
                    min={1} max={65535} allowDecimal={false} onChange={(x) => up({ ProxyPort_u32: Number(x) || 0 })} error={portErr} placeholder={v.ProxyType_u32 === 2 ? "1080" : "8080"} />
                  <TextInput label="Proxy user name" description={`${doc("ProxyUsername_str") ?? ""} (optional)`} value={v.ProxyUsername_str} disabled={direct} readOnly={!isAdmin}
                    onChange={(e) => up({ ProxyUsername_str: e.currentTarget.value })} autoComplete="off" />
                  <PasswordInput label="Proxy password" description={`${doc("ProxyPassword_str") ?? ""} (optional)`} value={v.ProxyPassword_str} disabled={direct} readOnly={!isAdmin}
                    onChange={(e) => up({ ProxyPassword_str: e.currentTarget.value })} autoComplete="new-password" />
                </SimpleGrid>
                {"CustomHttpHeader_str" in v && v.ProxyType_u32 === 1 && (
                  <TextInput label="Custom HTTP header" description="Extra header sent to the HTTP proxy (e.g. for proxies requiring a specific User-Agent). Leave empty if unsure."
                    value={String(v.CustomHttpHeader_str ?? "")} readOnly={!isAdmin} onChange={(e) => up({ CustomHttpHeader_str: e.currentTarget.value })} />
                )}
                {isAdmin && (
                  <Group justify="flex-end">
                    <Button variant="default" size="xs" disabled={!dirty} onClick={() => q.data && setV({ ...q.data })}>Reset</Button>
                    <ConfirmButton
                      title="Save Internet connection settings?" color="blue" variant="filled" size="xs"
                      disabled={!dirty || !!hostErr || !!portErr}
                      leftSection={<IconDeviceFloppy size={14} />}
                      message={<>The Dynamic DNS and VPN Azure clients will connect {direct ? <b>directly</b> : <>through the {v.ProxyType_u32 === 1 ? "HTTP" : "SOCKS"} proxy <b>{v.ProxyHostName_str}:{v.ProxyPort_u32}</b></>}. A wrong setting will make DDNS registration and VPN Azure fail.</>}
                      confirmLabel="Save"
                      onConfirm={() => save.mutateAsync({ ...q.data, ...v })}
                    >Save</ConfirmButton>
                  </Group>
                )}
              </Stack>
            </form>
          )}
        </QueryState>
      )}
    </Section>
  );
}

export default function DdnsPage() {
  const { serverId } = useScope();
  const server = useServer(serverId);
  const role = server.data?.myRole;
  const caps = useCaps(serverId);
  const ddns = useRpc<DdnsStatus>(serverId, "GetDDnsClientStatus", {}, { refetchInterval: 30_000 });
  const canWrite = can(role, "operator");
  const capOk = (n: string) => caps.isLoading || !!caps.error || caps.has(n);
  return (
    <>
      <PageHeader title="Dynamic DNS & VPN Azure" description="Cloud services that make the server reachable by name and through NAT/firewalls without port forwarding." />
      {!canWrite && <ReadOnlyNotice role={role ?? "none"} />}
      <DdnsSection serverId={serverId} canWrite={canWrite} supported={capOk("b_support_ddns")} />
      <AzureSection serverId={serverId} isAdmin={canWrite} supported={capOk("b_support_azure")} hostname={ddns.data?.CurrentHostName_str} />
      <ProxySection serverId={serverId} isAdmin={canWrite} supported={capOk("b_support_ddns_proxy")} />
    </>
  );
}
