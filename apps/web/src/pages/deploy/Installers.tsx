import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Anchor, Badge, Button, Checkbox, Code, Divider, Fieldset, Group, List, Modal, NumberInput, PasswordInput, Radio, ScrollArea, Select,
  SimpleGrid, Stack, Stepper, Switch, Table, Tabs, Text, TextInput, Title, Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconAlertTriangle, IconCheck, IconDownload, IconFileText, IconHammer, IconInfoCircle, IconPlus, IconRefresh, IconRocket, IconTrash, IconX,
} from "@tabler/icons-react";
import { Link } from "react-router";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, Copyable, PageHeader, QueryState, ReadOnlyNotice } from "../../components/common";
import { ApiError, del, download, post } from "../../lib/api";
import { can, notifyError } from "../../lib/hooks";
import { ago, bytes, downloadText, dt } from "../../lib/format";
import {
  AuthBadge, CRED_LABEL, NIC_OPTIONS, NIC_RE, UUID_RE, VERSION_RE, bumpVersion, deployKeys, productCodeOf, useDeployStatus, useGlobalRole,
  useInstallers, usePackages, useProfiles, type CredentialMode, type InstallerBuild, type MsiOptions, type Profile,
} from "../../components/deploy/shared";

const DEFAULT_OPTIONS: MsiOptions = {
  productName: "SoftEther VPN Client (Managed)",
  manufacturer: "IT Department",
  productVersion: "1.0.0",
  upgradeCode: undefined,
  installFolder: "SoftEther VPN Client Managed",
  connectAfterInstall: true,
  deleteProfileAfterImport: true,
  startMenuShortcut: true,
  uiHelperAtLogon: true,
  credentialMode: "embedded",
  clientConfigPassword: undefined,
  preserveOnUpgrade: true,
  configureTimeoutSec: 300,
  nicName: "VPN",
};

const CRED_HELP: Record<CredentialMode, ReactNode> = {
  embedded: <>The credential stored in each profile (password hash or client certificate) is baked into the MSI. One installer per user, or a shared account. Anyone with the MSI can extract it — treat the file as a secret.</>,
  "install-time": <>The MSI contains no password. Pass it on the command line: <Code>msiexec /i file.msi /qn VPNUSERNAME=jdoe VPNPASSWORD=…</Code>. The values are hidden from MSI logs (MsiHiddenProperties), handed to the configuration script via a short-lived HKLM value that is deleted immediately, and applied with <Code>AccountUsernameSet</Code> / <Code>AccountPasswordSet</Code>. Required for RADIUS / NT-domain passwords. One MSI can serve all users.</>,
  none: <>Passwords are stripped from password-auth profiles. Users enter their password in the VPN Client Manager on first connect (keep the Start-menu shortcut on). Certificate profiles still carry their key.</>,
};

const fileNameOf = (b: Pick<InstallerBuild, "name" | "productVersion">) => `${b.name.replace(/[^\w.-]+/g, "_")}-${b.productVersion}.msi`;

function StatusBadge({ status }: { status: string }) {
  if (status === "ready") return <Badge color="green" variant="light" leftSection={<IconCheck size={12} />}>Ready</Badge>;
  if (status === "failed") return <Badge color="red" variant="light" leftSection={<IconX size={12} />}>Failed</Badge>;
  if (status === "building") return <Badge color="yellow" variant="light">Building</Badge>;
  return <Badge color="gray" variant="light">{status}</Badge>;
}

// ---------------------------------------------------------------------------------------------
// Build log / tables

function splitLog(log: string): { title: string; body: string }[] {
  const parts = log.split(/\n== (\w+)\n/);
  const out = [{ title: "Build output", body: parts[0].trim() }];
  for (let i = 1; i < parts.length; i += 2) out.push({ title: parts[i], body: (parts[i + 1] ?? "").trim() });
  return out;
}

function LogModal({ build, onClose }: { build: InstallerBuild | null; onClose: () => void }) {
  const sections = useMemo(() => (build ? splitLog(build.log ?? "") : []), [build]);
  return (
    <Modal opened={!!build} onClose={onClose} size="90%" title={build ? `Build log — ${build.name} ${build.productVersion}` : ""} data-testid="build-log">
      {build && (
        <Stack>
          <Group justify="space-between">
            <Group gap="xs"><StatusBadge status={build.status} />{productCodeOf(build.log) && <><Text size="sm" c="dimmed">ProductCode</Text><Copyable value={productCodeOf(build.log)!} /></>}</Group>
            <Button size="xs" variant="light" leftSection={<IconDownload size={14} />} onClick={() => downloadText(`${fileNameOf(build)}.log.txt`, build.log)}>Save log</Button>
          </Group>
          {sections.length > 1 ? (
            <Tabs defaultValue="Build output" keepMounted={false}>
              <Tabs.List>{sections.map((s) => <Tabs.Tab key={s.title} value={s.title}>{s.title}</Tabs.Tab>)}</Tabs.List>
              {sections.map((s) => (
                <Tabs.Panel key={s.title} value={s.title} pt="sm">
                  {s.title === "Build output" ? <LogText text={s.body} /> : <MsiTable text={s.body} />}
                </Tabs.Panel>
              ))}
            </Tabs>
          ) : <LogText text={build.log || "(empty)"} />}
        </Stack>
      )}
    </Modal>
  );
}

function LogText({ text }: { text: string }) {
  return (
    <ScrollArea.Autosize mah="65vh" type="auto">
      <Code block style={{ whiteSpace: "pre", fontSize: 12 }}>{text}</Code>
    </ScrollArea.Autosize>
  );
}

/** msiinfo export format: header row, type row, key row, then tab-separated records. */
function MsiTable({ text }: { text: string }) {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 3 || !lines[0].includes("\t")) return <LogText text={text} />;
  const head = lines[0].split("\t");
  const rows = lines.slice(3).map((l) => l.split("\t"));
  return (
    <ScrollArea.Autosize mah="65vh" type="auto">
      <Table striped withTableBorder fz="xs" verticalSpacing={2}>
        <Table.Thead><Table.Tr>{head.map((h, i) => <Table.Th key={i}>{h}</Table.Th>)}</Table.Tr></Table.Thead>
        <Table.Tbody>
          {rows.map((r, i) => (
            <Table.Tr key={i}>{head.map((_, j) => <Table.Td key={j} style={{ fontFamily: "monospace", wordBreak: "break-all" }}>{r[j]}</Table.Td>)}</Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea.Autosize>
  );
}

// ---------------------------------------------------------------------------------------------
// Deployment instructions

function Cmd({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div>
      <Text size="sm" fw={500} mb={2}>{label}</Text>
      <Copyable value={value} />
    </div>
  );
}

function InstructionsModal({ build, onClose }: { build: InstallerBuild | null; onClose: () => void }) {
  if (!build) return <Modal opened={false} onClose={onClose}>{null}</Modal>;
  const file = fileNameOf(build);
  const pc = productCodeOf(build.log);
  const creds = build.options.credentialMode === "install-time" ? ` VPNUSERNAME="jdoe" VPNPASSWORD="<password>"` : "";
  const install = `msiexec /i "${file}" /qn /norestart /l*v "%TEMP%\\${build.name.replace(/[^\w.-]+/g, "_")}-install.log"${creds}`;
  const uninstallPc = pc ? `msiexec /x ${pc} /qn /norestart /l*v "%TEMP%\\${build.name.replace(/[^\w.-]+/g, "_")}-uninstall.log"` : null;
  const uninstallFile = `msiexec /x "${file}" /qn /norestart`;
  const x86 = /wixl -a x86 /.test(build.log ?? "");
  const installDir = `C:\\Program Files${x86 ? " (x86)" : ""}\\${build.options.installFolder}`;
  return (
    <Modal opened onClose={onClose} size="xl" title={`Deploy ${build.name} ${build.productVersion}`} data-testid="deploy-instructions">
      <Stack gap="md">
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <div><Text size="xs" c="dimmed">File</Text><Copyable value={file} /></div>
          <div><Text size="xs" c="dimmed">SHA-256</Text>{build.sha256 ? <Copyable value={build.sha256} /> : "–"}</div>
          <div><Text size="xs" c="dimmed">ProductCode (changes every build)</Text>{pc ? <Copyable value={pc} /> : <Text size="sm">See the Property table in the build log</Text>}</div>
          <div><Text size="xs" c="dimmed">UpgradeCode (stable across versions)</Text><Copyable value={`{${build.upgradeCode}}`} /></div>
        </SimpleGrid>

        <Title order={5}>Command line (elevated)</Title>
        <Cmd label="Silent install" value={install} />
        {build.options.credentialMode === "install-time" && (
          <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
            Replace <Code>jdoe</Code> / <Code>&lt;password&gt;</Code> per user. The password is hidden from the MSI log, but it is visible in the process command line
            and in your deployment tool's configuration; restrict who can read those.
          </Alert>
        )}
        {uninstallPc && <Cmd label="Silent uninstall (by product code)" value={uninstallPc} />}
        <Cmd label="Silent uninstall (with the MSI file)" value={uninstallFile} />
        <Text size="sm" c="dimmed">
          Run as SYSTEM or from an elevated prompt: the per-machine install creates a service and a virtual network adapter, so a non-elevated
          <Code>/qn</Code> run fails with 1603. Success exit codes: 0, 3010 (reboot required), 1641. A newer version with the same name upgrades in place
          {build.options.preserveOnUpgrade ? " and keeps the existing VPN account." : " (the VPN account and adapter are removed and recreated)."}
        </Text>

        <Divider />
        <Title order={5}>Microsoft Intune (Win32 app)</Title>
        <List size="sm" spacing={4}>
          <List.Item>Wrap the file: <Code>IntuneWinAppUtil.exe -c &lt;folder&gt; -s {file} -o &lt;out&gt;</Code> and upload the <Code>.intunewin</Code>.</List.Item>
          <List.Item>Install command: <Code>msiexec /i "{file}" /qn{creds}</Code>; Uninstall command: <Code>{pc ? `msiexec /x ${pc} /qn` : `msiexec /x "${file}" /qn`}</Code>.</List.Item>
          <List.Item>Install behavior: <b>System</b>; device restart behavior: “Determine behavior based on return codes”.</List.Item>
          <List.Item>Detection rule: <b>MSI</b>, product code <Code>{pc ?? "{ProductCode from the build log Property table}"}</Code>{" "}
            (optionally “MSI product version check: Greater than or equal to {build.productVersion}”). Intune usually fills this in automatically from the MSI.</List.Item>
          <List.Item>Assign to <b>devices</b>. {build.options.credentialMode === "embedded" ? "Embedded credentials are the same on every device that receives this app." : build.options.credentialMode === "install-time" ? "Per-user install-time credentials need one app per user or a scripted wrapper; embedded or 'none' mode is simpler in Intune." : "Users enter their password in the VPN Client Manager."}</List.Item>
        </List>

        <Title order={5}>Group Policy software installation</Title>
        <List size="sm" spacing={4}>
          <List.Item>Copy the MSI to a share readable by Domain Computers, e.g. <Code>\\fileserver\deploy$\{file}</Code>.</List.Item>
          <List.Item>Computer Configuration → Policies → Software Settings → Software installation → New → Package (UNC path) → <b>Assigned</b>. It installs at the next reboot.</List.Item>
          <List.Item>For a new version add the new MSI and set it to upgrade the old package (Upgrades tab), or rely on the shared UpgradeCode.</List.Item>
          <List.Item>GPO cannot pass <Code>VPNUSERNAME</Code>/<Code>VPNPASSWORD</Code>; use the embedded or “none” credential mode.</List.Item>
        </List>

        <Title order={5}>Configuration Manager (SCCM / MECM)</Title>
        <List size="sm" spacing={4}>
          <List.Item>Create an Application with a <b>Windows Installer (*.msi)</b> deployment type; SCCM reads the product code for detection.</List.Item>
          <List.Item>Installation program: <Code>msiexec /i "{file}" /qn{creds}</Code>; uninstall program: <Code>{pc ? `msiexec /x ${pc} /qn` : `msiexec /x "${file}" /qn`}</Code>.</List.Item>
          <List.Item>Installation behavior: <b>Install for system</b>, whether or not a user is logged on.</List.Item>
        </List>

        <Divider />
        <Title order={5}>Troubleshooting</Title>
        <List size="sm" spacing={4}>
          <List.Item>Configuration script log: <Code>C:\ProgramData\SoftEtherManager\configure.log</Code> (uninstall: <Code>unconfigure.log</Code>).</List.Item>
          <List.Item>Windows Installer log: the <Code>/l*v</Code> file from the command line above.</List.Item>
          <List.Item>Client logs: <Code>{installDir}\client_log</Code>. Check the account with <Code>vpncmd localhost /CLIENT /CMD AccountList</Code>.</List.Item>
          <List.Item>Exit code 1460 means the configuration step exceeded its {build.options.configureTimeoutSec}s timeout (typically a blocked driver install).</List.Item>
        </List>
      </Stack>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// New installer wizard

interface WizardSeed { name: string; packageId: string | null; profileIds: string[]; options: MsiOptions }

function credentialIssues(p: Profile, mode: CredentialMode): { level: "warn" | "info"; text: string }[] {
  const s = p.settings;
  const out: { level: "warn" | "info"; text: string }[] = [];
  if (mode === "embedded") {
    if (s.authType === "password" && !s.hasPassword) out.push({ level: "warn", text: "no password stored — the embedded hash is of an empty password" });
    if (s.authType === "radius") out.push({ level: "warn", text: "RADIUS/NT passwords cannot be embedded; use install-time credentials" });
    if (s.authType === "password" && s.hasPassword) out.push({ level: "info", text: "password hash embedded (password-equivalent)" });
  }
  if (mode === "install-time") {
    if (s.authType === "anonymous" || s.authType === "certificate") out.push({ level: "info", text: `${s.authType} auth: VPNPASSWORD is not used` });
  }
  if (mode === "none" && s.authType === "password") out.push({ level: "info", text: "password removed; the user enters it" });
  if (s.authType === "certificate") out.push({ level: "info", text: "client private key embedded" });
  return out;
}

function NewInstallerWizard({ opened, onClose, seed, onBuilt }: {
  opened: boolean; onClose: () => void; seed: WizardSeed | null; onBuilt: (b: InstallerBuild) => void;
}) {
  const qc = useQueryClient();
  const packages = usePackages();
  const profiles = useProfiles();
  const builds = useInstallers();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [packageId, setPackageId] = useState<string | null>(null);
  const [profileIds, setProfileIds] = useState<string[]>([]);
  const [o, setO] = useState<MsiOptions>(DEFAULT_OPTIONS);
  const [versionTouched, setVersionTouched] = useState(false);
  const [confirmPw, setConfirmPw] = useState("");
  const [result, setResult] = useState<InstallerBuild | null>(null);

  useEffect(() => {
    if (!opened) return;
    setStep(0); setResult(null); setConfirmPw("");
    setName(seed?.name ?? ""); setPackageId(seed?.packageId ?? null); setProfileIds(seed?.profileIds ?? []);
    setO(seed?.options ?? DEFAULT_OPTIONS); setVersionTouched(!!seed);
  }, [opened, seed]);

  const set = <K extends keyof MsiOptions>(k: K, v: MsiOptions[K]) => setO((cur) => ({ ...cur, [k]: v }));

  // Builds sharing this name: suggest the next version and show the reused upgrade code.
  const previous = useMemo(() => (builds.data ?? []).filter((b) => b.name === name.trim()).sort((a, b) => b.createdAt - a.createdAt)[0], [builds.data, name]);
  useEffect(() => {
    if (versionTouched) return;
    setO((cur) => ({ ...cur, productVersion: previous ? bumpVersion(previous.productVersion) : "1.0.0" }));
  }, [previous?.id, versionTouched]);

  // Default package: newest one
  useEffect(() => {
    if (opened && !packageId && packages.data?.length) setPackageId(String(packages.data[0].id));
  }, [opened, packages.data]);

  const pkg = packages.data?.find((p) => String(p.id) === packageId);
  const selected = profileIds.map((id) => profiles.data?.find((p) => String(p.id) === id)).filter((p): p is Profile => !!p);
  const dupes = selected.map((p) => p.settings.accountName.toLowerCase()).filter((n, i, a) => a.indexOf(n) !== i);

  const stepErrors: string[][] = [
    [
      !name.trim() ? "Enter an installer name" : "",
      !pkg ? "Choose a client package" : "",
    ].filter(Boolean),
    [
      selected.length === 0 ? "Select at least one profile" : "",
      selected.length > 16 ? "At most 16 profiles" : "",
      dupes.length ? `Account names must be distinct (duplicate: ${[...new Set(dupes)].join(", ")})` : "",
    ].filter(Boolean),
    [
      !o.productName.trim() ? "Product name is required" : "",
      !o.manufacturer.trim() ? "Manufacturer is required" : "",
      !VERSION_RE.test(o.productVersion) ? "Version must look like 1.0.0 (major ≤ 255 recommended)" : "",
      !o.installFolder.trim() || /[\\/:*?"<>|]/.test(o.installFolder) ? "Install folder must be a single folder name without \\ / : * ? \" < > |" : "",
      !NIC_RE.test(o.nicName) ? "Adapter name must be VPN … VPN127" : "",
      !(o.configureTimeoutSec >= 30 && o.configureTimeoutSec <= 1800) ? "Configuration timeout must be 30 – 1800 seconds" : "",
      o.upgradeCode && !UUID_RE.test(o.upgradeCode) ? "Upgrade code must be a GUID" : "",
      o.clientConfigPassword && o.clientConfigPassword !== confirmPw ? "Client configuration passwords do not match" : "",
    ].filter(Boolean),
    [],
  ];
  const firstBad = stepErrors.findIndex((e) => e.length > 0);

  const build = useMutation({
    mutationFn: () => post<InstallerBuild>("/api/deploy/installers", {
      name: name.trim(),
      packageId: Number(packageId),
      profileIds: profileIds.map(Number),
      options: { ...o, upgradeCode: o.upgradeCode?.trim() || undefined, clientConfigPassword: o.clientConfigPassword || undefined },
    }),
    onSuccess: (b) => {
      void qc.invalidateQueries({ queryKey: deployKeys.installers });
      setResult(b);
      if (b.status === "ready") notifications.show({ color: "green", message: `Built ${fileNameOf(b)} (${bytes(b.size)})` });
      else notifications.show({ color: "red", message: "The MSI build failed — see the log", autoClose: 8000 });
    },
    onError: (e) => {
      const issues = e instanceof ApiError && Array.isArray(e.body.issues) ? (e.body.issues as { path: string; message: string }[]) : [];
      notifyError(issues.length ? new Error(issues.map((i) => `${i.path}: ${i.message}`).join("; ")) : e, "Build request rejected");
    },
  });

  const next = () => {
    if (stepErrors[step].length) { notifyError(new Error(stepErrors[step].join("; ")), "Please complete this step"); return; }
    setStep((s) => s + 1);
  };

  const toggle = (id: string, on: boolean) => setProfileIds((cur) => (on ? [...cur, id] : cur.filter((x) => x !== id)));

  return (
    <Modal opened={opened} onClose={onClose} size="xl" title="New MSI installer" data-testid="installer-wizard" closeOnClickOutside={false}>
      {result ? (
        <Stack>
          {result.status === "ready" ? (
            <Alert color="green" icon={<IconCheck size={18} />} title="Installer ready">
              <Text size="sm">{fileNameOf(result)} — {bytes(result.size)}</Text>
              <Group gap={4} mt={4}><Text size="xs" c="dimmed">SHA-256</Text><Copyable value={result.sha256 ?? ""} /></Group>
            </Alert>
          ) : (
            <Alert color="red" icon={<IconX size={18} />} title="Build failed">
              <ScrollArea.Autosize mah={300}><Code block style={{ whiteSpace: "pre-wrap" }}>{result.log}</Code></ScrollArea.Autosize>
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Close</Button>
            {result.status === "ready" && (
              <>
                <Button variant="light" leftSection={<IconRocket size={16} />} onClick={() => { onBuilt(result); onClose(); }}>Deployment instructions</Button>
                <Button leftSection={<IconDownload size={16} />} onClick={() => download(`/api/deploy/installers/${result.id}/download`)} data-testid="wizard-download">Download MSI</Button>
              </>
            )}
            {result.status !== "ready" && <Button onClick={() => { setResult(null); setStep(2); }}>Back to options</Button>}
          </Group>
        </Stack>
      ) : (
        <>
          <Stepper active={step} onStepClick={(i) => { if (i < step || firstBad === -1 || i <= firstBad) setStep(i); }} size="sm" mb="md">
            <Stepper.Step label="Package" description="Name & client files" />
            <Stepper.Step label="Profiles" description="Connections to import" />
            <Stepper.Step label="Options" description="Installer behaviour" />
            <Stepper.Step label="Review" description="Build" />
          </Stepper>

          {step === 0 && (
            <Stack>
              <TextInput label="Installer name" required value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus data-testid="installer-name"
                description="Identifies this installer family. Builds with the same name share an UpgradeCode, so a higher version replaces the previous one in place." />
              {previous && (
                <Alert variant="light" color="blue" icon={<IconInfoCircle size={16} />}>
                  Previous build of “{previous.name}”: version {previous.productVersion} ({dt(previous.createdAt)}). The next version is suggested and the upgrade code
                  <Code>{previous.upgradeCode}</Code> is reused.
                </Alert>
              )}
              <QueryState query={packages}>
                {packages.data?.length ? (
                  <Select label="Client package" required value={packageId} onChange={setPackageId} allowDeselect={false} data-testid="installer-package"
                    data={packages.data.map((p) => ({ value: String(p.id), label: `${p.filename} — ${p.version} · ${p.arch} · ${p.edition === "dev" ? "Developer" : "Stable"}` }))}
                    description="The SoftEther VPN Client binaries to install. The MSI is built for the package's architecture." />
                ) : (
                  <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>No client packages yet. <Anchor component={Link} to="/deploy/packages">Add one first</Anchor>.</Alert>
                )}
              </QueryState>
              {pkg && (
                <Text size="xs" c="dimmed">
                  Files: {pkg.files.map((f) => `${f.name} (${bytes(f.size)})`).join(", ")}
                  {!pkg.files.some((f) => f.name === "vpncmgr.exe") && " — no vpncmgr.exe, so no Start-menu shortcut will be created."}
                </Text>
              )}
            </Stack>
          )}

          {step === 1 && (
            <QueryState query={profiles}>
              {!profiles.data?.length ? (
                <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>No connection profiles yet. <Anchor component={Link} to="/deploy/profiles">Create one first</Anchor>.</Alert>
              ) : (
                <Stack>
                  <Text size="sm" c="dimmed">Each selected profile becomes a VPN account on the client. Account names must be distinct; at most 16.</Text>
                  <ScrollArea.Autosize mah={420}>
                    <Table striped highlightOnHover data-testid="wizard-profiles">
                      <Table.Thead>
                        <Table.Tr><Table.Th w={40} /><Table.Th>Profile</Table.Th><Table.Th>Account name</Table.Th><Table.Th>Server / hub</Table.Th><Table.Th>Auth</Table.Th><Table.Th>Startup</Table.Th></Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {profiles.data.map((p) => {
                          const id = String(p.id);
                          const on = profileIds.includes(id);
                          const clash = on && dupes.includes(p.settings.accountName.toLowerCase());
                          return (
                            <Table.Tr key={p.id} onClick={() => toggle(id, !on)} style={{ cursor: "pointer" }}>
                              <Table.Td><Checkbox checked={on} onChange={(e) => toggle(id, e.currentTarget.checked)} onClick={(e) => e.stopPropagation()} aria-label={`Select ${p.name}`} data-testid={`wizard-profile-${p.id}`} /></Table.Td>
                              <Table.Td><Text size="sm" fw={600}>{p.name}</Text></Table.Td>
                              <Table.Td><Text size="sm" c={clash ? "red" : undefined}>{p.settings.accountName}</Text></Table.Td>
                              <Table.Td><Text size="sm">{p.settings.host}:{p.settings.port} / {p.settings.hub}</Text></Table.Td>
                              <Table.Td><AuthBadge type={p.settings.authType} /></Table.Td>
                              <Table.Td>{p.settings.startup ? "Auto" : "Manual"}</Table.Td>
                            </Table.Tr>
                          );
                        })}
                      </Table.Tbody>
                    </Table>
                  </ScrollArea.Autosize>
                  {stepErrors[1].filter((e) => !e.startsWith("Select")).map((e) => <Alert key={e} color="red" variant="light">{e}</Alert>)}
                  <Text size="xs" c="dimmed">{selected.length} selected. Startup profiles are set to auto-connect; each profile's own adapter setting is replaced by the installer's adapter name.</Text>
                </Stack>
              )}
            </QueryState>
          )}

          {step === 2 && (
            <Stack>
              <Fieldset legend="Product">
                <SimpleGrid cols={{ base: 1, sm: 3 }}>
                  <TextInput label="Product name" required value={o.productName} onChange={(e) => set("productName", e.currentTarget.value)}
                    description="Shown in Apps & Features and as the Start-menu folder." />
                  <TextInput label="Manufacturer" required value={o.manufacturer} onChange={(e) => set("manufacturer", e.currentTarget.value)} description="Publisher shown in Apps & Features." />
                  <TextInput label="Product version" required value={o.productVersion} data-testid="installer-version"
                    onChange={(e) => { setVersionTouched(true); set("productVersion", e.currentTarget.value.trim()); }}
                    error={o.productVersion && !VERSION_RE.test(o.productVersion) ? "Like 1.0.0" : undefined}
                    description={previous ? `Last build: ${previous.productVersion}. Must be higher to upgrade (Windows compares the first three parts).` : "Increase it for every new build you deploy."} />
                </SimpleGrid>
                <SimpleGrid cols={{ base: 1, sm: 2 }} mt="sm">
                  <TextInput label="Install folder" required value={o.installFolder} onChange={(e) => set("installFolder", e.currentTarget.value)}
                    description="Folder under Program Files. Use a folder separate from any vpnsetup-installed client." />
                  <TextInput label="Upgrade code (advanced)" value={o.upgradeCode ?? ""} onChange={(e) => set("upgradeCode", e.currentTarget.value.trim() || undefined)}
                    placeholder={previous?.upgradeCode ?? "Generated automatically"} error={o.upgradeCode && !UUID_RE.test(o.upgradeCode) ? "Must be a GUID" : undefined}
                    description="Leave empty: builds with the same name reuse the previous code. Set it only to take over an existing product family." />
                </SimpleGrid>
              </Fieldset>

              <Fieldset legend="Credentials">
                <Radio.Group value={o.credentialMode} onChange={(v) => set("credentialMode", v as CredentialMode)} data-testid="installer-credential-mode">
                  <Stack gap="sm">
                    {(["embedded", "install-time", "none"] as CredentialMode[]).map((m) => (
                      <Radio key={m} value={m} label={CRED_LABEL[m]} description={CRED_HELP[m]} />
                    ))}
                  </Stack>
                </Radio.Group>
              </Fieldset>

              <Fieldset legend="Behaviour">
                <SimpleGrid cols={{ base: 1, sm: 2 }} verticalSpacing="sm">
                  <Switch label="Connect after install" checked={o.connectAfterInstall} onChange={(e) => set("connectAfterInstall", e.currentTarget.checked)}
                    description="Connect startup profiles immediately instead of waiting for the next service start." />
                  <Switch label="Delete .vpn files after import" checked={o.deleteProfileAfterImport} onChange={(e) => set("deleteProfileAfterImport", e.currentTarget.checked)}
                    description="Remove the profile files from the install folder once imported, so the credential is only in the client configuration." />
                  <Switch label="Start-menu shortcut" checked={o.startMenuShortcut} onChange={(e) => set("startMenuShortcut", e.currentTarget.checked)}
                    description="Adds “SoftEther VPN Client Manager” (needs vpncmgr.exe in the package)." />
                  <Switch label="Run UI helper at logon" checked={o.uiHelperAtLogon} onChange={(e) => set("uiHelperAtLogon", e.currentTarget.checked)}
                    description="Registers vpnclient.exe /uihelp in HKLM Run. The service needs it for later adapter changes and certificate prompts." />
                  <Switch label="Keep account on upgrade" checked={o.preserveOnUpgrade} onChange={(e) => set("preserveOnUpgrade", e.currentTarget.checked)}
                    description="When a newer version replaces this one, skip removing the VPN account and adapter (no outage). Off = clean re-create." />
                  <Select label="Virtual network adapter" value={o.nicName} onChange={(v) => set("nicName", v ?? "VPN")} data={NIC_OPTIONS} searchable allowDeselect={false}
                    description="Adapter created on install (NicCreate) and used by every imported profile." />
                  <NumberInput label="Configuration timeout (seconds)" min={30} max={1800} value={o.configureTimeoutSec}
                    onChange={(v) => set("configureTimeoutSec", typeof v === "number" ? v : Number(v) || 300)}
                    description="Maximum time for adapter creation and profile import; the install fails with 1460 instead of hanging on a hidden driver prompt." />
                </SimpleGrid>
              </Fieldset>

              <Fieldset legend="Client configuration password (optional)">
                <Text size="xs" c="dimmed" mb="xs">
                  Protects the local VPN Client configuration (vpncmd PasswordSet) so users cannot view, change or delete the imported accounts without it.
                  Stored encrypted; it is not shown again and must be re-entered for future builds.
                </Text>
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <PasswordInput label="Password" value={o.clientConfigPassword ?? ""} onChange={(e) => set("clientConfigPassword", e.currentTarget.value || undefined)} autoComplete="new-password" />
                  <PasswordInput label="Confirm password" value={confirmPw} onChange={(e) => setConfirmPw(e.currentTarget.value)} autoComplete="new-password"
                    error={o.clientConfigPassword && confirmPw && confirmPw !== o.clientConfigPassword ? "Does not match" : undefined} />
                </SimpleGrid>
              </Fieldset>
              {stepErrors[2].map((e) => <Text key={e} size="sm" c="red">{e}</Text>)}
            </Stack>
          )}

          {step === 3 && (
            <Stack>
              <Table withRowBorders={false} verticalSpacing={4}>
                <Table.Tbody>
                  <Table.Tr><Table.Td w={200}><Text size="sm" c="dimmed">File</Text></Table.Td><Table.Td><Code>{fileNameOf({ name: name.trim(), productVersion: o.productVersion })}</Code></Table.Td></Table.Tr>
                  <Table.Tr><Table.Td><Text size="sm" c="dimmed">Product</Text></Table.Td><Table.Td>{o.productName} {o.productVersion} — {o.manufacturer}</Table.Td></Table.Tr>
                  <Table.Tr><Table.Td><Text size="sm" c="dimmed">Package</Text></Table.Td><Table.Td>{pkg ? `${pkg.filename} (${pkg.version}, ${pkg.arch}, ${pkg.edition === "dev" ? "Developer" : "Stable"})` : "–"}</Table.Td></Table.Tr>
                  <Table.Tr><Table.Td><Text size="sm" c="dimmed">Install folder</Text></Table.Td><Table.Td>Program Files\{o.installFolder}</Table.Td></Table.Tr>
                  <Table.Tr><Table.Td><Text size="sm" c="dimmed">Adapter</Text></Table.Td><Table.Td>{o.nicName}</Table.Td></Table.Tr>
                  <Table.Tr><Table.Td><Text size="sm" c="dimmed">Credentials</Text></Table.Td><Table.Td>{CRED_LABEL[o.credentialMode]}</Table.Td></Table.Tr>
                  <Table.Tr><Table.Td><Text size="sm" c="dimmed">Options</Text></Table.Td><Table.Td>
                    <Group gap={4}>
                      {o.connectAfterInstall && <Badge variant="light">connect after install</Badge>}
                      {o.deleteProfileAfterImport && <Badge variant="light">delete .vpn after import</Badge>}
                      {o.startMenuShortcut && <Badge variant="light">shortcut</Badge>}
                      {o.uiHelperAtLogon && <Badge variant="light">UI helper at logon</Badge>}
                      {o.preserveOnUpgrade && <Badge variant="light">keep on upgrade</Badge>}
                      {o.clientConfigPassword && <Badge variant="light" color="teal">config password</Badge>}
                      <Badge variant="light" color="gray">timeout {o.configureTimeoutSec}s</Badge>
                    </Group>
                  </Table.Td></Table.Tr>
                </Table.Tbody>
              </Table>
              <Text fw={600} size="sm">Profiles</Text>
              {selected.map((p) => (
                <div key={p.id}>
                  <Group gap="xs"><Text size="sm" fw={500}>{p.settings.accountName}</Text><AuthBadge type={p.settings.authType} /><Text size="xs" c="dimmed">{p.settings.host}:{p.settings.port} / {p.settings.hub}</Text></Group>
                  {credentialIssues(p, o.credentialMode).map((i) => (
                    <Text key={i.text} size="xs" c={i.level === "warn" ? "orange" : "dimmed"} ml="md">{i.level === "warn" ? "⚠ " : "· "}{i.text}</Text>
                  ))}
                </div>
              ))}
              {o.credentialMode === "embedded" && selected.some((p) => p.settings.hasPassword || p.settings.authType === "certificate") && (
                <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>
                  This MSI will contain password-equivalent credentials. Distribute it only through trusted channels and delete old builds you no longer need.
                </Alert>
              )}
              {firstBad !== -1 && <Alert color="red" variant="light">Step {firstBad + 1}: {stepErrors[firstBad].join("; ")}</Alert>}
            </Stack>
          )}

          <Group justify="space-between" mt="lg">
            <Button variant="default" onClick={step === 0 ? onClose : () => setStep(step - 1)}>{step === 0 ? "Cancel" : "Back"}</Button>
            {step < 3 ? (
              <Button onClick={next} data-testid="wizard-next">Next</Button>
            ) : (
              <Button leftSection={<IconHammer size={16} />} loading={build.isPending} disabled={firstBad !== -1} onClick={() => build.mutate()} data-testid="wizard-build">
                Build MSI
              </Button>
            )}
          </Group>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Page

export default function InstallersPage() {
  const role = useGlobalRole();
  const isOperator = can(role, "operator");
  const qc = useQueryClient();
  const installers = useInstallers();
  const packages = usePackages();
  const profiles = useProfiles();
  const status = useDeployStatus();
  const [wizard, setWizard] = useState(false);
  const [seed, setSeed] = useState<WizardSeed | null>(null);
  const [logOf, setLogOf] = useState<InstallerBuild | null>(null);
  const [guideOf, setGuideOf] = useState<InstallerBuild | null>(null);

  const remove = useMutation({
    mutationFn: (b: InstallerBuild) => del(`/api/deploy/installers/${b.id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: deployKeys.installers }); notifications.show({ color: "green", message: "Installer deleted" }); },
    onError: (e) => notifyError(e, "Could not delete installer"),
  });

  const pkgName = (id: number | null) => {
    const p = packages.data?.find((x) => x.id === id);
    return p ? `${p.filename} (${p.version}, ${p.arch})` : id === null ? "–" : `#${id} (deleted)`;
  };
  const profName = (id: number) => profiles.data?.find((p) => p.id === id)?.name ?? `#${id} (deleted)`;
  const sameName = (b: InstallerBuild) => (installers.data ?? []).filter((x) => x.name === b.name).length;
  const msiOk = status.data?.msitools.ok;

  const newVersion = (b: InstallerBuild) => {
    setSeed({
      name: b.name,
      packageId: packages.data?.some((p) => p.id === b.packageId) ? String(b.packageId) : null,
      profileIds: b.profileIds.filter((id) => profiles.data?.some((p) => p.id === id)).map(String),
      options: { ...DEFAULT_OPTIONS, ...b.options, upgradeCode: undefined, clientConfigPassword: undefined, productVersion: bumpVersion(b.productVersion) },
    });
    setWizard(true);
  };

  return (
    <>
      <PageHeader
        title="MSI installers"
        description="Silent Windows installers that deploy the SoftEther VPN Client with your connection profiles — for Intune, Configuration Manager, Group Policy or msiexec."
        badge={status.data && (msiOk
          ? <Tooltip label="msitools (wixl) is used to build MSI files on this server"><Badge variant="light" color="green">msitools {status.data.msitools.version}</Badge></Tooltip>
          : <Badge variant="light" color="red">msitools missing</Badge>)}
        actions={isOperator && (
          <Button leftSection={<IconPlus size={16} />} onClick={() => { setSeed(null); setWizard(true); }} disabled={msiOk === false} data-testid="create-installer">
            New installer
          </Button>
        )}
      />
      {!isOperator && <ReadOnlyNotice role={role} />}
      {status.data && !msiOk && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />} mb="md" title="MSI builds are unavailable">
          {status.data.msitools.error ?? "msitools is not installed on the management server."}
        </Alert>
      )}
      <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />} mb="md">
        Each MSI installs the client files from a <Anchor component={Link} to="/deploy/packages">client package</Anchor>, registers the VPN Client service,
        creates the virtual adapter and imports the selected <Anchor component={Link} to="/deploy/profiles">connection profiles</Anchor> — all unattended as SYSTEM.
        Uninstalling removes the accounts, the adapter and the service.
      </Alert>
      <QueryState query={installers}>
        <DataTable
          testId="installers-table"
          data={installers.data}
          rowKey={(b) => b.id}
          initialSort={{ key: "createdAt", dir: "desc" }}
          empty={isOperator ? "No installers built yet. Add a client package and a profile, then choose “New installer”." : "No installers built yet."}
          columns={[
            { key: "name", title: "Name", render: (b) => <div><Text fw={600} size="sm">{b.name}</Text><Text size="xs" c="dimmed">{b.options.productName}</Text></div> },
            { key: "productVersion", title: "Version", render: (b) => <Code>{b.productVersion}</Code> },
            { key: "package", title: "Package", value: (b) => pkgName(b.packageId), render: (b) => <Text size="sm">{pkgName(b.packageId)}</Text> },
            { key: "profiles", title: "Profiles", value: (b) => b.profileIds.map(profName).join(", "), render: (b) => <Text size="sm" lineClamp={2}>{b.profileIds.map(profName).join(", ")}</Text> },
            { key: "cred", title: "Credentials", value: (b) => b.options.credentialMode, render: (b) => <Badge variant="outline" color={b.options.credentialMode === "embedded" ? "orange" : "gray"}>{CRED_LABEL[b.options.credentialMode] ?? b.options.credentialMode}</Badge> },
            { key: "status", title: "Status", render: (b) => <StatusBadge status={b.status} /> },
            { key: "size", title: "Size", align: "right", value: (b) => b.size ?? 0, render: (b) => bytes(b.size) },
            { key: "sha256", title: "SHA-256", render: (b) => (b.sha256 ? <Tooltip label={b.sha256}><Code>{b.sha256.slice(0, 12)}…</Code></Tooltip> : "–") },
            { key: "createdAt", title: "Created", value: (b) => b.createdAt, render: (b) => <Tooltip label={dt(b.createdAt)}><Text size="sm">{ago(b.createdAt)} · {b.createdBy}</Text></Tooltip> },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (b) => (
                <Group gap={6} justify="flex-end" wrap="nowrap">
                  <Tooltip label="Build log and MSI tables"><Button size="xs" variant="subtle" leftSection={<IconFileText size={14} />} onClick={() => setLogOf(b)} data-testid={`installer-log-${b.id}`}>Log</Button></Tooltip>
                  {b.status === "ready" && <Button size="xs" variant="subtle" leftSection={<IconRocket size={14} />} onClick={() => setGuideOf(b)} data-testid={`installer-deploy-${b.id}`}>Deploy</Button>}
                  {isOperator && b.status === "ready" && (
                    <Tooltip label="Download MSI (audited)">
                      <Button size="xs" variant="light" leftSection={<IconDownload size={14} />} onClick={() => download(`/api/deploy/installers/${b.id}/download`)} data-testid={`installer-download-${b.id}`}>MSI</Button>
                    </Tooltip>
                  )}
                  {isOperator && msiOk !== false && (
                    <Tooltip label="Build a new version with the same settings"><Button size="xs" variant="subtle" leftSection={<IconRefresh size={14} />} onClick={() => newVersion(b)}>New version</Button></Tooltip>
                  )}
                  {isOperator && (
                    <ConfirmButton
                      title={`Delete installer ${b.name} ${b.productVersion}?`}
                      message={
                        <>
                          The MSI file and its build record are deleted. Machines that already installed it are not affected.
                          {sameName(b) === 1 && <Text size="sm" c="orange" mt="xs">This is the last build named “{b.name}”. Its upgrade code <Code>{b.upgradeCode}</Code> will be forgotten, so a later build with this name will not upgrade existing installations unless you enter the code manually. Copy it first if you still deploy this installer.</Text>}
                        </>
                      }
                      typeToConfirm={sameName(b) === 1 ? b.name : undefined}
                      confirmLabel="Delete installer"
                      onConfirm={() => remove.mutateAsync(b)}
                      leftSection={<IconTrash size={14} />}
                    >Delete</ConfirmButton>
                  )}
                </Group>
              ),
            },
          ]}
        />
      </QueryState>
      <NewInstallerWizard opened={wizard} onClose={() => setWizard(false)} seed={seed} onBuilt={setGuideOf} />
      <LogModal build={logOf} onClose={() => setLogOf(null)} />
      <InstructionsModal build={guideOf} onClose={() => setGuideOf(null)} />
    </>
  );
}
