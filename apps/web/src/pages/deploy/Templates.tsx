import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ActionIcon, Alert, Badge, Button, Drawer, FileButton, Group, Image, JsonInput, NumberInput, PasswordInput, Radio, Select, SimpleGrid,
  Stack, Switch, Tabs, Text, TextInput, Textarea, Tooltip,
} from "@mantine/core";
import {
  IconBrandWindows, IconCopy, IconEdit, IconKey, IconPalette, IconPlug, IconPlus, IconSettings, IconStar, IconTrash, IconUpload, IconPackage,
} from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, PageHeader, QueryState } from "../../components/common";
import { del, post, put } from "../../lib/api";
import { ago, fileToB64 } from "../../lib/format";
import { notifyError } from "../../lib/hooks";
import { usePackages, useGlobalRole } from "../../components/deploy/shared";
import { can } from "../../lib/hooks";
import { PolicyBadge, POLICY_LABEL, useTemplates, type Template, type TemplateSettings } from "../../components/deploy/hubdeploy";

const EMPTY: TemplateSettings = {
  connection: {
    accountNamePattern: "{hub} VPN", publicHost: "", publicPort: 0, pinServerCertificate: true, checkServerCert: true, addDefaultCa: false,
    startup: true, maxConnection: 1, useEncrypt: true, useCompress: false, halfConnection: false, noUdpAcceleration: false, disableQoS: false,
    noRoutingTracking: false, additionalConnectionInterval: 1, connectionDisconnectSpan: 0, numRetry: 4294967295, retryInterval: 15,
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

const PLACEHOLDERS = "Placeholders: {server} {hub} {user}";

function TemplateEditor({ template, opened, onClose, copyFrom }: { template: Template | null; opened: boolean; onClose: () => void; copyFrom?: Template | null }) {
  const qc = useQueryClient();
  const packages = usePackages();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [s, setS] = useState<TemplateSettings>(EMPTY);
  const [overridesText, setOverridesText] = useState("{}");
  const [overridesError, setOverridesError] = useState<string | null>(null);
  useEffect(() => {
    if (!opened) return;
    const src = template ?? copyFrom;
    setName(template ? template.name : copyFrom ? `${copyFrom.name} (copy)` : "");
    setDescription(src?.description ?? "");
    setIsDefault(template?.isDefault ?? false);
    const base = src ? structuredClone(src.settings) : structuredClone(EMPTY);
    if (!template && copyFrom && base.installer.clientConfigPassword === "********") delete base.installer.clientConfigPassword;
    setS(base);
    setOverridesText(JSON.stringify(base.client.stringOverrides ?? {}, null, 2));
    setOverridesError(null);
  }, [opened, template, copyFrom]);

  const set = <K extends keyof TemplateSettings>(k: K, patch: Partial<TemplateSettings[K]>) => setS((x) => ({ ...x, [k]: { ...x[k], ...patch } }));
  const save = useMutation({
    mutationFn: () => {
      const body = { name, description, isDefault, settings: s };
      return template ? put(`/api/deploy/templates/${template.id}`, body) : post("/api/deploy/templates", body);
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["deploy"] }); onClose(); },
    onError: (e) => notifyError(e, "Save failed"),
  });
  const c = s.connection, cr = s.credentials, ins = s.installer, b = s.branding, ex = s.setupExe, cl = s.client;
  const iconSrc = b.iconIco ? `data:image/x-icon;base64,${b.iconIco}` : null;

  return (
    <Drawer opened={opened} onClose={onClose} title={template ? `Edit template: ${template.name}` : "New template"} position="right" size="xl" data-testid="template-editor">
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="Name" required value={name} onChange={(e) => setName(e.currentTarget.value)} data-testid="template-name" />
          <Switch label="Default template (used by hubs without an explicit template)" checked={isDefault} onChange={(e) => setIsDefault(e.currentTarget.checked)} mt={28} disabled={template?.isDefault} />
        </SimpleGrid>
        <Textarea label="Description" autosize minRows={1} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        <Tabs defaultValue="connection" keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="connection" leftSection={<IconPlug size={14} />}>Connection</Tabs.Tab>
            <Tabs.Tab value="credentials" leftSection={<IconKey size={14} />}>Credentials</Tabs.Tab>
            <Tabs.Tab value="installer" leftSection={<IconSettings size={14} />}>Installer</Tabs.Tab>
            <Tabs.Tab value="branding" leftSection={<IconPalette size={14} />}>MSI branding</Tabs.Tab>
            <Tabs.Tab value="exe" leftSection={<IconBrandWindows size={14} />}>setup.exe</Tabs.Tab>
            <Tabs.Tab value="client" leftSection={<IconPackage size={14} />}>Client branding</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="connection" pt="md">
            <Stack>
              <TextInput label="Connection name pattern" description={`Shown in the VPN client. ${PLACEHOLDERS}`} value={c.accountNamePattern}
                onChange={(e) => set("connection", { accountNamePattern: e.currentTarget.value })} data-testid="tpl-account-pattern" />
              <SimpleGrid cols={2}>
                <TextInput label="Default public host" description="Empty = the server's address in the manager (hubs can override)" value={c.publicHost}
                  onChange={(e) => set("connection", { publicHost: e.currentTarget.value })} />
                <NumberInput label="Default public port" description="0 = the server's management port" min={0} max={65535} value={c.publicPort}
                  onChange={(v) => set("connection", { publicPort: Number(v) || 0 })} allowDecimal={false} />
              </SimpleGrid>
              <SimpleGrid cols={2}>
                <Switch label="Pin the server certificate" description="Embeds the server's certificate so the client trusts only it" checked={c.pinServerCertificate} onChange={(e) => set("connection", { pinServerCertificate: e.currentTarget.checked })} />
                <Switch label="Verify server certificate" checked={c.checkServerCert} onChange={(e) => set("connection", { checkServerCert: e.currentTarget.checked })} />
                <Switch label="Also trust the system CA store" checked={c.addDefaultCa} onChange={(e) => set("connection", { addDefaultCa: e.currentTarget.checked })} />
                <Switch label="Connect automatically at startup" checked={c.startup} onChange={(e) => set("connection", { startup: e.currentTarget.checked })} />
                <Switch label="Encrypt (SSL)" checked={c.useEncrypt} onChange={(e) => set("connection", { useEncrypt: e.currentTarget.checked })} />
                <Switch label="Compress" checked={c.useCompress} onChange={(e) => set("connection", { useCompress: e.currentTarget.checked })} />
                <Switch label="Half-duplex connections" checked={c.halfConnection} onChange={(e) => set("connection", { halfConnection: e.currentTarget.checked })} />
                <Switch label="Disable UDP acceleration" checked={c.noUdpAcceleration} onChange={(e) => set("connection", { noUdpAcceleration: e.currentTarget.checked })} />
                <Switch label="Disable QoS" checked={c.disableQoS} onChange={(e) => set("connection", { disableQoS: e.currentTarget.checked })} />
                <Switch label="No routing-table adjustment" checked={c.noRoutingTracking} onChange={(e) => set("connection", { noRoutingTracking: e.currentTarget.checked })} />
                <Switch label="Hide connection status window" checked={c.hideStatusWindow} onChange={(e) => set("connection", { hideStatusWindow: e.currentTarget.checked })} />
                <Switch label="Hide adapter info window" checked={c.hideNicInfoWindow} onChange={(e) => set("connection", { hideNicInfoWindow: e.currentTarget.checked })} />
              </SimpleGrid>
              <SimpleGrid cols={3}>
                <NumberInput label="TCP connections" min={1} max={32} value={c.maxConnection} onChange={(v) => set("connection", { maxConnection: Number(v) || 1 })} allowDecimal={false} />
                <NumberInput label="Retry interval (s)" min={5} max={3600} value={c.retryInterval} onChange={(v) => set("connection", { retryInterval: Number(v) || 15 })} allowDecimal={false} />
                <NumberInput label="Retries" description="4294967295 = forever" min={0} max={4294967295} value={c.numRetry} onChange={(v) => set("connection", { numRetry: Number(v) || 0 })} allowDecimal={false} />
                <NumberInput label="Additional connection interval (s)" min={1} max={3600} value={c.additionalConnectionInterval} onChange={(v) => set("connection", { additionalConnectionInterval: Number(v) || 1 })} allowDecimal={false} />
                <NumberInput label="Connection life (s)" description="0 = unlimited" min={0} value={c.connectionDisconnectSpan} onChange={(v) => set("connection", { connectionDisconnectSpan: Number(v) || 0 })} allowDecimal={false} />
              </SimpleGrid>
              <SimpleGrid cols={4}>
                <Select label="Proxy" data={[{ value: "direct", label: "Direct" }, { value: "http", label: "HTTP" }, { value: "socks4", label: "SOCKS4" }, { value: "socks5", label: "SOCKS5" }]}
                  value={c.proxyType} onChange={(v) => set("connection", { proxyType: (v ?? "direct") as TemplateSettings["connection"]["proxyType"] })} allowDeselect={false} />
                <TextInput label="Proxy host" value={c.proxyHost} disabled={c.proxyType === "direct"} onChange={(e) => set("connection", { proxyHost: e.currentTarget.value })} />
                <NumberInput label="Proxy port" min={0} max={65535} value={c.proxyPort} disabled={c.proxyType === "direct"} onChange={(v) => set("connection", { proxyPort: Number(v) || 0 })} allowDecimal={false} />
                <TextInput label="Proxy user" value={c.proxyUsername} disabled={c.proxyType === "direct"} onChange={(e) => set("connection", { proxyUsername: e.currentTarget.value })} />
              </SimpleGrid>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="credentials" pt="md">
            <Stack>
              <Radio.Group label="Password users" description="What a per-user package contains for users with password authentication" value={cr.passwordUsers}
                onChange={(v) => set("credentials", { passwordUsers: v as TemplateSettings["credentials"]["passwordUsers"] })} data-testid="tpl-policy">
                <Stack mt="xs" gap="sm">
                  {(["embed-hash", "rotate", "install-time", "prompt"] as const).map((p) => (
                    <Radio key={p} value={p} label={<Group gap={6}><PolicyBadge value={p} /></Group>} description={POLICY_LABEL[p].help} />
                  ))}
                </Stack>
              </Radio.Group>
              {cr.passwordUsers === "rotate" && (
                <NumberInput label="Generated password length" min={12} max={64} value={cr.rotateLength} onChange={(v) => set("credentials", { rotateLength: Number(v) || 20 })} allowDecimal={false} w={240} />
              )}
              <Alert color="gray" variant="light">RADIUS / NT-domain users always get "user enters" (or "at install"). Certificate users need their own certificate and key and are not generated automatically.</Alert>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="installer" pt="md">
            <Stack>
              <SimpleGrid cols={2}>
                <TextInput label="Product name" description={PLACEHOLDERS} value={ins.productName} onChange={(e) => set("installer", { productName: e.currentTarget.value })} data-testid="tpl-product-name" />
                <TextInput label="Manufacturer / publisher" value={ins.manufacturer} onChange={(e) => set("installer", { manufacturer: e.currentTarget.value })} />
                <TextInput label="Base version (major.minor)" description="Build number increments automatically per hub" value={ins.baseVersion} onChange={(e) => set("installer", { baseVersion: e.currentTarget.value })} />
                <TextInput label="Install folder (under Program Files)" value={ins.installFolder} onChange={(e) => set("installer", { installFolder: e.currentTarget.value })} />
                <Select label="Client package" description="Empty = newest package for the architecture" clearable
                  data={(packages.data ?? []).map((p) => ({ value: String(p.id), label: `#${p.id} ${p.filename} (${p.edition} ${p.arch}${p.version ? ` ${p.version}` : ""})` }))}
                  value={ins.packageId ? String(ins.packageId) : null} onChange={(v) => set("installer", { packageId: v ? Number(v) : null })} />
                <Select label="Architecture" data={["x64", "x86"]} value={ins.arch} onChange={(v) => set("installer", { arch: (v ?? "x64") as "x64" | "x86" })} allowDeselect={false} />
                <TextInput label="Virtual adapter name" description="VPN, VPN2 … VPN127" value={ins.nicName} onChange={(e) => set("installer", { nicName: e.currentTarget.value })} />
                <NumberInput label="Configure timeout (s)" min={30} max={1800} value={ins.configureTimeoutSec} onChange={(v) => set("installer", { configureTimeoutSec: Number(v) || 300 })} allowDecimal={false} />
              </SimpleGrid>
              <SimpleGrid cols={2}>
                <Switch label="Connect right after installation" checked={ins.connectAfterInstall} onChange={(e) => set("installer", { connectAfterInstall: e.currentTarget.checked })} />
                <Switch label="Delete the profile file after import" checked={ins.deleteProfileAfterImport} onChange={(e) => set("installer", { deleteProfileAfterImport: e.currentTarget.checked })} />
                <Switch label="Start-menu shortcut" checked={ins.startMenuShortcut} onChange={(e) => set("installer", { startMenuShortcut: e.currentTarget.checked })} />
                <Switch label="Run UI helper at logon" checked={ins.uiHelperAtLogon} onChange={(e) => set("installer", { uiHelperAtLogon: e.currentTarget.checked })} />
                <Switch label="Keep connection on upgrade" checked={ins.preserveOnUpgrade} onChange={(e) => set("installer", { preserveOnUpgrade: e.currentTarget.checked })} />
              </SimpleGrid>
              <PasswordInput label="Client configuration password" description="Locks the local client settings so users cannot change or remove the connection (optional)"
                value={ins.clientConfigPassword ?? ""} onChange={(e) => set("installer", { clientConfigPassword: e.currentTarget.value || undefined })} autoComplete="new-password" w={360} />
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="branding" pt="md">
            <Stack>
              <Group align="flex-end">
                {iconSrc ? <Image src={iconSrc} w={48} h={48} alt="Icon preview" data-testid="tpl-icon-preview" /> : <Text size="sm" c="dimmed">No icon (defaults are used)</Text>}
                <FileButton accept=".ico,image/x-icon,image/vnd.microsoft.icon" onChange={async (f) => {
                  if (!f) return;
                  const b64 = await fileToB64(f);
                  const bin = atob(b64.slice(0, 8));
                  if (bin.charCodeAt(0) !== 0 || bin.charCodeAt(2) !== 1) { notifyError(new Error("Choose a Windows .ico file (multi-size, 256×256 recommended)")); return; }
                  set("branding", { iconIco: b64 });
                }}>
                  {(p) => <Button {...p} variant="light" leftSection={<IconUpload size={16} />} data-testid="tpl-icon-upload">Upload .ico</Button>}
                </FileButton>
                {b.iconIco && <Button variant="subtle" color="red" onClick={() => set("branding", { iconIco: null })}>Remove</Button>}
              </Group>
              <Text size="xs" c="dimmed">Used for Add/Remove Programs, the Start-menu shortcut, setup.exe and (if enabled) the client executables.</Text>
              <SimpleGrid cols={2}>
                <TextInput label="Support / help link" placeholder="https://support.example.com/vpn" value={b.arpHelpLink} onChange={(e) => set("branding", { arpHelpLink: e.currentTarget.value })} />
                <TextInput label="Publisher web site" value={b.arpUrlInfoAbout} onChange={(e) => set("branding", { arpUrlInfoAbout: e.currentTarget.value })} />
                <TextInput label="Support contact" value={b.arpContact} onChange={(e) => set("branding", { arpContact: e.currentTarget.value })} />
                <TextInput label="Support telephone" value={b.arpHelpTelephone} onChange={(e) => set("branding", { arpHelpTelephone: e.currentTarget.value })} />
                <TextInput label="Start-menu folder" description={`Empty = product name. ${PLACEHOLDERS}`} value={b.startMenuFolder} onChange={(e) => set("branding", { startMenuFolder: e.currentTarget.value })} />
                <TextInput label="Shortcut name" value={b.shortcutName} onChange={(e) => set("branding", { shortcutName: e.currentTarget.value })} />
                <TextInput label="Windows service display name" description="Empty = SoftEther default" value={b.serviceDisplayName} onChange={(e) => set("branding", { serviceDisplayName: e.currentTarget.value })} />
                <TextInput label="Windows service description" value={b.serviceDescription} onChange={(e) => set("branding", { serviceDescription: e.currentTarget.value })} />
              </SimpleGrid>
              <Textarea label="Comments (Add/Remove Programs)" value={b.arpComments} onChange={(e) => set("branding", { arpComments: e.currentTarget.value })} />
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="exe" pt="md">
            <Stack>
              <Text size="sm" c="dimmed">setup.exe wraps the MSI for users who install it themselves (double-click). It shows your icon and details in Explorer and supports /quiet, /passive, /log &lt;file&gt;, /uninstall and NAME=value properties.</Text>
              <SimpleGrid cols={2}>
                <TextInput label="Company name" description="Empty = manufacturer" value={ex.companyName} onChange={(e) => set("setupExe", { companyName: e.currentTarget.value })} />
                <TextInput label="Product name" description={PLACEHOLDERS} value={ex.productName} onChange={(e) => set("setupExe", { productName: e.currentTarget.value })} />
                <TextInput label="File description" value={ex.fileDescription} onChange={(e) => set("setupExe", { fileDescription: e.currentTarget.value })} />
                <TextInput label="Copyright" value={ex.copyright} onChange={(e) => set("setupExe", { copyright: e.currentTarget.value })} />
                <TextInput label="File name pattern" description={`${PLACEHOLDERS}; version and extension are appended`} value={ex.fileNamePattern} onChange={(e) => set("setupExe", { fileNamePattern: e.currentTarget.value })} />
                <Select label="Installer UI" data={[{ value: "basic", label: "Progress bar only" }, { value: "full", label: "Full wizard" }]} value={ex.ui}
                  onChange={(v) => set("setupExe", { ui: (v ?? "basic") as "basic" | "full" })} allowDeselect={false} />
              </SimpleGrid>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="client" pt="md">
            <Stack>
              <Text size="sm" c="dimmed">Everything SoftEther lets us change without rebuilding it: the product names in its user interface (from its string tables) and, optionally, the icon and version details of vpnclient.exe / vpncmgr.exe.</Text>
              <SimpleGrid cols={2}>
                <TextInput label="Client display name" description="Window titles, tray and service names (e.g. Contoso VPN)" value={cl.displayName} onChange={(e) => set("client", { displayName: e.currentTarget.value })} data-testid="tpl-client-name" />
                <TextInput label="Client Manager name" description="Title of the connection manager window" value={cl.managerName} onChange={(e) => set("client", { managerName: e.currentTarget.value })} />
              </SimpleGrid>
              <Switch label="Brand the client executables (icon and version details)" checked={cl.brandBinaries} onChange={(e) => set("client", { brandBinaries: e.currentTarget.checked })}
                description="Changes vpnclient.exe and vpncmgr.exe resources. Any code signature on them becomes invalid (SoftEther's own builds are unsigned)." />
              <JsonInput label="Advanced: string-table overrides" description="SoftEther string keys (from strtable_en.stb) and replacement texts, e.g. { &quot;CM_PRODUCT_NAME&quot;: &quot;Contoso VPN Build %u&quot; }. Unknown keys are reported in the build log."
                value={overridesText} autosize minRows={3} maxRows={12} formatOnBlur error={overridesError}
                onChange={(v) => {
                  setOverridesText(v);
                  try {
                    const o = JSON.parse(v || "{}");
                    if (typeof o !== "object" || Array.isArray(o) || Object.entries(o).some(([k, x]) => !/^[A-Z0-9_]{2,80}$/.test(k) || typeof x !== "string")) throw new Error("Keys must be UPPER_CASE string-table names with text values");
                    set("client", { stringOverrides: o }); setOverridesError(null);
                  } catch (e) { setOverridesError((e as Error).message); }
                }} />
            </Stack>
          </Tabs.Panel>
        </Tabs>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name.trim() || !!overridesError} data-testid="template-save">Save template</Button>
        </Group>
      </Stack>
    </Drawer>
  );
}

export default function TemplatesPage() {
  const role = useGlobalRole();
  const canWrite = can(role, "operator");
  const templates = useTemplates();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Template | null | "new">(null);
  const [copyFrom, setCopyFrom] = useState<Template | null>(null);
  const makeDefault = useMutation({
    mutationFn: (t: Template) => put(`/api/deploy/templates/${t.id}`, { name: t.name, description: t.description, isDefault: true, settings: t.settings }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["deploy"] }),
    onError: (e) => notifyError(e),
  });
  return (
    <>
      <PageHeader title="Deployment templates"
        description="Reusable settings for client packages: connection options, how credentials are delivered, installer behaviour and branding (MSI, setup.exe and the VPN client). Hubs use the default template unless you pick another one on the hub's Client deployment page."
        actions={canWrite && <Button leftSection={<IconPlus size={16} />} onClick={() => { setCopyFrom(null); setEditing("new"); }} data-testid="create-template">New template</Button>} />
      <QueryState query={templates}>
        <DataTable<Template>
          testId="templates-table"
          data={templates.data}
          rowKey={(t) => t.id}
          onRowClick={canWrite ? (t) => { setCopyFrom(null); setEditing(t); } : undefined}
          columns={[
            {
              key: "name", title: "Template", render: (t) => (
                <Group gap="xs" wrap="nowrap">
                  {t.settings.branding.iconIco && <Image src={`data:image/x-icon;base64,${t.settings.branding.iconIco}`} w={20} h={20} alt="" />}
                  <div><Text fw={600} size="sm">{t.name}</Text>{t.description && <Text size="xs" c="dimmed" lineClamp={1}>{t.description}</Text>}</div>
                  {t.isDefault && <Badge size="xs" variant="filled">default</Badge>}
                </Group>
              ),
            },
            { key: "product", title: "Product", value: (t) => t.settings.installer.productName, render: (t) => <Text size="sm">{t.settings.installer.productName}</Text> },
            { key: "policy", title: "Password users", value: (t) => t.settings.credentials.passwordUsers, render: (t) => <PolicyBadge value={t.settings.credentials.passwordUsers} /> },
            { key: "client", title: "Client branding", value: (t) => t.settings.client.displayName, render: (t) => t.settings.client.displayName || <Text size="sm" c="dimmed">SoftEther defaults</Text> },
            { key: "updatedAt", title: "Updated", render: (t) => ago(t.updatedAt) },
            {
              key: "actions", title: "", sortable: false, align: "right", render: (t) => canWrite && (
                <Group gap={4} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                  <Tooltip label="Edit"><ActionIcon variant="subtle" onClick={() => { setCopyFrom(null); setEditing(t); }} aria-label={`Edit ${t.name}`}><IconEdit size={16} /></ActionIcon></Tooltip>
                  <Tooltip label="Duplicate"><ActionIcon variant="subtle" onClick={() => { setCopyFrom(t); setEditing("new"); }} aria-label={`Duplicate ${t.name}`}><IconCopy size={16} /></ActionIcon></Tooltip>
                  {!t.isDefault && <Tooltip label="Make default"><ActionIcon variant="subtle" onClick={() => makeDefault.mutate(t)} aria-label={`Make ${t.name} default`}><IconStar size={16} /></ActionIcon></Tooltip>}
                  {!t.isDefault && (
                    <ConfirmButton title={`Delete template ${t.name}?`} message="Hubs using it fall back to the default template." size="xs" variant="subtle"
                      onConfirm={async () => { await del(`/api/deploy/templates/${t.id}`); void qc.invalidateQueries({ queryKey: ["deploy"] }); }}
                      leftSection={<IconTrash size={14} />}>Delete</ConfirmButton>
                  )}
                </Group>
              ),
            },
          ]}
        />
      </QueryState>
      <TemplateEditor opened={editing !== null} template={editing === "new" ? null : editing} copyFrom={copyFrom} onClose={() => setEditing(null)} />
    </>
  );
}
