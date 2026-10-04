import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Badge, Button, Code, Divider, Drawer, FileButton, Fieldset, Group, Loader, Modal, NumberInput, PasswordInput,
  ScrollArea, SegmentedControl, Select, SimpleGrid, Stack, Switch, Text, TextInput, Textarea, Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle, IconCertificate, IconCloudDownload, IconDownload, IconFileUpload, IconPlus, IconServer, IconShieldLock, IconTrash,
} from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, ErrorAlert, PageHeader, QueryState, ReadOnlyNotice } from "../../components/common";
import { ApiError, del, download, post, put } from "../../lib/api";
import { can, notifyError, useRpc, useServers } from "../../lib/hooks";
import { ago, downloadText, dt } from "../../lib/format";
import {
  AUTH_LABEL, AuthBadge, KEEP, NIC_OPTIONS, NIC_RE, deployKeys, fileToPem, pemSummary, useGlobalRole, useProfiles,
  type AuthType, type Profile, type ProfileSettings, type ProxyType,
} from "../../components/deploy/shared";

const INFINITE = 4294967295;

const DEFAULTS: ProfileSettings = {
  accountName: "", host: "", port: 443, hub: "", authType: "password", username: "",
  password: undefined, hashedPassword: undefined, clientCertPem: undefined, clientKeyPem: undefined, serverCertPem: undefined,
  checkServerCert: true, addDefaultCa: false, deviceName: "VPN", startup: true, maxConnection: 1,
  useEncrypt: true, useCompress: false, halfConnection: false, noUdpAcceleration: false, disableQoS: false,
  noRoutingTracking: false, requireBridgeRoutingMode: false, requireMonitorMode: false,
  additionalConnectionInterval: 1, connectionDisconnectSpan: 0, numRetry: INFINITE, retryInterval: 15,
  hideStatusWindow: false, hideNicInfoWindow: false, proxyType: "direct", proxyHost: "", proxyPort: 0, proxyUsername: "",
};

const PROXY_TYPES: { value: ProxyType; label: string }[] = [
  { value: "direct", label: "Direct TCP/IP connection (no proxy)" },
  { value: "http", label: "HTTP proxy server" },
  { value: "socks4", label: "SOCKS4 proxy server" },
  { value: "socks5", label: "SOCKS5 proxy server" },
];

interface FromServerResult extends Partial<ProfileSettings> { warnings: string[] }
type Initial = Partial<ProfileSettings> & { profileName?: string; notice?: ReactNode };

const toNum = (v: number | string, fallback = 0) => (typeof v === "number" ? v : Number(v) || fallback);
const isB64Hash = (s: string) => /^[A-Za-z0-9+/]{27}=$/.test(s);

/** Build the body the backend accepts from the editor state (drop secrets that don't apply). */
function cleanSettings(s: ProfileSettings): ProfileSettings {
  const out: ProfileSettings = { ...s, username: s.username.trim(), host: s.host.trim(), hub: s.hub.trim(), accountName: s.accountName.trim() };
  if (s.authType !== "password" && s.authType !== "radius") { out.password = undefined; out.hashedPassword = undefined; }
  if (s.authType === "radius") out.hashedPassword = undefined;
  if (s.authType !== "certificate") { out.clientCertPem = undefined; out.clientKeyPem = undefined; }
  for (const k of ["password", "hashedPassword", "clientCertPem", "clientKeyPem", "serverCertPem"] as const) {
    if (out[k] === "") out[k] = undefined;
  }
  if (out.proxyType === "direct") { out.proxyHost = ""; out.proxyPort = 0; out.proxyUsername = ""; }
  return out;
}

/** Settings for the preview renderer: stored secrets are never sent back to the browser, so use placeholders. */
function previewSettings(s: ProfileSettings): ProfileSettings {
  const c = cleanSettings(s);
  if (c.hashedPassword === KEEP) c.hashedPassword = "AAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  if (c.password === KEEP) { c.password = undefined; if (!c.hashedPassword) c.hashedPassword = "AAAAAAAAAAAAAAAAAAAAAAAAAAA="; }
  if (c.clientKeyPem === KEEP) c.clientKeyPem = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
  if (c.authType === "certificate") {
    c.clientCertPem ||= "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
    c.clientKeyPem ||= "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
  }
  return c;
}

function validate(name: string, s: ProfileSettings): Record<string, string> {
  const e: Record<string, string> = {};
  if (!name.trim()) e.name = "Required";
  if (!s.accountName.trim()) e.accountName = "Required";
  if (!s.host.trim()) e.host = "Required";
  else if (/\s/.test(s.host.trim())) e.host = "Host name must not contain spaces";
  if (!s.hub.trim()) e.hub = "Required";
  if (!(s.port >= 1 && s.port <= 65535)) e.port = "1 – 65535";
  if (!NIC_RE.test(s.deviceName)) e.deviceName = "VPN, VPN2 … VPN127";
  if ((s.authType === "password" || s.authType === "radius" || s.authType === "certificate") && !s.username.trim()) e.username = "Required for this authentication type";
  if (s.hashedPassword && s.hashedPassword !== KEEP && !isB64Hash(s.hashedPassword)) e.hashedPassword = "Must be a base64 SHA-0 hash (28 characters, 20 bytes)";
  if (s.authType === "certificate") {
    if (!s.clientCertPem) e.clientCertPem = "A client certificate is required";
    if (!s.clientKeyPem) e.clientKeyPem = "The matching private key is required";
  }
  if (!(s.maxConnection >= 1 && s.maxConnection <= 32)) e.maxConnection = "1 – 32";
  if (s.halfConnection && s.maxConnection < 2) e.halfConnection = "Half-duplex mode needs at least 2 TCP connections";
  if (!(s.retryInterval >= 5 && s.retryInterval <= 3600)) e.retryInterval = "5 – 3600 seconds";
  if (!(s.additionalConnectionInterval >= 1 && s.additionalConnectionInterval <= 3600)) e.additionalConnectionInterval = "1 – 3600 seconds";
  if (s.connectionDisconnectSpan < 0) e.connectionDisconnectSpan = "Must be 0 or more";
  if (s.numRetry < 0 || s.numRetry > INFINITE) e.numRetry = "Out of range";
  if (s.proxyType !== "direct") {
    if (!s.proxyHost.trim()) e.proxyHost = "Required when a proxy is used";
    if (!(s.proxyPort >= 1 && s.proxyPort <= 65535)) e.proxyPort = "1 – 65535";
  }
  return e;
}

// ---------------------------------------------------------------------------------------------
// Fill from managed server

function FromServerModal({ opened, onClose, onApply, preset }: {
  opened: boolean; onClose: () => void; onApply: (r: FromServerResult, serverName: string) => void;
  preset?: { serverId?: string; hub?: string; user?: string };
}) {
  const servers = useServers();
  const [serverId, setServerId] = useState<string | null>(null);
  const [hub, setHub] = useState<string | null>(null);
  const [user, setUser] = useState<string | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState<number | string>("");
  const [pin, setPin] = useState(true);
  const [includeHash, setIncludeHash] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setServerId(preset?.serverId ?? null); setHub(preset?.hub ?? null); setUser(preset?.user ?? null);
    setHost(""); setPort(""); setPin(true); setIncludeHash(false);
  }, [opened]);

  const sid = serverId ? Number(serverId) : NaN;
  const server = servers.data?.find((s) => s.id === sid);
  const hubs = useRpc<{ HubList?: { HubName_str: string }[] }>(sid, "EnumHub", {}, { enabled: opened && Number.isFinite(sid) });
  const users = useRpc<{ UserList?: { Name_str: string; AuthType_u32: number; Realname_utf?: string }[] }>(
    sid, "EnumUser", { HubName_str: hub ?? "" }, { enabled: opened && Number.isFinite(sid) && !!hub });
  const authName = (t: number) => ({ 0: "anonymous", 1: "password", 2: "user cert", 3: "signed cert", 4: "RADIUS", 5: "NT domain" } as Record<number, string>)[t] ?? `type ${t}`;
  const selUser = users.data?.UserList?.find((u) => u.Name_str === user);

  const fill = useMutation({
    mutationFn: () => post<FromServerResult>("/api/deploy/from-server", {
      serverId: sid, hub, username: user || undefined, pinCertificate: pin,
      includeUserHash: !!user && includeHash && selUser?.AuthType_u32 === 1,
      host: host.trim() || undefined, port: port === "" ? undefined : Number(port),
    }),
    onSuccess: (r) => { onApply(r, server?.name ?? String(sid)); onClose(); },
    onError: (e) => notifyError(e, "Could not read settings from the server"),
  });

  return (
    <Modal opened={opened} onClose={onClose} title="Fill from a managed server" size="lg" centered>
      <Stack>
        <Text size="sm" c="dimmed">
          Copies the connection target of a server managed here into the profile, pins its current server certificate
          (GetServerCert) and, if you pick a hub user, sets the matching authentication type.
        </Text>
        <Select label="Server" required data-testid="fill-server" placeholder="Choose a server"
          data={(servers.data ?? []).map((s) => ({ value: String(s.id), label: `${s.name} (${s.host}:${s.port})` }))}
          value={serverId} onChange={(v) => { setServerId(v); setHub(null); setUser(null); }} searchable />
        <Select label="Virtual Hub" required data-testid="fill-hub" placeholder={hubs.isLoading ? "Loading…" : "Choose a hub"} disabled={!serverId}
          data={(hubs.data?.HubList ?? []).map((h) => h.HubName_str)} value={hub} onChange={(v) => { setHub(v); setUser(null); }} searchable
          error={hubs.error ? hubs.error.message : undefined} />
        <Select label="User (optional)" data-testid="fill-user" placeholder={users.isLoading ? "Loading…" : "No specific user"} disabled={!hub} clearable searchable
          description="Sets the user name and authentication type from the hub user."
          data={(users.data?.UserList ?? []).map((u) => ({ value: u.Name_str, label: `${u.Name_str} — ${authName(u.AuthType_u32)}${u.Realname_utf ? ` (${u.Realname_utf})` : ""}` }))}
          value={user} onChange={setUser} error={users.error ? users.error.message : undefined} />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="Public host name (optional)" placeholder={server?.host ?? "server host"} value={host} onChange={(e) => setHost(e.currentTarget.value)}
            description="The address clients use. Defaults to the address this manager uses, which may be internal." />
          <NumberInput label="Port (optional)" placeholder={server ? String(server.port) : "443"} min={1} max={65535} value={port} onChange={setPort} />
        </SimpleGrid>
        <Switch label="Pin the server certificate" checked={pin} onChange={(e) => setPin(e.currentTarget.checked)}
          description="The client will refuse to connect if the server presents a different certificate. Re-issue profiles after renewing the server certificate." />
        <Switch label="Include the user's password hash" checked={includeHash} disabled={!user || selUser?.AuthType_u32 !== 1}
          onChange={(e) => setIncludeHash(e.currentTarget.checked)} data-testid="fill-include-hash"
          description={user && selUser?.AuthType_u32 !== 1 ? "Only available for users with password authentication." : "Exports the user's stored HashedKey so the profile can log in without knowing the password."} />
        {includeHash && (
          <Alert color="orange" icon={<IconAlertTriangle size={16} />} title="Password-equivalent secret">
            The exported hash is all an attacker needs to log in as <b>{user}</b>; it is not a one-way protection. The export is recorded in the
            audit log. Only distribute the resulting profile or installer to that user's devices.
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button leftSection={<IconServer size={16} />} disabled={!serverId || !hub} loading={fill.isPending} onClick={() => fill.mutate()} data-testid="fill-apply">
            Fill profile
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// PEM field (upload or paste)

function PemField({ label, description, value, onChange, kind, error, keepLabel, testId }: {
  label: string; description: ReactNode; value: string | undefined; onChange: (v: string | undefined) => void;
  kind: "CERTIFICATE" | "PRIVATE KEY"; error?: string; keepLabel?: string; testId?: string;
}) {
  const reset = useRef<() => void>(null);
  const kept = value === KEEP;
  return (
    <Stack gap={4}>
      <Group justify="space-between" align="flex-end">
        <div>
          <Text size="sm" fw={500}>{label}</Text>
          <Text size="xs" c="dimmed">{description}</Text>
        </div>
        <Group gap={6}>
          <FileButton resetRef={reset} accept=".pem,.crt,.cer,.der,.key,.txt" onChange={async (f) => {
            if (!f) return;
            try { onChange(await fileToPem(f, kind)); } catch (e) { notifyError(e, "Could not read file"); }
            reset.current?.();
          }}>
            {(props) => <Button {...props} size="xs" variant="light" leftSection={<IconFileUpload size={14} />} data-testid={testId ? `${testId}-upload` : undefined}>Upload</Button>}
          </FileButton>
          {value && <Button size="xs" variant="subtle" color="red" onClick={() => onChange(undefined)}>Clear</Button>}
        </Group>
      </Group>
      {kept ? (
        <Alert color="gray" variant="light" py={6}><Text size="sm">{keepLabel ?? "A stored value is kept."} Upload or paste to replace it.</Text></Alert>
      ) : (
        <Textarea
          value={value ?? ""} onChange={(e) => onChange(e.currentTarget.value || undefined)} autosize minRows={2} maxRows={6}
          placeholder={`-----BEGIN ${kind}-----\n…\n-----END ${kind}-----`} styles={{ input: { fontFamily: "monospace", fontSize: 11 } }}
          error={error} data-testid={testId}
        />
      )}
      {value && !kept && <Text size="xs" c="dimmed">{pemSummary(value)}</Text>}
    </Stack>
  );
}

// ---------------------------------------------------------------------------------------------
// Editor

function ProfileEditor({ opened, onClose, profile, initial, readOnly, canPreview }: {
  opened: boolean; onClose: () => void; profile: Profile | null; initial: Initial | null; readOnly: boolean; canPreview: boolean;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [s, setS] = useState<ProfileSettings>(DEFAULTS);
  const [pwMode, setPwMode] = useState<"password" | "hash">("password");
  const [fillOpen, setFillOpen] = useState(false);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!opened) return;
    const base: ProfileSettings = profile ? { ...DEFAULTS, ...profile.settings } : { ...DEFAULTS, ...(initial ?? {}) };
    delete (base as Partial<{ hasPassword: boolean }>).hasPassword;
    delete (base as Partial<{ hasClientKey: boolean }>).hasClientKey;
    setS(base);
    setName(profile?.name ?? initial?.profileName ?? "");
    setDescription(profile?.description ?? "");
    setPwMode(base.hashedPassword ? "hash" : "password");
    setNotice(initial?.notice ?? null);
    setTouched(false);
  }, [opened, profile?.id, initial]);

  const set = <K extends keyof ProfileSettings>(k: K, v: ProfileSettings[K]) => setS((cur) => ({ ...cur, [k]: v }));
  const errors = validate(name, s);
  const err = (k: string) => (touched ? errors[k] : undefined);

  const [debounced] = useDebouncedValue(s, 400);
  const previewable = canPreview && !!debounced.accountName.trim() && !!debounced.host.trim() && !!debounced.hub.trim() && NIC_RE.test(debounced.deviceName);
  const preview = useQuery({
    queryKey: ["deploy", "render", debounced],
    queryFn: () => post<{ content: string }>("/api/deploy/render", previewSettings(debounced)),
    enabled: opened && previewable,
    retry: false,
    placeholderData: (prev) => prev,
  });

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description, settings: cleanSettings(s) };
      return profile ? put(`/api/deploy/profiles/${profile.id}`, body) : post("/api/deploy/profiles", body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: deployKeys.profiles });
      notifications.show({ color: "green", message: profile ? "Profile saved" : "Profile created" });
      onClose();
    },
    onError: (e) => {
      const issues = e instanceof ApiError && Array.isArray(e.body.issues) ? (e.body.issues as { path: string; message: string }[]) : [];
      notifyError(issues.length ? new Error(issues.map((i) => `${i.path}: ${i.message}`).join("; ")) : e, "Could not save profile");
    },
  });

  const applyFill = (r: FromServerResult, serverName: string) => {
    setS((cur) => {
      const next: ProfileSettings = { ...cur };
      if (r.host) next.host = r.host;
      if (r.port) next.port = r.port;
      if (r.hub) next.hub = r.hub;
      if (r.serverCertPem) { next.serverCertPem = r.serverCertPem; next.checkServerCert = true; }
      if (r.username !== undefined) next.username = r.username;
      if (r.authType) next.authType = r.authType;
      if (r.hashedPassword) { next.hashedPassword = r.hashedPassword; next.password = undefined; }
      if (!next.accountName) next.accountName = `${r.hub} (${r.host})`;
      return next;
    });
    if (r.hashedPassword) setPwMode("hash");
    if (!name) setName(`${r.hub}${r.username ? `-${r.username}` : ""}@${serverName}`);
    setNotice(
      <>
        Filled from <b>{serverName}</b> / hub <b>{r.hub}</b>{r.username ? <> / user <b>{r.username}</b></> : null}.
        {r.serverCertPem ? " Server certificate pinned." : ""}{r.hashedPassword ? " User password hash embedded." : ""}
        {r.warnings.map((w, i) => <Text key={i} size="sm" c="orange">{w}</Text>)}
      </>,
    );
  };

  const hashBoundUser = pwMode === "hash" && !!s.hashedPassword;
  const storedPassword = profile?.settings.password === KEEP;
  /** Typing replaces a stored password; clearing the field falls back to keeping it. */
  const setPassword = (v: string) => set("password", v ? v : storedPassword ? KEEP : undefined);

  const form = (
    <Stack gap="md">
      {readOnly && <ReadOnlyNotice role="viewer" />}
      {notice && <Alert color="blue" variant="light" withCloseButton onClose={() => setNotice(null)}>{notice}</Alert>}
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Stack gap="md">
          <Fieldset legend="Profile">
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label="Profile name" required value={name} onChange={(e) => setName(e.currentTarget.value)} error={err("name")} data-testid="profile-name"
                description="Name of this record in SoftEther Manager (unique). Not shown to end users." />
              <TextInput label="Description" value={description} onChange={(e) => setDescription(e.currentTarget.value)} description="Optional internal notes." />
            </SimpleGrid>
          </Fieldset>

          <Fieldset legend="Connection">
            <Stack gap="sm">
              <TextInput label="Connection setting name (AccountName)" required value={s.accountName} onChange={(e) => set("accountName", e.currentTarget.value)}
                error={err("accountName")} data-testid="profile-account-name"
                description="Name shown in the VPN Client Manager. Must be unique on the client; importing replaces an account with the same name." />
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <TextInput label="VPN server host name or IP" required value={s.host} onChange={(e) => set("host", e.currentTarget.value)} error={err("host")}
                  data-testid="profile-host" description="Address the client connects to (must be reachable by clients)." />
                <NumberInput label="Port" required min={1} max={65535} value={s.port} onChange={(v) => set("port", toNum(v, 443))} error={err("port")}
                  description="TCP listener: 443, 992, 1194 or 5555 by default." />
                <TextInput label="Virtual Hub name" required value={s.hub} onChange={(e) => set("hub", e.currentTarget.value)} error={err("hub")}
                  data-testid="profile-hub" description="Hub to connect to on that server." />
              </SimpleGrid>
            </Stack>
          </Fieldset>

          <Fieldset legend="Authentication">
            <Stack gap="sm">
              <Select label="Authentication type" allowDeselect={false} value={s.authType} onChange={(v) => set("authType", (v ?? "password") as AuthType)}
                data={(Object.keys(AUTH_LABEL) as AuthType[]).map((k) => ({ value: k, label: AUTH_LABEL[k] }))} data-testid="profile-auth-type"
                description={{
                  anonymous: "No credential. Only works if the hub allows anonymous users.",
                  password: "Password checked by the Virtual Hub. The .vpn file stores SHA-0(password + UPPERCASE(username)), never the plain password.",
                  radius: "Password verified by a RADIUS server or Windows NT domain. The password cannot be embedded in a .vpn file; supply it at install time (MSI credential mode \"install-time\") or let the user type it.",
                  certificate: "The client presents an X.509 certificate and private key that the hub trusts.",
                }[s.authType]} />
              {s.authType !== "anonymous" && (
                <TextInput label="User name" value={s.username} onChange={(e) => set("username", e.currentTarget.value)} error={err("username")} data-testid="profile-username"
                  description={hashBoundUser ? "The imported hash is bound to this user name; changing it invalidates the hash." : "Hub user name (case-insensitive)."} />
              )}
              {s.authType === "password" && (
                <>
                  <SegmentedControl value={pwMode} onChange={(v) => {
                    setPwMode(v as "password" | "hash");
                    if (v === "password") set("hashedPassword", undefined); else set("password", undefined);
                  }} data={[{ value: "password", label: "Enter password" }, { value: "hash", label: "Pre-computed hash" }]} />
                  {pwMode === "password" ? (
                    <PasswordInput label="Password" value={s.password === KEEP ? "" : s.password ?? ""} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="new-password"
                      data-testid="profile-password" placeholder={s.password === KEEP ? "Stored password kept — type to replace" : undefined}
                      description={storedPassword ? "A password is stored for this profile. Leave empty to keep it, or type a new one to replace it." : "Hashed on the server when the .vpn file is generated. Leave empty if the user or the installer supplies it."} />
                  ) : (
                    s.hashedPassword === KEEP ? (
                      <Alert color="gray" variant="light" py={6}>
                        <Group justify="space-between"><Text size="sm">A stored password hash is kept.</Text>
                          <Button size="xs" variant="subtle" color="red" onClick={() => set("hashedPassword", undefined)}>Remove</Button></Group>
                      </Alert>
                    ) : (
                      <TextInput label="Hashed password (base64)" value={s.hashedPassword ?? ""} onChange={(e) => set("hashedPassword", e.currentTarget.value.trim() || undefined)}
                        error={err("hashedPassword")} styles={{ input: { fontFamily: "monospace" } }}
                        description="Base64 SHA-0 hash as stored by the hub (HashedKey). Use “Fill from managed server” to import it." />
                    )
                  )}
                </>
              )}
              {s.authType === "radius" && (
                <PasswordInput label="Password (optional)" value={s.password === KEEP ? "" : s.password ?? ""} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="new-password"
                  placeholder={s.password === KEEP ? "Stored password kept — type to replace" : undefined}
                  description="Stored (encrypted) for reference only: the .vpn file cannot carry a RADIUS/NT password. Deliver it with the MSI install-time credential mode." />
              )}
              {s.authType === "certificate" && (
                <>
                  <PemField label="Client certificate" kind="CERTIFICATE" value={s.clientCertPem} onChange={(v) => set("clientCertPem", v)} error={err("clientCertPem")}
                    description="X.509 certificate (PEM or DER) registered for the user or signed by a CA the hub trusts." testId="profile-client-cert" />
                  <PemField label="Client private key" kind="PRIVATE KEY" value={s.clientKeyPem} onChange={(v) => set("clientKeyPem", v)} error={err("clientKeyPem")}
                    keepLabel="The stored private key is kept (encrypted at rest)."
                    description="Unencrypted RSA private key matching the certificate. It is embedded in the .vpn file." testId="profile-client-key" />
                </>
              )}
              {s.authType === "password" && !s.password && !s.hashedPassword && (
                <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
                  No password set: the profile will contain the hash of an empty password. That is fine when the MSI supplies credentials at
                  install time or the user types them, but the connection will fail otherwise.
                </Alert>
              )}
            </Stack>
          </Fieldset>

          <Fieldset legend="Server certificate verification">
            <Stack gap="sm">
              <Switch label="Always verify the server certificate (CheckServerCert)" checked={s.checkServerCert || !!s.serverCertPem}
                disabled={!!s.serverCertPem} onChange={(e) => set("checkServerCert", e.currentTarget.checked)}
                description={s.serverCertPem ? "Always on while a certificate is pinned." : "Reject servers whose certificate is not trusted. Without a pinned certificate the client uses its trusted CA list (and prompts the user otherwise)."} />
              <Switch label="Trust the default root CA list (AddDefaultCA)" checked={s.addDefaultCa} onChange={(e) => set("addDefaultCa", e.currentTarget.checked)}
                description="Also accept server certificates issued by the built-in list of public root CAs (e.g. a Let's Encrypt certificate on the VPN server)." />
              <PemField label="Pinned server certificate" kind="CERTIFICATE" value={s.serverCertPem} onChange={(v) => set("serverCertPem", v)} testId="profile-server-cert"
                description="The exact certificate the server must present (ServerCert). Recommended for self-signed server certificates." />
            </Stack>
          </Fieldset>

          <Fieldset legend="Behaviour">
            <Stack gap="sm">
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Switch label="Startup connection" checked={s.startup} onChange={(e) => set("startup", e.currentTarget.checked)}
                  description="Connect automatically whenever the VPN Client service starts (always-on VPN)." />
                <Select label="Virtual network adapter" value={s.deviceName} onChange={(v) => set("deviceName", v ?? "VPN")} data={NIC_OPTIONS} searchable allowDeselect={false}
                  error={err("deviceName")} description="Client virtual NIC used by this connection (VPN … VPN127). The MSI installer overrides this with its own NIC name." />
              </SimpleGrid>
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Stack gap={4}>
                  <Switch label="Retry forever" checked={s.numRetry === INFINITE} onChange={(e) => set("numRetry", e.currentTarget.checked ? INFINITE : 10)} />
                  <NumberInput label="Number of reconnect attempts" min={0} max={INFINITE - 1} disabled={s.numRetry === INFINITE}
                    value={s.numRetry === INFINITE ? "" : s.numRetry} placeholder="Infinite" onChange={(v) => set("numRetry", toNum(v))} error={err("numRetry")}
                    description="How often to reconnect after a failure or disconnect. 0 = never." />
                </Stack>
                <NumberInput label="Reconnect interval (seconds)" min={5} max={3600} value={s.retryInterval} onChange={(v) => set("retryInterval", toNum(v, 15))}
                  error={err("retryInterval")} description="Wait between reconnect attempts (5 – 3600)." />
              </SimpleGrid>
            </Stack>
          </Fieldset>

          <Fieldset legend="Advanced communication settings">
            <Stack gap="sm">
              <SimpleGrid cols={{ base: 1, sm: 3 }}>
                <NumberInput label="TCP connections" min={1} max={32} value={s.maxConnection} onChange={(v) => set("maxConnection", toNum(v, 1))} error={err("maxConnection")}
                  data-testid="profile-max-connection" description="Parallel TCP connections per session (1 – 32). More can raise throughput on high-latency links." />
                <NumberInput label="Interval between connections (s)" min={1} max={3600} value={s.additionalConnectionInterval}
                  onChange={(v) => set("additionalConnectionInterval", toNum(v, 1))} error={err("additionalConnectionInterval")}
                  description="Delay before establishing each additional TCP connection." />
                <NumberInput label="TCP connection lifetime (s)" min={0} value={s.connectionDisconnectSpan} onChange={(v) => set("connectionDisconnectSpan", toNum(v))}
                  error={err("connectionDisconnectSpan")} description="Recycle each TCP connection after this many seconds. 0 = keep indefinitely." />
              </SimpleGrid>
              <SimpleGrid cols={{ base: 1, sm: 2 }} verticalSpacing="sm">
                <Switch label="Encrypt VPN communication (SSL)" checked={s.useEncrypt} onChange={(e) => set("useEncrypt", e.currentTarget.checked)}
                  description="Disable only on trusted networks to save CPU; credentials stay protected." />
                <Switch label="Compress data" checked={s.useCompress} onChange={(e) => set("useCompress", e.currentTarget.checked)}
                  description="Deflate compression. Saves bandwidth on slow links but costs CPU; usually off." />
                <Switch label="Half-duplex mode" checked={s.halfConnection} onChange={(e) => set("halfConnection", e.currentTarget.checked)} error={err("halfConnection")}
                  description="Use each TCP connection in one direction only (needs ≥ 2 connections)." />
                <Switch label="Disable UDP acceleration" checked={s.noUdpAcceleration} onChange={(e) => set("noUdpAcceleration", e.currentTarget.checked)}
                  description="Force TCP only, e.g. when a firewall breaks UDP." />
                <Switch label="Disable VoIP / QoS control" checked={s.disableQoS} onChange={(e) => set("disableQoS", e.currentTarget.checked)}
                  description="Turn off prioritisation of VoIP-like packets." />
                <Switch label="Disable routing table tracking" checked={s.noRoutingTracking} onChange={(e) => set("noRoutingTracking", e.currentTarget.checked)}
                  description="Stop the client from watching the routing table to keep the server route reachable." />
                <Switch label="Bridge / router mode" checked={s.requireBridgeRoutingMode} onChange={(e) => set("requireBridgeRoutingMode", e.currentTarget.checked)}
                  description="Request a session that may carry traffic from other MAC addresses (needs server permission)." />
                <Switch label="Monitoring mode" checked={s.requireMonitorMode} onChange={(e) => set("requireMonitorMode", e.currentTarget.checked)}
                  description="Request a session that receives all packets on the hub (needs a policy allowing it)." />
                <Switch label="Hide connection status window" checked={s.hideStatusWindow} onChange={(e) => set("hideStatusWindow", e.currentTarget.checked)}
                  description="Do not show the progress window while connecting." />
                <Switch label="Hide virtual NIC IP information" checked={s.hideNicInfoWindow} onChange={(e) => set("hideNicInfoWindow", e.currentTarget.checked)}
                  description="Do not show the IP address notification after connecting." />
              </SimpleGrid>
            </Stack>
          </Fieldset>

          <Fieldset legend="Proxy">
            <Stack gap="sm">
              <Select label="Connection method" data={PROXY_TYPES} value={s.proxyType} allowDeselect={false} onChange={(v) => set("proxyType", (v ?? "direct") as ProxyType)}
                description="Route the VPN connection through a proxy server." />
              {s.proxyType !== "direct" && (
                <>
                  <SimpleGrid cols={{ base: 1, sm: 3 }}>
                    <TextInput label="Proxy host" value={s.proxyHost} onChange={(e) => set("proxyHost", e.currentTarget.value)} error={err("proxyHost")} />
                    <NumberInput label="Proxy port" min={1} max={65535} value={s.proxyPort || ""} onChange={(v) => set("proxyPort", toNum(v))} error={err("proxyPort")} />
                    <TextInput label="Proxy user name" value={s.proxyUsername} onChange={(e) => set("proxyUsername", e.currentTarget.value)} description="Optional." />
                  </SimpleGrid>
                  <Text size="xs" c="dimmed">Proxy passwords cannot be stored in a .vpn file; users are prompted for it.</Text>
                </>
              )}
            </Stack>
          </Fieldset>
        </Stack>
      </fieldset>
    </Stack>
  );

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="min(1280px, 100vw)" data-testid="profile-editor"
      title={<Text fw={700}>{profile ? `Edit profile ${profile.name}` : "New connection profile"}</Text>}>
      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <div>
          {!readOnly && (
            <Group mb="sm">
              <Button variant="light" leftSection={<IconServer size={16} />} onClick={() => setFillOpen(true)} data-testid="fill-from-server">Fill from managed server</Button>
            </Group>
          )}
          {form}
          {!readOnly && (
            <Group justify="flex-end" mt="md" pb="md">
              <Button variant="default" onClick={onClose}>Cancel</Button>
              <Button loading={save.isPending} data-testid="profile-save" onClick={() => {
                setTouched(true);
                if (Object.keys(errors).length) { notifyError(new Error(Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join("; ")), "Please fix the highlighted fields"); return; }
                save.mutate();
              }}>{profile ? "Save profile" : "Create profile"}</Button>
            </Group>
          )}
        </div>
        <div style={{ position: "sticky", top: 70, alignSelf: "start" }}>
          <Group justify="space-between" mb={6}>
            <Text fw={600}>.vpn preview {preview.isFetching && <Loader size={12} ml={6} />}</Text>
            {preview.data && (
              <Button size="xs" variant="subtle" leftSection={<IconDownload size={14} />}
                onClick={() => downloadText(`${(s.accountName || "profile").replace(/[^\w.-]+/g, "_")}.vpn`, preview.data!.content, "application/x-softether-vpn")}>
                Download preview
              </Button>
            )}
          </Group>
          {!canPreview ? (
            <Text size="sm" c="dimmed">Previewing requires operator access.</Text>
          ) : !previewable ? (
            <Text size="sm" c="dimmed">Enter the connection setting name, host and hub to see the generated file.</Text>
          ) : preview.error ? (
            <ErrorAlert error={preview.error} />
          ) : (
            <ScrollArea.Autosize mah="calc(100vh - 160px)" type="auto">
              <Code block data-testid="profile-preview" style={{ fontSize: 11, whiteSpace: "pre" }}>{preview.data?.content.replace(/\r\n/g, "\n") ?? ""}</Code>
            </ScrollArea.Autosize>
          )}
          {(s.password === KEEP || s.hashedPassword === KEEP || s.clientKeyPem === KEEP) && (
            <Text size="xs" c="dimmed" mt={4}>Stored secrets are never sent to the browser; the preview shows placeholder values for them. The downloaded .vpn contains the real values.</Text>
          )}
        </div>
      </SimpleGrid>
      <FromServerModal opened={fillOpen} onClose={() => setFillOpen(false)} onApply={applyFill} />
    </Drawer>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export default function ProfilesPage() {
  const role = useGlobalRole();
  const isOperator = can(role, "operator");
  const qc = useQueryClient();
  const profiles = useProfiles();
  const [editing, setEditing] = useState<Profile | null>(null);
  const [initial, setInitial] = useState<Initial | null>(null);
  const [open, setOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const handledDeepLink = useRef(false);

  const remove = useMutation({
    mutationFn: (p: Profile) => del(`/api/deploy/profiles/${p.id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: deployKeys.profiles }); notifications.show({ color: "green", message: "Profile deleted" }); },
    onError: (e) => notifyError(e, "Could not delete profile"),
  });

  // Deep link from a hub's user list: /deploy/profiles?serverId=1&hub=T1&user=alice
  useEffect(() => {
    const sid = params.get("serverId"), hub = params.get("hub"), user = params.get("user");
    if (handledDeepLink.current || !sid || !hub || !isOperator) return;
    handledDeepLink.current = true;
    setParams({}, { replace: true });
    post<FromServerResult>("/api/deploy/from-server", { serverId: Number(sid), hub, username: user || undefined, pinCertificate: true, includeUserHash: false })
      .then((r) => {
        setEditing(null);
        setInitial({
          ...r, accountName: `${r.hub} (${r.host})`, profileName: `${hub}${user ? `-${user}` : ""}`,
          notice: (
            <>
              Prefilled from server #{sid} / hub <b>{hub}</b>{user ? <> / user <b>{user}</b></> : null}
              {r.serverCertPem ? "; server certificate pinned" : ""}. The user's password is not included — enter it, or use
              “Fill from managed server” with “Include the user's password hash”.
              {r.warnings.map((w, i) => <Text key={i} size="sm" c="orange">{w}</Text>)}
            </>
          ),
        });
        setOpen(true);
      })
      .catch((e) => notifyError(e, "Could not prefill from server"));
  }, [params, isOperator]);

  const openNew = () => { setEditing(null); setInitial(null); setOpen(true); };
  const profilesWithHash = useMemo(() => (profiles.data ?? []).filter((p) => p.settings.authType === "password" && p.settings.hasPassword).length, [profiles.data]);

  return (
    <>
      <PageHeader
        title="Connection profiles"
        description="Connection settings (.vpn files) for the SoftEther VPN Client. Import them in the VPN Client Manager, with vpncmd AccountImport, or bundle them into an MSI installer for silent deployment."
        actions={isOperator && <Button leftSection={<IconPlus size={16} />} onClick={openNew} data-testid="create-profile">New profile</Button>}
      />
      {!isOperator && <ReadOnlyNotice role={role} />}
      <Alert color="orange" variant="light" icon={<IconShieldLock size={18} />} mb="md" title="Treat .vpn files and installers as secrets">
        For password authentication a .vpn file stores SHA-0(password + UPPERCASE(username)). That hash is <b>password-equivalent</b>: anyone holding the file can
        log in as that user, and the hash cannot be “un-shared” without changing the password. Client private keys are embedded in clear as well.
        Downloads and hash exports are recorded in the audit log; secrets are encrypted at rest here.
        {profilesWithHash > 0 && <Text size="sm" mt={4}>{profilesWithHash} profile(s) currently carry a password or password hash.</Text>}
      </Alert>
      <QueryState query={profiles}>
        <DataTable
          testId="profiles-table"
          data={profiles.data}
          rowKey={(p) => p.id}
          onRowClick={(p) => { setEditing(p); setInitial(null); setOpen(true); }}
          initialSort={{ key: "name", dir: "asc" }}
          empty={isOperator ? "No profiles yet. Create one, or open a hub user's page and choose “Create client profile”." : "No profiles yet."}
          columns={[
            {
              key: "name", title: "Name",
              render: (p) => (
                <div>
                  <Text fw={600} size="sm">{p.name}</Text>
                  {p.description && <Text size="xs" c="dimmed" lineClamp={1}>{p.description}</Text>}
                  {p.settings.accountName !== p.name && <Text size="xs" c="dimmed">Account: {p.settings.accountName}</Text>}
                </div>
              ),
            },
            { key: "server", title: "Server", value: (p) => `${p.settings.host}:${p.settings.port}`, render: (p) => <Code>{p.settings.host}:{p.settings.port}</Code> },
            { key: "hub", title: "Hub", value: (p) => p.settings.hub },
            { key: "auth", title: "Authentication", value: (p) => p.settings.authType, render: (p) => <AuthBadge type={p.settings.authType} /> },
            {
              key: "user", title: "User", value: (p) => p.settings.username,
              render: (p) => (
                <Group gap={4} wrap="nowrap">
                  <Text size="sm">{p.settings.username || "–"}</Text>
                  {p.settings.hashedPassword && <Tooltip label="Embedded password hash imported from the server"><Badge size="xs" color="orange" variant="light">hash</Badge></Tooltip>}
                  {p.settings.authType === "password" && !p.settings.hasPassword && <Tooltip label="No password stored"><Badge size="xs" color="gray" variant="light">no password</Badge></Tooltip>}
                </Group>
              ),
            },
            { key: "startup", title: "Startup", value: (p) => (p.settings.startup ? 1 : 0), render: (p) => (p.settings.startup ? <Badge variant="light" color="green">Auto-connect</Badge> : <Text size="sm" c="dimmed">Manual</Text>) },
            {
              key: "pinned", title: "Pinned cert", value: (p) => (p.settings.serverCertPem ? 1 : 0),
              render: (p) => (p.settings.serverCertPem
                ? <Badge variant="light" color="teal" leftSection={<IconCertificate size={12} />}>Yes</Badge>
                : <Text size="sm" c="dimmed">{p.settings.checkServerCert ? "CA check" : "No"}</Text>),
            },
            { key: "updatedAt", title: "Updated", value: (p) => p.updatedAt, render: (p) => <Tooltip label={`${dt(p.updatedAt)} by ${p.createdBy}`}><Text size="sm">{ago(p.updatedAt)}</Text></Tooltip> },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (p) => isOperator && (
                <Group gap={6} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                  <Tooltip label="Download .vpn file (audited)">
                    <Button size="xs" variant="light" leftSection={<IconCloudDownload size={14} />} data-testid={`download-profile-${p.id}`}
                      onClick={() => download(`/api/deploy/profiles/${p.id}/vpn`)}>.vpn</Button>
                  </Tooltip>
                  <ConfirmButton
                    title={`Delete profile ${p.name}?`}
                    message={<>The profile is removed permanently. Installers already built keep their embedded copy, but new builds can no longer use it.</>}
                    typeToConfirm={p.name}
                    confirmLabel="Delete profile"
                    onConfirm={() => remove.mutateAsync(p)}
                    leftSection={<IconTrash size={14} />}
                  >Delete</ConfirmButton>
                </Group>
              ),
            },
          ]}
        />
      </QueryState>
      <Divider my="lg" />
      <Text size="xs" c="dimmed">
        Manual import on a client: <Code>vpncmd localhost /CLIENT /CMD AccountImport profile.vpn</Code>, then <Code>AccountStartupSet</Code> / <Code>AccountConnect</Code>.
      </Text>
      <ProfileEditor opened={open} onClose={() => setOpen(false)} profile={editing} initial={initial} readOnly={!isOperator} canPreview={isOperator} />
    </>
  );
}
