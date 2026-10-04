import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert, Anchor, Badge, Button, Code, FileInput, Group, List, Modal, Select, Stack, Table, Text, Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconBrandGithub, IconFileZip, IconInfoCircle, IconTrash, IconUpload } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, Copyable, ErrorAlert, PageHeader, QueryState, ReadOnlyNotice } from "../../components/common";
import { del, get, post, upload } from "../../lib/api";
import { can, notifyError } from "../../lib/hooks";
import { ago, bytes, dt } from "../../lib/format";
import { deployKeys, useGlobalRole, useInstallers, usePackages, type ClientPackage } from "../../components/deploy/shared";

const ARCHS = [
  { value: "x64", label: "x64 (64-bit Intel/AMD)" },
  { value: "x86", label: "x86 (32-bit)" },
  { value: "arm64", label: "ARM64" },
];
const REQUIRED_FILES = ["vpnclient.exe", "vpncmd.exe", "hamcore.se2"];

interface Release { tag: string; name: string; publishedAt: string; assets: { name: string; url: string; size: number }[] }

const archOf = (name: string): "x64" | "x86" | "arm64" => (/arm64/i.test(name) ? "arm64" : /x86/i.test(name) ? "x86" : "x64");

function EditionBadge({ edition }: { edition: string }) {
  return edition === "dev"
    ? <Tooltip label="Developer Edition 5.x (service SEVPNCLIENTDEV)"><Badge variant="light" color="violet">Developer 5.x</Badge></Tooltip>
    : <Tooltip label="Stable Edition 4.x (service SEVPNCLIENT)"><Badge variant="light" color="blue">Stable 4.x</Badge></Tooltip>;
}

function UploadModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [arch, setArch] = useState<string>("x64");
  const [edition, setEdition] = useState<string>("auto");
  const up = useMutation({
    mutationFn: () => upload<ClientPackage>("/api/deploy/packages", file!, { arch, ...(edition !== "auto" ? { edition } : {}) }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: deployKeys.packages });
      notifications.show({ color: "green", message: `Package ${p.filename} (${p.version}, ${p.files.length} files) added` });
      setFile(null); onClose();
    },
    onError: (e) => notifyError(e, "Upload rejected"),
  });
  return (
    <Modal opened={opened} onClose={onClose} title="Upload client package" size="lg" centered>
      <Stack>
        <Text size="sm">Accepted files:</Text>
        <List size="sm" spacing={2}>
          <List.Item>The official <b>SoftEther VPN Client installer</b> (<Code>softether-vpnclient-*.exe</Code>). The client files are extracted from its embedded resources; the installer itself is never run.</List.Item>
          <List.Item>A <b>ZIP archive</b> containing <Code>vpnclient.exe</Code>, <Code>vpncmd.exe</Code>, <Code>hamcore.se2</Code> and optionally <Code>vpncmgr.exe</Code> (e.g. your own Windows build).</List.Item>
        </List>
        <FileInput label="Installer or ZIP" required placeholder="Choose file…" accept=".exe,.zip" value={file} onChange={setFile} clearable
          leftSection={<IconFileZip size={16} />} data-testid="package-file" />
        <Select label="Architecture" data={ARCHS} value={arch} onChange={(v) => setArch(v ?? "x64")} allowDeselect={false} data-testid="package-arch"
          description="Must match the binaries: the MSI is built for this platform. Official installers name it in the file name." />
        <Select label="Edition" value={edition} onChange={(v) => setEdition(v ?? "auto")} allowDeselect={false}
          data={[{ value: "auto", label: "Detect automatically" }, { value: "dev", label: "Developer Edition 5.x" }, { value: "stable", label: "Stable Edition 4.x" }]}
          description="Determines the Windows service and registry names used by the MSI. Override only if detection is wrong." />
        {file && <Text size="xs" c="dimmed">{file.name} — {bytes(file.size)}</Text>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button leftSection={<IconUpload size={16} />} disabled={!file} loading={up.isPending} onClick={() => up.mutate()} data-testid="package-upload-submit">Upload</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function GithubModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const releases = useQuery({ queryKey: ["deploy", "releases"], queryFn: () => get<Release[]>("/api/deploy/releases"), enabled: opened, staleTime: 10 * 60_000, retry: false });
  const [busy, setBusy] = useState<string | null>(null);
  const imp = useMutation({
    mutationFn: (a: { url: string; arch: string }) => post<ClientPackage>("/api/deploy/packages/import", a),
    onMutate: (a) => setBusy(a.url),
    onSettled: () => setBusy(null),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: deployKeys.packages });
      notifications.show({ color: "green", message: `Imported ${p.filename} (${p.version})` });
      onClose();
    },
    onError: (e) => notifyError(e, "Import failed"),
  });
  return (
    <Modal opened={opened} onClose={onClose} title="Import from GitHub releases" size="xl" centered>
      <Stack>
        <Text size="sm" c="dimmed">
          Latest Windows client installers published at <Anchor href="https://github.com/SoftEtherVPN/SoftEtherVPN/releases" target="_blank" rel="noreferrer">github.com/SoftEtherVPN/SoftEtherVPN</Anchor> (Developer Edition).
          The server downloads the asset directly from GitHub (about 50 MB) and extracts the client files; only official SoftEtherVPN URLs are accepted.
        </Text>
        <QueryState query={releases}>
          {releases.data?.length === 0 && <Text c="dimmed" size="sm">No releases with Windows client installers found.</Text>}
          {releases.data?.map((r) => (
            <div key={r.tag}>
              <Group gap="xs" mb={4}><Text fw={600}>{r.name || r.tag}</Text><Badge variant="outline" color="gray">{r.tag}</Badge><Text size="xs" c="dimmed">{dt(r.publishedAt)}</Text></Group>
              <Table verticalSpacing={4} data-testid="github-assets">
                <Table.Tbody>
                  {r.assets.map((a) => (
                    <Table.Tr key={a.url}>
                      <Table.Td><Text size="sm" ff="monospace">{a.name}</Text></Table.Td>
                      <Table.Td><Badge variant="light" color="gray">{archOf(a.name)}</Badge></Table.Td>
                      <Table.Td ta="right"><Text size="sm">{bytes(a.size)}</Text></Table.Td>
                      <Table.Td ta="right">
                        <Button size="xs" variant="light" leftSection={<IconBrandGithub size={14} />} loading={busy === a.url} disabled={!!busy && busy !== a.url}
                          onClick={() => imp.mutate({ url: a.url, arch: archOf(a.name) })}>Import</Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          ))}
        </QueryState>
      </Stack>
    </Modal>
  );
}

function PackageDetails({ pkg, onClose }: { pkg: ClientPackage | null; onClose: () => void }) {
  return (
    <Modal opened={!!pkg} onClose={onClose} title={pkg ? `Package ${pkg.filename}` : ""} size="xl" centered>
      {pkg && (
        <Stack>
          <Table withRowBorders={false} verticalSpacing={4}>
            <Table.Tbody>
              <Table.Tr><Table.Td w={180}><Text size="sm" c="dimmed">Version</Text></Table.Td><Table.Td>{pkg.version}</Table.Td></Table.Tr>
              <Table.Tr><Table.Td><Text size="sm" c="dimmed">Edition / architecture</Text></Table.Td><Table.Td><Group gap={6}><EditionBadge edition={pkg.edition} /><Badge variant="light" color="gray">{pkg.arch}</Badge></Group></Table.Td></Table.Tr>
              <Table.Tr><Table.Td><Text size="sm" c="dimmed">Source file</Text></Table.Td><Table.Td>{pkg.filename} ({bytes(pkg.size)})</Table.Td></Table.Tr>
              <Table.Tr><Table.Td><Text size="sm" c="dimmed">Source SHA-256</Text></Table.Td><Table.Td><Copyable value={pkg.sha256} /></Table.Td></Table.Tr>
              <Table.Tr><Table.Td><Text size="sm" c="dimmed">Origin</Text></Table.Td><Table.Td>{pkg.source === "github" ? <Anchor href={pkg.url} target="_blank" rel="noreferrer" size="sm">{pkg.url}</Anchor> : "Uploaded file"}</Table.Td></Table.Tr>
              <Table.Tr><Table.Td><Text size="sm" c="dimmed">Added</Text></Table.Td><Table.Td>{dt(pkg.createdAt)} by {pkg.uploadedBy}</Table.Td></Table.Tr>
            </Table.Tbody>
          </Table>
          <Text fw={600}>Extracted files</Text>
          <Table striped data-testid="package-files">
            <Table.Thead><Table.Tr><Table.Th>File</Table.Th><Table.Th ta="right">Size</Table.Th><Table.Th>SHA-256</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {pkg.files.map((f) => (
                <Table.Tr key={f.name}>
                  <Table.Td><Text size="sm" ff="monospace">{f.name}</Text></Table.Td>
                  <Table.Td ta="right"><Text size="sm">{bytes(f.size)}</Text></Table.Td>
                  <Table.Td><Copyable value={f.sha256} /></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Text size="xs" c="dimmed">Compare these hashes with a trusted installation to verify the binaries before distributing them.</Text>
        </Stack>
      )}
    </Modal>
  );
}

export default function PackagesPage() {
  const role = useGlobalRole();
  const isAdmin = can(role, "admin");
  const qc = useQueryClient();
  const packages = usePackages();
  const installers = useInstallers();
  const [uploading, setUploading] = useState(false);
  const [github, setGithub] = useState(false);
  const [details, setDetails] = useState<ClientPackage | null>(null);

  const remove = useMutation({
    mutationFn: (p: ClientPackage) => del(`/api/deploy/packages/${p.id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: deployKeys.packages }); notifications.show({ color: "green", message: "Package deleted" }); },
    onError: (e) => notifyError(e, "Could not delete package"),
  });
  const usedBy = (id: number) => (installers.data ?? []).filter((b) => b.packageId === id);

  return (
    <>
      <PageHeader
        title="Client packages"
        description="SoftEther VPN Client binaries used to build MSI installers."
        actions={isAdmin && (
          <>
            <Button variant="light" leftSection={<IconBrandGithub size={16} />} onClick={() => setGithub(true)} data-testid="import-github">Import from GitHub</Button>
            <Button leftSection={<IconUpload size={16} />} onClick={() => setUploading(true)} data-testid="upload-package">Upload package</Button>
          </>
        )}
      />
      {!isAdmin && <ReadOnlyNotice role={role} />}
      <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />} mb="md" title="Why packages are needed">
        The official SoftEther installer (<Code>vpnsetup</Code>) is a wizard with no silent mode, so it cannot be pushed by Intune, SCCM or GPO.
        SoftEther Manager instead repackages the client files (<Code>vpnclient.exe</Code>, <Code>vpncmd.exe</Code>, <Code>vpncmgr.exe</Code>,{" "}
        <Code>hamcore.se2</Code>) into its own MSI, which installs the service and imports your connection profiles unattended.
        Add a package once per client version and architecture.
      </Alert>
      <QueryState query={packages}>
        <DataTable
          testId="packages-table"
          data={packages.data}
          rowKey={(p) => p.id}
          onRowClick={setDetails}
          initialSort={{ key: "createdAt", dir: "desc" }}
          empty={isAdmin ? "No packages yet. Upload the official client installer or import it from GitHub." : "No packages yet."}
          columns={[
            { key: "filename", title: "File", render: (p) => <Text size="sm" fw={600} ff="monospace">{p.filename}</Text> },
            { key: "edition", title: "Edition", render: (p) => <EditionBadge edition={p.edition} /> },
            { key: "arch", title: "Arch", render: (p) => <Badge variant="light" color="gray">{p.arch}</Badge> },
            { key: "version", title: "Version" },
            {
              key: "files", title: "Files", value: (p) => p.files.map((f) => f.name).join(" "),
              render: (p) => {
                const missing = REQUIRED_FILES.filter((n) => !p.files.some((f) => f.name.toLowerCase() === n));
                return (
                  <Tooltip label={<Stack gap={0}>{p.files.map((f) => <Text key={f.name} size="xs">{f.name} — {bytes(f.size)}</Text>)}</Stack>}>
                    <Group gap={4}>
                      <Text size="sm">{p.files.length} files, {bytes(p.files.reduce((a, f) => a + f.size, 0))}</Text>
                      {missing.length > 0 && <Badge size="xs" color="red" variant="light">missing {missing.join(", ")}</Badge>}
                      {!p.files.some((f) => f.name === "vpncmgr.exe") && <Badge size="xs" color="gray" variant="light">no GUI</Badge>}
                    </Group>
                  </Tooltip>
                );
              },
            },
            { key: "sha256", title: "SHA-256", render: (p) => <Tooltip label={p.sha256}><Code>{p.sha256.slice(0, 12)}…</Code></Tooltip> },
            {
              key: "source", title: "Source",
              render: (p) => p.source === "github"
                ? <Badge variant="light" color="dark" leftSection={<IconBrandGithub size={12} />}>GitHub</Badge>
                : <Badge variant="light" color="gray">Upload</Badge>,
            },
            { key: "createdAt", title: "Added", value: (p) => p.createdAt, render: (p) => <Tooltip label={dt(p.createdAt)}><Text size="sm">{ago(p.createdAt)} · {p.uploadedBy}</Text></Tooltip> },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (p) => isAdmin && (
                <Group justify="flex-end" onClick={(e) => e.stopPropagation()}>
                  <ConfirmButton
                    title={`Delete package ${p.filename}?`}
                    message={
                      <>
                        The extracted client files are removed. Existing MSI files stay downloadable, but they can no longer be rebuilt from this package.
                        {usedBy(p.id).length > 0 && <Text size="sm" c="orange" mt="xs">Used by {usedBy(p.id).length} installer build(s): {usedBy(p.id).map((b) => `${b.name} ${b.productVersion}`).join(", ")}.</Text>}
                      </>
                    }
                    typeToConfirm={p.filename}
                    confirmLabel="Delete package"
                    onConfirm={() => remove.mutateAsync(p)}
                    leftSection={<IconTrash size={14} />}
                  >Delete</ConfirmButton>
                </Group>
              ),
            },
          ]}
        />
      </QueryState>
      {installers.error && <ErrorAlert error={installers.error} />}
      <UploadModal opened={uploading} onClose={() => setUploading(false)} />
      <GithubModal opened={github} onClose={() => setGithub(false)} />
      <PackageDetails pkg={details} onClose={() => setDetails(null)} />
    </>
  );
}
