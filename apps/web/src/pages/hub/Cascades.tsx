import { useEffect, useState } from "react";
import {
  ActionIcon, Alert, Badge, Button, Code, Divider, Drawer, FileButton, Group, Modal, NumberInput, PasswordInput, Radio, Select, SimpleGrid, Stack, Switch,
  Tabs, Text, TextInput, Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCertificate, IconDownload, IconEdit, IconEye, IconPlus, IconRefresh, IconTrash, IconUpload, IconCursorText } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, ErrorAlert, PageHeader, QueryState, ReadOnlyNotice } from "../../components/common";
import { CASCADE_POLICY_FIELDS, PolicyEditor, POLICY_DEFAULTS } from "../../components/hub/PolicyEditor";
import { CONNECTION_GROUPS, SessionStatusBadge, StatusGroups } from "../../components/hub/StatusView";
import { b64ToBytes, certFileToDerB64, derB64ToPem } from "../../components/hub/util";
import { ApiError, rpc } from "../../lib/api";
import { ago, downloadText, dt } from "../../lib/format";
import { can, notifyError, useCatalog, useRpc, useRpcMutation, useScope, useServer, useServers } from "../../lib/hooks";

type Struct = Record<string, any>;
interface LinkItem { AccountName_utf: string; Online_bool: boolean; Connected_bool: boolean; LastError_u32: number; ConnectedTime_dt: string; Hostname_str: string; TargetHubName_str: string; ConnectedHubName_str?: string }

const LINK_AUTH = [
  { value: "0", label: "Anonymous", description: "No credentials; the destination hub must allow an anonymous user." },
  { value: "2", label: "Password", description: "User name and password of a user on the destination Virtual Hub." },
  { value: "3", label: "Client certificate", description: "Authenticate with an X.509 certificate and its private key." },
];

const PROXY_TYPES = [
  { value: "0", label: "Direct TCP/IP connection (no proxy)" },
  { value: "1", label: "HTTP proxy (CONNECT)" },
  { value: "2", label: "SOCKS proxy" },
];

const NEW_LINK: Struct = {
  AccountName_utf: "", Hostname_str: "", Port_u32: 443, HubName_str: "", Online_bool: true,
  ProxyType_u32: 0, ProxyName_str: "", ProxyPort_u32: 8080, ProxyUsername_str: "", ProxyPassword_str: "", CustomHttpHeader_str: "",
  MaxConnection_u32: 1, UseEncrypt_bool: true, UseCompress_bool: false, HalfConnection_bool: false, AdditionalConnectionInterval_u32: 1,
  ConnectionDisconnectSpan_u32: 0, DisableQoS_bool: false, NoTls1_bool: false, NoUdpAcceleration_bool: false,
  RequireBridgeRoutingMode_bool: true, RequireMonitorMode_bool: false, NoRoutingTracking_bool: true, RetryInterval_u32: 10,
  AuthType_u32: 2, Username_str: "", PlainPassword_str: "", ClientX_bin: "", ClientK_bin: "",
  CheckServerCert_bool: false, AddDefaultCA_bool: false, ServerCert_bin: "",
  ...Object.fromEntries(CASCADE_POLICY_FIELDS.map((f) => [f, POLICY_DEFAULTS[f]])),
  "policy:Ver3_bool": true,
};

function linkState(l: LinkItem): { label: string; color: string } {
  if (!l.Online_bool) return { label: "Offline", color: "gray" };
  if (l.Connected_bool) return { label: "Online", color: "green" };
  if (l.LastError_u32) return { label: "Error – retrying", color: "red" };
  return { label: "Connecting", color: "yellow" };
}

/* ------------------------------------------------------------------ editor */

function LinkDrawer({ serverId, hub, name, opened, onClose, canWrite }: {
  serverId: number; hub: string; name: string | null; opened: boolean; onClose: () => void; canWrite: boolean;
}) {
  const isNew = name === null;
  const cat = useCatalog();
  const doc = (f: string) => cat.data?.types["VpnRpcCreateLink"]?.fields.find((x) => x.name === f)?.doc?.replace(/^Client Option Parameters:\s*/, "");
  const q = useRpc<Struct>(serverId, "GetLink", { HubName_Ex_str: hub, AccountName_utf: name ?? "" }, { enabled: opened && !isNew, staleTime: 0 });
  const servers = useServers();
  const [form, setForm] = useState<Struct>(NEW_LINK);
  const [tab, setTab] = useState<string | null>("connection");
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [fetchFrom, setFetchFrom] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    if (!opened) return;
    if (isNew) setForm({ ...NEW_LINK });
    else if (q.data) setForm({ ...q.data, AuthType_u32: q.data.AuthType_u32 });
    setFileErr(null); setFetchFrom(null);
  }, [opened, isNew, q.data]);
  useEffect(() => { if (opened) setTab("connection"); }, [opened, name]);

  const set = (patch: Struct) => setForm((f) => ({ ...f, ...patch }));
  const create = useRpcMutation(serverId, "CreateLink", { success: "Cascade connection created", onSuccess: () => onClose() });
  const save = useRpcMutation(serverId, "SetLink", { success: "Cascade connection saved", onSuccess: () => onClose() });
  const auth = Number(form.AuthType_u32 ?? 0);
  const ro = !canWrite;

  const errors: string[] = [];
  if (!String(form.AccountName_utf ?? "").trim()) errors.push("Connection name is required");
  if (!String(form.Hostname_str ?? "").trim()) errors.push("Destination host name is required");
  if (!(form.Port_u32 >= 1 && form.Port_u32 <= 65535)) errors.push("Port must be 1–65535");
  if (!String(form.HubName_str ?? "").trim()) errors.push("Destination Virtual Hub name is required");
  if (!(form.MaxConnection_u32 >= 1 && form.MaxConnection_u32 <= 32)) errors.push("Number of TCP connections must be 1–32");
  if (form.HalfConnection_bool && form.MaxConnection_u32 < 2) errors.push("Half-duplex mode requires at least 2 TCP connections");
  if (auth !== 0 && !String(form.Username_str ?? "").trim()) errors.push("User name is required");
  if (auth === 2 && !form.PlainPassword_str && !(Number(q.data?.AuthType_u32) === 1 && !isNew)) errors.push("Password is required");
  if (auth === 3 && (b64ToBytes(form.ClientX_bin).length === 0 || b64ToBytes(form.ClientK_bin).length === 0)) errors.push("Upload both the client certificate and its private key");
  if (form.CheckServerCert_bool && !form.AddDefaultCA_bool && b64ToBytes(form.ServerCert_bin).length === 0) errors.push("Server certificate check is on: upload the expected server certificate or trust the default CA list");
  if (Number(form.ProxyType_u32) !== 0 && (!String(form.ProxyName_str ?? "").trim() || !(form.ProxyPort_u32 >= 1 && form.ProxyPort_u32 <= 65535))) errors.push("Proxy host and port are required");

  const submit = () => {
    if (errors.length) return;
    const p: Struct = { ...form, HubName_Ex_str: hub, AccountName_utf: String(form.AccountName_utf).trim(), Hostname_str: String(form.Hostname_str).trim(), HubName_str: String(form.HubName_str).trim(), "policy:Ver3_bool": true };
    if (!isNew) { p.AccountName_utf = name; delete p.NoTls1_bool; }
    // Existing SHA-0 hashed password (AuthType 1) with no new plain password: keep type 1 + HashedPassword_bin.
    if (auth === 2 && !form.PlainPassword_str && Number(q.data?.AuthType_u32) === 1) p.AuthType_u32 = 1;
    if (isNew) create.mutate(p); else save.mutate(p);
  };

  const fetchServerCert = async () => {
    if (!fetchFrom) return;
    setFetching(true);
    try {
      if (fetchFrom === "status") {
        const s = await rpc<Struct>(serverId, "GetLinkStatus", { HubName_Ex_str: hub, AccountName_utf: name ?? "" });
        if (!s.ServerX_bin || b64ToBytes(s.ServerX_bin).length === 0) throw new Error("The link has not received a server certificate yet (it must be connected).");
        set({ ServerCert_bin: s.ServerX_bin, CheckServerCert_bool: true });
      } else {
        const r = await rpc<Struct>(Number(fetchFrom), "GetServerCert", {});
        set({ ServerCert_bin: r.Cert_bin, CheckServerCert_bool: true });
      }
      notifications.show({ color: "green", message: "Server certificate loaded" });
    } catch (e) {
      notifyError(e, "Fetch certificate");
    } finally {
      setFetching(false);
    }
  };

  const fileField = (label: string, field: string, kind: "cert" | "key", testId: string) => {
    const len = b64ToBytes(form[field]).length;
    return (
      <Stack gap={4}>
        <Text size="sm" fw={500}>{label}</Text>
        <Group gap="xs">
          {len > 0 ? <Badge variant="light" color="grape" leftSection={<IconCertificate size={12} />}>{kind === "cert" ? "Certificate" : "Private key"} loaded ({len} bytes)</Badge> : <Badge variant="light" color="red">Not set</Badge>}
          {len > 0 && kind === "cert" && <Button size="compact-xs" variant="subtle" leftSection={<IconDownload size={12} />} onClick={() => downloadText(`${field}.pem`, derB64ToPem(form[field]), "application/x-pem-file")}>PEM</Button>}
          {!ro && (
            <FileButton accept=".cer,.crt,.pem,.der,.key" onChange={async (f) => {
              if (!f) return;
              try { set({ [field]: await certFileToDerB64(f, kind) }); setFileErr(null); } catch (e) { setFileErr((e as Error).message); }
            }}>
              {(props) => <Button {...props} size="compact-sm" variant="light" leftSection={<IconUpload size={14} />} data-testid={testId}>Upload…</Button>}
            </FileButton>
          )}
        </Group>
      </Stack>
    );
  };

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="xl" title={<Text fw={700}>{isNew ? "New cascade connection" : <>Cascade <Code>{name}</Code></>}</Text>}>
      {!isNew && q.isLoading ? <QueryState query={q}>{null}</QueryState> : !isNew && q.error ? <ErrorAlert error={q.error} /> : (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} data-testid="link-form">
          <Tabs value={tab} onChange={setTab}>
            <Tabs.List mb="md">
              <Tabs.Tab value="connection">Destination</Tabs.Tab>
              <Tabs.Tab value="auth">Authentication</Tabs.Tab>
              <Tabs.Tab value="cert">Server certificate</Tabs.Tab>
              <Tabs.Tab value="proxy">Proxy</Tabs.Tab>
              <Tabs.Tab value="advanced">Advanced</Tabs.Tab>
              <Tabs.Tab value="policy">Security policy</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="connection">
              <Stack gap="sm">
                <TextInput label="Connection name" required readOnly={!isNew || ro} description={isNew ? doc("AccountName_utf") : "Use Rename in the list to change the name."}
                  value={String(form.AccountName_utf ?? "")} onChange={(e) => set({ AccountName_utf: e.currentTarget.value })} data-autofocus data-testid="link-name" />
                <SimpleGrid cols={{ base: 1, sm: 3 }}>
                  <TextInput style={{ gridColumn: "span 2" }} label="Destination VPN server" required placeholder="vpn.example.com" description={doc("Hostname_str")}
                    value={String(form.Hostname_str ?? "")} readOnly={ro} onChange={(e) => set({ Hostname_str: e.currentTarget.value })} data-testid="link-host" />
                  <NumberInput label="Port" required min={1} max={65535} allowDecimal={false} description="Usually 443, 992, 1194 or 5555"
                    value={form.Port_u32} readOnly={ro} onChange={(v) => set({ Port_u32: Number(v) || 0 })} data-testid="link-port" />
                </SimpleGrid>
                <TextInput label="Destination Virtual Hub" required description={doc("HubName_str")} value={String(form.HubName_str ?? "")} readOnly={ro}
                  onChange={(e) => set({ HubName_str: e.currentTarget.value })} data-testid="link-target-hub" />
                {isNew && <Switch label="Bring online immediately after creation" checked={!!form.Online_bool} onChange={(e) => set({ Online_bool: e.currentTarget.checked })} />}
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="auth">
              <Stack gap="sm">
                <Radio.Group label="Authentication type" value={String(auth === 1 ? 2 : auth)} onChange={(v) => set({ AuthType_u32: Number(v) })} data-testid="link-authtype">
                  <Stack gap={6} mt={6}>{LINK_AUTH.map((a) => <Radio key={a.value} value={a.value} label={a.label} description={a.description} disabled={ro} />)}</Stack>
                </Radio.Group>
                {auth !== 0 && (
                  <TextInput label="User name" required description="User on the destination Virtual Hub." value={String(form.Username_str ?? "")} readOnly={ro}
                    onChange={(e) => set({ Username_str: e.currentTarget.value })} data-testid="link-username" />
                )}
                {(auth === 2 || auth === 1) && (
                  <>
                    {auth === 1 && <Alert color="blue" variant="light">A hashed password is stored. Leave the field blank to keep it, or enter a new password.</Alert>}
                    <PasswordInput label="Password" description={doc("PlainPassword_str")} value={String(form.PlainPassword_str ?? "")} readOnly={ro} autoComplete="new-password"
                      onChange={(e) => set({ PlainPassword_str: e.currentTarget.value, ...(auth === 1 && e.currentTarget.value ? { AuthType_u32: 2 } : {}) })} data-testid="link-password" />
                  </>
                )}
                {auth === 3 && (
                  <Stack gap="sm">
                    <Text size="sm" c="dimmed">PEM or DER files are accepted (PEM is converted to DER). The private key must not be passphrase-protected.</Text>
                    {fileField("Client certificate (ClientX_bin)", "ClientX_bin", "cert", "link-client-cert")}
                    {fileField("Client private key (ClientK_bin)", "ClientK_bin", "key", "link-client-key")}
                    {fileErr && <Text size="sm" c="red">{fileErr}</Text>}
                  </Stack>
                )}
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="cert">
              <Stack gap="sm">
                <Switch label="Verify the destination server certificate" description={doc("CheckServerCert_bool")} checked={!!form.CheckServerCert_bool} disabled={ro}
                  onChange={(e) => set({ CheckServerCert_bool: e.currentTarget.checked })} data-testid="link-check-cert" />
                {form.CheckServerCert_bool && (
                  <>
                    {form.AddDefaultCA_bool !== undefined && (
                      <Switch label="Also trust the built-in list of public root CAs" checked={!!form.AddDefaultCA_bool} disabled={ro}
                        description="Accept any server certificate signed by a well-known CA, in addition to the pinned certificate below."
                        onChange={(e) => set({ AddDefaultCA_bool: e.currentTarget.checked })} />
                    )}
                    {fileField("Expected server certificate (ServerCert_bin)", "ServerCert_bin", "cert", "link-server-cert")}
                    <Text size="xs" c="dimmed">{doc("ServerCert_bin")}</Text>
                    {canWrite && (
                      <Group align="flex-end">
                        <Select style={{ flex: 1 }} label="…or fetch it" placeholder="Choose source" value={fetchFrom} onChange={setFetchFrom}
                          data={[
                            ...(!isNew ? [{ value: "status", label: "Certificate presented on the last connection of this link" }] : []),
                            ...(servers.data ?? []).filter((s) => can(s.myRole, "admin")).map((s) => ({ value: String(s.id), label: `Managed server: ${s.name} (${s.host}:${s.port})` })),
                          ]} />
                        <Button variant="light" onClick={fetchServerCert} loading={fetching} disabled={!fetchFrom} data-testid="link-fetch-cert">Fetch</Button>
                      </Group>
                    )}
                    {fileErr && <Text size="sm" c="red">{fileErr}</Text>}
                  </>
                )}
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="proxy">
              <Stack gap="sm">
                <Select label="Proxy type" description={doc("ProxyType_u32")} data={PROXY_TYPES} value={String(form.ProxyType_u32 ?? 0)} allowDeselect={false} readOnly={ro}
                  onChange={(v) => set({ ProxyType_u32: Number(v ?? 0) })} data-testid="link-proxy-type" />
                {Number(form.ProxyType_u32) !== 0 && (
                  <>
                    <SimpleGrid cols={{ base: 1, sm: 3 }}>
                      <TextInput style={{ gridColumn: "span 2" }} label="Proxy host" required description={doc("ProxyName_str")} value={String(form.ProxyName_str ?? "")} readOnly={ro}
                        onChange={(e) => set({ ProxyName_str: e.currentTarget.value })} />
                      <NumberInput label="Proxy port" required min={1} max={65535} allowDecimal={false} value={form.ProxyPort_u32} readOnly={ro}
                        onChange={(v) => set({ ProxyPort_u32: Number(v) || 0 })} />
                    </SimpleGrid>
                    <SimpleGrid cols={{ base: 1, sm: 2 }}>
                      <TextInput label="Proxy user name" description={doc("ProxyUsername_str")} value={String(form.ProxyUsername_str ?? "")} readOnly={ro}
                        onChange={(e) => set({ ProxyUsername_str: e.currentTarget.value })} />
                      <PasswordInput label="Proxy password" description={doc("ProxyPassword_str")} value={String(form.ProxyPassword_str ?? "")} readOnly={ro} autoComplete="new-password"
                        onChange={(e) => set({ ProxyPassword_str: e.currentTarget.value })} />
                    </SimpleGrid>
                    {Number(form.ProxyType_u32) === 1 && form.CustomHttpHeader_str !== undefined && (
                      <TextInput label="Custom HTTP header" description="Extra header sent to the HTTP proxy, e.g. X-Forwarded-For: 1.2.3.4" value={String(form.CustomHttpHeader_str ?? "")} readOnly={ro}
                        onChange={(e) => set({ CustomHttpHeader_str: e.currentTarget.value })} />
                    )}
                  </>
                )}
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="advanced">
              <Stack gap="sm">
                <SimpleGrid cols={{ base: 1, sm: 3 }}>
                  <NumberInput label="TCP connections" min={1} max={32} allowDecimal={false} description={doc("MaxConnection_u32")} value={form.MaxConnection_u32} readOnly={ro}
                    onChange={(v) => set({ MaxConnection_u32: Number(v) || 1 })} data-testid="link-maxconn" />
                  <NumberInput label="Additional connection interval" suffix=" s" min={1} allowDecimal={false} description={doc("AdditionalConnectionInterval_u32")}
                    value={form.AdditionalConnectionInterval_u32} readOnly={ro} onChange={(v) => set({ AdditionalConnectionInterval_u32: Number(v) || 1 })} />
                  <NumberInput label="Connection life span" suffix=" s" min={0} allowDecimal={false} description={doc("ConnectionDisconnectSpan_u32")}
                    value={form.ConnectionDisconnectSpan_u32} readOnly={ro} onChange={(v) => set({ ConnectionDisconnectSpan_u32: Number(v) || 0 })} />
                </SimpleGrid>
                {form.RetryInterval_u32 !== undefined && (
                  <NumberInput w={260} label="Retry interval" suffix=" s" min={1} allowDecimal={false} description="Wait time before reconnecting after a failure."
                    value={form.RetryInterval_u32} readOnly={ro} onChange={(v) => set({ RetryInterval_u32: Number(v) || 1 })} />
                )}
                <Divider />
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                  <Switch label="Encrypt VPN session (SSL)" description={doc("UseEncrypt_bool")} checked={!!form.UseEncrypt_bool} disabled={ro} onChange={(e) => set({ UseEncrypt_bool: e.currentTarget.checked })} />
                  <Switch label="Data compression" description={doc("UseCompress_bool")} checked={!!form.UseCompress_bool} disabled={ro} onChange={(e) => set({ UseCompress_bool: e.currentTarget.checked })} />
                  <Switch label="Half-duplex mode" description="Split TCP connections into upload/download halves (needs ≥ 2 connections)." checked={!!form.HalfConnection_bool} disabled={ro} onChange={(e) => set({ HalfConnection_bool: e.currentTarget.checked })} />
                  <Switch label="Disable VoIP / QoS" description={doc("DisableQoS_bool")} checked={!!form.DisableQoS_bool} disabled={ro} onChange={(e) => set({ DisableQoS_bool: e.currentTarget.checked })} />
                  <Switch label="Disable UDP acceleration" description={doc("NoUdpAcceleration_bool")} checked={!!form.NoUdpAcceleration_bool} disabled={ro} onChange={(e) => set({ NoUdpAcceleration_bool: e.currentTarget.checked })} />
                  {isNew && <Switch label="Do not use TLS 1.x" description={doc("NoTls1_bool")} checked={!!form.NoTls1_bool} onChange={(e) => set({ NoTls1_bool: e.currentTarget.checked })} />}
                  {form.NoRoutingTracking_bool !== undefined && <Switch label="No routing tracking" description="Do not track routing (IP) tables on this cascade session." checked={!!form.NoRoutingTracking_bool} disabled={ro} onChange={(e) => set({ NoRoutingTracking_bool: e.currentTarget.checked })} />}
                  {form.RequireBridgeRoutingMode_bool !== undefined && <Switch label="Require bridge / routing mode" description="Request bridge/router mode on the destination (normally on for cascades)." checked={!!form.RequireBridgeRoutingMode_bool} disabled={ro} onChange={(e) => set({ RequireBridgeRoutingMode_bool: e.currentTarget.checked })} />}
                  {form.RequireMonitorMode_bool !== undefined && <Switch label="Require monitoring mode" description="Connect in monitoring (tap) mode; the destination user needs the monitoring policy." checked={!!form.RequireMonitorMode_bool} disabled={ro} onChange={(e) => set({ RequireMonitorMode_bool: e.currentTarget.checked })} />}
                </SimpleGrid>
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="policy">
              <Stack gap="sm">
                <Text size="sm" c="dimmed">Security policy applied on this side to the cascade session (the session appears in this hub as user "Cascade").</Text>
                <PolicyEditor value={form} onChange={set} fields={CASCADE_POLICY_FIELDS} readOnly={ro} testId="link-policy" />
              </Stack>
            </Tabs.Panel>
          </Tabs>
          {canWrite && (
            <Stack gap="xs" mt="lg">
              {errors.length > 0 && <Text size="sm" c="red">{errors[0]}</Text>}
              <Group justify="flex-end">
                <Button variant="default" onClick={onClose}>Cancel</Button>
                <Button type="submit" loading={create.isPending || save.isPending} disabled={errors.length > 0} data-testid="link-save">{isNew ? "Create" : "Save changes"}</Button>
              </Group>
              {!isNew && <Text size="xs" c="dimmed" ta="right">Saving an online link reconnects it with the new settings.</Text>}
            </Stack>
          )}
        </form>
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ status + rename */

function StatusDrawer({ serverId, hub, name, onClose }: { serverId: number; hub: string; name: string | null; onClose: () => void }) {
  const q = useRpc<Struct>(serverId, "GetLinkStatus", { HubName_Ex_str: hub, AccountName_utf: name ?? "" }, { enabled: !!name, refetchInterval: 5000, retry: false });
  const offline = q.error instanceof ApiError && q.error.softEtherCode === 61;
  return (
    <Drawer opened={!!name} onClose={onClose} position="right" size="xl" title={<Text fw={700}>Status of <Code>{name}</Code></Text>}>
      <Stack>
        <Group justify="space-between">
          {q.data ? <SessionStatusBadge value={Number(q.data.SessionStatus_u32)} /> : <span />}
          <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={() => q.refetch()} loading={q.isFetching}>Refresh</Button>
        </Group>
        {offline ? <Alert color="gray">The cascade connection is offline. Bring it online to see live status.</Alert>
          : q.error ? <ErrorAlert error={q.error} />
          : <QueryState query={q}>{q.data && <StatusGroups data={q.data} groups={[{ title: "Link", fields: [["Connection name", "AccountName_utf"], ["Session name", "SessionName_str"], ["Connection ID", "ConnectionName_str"], ["Server certificate", "ServerX_bin"], ["Client certificate", "ClientX_bin"]] }, ...CONNECTION_GROUPS]} hide={["HubName_Ex_str", "SessionKey_bin"]} />}</QueryState>}
      </Stack>
    </Drawer>
  );
}

function RenameModal({ serverId, hub, name, onClose, existing }: { serverId: number; hub: string; name: string | null; onClose: () => void; existing: string[] }) {
  const [v, setV] = useState("");
  useEffect(() => { setV(name ?? ""); }, [name]);
  const m = useRpcMutation(serverId, "RenameLink", { success: "Cascade connection renamed", onSuccess: onClose });
  const t = v.trim();
  const err = !t ? "Required" : t !== name && existing.some((e) => e.toLowerCase() === t.toLowerCase()) ? "A connection with this name exists" : null;
  return (
    <Modal opened={!!name} onClose={onClose} title={`Rename ${name}`} centered>
      <form onSubmit={(e) => { e.preventDefault(); if (!err && t !== name) m.mutate({ HubName_str: hub, OldAccountName_utf: name, NewAccountName_utf: t }); }}>
        <Stack>
          <TextInput label="New name" value={v} onChange={(e) => setV(e.currentTarget.value)} error={v && err} data-autofocus data-testid="link-rename-input" />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={m.isPending} disabled={!!err || t === name} data-testid="link-rename-save">Rename</Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ page */

export default function CascadesPage() {
  const { serverId, hub = "" } = useScope();
  const role = useServer(serverId).data?.myRole;
  const canWrite = can(role, "operator");
  const cat = useCatalog();
  const q = useRpc<{ LinkList?: LinkItem[] }>(serverId, "EnumLink", { HubName_str: hub }, { refetchInterval: 10_000 });
  const [editing, setEditing] = useState<{ name: string | null } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const online = useRpcMutation(serverId, "SetLinkOnline", { success: "Cascade connection set online" });
  const offline = useRpcMutation(serverId, "SetLinkOffline", { success: "Cascade connection set offline" });
  const del = useRpcMutation(serverId, "DeleteLink", { success: "Cascade connection deleted" });
  const errText = (c: number) => cat.data?.errors[String(c)] ?? `Error ${c}`;
  const list = q.data?.LinkList ?? [];

  return (
    <>
      <PageHeader
        title="Cascade connections"
        description="Site-to-site links: this Virtual Hub connects as a client to a Virtual Hub on another (or the same) VPN server and bridges both Ethernet segments at Layer 2."
        actions={<>
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => q.refetch()} loading={q.isFetching}>Refresh</Button>
          {canWrite && <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing({ name: null })} data-testid="create-link">New cascade</Button>}
        </>}
      />
      {!canWrite && role && <ReadOnlyNotice role={role} />}
      <QueryState query={q}>
        <DataTable
          testId="links-table"
          data={list}
          rowKey={(l) => l.AccountName_utf}
          onRowClick={(l) => setEditing({ name: l.AccountName_utf })}
          initialSort={{ key: "AccountName_utf", dir: "asc" }}
          empty="No cascade connections"
          columns={[
            { key: "AccountName_utf", title: "Name", render: (l) => <Text fw={600} size="sm">{l.AccountName_utf}</Text> },
            { key: "status", title: "Status", value: (l) => linkState(l).label, render: (l) => {
              const s = linkState(l);
              return <Badge color={s.color} variant="light" data-testid={`link-status-${l.AccountName_utf}`}>{s.label}</Badge>;
            } },
            { key: "Hostname_str", title: "Destination server", render: (l) => <Text size="sm" ff="monospace">{l.Hostname_str}</Text> },
            { key: "TargetHubName_str", title: "Destination hub" },
            { key: "ConnectedTime_dt", title: "Connected since", render: (l) => (l.Connected_bool ? <Tooltip label={dt(l.ConnectedTime_dt)}><span>{ago(l.ConnectedTime_dt)}</span></Tooltip> : "–") },
            { key: "LastError_u32", title: "Last error", render: (l) => (l.LastError_u32 ? <Tooltip label={errText(l.LastError_u32)} multiline w={320}><Text size="sm" c="red" lineClamp={1} maw={260}>{errText(l.LastError_u32)}</Text></Tooltip> : <Text size="sm" c="dimmed">–</Text>) },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (l) => (
                <Group gap={4} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                  {canWrite && (
                    <Tooltip label={l.Online_bool ? "Set offline" : "Set online"}>
                      <Switch size="sm" checked={l.Online_bool} aria-label={`Toggle ${l.AccountName_utf} online`} data-testid={`link-online-${l.AccountName_utf}`}
                        onChange={(e) => (e.currentTarget.checked ? online : offline).mutate({ HubName_str: hub, AccountName_utf: l.AccountName_utf })} />
                    </Tooltip>
                  )}
                  <Tooltip label="Live status"><ActionIcon variant="subtle" onClick={() => setStatus(l.AccountName_utf)} aria-label="Status" data-testid={`link-status-open-${l.AccountName_utf}`}><IconEye size={16} /></ActionIcon></Tooltip>
                  <Tooltip label={canWrite ? "Edit" : "View"}><ActionIcon variant="subtle" onClick={() => setEditing({ name: l.AccountName_utf })} aria-label="Edit" data-testid={`link-edit-${l.AccountName_utf}`}><IconEdit size={16} /></ActionIcon></Tooltip>
                  {canWrite && <Tooltip label="Rename"><ActionIcon variant="subtle" onClick={() => setRenaming(l.AccountName_utf)} aria-label="Rename" data-testid={`link-rename-${l.AccountName_utf}`}><IconCursorText size={16} /></ActionIcon></Tooltip>}
                  {canWrite && (
                    <ConfirmButton title={`Delete cascade ${l.AccountName_utf}?`} confirmLabel="Delete" typeToConfirm={l.AccountName_utf} leftSection={<IconTrash size={14} />}
                      message="The link is disconnected and its configuration, including stored credentials and certificates, is permanently removed."
                      onConfirm={() => del.mutateAsync({ HubName_str: hub, AccountName_utf: l.AccountName_utf })}>Delete</ConfirmButton>
                  )}
                </Group>
              ),
            },
          ]}
        />
      </QueryState>
      <LinkDrawer serverId={serverId} hub={hub} name={editing?.name ?? null} opened={!!editing} onClose={() => setEditing(null)} canWrite={canWrite} />
      <StatusDrawer serverId={serverId} hub={hub} name={status} onClose={() => setStatus(null)} />
      <RenameModal serverId={serverId} hub={hub} name={renaming} onClose={() => setRenaming(null)} existing={list.map((l) => l.AccountName_utf)} />
    </>
  );
}
