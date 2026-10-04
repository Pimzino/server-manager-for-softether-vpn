// Client Deployment › Templates & Branding: reusable settings for hub packages — connection options,
// how credentials are delivered, installer behaviour and branding (MSI, setup.exe, the VPN client).
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, NumberInput, PasswordInput, Radio, SegmentedControl, Select, Textarea, TextInput } from "@mantine/core";
import { IconCopy, IconPalette, IconPencil, IconPhoto, IconPlus, IconStar, IconTrash } from "@tabler/icons-react";
import { del, post, put } from "../../lib/api";
import { agoShort, dt } from "../../lib/format";
import { notifyError, notifySuccess } from "../../lib/hooks";
import { confirmAction, DataTable, FormRow, FormSection, PageHeader, Sheet, Tag } from "../../design";
import { usePackages } from "../../components/domain/deploy";
import { PolicyBadge, POLICY_LABEL, useTemplates, type Template, type TemplateSettings } from "../../components/domain/hubdeploy";
import { openB64 } from "../../components/domain/files";
import { Callout } from "../../components/domain/ui";
import { SheetFooter, SwitchRow, invalidateDeploy } from "./_deployment/shared";

const INFINITE = 4294967295;
const EMPTY: TemplateSettings = {
  connection: {
    accountNamePattern: "{hub} VPN", publicHost: "", publicPort: 0, pinServerCertificate: true, checkServerCert: true, addDefaultCa: false,
    startup: true, maxConnection: 1, useEncrypt: true, useCompress: false, halfConnection: false, noUdpAcceleration: false, disableQoS: false,
    noRoutingTracking: false, additionalConnectionInterval: 1, connectionDisconnectSpan: 0, numRetry: INFINITE, retryInterval: 15,
    hideStatusWindow: false, hideNicInfoWindow: false, proxyType: "direct", proxyHost: "", proxyPort: 0, proxyUsername: "",
  },
  credentials: { passwordUsers: "embed-hash", rotateLength: 20 },
  installer: {
    productName: "{hub} VPN", manufacturer: "IT Department", baseVersion: "1.0", installFolder: "VPN Client", connectAfterInstall: true,
    deleteProfileAfterImport: true, startMenuShortcut: true, uiHelperAtLogon: true, preserveOnUpgrade: true, configureTimeoutSec: 300,
    nicName: "VPN", packageId: null, arch: "x64",
  },
  branding: {
    iconIco: null, arpHelpLink: "", arpUrlInfoAbout: "", arpContact: "", arpHelpTelephone: "", arpComments: "", startMenuFolder: "",
    shortcutName: "VPN Client Manager", serviceDisplayName: "", serviceDescription: "",
  },
  setupExe: { companyName: "", productName: "{hub} VPN", fileDescription: "{hub} VPN Setup", copyright: "", ui: "basic", fileNamePattern: "{hub}-{user}-setup" },
  client: { brandBinaries: false, displayName: "", managerName: "", stringOverrides: {} },
};

const PLACEHOLDERS = <>Placeholders: <code className="sem-code-inline">{"{server}"}</code> <code className="sem-code-inline">{"{hub}"}</code> <code className="sem-code-inline">{"{user}"}</code></>;
const TABS = [
  { value: "general", label: "General" },
  { value: "connection", label: "Connection" },
  { value: "credentials", label: "Credentials" },
  { value: "installer", label: "Installer" },
  { value: "branding", label: "MSI Branding" },
  { value: "exe", label: "setup.exe" },
  { value: "client", label: "Client" },
] as const;
type Tab = (typeof TABS)[number]["value"];

const CTRL = /[\x00-\x1f]/;
const BASE_VERSION = /^(25[0-5]|2[0-4]\d|1?\d?\d)\.(25[0-5]|2[0-4]\d|1?\d?\d)$/;
const FOLDER = /^[^\\/:*?"<>|\x00-\x1f]+$/;
const NIC = /^VPN([1-9]|[1-9]\d|1[01]\d|12[0-7])?$/;
const URLISH = (v: string) => v === "" || /^(https?:\/\/|mailto:)/i.test(v);
const inRange = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;

/** Field errors, keyed "tab.field", mirroring the backend's template schema. */
function validate(name: string, description: string, s: TemplateSettings, overridesError: string | null): Record<string, string> {
  const e: Record<string, string> = {};
  const c = s.connection, ins = s.installer, b = s.branding, ex = s.setupExe, cl = s.client;
  if (!name.trim()) e["general.name"] = "Enter a name.";
  else if (name.trim().length > 100) e["general.name"] = "Up to 100 characters.";
  if (description.length > 1000) e["general.description"] = "Up to 1000 characters.";
  if (CTRL.test(c.accountNamePattern) || c.accountNamePattern.length > 200) e["connection.accountNamePattern"] = "Up to 200 characters, no control characters.";
  if (!inRange(c.publicPort, 0, 65535)) e["connection.publicPort"] = "0 to 65535.";
  if (!inRange(c.maxConnection, 1, 32)) e["connection.maxConnection"] = "1 to 32.";
  if (c.halfConnection && c.maxConnection < 2) e["connection.halfConnection"] = "Half-duplex needs at least 2 TCP connections.";
  if (!inRange(c.retryInterval, 5, 3600)) e["connection.retryInterval"] = "5 to 3600 seconds.";
  if (!inRange(c.additionalConnectionInterval, 1, 3600)) e["connection.additionalConnectionInterval"] = "1 to 3600 seconds.";
  if (!inRange(c.connectionDisconnectSpan, 0, INFINITE)) e["connection.connectionDisconnectSpan"] = "0 or more seconds.";
  if (!inRange(c.numRetry, 0, INFINITE)) e["connection.numRetry"] = "Out of range.";
  if (c.proxyType !== "direct" && !c.proxyHost.trim()) e["connection.proxyHost"] = "Enter the proxy host.";
  if (c.proxyType !== "direct" && !inRange(c.proxyPort, 1, 65535)) e["connection.proxyPort"] = "1 to 65535.";
  if (s.credentials.passwordUsers === "rotate" && !inRange(s.credentials.rotateLength, 12, 64)) e["credentials.rotateLength"] = "12 to 64 characters.";
  if (!ins.productName.trim() || CTRL.test(ins.productName)) e["installer.productName"] = "Enter a product name.";
  if (!ins.manufacturer.trim() || CTRL.test(ins.manufacturer)) e["installer.manufacturer"] = "Enter the publisher.";
  if (!BASE_VERSION.test(ins.baseVersion)) e["installer.baseVersion"] = "major.minor, each 0–255 (e.g. 1.0).";
  if (!FOLDER.test(ins.installFolder.trim())) e["installer.installFolder"] = "One folder name without \\ / : * ? \" < > |.";
  if (!NIC.test(ins.nicName)) e["installer.nicName"] = "VPN, VPN2 … VPN127.";
  if (!inRange(ins.configureTimeoutSec, 30, 1800)) e["installer.configureTimeoutSec"] = "30 to 1800 seconds.";
  if (!URLISH(b.arpHelpLink)) e["branding.arpHelpLink"] = "Must start with https://, http:// or mailto:.";
  if (!URLISH(b.arpUrlInfoAbout)) e["branding.arpUrlInfoAbout"] = "Must start with https://, http:// or mailto:.";
  for (const k of ["arpContact", "arpHelpTelephone", "arpComments", "startMenuFolder", "shortcutName", "serviceDisplayName", "serviceDescription"] as const) {
    if (CTRL.test(b[k])) e[`branding.${k}`] = "No line breaks or control characters.";
  }
  for (const k of ["companyName", "productName", "fileDescription", "copyright", "fileNamePattern"] as const) {
    if (CTRL.test(ex[k])) e[`exe.${k}`] = "No line breaks or control characters.";
  }
  if (CTRL.test(cl.displayName)) e["client.displayName"] = "No control characters.";
  if (CTRL.test(cl.managerName)) e["client.managerName"] = "No control characters.";
  if (overridesError) e["client.stringOverrides"] = overridesError;
  return e;
}

function parseOverrides(text: string): { value?: Record<string, string>; error?: string } {
  try {
    const o = JSON.parse(text.trim() || "{}");
    if (typeof o !== "object" || o === null || Array.isArray(o)) return { error: "Enter a JSON object, e.g. { \"KEY\": \"text\" }." };
    for (const [k, v] of Object.entries(o)) {
      if (!/^[A-Z0-9_]{2,80}$/.test(k)) return { error: `“${k}” isn’t a string-table key (UPPER_CASE letters, digits and _).` };
      if (typeof v !== "string") return { error: `The value of ${k} must be text.` };
    }
    return { value: o as Record<string, string> };
  } catch (e) {
    return { error: `Not valid JSON: ${(e as Error).message}` };
  }
}

function TemplateSheet({ template, copyFrom, opened, onClose }: { template: Template | null; copyFrom: Template | null; opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const packages = usePackages();
  const [tab, setTab] = useState<Tab>("general");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [s, setS] = useState<TemplateSettings>(EMPTY);
  const [overridesText, setOverridesText] = useState("{}");
  const [touched, setTouched] = useState(false);
  const [storedPw, setStoredPw] = useState(false);

  useEffect(() => {
    if (!opened) return;
    const src = template ?? copyFrom;
    setTab("general");
    setName(template ? template.name : copyFrom ? `${copyFrom.name} (copy)` : "");
    setDescription(src?.description ?? "");
    setIsDefault(template?.isDefault ?? false);
    const base = structuredClone(src ? src.settings : EMPTY);
    if (!template && copyFrom && base.installer.clientConfigPassword === "********") delete base.installer.clientConfigPassword;
    setS(base);
    setStoredPw(base.installer.clientConfigPassword === "********");
    setOverridesText(JSON.stringify(base.client.stringOverrides ?? {}, null, 2));
    setTouched(false);
  }, [opened, template, copyFrom]);

  const parsed = parseOverrides(overridesText);
  const errors = validate(name, description, s, parsed.error ?? null);
  const err = (k: string) => (touched || k === "client.stringOverrides" ? errors[k] : undefined);
  const tabErrors = (t: Tab) => Object.keys(errors).filter((k) => k.startsWith(`${t}.`)).length;

  const set = <K extends keyof TemplateSettings>(k: K, patch: Partial<TemplateSettings[K]>) => setS((x) => ({ ...x, [k]: { ...x[k], ...patch } }));
  const c = s.connection, cr = s.credentials, ins = s.installer, b = s.branding, ex = s.setupExe, cl = s.client;

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description, isDefault, settings: { ...s, client: { ...s.client, stringOverrides: parsed.value ?? {} } } };
      return template ? put(`/api/deploy/templates/${template.id}`, body) : post("/api/deploy/templates", body);
    },
    onSuccess: () => { notifySuccess(template ? `Saved “${name.trim()}”` : `Created “${name.trim()}”`); void invalidateDeploy(qc); onClose(); },
    onError: (e) => notifyError(e, "Couldn’t save the template"),
  });
  const submit = () => {
    setTouched(true);
    const bad = Object.keys(errors);
    if (bad.length) { setTab(bad[0].split(".")[0] as Tab); return; }
    save.mutate();
  };

  const chooseIcon = async () => {
    try {
      const f = await openB64({ title: "Choose a Windows Icon", filters: [{ name: "Windows Icons", extensions: ["ico"] }] });
      if (!f) return;
      const bin = atob(f.b64.slice(0, 8));
      if (bin.charCodeAt(0) !== 0 || bin.charCodeAt(1) !== 0 || bin.charCodeAt(2) !== 1) throw new Error("Choose a Windows .ico file (multi-size, 256×256 recommended).");
      set("branding", { iconIco: f.b64 });
    } catch (e) {
      notifyError(e, "Couldn’t use that icon");
    }
  };

  const num = (v: number | string, fallback: number) => (typeof v === "number" ? v : v === "" ? fallback : Number(v));
  const text = (k: string, value: string, onChange: (v: string) => void, extra: { w?: number | string; testId?: string; placeholder?: string } = {}) => (id: string) => (
    <TextInput id={id} value={value} onChange={(e) => onChange(e.currentTarget.value)} w={extra.w ?? "100%"} data-testid={extra.testId} placeholder={extra.placeholder} error={!!err(k)} />
  );
  const badCount = Object.keys(errors).length;

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={save.isPending} size={780} testId="template-editor"
      icon={<IconPalette size={19} stroke={1.5} />}
      title={template ? `Edit “${template.name}”` : copyFrom ? `Duplicate “${copyFrom.name}”` : "New Template"}
      subtitle="Hubs use the default template unless their Client Deployment page picks another."
      footer={(
        <SheetFooter leading={touched && badCount > 0 ? <span className="sem-text-red" data-testid="template-errors">{badCount === 1 ? "Fix 1 field" : `Fix ${badCount} fields`} to save.</span> : undefined}>
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending} data-testid="template-save">{template ? "Save" : "Create Template"}</Button>
        </SheetFooter>
      )}
    >
      <SegmentedControl
        fullWidth size="xs" value={tab} onChange={(v) => setTab(v as Tab)} data-testid="template-tabs"
        data={TABS.map((t) => ({ value: t.value, label: touched && tabErrors(t.value) ? <span className="sem-text-red">{t.label} •</span> : t.label }))}
      />

      <div style={{ minHeight: "min(520px, calc(100vh - 300px))" }}>
      {tab === "general" && (
        <FormSection>
          <FormRow label="Name" error={err("general.name")}>{text("general.name", name, setName, { testId: "template-name" })}</FormRow>
          <FormRow label="Description" align="start" error={err("general.description")}>{(id) => <Textarea id={id} w="100%" autosize minRows={2} maxRows={5} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />}</FormRow>
          <SwitchRow label="Default template" description={template?.isDefault ? "Make another template the default to change this." : "Used by every hub that doesn’t pick a template."}
            checked={isDefault} onChange={setIsDefault} disabled={template?.isDefault} testId="template-default" />
        </FormSection>
      )}

      {tab === "connection" && (
        <>
          <FormSection title="Endpoint">
            <FormRow label="Connection name" description={<>Shown in the VPN client. {PLACEHOLDERS}</>} error={err("connection.accountNamePattern")}>
              {text("connection.accountNamePattern", c.accountNamePattern, (v) => set("connection", { accountNamePattern: v }), { testId: "tpl-account-pattern" })}
            </FormRow>
            <FormRow label="Default public host" description="Empty uses the server’s address in this app. Hubs can override it.">
              {text("connection.publicHost", c.publicHost, (v) => set("connection", { publicHost: v }))}
            </FormRow>
            <FormRow label="Default public port" description="0 uses the server’s port in this app." error={err("connection.publicPort")}>
              {(id) => <NumberInput id={id} w={120} min={0} max={65535} allowDecimal={false} value={c.publicPort} onChange={(v) => set("connection", { publicPort: num(v, 0) })} />}
            </FormRow>
          </FormSection>
          <FormSection title="Server certificate">
            <SwitchRow label="Pin the server certificate" description="Embeds the server’s certificate so the client trusts only it." checked={c.pinServerCertificate} onChange={(v) => set("connection", { pinServerCertificate: v })} />
            <SwitchRow label="Verify the server certificate" checked={c.checkServerCert} onChange={(v) => set("connection", { checkServerCert: v })} />
            <SwitchRow label="Also trust the system CA list" checked={c.addDefaultCa} onChange={(v) => set("connection", { addDefaultCa: v })} />
          </FormSection>
          <FormSection title="Behaviour">
            <SwitchRow label="Connect at startup" checked={c.startup} onChange={(v) => set("connection", { startup: v })} />
            <SwitchRow label="Encrypt (SSL)" checked={c.useEncrypt} onChange={(v) => set("connection", { useEncrypt: v })} />
            <SwitchRow label="Compress data" checked={c.useCompress} onChange={(v) => set("connection", { useCompress: v })} />
            <SwitchRow label="Half-duplex connections" checked={c.halfConnection} onChange={(v) => set("connection", { halfConnection: v })} error={err("connection.halfConnection")} />
            <SwitchRow label="Disable UDP acceleration" checked={c.noUdpAcceleration} onChange={(v) => set("connection", { noUdpAcceleration: v })} />
            <SwitchRow label="Disable VoIP / QoS control" checked={c.disableQoS} onChange={(v) => set("connection", { disableQoS: v })} />
            <SwitchRow label="Don’t adjust the routing table" checked={c.noRoutingTracking} onChange={(v) => set("connection", { noRoutingTracking: v })} />
            <SwitchRow label="Hide the connection status window" checked={c.hideStatusWindow} onChange={(v) => set("connection", { hideStatusWindow: v })} />
            <SwitchRow label="Hide the adapter IP window" checked={c.hideNicInfoWindow} onChange={(v) => set("connection", { hideNicInfoWindow: v })} />
          </FormSection>
          <FormSection title="Advanced communication">
            <FormRow label="TCP connections" error={err("connection.maxConnection")}>
              {(id) => <NumberInput id={id} w={120} min={1} max={32} allowDecimal={false} value={c.maxConnection} onChange={(v) => set("connection", { maxConnection: num(v, 1) })} />}
            </FormRow>
            <FormRow label="Retry interval" error={err("connection.retryInterval")}>
              {(id) => <NumberInput id={id} w={120} min={5} max={3600} allowDecimal={false} suffix=" s" value={c.retryInterval} onChange={(v) => set("connection", { retryInterval: num(v, 15) })} />}
            </FormRow>
            <SwitchRow label="Retry forever" checked={c.numRetry === INFINITE} onChange={(v) => set("connection", { numRetry: v ? INFINITE : 10 })} />
            {c.numRetry !== INFINITE && (
              <FormRow label="Reconnect attempts" description="0 never reconnects." error={err("connection.numRetry")}>
                {(id) => <NumberInput id={id} w={120} min={0} allowDecimal={false} value={c.numRetry} onChange={(v) => set("connection", { numRetry: num(v, 0) })} />}
              </FormRow>
            )}
            <FormRow label="Interval between connections" error={err("connection.additionalConnectionInterval")}>
              {(id) => <NumberInput id={id} w={120} min={1} max={3600} allowDecimal={false} suffix=" s" value={c.additionalConnectionInterval} onChange={(v) => set("connection", { additionalConnectionInterval: num(v, 1) })} />}
            </FormRow>
            <FormRow label="Connection lifetime" description="0 keeps connections indefinitely." error={err("connection.connectionDisconnectSpan")}>
              {(id) => <NumberInput id={id} w={120} min={0} allowDecimal={false} suffix=" s" value={c.connectionDisconnectSpan} onChange={(v) => set("connection", { connectionDisconnectSpan: num(v, 0) })} />}
            </FormRow>
          </FormSection>
          <FormSection title="Proxy">
            <FormRow label="Connection method">
              {(id) => (
                <Select id={id} w={220} allowDeselect={false} value={c.proxyType}
                  data={[{ value: "direct", label: "Direct (no proxy)" }, { value: "http", label: "HTTP proxy" }, { value: "socks4", label: "SOCKS4 proxy" }, { value: "socks5", label: "SOCKS5 proxy" }]}
                  onChange={(v) => set("connection", { proxyType: (v ?? "direct") as TemplateSettings["connection"]["proxyType"] })} />
              )}
            </FormRow>
            {c.proxyType !== "direct" && (
              <>
                <FormRow label="Proxy host" error={err("connection.proxyHost")}>{text("connection.proxyHost", c.proxyHost, (v) => set("connection", { proxyHost: v }))}</FormRow>
                <FormRow label="Proxy port" error={err("connection.proxyPort")}>
                  {(id) => <NumberInput id={id} w={120} min={1} max={65535} allowDecimal={false} value={c.proxyPort || ""} onChange={(v) => set("connection", { proxyPort: num(v, 0) })} />}
                </FormRow>
                <FormRow label="Proxy user name" description="Optional. Users are asked for the proxy password.">{text("connection.proxyUsername", c.proxyUsername, (v) => set("connection", { proxyUsername: v }))}</FormRow>
              </>
            )}
          </FormSection>
        </>
      )}

      {tab === "credentials" && (
        <>
          <FormSection title="Password users" description="What a per-user package contains for users with password authentication.">
            <Radio.Group value={cr.passwordUsers} onChange={(v) => set("credentials", { passwordUsers: v as TemplateSettings["credentials"]["passwordUsers"] })} data-testid="tpl-policy">
              {(["embed-hash", "rotate", "install-time", "prompt"] as const).map((p) => (
                <div key={p} className="sem-form-row" data-align="start" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
                  <Radio value={p} data-testid={`tpl-policy-${p}`} label={<span className="sem-row-inline"><PolicyBadge value={p} /></span>} description={POLICY_LABEL[p].help} />
                </div>
              ))}
            </Radio.Group>
          </FormSection>
          {cr.passwordUsers === "rotate" && (
            <FormSection>
              <FormRow label="Generated password length" error={err("credentials.rotateLength")}>
                {(id) => <NumberInput id={id} w={120} min={12} max={64} allowDecimal={false} value={cr.rotateLength} onChange={(v) => set("credentials", { rotateLength: num(v, 20) })} />}
              </FormRow>
            </FormSection>
          )}
          <div className="sem-callouts">
            <Callout tone="gray">RADIUS and NT-domain users always enter their password (or get it at install time). Certificate users need their own certificate and key, which aren’t generated.</Callout>
          </div>
        </>
      )}

      {tab === "installer" && (
        <>
          <FormSection title="Product">
            <FormRow label="Product name" description={PLACEHOLDERS} error={err("installer.productName")}>{text("installer.productName", ins.productName, (v) => set("installer", { productName: v }), { testId: "tpl-product-name" })}</FormRow>
            <FormRow label="Publisher" error={err("installer.manufacturer")}>{text("installer.manufacturer", ins.manufacturer, (v) => set("installer", { manufacturer: v }))}</FormRow>
            <FormRow label="Base version" description="major.minor. The build number goes up with every build for a hub." error={err("installer.baseVersion")}>
              {text("installer.baseVersion", ins.baseVersion, (v) => set("installer", { baseVersion: v.trim() }), { w: 120, testId: "tpl-base-version" })}
            </FormRow>
            <FormRow label="Install folder" description="Under Program Files." error={err("installer.installFolder")}>{text("installer.installFolder", ins.installFolder, (v) => set("installer", { installFolder: v }))}</FormRow>
          </FormSection>
          <FormSection title="Client files">
            <FormRow label="Client package" description="Empty uses the newest package for the architecture.">
              {(id) => (
                <Select id={id} w="100%" clearable placeholder="Newest package" data-testid="tpl-package" value={ins.packageId ? String(ins.packageId) : null}
                  data={(packages.data ?? []).map((p) => ({ value: String(p.id), label: `${p.filename} · ${p.edition === "dev" ? "Developer" : "Stable"} ${p.arch}${p.version ? ` · ${p.version}` : ""}` }))}
                  onChange={(v) => set("installer", { packageId: v ? Number(v) : null })} />
              )}
            </FormRow>
            <FormRow label="Architecture">
              {(id) => <SegmentedControl id={id} size="xs" data={["x64", "x86"]} value={ins.arch} onChange={(v) => set("installer", { arch: v as "x64" | "x86" })} />}
            </FormRow>
            <FormRow label="Virtual adapter" error={err("installer.nicName")}>{text("installer.nicName", ins.nicName, (v) => set("installer", { nicName: v.trim() }), { w: 120, placeholder: "VPN" })}</FormRow>
            <FormRow label="Configuration timeout" description="The install fails with 1460 instead of hanging on a hidden driver prompt." error={err("installer.configureTimeoutSec")}>
              {(id) => <NumberInput id={id} w={120} min={30} max={1800} allowDecimal={false} suffix=" s" value={ins.configureTimeoutSec} onChange={(v) => set("installer", { configureTimeoutSec: num(v, 300) })} />}
            </FormRow>
          </FormSection>
          <FormSection title="Behaviour">
            <SwitchRow label="Connect right after installing" checked={ins.connectAfterInstall} onChange={(v) => set("installer", { connectAfterInstall: v })} />
            <SwitchRow label="Delete the profile file after import" checked={ins.deleteProfileAfterImport} onChange={(v) => set("installer", { deleteProfileAfterImport: v })} />
            <SwitchRow label="Start menu shortcut" checked={ins.startMenuShortcut} onChange={(v) => set("installer", { startMenuShortcut: v })} />
            <SwitchRow label="Run the UI helper at logon" checked={ins.uiHelperAtLogon} onChange={(v) => set("installer", { uiHelperAtLogon: v })} />
            <SwitchRow label="Keep the connection on upgrade" checked={ins.preserveOnUpgrade} onChange={(v) => set("installer", { preserveOnUpgrade: v })} />
            <FormRow label="Client configuration password" description={storedPw ? "A password is stored. Type a new one to replace it." : "Optional. Stops users changing or removing the connection."}>
              {(id) => (
                <div className="sem-row-inline" style={{ flexWrap: "nowrap" }}>
                  <PasswordInput id={id} w={240} autoComplete="new-password" data-testid="tpl-config-password"
                    value={ins.clientConfigPassword === "********" ? "" : ins.clientConfigPassword ?? ""}
                    placeholder={ins.clientConfigPassword === "********" ? "Stored password kept" : undefined}
                    onChange={(e) => set("installer", { clientConfigPassword: e.currentTarget.value || (storedPw ? "********" : undefined) })} />
                  {storedPw && ins.clientConfigPassword === "********" && (
                    <Button size="xs" variant="subtle" color="red" onClick={() => { setStoredPw(false); set("installer", { clientConfigPassword: undefined }); }}>Remove</Button>
                  )}
                </div>
              )}
            </FormRow>
          </FormSection>
        </>
      )}

      {tab === "branding" && (
        <>
          <FormSection title="Icon" description="Used in Apps & Features, the Start menu shortcut, setup.exe and, if enabled, the client executables.">
            <FormRow label={b.iconIco ? "Custom icon" : "Default icon"}>
              <div className="sem-row-inline" style={{ alignSelf: "flex-end" }}>
                {b.iconIco
                  ? <img src={`data:image/x-icon;base64,${b.iconIco}`} width={32} height={32} alt="Icon preview" data-testid="tpl-icon-preview" />
                  : <IconPhoto size={28} stroke={1.3} className="sem-dim" />}
                <Button size="xs" variant="default" onClick={chooseIcon} data-testid="tpl-icon-upload">Choose Icon…</Button>
                {b.iconIco && <Button size="xs" variant="subtle" color="red" onClick={() => set("branding", { iconIco: null })}>Remove</Button>}
              </div>
            </FormRow>
          </FormSection>
          <FormSection title="Apps & Features">
            <FormRow label="Support link" error={err("branding.arpHelpLink")}>{text("branding.arpHelpLink", b.arpHelpLink, (v) => set("branding", { arpHelpLink: v }), { placeholder: "https://support.example.com/vpn" })}</FormRow>
            <FormRow label="Publisher web site" error={err("branding.arpUrlInfoAbout")}>{text("branding.arpUrlInfoAbout", b.arpUrlInfoAbout, (v) => set("branding", { arpUrlInfoAbout: v }), { placeholder: "https://example.com" })}</FormRow>
            <FormRow label="Support contact" error={err("branding.arpContact")}>{text("branding.arpContact", b.arpContact, (v) => set("branding", { arpContact: v }))}</FormRow>
            <FormRow label="Support telephone" error={err("branding.arpHelpTelephone")}>{text("branding.arpHelpTelephone", b.arpHelpTelephone, (v) => set("branding", { arpHelpTelephone: v }), { w: 220 })}</FormRow>
            <FormRow label="Comments" error={err("branding.arpComments")}>{text("branding.arpComments", b.arpComments, (v) => set("branding", { arpComments: v }))}</FormRow>
          </FormSection>
          <FormSection title="Shortcuts and service">
            <FormRow label="Start menu folder" description={<>Empty uses the product name. {PLACEHOLDERS}</>} error={err("branding.startMenuFolder")}>{text("branding.startMenuFolder", b.startMenuFolder, (v) => set("branding", { startMenuFolder: v }))}</FormRow>
            <FormRow label="Shortcut name" error={err("branding.shortcutName")}>{text("branding.shortcutName", b.shortcutName, (v) => set("branding", { shortcutName: v }))}</FormRow>
            <FormRow label="Service display name" description="Empty keeps SoftEther’s name." error={err("branding.serviceDisplayName")}>{text("branding.serviceDisplayName", b.serviceDisplayName, (v) => set("branding", { serviceDisplayName: v }))}</FormRow>
            <FormRow label="Service description" error={err("branding.serviceDescription")}>{text("branding.serviceDescription", b.serviceDescription, (v) => set("branding", { serviceDescription: v }))}</FormRow>
          </FormSection>
        </>
      )}

      {tab === "exe" && (
        <FormSection
          title="setup.exe"
          description="setup.exe wraps the MSI for people who install it themselves. It shows your icon and details, and accepts /quiet, /passive, /log <file>, /uninstall and NAME=value."
        >
          <FormRow label="Company name" description="Empty uses the publisher." error={err("exe.companyName")}>{text("exe.companyName", ex.companyName, (v) => set("setupExe", { companyName: v }))}</FormRow>
          <FormRow label="Product name" description={PLACEHOLDERS} error={err("exe.productName")}>{text("exe.productName", ex.productName, (v) => set("setupExe", { productName: v }))}</FormRow>
          <FormRow label="File description" error={err("exe.fileDescription")}>{text("exe.fileDescription", ex.fileDescription, (v) => set("setupExe", { fileDescription: v }))}</FormRow>
          <FormRow label="Copyright" error={err("exe.copyright")}>{text("exe.copyright", ex.copyright, (v) => set("setupExe", { copyright: v }))}</FormRow>
          <FormRow label="File name" description={<>The version and .exe are appended. {PLACEHOLDERS}</>} error={err("exe.fileNamePattern")}>{text("exe.fileNamePattern", ex.fileNamePattern, (v) => set("setupExe", { fileNamePattern: v }))}</FormRow>
          <FormRow label="Installer window">
            {(id) => <SegmentedControl id={id} size="xs" value={ex.ui} onChange={(v) => set("setupExe", { ui: v as "basic" | "full" })} data={[{ value: "basic", label: "Progress Only" }, { value: "full", label: "Full Wizard" }]} />}
          </FormRow>
        </FormSection>
      )}

      {tab === "client" && (
        <>
          <FormSection title="Client branding" description="Changes SoftEther’s product names in its windows, tray and service (from its string tables). Nothing is rebuilt.">
            <FormRow label="Client display name" description="E.g. Contoso VPN." error={err("client.displayName")}>{text("client.displayName", cl.displayName, (v) => set("client", { displayName: v }), { testId: "tpl-client-name" })}</FormRow>
            <FormRow label="Client Manager name" description="Title of the connection manager window." error={err("client.managerName")}>{text("client.managerName", cl.managerName, (v) => set("client", { managerName: v }))}</FormRow>
            <SwitchRow label="Brand the client executables" description="Sets the icon and version details of vpnclient.exe and vpncmgr.exe. Any code signature on them becomes invalid."
              checked={cl.brandBinaries} onChange={(v) => set("client", { brandBinaries: v })} />
          </FormSection>
          <FormSection title="String-table overrides" description={<>Advanced. Keys from <code className="sem-code-inline">strtable_en.stb</code> and their text. Unknown keys are reported in the build log.</>}>
            <FormRow label="Overrides (JSON)" stacked error={err("client.stringOverrides")}>
              {(id) => (
                <Textarea id={id} w="100%" autosize minRows={4} maxRows={12} value={overridesText} onChange={(e) => setOverridesText(e.currentTarget.value)}
                  styles={{ input: { fontFamily: "var(--sem-font-mono)", fontSize: "var(--sem-fz-small)" } }} error={!!errors["client.stringOverrides"]} data-testid="tpl-overrides"
                  placeholder={'{ "CM_PRODUCT_NAME": "Contoso VPN Build %u" }'} />
              )}
            </FormRow>
          </FormSection>
        </>
      )}
      </div>
    </Sheet>
  );
}

export default function TemplatesPage() {
  const templates = useTemplates();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const [copyFrom, setCopyFrom] = useState<Template | null>(null);
  const rows = useMemo(() => templates.data ?? [], [templates.data]);

  const open = (t: Template | "new", from: Template | null = null) => { setCopyFrom(from); setEditing(t); };
  const makeDefault = async (t: Template) => {
    try {
      await put(`/api/deploy/templates/${t.id}`, { name: t.name, description: t.description, isDefault: true, settings: t.settings });
      notifySuccess(`“${t.name}” is now the default template`);
      void invalidateDeploy(qc);
    } catch (e) { notifyError(e, "Couldn’t change the default template"); }
  };
  const remove = async (t: Template) => {
    const ok = await confirmAction({
      title: <>Delete the template “{t.name}”?</>,
      message: "Hubs that use it switch to the default template. Packages already built aren’t affected.",
      confirmLabel: "Delete Template", testId: "delete-template",
    });
    if (!ok) return;
    try {
      const r = await del<{ hubsFallingBackToDefault?: number }>(`/api/deploy/templates/${t.id}`);
      notifySuccess(r?.hubsFallingBackToDefault ? `Deleted “${t.name}”. ${r.hubsFallingBackToDefault} hub(s) now use the default template.` : `Deleted “${t.name}”`);
      void invalidateDeploy(qc);
    } catch (e) { notifyError(e, "Couldn’t delete the template"); }
  };

  return (
    <>
      <PageHeader
        title="Templates & Branding"
        meta={templates.data ? <>{rows.length} {rows.length === 1 ? "template" : "templates"} · default: {rows.find((t) => t.isDefault)?.name ?? "–"}</> : undefined}
        description="Reusable settings for hub packages: connection options, how credentials are delivered, installer behaviour and branding."
        actions={<Button leftSection={<IconPlus size={14} />} onClick={() => open("new")} data-testid="create-template">New Template…</Button>}
      />
      <DataTable<Template>
        testId="templates-table"
        aria-label="Templates"
        data={templates.data}
        loading={templates.isLoading}
        error={templates.error}
        onRetry={() => void templates.refetch()}
        rowKey={(t) => t.id}
        rowTestId={(t) => `template-${t.name}`}
        selectable="single"
        initialSort={{ key: "name", dir: "asc" }}
        onRowOpen={(t) => open(t)}
        searchable={rows.length > 8}
        empty={{ title: "No templates", description: "The default template is created automatically." }}
        contextMenu={(t) => [
          { label: "Edit…", icon: <IconPencil size={14} />, onClick: () => open(t), testId: "ctx-edit" },
          { label: "Duplicate…", icon: <IconCopy size={14} />, onClick: () => open("new", t), testId: "ctx-duplicate" },
          { label: "Make Default", icon: <IconStar size={14} />, disabled: t.isDefault, onClick: () => void makeDefault(t), testId: "ctx-make-default" },
          "divider",
          { label: t.isDefault ? "Delete… (make another default first)" : "Delete…", icon: <IconTrash size={14} />, danger: true, disabled: t.isDefault, onClick: () => void remove(t), testId: "ctx-delete" },
        ]}
        columns={[
          {
            key: "name", title: "Template", width: 230,
            render: (t) => (
              <span className="sem-row-inline" style={{ flexWrap: "nowrap", maxWidth: "100%" }}>
                {t.settings.branding.iconIco
                  ? <img src={`data:image/x-icon;base64,${t.settings.branding.iconIco}`} width={16} height={16} alt="" />
                  : <IconPalette size={16} stroke={1.5} className="sem-dim" />}
                <span className="sem-strong" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</span>
                {t.isDefault && <Tag color="accent">Default</Tag>}
              </span>
            ),
          },
          { key: "description", title: "Description", truncate: true, render: (t) => t.description ? <span className="sem-dim">{t.description}</span> : <span className="sem-dim">–</span> },
          { key: "product", title: "Product", width: 150, truncate: true, value: (t) => t.settings.installer.productName },
          { key: "policy", title: "Password users", width: 130, value: (t) => t.settings.credentials.passwordUsers, render: (t) => <PolicyBadge value={t.settings.credentials.passwordUsers} /> },
          { key: "client", title: "Client branding", width: 130, truncate: true, value: (t) => t.settings.client.displayName, render: (t) => t.settings.client.displayName || <span className="sem-dim">SoftEther</span> },
          { key: "updatedAt", title: "Updated", width: 90, render: (t) => <span className="sem-dim" title={dt(t.updatedAt)}>{agoShort(t.updatedAt)}</span> },
        ]}
      />
      <TemplateSheet opened={editing !== null} template={editing === "new" ? null : editing} copyFrom={copyFrom} onClose={() => setEditing(null)} />
    </>
  );
}

