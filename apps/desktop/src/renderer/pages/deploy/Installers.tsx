// Client Deployment › MSI Installers: silent Windows installers built from a client package and custom
// profiles, plus every MSI / setup.exe / .vpn package built from a hub's Client Deployment page.
// Builds need an MSI toolchain (msitools on macOS/Linux, WiX v3 on Windows): /api/deploy/capabilities says
// whether this computer has one, and what to install when it doesn't.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, NumberInput, PasswordInput, Radio, SegmentedControl, Select, TextInput } from "@mantine/core";
import {
  IconAlertTriangle, IconCopy, IconDownload, IconFileText, IconHammer, IconInfoCircle, IconPackage, IconPackageExport, IconPlus, IconRefresh, IconRocket, IconTrash,
} from "@tabler/icons-react";
import { ApiError, del, download, post } from "../../lib/api";
import { agoShort, bytes, downloadText, dt } from "../../lib/format";
import { notifyError, notifySuccess } from "../../lib/hooks";
import { deployBase, hubBase } from "../../sections";
import {
  confirmAction, CopyField, DataTable, ErrorState, FormRow, FormSection, Mono, PageHeader, PropertyList, Section, Sheet, TableSkeleton, Tag, type ContextMenuItem,
} from "../../design";
import {
  AuthBadge, CRED_LABEL, NIC_OPTIONS, NIC_RE, UUID_RE, VERSION_RE, bumpVersion, deployKeys, useInstallers, usePackages, useProfiles,
  type CredentialMode, type MsiOptions, type Profile,
} from "../../components/domain/deploy";
import { PolicyBadge } from "../../components/domain/hubdeploy";
import { Callout } from "../../components/domain/ui";
import {
  BuildStatus, CodeBlock, KIND_SHORT, MsiToolBadge, SheetFooter, StepHeader, SwitchRow, buildFileName, isHubBuild, productCodeFrom, safeFile,
  toolLabel, useCapabilities, useRecheckCapabilities, type BuildRecord,
} from "./_deployment/shared";

const DEFAULT_OPTIONS: MsiOptions = {
  productName: "SoftEther VPN Client (Managed)", manufacturer: "IT Department", productVersion: "1.0.0", upgradeCode: undefined,
  installFolder: "SoftEther VPN Client Managed", connectAfterInstall: true, deleteProfileAfterImport: true, startMenuShortcut: true,
  uiHelperAtLogon: true, credentialMode: "embedded", clientConfigPassword: undefined, preserveOnUpgrade: true, configureTimeoutSec: 300, nicName: "VPN",
};

const CRED_HELP: Record<CredentialMode, ReactNode> = {
  embedded: <>Each profile’s credential (password hash or client certificate) is built into the MSI. Anyone with the file can extract it.</>,
  "install-time": <>No password in the MSI. Pass it at install: <code className="sem-code-inline">VPNUSERNAME=jdoe VPNPASSWORD=…</code>. It’s hidden from MSI logs and deleted right after use. Needed for RADIUS and domain passwords.</>,
  none: <>Passwords are removed. Users enter theirs in the VPN Client Manager. Certificate profiles still carry their key.</>,
};

type Filter = "all" | "custom" | "hub";

// ------------------------------------------------------------------ build log

function splitLog(log: string): { title: string; body: string }[] {
  const parts = log.split(/\n== (\w+)\n/);
  const out = [{ title: "Build output", body: parts[0].trim() }];
  for (let i = 1; i < parts.length; i += 2) out.push({ title: parts[i], body: (parts[i + 1] ?? "").trim() });
  return out;
}

/** msiinfo export format: header row, type row, key row, then tab-separated records. */
function MsiTable({ text }: { text: string }) {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (lines.length < 3 || !lines[0].includes("\t")) return <CodeBlock text={text} maxHeight="55vh" />;
  const head = lines[0].split("\t");
  const rows = lines.slice(3).map((l, i) => ({ i, cells: l.split("\t") }));
  return (
    <DataTable
      testId="msi-table" aria-label="MSI table" data={rows} rowKey={(r) => r.i} maxHeight="55vh" searchable={rows.length > 12}
      columns={head.map((h, j) => ({ key: String(j), title: h, mono: true, truncate: true, value: (r: { cells: string[] }) => r.cells[j], render: (r: { cells: string[] }) => <span title={r.cells[j]}>{r.cells[j]}</span> }))}
    />
  );
}

function LogSheet({ build, onClose }: { build: BuildRecord | null; onClose: () => void }) {
  const sections = useMemo(() => (build ? splitLog(build.log ?? "") : []), [build]);
  const [tab, setTab] = useState("Build output");
  useEffect(() => setTab("Build output"), [build?.id]);
  const cur = sections.find((s) => s.title === tab) ?? sections[0];
  const pc = build ? productCodeFrom(build) : null;
  return (
    <Sheet
      opened={!!build} onClose={onClose} size="min(1100px, calc(100vw - 64px))" testId="build-log"
      icon={<IconFileText size={19} stroke={1.5} />} title={build ? `Build Log: ${build.name} ${build.productVersion}` : ""}
      subtitle={build ? buildFileName(build) : undefined}
      footer={build && (
        <SheetFooter leading={<span className="sem-row-inline"><BuildStatus status={build.status} />{pc && <><span className="sem-dim">ProductCode</span><CopyField value={pc} size="sm" /></>}</span>}>
          <Button variant="default" leftSection={<IconDownload size={14} />} onClick={() => void downloadText(`${buildFileName(build)}.log.txt`, build.log ?? "").catch((e) => notifyError(e, "Couldn’t save the log"))}>Save Log…</Button>
          <Button onClick={onClose}>Done</Button>
        </SheetFooter>
      )}
    >
      {build && (
        <div className="sem-stack">
          {sections.length > 1 && (sections.length <= 6
            ? <SegmentedControl size="xs" value={tab} onChange={setTab} data={sections.map((s) => s.title)} data-testid="build-log-tabs" />
            : <Select w={260} value={tab} onChange={(v) => setTab(v ?? "Build output")} allowDeselect={false} data={sections.map((s) => s.title)} data-testid="build-log-tabs" aria-label="Log section" />)}
          {cur && (cur.title === "Build output" ? <CodeBlock text={cur.body || "(empty)"} maxHeight="55vh" testId="build-log-text" /> : <MsiTable text={cur.body} />)}
        </div>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ deployment instructions

function Cmd({ label, value, testId }: { label: ReactNode; value: string; testId?: string }) {
  return <FormRow label={label} stacked>{() => <CopyField value={value} block testId={testId} />}</FormRow>;
}

function InstructionsSheet({ build, onClose }: { build: BuildRecord | null; onClose: () => void }) {
  const b = build;
  const file = b ? buildFileName(b) : "";
  const pc = b ? productCodeFrom(b) : null;
  const installTime = b ? (b.options.credentialMode ?? b.options.credential) === "install-time" : false;
  const creds = installTime ? ` VPNUSERNAME="jdoe" VPNPASSWORD="<password>"` : "";
  const logBase = b ? safeFile(b.name) : "";
  const kind = b?.kind ?? "msi";
  const x86 = /wixl -a x86 /.test(b?.log ?? "");
  const installDir = `C:\\Program Files${x86 ? " (x86)" : ""}\\${b?.options.installFolder ?? "<install folder>"}`;
  const uninstallShort = pc ? `msiexec /x ${pc} /qn` : `msiexec /x "${file}" /qn`;

  return (
    <Sheet
      opened={!!b} onClose={onClose} size={760} testId="deploy-instructions"
      icon={<IconRocket size={19} stroke={1.5} />} title={b ? `Deploy ${b.name} ${b.productVersion}`.trim() : ""} subtitle={file}
      footer={b && (
        <SheetFooter>
          {b.status === "ready" && <Button variant="default" leftSection={<IconDownload size={14} />} onClick={() => void download(`/api/deploy/installers/${b.id}/download`).catch((e) => notifyError(e, "Couldn’t save the file"))}>Save {KIND_SHORT[kind] ?? "File"}…</Button>}
          <Button onClick={onClose}>Done</Button>
        </SheetFooter>
      )}
    >
      {b && (
        <div className="sem-stack">
          <FormSection title="File">
            <PropertyList labelWidth={150} items={[
              { label: "File name", value: <CopyField value={file} size="sm" /> },
              { label: "SHA-256", value: b.sha256 ? <CopyField value={b.sha256} display={`${b.sha256.slice(0, 24)}…`} size="sm" /> : undefined },
              ...(kind !== "vpn" ? [
                { label: "ProductCode", hint: "Changes with every build.", value: pc ? <CopyField value={pc} size="sm" /> : "See the Property table in the build log" },
                { label: "UpgradeCode", hint: "Stays the same across versions.", value: <CopyField value={`{${b.upgradeCode}}`} size="sm" /> },
              ] : []),
            ]} />
          </FormSection>

          {kind === "vpn" && (
            <FormSection title="Import on a client">
              <Cmd label="Import the profile" value={`vpncmd localhost /CLIENT /CMD AccountImport "${file}"`} />
              <Cmd label="Connect it" value={`vpncmd localhost /CLIENT /CMD AccountConnect "<connection name>"`} />
            </FormSection>
          )}

          {kind === "exe" && (
            <FormSection title="Command line (elevated)" footer="setup.exe also accepts /passive and /log <file>, and passes NAME=value properties to the MSI.">
              <Cmd label="Silent install" value={`"${file}" /quiet /log "%TEMP%\\${logBase}-install.log"${creds}`} testId="cmd-install" />
              <Cmd label="Silent uninstall" value={`"${file}" /uninstall /quiet`} />
              {pc && <Cmd label="Silent uninstall (by product code)" value={`msiexec /x ${pc} /qn /norestart`} />}
            </FormSection>
          )}

          {kind === "msi" && (
            <FormSection title="Command line (elevated)"
              footer={<>Run as SYSTEM or elevated: the install creates a service and a virtual adapter, so a non-elevated <code className="sem-code-inline">/qn</code> run fails with 1603. Success codes: 0, 3010 (restart needed), 1641. A newer version with the same name upgrades in place{b.options.preserveOnUpgrade === false ? " and re-creates the VPN account." : " and keeps the VPN account."}</>}>
              <Cmd label="Silent install" value={`msiexec /i "${file}" /qn /norestart /l*v "%TEMP%\\${logBase}-install.log"${creds}`} testId="cmd-install" />
              {pc && <Cmd label="Silent uninstall (by product code)" value={`msiexec /x ${pc} /qn /norestart /l*v "%TEMP%\\${logBase}-uninstall.log"`} />}
              <Cmd label="Silent uninstall (with the MSI file)" value={`msiexec /x "${file}" /qn /norestart`} />
            </FormSection>
          )}
          {installTime && kind !== "vpn" && (
            <Callout tone="yellow" icon={<IconAlertTriangle size={16} stroke={1.7} />}>
              Replace <code className="sem-code-inline">jdoe</code> and <code className="sem-code-inline">&lt;password&gt;</code> for each user. The password is hidden from the MSI log but visible in the process command line and in your deployment tool; restrict who can read those.
            </Callout>
          )}

          {kind === "msi" && (
            <>
              <Section title="Microsoft Intune (Win32 app)">
                <ul className="sem-sheet-text" style={{ margin: 0, paddingLeft: "var(--sem-space-7)" }}>
                  <li>Wrap it: <code className="sem-code-inline">IntuneWinAppUtil.exe -c &lt;folder&gt; -s {file} -o &lt;out&gt;</code>, then upload the <code className="sem-code-inline">.intunewin</code>.</li>
                  <li>Install command <code className="sem-code-inline">msiexec /i "{file}" /qn{creds}</code>; uninstall command <code className="sem-code-inline">{uninstallShort}</code>.</li>
                  <li>Install behaviour <b>System</b>; restart behaviour “Determine behavior based on return codes”.</li>
                  <li>Detection rule: <b>MSI</b>, product code <code className="sem-code-inline">{pc ?? "{ProductCode from the build log}"}</code> (optionally version ≥ {b.productVersion}).</li>
                  <li>Assign to <b>devices</b>. {["embedded", "embed-hash", "rotate"].includes(String(b.options.credentialMode ?? b.options.credential ?? "")) ?"Embedded credentials are the same on every device." : installTime ? "Install-time credentials need one app per user or a script wrapper." : "Users enter their password in the VPN Client Manager."}</li>
                </ul>
              </Section>
              <Section title="Group Policy">
                <ul className="sem-sheet-text" style={{ margin: 0, paddingLeft: "var(--sem-space-7)" }}>
                  <li>Copy the MSI to a share Domain Computers can read, e.g. <code className="sem-code-inline">\\fileserver\deploy$\{file}</code>.</li>
                  <li>Computer Configuration › Policies › Software Settings › Software installation › New › Package › <b>Assigned</b>. It installs at the next restart.</li>
                  <li>Group Policy can’t pass <code className="sem-code-inline">VPNUSERNAME</code>/<code className="sem-code-inline">VPNPASSWORD</code>: use embedded or “none” credentials.</li>
                </ul>
              </Section>
              <Section title="Configuration Manager">
                <ul className="sem-sheet-text" style={{ margin: 0, paddingLeft: "var(--sem-space-7)" }}>
                  <li>Create an Application with a <b>Windows Installer (*.msi)</b> deployment type; it reads the product code for detection.</li>
                  <li>Install program <code className="sem-code-inline">msiexec /i "{file}" /qn{creds}</code>; uninstall program <code className="sem-code-inline">{uninstallShort}</code>; install for system.</li>
                </ul>
              </Section>
            </>
          )}
          {kind !== "vpn" && (
            <Section title="Troubleshooting">
              <ul className="sem-sheet-text" style={{ margin: 0, paddingLeft: "var(--sem-space-7)" }}>
                <li>Configuration log: <code className="sem-code-inline">C:\ProgramData\SoftEtherManager\configure.log</code> (uninstall: <code className="sem-code-inline">unconfigure.log</code>).</li>
                <li>Client logs: <code className="sem-code-inline">{installDir}\client_log</code>. Check the account with <code className="sem-code-inline">vpncmd localhost /CLIENT /CMD AccountList</code>.</li>
                <li>Exit code 1460: the configuration step took longer than {b.options.configureTimeoutSec ? `${b.options.configureTimeoutSec} s` : "its timeout"} (usually a blocked driver install).</li>
              </ul>
            </Section>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ new installer assistant

interface Seed { name: string; packageId: string | null; profileIds: string[]; options: MsiOptions }

function credentialIssues(p: Profile, mode: CredentialMode): { level: "warn" | "info"; text: string }[] {
  const s = p.settings;
  const out: { level: "warn" | "info"; text: string }[] = [];
  if (mode === "embedded") {
    if (s.authType === "password" && !s.hasPassword) out.push({ level: "warn", text: "No password stored: the embedded hash is of an empty password." });
    if (s.authType === "radius") out.push({ level: "warn", text: "RADIUS and domain passwords can’t be embedded; use install-time credentials." });
    if (s.authType === "password" && s.hasPassword) out.push({ level: "info", text: "Password hash embedded (works like the password)." });
  }
  if (mode === "install-time" && (s.authType === "anonymous" || s.authType === "certificate")) out.push({ level: "info", text: `${s.authType === "anonymous" ? "Anonymous" : "Certificate"} authentication: VPNPASSWORD isn’t used.` });
  if (mode === "none" && s.authType === "password") out.push({ level: "info", text: "Password removed; the user enters it." });
  if (s.authType === "certificate") out.push({ level: "info", text: "Client private key embedded." });
  return out;
}

const STEPS = ["Package", "Profiles", "Options", "Review"];

function NewInstallerSheet({ opened, onClose, seed, onDeploy }: { opened: boolean; onClose: () => void; seed: Seed | null; onDeploy: (b: BuildRecord) => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
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
  const [result, setResult] = useState<BuildRecord | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (!opened) return;
    setStep(0); setResult(null); setConfirmPw(""); setShowErrors(false);
    setName(seed?.name ?? ""); setPackageId(seed?.packageId ?? null); setProfileIds(seed?.profileIds ?? []);
    setO(seed?.options ?? DEFAULT_OPTIONS); setVersionTouched(!!seed);
  }, [opened, seed]);
  const set = <K extends keyof MsiOptions>(k: K, v: MsiOptions[K]) => setO((cur) => ({ ...cur, [k]: v }));

  // Builds with this name: suggest the next version; the server reuses their upgrade code.
  const previous = useMemo(() => (builds.data ?? []).filter((b) => b.name === name.trim()).sort((a, b) => b.createdAt - a.createdAt)[0], [builds.data, name]);
  useEffect(() => {
    if (versionTouched) return;
    setO((cur) => ({ ...cur, productVersion: previous ? bumpVersion(previous.productVersion) : "1.0.0" }));
  }, [previous?.id, versionTouched]);
  useEffect(() => {
    if (opened && !packageId && packages.data?.length) setPackageId(String(packages.data[0].id));
  }, [opened, packages.data]);

  const pkg = packages.data?.find((p) => String(p.id) === packageId);
  const selected = profileIds.map((id) => profiles.data?.find((p) => String(p.id) === id)).filter((p): p is Profile => !!p);
  const dupes = selected.map((p) => p.settings.accountName.toLowerCase()).filter((n, i, a) => a.indexOf(n) !== i);

  const fieldErrors: Record<string, string> = {};
  if (!name.trim()) fieldErrors.name = "Enter an installer name.";
  if (!pkg) fieldErrors.package = "Choose a client package.";
  if (!o.productName.trim()) fieldErrors.productName = "Enter a product name.";
  if (!o.manufacturer.trim()) fieldErrors.manufacturer = "Enter the publisher.";
  if (!VERSION_RE.test(o.productVersion)) fieldErrors.productVersion = "Like 1.0.0 (major up to 255).";
  if (!o.installFolder.trim() || /[\\/:*?"<>|]/.test(o.installFolder)) fieldErrors.installFolder = "One folder name without \\ / : * ? \" < > |.";
  if (!NIC_RE.test(o.nicName)) fieldErrors.nicName = "VPN … VPN127.";
  if (!(o.configureTimeoutSec >= 30 && o.configureTimeoutSec <= 1800)) fieldErrors.configureTimeoutSec = "30 to 1800 seconds.";
  if (o.upgradeCode && !UUID_RE.test(o.upgradeCode)) fieldErrors.upgradeCode = "Must be a GUID.";
  if (o.clientConfigPassword && o.clientConfigPassword !== confirmPw) fieldErrors.confirmPw = "The passwords don’t match.";
  const stepErrors: string[][] = [
    [fieldErrors.name, fieldErrors.package].filter(Boolean) as string[],
    [
      selected.length === 0 ? "Select at least one profile." : "",
      selected.length > 16 ? "Select at most 16 profiles." : "",
      dupes.length ? `Connection names must differ (duplicate: ${[...new Set(dupes)].join(", ")}).` : "",
    ].filter(Boolean),
    ["productName", "manufacturer", "productVersion", "installFolder", "nicName", "configureTimeoutSec", "upgradeCode", "confirmPw"].map((k) => fieldErrors[k]).filter(Boolean),
    [],
  ];
  const firstBad = stepErrors.findIndex((e) => e.length > 0);
  const fe = (k: string) => (showErrors ? fieldErrors[k] : undefined);

  const build = useMutation({
    mutationFn: () => post<BuildRecord>("/api/deploy/installers", {
      name: name.trim(), packageId: Number(packageId), profileIds: profileIds.map(Number),
      options: { ...o, upgradeCode: o.upgradeCode?.trim() || undefined, clientConfigPassword: o.clientConfigPassword || undefined },
    }),
    onSuccess: (b) => {
      void qc.invalidateQueries({ queryKey: deployKeys.installers });
      setResult(b);
      if (b.status === "ready") notifySuccess(`Built ${buildFileName(b)} (${bytes(b.size)})`);
    },
    onError: (e) => notifyError(e, e instanceof ApiError && e.status === 503 ? "MSI tools are missing" : "The build request was rejected"),
  });

  const next = () => {
    if (stepErrors[step].length) { setShowErrors(true); return; }
    setShowErrors(false);
    setStep((s) => s + 1);
  };
  const saveMsi = async (b: BuildRecord) => {
    try {
      const r = await download(`/api/deploy/installers/${b.id}/download`);
      if (r.saved) notifySuccess(`Saved ${r.filePath?.split(/[\\/]/).pop() ?? buildFileName(b)}`);
    } catch (e) { notifyError(e, "Couldn’t save the MSI"); }
  };

  const footer = result ? (
    <SheetFooter>
      <Button variant="default" onClick={onClose}>Close</Button>
      {result.status === "ready" ? (
        <>
          <Button variant="default" leftSection={<IconRocket size={14} />} onClick={() => { onDeploy(result); onClose(); }}>Deployment Instructions…</Button>
          <Button leftSection={<IconDownload size={14} />} onClick={() => void saveMsi(result)} data-testid="wizard-download">Save MSI…</Button>
        </>
      ) : <Button onClick={() => { setResult(null); setStep(2); }}>Back to Options</Button>}
    </SheetFooter>
  ) : (
    <SheetFooter leading={showErrors && stepErrors[step].length ? <span className="sem-text-red" data-testid="wizard-errors">{stepErrors[step][0]}</span> : undefined}>
      <Button variant="default" onClick={step === 0 ? onClose : () => { setShowErrors(false); setStep(step - 1); }}>{step === 0 ? "Cancel" : "Back"}</Button>
      {step < 3
        ? <Button onClick={next} data-testid="wizard-next">Continue</Button>
        : <Button leftSection={<IconHammer size={14} />} loading={build.isPending} disabled={firstBad !== -1} onClick={() => build.mutate()} data-testid="wizard-build">Build MSI</Button>}
    </SheetFooter>
  );

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={build.isPending} size={820} testId="installer-wizard"
      icon={<IconPackage size={19} stroke={1.5} />} title={seed ? `New Version of “${seed.name}”` : "New MSI Installer"}
      subtitle={result ? undefined : `Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`} footer={footer}
    >
      {result ? (
        <div className="sem-stack" data-testid="wizard-result">
          {result.status === "ready" ? (
            <Callout tone="green" title="Installer ready">
              <div className="sem-row-inline"><Mono>{buildFileName(result)}</Mono><span className="sem-dim">{bytes(result.size)}</span></div>
              <div style={{ marginTop: "var(--sem-space-3)" }}><CopyField value={result.sha256 ?? ""} display={`SHA-256 ${result.sha256?.slice(0, 24)}…`} size="sm" /></div>
            </Callout>
          ) : (
            <>
              <Callout tone="red" title="The build failed.">The MSI toolchain reported an error. The log is below and on the installer’s Build Log.</Callout>
              <CodeBlock text={result.log} maxHeight={300} wrap />
            </>
          )}
        </div>
      ) : (
        <>
          <StepHeader steps={STEPS} active={step} testId="wizard-steps" onStep={(i) => { if (i < step || firstBad === -1 || i <= firstBad) { setShowErrors(false); setStep(i); } }} />

          {step === 0 && (
            <>
              <FormSection>
                <FormRow label="Installer name" description="Builds with the same name share an UpgradeCode, so a higher version replaces the previous one." error={fe("name")}>
                  {(id) => <TextInput id={id} w="100%" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus data-testid="installer-name" error={!!fe("name")} />}
                </FormRow>
                <FormRow label="Client package" description="The SoftEther VPN Client files to install. The MSI is built for its architecture." error={fe("package")}>
                  {(id) => packages.isLoading ? <TableSkeleton rows={1} columns={1} /> : (
                    <Select id={id} w="100%" value={packageId} onChange={setPackageId} allowDeselect={false} data-testid="installer-package" placeholder={packages.data?.length ? "Choose a package" : "No packages"}
                      data={(packages.data ?? []).map((p) => ({ value: String(p.id), label: `${p.filename} · ${p.version} · ${p.arch} · ${p.edition === "dev" ? "Developer" : "Stable"}` }))} />
                  )}
                </FormRow>
              </FormSection>
              <div className="sem-callouts">
                {previous && (
                  <Callout tone="accent" icon={<IconInfoCircle size={16} stroke={1.7} />}>
                    Last build of “{previous.name}”: version {previous.productVersion}, {dt(previous.createdAt)}. The next version is suggested and upgrade code <Mono>{previous.upgradeCode}</Mono> is reused.
                  </Callout>
                )}
                {packages.data && !packages.data.length && (
                  <Callout tone="yellow" action={<Button size="xs" variant="default" onClick={() => { onClose(); nav(`${deployBase}/packages`); }}>Client Packages…</Button>}>No client packages yet. Add one first.</Callout>
                )}
                {pkg && (
                  <Callout tone="gray">
                    {pkg.files.map((f) => `${f.name} (${bytes(f.size)})`).join(", ")}
                    {!pkg.files.some((f) => f.name.toLowerCase() === "vpncmgr.exe") && ". No vpncmgr.exe, so no Start menu shortcut."}
                  </Callout>
                )}
              </div>
            </>
          )}

          {step === 1 && (
            profiles.error ? <ErrorState error={profiles.error} inline onRetry={() => void profiles.refetch()} /> : (
              <div className="sem-stack">
                <p className="sem-sheet-text">Each selected profile becomes a VPN connection on the client. Connection names must differ; at most 16. The installer’s adapter replaces each profile’s own.</p>
                <DataTable<Profile>
                  testId="wizard-profiles" aria-label="Profiles to include" data={profiles.data} loading={profiles.isLoading} rowKey={(p) => String(p.id)}
                  rowTestId={(p) => `wizard-profile-${p.id}`} selectable="multi" selection={profileIds}
                  onSelectionChange={(k) => setProfileIds(k.map(String))} maxHeight={330} searchable={(profiles.data?.length ?? 0) > 8}
                  rowTone={(p) => (profileIds.includes(String(p.id)) && dupes.includes(p.settings.accountName.toLowerCase()) ? "danger" : undefined)}
                  empty={{ title: "No custom profiles", description: "Create a profile first.", action: <Button size="xs" variant="default" onClick={() => { onClose(); nav(`${deployBase}/profiles`); }}>Custom Profiles…</Button> }}
                  columns={[
                    { key: "name", title: "Profile", truncate: true, render: (p) => <span className="sem-strong">{p.name}</span> },
                    { key: "accountName", title: "Connection name", truncate: true, value: (p) => p.settings.accountName },
                    { key: "server", title: "Server / hub", truncate: true, value: (p) => `${p.settings.host}:${p.settings.port} / ${p.settings.hub}`, render: (p) => <Mono>{p.settings.host}:{p.settings.port} / {p.settings.hub}</Mono> },
                    { key: "auth", title: "Authentication", width: 150, value: (p) => p.settings.authType, render: (p) => <AuthBadge type={p.settings.authType} /> },
                    { key: "startup", title: "Startup", width: 76, value: (p) => (p.settings.startup ? 1 : 0), render: (p) => (p.settings.startup ? "Auto" : <span className="sem-dim">Manual</span>) },
                  ]}
                />
              </div>
            )
          )}

          {step === 2 && (
            <>
              <FormSection title="Product">
                <FormRow label="Product name" description="Shown in Apps & Features and as the Start menu folder." error={fe("productName")}>
                  {(id) => <TextInput id={id} w="100%" value={o.productName} onChange={(e) => set("productName", e.currentTarget.value)} error={!!fe("productName")} />}
                </FormRow>
                <FormRow label="Publisher" error={fe("manufacturer")}>{(id) => <TextInput id={id} w="100%" value={o.manufacturer} onChange={(e) => set("manufacturer", e.currentTarget.value)} error={!!fe("manufacturer")} />}</FormRow>
                <FormRow label="Version" description={previous ? `Last build: ${previous.productVersion}. Must be higher to upgrade.` : "Increase it for every build you deploy."}
                  error={o.productVersion && !VERSION_RE.test(o.productVersion) ? "Like 1.0.0." : fe("productVersion")}>
                  {(id) => <TextInput id={id} w={140} value={o.productVersion} data-testid="installer-version" onChange={(e) => { setVersionTouched(true); set("productVersion", e.currentTarget.value.trim()); }} error={!!(o.productVersion && !VERSION_RE.test(o.productVersion))} />}
                </FormRow>
                <FormRow label="Install folder" description="Under Program Files. Keep it apart from a vpnsetup-installed client." error={fe("installFolder")}>
                  {(id) => <TextInput id={id} w="100%" value={o.installFolder} onChange={(e) => set("installFolder", e.currentTarget.value)} error={!!fe("installFolder")} />}
                </FormRow>
                <FormRow label="Upgrade code" description="Advanced. Leave empty: builds with the same name reuse theirs." error={o.upgradeCode && !UUID_RE.test(o.upgradeCode) ? "Must be a GUID." : undefined}>
                  {(id) => <TextInput id={id} w="100%" value={o.upgradeCode ?? ""} onChange={(e) => set("upgradeCode", e.currentTarget.value.trim() || undefined)} placeholder={previous?.upgradeCode ?? "Generated automatically"} styles={{ input: { fontFamily: "var(--sem-font-mono)" } }} />}
                </FormRow>
              </FormSection>
              <FormSection title="Credentials">
                <Radio.Group value={o.credentialMode} onChange={(v) => set("credentialMode", v as CredentialMode)} data-testid="installer-credential-mode">
                  {(["embedded", "install-time", "none"] as CredentialMode[]).map((m) => (
                    <div key={m} className="sem-form-row" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
                      <Radio value={m} label={CRED_LABEL[m]} description={CRED_HELP[m]} data-testid={`cred-${m}`} />
                    </div>
                  ))}
                </Radio.Group>
              </FormSection>
              <FormSection title="Behaviour">
                <SwitchRow label="Connect after installing" description="Connect startup profiles right away." checked={o.connectAfterInstall} onChange={(v) => set("connectAfterInstall", v)} />
                <SwitchRow label="Delete .vpn files after import" description="The credential then lives only in the client configuration." checked={o.deleteProfileAfterImport} onChange={(v) => set("deleteProfileAfterImport", v)} />
                <SwitchRow label="Start menu shortcut" description="Needs vpncmgr.exe in the package." checked={o.startMenuShortcut} onChange={(v) => set("startMenuShortcut", v)} />
                <SwitchRow label="Run the UI helper at logon" description="Needed for later adapter changes and certificate prompts." checked={o.uiHelperAtLogon} onChange={(v) => set("uiHelperAtLogon", v)} />
                <SwitchRow label="Keep the account on upgrade" description="Upgrading doesn’t drop the connection." checked={o.preserveOnUpgrade} onChange={(v) => set("preserveOnUpgrade", v)} />
                <FormRow label="Virtual adapter" error={fe("nicName")}>
                  {(id) => <Select id={id} w={140} value={o.nicName} onChange={(v) => set("nicName", v ?? "VPN")} data={NIC_OPTIONS} searchable allowDeselect={false} />}
                </FormRow>
                <FormRow label="Configuration timeout" description="The install fails with 1460 instead of hanging on a hidden driver prompt." error={fe("configureTimeoutSec")}>
                  {(id) => <NumberInput id={id} w={120} min={30} max={1800} allowDecimal={false} suffix=" s" value={o.configureTimeoutSec} onChange={(v) => set("configureTimeoutSec", typeof v === "number" ? v : Number(v) || 300)} />}
                </FormRow>
              </FormSection>
              <FormSection title="Client configuration password" description="Optional. Protects the VPN Client configuration so users can’t view, change or delete the connections. It isn’t shown again.">
                <FormRow label="Password">{(id) => <PasswordInput id={id} w={240} value={o.clientConfigPassword ?? ""} onChange={(e) => set("clientConfigPassword", e.currentTarget.value || undefined)} autoComplete="new-password" />}</FormRow>
                <FormRow label="Confirm" error={o.clientConfigPassword && confirmPw && confirmPw !== o.clientConfigPassword ? "The passwords don’t match." : fe("confirmPw")}>
                  {(id) => <PasswordInput id={id} w={240} value={confirmPw} onChange={(e) => setConfirmPw(e.currentTarget.value)} autoComplete="new-password" />}
                </FormRow>
              </FormSection>
            </>
          )}

          {step === 3 && (
            <div className="sem-stack">
              <FormSection>
                <PropertyList labelWidth={140} testId="wizard-review" items={[
                  { label: "File", value: <Mono>{buildFileName({ name: name.trim(), productVersion: o.productVersion, fileName: null })}</Mono> },
                  { label: "Product", value: `${o.productName} ${o.productVersion} · ${o.manufacturer}` },
                  { label: "Package", value: pkg ? `${pkg.filename} (${pkg.version}, ${pkg.arch}, ${pkg.edition === "dev" ? "Developer" : "Stable"})` : undefined },
                  { label: "Install folder", value: `Program Files\\${o.installFolder}` },
                  { label: "Adapter", value: o.nicName },
                  { label: "Credentials", value: CRED_LABEL[o.credentialMode] },
                  { label: "Options", value: (
                    <span className="sem-row-inline">
                      {o.connectAfterInstall && <Tag>Connect after install</Tag>}
                      {o.deleteProfileAfterImport && <Tag>Delete .vpn after import</Tag>}
                      {o.startMenuShortcut && <Tag>Shortcut</Tag>}
                      {o.uiHelperAtLogon && <Tag>UI helper</Tag>}
                      {o.preserveOnUpgrade && <Tag>Keep on upgrade</Tag>}
                      {o.clientConfigPassword && <Tag color="teal">Config password</Tag>}
                      <Tag>Timeout {o.configureTimeoutSec} s</Tag>
                    </span>
                  ) },
                ]} />
              </FormSection>
              <FormSection title={`Profiles (${selected.length})`}>
                {selected.map((p) => (
                  <div key={p.id} className="sem-form-row" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
                    <div className="sem-row-inline"><span className="sem-strong">{p.settings.accountName}</span><AuthBadge type={p.settings.authType} /><Mono dim>{p.settings.host}:{p.settings.port} / {p.settings.hub}</Mono></div>
                    {credentialIssues(p, o.credentialMode).map((i) => (
                      <div key={i.text} style={{ color: i.level === "warn" ? "var(--sem-orange)" : "var(--sem-text-2)", fontSize: "var(--sem-fz-small)" }}>{i.level === "warn" ? "⚠ " : ""}{i.text}</div>
                    ))}
                  </div>
                ))}
              </FormSection>
              {o.credentialMode === "embedded" && selected.some((p) => p.settings.hasPassword || p.settings.authType === "certificate") && (
                <Callout tone="orange">This MSI will contain credentials that work like passwords. Distribute it only through trusted channels, and delete old builds you don’t need.</Callout>
              )}
              {firstBad !== -1 && <Callout tone="red">Step {firstBad + 1}: {stepErrors[firstBad].join(" ")}</Callout>}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}

// ------------------------------------------------------------------ page

export default function InstallersPage() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const installers = useInstallers();
  const packages = usePackages();
  const profiles = useProfiles();
  const caps = useCapabilities();
  const recheck = useRecheckCapabilities();
  const [checking, setChecking] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [wizard, setWizard] = useState(false);
  const [seed, setSeed] = useState<Seed | null>(null);
  const [logOf, setLogOf] = useState<BuildRecord | null>(null);
  const [guideOf, setGuideOf] = useState<BuildRecord | null>(null);

  const all = (installers.data ?? []) as unknown as BuildRecord[];
  const rows = useMemo(() => all.filter((b) => filter === "all" || (filter === "hub" ? isHubBuild(b) : !isHubBuild(b))), [all, filter]);
  const msiOk = caps.data?.msi.available;

  const pkgName = (id: number | null) => {
    const p = packages.data?.find((x) => x.id === id);
    return p ? `${p.filename} (${p.version}, ${p.arch})` : id === null ? "–" : `#${id} (deleted)`;
  };
  const profName = (id: number) => profiles.data?.find((p) => p.id === id)?.name ?? `#${id} (deleted)`;
  const contents = (b: BuildRecord) => isHubBuild(b)
    ? `${b.options.template ?? "–"} template`
    : b.profileIds.map(profName).join(", ");

  const recheckNow = async () => {
    setChecking(true);
    try {
      const r = await recheck();
      if (r.msi.available) notifySuccess(`Found ${toolLabel(r.msi)}`);
      else notifyError(new Error(r.msi.hint), "MSI tools still missing");
    } catch (e) { notifyError(e, "Couldn’t check the MSI tools"); } finally { setChecking(false); }
  };
  const save = async (b: BuildRecord) => {
    try {
      const r = await download(`/api/deploy/installers/${b.id}/download`);
      if (r.saved) notifySuccess(`Saved ${r.filePath?.split(/[\\/]/).pop() ?? buildFileName(b)}`);
    } catch (e) { notifyError(e, "Couldn’t save the file"); }
  };
  const newVersion = (b: BuildRecord) => {
    setSeed({
      name: b.name,
      packageId: packages.data?.some((p) => p.id === b.packageId) ? String(b.packageId) : null,
      profileIds: b.profileIds.filter((id) => profiles.data?.some((p) => p.id === id)).map(String),
      options: { ...DEFAULT_OPTIONS, ...(b.options as MsiOptions), upgradeCode: undefined, clientConfigPassword: undefined, productVersion: bumpVersion(b.productVersion) },
    });
    setWizard(true);
  };
  const remove = async (b: BuildRecord) => {
    const last = !isHubBuild(b) && all.filter((x) => !isHubBuild(x) && x.name === b.name).length === 1;
    const ok = await confirmAction({
      title: <>Delete “{buildFileName(b)}”?</>,
      message: "The file and its build record are deleted. Computers that already installed it aren’t affected.",
      details: last ? (
        <Callout tone="orange">
          This is the last build named “{b.name}”. Its upgrade code <Mono>{b.upgradeCode}</Mono> will be forgotten, so a later build with this name won’t upgrade existing installations unless you enter the code. Copy it first if you still deploy this installer.
        </Callout>
      ) : undefined,
      typeToConfirm: last ? b.name : undefined, typeLabel: last ? <>Type the installer name to confirm</> : undefined,
      confirmLabel: "Delete Installer", testId: "delete-installer",
    });
    if (!ok) return;
    try {
      await del(`/api/deploy/installers/${b.id}`);
      notifySuccess(`Deleted ${buildFileName(b)}`);
      void qc.invalidateQueries({ queryKey: ["deploy"] });
    } catch (e) { notifyError(e, "Couldn’t delete the installer"); }
  };

  const menu = (b: BuildRecord): ContextMenuItem[] => [
    { label: `Save ${KIND_SHORT[b.kind] ?? "File"}…`, icon: <IconDownload size={14} />, disabled: b.status !== "ready", onClick: () => void save(b), testId: "ctx-save" },
    { label: "Deployment Instructions…", icon: <IconRocket size={14} />, disabled: b.status !== "ready", onClick: () => setGuideOf(b), testId: "ctx-instructions" },
    { label: "Build Log…", icon: <IconFileText size={14} />, onClick: () => setLogOf(b), testId: "ctx-log" },
    ...(!isHubBuild(b) ? [{ label: "New Version…", icon: <IconRefresh size={14} />, disabled: msiOk === false, onClick: () => newVersion(b), testId: "ctx-new-version" }] : []),
    ...(isHubBuild(b) && b.hub ? [{ label: "Open Hub Client Deployment", icon: <IconPackageExport size={14} />, onClick: () => nav(`${hubBase(b.serverId!, b.hub!)}/deploy`) }] : []),
    { label: "Copy SHA-256", icon: <IconCopy size={14} />, disabled: !b.sha256, onClick: () => void navigator.clipboard.writeText(b.sha256 ?? "") },
    "divider",
    { label: "Delete…", icon: <IconTrash size={14} />, danger: true, onClick: () => void remove(b), testId: "ctx-delete" },
  ];

  const hubCount = all.filter(isHubBuild).length;

  return (
    <>
      <PageHeader
        title="MSI Installers"
        badge={<MsiToolBadge caps={caps.data} testId="msi-tool-badge" />}
        meta={installers.data ? <>{all.length - hubCount} custom {all.length - hubCount === 1 ? "installer" : "installers"} · {hubCount} hub {hubCount === 1 ? "package" : "packages"}</> : undefined}
        description="Silent Windows installers of the SoftEther VPN Client with your custom profiles, for Intune, Configuration Manager, Group Policy or msiexec."
        actions={(
          <Button leftSection={<IconPlus size={14} />} onClick={() => { setSeed(null); setWizard(true); }} disabled={msiOk === false} data-testid="create-installer">
            New Installer…
          </Button>
        )}
      />

      <div className="sem-callouts" style={{ marginTop: 0 }}>
        {caps.error && <ErrorState error={caps.error} inline onRetry={() => void caps.refetch()} />}
        {caps.data && !caps.data.msi.available && (
          <Callout tone="red" title="MSI and setup.exe builds aren’t available on this computer." testId="msi-missing"
            action={<Button size="xs" variant="default" loading={checking} onClick={recheckNow} data-testid="msi-recheck">Check Again</Button>}>
            {caps.data.msi.hint}
            <div className="sem-callout-detail">.vpn profiles still work.</div>
          </Callout>
        )}
        {caps.data && caps.data.msi.available && !caps.data.setupExe.available && (
          <Callout tone="yellow" title="setup.exe builds aren’t available." testId="exe-missing">{caps.data.setupExe.hint}</Callout>
        )}
        <Callout tone="gray" icon={<IconInfoCircle size={16} stroke={1.7} />}>
          Each MSI installs the files of a{" "}
          <a href={`#${deployBase}/packages`} onClick={(e) => { e.preventDefault(); nav(`${deployBase}/packages`); }}>client package</a>, registers the VPN Client service, creates the virtual adapter and imports the selected{" "}
          <a href={`#${deployBase}/profiles`} onClick={(e) => { e.preventDefault(); nav(`${deployBase}/profiles`); }}>custom profiles</a>, unattended as SYSTEM. Uninstalling removes all of it.
        </Callout>
      </div>

      <Section>
        <DataTable<BuildRecord>
          testId="installers-table"
          aria-label="Installers"
          data={installers.data ? rows : undefined}
          loading={installers.isLoading}
          error={installers.error}
          onRetry={() => void installers.refetch()}
          rowKey={(b) => b.id}
          rowTestId={(b) => `installer-${b.id}`}
          selectable="single"
          initialSort={{ key: "createdAt", dir: "desc" }}
          onRowOpen={(b) => (b.status === "ready" ? setGuideOf(b) : setLogOf(b))}
          rowTone={(b) => (b.status === "failed" ? "danger" : undefined)}
          contextMenu={menu}
          filters={(
            <SegmentedControl size="xs" value={filter} onChange={(v) => setFilter(v as Filter)} data-testid="installers-filter"
              data={[{ value: "all", label: "All" }, { value: "custom", label: "Custom MSI" }, { value: "hub", label: "Hub Packages" }]} />
          )}
          empty={{
            title: "No installers yet",
            description: "Add a client package and a custom profile, then choose New Installer…. Packages built from a hub’s Client Deployment page appear here too.",
            icon: <IconPackage size={28} stroke={1.4} />,
          }}
          columns={[
            { key: "name", title: "Name", width: 200, truncate: true, render: (b) => <span className="sem-strong" title={b.name}>{b.name}</span> },
            { key: "kind", title: "Type", width: 66, render: (b) => <Tag color={b.kind === "exe" ? "purple" : b.kind === "vpn" ? "teal" : "accent"}>{KIND_SHORT[b.kind] ?? b.kind}</Tag> },
            { key: "productVersion", title: "Version", width: 68, render: (b) => b.productVersion ? <Mono>{b.productVersion}</Mono> : <span className="sem-dim">–</span> },
            { key: "contents", title: "Contents", truncate: true, value: contents, render: (b) => <span title={isHubBuild(b) ? `${b.username ? `Package for ${b.username}` : "Hub-wide package"}, ${contents(b)}` : `Package ${pkgName(b.packageId)}`}>{contents(b)}</span> },
            {
              key: "cred", title: "Credentials", width: 140, value: (b) => b.options.credentialMode ?? b.options.credential ?? "",
              render: (b) => isHubBuild(b)
                ? (b.options.credential ? <PolicyBadge value={b.options.credential} /> : <span className="sem-dim">–</span>)
                : <Tag color={b.options.credentialMode === "embedded" ? "orange" : "gray"}>{CRED_LABEL[b.options.credentialMode as CredentialMode] ?? b.options.credentialMode}</Tag>,
            },
            { key: "status", title: "Status", width: 78, render: (b) => <BuildStatus status={b.status} /> },
            { key: "size", title: "Size", align: "right", width: 76, value: (b) => b.size ?? 0, render: (b) => <span className="sem-num">{bytes(b.size)}</span> },
            { key: "createdAt", title: "Built", width: 74, render: (b) => <span className="sem-dim" title={`${dt(b.createdAt)} by ${b.createdBy}`}>{agoShort(b.createdAt)}</span> },
          ]}
        />
      </Section>
      {installers.data && !installers.isLoading && packages.data && !packages.data.length && (
        <div className="sem-callouts">
          <Callout tone="yellow" action={<Button size="xs" variant="default" onClick={() => nav(`${deployBase}/packages`)}>Client Packages…</Button>}>There are no client packages yet, so nothing can be built.</Callout>
        </div>
      )}
      <NewInstallerSheet opened={wizard} onClose={() => setWizard(false)} seed={seed} onDeploy={setGuideOf} />
      <LogSheet build={logOf} onClose={() => setLogOf(null)} />
      <InstructionsSheet build={guideOf} onClose={() => setGuideOf(null)} />
    </>
  );
}
