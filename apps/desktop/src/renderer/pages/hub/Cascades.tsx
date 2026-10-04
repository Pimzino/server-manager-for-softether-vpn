// Hub › Cascade Connections: site-to-site links. This hub connects as a client to a Virtual Hub on another
// (or the same) VPN server and bridges both segments at Layer 2.
// Ported from apps/web/src/pages/hub/Cascades.tsx: EnumLink, GetLink, CreateLink, SetLink, RenameLink, DeleteLink,
// SetLinkOnline/Offline and GetLinkStatus with the same fields, validation and SoftEther quirks (hashed password
// kept as AuthType 1, NoTls1_bool only on create, policy:Ver3_bool always set). Redesigned: dense table with a
// context menu, an edit Sheet with a segmented tab bar, a live-status Inspector and a Rename sheet.
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, NumberInput, PasswordInput, SegmentedControl, Select, Switch, TextInput } from "@mantine/core";
import {
  IconActivity, IconCertificate, IconCursorText, IconDownload, IconFileImport, IconLink, IconPencil, IconPlayerPlay, IconPlayerStop, IconPlus, IconRefresh, IconTrash,
} from "@tabler/icons-react";
import { ApiError, rpc } from "../../lib/api";
import { agoShort, dt, downloadText, num } from "../../lib/format";
import { notifyError, notifySuccess, useCatalog, useRpc, useRpcMutation, useServers } from "../../lib/hooks";
import {
  DataTable, ErrorState, FormRow, FormSection, Inspector, Mono, PageHeader, PropertySkeleton, Sheet, StatusBadge, type ContextMenuItem, type RowKey, type Status,
} from "../../design";
import { CASCADE_POLICY_FIELDS, PolicyEditor, POLICY_DEFAULTS } from "../../components/domain/PolicyEditor";
import { CONNECTION_GROUPS, SessionStatusBadge, StatusGroups, type FieldGroup } from "../../components/domain/StatusView";
import { b64ToBytes, derB64ToPem } from "../../components/domain/util";
import { dnGet, dnToString, parseCert } from "../../components/domain/x509";
import { pickCertDerB64 } from "../../components/domain/files";
import { Callout, HelpLabel } from "../../components/domain/ui";
import { Unreachable, useHubPage, ViewSwitcher } from "./_hub-policy-network/shared";

type Struct = Record<string, any>;
interface LinkItem { AccountName_utf: string; Online_bool: boolean; Connected_bool: boolean; LastError_u32: number; ConnectedTime_dt: string; Hostname_str: string; TargetHubName_str: string; ConnectedHubName_str?: string }

const LINK_AUTH = [
  { value: "0", label: "Anonymous", description: "No credentials. The destination hub must have a user that allows anonymous login." },
  { value: "2", label: "Password", description: "User name and password of a user on the destination Virtual Hub." },
  { value: "3", label: "Certificate", description: "An X.509 client certificate and its private key." },
];

const PROXY_TYPES = [
  { value: "0", label: "Direct connection" },
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

function linkState(l: LinkItem): { label: string; status: Status } {
  if (!l.Online_bool) return { label: "Offline", status: "off" };
  if (l.Connected_bool) return { label: "Connected", status: "ok" };
  if (l.LastError_u32) return { label: "Retrying", status: "error" };
  return { label: "Connecting", status: "busy" };
}

type Tab = "connection" | "auth" | "cert" | "proxy" | "advanced" | "policy";
const unit = (u: string) => ({ rightSection: <span className="sem-input-unit">{u}</span>, rightSectionWidth: 30 });

/* ------------------------------------------------------------------ certificate / key slot */

function CertSlot({ b64, kind, onPick, onClear, testId, emptyText }: {
  b64: string; kind: "cert" | "key"; onPick: (derB64: string) => void; onClear?: () => void; testId: string; emptyText: string;
}) {
  const bytes = b64ToBytes(b64);
  const info = useMemo(() => {
    if (kind !== "cert" || !bytes.length) return null;
    try { return parseCert(bytes); } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b64, kind]);
  const pick = async () => {
    try {
      const r = await pickCertDerB64(kind);
      if (r) onPick(r.derB64);
    } catch (e) { notifyError(e, kind === "cert" ? "Couldn’t read the certificate" : "Couldn’t read the private key"); }
  };
  return (
    <div className="hpn-file" data-testid={`${testId}-slot`}>
      <IconCertificate size={22} stroke={1.4} style={{ color: bytes.length ? "var(--sem-accent)" : "var(--sem-text-3)", flex: "none" }} />
      <div className="hpn-file-info">
        {bytes.length === 0 ? <span className="hpn-file-name sem-dim">{emptyText}</span>
          : kind === "key" ? <><span className="hpn-file-name">Private key</span><span className="hpn-file-detail">{num(bytes.length)} bytes, DER</span></>
          : info ? (
            <>
              <span className="hpn-file-name" title={dnToString(info.subject)}>{dnGet(info.subject, "CN") || dnToString(info.subject) || "Certificate"}</span>
              <span className="hpn-file-detail" title={dnToString(info.issuer)}>
                {info.selfSigned ? "Self-signed" : `Issued by ${dnGet(info.issuer, "CN") || dnToString(info.issuer)}`}
                {info.notAfter ? ` · expires ${info.notAfter.toISOString().slice(0, 10)}` : ""}
              </span>
            </>
          ) : <><span className="hpn-file-name">Certificate</span><span className="hpn-file-detail">{num(bytes.length)} bytes</span></>}
      </div>
      <div className="sem-row-inline" style={{ flexWrap: "nowrap", gap: 6 }}>
        {bytes.length > 0 && kind === "cert" && (
          <Button size="xs" variant="default" leftSection={<IconDownload size={12} />}
            onClick={() => { downloadText("certificate.pem", derB64ToPem(b64), "application/x-pem-file").catch((e) => notifyError(e, "Couldn’t save the certificate")); }}>
            Save PEM…
          </Button>
        )}
        {bytes.length > 0 && onClear && <Button size="xs" variant="subtle" color="gray" onClick={onClear} aria-label="Remove">Remove</Button>}
        <Button size="xs" variant="default" leftSection={<IconFileImport size={12} />} onClick={() => void pick()} data-testid={testId}>
          {bytes.length ? "Replace…" : "Choose File…"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ editor */

function LinkSheet({ serverId, hub, name, opened, onClose, existing, onCreated }: {
  serverId: number; hub: string; name: string | null; opened: boolean; onClose: () => void; existing: string[]; onCreated: (name: string) => void;
}) {
  const isNew = name === null;
  const cat = useCatalog();
  const doc = (f: string) => cat.data?.types["VpnRpcCreateLink"]?.fields.find((x) => x.name === f)?.doc?.replace(/^Client Option Parameters:\s*/, "");
  const q = useRpc<Struct>(serverId, "GetLink", { HubName_Ex_str: hub, AccountName_utf: name ?? "" }, { enabled: opened && !isNew, staleTime: 0 });
  const servers = useServers();
  const [form, setForm] = useState<Struct>(NEW_LINK);
  const [tab, setTab] = useState<Tab>("connection");
  const [fetchFrom, setFetchFrom] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!opened) return;
    if (isNew) setForm({ ...NEW_LINK });
    else if (q.data) setForm({ ...q.data, AuthType_u32: q.data.AuthType_u32 });
    setFetchFrom(null);
  }, [opened, isNew, q.data]);
  useEffect(() => { if (opened) { setTab("connection"); setTried(false); } }, [opened, name]);

  const set = (patch: Struct) => setForm((f) => ({ ...f, ...patch }));
  const qc = useQueryClient();
  // SoftEther always creates a cascade offline (StCreateLink ignores Online_bool), so "Connect now" is a
  // SetLinkOnline right after the create.
  const create = useRpcMutation(serverId, "CreateLink", {
    success: "Cascade connection created",
    onSuccess: (_r, p) => {
      onClose();
      onCreated(String(p.AccountName_utf));
      if (!p.Online_bool) return;
      rpc(serverId, "SetLinkOnline", { HubName_str: hub, AccountName_utf: p.AccountName_utf })
        .catch((e) => notifyError(e, "Created, but couldn’t bring it online"))
        .finally(() => void qc.invalidateQueries({ queryKey: ["rpc", serverId] }));
    },
  });
  const save = useRpcMutation(serverId, "SetLink", { success: "Cascade connection saved", onSuccess: () => onClose() });
  const saving = create.isPending || save.isPending;
  const auth = Number(form.AuthType_u32 ?? 0);
  const proxy = Number(form.ProxyType_u32 ?? 0);

  const errors: { tab: Tab; msg: string }[] = [];
  const err = (t: Tab, msg: string) => errors.push({ tab: t, msg });
  if (!String(form.AccountName_utf ?? "").trim()) err("connection", "Enter a name for the connection.");
  else if (isNew && existing.some((x) => x.toLowerCase() === String(form.AccountName_utf).trim().toLowerCase())) err("connection", "Another cascade connection already has this name.");
  if (!String(form.Hostname_str ?? "").trim()) err("connection", "Enter the destination server’s host name.");
  if (!(form.Port_u32 >= 1 && form.Port_u32 <= 65535)) err("connection", "The port must be between 1 and 65535.");
  if (!String(form.HubName_str ?? "").trim()) err("connection", "Enter the destination Virtual Hub.");
  if (!(form.MaxConnection_u32 >= 1 && form.MaxConnection_u32 <= 32)) err("advanced", "Use 1 to 32 TCP connections.");
  if (form.HalfConnection_bool && form.MaxConnection_u32 < 2) err("advanced", "Half-duplex mode needs at least 2 TCP connections.");
  if (auth !== 0 && !String(form.Username_str ?? "").trim()) err("auth", "Enter the user name on the destination hub.");
  if (auth === 2 && !form.PlainPassword_str && !(Number(q.data?.AuthType_u32) === 1 && !isNew)) err("auth", "Enter the password.");
  if (auth === 3 && (b64ToBytes(form.ClientX_bin).length === 0 || b64ToBytes(form.ClientK_bin).length === 0)) err("auth", "Choose both the client certificate and its private key.");
  if (form.CheckServerCert_bool && !form.AddDefaultCA_bool && b64ToBytes(form.ServerCert_bin).length === 0) err("cert", "Choose the expected server certificate, or also trust the public root CAs.");
  if (proxy !== 0 && (!String(form.ProxyName_str ?? "").trim() || !(form.ProxyPort_u32 >= 1 && form.ProxyPort_u32 <= 65535))) err("proxy", "Enter the proxy host and port.");
  const tabHasError = (t: Tab) => tried && errors.some((e) => e.tab === t);

  const submit = () => {
    setTried(true);
    if (errors.length) { setTab(errors[0].tab); return; }
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
        if (!s.ServerX_bin || b64ToBytes(s.ServerX_bin).length === 0) throw new Error("The cascade hasn’t received a server certificate yet. It must be connected first.");
        set({ ServerCert_bin: s.ServerX_bin, CheckServerCert_bool: true });
      } else {
        const r = await rpc<Struct>(Number(fetchFrom), "GetServerCert", {});
        set({ ServerCert_bin: r.Cert_bin, CheckServerCert_bool: true });
      }
      notifySuccess("Server certificate loaded");
    } catch (e) {
      notifyError(e, "Couldn’t fetch the certificate");
    } finally {
      setFetching(false);
    }
  };

  const loading = !isNew && q.isLoading;
  const firstErr = tried ? errors[0]?.msg : undefined;

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={saving} size={700} testId="link-sheet"
      icon={<IconLink size={19} stroke={1.5} />}
      title={isNew ? "New Cascade Connection" : <>Edit “{name}”</>}
      subtitle={isNew ? `Connects ${hub} to a Virtual Hub on another server.` : "Saving an online cascade reconnects it with the new settings."}
      footer={(
        <div className="hpn-footer">
          <span className="hpn-footer-note" data-error={firstErr ? true : undefined} data-testid="link-form-error">{firstErr}</span>
          <div className="hpn-footer-buttons">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} loading={saving} disabled={loading || !!q.error} data-testid="link-save">{isNew ? "Create Connection" : "Save"}</Button>
          </div>
        </div>
      )}
    >
      {loading ? <PropertySkeleton rows={6} /> : !isNew && q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} serverId={serverId} inline testId="link-load-error" /> : (
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} data-testid="link-form" className="hpn-tabbed">
          <ViewSwitcher<Tab>
            value={tab} onChange={setTab} fullWidth testId="link-tabs"
            items={[
              { value: "connection", label: "Destination", alert: tabHasError("connection"), testId: "link-tab-connection" },
              { value: "auth", label: "Authentication", alert: tabHasError("auth"), testId: "link-tab-auth" },
              { value: "cert", label: "Certificate", alert: tabHasError("cert"), testId: "link-tab-cert" },
              { value: "proxy", label: "Proxy", alert: tabHasError("proxy"), testId: "link-tab-proxy" },
              { value: "advanced", label: "Advanced", alert: tabHasError("advanced"), testId: "link-tab-advanced" },
              { value: "policy", label: "Policy", testId: "link-tab-policy" },
            ]}
          />

          {tab === "connection" && (
            <FormSection description="The VPN server and Virtual Hub this hub connects to.">
              <FormRow label="Name" description={isNew ? "How this cascade is listed on this hub." : "Use Rename… in the list to change the name."}>
                {(id) => <TextInput id={id} readOnly={!isNew} value={String(form.AccountName_utf ?? "")} onChange={(e) => set({ AccountName_utf: e.currentTarget.value })}
                  placeholder="to-branch-office" data-autofocus={isNew || undefined} data-testid="link-name" />}
              </FormRow>
              <FormRow label="VPN server" description="Host name or IP address, and port (usually 443, 992, 1194 or 5555).">
                <div className="hpn-range">
                  <TextInput aria-label="Destination host" placeholder="vpn.example.com" value={String(form.Hostname_str ?? "")}
                    onChange={(e) => set({ Hostname_str: e.currentTarget.value })} data-testid="link-host" style={{ flex: 3 }} />
                  <NumberInput aria-label="Port" w={96} min={1} max={65535} allowDecimal={false} allowNegative={false} value={form.Port_u32}
                    onChange={(v) => set({ Port_u32: Number(v) || 0 })} data-testid="link-port" />
                </div>
              </FormRow>
              <FormRow label="Virtual Hub" description="The hub to join on the destination server.">
                {(id) => <TextInput id={id} placeholder="DEFAULT" value={String(form.HubName_str ?? "")} onChange={(e) => set({ HubName_str: e.currentTarget.value })} data-testid="link-target-hub" />}
              </FormRow>
              {isNew && (
                <FormRow label="Connect now" description="Bring the cascade online as soon as it’s created.">
                  <Switch checked={!!form.Online_bool} aria-label="Connect now" onChange={(e) => set({ Online_bool: e.currentTarget.checked })} data-testid="link-online-new" />
                </FormRow>
              )}
            </FormSection>
          )}

          {tab === "auth" && (
            <FormSection description="How this hub logs on to the destination hub.">
              <FormRow label="Method" align="start" description={LINK_AUTH.find((a) => a.value === String(auth === 1 ? 2 : auth))?.description}>
                <SegmentedControl value={String(auth === 1 ? 2 : auth)} onChange={(v) => set({ AuthType_u32: Number(v) })} aria-label="Authentication method"
                  data={LINK_AUTH.map((a) => ({ value: a.value, label: a.label }))} data-testid="link-authtype" />
              </FormRow>
              {auth !== 0 && (
                <FormRow label="User name" description="A user on the destination hub.">
                  {(id) => <TextInput id={id} value={String(form.Username_str ?? "")} onChange={(e) => set({ Username_str: e.currentTarget.value })} data-testid="link-username" />}
                </FormRow>
              )}
              {(auth === 2 || auth === 1) && (
                <FormRow label="Password" align="start" description={auth === 1 ? "A hashed password is stored. Leave empty to keep it, or type a new one." : undefined}>
                  {(id) => <PasswordInput id={id} value={String(form.PlainPassword_str ?? "")} autoComplete="new-password" placeholder={auth === 1 ? "Unchanged" : undefined}
                    onChange={(e) => set({ PlainPassword_str: e.currentTarget.value, ...(auth === 1 && e.currentTarget.value ? { AuthType_u32: 2 } : {}) })} data-testid="link-password" />}
                </FormRow>
              )}
              {auth === 3 && (
                <>
                  <FormRow label="Client certificate" stacked description="PEM or DER. PEM files are converted to DER.">
                    <CertSlot b64={String(form.ClientX_bin ?? "")} kind="cert" onPick={(d) => set({ ClientX_bin: d })} testId="link-client-cert" emptyText="No certificate chosen" />
                  </FormRow>
                  <FormRow label="Private key" stacked description="PEM or DER, without a passphrase.">
                    <CertSlot b64={String(form.ClientK_bin ?? "")} kind="key" onPick={(d) => set({ ClientK_bin: d })} testId="link-client-key" emptyText="No private key chosen" />
                  </FormRow>
                </>
              )}
            </FormSection>
          )}

          {tab === "cert" && (
            <FormSection description="Check the destination server’s certificate before sending credentials.">
              <FormRow label={<HelpLabel label="Verify certificate" doc={doc("CheckServerCert_bool")} />}>
                <Switch checked={!!form.CheckServerCert_bool} aria-label="Verify the destination server certificate"
                  onChange={(e) => set({ CheckServerCert_bool: e.currentTarget.checked })} data-testid="link-check-cert" />
              </FormRow>
              {form.CheckServerCert_bool && form.AddDefaultCA_bool !== undefined && (
                <FormRow label="Trust public root CAs" description="Also accept certificates signed by a well-known CA.">
                  <Switch checked={!!form.AddDefaultCA_bool} aria-label="Trust public root CAs" onChange={(e) => set({ AddDefaultCA_bool: e.currentTarget.checked })} data-testid="link-default-ca" />
                </FormRow>
              )}
              {form.CheckServerCert_bool && (
                <>
                  <FormRow label="Expected certificate" stacked description={doc("ServerCert_bin")}>
                    <CertSlot b64={String(form.ServerCert_bin ?? "")} kind="cert" onPick={(d) => set({ ServerCert_bin: d })} onClear={() => set({ ServerCert_bin: "" })}
                      testId="link-server-cert" emptyText="No certificate pinned" />
                  </FormRow>
                  <FormRow label="Or fetch it from" description="The certificate this cascade saw on its last connection, or one of your saved servers.">
                    <div className="hpn-range">
                      <Select aria-label="Certificate source" placeholder="Choose a source" value={fetchFrom} onChange={setFetchFrom} style={{ flex: 1 }} data-testid="link-fetch-source"
                        data={[
                          ...(!isNew ? [{ value: "status", label: "Last connection of this cascade" }] : []),
                          ...(servers.data ?? []).map((s) => ({ value: String(s.id), label: `${s.name} (${s.host}:${s.port})` })),
                        ]} />
                      <Button variant="default" onClick={() => void fetchServerCert()} loading={fetching} disabled={!fetchFrom} data-testid="link-fetch-cert">Fetch</Button>
                    </div>
                  </FormRow>
                </>
              )}
            </FormSection>
          )}

          {tab === "proxy" && (
            <FormSection description="Reach the destination server through an HTTP or SOCKS proxy.">
              <FormRow label="Connection">
                {(id) => <Select id={id} w={240} data={PROXY_TYPES} value={String(proxy)} allowDeselect={false}
                  onChange={(v) => set({ ProxyType_u32: Number(v ?? 0) })} data-testid="link-proxy-type" />}
              </FormRow>
              {proxy !== 0 && (
                <>
                  <FormRow label="Proxy server">
                    <div className="hpn-range">
                      <TextInput aria-label="Proxy host" placeholder="proxy.example.com" value={String(form.ProxyName_str ?? "")} style={{ flex: 3 }}
                        onChange={(e) => set({ ProxyName_str: e.currentTarget.value })} data-testid="link-proxy-host" />
                      <NumberInput aria-label="Proxy port" w={96} min={1} max={65535} allowDecimal={false} allowNegative={false} value={form.ProxyPort_u32}
                        onChange={(v) => set({ ProxyPort_u32: Number(v) || 0 })} data-testid="link-proxy-port" />
                    </div>
                  </FormRow>
                  <FormRow label="User name" description="Leave empty if the proxy doesn’t need a login.">
                    {(id) => <TextInput id={id} value={String(form.ProxyUsername_str ?? "")} onChange={(e) => set({ ProxyUsername_str: e.currentTarget.value })} />}
                  </FormRow>
                  <FormRow label="Password">
                    {(id) => <PasswordInput id={id} value={String(form.ProxyPassword_str ?? "")} autoComplete="new-password" onChange={(e) => set({ ProxyPassword_str: e.currentTarget.value })} />}
                  </FormRow>
                  {proxy === 1 && form.CustomHttpHeader_str !== undefined && (
                    <FormRow label="Custom HTTP header" description="Sent to the proxy, e.g. X-Forwarded-For: 1.2.3.4">
                      {(id) => <TextInput id={id} value={String(form.CustomHttpHeader_str ?? "")} onChange={(e) => set({ CustomHttpHeader_str: e.currentTarget.value })} />}
                    </FormRow>
                  )}
                </>
              )}
            </FormSection>
          )}

          {tab === "advanced" && (
            <>
              <FormSection title="Connections">
                <FormRow label={<HelpLabel label="TCP connections" doc={doc("MaxConnection_u32")} />} description="1 to 32 parallel connections.">
                  {(id) => <NumberInput id={id} w={110} min={1} max={32} allowDecimal={false} allowNegative={false} value={form.MaxConnection_u32}
                    onChange={(v) => set({ MaxConnection_u32: Number(v) || 1 })} data-testid="link-maxconn" />}
                </FormRow>
                <FormRow label={<HelpLabel label="Connection interval" doc={doc("AdditionalConnectionInterval_u32")} />} description="Wait between opening additional connections.">
                  {(id) => <NumberInput id={id} w={110} min={1} allowDecimal={false} allowNegative={false} value={form.AdditionalConnectionInterval_u32} {...unit("s")}
                    onChange={(v) => set({ AdditionalConnectionInterval_u32: Number(v) || 1 })} />}
                </FormRow>
                <FormRow label={<HelpLabel label="Connection lifetime" doc={doc("ConnectionDisconnectSpan_u32")} />} description="Reconnect each TCP connection after this long. 0 keeps them open.">
                  {(id) => <NumberInput id={id} w={110} min={0} allowDecimal={false} allowNegative={false} value={form.ConnectionDisconnectSpan_u32} {...unit("s")}
                    onChange={(v) => set({ ConnectionDisconnectSpan_u32: Number(v) || 0 })} />}
                </FormRow>
                {form.RetryInterval_u32 !== undefined && (
                  <FormRow label="Retry interval" description="Wait before reconnecting after a failure.">
                    {(id) => <NumberInput id={id} w={110} min={1} allowDecimal={false} allowNegative={false} value={form.RetryInterval_u32} {...unit("s")}
                      onChange={(v) => set({ RetryInterval_u32: Number(v) || 1 })} data-testid="link-retry" />}
                  </FormRow>
                )}
                <FormRow label="Half-duplex mode" description="Split connections into upload and download halves (2 or more connections).">
                  <Switch checked={!!form.HalfConnection_bool} aria-label="Half-duplex mode" onChange={(e) => set({ HalfConnection_bool: e.currentTarget.checked })} data-testid="link-half" />
                </FormRow>
              </FormSection>
              <FormSection title="Transport">
                <FormRow label={<HelpLabel label="Encrypt the session" doc={doc("UseEncrypt_bool")} />}>
                  <Switch checked={!!form.UseEncrypt_bool} aria-label="Encrypt the session" onChange={(e) => set({ UseEncrypt_bool: e.currentTarget.checked })} data-testid="link-encrypt" />
                </FormRow>
                <FormRow label={<HelpLabel label="Compress data" doc={doc("UseCompress_bool")} />}>
                  <Switch checked={!!form.UseCompress_bool} aria-label="Compress data" onChange={(e) => set({ UseCompress_bool: e.currentTarget.checked })} data-testid="link-compress" />
                </FormRow>
                <FormRow label={<HelpLabel label="Disable VoIP / QoS" doc={doc("DisableQoS_bool")} />}>
                  <Switch checked={!!form.DisableQoS_bool} aria-label="Disable VoIP / QoS" onChange={(e) => set({ DisableQoS_bool: e.currentTarget.checked })} />
                </FormRow>
                <FormRow label={<HelpLabel label="Disable UDP acceleration" doc={doc("NoUdpAcceleration_bool")} />}>
                  <Switch checked={!!form.NoUdpAcceleration_bool} aria-label="Disable UDP acceleration" onChange={(e) => set({ NoUdpAcceleration_bool: e.currentTarget.checked })} />
                </FormRow>
                {isNew && (
                  <FormRow label={<HelpLabel label="Don’t use TLS 1.x" doc={doc("NoTls1_bool")} />} description="Can only be set when the cascade is created.">
                    <Switch checked={!!form.NoTls1_bool} aria-label="Don’t use TLS 1.x" onChange={(e) => set({ NoTls1_bool: e.currentTarget.checked })} />
                  </FormRow>
                )}
              </FormSection>
              {(form.NoRoutingTracking_bool !== undefined || form.RequireBridgeRoutingMode_bool !== undefined || form.RequireMonitorMode_bool !== undefined) && (
                <FormSection title="Session mode">
                  {form.RequireBridgeRoutingMode_bool !== undefined && (
                    <FormRow label="Require bridge / router mode" description="Normally on for cascades.">
                      <Switch checked={!!form.RequireBridgeRoutingMode_bool} aria-label="Require bridge or router mode" onChange={(e) => set({ RequireBridgeRoutingMode_bool: e.currentTarget.checked })} />
                    </FormRow>
                  )}
                  {form.RequireMonitorMode_bool !== undefined && (
                    <FormRow label="Require monitoring mode" description="The destination user needs the monitoring policy.">
                      <Switch checked={!!form.RequireMonitorMode_bool} aria-label="Require monitoring mode" onChange={(e) => set({ RequireMonitorMode_bool: e.currentTarget.checked })} />
                    </FormRow>
                  )}
                  {form.NoRoutingTracking_bool !== undefined && (
                    <FormRow label="No routing tracking" description="Don’t track IP routing tables on this session.">
                      <Switch checked={!!form.NoRoutingTracking_bool} aria-label="No routing tracking" onChange={(e) => set({ NoRoutingTracking_bool: e.currentTarget.checked })} />
                    </FormRow>
                  )}
                </FormSection>
              )}
            </>
          )}

          {tab === "policy" && (
            <>
              <div className="hpn-block">
                <Callout tone="gray">The cascade appears on this hub as the user “Cascade”. This policy applies to its session here.</Callout>
              </div>
              <PolicyEditor value={form} onChange={set} fields={CASCADE_POLICY_FIELDS} testId="link-policy" />
            </>
          )}
        </form>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ status inspector + rename */

// The status badge sits above the groups, and a port is not a quantity ("15916", not "15,916").
const STATUS_GROUPS: FieldGroup[] = CONNECTION_GROUPS.map((g) => ({
  ...g,
  fields: g.fields.filter((f) => f[1] !== "SessionStatus_u32").map((f) => (f[1] === "ServerPort_u32" ? [f[0], f[1], (v: unknown) => String(v ?? "–")] : f)),
}));

function StatusInspector({ serverId, hub, link, onClose, onEdit, onToggle }: {
  serverId: number; hub: string; link: LinkItem | null; onClose: () => void; onEdit: (n: string) => void; onToggle: (l: LinkItem) => void;
}) {
  const name = link?.AccountName_utf ?? null;
  const q = useRpc<Struct>(serverId, "GetLinkStatus", { HubName_Ex_str: hub, AccountName_utf: name ?? "" }, { enabled: !!name && !!link?.Online_bool, refetchInterval: 5000, retry: false });
  const offline = (q.error instanceof ApiError && q.error.softEtherCode === 61) || (link && !link.Online_bool);
  return (
    <Inspector
      opened={!!link} onClose={onClose} width={420} testId="link-status"
      icon={<IconActivity size={17} stroke={1.6} />}
      title={name ?? ""}
      subtitle={link ? `${link.Hostname_str} · ${link.TargetHubName_str}` : undefined}
      actions={link && <>
        <Button size="xs" variant="default" leftSection={<IconRefresh size={12} />} onClick={() => void q.refetch()} loading={q.isFetching && !q.isLoading} disabled={!!offline}>Refresh</Button>
        <Button size="xs" variant="default" leftSection={link.Online_bool ? <IconPlayerStop size={12} /> : <IconPlayerPlay size={12} />} onClick={() => onToggle(link)} data-testid="link-status-toggle">
          {link.Online_bool ? "Take Offline" : "Bring Online"}
        </Button>
        <Button size="xs" variant="default" leftSection={<IconPencil size={12} />} onClick={() => onEdit(link.AccountName_utf)}>Edit…</Button>
      </>}
    >
      {offline ? (
        <div className="hpn-block"><Callout tone="gray" title="This cascade is offline" testId="link-status-offline">Bring it online to see its live status.</Callout></div>
      ) : q.error ? (
        <div className="hpn-block"><ErrorState error={q.error} onRetry={() => void q.refetch()} serverId={serverId} inline testId="link-status-error" /></div>
      ) : !q.data ? <div className="hpn-block"><PropertySkeleton rows={8} /></div> : (
        <>
          <div className="hpn-block"><SessionStatusBadge value={Number(q.data.SessionStatus_u32)} testId="link-status-badge" /></div>
          <StatusGroups
            data={q.data} labelWidth={150} testId="link-status-groups"
            groups={[{ title: "Cascade", fields: [["Session name", "SessionName_str"], ["Connection ID", "ConnectionName_str"], ["Server certificate", "ServerX_bin"], ["Client certificate", "ClientX_bin"]] }, ...STATUS_GROUPS]}
            hide={["HubName_Ex_str", "SessionKey_bin", "AccountName_utf"]}
          />
        </>
      )}
    </Inspector>
  );
}

function RenameSheet({ serverId, hub, name, onClose, existing }: { serverId: number; hub: string; name: string | null; onClose: () => void; existing: string[] }) {
  const [v, setV] = useState("");
  useEffect(() => { if (name) setV(name); }, [name]);
  const m = useRpcMutation(serverId, "RenameLink", { success: "Cascade connection renamed", onSuccess: onClose });
  const t = v.trim();
  const errMsg = !t ? "Enter a name." : t !== name && existing.some((e) => e.toLowerCase() === t.toLowerCase()) ? "Another cascade connection already has this name." : null;
  const submit = () => { if (!errMsg && t !== name) m.mutate({ HubName_str: hub, OldAccountName_utf: name, NewAccountName_utf: t }); };
  return (
    <Sheet
      opened={!!name} onClose={onClose} busy={m.isPending} size={460} testId="link-rename-sheet"
      icon={<IconCursorText size={19} stroke={1.5} />} title={<>Rename “{name}”</>}
      footer={(
        <div className="hpn-footer">
          <span className="hpn-footer-note" />
          <div className="hpn-footer-buttons">
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} loading={m.isPending} disabled={!!errMsg || t === name} data-testid="link-rename-save">Rename</Button>
          </div>
        </div>
      )}
    >
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormSection>
          <FormRow label="New name">
            {(id) => <TextInput id={id} value={v} onChange={(e) => setV(e.currentTarget.value)} error={v && t !== name ? errMsg : undefined} data-autofocus data-testid="link-rename-input" />}
          </FormRow>
        </FormSection>
      </form>
    </Sheet>
  );
}

/* ------------------------------------------------------------------ page */

export default function CascadesPage() {
  const { serverId, hub, server, reachable } = useHubPage();
  const cat = useCatalog();
  const q = useRpc<{ LinkList?: LinkItem[] }>(serverId, "EnumLink", { HubName_str: hub }, { refetchInterval: 10_000, enabled: reachable });
  const [editing, setEditing] = useState<{ name: string | null } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [selection, setSelection] = useState<RowKey[]>([]);
  const online = useRpcMutation(serverId, "SetLinkOnline", { success: "Cascade connection is online" });
  const offline = useRpcMutation(serverId, "SetLinkOffline", { success: "Cascade connection is offline" });
  const del = useRpcMutation(serverId, "DeleteLink", {
    success: "Cascade connection deleted",
    confirm: (p) => ({
      title: <>Delete cascade connection “{String(p.AccountName_utf)}”?</>,
      message: "The link is disconnected and its settings, including stored credentials and certificates, are removed. This can’t be undone.",
      confirmLabel: "Delete Connection", tone: "danger", typeToConfirm: String(p.AccountName_utf), testId: "delete-link",
    }),
  });
  const errText = (c: number) => cat.data?.errors[String(c)] ?? `Error ${c}`;
  const list = q.data?.LinkList ?? [];
  const statusLink = list.find((l) => l.AccountName_utf === status) ?? null;
  const nOnline = list.filter((l) => l.Connected_bool).length;

  const setLinkOnline = (l: LinkItem, on: boolean) => (on ? online : offline).mutate({ HubName_str: hub, AccountName_utf: l.AccountName_utf });

  const menu = (l: LinkItem): ContextMenuItem[] => [
    { label: "Show Status", icon: <IconActivity size={14} />, onClick: () => setStatus(l.AccountName_utf), testId: `link-status-open-${l.AccountName_utf}` },
    { label: "Edit…", icon: <IconPencil size={14} />, shortcut: "↩", onClick: () => setEditing({ name: l.AccountName_utf }), testId: `link-edit-${l.AccountName_utf}` },
    { label: "Rename…", icon: <IconCursorText size={14} />, onClick: () => setRenaming(l.AccountName_utf), testId: `link-rename-${l.AccountName_utf}` },
    "divider",
    l.Online_bool
      ? { label: "Take Offline", icon: <IconPlayerStop size={14} />, onClick: () => setLinkOnline(l, false), testId: `link-offline-${l.AccountName_utf}` }
      : { label: "Bring Online", icon: <IconPlayerPlay size={14} />, onClick: () => setLinkOnline(l, true), testId: `link-onlinemenu-${l.AccountName_utf}` },
    "divider",
    { label: "Delete…", icon: <IconTrash size={14} />, danger: true, onClick: () => del.mutate({ HubName_str: hub, AccountName_utf: l.AccountName_utf }), testId: `link-delete-${l.AccountName_utf}` },
  ];

  if (server && !reachable) return <><PageHeader title="Cascade Connections" /><Unreachable server={server} /></>;

  return (
    <>
      <PageHeader
        title="Cascade Connections"
        meta={q.data ? <span data-testid="links-meta">{list.length ? <>{list.length} {list.length === 1 ? "connection" : "connections"} · {nOnline} connected</> : "No connections"}</span> : undefined}
        description="Site-to-site links: this hub connects as a client to a Virtual Hub on another server and bridges both segments at Layer 2."
        actions={<Button leftSection={<IconPlus size={14} />} onClick={() => setEditing({ name: null })} data-testid="create-link">New Cascade Connection…</Button>}
      />
      <DataTable
        testId="links-table"
        aria-label="Cascade connections"
        data={q.data ? list : undefined}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        rowKey={(l) => l.AccountName_utf}
        rowTestId={(l) => `link-row-${l.AccountName_utf}`}
        selectable="single"
        selection={selection}
        onSelectionChange={(k) => { setSelection(k); if (status && k.length === 1) setStatus(String(k[0])); }}
        onRowOpen={(l) => setEditing({ name: l.AccountName_utf })}
        contextMenu={(l) => menu(l)}
        initialSort={{ key: "AccountName_utf", dir: "asc" }}
        searchable={list.length > 8}
        empty={{
          title: "No cascade connections",
          description: "Link this hub to a hub on another server to join both networks.",
          icon: <IconLink size={28} stroke={1.4} />,
          action: <Button size="xs" variant="default" onClick={() => setEditing({ name: null })}>New Cascade Connection…</Button>,
        }}
        toolbar={selection.length === 1 ? (
          <Button size="xs" variant="default" leftSection={<IconActivity size={13} />} onClick={() => setStatus(String(selection[0]))} data-testid="links-show-status">Show Status</Button>
        ) : undefined}
        columns={[
          {
            key: "Online_bool", title: "On", width: 52, align: "center",
            render: (l) => (
              <span onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} style={{ display: "inline-flex" }}>
                <Switch size="xs" checked={l.Online_bool} aria-label={`${l.AccountName_utf} online`} disabled={online.isPending || offline.isPending}
                  onChange={(e) => setLinkOnline(l, e.currentTarget.checked)} data-testid={`link-online-${l.AccountName_utf}`} />
              </span>
            ),
          },
          { key: "AccountName_utf", title: "Name", width: "20%", truncate: true, render: (l) => <span className="sem-strong" title={l.AccountName_utf}>{l.AccountName_utf}</span> },
          {
            key: "status", title: "Status", width: 118, value: (l) => linkState(l).label,
            render: (l) => { const s = linkState(l); return <StatusBadge status={s.status} testId={`link-status-${l.AccountName_utf}`}>{s.label}</StatusBadge>; },
          },
          { key: "Hostname_str", title: "Server", truncate: true, render: (l) => <span title={l.Hostname_str}><Mono>{l.Hostname_str}</Mono></span> },
          { key: "TargetHubName_str", title: "Hub", truncate: true, render: (l) => <span title={l.TargetHubName_str}>{l.TargetHubName_str}</span> },
          {
            key: "ConnectedTime_dt", title: "Connected", width: 110, value: (l) => (l.Connected_bool ? l.ConnectedTime_dt : ""),
            render: (l) => (l.Connected_bool ? <span title={dt(l.ConnectedTime_dt)}>{agoShort(l.ConnectedTime_dt)}</span> : <span className="sem-dim">–</span>),
          },
          {
            key: "LastError_u32", title: "Last error", width: "28%", truncate: true, value: (l) => (l.LastError_u32 ? errText(l.LastError_u32) : ""),
            render: (l) => (l.LastError_u32 ? <span className="sem-text-red" title={`${errText(l.LastError_u32)} (error ${l.LastError_u32})`}>{errText(l.LastError_u32)}</span> : <span className="sem-dim">–</span>),
          },
        ]}
      />
      <LinkSheet serverId={serverId} hub={hub} name={editing?.name ?? null} opened={!!editing} onClose={() => setEditing(null)}
        existing={list.map((l) => l.AccountName_utf)} onCreated={(n) => setSelection([n])} />
      <StatusInspector serverId={serverId} hub={hub} link={statusLink} onClose={() => setStatus(null)}
        onEdit={(n) => setEditing({ name: n })} onToggle={(l) => setLinkOnline(l, !l.Online_bool)} />
      <RenameSheet serverId={serverId} hub={hub} name={renaming} onClose={() => setRenaming(null)} existing={list.map((l) => l.AccountName_utf)} />
    </>
  );
}

