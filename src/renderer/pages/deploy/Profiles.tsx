// Client Deployment › Custom Profiles: hand-made connection settings (.vpn files) for the SoftEther VPN Client,
// with a live preview of the generated file. They can be saved as .vpn or bundled into MSI installers.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Loader, NumberInput, PasswordInput, SegmentedControl, Select, Textarea, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import {
  IconCertificate, IconCopy, IconDownload, IconFileCertificate, IconPencil, IconPlus, IconServer, IconShieldLock, IconTrash,
} from "@tabler/icons-react";
import { ApiError, del, download, post, put } from "../../lib/api";
import { agoShort, downloadText, dt } from "../../lib/format";
import { notifyError, notifySuccess, useRpc, useServers } from "../../lib/hooks";
import { confirmAction, DataTable, ErrorState, FormRow, FormSection, Mono, PageHeader, Section, Sheet, Tag } from "../../design";
import {
  AUTH_LABEL, AuthBadge, KEEP, NIC_OPTIONS, NIC_RE, deployKeys, pemSummary, pickPemFile, useProfiles,
  type AuthType, type Profile, type ProfileSettings, type ProxyType,
} from "../../components/domain/deploy";
import { Callout } from "../../components/domain/ui";
import { CodeBlock, SheetFooter, SwitchRow } from "./_deployment/shared";

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
  { value: "direct", label: "Direct (no proxy)" },
  { value: "http", label: "HTTP proxy" },
  { value: "socks4", label: "SOCKS4 proxy" },
  { value: "socks5", label: "SOCKS5 proxy" },
];
const AUTH_HELP: Record<AuthType, string> = {
  anonymous: "No credential. Works only if the hub allows anonymous users.",
  password: "Checked by the Virtual Hub. The .vpn file stores SHA-0(password + UPPERCASE(user name)), never the password itself.",
  radius: "Checked by a RADIUS server or Windows domain. A .vpn file can’t carry this password: supply it at install time or let the user type it.",
  certificate: "The client presents an X.509 certificate and private key that the hub trusts.",
};
const USER_AUTH: Record<number, string> = { 0: "anonymous", 1: "password", 2: "user certificate", 3: "signed certificate", 4: "RADIUS", 5: "NT domain" };

interface FromServerResult extends Partial<ProfileSettings> { warnings: string[] }
type Initial = Partial<ProfileSettings> & { profileName?: string; description?: string; notice?: ReactNode };

const toNum = (v: number | string, fallback = 0) => (typeof v === "number" ? v : v === "" ? fallback : Number(v) || fallback);
const isB64Hash = (s: string) => /^[A-Za-z0-9+/]{27}=$/.test(s);
const vpnName = (s: string) => `${(s || "profile").replace(/[^\w.-]+/g, "_")}.vpn`;

/** The body the backend accepts: drop secrets that don't apply to the authentication type. */
function cleanSettings(s: ProfileSettings): ProfileSettings {
  const out: ProfileSettings = { ...s, username: s.username.trim(), host: s.host.trim(), hub: s.hub.trim(), accountName: s.accountName.trim() };
  if (s.authType !== "password" && s.authType !== "radius") { out.password = undefined; out.hashedPassword = undefined; }
  if (s.authType === "radius") out.hashedPassword = undefined;
  if (s.authType !== "certificate") { out.clientCertPem = undefined; out.clientKeyPem = undefined; }
  for (const k of ["password", "hashedPassword", "clientCertPem", "clientKeyPem", "serverCertPem"] as const) if (out[k] === "") out[k] = undefined;
  if (out.proxyType === "direct") { out.proxyHost = ""; out.proxyPort = 0; out.proxyUsername = ""; }
  return out;
}

/** Stored secrets never come back to the renderer, so the preview uses placeholders for them. */
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
  if (!name.trim()) e.name = "Enter a name.";
  else if (name.trim().length > 100) e.name = "Up to 100 characters.";
  const acct = s.accountName.trim();
  if (!acct) e.accountName = "Enter the connection name.";
  else if (/["`\x00-\x1f‘-‛]/.test(acct)) e.accountName = "Quotes, backticks and control characters aren’t allowed.";
  else if (acct.startsWith("/")) e.accountName = "Can’t start with “/”.";
  if (!s.host.trim()) e.host = "Enter the server’s host name or IP address.";
  else if (/\s/.test(s.host.trim())) e.host = "A host name can’t contain spaces.";
  if (!s.hub.trim()) e.hub = "Enter the Virtual Hub name.";
  if (!(Number.isInteger(s.port) && s.port >= 1 && s.port <= 65535)) e.port = "1 to 65535.";
  if (!NIC_RE.test(s.deviceName)) e.deviceName = "VPN, VPN2 … VPN127.";
  if (s.authType !== "anonymous" && !s.username.trim()) e.username = "Enter the user name.";
  if (s.hashedPassword && s.hashedPassword !== KEEP && !isB64Hash(s.hashedPassword)) e.hashedPassword = "A base64 SHA-0 hash: 28 characters (20 bytes).";
  if (s.authType === "certificate") {
    if (!s.clientCertPem) e.clientCertPem = "Add the client certificate.";
    if (!s.clientKeyPem) e.clientKeyPem = "Add the matching private key.";
  }
  if (!(s.maxConnection >= 1 && s.maxConnection <= 32)) e.maxConnection = "1 to 32.";
  if (s.halfConnection && s.maxConnection < 2) e.halfConnection = "Half-duplex needs at least 2 TCP connections.";
  if (!(s.retryInterval >= 5 && s.retryInterval <= 3600)) e.retryInterval = "5 to 3600 seconds.";
  if (!(s.additionalConnectionInterval >= 1 && s.additionalConnectionInterval <= 3600)) e.additionalConnectionInterval = "1 to 3600 seconds.";
  if (s.connectionDisconnectSpan < 0) e.connectionDisconnectSpan = "0 or more.";
  if (s.numRetry < 0 || s.numRetry > INFINITE) e.numRetry = "Out of range.";
  if (s.proxyType !== "direct") {
    if (!s.proxyHost.trim()) e.proxyHost = "Enter the proxy host.";
    if (!(s.proxyPort >= 1 && s.proxyPort <= 65535)) e.proxyPort = "1 to 65535.";
  }
  return e;
}

// ------------------------------------------------------------------ fill from a saved connection

function FromServerSheet({ opened, onClose, onApply }: { opened: boolean; onClose: () => void; onApply: (r: FromServerResult, serverName: string) => void }) {
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
    setServerId(null); setHub(null); setUser(null); setHost(""); setPort(""); setPin(true); setIncludeHash(false);
  }, [opened]);

  const sid = serverId ? Number(serverId) : NaN;
  const server = servers.data?.find((s) => s.id === sid);
  const hubs = useRpc<{ HubList?: { HubName_str: string }[] }>(sid, "EnumHub", {}, { enabled: opened && Number.isFinite(sid) });
  const users = useRpc<{ UserList?: { Name_str: string; AuthType_u32: number; Realname_utf?: string }[] }>(
    sid, "EnumUser", { HubName_str: hub ?? "" }, { enabled: opened && Number.isFinite(sid) && !!hub });
  const selUser = users.data?.UserList?.find((u) => u.Name_str === user);
  const hashOk = !!user && selUser?.AuthType_u32 === 1;

  const fill = useMutation({
    mutationFn: () => post<FromServerResult>("/api/deploy/from-server", {
      serverId: sid, hub, username: user || undefined, pinCertificate: pin, includeUserHash: hashOk && includeHash,
      host: host.trim() || undefined, port: port === "" ? undefined : Number(port),
    }),
    onSuccess: (r) => { onApply(r, server?.name ?? String(sid)); onClose(); },
    onError: (e) => notifyError(e, "Couldn’t read the settings from the server"),
  });

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={fill.isPending} size={600} testId="fill-sheet"
      icon={<IconServer size={19} stroke={1.5} />} title="Fill from a Server"
      subtitle="Copies the endpoint of a saved connection, pins its certificate and sets the user’s authentication type."
      footer={(
        <SheetFooter>
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button disabled={!serverId || !hub} loading={fill.isPending} onClick={() => fill.mutate()} data-testid="fill-apply">Fill Profile</Button>
        </SheetFooter>
      )}
    >
      <FormSection>
        <FormRow label="Server">
          {(id) => (
            <Select id={id} w="100%" data-testid="fill-server" placeholder="Choose a connection" searchable
              data={(servers.data ?? []).map((s) => ({ value: String(s.id), label: `${s.name} (${s.host}:${s.port})` }))}
              value={serverId} onChange={(v) => { setServerId(v); setHub(null); setUser(null); }} />
          )}
        </FormRow>
        <FormRow label="Virtual Hub" error={hubs.error ? hubs.error.message : undefined}>
          {(id) => (
            <Select id={id} w="100%" data-testid="fill-hub" placeholder={hubs.isFetching ? "Loading…" : "Choose a hub"} disabled={!serverId} searchable
              data={(hubs.data?.HubList ?? []).map((h) => h.HubName_str)} value={hub} onChange={(v) => { setHub(v); setUser(null); }} />
          )}
        </FormRow>
        <FormRow label="User" description="Optional. Sets the user name and authentication type." error={users.error ? users.error.message : undefined}>
          {(id) => (
            <Select id={id} w="100%" data-testid="fill-user" placeholder={users.isFetching ? "Loading…" : "No specific user"} disabled={!hub} clearable searchable
              data={(users.data?.UserList ?? []).map((u) => ({ value: u.Name_str, label: `${u.Name_str} — ${USER_AUTH[u.AuthType_u32] ?? `type ${u.AuthType_u32}`}${u.Realname_utf ? ` (${u.Realname_utf})` : ""}` }))}
              value={user} onChange={setUser} />
          )}
        </FormRow>
        <FormRow label="Public host" description="Optional. The address clients use; this app’s address may be internal.">
          {(id) => <TextInput id={id} w="100%" placeholder={server?.host ?? "Server host"} value={host} onChange={(e) => setHost(e.currentTarget.value)} />}
        </FormRow>
        <FormRow label="Port">
          {(id) => <NumberInput id={id} w={120} placeholder={server ? String(server.port) : "443"} min={1} max={65535} allowDecimal={false} value={port} onChange={setPort} />}
        </FormRow>
        <SwitchRow label="Pin the server certificate" description="The client refuses a server that presents a different certificate. Re-issue profiles after renewing it." checked={pin} onChange={setPin} />
        <SwitchRow label="Include the user’s password hash" checked={includeHash} disabled={!hashOk} onChange={setIncludeHash} testId="fill-include-hash"
          description={user && !hashOk ? "Only for users with password authentication." : "Exports the stored hash so the profile logs in without the password."} />
      </FormSection>
      {includeHash && hashOk && (
        <div className="sem-callouts">
          <Callout tone="orange" icon={<IconShieldLock size={16} stroke={1.7} />} title="This hash works like the password.">
            Anyone with it can sign in as <b>{user}</b>. Only give the resulting profile or installer to that user’s devices.
          </Callout>
        </div>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ PEM field

function PemRow({ label, description, value, onChange, kind, error, keepLabel, testId }: {
  label: string; description: ReactNode; value: string | undefined; onChange: (v: string | undefined) => void;
  kind: "CERTIFICATE" | "PRIVATE KEY"; error?: string; keepLabel?: string; testId?: string;
}) {
  const kept = value === KEEP;
  const choose = async () => {
    try {
      const f = await pickPemFile(kind, kind === "CERTIFICATE" ? "Choose a Certificate" : "Choose a Private Key");
      if (f) onChange(f.pem);
    } catch (e) { notifyError(e, "Couldn’t read the file"); }
  };
  return (
    <FormRow label={label} description={description} stacked error={error}>
      {(id) => (
        <>
          {kept
            ? <div className="sem-dim" data-testid={testId ? `${testId}-kept` : undefined}>{keepLabel ?? "A stored value is kept."} Choose a file or paste to replace it.</div>
            : <Textarea id={id} w="100%" value={value ?? ""} onChange={(e) => onChange(e.currentTarget.value || undefined)} autosize minRows={2} maxRows={6}
                placeholder={`-----BEGIN ${kind}-----\n…\n-----END ${kind}-----`} error={!!error} data-testid={testId}
                styles={{ input: { fontFamily: "var(--sem-font-mono)", fontSize: "var(--sem-fz-caption)" } }} />}
          <div className="sem-row-inline" style={{ width: "100%" }}>
            <Button size="xs" variant="default" onClick={choose} data-testid={testId ? `${testId}-upload` : undefined}>Choose File…</Button>
            {kept && <Button size="xs" variant="default" onClick={() => onChange("")}>Replace…</Button>}
            {value && <Button size="xs" variant="subtle" color="red" onClick={() => onChange(undefined)}>Clear</Button>}
            <span style={{ flex: 1 }} />
            {value && !kept && <span className="sem-dim">{pemSummary(value)}</span>}
          </div>
        </>
      )}
    </FormRow>
  );
}

// ------------------------------------------------------------------ editor

function ProfileSheet({ opened, onClose, profile, initial }: { opened: boolean; onClose: () => void; profile: Profile | null; initial: Initial | null }) {
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
    for (const k of ["hasPassword", "hasClientKey", "warnings", "profileName", "notice", "description"]) delete (base as unknown as Record<string, unknown>)[k];
    setS(base);
    setName(profile?.name ?? initial?.profileName ?? "");
    setDescription(profile?.description ?? initial?.description ?? "");
    setPwMode(base.hashedPassword ? "hash" : "password");
    setNotice(initial?.notice ?? null);
    setTouched(false);
  }, [opened, profile?.id, initial]);

  const set = <K extends keyof ProfileSettings>(k: K, v: ProfileSettings[K]) => setS((cur) => ({ ...cur, [k]: v }));
  const errors = validate(name, s);
  const err = (k: string) => (touched ? errors[k] : undefined);

  const [debounced] = useDebouncedValue(s, 350);
  const previewable = !!debounced.accountName.trim() && !!debounced.host.trim() && !!debounced.hub.trim() && NIC_RE.test(debounced.deviceName);
  const preview = useQuery({
    queryKey: ["deploy", "render", debounced],
    queryFn: () => post<{ content: string }>("/api/deploy/render", previewSettings(debounced)),
    enabled: opened && previewable, retry: false, placeholderData: (prev) => prev,
  });

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description, settings: cleanSettings(s) };
      return profile ? put(`/api/deploy/profiles/${profile.id}`, body) : post("/api/deploy/profiles", body);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: deployKeys.profiles });
      notifySuccess(profile ? `Saved “${name.trim()}”` : `Created “${name.trim()}”`);
      onClose();
    },
    onError: (e) => notifyError(e, e instanceof ApiError && e.status === 409 ? "That name is taken" : "Couldn’t save the profile"),
  });
  const submit = () => {
    setTouched(true);
    if (Object.keys(errors).length) {
      requestAnimationFrame(() => document.querySelector(".sem-sheet .sem-form-row-error")?.scrollIntoView({ block: "center", behavior: "smooth" }));
      return;
    }
    save.mutate();
  };

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
        Filled from <b>{serverName}</b>, hub <b>{r.hub}</b>{r.username ? <>, user <b>{r.username}</b></> : null}.
        {r.serverCertPem ? " Server certificate pinned." : ""}{r.hashedPassword ? " Password hash embedded." : ""}
        {r.warnings.map((w, i) => <div key={i} className="sem-text-red">{w}</div>)}
      </>,
    );
  };

  const hashBoundUser = pwMode === "hash" && !!s.hashedPassword;
  const storedPassword = profile?.settings.password === KEEP;
  /** Typing replaces a stored password; clearing the field keeps it. */
  const setPassword = (v: string) => set("password", v ? v : storedPassword ? KEEP : undefined);
  const badCount = Object.keys(errors).length;
  const content = preview.data?.content.replace(/\r\n/g, "\n") ?? "";

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={save.isPending} size="min(1160px, calc(100vw - 64px))" testId="profile-editor"
      icon={<IconFileCertificate size={19} stroke={1.5} />}
      title={profile ? `Edit “${profile.name}”` : "New Custom Profile"}
      subtitle="Connection settings for the SoftEther VPN Client (.vpn)."
      footer={(
        <SheetFooter
          leading={(
            <>
              <Button variant="default" leftSection={<IconServer size={14} />} onClick={() => setFillOpen(true)} data-testid="fill-from-server">Fill from Server…</Button>
              {touched && badCount > 0 && <span className="sem-text-red" data-testid="profile-errors">{badCount === 1 ? "Fix 1 field" : `Fix ${badCount} fields`} to save.</span>}
            </>
          )}
        >
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button loading={save.isPending} onClick={submit} data-testid="profile-save">{profile ? "Save" : "Create Profile"}</Button>
        </SheetFooter>
      )}
    >
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)", gap: "var(--sem-space-8)", alignItems: "start" }}>
        <div>
          {notice && <div className="sem-callouts" style={{ marginTop: 0 }}><Callout tone="accent" testId="profile-notice" action={<Button size="xs" variant="subtle" onClick={() => setNotice(null)}>Dismiss</Button>}>{notice}</Callout></div>}
          <FormSection title="Profile">
            <FormRow label="Name" description="Only in this app. Must be unique." error={err("name")}>
              {(id) => <TextInput id={id} w="100%" value={name} onChange={(e) => setName(e.currentTarget.value)} error={!!err("name")} data-testid="profile-name" data-autofocus />}
            </FormRow>
            <FormRow label="Notes">{(id) => <TextInput id={id} w="100%" value={description} onChange={(e) => setDescription(e.currentTarget.value)} placeholder="Optional" />}</FormRow>
          </FormSection>

          <FormSection title="Connection">
            <FormRow label="Connection name" description="Shown in the VPN Client Manager. Importing replaces a connection with the same name." error={err("accountName")}>
              {(id) => <TextInput id={id} w="100%" value={s.accountName} onChange={(e) => set("accountName", e.currentTarget.value)} error={!!err("accountName")} data-testid="profile-account-name" />}
            </FormRow>
            <FormRow label="Server" description="Host name or IP address clients can reach." error={err("host")}>
              {(id) => <TextInput id={id} w="100%" value={s.host} onChange={(e) => set("host", e.currentTarget.value)} error={!!err("host")} data-testid="profile-host" placeholder="vpn.example.com" />}
            </FormRow>
            <FormRow label="Port" description="443, 992, 1194 or 5555 by default." error={err("port")}>
              {(id) => <NumberInput id={id} w={120} min={1} max={65535} allowDecimal={false} value={s.port} onChange={(v) => set("port", toNum(v, 443))} error={!!err("port")} data-testid="profile-port" />}
            </FormRow>
            <FormRow label="Virtual Hub" error={err("hub")}>
              {(id) => <TextInput id={id} w={220} value={s.hub} onChange={(e) => set("hub", e.currentTarget.value)} error={!!err("hub")} data-testid="profile-hub" />}
            </FormRow>
          </FormSection>

          <FormSection title="Authentication" description={AUTH_HELP[s.authType]}>
            <FormRow label="Type">
              {(id) => (
                <Select id={id} w={240} allowDeselect={false} value={s.authType} onChange={(v) => set("authType", (v ?? "password") as AuthType)} data-testid="profile-auth-type"
                  data={(Object.keys(AUTH_LABEL) as AuthType[]).map((k) => ({ value: k, label: AUTH_LABEL[k] }))} />
              )}
            </FormRow>
            {s.authType !== "anonymous" && (
              <FormRow label="User name" description={hashBoundUser ? "The imported hash belongs to this user name; changing it breaks the hash." : undefined} error={err("username")}>
                {(id) => <TextInput id={id} w={240} value={s.username} onChange={(e) => set("username", e.currentTarget.value)} error={!!err("username")} data-testid="profile-username" />}
              </FormRow>
            )}
            {s.authType === "password" && (
              <>
                <FormRow label="Credential">
                  {(id) => (
                    <SegmentedControl id={id} size="xs" value={pwMode} data-testid="profile-pw-mode"
                      onChange={(v) => { setPwMode(v as "password" | "hash"); if (v === "password") set("hashedPassword", undefined); else set("password", undefined); }}
                      data={[{ value: "password", label: "Password" }, { value: "hash", label: "Password Hash" }]} />
                  )}
                </FormRow>
                {pwMode === "password" ? (
                  <FormRow label="Password" description={storedPassword ? "A password is stored. Leave empty to keep it." : "Leave empty if the installer or the user supplies it."}>
                    {(id) => <PasswordInput id={id} w={240} value={s.password === KEEP ? "" : s.password ?? ""} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="new-password"
                      data-testid="profile-password" placeholder={s.password === KEEP ? "Stored password kept" : undefined} />}
                  </FormRow>
                ) : s.hashedPassword === KEEP ? (
                  <FormRow label="Password hash" description="A stored hash is kept.">
                    <div style={{ alignSelf: "flex-end" }}><Button size="xs" variant="subtle" color="red" onClick={() => set("hashedPassword", undefined)}>Remove</Button></div>
                  </FormRow>
                ) : (
                  <FormRow label="Password hash" description="Base64 SHA-0 hash as stored by the hub (HashedKey). Use Fill from Server… to import it." error={err("hashedPassword")}>
                    {(id) => <TextInput id={id} w="100%" value={s.hashedPassword ?? ""} onChange={(e) => set("hashedPassword", e.currentTarget.value.trim() || undefined)}
                      error={!!err("hashedPassword")} styles={{ input: { fontFamily: "var(--sem-font-mono)" } }} data-testid="profile-hash" />}
                  </FormRow>
                )}
              </>
            )}
            {s.authType === "radius" && (
              <FormRow label="Password" description="Optional, kept for reference only: a .vpn file can’t carry a RADIUS or domain password.">
                {(id) => <PasswordInput id={id} w={240} value={s.password === KEEP ? "" : s.password ?? ""} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="new-password"
                  placeholder={s.password === KEEP ? "Stored password kept" : undefined} />}
              </FormRow>
            )}
            {s.authType === "certificate" && (
              <>
                <PemRow label="Client certificate" kind="CERTIFICATE" value={s.clientCertPem} onChange={(v) => set("clientCertPem", v)} error={err("clientCertPem")}
                  description="PEM or DER, registered for the user or signed by a CA the hub trusts." testId="profile-client-cert" />
                <PemRow label="Private key" kind="PRIVATE KEY" value={s.clientKeyPem} onChange={(v) => set("clientKeyPem", v)} error={err("clientKeyPem")}
                  keepLabel="The stored private key is kept (encrypted)." description="Unencrypted RSA key matching the certificate. It’s embedded in the .vpn file." testId="profile-client-key" />
              </>
            )}
          </FormSection>
          {s.authType === "password" && !s.password && !s.hashedPassword && (
            <div className="sem-callouts">
              <Callout tone="yellow">No password: the profile carries the hash of an empty password. That’s fine when the MSI supplies credentials at install time or the user types them.</Callout>
            </div>
          )}

          <FormSection title="Server certificate">
            <SwitchRow label="Always verify the server certificate" checked={s.checkServerCert || !!s.serverCertPem} disabled={!!s.serverCertPem}
              onChange={(v) => set("checkServerCert", v)} description={s.serverCertPem ? "Always on while a certificate is pinned." : "Without a pinned certificate the client uses its trusted CA list."} />
            <SwitchRow label="Trust the built-in root CA list" description="Accept certificates from public CAs, such as Let’s Encrypt." checked={s.addDefaultCa} onChange={(v) => set("addDefaultCa", v)} />
            <PemRow label="Pinned certificate" kind="CERTIFICATE" value={s.serverCertPem} onChange={(v) => set("serverCertPem", v)} testId="profile-server-cert"
              description="The exact certificate the server must present. Recommended for self-signed servers." />
          </FormSection>

          <FormSection title="Behaviour">
            <SwitchRow label="Connect at startup" description="Always-on VPN: connect whenever the client service starts." checked={s.startup} onChange={(v) => set("startup", v)} />
            <FormRow label="Virtual adapter" description="MSI installers replace this with their own adapter." error={err("deviceName")}>
              {(id) => <Select id={id} w={140} value={s.deviceName} onChange={(v) => set("deviceName", v ?? "VPN")} data={NIC_OPTIONS} searchable allowDeselect={false} />}
            </FormRow>
            <SwitchRow label="Retry forever" checked={s.numRetry === INFINITE} onChange={(v) => set("numRetry", v ? INFINITE : 10)} />
            {s.numRetry !== INFINITE && (
              <FormRow label="Reconnect attempts" description="0 never reconnects." error={err("numRetry")}>
                {(id) => <NumberInput id={id} w={120} min={0} max={INFINITE - 1} allowDecimal={false} value={s.numRetry} onChange={(v) => set("numRetry", toNum(v))} />}
              </FormRow>
            )}
            <FormRow label="Reconnect interval" error={err("retryInterval")}>
              {(id) => <NumberInput id={id} w={120} min={5} max={3600} allowDecimal={false} suffix=" s" value={s.retryInterval} onChange={(v) => set("retryInterval", toNum(v, 15))} />}
            </FormRow>
          </FormSection>

          <FormSection title="Advanced communication">
            <FormRow label="TCP connections" description="Parallel connections per session. More can help on high-latency links." error={err("maxConnection")}>
              {(id) => <NumberInput id={id} w={120} min={1} max={32} allowDecimal={false} value={s.maxConnection} onChange={(v) => set("maxConnection", toNum(v, 1))} data-testid="profile-max-connection" />}
            </FormRow>
            <FormRow label="Interval between connections" error={err("additionalConnectionInterval")}>
              {(id) => <NumberInput id={id} w={120} min={1} max={3600} allowDecimal={false} suffix=" s" value={s.additionalConnectionInterval} onChange={(v) => set("additionalConnectionInterval", toNum(v, 1))} />}
            </FormRow>
            <FormRow label="Connection lifetime" description="Recycle each TCP connection after this time. 0 keeps it." error={err("connectionDisconnectSpan")}>
              {(id) => <NumberInput id={id} w={120} min={0} allowDecimal={false} suffix=" s" value={s.connectionDisconnectSpan} onChange={(v) => set("connectionDisconnectSpan", toNum(v))} />}
            </FormRow>
            <SwitchRow label="Encrypt (SSL)" description="Turn off only on trusted networks; credentials stay protected." checked={s.useEncrypt} onChange={(v) => set("useEncrypt", v)} />
            <SwitchRow label="Compress data" checked={s.useCompress} onChange={(v) => set("useCompress", v)} />
            <SwitchRow label="Half-duplex mode" description="Each TCP connection carries one direction only." checked={s.halfConnection} onChange={(v) => set("halfConnection", v)} error={err("halfConnection")} />
            <SwitchRow label="Disable UDP acceleration" checked={s.noUdpAcceleration} onChange={(v) => set("noUdpAcceleration", v)} />
            <SwitchRow label="Disable VoIP / QoS control" checked={s.disableQoS} onChange={(v) => set("disableQoS", v)} />
            <SwitchRow label="Don’t track the routing table" checked={s.noRoutingTracking} onChange={(v) => set("noRoutingTracking", v)} />
            <SwitchRow label="Bridge / router mode" description="Needs the server’s permission." checked={s.requireBridgeRoutingMode} onChange={(v) => set("requireBridgeRoutingMode", v)} />
            <SwitchRow label="Monitoring mode" description="Needs a policy that allows it." checked={s.requireMonitorMode} onChange={(v) => set("requireMonitorMode", v)} />
            <SwitchRow label="Hide the connection status window" checked={s.hideStatusWindow} onChange={(v) => set("hideStatusWindow", v)} />
            <SwitchRow label="Hide the adapter IP window" checked={s.hideNicInfoWindow} onChange={(v) => set("hideNicInfoWindow", v)} />
          </FormSection>

          <FormSection title="Proxy" footer={s.proxyType !== "direct" ? "A .vpn file can’t store the proxy password; users are asked for it." : undefined}>
            <FormRow label="Connection method">
              {(id) => <Select id={id} w={200} data={PROXY_TYPES} value={s.proxyType} allowDeselect={false} onChange={(v) => set("proxyType", (v ?? "direct") as ProxyType)} />}
            </FormRow>
            {s.proxyType !== "direct" && (
              <>
                <FormRow label="Proxy host" error={err("proxyHost")}>{(id) => <TextInput id={id} w="100%" value={s.proxyHost} onChange={(e) => set("proxyHost", e.currentTarget.value)} error={!!err("proxyHost")} />}</FormRow>
                <FormRow label="Proxy port" error={err("proxyPort")}>{(id) => <NumberInput id={id} w={120} min={1} max={65535} allowDecimal={false} value={s.proxyPort || ""} onChange={(v) => set("proxyPort", toNum(v))} />}</FormRow>
                <FormRow label="Proxy user name" description="Optional.">{(id) => <TextInput id={id} w={240} value={s.proxyUsername} onChange={(e) => set("proxyUsername", e.currentTarget.value)} />}</FormRow>
              </>
            )}
          </FormSection>
        </div>

        <div style={{ position: "sticky", top: 0, paddingTop: "var(--sem-space-3)" }}>
          <div className="sem-row-inline" style={{ width: "100%", justifyContent: "space-between", marginBottom: "var(--sem-space-4)" }}>
            <span className="sem-strong">Preview {preview.isFetching && <Loader size={10} ml={6} />}</span>
            {preview.data && previewable && (
              <Button size="xs" variant="subtle" leftSection={<IconDownload size={13} />} onClick={() => void downloadText(vpnName(s.accountName), preview.data!.content).catch((e) => notifyError(e, "Couldn’t save the file"))}>
                Save Preview…
              </Button>
            )}
          </div>
          {!previewable ? (
            <div className="sem-dim" style={{ padding: "var(--sem-space-7) 0" }}>Enter the connection name, server and hub to see the generated file.</div>
          ) : preview.error ? (
            <ErrorState error={preview.error} inline />
          ) : (
            <CodeBlock text={content} maxHeight="calc(100vh - 320px)" testId="profile-preview" />
          )}
          {(s.password === KEEP || s.hashedPassword === KEEP || s.clientKeyPem === KEEP) && (
            <div className="sem-dim" style={{ marginTop: "var(--sem-space-3)" }}>Stored secrets are shown as placeholders here. Saved .vpn files contain the real values.</div>
          )}
        </div>
      </div>
      <FromServerSheet opened={fillOpen} onClose={() => setFillOpen(false)} onApply={applyFill} />
    </Sheet>
  );
}

// ------------------------------------------------------------------ page

export default function ProfilesPage() {
  const qc = useQueryClient();
  const profiles = useProfiles();
  const [editing, setEditing] = useState<Profile | null>(null);
  const [initial, setInitial] = useState<Initial | null>(null);
  const [open, setOpen] = useState(false);
  const [params, setParams] = useSearchParams();
  const handledDeepLink = useRef(false);

  // Deep link from a hub's users: #/deploy/profiles?serverId=1&hub=SALES&user=alice
  useEffect(() => {
    const sid = params.get("serverId"), hub = params.get("hub"), user = params.get("user");
    if (handledDeepLink.current || !sid || !hub) return;
    handledDeepLink.current = true;
    setParams({}, { replace: true });
    post<FromServerResult>("/api/deploy/from-server", { serverId: Number(sid), hub, username: user || undefined, pinCertificate: true, includeUserHash: false })
      .then((r) => {
        setEditing(null);
        setInitial({
          ...r, accountName: `${r.hub} (${r.host})`, profileName: `${hub}${user ? `-${user}` : ""}`,
          notice: (
            <>
              Filled from hub <b>{hub}</b>{user ? <>, user <b>{user}</b></> : null}{r.serverCertPem ? "; server certificate pinned" : ""}. The password isn’t included:
              enter it, or use Fill from Server… with the password hash.
              {r.warnings.map((w, i) => <div key={i} className="sem-text-red">{w}</div>)}
            </>
          ),
        });
        setOpen(true);
      })
      .catch((e) => notifyError(e, "Couldn’t fill the profile from the server"));
  }, [params]);

  const openNew = () => { setEditing(null); setInitial(null); setOpen(true); };
  const openEdit = (p: Profile) => { setEditing(p); setInitial(null); setOpen(true); };
  const duplicate = (p: Profile) => {
    const { hasPassword: _h, hasClientKey: _k, ...settings } = p.settings;
    const strip = (v: string | undefined) => (v === KEEP ? undefined : v);
    setEditing(null);
    setInitial({
      ...settings, password: strip(settings.password), hashedPassword: strip(settings.hashedPassword), clientKeyPem: strip(settings.clientKeyPem),
      profileName: `${p.name} (copy)`, description: p.description,
      notice: settings.password === KEEP || settings.hashedPassword === KEEP || settings.clientKeyPem === KEEP
        ? <>Stored secrets (password, hash, private key) aren’t copied. Enter them again.</> : undefined,
    });
    setOpen(true);
  };
  const saveVpn = async (p: Profile) => {
    try {
      const r = await download(`/api/deploy/profiles/${p.id}/vpn`, { suggestedName: vpnName(p.name) });
      if (r.saved) notifySuccess(`Saved ${r.filePath?.split(/[\\/]/).pop() ?? vpnName(p.name)}`);
    } catch (e) { notifyError(e, "Couldn’t save the .vpn file"); }
  };
  const remove = async (p: Profile) => {
    const ok = await confirmAction({
      title: <>Delete the profile “{p.name}”?</>,
      message: "The profile is removed for good. Installers already built keep their copy, but new builds can’t use it.",
      typeToConfirm: p.name, typeLabel: <>Type the profile name to confirm</>, confirmLabel: "Delete Profile", testId: "delete-profile",
    });
    if (!ok) return;
    try {
      await del(`/api/deploy/profiles/${p.id}`);
      notifySuccess(`Deleted “${p.name}”`);
      void qc.invalidateQueries({ queryKey: deployKeys.profiles });
    } catch (e) { notifyError(e, "Couldn’t delete the profile"); }
  };

  const rows = profiles.data ?? [];
  const withSecret = useMemo(() => rows.filter((p) => (p.settings.authType === "password" && p.settings.hasPassword) || p.settings.hasClientKey).length, [rows]);

  return (
    <>
      <PageHeader
        title="Custom Profiles"
        meta={profiles.data ? <>{rows.length} {rows.length === 1 ? "profile" : "profiles"}{withSecret ? <> · {withSecret} with embedded credentials</> : null}</> : undefined}
        description="Connection settings (.vpn files) for the SoftEther VPN Client. Import them in the Client Manager or with vpncmd, or bundle them into an MSI installer."
        actions={<Button leftSection={<IconPlus size={14} />} onClick={openNew} data-testid="create-profile">New Profile…</Button>}
      />
      <div className="sem-callouts" style={{ marginTop: 0 }}>
        <Callout tone="orange" icon={<IconShieldLock size={16} stroke={1.7} />} title="Treat .vpn files and installers as secrets." testId="profiles-secret-note">
          A password profile stores SHA-0(password + UPPERCASE(user name)). That hash works like the password, and it can’t be revoked without changing the password.
          Client private keys are embedded in clear too. Here, secrets are encrypted at rest.
        </Callout>
      </div>
      <Section>
      <DataTable<Profile>
        testId="profiles-table"
        aria-label="Custom profiles"
        data={profiles.data}
        loading={profiles.isLoading}
        error={profiles.error}
        onRetry={() => void profiles.refetch()}
        rowKey={(p) => p.id}
        rowTestId={(p) => `profile-${p.name}`}
        selectable="single"
        initialSort={{ key: "name", dir: "asc" }}
        onRowOpen={openEdit}
        searchable={rows.length > 6}
        empty={{
          title: "No custom profiles",
          description: "Create one, or fill it from a hub user on a saved connection.",
          icon: <IconFileCertificate size={28} stroke={1.4} />,
          action: <Button size="xs" variant="default" onClick={openNew}>New Profile…</Button>,
        }}
        contextMenu={(p) => [
          { label: "Edit…", icon: <IconPencil size={14} />, onClick: () => openEdit(p), testId: "ctx-edit" },
          { label: "Save .vpn File…", icon: <IconDownload size={14} />, onClick: () => void saveVpn(p), testId: "ctx-save-vpn" },
          { label: "Duplicate…", icon: <IconCopy size={14} />, onClick: () => duplicate(p), testId: "ctx-duplicate" },
          "divider",
          { label: "Delete…", icon: <IconTrash size={14} />, danger: true, onClick: () => void remove(p), testId: "ctx-delete" },
        ]}
        columns={[
          { key: "name", title: "Name", width: 140, truncate: true, render: (p) => <span className="sem-strong" title={[`Connection name: ${p.settings.accountName}`, p.description].filter(Boolean).join("\n")}>{p.name}</span> },
          { key: "server", title: "Server / hub", truncate: true, value: (p) => `${p.settings.host}:${p.settings.port} ${p.settings.hub}`,
            render: (p) => <span title={`${p.settings.host}:${p.settings.port} / ${p.settings.hub}`}><Mono>{p.settings.host}:{p.settings.port}</Mono> <span className="sem-dim">/</span> {p.settings.hub}</span> },
          { key: "auth", title: "Authentication", width: 140, value: (p) => p.settings.authType, render: (p) => <AuthBadge type={p.settings.authType} /> },
          {
            key: "user", title: "User", width: 130, value: (p) => p.settings.username,
            render: (p) => (
              <span className="sem-row-inline" style={{ flexWrap: "nowrap" }}>
                <span>{p.settings.username || <span className="sem-dim">–</span>}</span>
                {p.settings.hashedPassword && <Tag color="orange" title="Embedded password hash imported from the server">Hash</Tag>}
                {p.settings.authType === "password" && !p.settings.hasPassword && <Tag title="No password stored">No password</Tag>}
              </span>
            ),
          },
          { key: "startup", title: "Startup", width: 70, value: (p) => (p.settings.startup ? 1 : 0),
            render: (p) => (p.settings.startup ? <span title="Connects whenever the VPN Client service starts">Auto</span> : <span className="sem-dim">Manual</span>) },
          {
            key: "pinned", title: "Certificate", width: 96, value: (p) => (p.settings.serverCertPem ? 2 : p.settings.checkServerCert ? 1 : 0),
            render: (p) => p.settings.serverCertPem
              ? <Tag color="teal" icon={<IconCertificate size={11} />}>Pinned</Tag>
              : p.settings.checkServerCert ? <span className="sem-dim">CA check</span> : <Tag color="red">Not verified</Tag>,
          },
          { key: "updatedAt", title: "Updated", width: 80, render: (p) => <span className="sem-dim" title={`${dt(p.updatedAt)} by ${p.createdBy}`}>{agoShort(p.updatedAt)}</span> },
        ]}
      />
      </Section>
      <div className="sem-dim" style={{ marginTop: "var(--sem-space-7)" }}>
        Manual import on a client: <code className="sem-code-inline">vpncmd localhost /CLIENT /CMD AccountImport profile.vpn</code>, then <code className="sem-code-inline">AccountStartupSet</code> or <code className="sem-code-inline">AccountConnect</code>.
      </div>
      <ProfileSheet opened={open} onClose={() => setOpen(false)} profile={editing} initial={initial} />
    </>
  );
}
