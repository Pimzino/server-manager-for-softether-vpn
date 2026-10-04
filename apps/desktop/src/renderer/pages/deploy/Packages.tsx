// Client Deployment › Client Packages: the SoftEther VPN Client binaries that MSI installers and setup.exe
// packages are built from. Add one from a file (native Open dialog) or import an official GitHub release.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Select } from "@mantine/core";
import { IconBox, IconBrandGithub, IconCopy, IconExternalLink, IconInfoCircle, IconTrash, IconUpload } from "@tabler/icons-react";
import { del, get, openExternal, post, upload } from "../../lib/api";
import { agoShort, bytes, dt } from "../../lib/format";
import { notifyError, notifySuccess } from "../../lib/hooks";
import {
  confirmAction, CopyField, DataTable, ErrorState, FormRow, FormSection, Inspector, Mono, PageHeader, PropertyList, Section, Sheet, TableSkeleton, Tag,
} from "../../design";
import { deployKeys, useInstallers, usePackages, type ClientPackage } from "../../components/domain/deploy";
import { Callout } from "../../components/domain/ui";
import { EditionTag, REQUIRED_FILES, SheetFooter, SourceTag } from "./_deployment/shared";

const ARCHS = [
  { value: "x64", label: "x64 (64-bit Intel/AMD)" },
  { value: "x86", label: "x86 (32-bit)" },
  { value: "arm64", label: "ARM64" },
];
const RELEASES_URL = "https://github.com/SoftEtherVPN/SoftEtherVPN/releases";

interface Release { tag: string; name: string; publishedAt: string; assets: { name: string; url: string; size: number }[] }
interface Asset { key: string; name: string; url: string; size: number; tag: string; release: string; publishedAt: string; arch: "x64" | "x86" | "arm64" }

const archOf = (name: string): "x64" | "x86" | "arm64" => (/arm64/i.test(name) ? "arm64" : /x86/i.test(name) ? "x86" : "x64");
const missingOf = (p: ClientPackage) => REQUIRED_FILES.filter((n) => !p.files.some((f) => f.name.toLowerCase() === n));
const hasGui = (p: ClientPackage) => p.files.some((f) => f.name.toLowerCase() === "vpncmgr.exe");

// ------------------------------------------------------------------ add from a file

function AddPackageSheet({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [arch, setArch] = useState("x64");
  const [edition, setEdition] = useState("auto");
  const [busy, setBusy] = useState(false);
  const choose = async () => {
    setBusy(true);
    try {
      const p = await upload<ClientPackage>("/api/deploy/packages", {
        title: "Choose a SoftEther VPN Client Installer or ZIP",
        fields: { arch, ...(edition !== "auto" ? { edition } : {}) },
        filters: [{ name: "Client Installer or ZIP", extensions: ["exe", "zip"] }, { name: "All Files", extensions: ["*"] }],
      });
      if (!p) return;
      void qc.invalidateQueries({ queryKey: deployKeys.packages });
      notifySuccess(`Added ${p.filename} (${p.version}, ${p.files.length} files)`);
      onClose();
    } catch (e) {
      notifyError(e, "Couldn’t add the package");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      opened={opened} onClose={onClose} busy={busy} size={600} testId="package-upload"
      icon={<IconUpload size={19} stroke={1.5} />} title="Add Client Package" subtitle="From a file on this computer"
      footer={(
        <SheetFooter>
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button onClick={choose} loading={busy} data-testid="package-upload-submit">Choose File…</Button>
        </SheetFooter>
      )}
    >
      <div className="sem-stack">
        <div>
          <div className="sem-sheet-lead">Accepted files</div>
          <ul className="sem-sheet-text" style={{ margin: 0, paddingLeft: "var(--sem-space-7)" }}>
            <li>The official <b>SoftEther VPN Client installer</b> (<code className="sem-code-inline">softether-vpnclient-*.exe</code>). Its files are extracted; it’s never run.</li>
            <li>A <b>ZIP archive</b> with <code className="sem-code-inline">vpnclient.exe</code>, <code className="sem-code-inline">vpncmd.exe</code>, <code className="sem-code-inline">hamcore.se2</code> and optionally <code className="sem-code-inline">vpncmgr.exe</code>.</li>
          </ul>
        </div>
        <FormSection>
          <FormRow label="Architecture" description="Must match the binaries. Official installers name it in the file name.">
            {(id) => <Select id={id} w={240} data={ARCHS} value={arch} onChange={(v) => setArch(v ?? "x64")} allowDeselect={false} data-testid="package-arch" />}
          </FormRow>
          <FormRow label="Edition" description="Sets the Windows service and registry names the MSI uses. Change it only if detection is wrong.">
            {(id) => (
              <Select id={id} w={240} value={edition} onChange={(v) => setEdition(v ?? "auto")} allowDeselect={false} data-testid="package-edition"
                data={[{ value: "auto", label: "Detect automatically" }, { value: "dev", label: "Developer Edition 5.x" }, { value: "stable", label: "Stable Edition 4.x" }]} />
            )}
          </FormRow>
        </FormSection>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ import from GitHub

function GithubSheet({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const releases = useQuery({ queryKey: ["deploy", "releases"], queryFn: () => get<Release[]>("/api/deploy/releases"), enabled: opened, staleTime: 10 * 60_000, retry: false });
  const [selected, setSelected] = useState<(string | number)[]>([]);
  const [busy, setBusy] = useState(false);
  const assets = useMemo<Asset[]>(() => (releases.data ?? []).flatMap((r) => r.assets.map((a) => ({
    key: a.url, name: a.name, url: a.url, size: a.size, tag: r.tag, release: r.name || r.tag, publishedAt: r.publishedAt, arch: archOf(a.name),
  }))), [releases.data]);
  const pick = assets.find((a) => a.key === selected[0]);

  const importAsset = async (a: Asset | undefined) => {
    if (!a) return;
    setBusy(true);
    try {
      const p = await post<ClientPackage>("/api/deploy/packages/import", { url: a.url, arch: a.arch });
      void qc.invalidateQueries({ queryKey: deployKeys.packages });
      notifySuccess(`Imported ${p.filename} (${p.version})`);
      onClose();
    } catch (e) {
      notifyError(e, "Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={busy} size={780} testId="github-import"
      icon={<IconBrandGithub size={19} stroke={1.5} />} title="Import from GitHub"
      subtitle="Official SoftEther VPN Client installers (Developer Edition)"
      footer={(
        <SheetFooter leading={<Button variant="subtle" size="xs" leftSection={<IconExternalLink size={13} />} onClick={() => void openExternal(RELEASES_URL)}>Open Releases Page</Button>}>
          <Button variant="default" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void importAsset(pick)} disabled={!pick} loading={busy} data-testid="github-import-submit">Import</Button>
        </SheetFooter>
      )}
    >
      <div className="sem-stack">
        <p className="sem-sheet-text">
          The installer (about 50 MB) is downloaded straight from GitHub and its client files are extracted. Only official SoftEtherVPN release assets are accepted.
        </p>
        {busy && <Callout tone="accent" title={`Downloading ${pick?.name}…`}>This can take a minute on a slow connection.</Callout>}
        {releases.error ? <ErrorState error={releases.error} inline onRetry={() => void releases.refetch()} /> : releases.isLoading ? <TableSkeleton rows={5} columns={4} /> : (
          <DataTable<Asset>
            testId="github-assets" aria-label="Release assets"
            data={assets} rowKey={(a) => a.key} rowTestId={(a) => `github-asset-${a.name}`}
            selectable="single" selection={selected} onSelectionChange={(k) => setSelected(k)}
            onRowOpen={(a) => void importAsset(a)} searchable={assets.length > 8} maxHeight={360} footer={false}
            empty={{ title: "No Windows client installers found", description: "The latest releases don’t include VPN Client installers." }}
            columns={[
              { key: "name", title: "Installer", truncate: true, render: (a) => <Mono>{a.name}</Mono> },
              { key: "release", title: "Release", width: 170, truncate: true, render: (a) => <span title={a.release}>{a.tag}</span> },
              { key: "arch", title: "Arch", width: 70, render: (a) => <Tag>{a.arch}</Tag> },
              { key: "publishedAt", title: "Published", width: 100, render: (a) => <span className="sem-dim" title={dt(a.publishedAt)}>{agoShort(a.publishedAt)}</span> },
              { key: "size", title: "Size", width: 80, align: "right", render: (a) => <span className="sem-num">{bytes(a.size)}</span> },
            ]}
          />
        )}
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------ details

function PackageInspector({ pkg, onClose, usedBy }: { pkg: ClientPackage | null; onClose: () => void; usedBy: number }) {
  return (
    <Inspector opened={!!pkg} onClose={onClose} title={pkg?.filename ?? ""} subtitle={pkg ? `${pkg.version} · ${pkg.arch}` : undefined} icon={<IconBox size={18} stroke={1.5} />} width={460} testId="package-details">
      {pkg && (
        <div className="sem-stack">
          <PropertyList labelWidth={120} items={[
            { label: "Version", value: pkg.version },
            { label: "Edition", value: <EditionTag edition={pkg.edition} /> },
            { label: "Architecture", value: <Tag>{pkg.arch}</Tag> },
            { label: "Installer size", value: bytes(pkg.size) },
            { label: "SHA-256", value: <CopyField value={pkg.sha256} display={`${pkg.sha256.slice(0, 20)}…`} size="sm" /> },
            { label: "Origin", value: pkg.source === "github" && pkg.url
              ? <a href={pkg.url} onClick={(e) => { e.preventDefault(); void openExternal(pkg.url!); }}>GitHub release</a>
              : "Uploaded file" },
            { label: "Added", value: <>{dt(pkg.createdAt)}{pkg.uploadedBy ? <span className="sem-dim"> by {pkg.uploadedBy}</span> : null}</> },
            { label: "Used by", value: usedBy ? `${usedBy} installer build${usedBy === 1 ? "" : "s"}` : "No builds" },
          ]} />
          <div>
            <div className="sem-sheet-lead">Extracted files</div>
            <DataTable
              testId="package-files" aria-label="Extracted files" data={pkg.files} rowKey={(f) => f.name} searchable={false} footer={false}
              columns={[
                { key: "name", title: "File", render: (f) => <Mono>{f.name}</Mono> },
                { key: "size", title: "Size", align: "right", width: 80, render: (f) => <span className="sem-num">{bytes(f.size)}</span> },
                { key: "sha256", title: "SHA-256", width: 120, sortable: false, render: (f) => <CopyField value={f.sha256} display={`${f.sha256.slice(0, 8)}…`} size="sm" /> },
              ]}
            />
          </div>
          <div className="sem-dim">Compare these hashes with a trusted installation before you distribute the binaries.</div>
        </div>
      )}
    </Inspector>
  );
}

// ------------------------------------------------------------------ page

export default function PackagesPage() {
  const qc = useQueryClient();
  const packages = usePackages();
  const installers = useInstallers();
  const [adding, setAdding] = useState(false);
  const [github, setGithub] = useState(false);
  const [details, setDetails] = useState<ClientPackage | null>(null);
  const usedBy = (id: number) => (installers.data ?? []).filter((b) => b.packageId === id);

  const remove = async (p: ClientPackage) => {
    const used = usedBy(p.id);
    const ok = await confirmAction({
      title: <>Delete the package “{p.filename}”?</>,
      message: "The extracted client files are removed. Installers already built stay available, but they can’t be rebuilt from this package.",
      details: used.length ? <Callout tone="orange">Used by {used.length} installer build{used.length === 1 ? "" : "s"}: {used.map((b) => `${b.name} ${b.productVersion}`).join(", ")}.</Callout> : undefined,
      typeToConfirm: p.filename, typeLabel: <>Type the file name to confirm</>, confirmLabel: "Delete Package", testId: "delete-package",
    });
    if (!ok) return;
    try {
      await del(`/api/deploy/packages/${p.id}`);
      if (details?.id === p.id) setDetails(null);
      notifySuccess(`Deleted ${p.filename}`);
      void qc.invalidateQueries({ queryKey: deployKeys.packages });
    } catch (e) { notifyError(e, "Couldn’t delete the package"); }
  };

  const rows = packages.data ?? [];
  return (
    <>
      <PageHeader
        title="Client Packages"
        meta={packages.data ? <>{rows.length} {rows.length === 1 ? "package" : "packages"}{rows[0] ? <> · newest {rows[0].version} ({rows[0].arch})</> : null}</> : undefined}
        description="SoftEther VPN Client binaries that MSI installers and setup.exe packages are built from."
        actions={(
          <>
            <Button variant="default" leftSection={<IconBrandGithub size={14} />} onClick={() => setGithub(true)} data-testid="import-github">Import from GitHub…</Button>
            <Button leftSection={<IconUpload size={14} />} onClick={() => setAdding(true)} data-testid="upload-package">Add Package…</Button>
          </>
        )}
      />
      <div className="sem-callouts" style={{ marginTop: 0 }}>
        <Callout tone="gray" icon={<IconInfoCircle size={16} stroke={1.7} />} title="Why packages are needed">
          SoftEther’s own installer is a wizard without a silent mode, so Intune, Configuration Manager and Group Policy can’t push it.
          This app repackages the client files into its own MSI, which installs the service and imports the profiles unattended.
          Add one package per client version and architecture.
        </Callout>
      </div>
      <Section>
        <DataTable<ClientPackage>
          testId="packages-table"
          aria-label="Client packages"
          data={packages.data}
          loading={packages.isLoading}
          error={packages.error}
          onRetry={() => void packages.refetch()}
          rowKey={(p) => p.id}
          rowTestId={(p) => `package-${p.id}`}
          selectable="single"
          initialSort={{ key: "createdAt", dir: "desc" }}
          onRowOpen={setDetails}
          searchable={rows.length > 8}
          empty={{
            title: "No client packages",
            description: "Add the official client installer from a file, or import it from GitHub.",
            icon: <IconBox size={28} stroke={1.4} />,
            action: <Button size="xs" variant="default" onClick={() => setAdding(true)}>Add Package…</Button>,
          }}
          contextMenu={(p) => [
            { label: "Show Details", icon: <IconInfoCircle size={14} />, onClick: () => setDetails(p), testId: "ctx-details" },
            { label: "Copy SHA-256", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(p.sha256) },
            ...(p.url ? [{ label: "Open on GitHub", icon: <IconExternalLink size={14} />, onClick: () => void openExternal(p.url!) }] : []),
            "divider",
            { label: "Delete…", icon: <IconTrash size={14} />, danger: true, onClick: () => void remove(p), testId: "ctx-delete" },
          ]}
          columns={[
            { key: "filename", title: "File", truncate: true, render: (p) => <span className="sem-strong sem-mono" title={p.filename}>{p.filename}</span> },
            { key: "edition", title: "Edition", width: 108, render: (p) => <EditionTag edition={p.edition} /> },
            { key: "arch", title: "Arch", width: 64, render: (p) => <Tag>{p.arch}</Tag> },
            { key: "version", title: "Version", width: 96, truncate: true, render: (p) => p.version ? <Mono>{p.version}</Mono> : <span className="sem-dim">–</span> },
            {
              key: "files", title: "Contents", width: 170, value: (p) => p.files.reduce((a, f) => a + f.size, 0),
              render: (p) => {
                const missing = missingOf(p);
                return (
                  <span className="sem-row-inline" style={{ flexWrap: "nowrap" }} title={p.files.map((f) => `${f.name} — ${bytes(f.size)}`).join("\n")}>
                    <span className="sem-num">{p.files.length} files · {bytes(p.files.reduce((a, f) => a + f.size, 0))}</span>
                    {missing.length > 0 && <Tag color="red" title={`Missing ${missing.join(", ")}`}>Incomplete</Tag>}
                    {missing.length === 0 && !hasGui(p) && <Tag title="No vpncmgr.exe: no Start menu shortcut">No GUI</Tag>}
                  </span>
                );
              },
            },
            { key: "source", title: "Source", width: 82, render: (p) => <SourceTag source={p.source} /> },
            { key: "createdAt", title: "Added", width: 80, render: (p) => <span className="sem-dim" title={`${dt(p.createdAt)} by ${p.uploadedBy}`}>{agoShort(p.createdAt)}</span> },
          ]}
        />
      </Section>
      {installers.error && <ErrorState error={installers.error} inline onRetry={() => void installers.refetch()} />}
      <AddPackageSheet opened={adding} onClose={() => setAdding(false)} />
      <GithubSheet opened={github} onClose={() => setGithub(false)} />
      <PackageInspector pkg={details} onClose={() => setDetails(null)} usedBy={details ? usedBy(details.id).length : 0} />
    </>
  );
}
