import { useMemo, useState } from "react";
import {
  Alert, Badge, Box, Button, Code, FileButton, Group, Highlight, Modal, ScrollArea, SegmentedControl, Select, Stack, Switch, Tabs, Text, TextInput, Textarea, Tooltip,
} from "@mantine/core";
import {
  IconAlertTriangle, IconArrowsDiff, IconDatabase, IconDownload, IconEye, IconHistory, IconLock, IconPlus, IconRestore, IconSearch, IconUpload,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { notifications } from "@mantine/notifications";
import { DataTable } from "../../components/DataTable";
import { ConfirmButton, Empty, ErrorAlert, PageHeader, QueryState, Section } from "../../components/common";
import { useServerAccess } from "../../components/server-b/ui";
import { download, get, post, type ApiError } from "../../lib/api";
import { notifyError, useRpc, useScope } from "../../lib/hooks";
import { ago, b64ToText, bytes, downloadText, dt } from "../../lib/format";

interface Backup { id: number; createdAt: number; createdBy: string; sha256: string; size: number; note: string }
interface BackupFull extends Backup { content: string }
type DiffLine = { type: "same" | "add" | "del"; text: string; a?: number; b?: number } | { type: "skip"; count: number };
interface Diff { changed: number; lines: DiffLine[] }

function safe(s: string) { return s.replace(/[^\w.-]/g, "_"); }

/** Line-numbered, searchable text view. */
function TextView({ text, height = 560, testId }: { text: string; height?: number | string; testId?: string }) {
  const [q, setQ] = useState("");
  const [only, setOnly] = useState(false);
  const lines = useMemo(() => text.split(/\r?\n/), [text]);
  const needle = q.trim().toLowerCase();
  const hits = useMemo(() => (needle ? lines.filter((l) => l.toLowerCase().includes(needle)).length : 0), [lines, needle]);
  const shown = lines.map((l, i) => [i, l] as const).filter(([, l]) => !only || !needle || l.toLowerCase().includes(needle));
  return (
    <Stack gap="xs">
      <Group gap="xs">
        <TextInput size="xs" placeholder="Search…" leftSection={<IconSearch size={14} />} value={q} onChange={(e) => setQ(e.currentTarget.value)} w={260} data-testid={testId ? `${testId}-search` : undefined} />
        {needle && <Badge variant="light" color={hits ? "yellow" : "gray"} data-testid={testId ? `${testId}-hits` : undefined}>{hits} matching line(s)</Badge>}
        <Switch size="xs" label="Only matching lines" checked={only} onChange={(e) => setOnly(e.currentTarget.checked)} disabled={!needle} />
        <Text size="xs" c="dimmed">{lines.length.toLocaleString()} lines · {bytes(new TextEncoder().encode(text).length)}</Text>
      </Group>
      <ScrollArea h={height} type="auto" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 6 }}>
        <Box component="pre" m={0} p="xs" style={{ fontFamily: "var(--mantine-font-family-monospace)", fontSize: 12, lineHeight: 1.45, tabSize: 4 }} data-testid={testId}>
          {shown.map(([i, l]) => {
            const hit = !!needle && l.toLowerCase().includes(needle);
            return (
              <div key={i} style={{ display: "flex", gap: 12, background: hit ? "var(--mantine-color-yellow-light)" : undefined }}>
                <span style={{ color: "var(--mantine-color-dimmed)", userSelect: "none", minWidth: 44, textAlign: "right" }}>{i + 1}</span>
                {hit ? <Highlight highlight={q.trim()} component="span" ff="monospace" fz={12}>{l}</Highlight> : <span>{l}</span>}
              </div>
            );
          })}
        </Box>
      </ScrollArea>
    </Stack>
  );
}

function LiveConfig({ serverId, serverName }: { serverId: number; serverName: string }) {
  const q = useRpc<{ FileName_str?: string; FileData_bin?: string }>(serverId, "GetConfig");
  const text = useMemo(() => b64ToText(q.data?.FileData_bin), [q.data]);
  const fname = (q.data?.FileName_str || "vpn_server.config").replace(/^\$/, "");
  return (
    <Section
      title="Live configuration"
      description={<>The current <Code>{fname}</Code> as reported by the server (GetConfig). It contains password hashes and keys — treat downloads as secrets.</>}
      actions={q.data && (
        <>
          <Button size="xs" variant="default" onClick={() => q.refetch()} loading={q.isFetching}>Reload</Button>
          <Button size="xs" variant="light" leftSection={<IconDownload size={14} />} onClick={() => downloadText(`${safe(serverName)}-${fname}`, text)} data-testid="download-live-config">Download</Button>
        </>
      )}
    >
      <QueryState query={q}>
        <TextView text={text} testId="live-config" />
      </QueryState>
    </Section>
  );
}

function DiffView({ diff, aLabel, bLabel }: { diff: Diff; aLabel: string; bLabel: string }) {
  if (diff.changed === 0) return <Alert color="green" variant="light" data-testid="diff-identical">No differences between {aLabel} and {bLabel}.</Alert>;
  const adds = diff.lines.filter((l) => l.type === "add").length;
  const dels = diff.lines.filter((l) => l.type === "del").length;
  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Badge color="green" variant="light">+{adds}</Badge>
        <Badge color="red" variant="light">−{dels}</Badge>
        <Text size="xs" c="dimmed"><Text span c="red" size="xs">− {aLabel}</Text> · <Text span c="green" size="xs">+ {bLabel}</Text></Text>
      </Group>
      <ScrollArea h="calc(100vh - 260px)" type="auto" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 6 }}>
        <Box component="table" style={{ borderCollapse: "collapse", width: "100%", fontFamily: "var(--mantine-font-family-monospace)", fontSize: 12, lineHeight: 1.45 }} data-testid="diff-view">
          <tbody>
            {diff.lines.map((l, i) => {
              if (l.type === "skip") {
                return (
                  <tr key={i} style={{ background: "var(--mantine-color-blue-light)" }}>
                    <td colSpan={4} style={{ padding: "2px 8px", color: "var(--mantine-color-blue-light-color)" }}>⋯ {l.count.toLocaleString()} unchanged line(s)</td>
                  </tr>
                );
              }
              const bg = l.type === "add" ? "var(--mantine-color-green-light)" : l.type === "del" ? "var(--mantine-color-red-light)" : undefined;
              const sign = l.type === "add" ? "+" : l.type === "del" ? "−" : " ";
              return (
                <tr key={i} style={{ background: bg }} data-difftype={l.type}>
                  <td style={{ width: 52, textAlign: "right", padding: "0 6px", color: "var(--mantine-color-dimmed)", userSelect: "none" }}>{l.a ?? ""}</td>
                  <td style={{ width: 52, textAlign: "right", padding: "0 6px", color: "var(--mantine-color-dimmed)", userSelect: "none" }}>{l.b ?? ""}</td>
                  <td style={{ width: 16, textAlign: "center", userSelect: "none", fontWeight: 700 }}>{sign}</td>
                  <td style={{ whiteSpace: "pre", padding: "0 6px", tabSize: 4 }}>{l.text}</td>
                </tr>
              );
            })}
          </tbody>
        </Box>
      </ScrollArea>
    </Stack>
  );
}

function DiffModal({ serverId, backup, backups, onClose }: { serverId: number; backup: Backup | null; backups: Backup[]; onClose: () => void }) {
  const [other, setOther] = useState<string>("live");
  const [raw, setRaw] = useState(false);
  // Orient the diff old -> new: "+" lines are what changed after the older snapshot.
  const otherBackup = backups.find((b) => String(b.id) === other);
  const swap = !!backup && !!otherBackup && otherBackup.createdAt < backup.createdAt;
  const aId = swap ? otherBackup!.id : backup?.id;
  const bRef = swap ? String(backup!.id) : other;
  const q = useQuery<Diff, ApiError>({
    queryKey: ["backup-diff", serverId, aId, bRef, raw],
    queryFn: () => get<Diff>(`/api/servers/${serverId}/backups/${aId}/diff?other=${encodeURIComponent(bRef)}${raw ? "&raw=1" : ""}`),
    enabled: !!backup,
    retry: false,
  });
  const aLabel = `backup #${aId}`;
  const otherLabel = bRef === "live" ? "live configuration" : `backup #${bRef}`;
  return (
    <Modal opened={!!backup} onClose={onClose} size="95%" title={<Group gap="xs"><IconArrowsDiff size={18} /><Text fw={600}>Compare backup #{backup?.id} with…</Text></Group>}>
      <Stack>
        <Group gap="sm">
          <Select
            size="xs" w={360} allowDeselect={false} value={other} onChange={(v) => setOther(v ?? "live")}
            data={[{ value: "live", label: "Live configuration (current)" }, ...backups.filter((b) => b.id !== backup?.id).map((b) => ({ value: String(b.id), label: `#${b.id} · ${dt(b.createdAt)}${b.note ? ` · ${b.note}` : ""}` }))]}
            data-testid="diff-other"
          />
          <Tooltip label="By default volatile values (counters, timestamps) are stripped so only meaningful changes are shown." multiline w={300}>
            <Switch size="xs" label="Include volatile values (raw diff)" checked={raw} onChange={(e) => setRaw(e.currentTarget.checked)} data-testid="diff-raw" />
          </Tooltip>
        </Group>
        <QueryState query={q}>
          {q.data && <DiffView diff={q.data} aLabel={aLabel} bLabel={otherLabel} />}
        </QueryState>
      </Stack>
    </Modal>
  );
}

function ViewBackupModal({ serverId, id, onClose }: { serverId: number; id: number | null; onClose: () => void }) {
  const q = useQuery<BackupFull, ApiError>({ queryKey: ["backup", serverId, id], queryFn: () => get<BackupFull>(`/api/servers/${serverId}/backups/${id}`), enabled: id !== null });
  return (
    <Modal opened={id !== null} onClose={onClose} size="90%" title={`Backup #${id ?? ""}`}>
      <QueryState query={q}>
        {q.data && (
          <Stack gap="xs">
            <Text size="xs" c="dimmed">Taken {dt(q.data.createdAt)} by {q.data.createdBy} · SHA-256 {q.data.sha256.slice(0, 16)}…{q.data.note ? ` · ${q.data.note}` : ""}</Text>
            <TextView text={q.data.content} height="calc(100vh - 260px)" testId="backup-content" />
          </Stack>
        )}
      </QueryState>
    </Modal>
  );
}

function Backups({ serverId, serverName }: { serverId: number; serverName: string }) {
  const qc = useQueryClient();
  const list = useQuery<Backup[], ApiError>({ queryKey: ["backups", serverId], queryFn: () => get<Backup[]>(`/api/servers/${serverId}/backups`) });
  const [note, setNote] = useState("");
  const [diffOf, setDiffOf] = useState<Backup | null>(null);
  const [viewId, setViewId] = useState<number | null>(null);
  const create = useMutation<{ id: number; changed: boolean }, ApiError, void>({
    mutationFn: () => post(`/api/servers/${serverId}/backups`, { note: note.trim() }),
    onSuccess: (r) => {
      setNote("");
      notifications.show({ color: "green", message: `Backup #${r.id} created` });
      void qc.invalidateQueries({ queryKey: ["backups", serverId] });
    },
    onError: (e) => notifyError(e, "Create backup"),
  });
  const restore = async (b: Backup) => {
    try {
      await post(`/api/servers/${serverId}/backups/${b.id}/restore`, { confirm: serverName });
      notifications.show({ color: "green", message: `Backup #${b.id} restored — the VPN Server is restarting`, autoClose: 10000 });
      void qc.invalidateQueries({ queryKey: ["backups", serverId] });
      void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
    } catch (e) {
      notifyError(e, "Restore backup");
      throw e;
    }
  };
  const latest = list.data?.[0];

  return (
    <Section
      title="Configuration backups"
      description="Snapshots of the server configuration stored by the manager (taken on schedule, before restores/uploads, and on demand). Compare any two snapshots or a snapshot with the live configuration."
    >
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Group align="flex-end" mb="md">
          <TextInput label="Note (optional)" placeholder="e.g. before enabling IPsec" value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={500} w={360} data-testid="backup-note" />
          <Button type="submit" leftSection={<IconPlus size={16} />} loading={create.isPending} data-testid="create-backup">Back up now</Button>
          {latest && <Text size="xs" c="dimmed">Latest: #{latest.id}, {ago(latest.createdAt)}</Text>}
        </Group>
      </form>
      {list.error ? <ErrorAlert error={list.error} /> : (
        <DataTable
          testId="backups-table"
          data={list.data}
          loading={list.isLoading}
          rowKey={(b) => b.id}
          initialSort={{ key: "createdAt", dir: "desc" }}
          empty="No backups yet"
          columns={[
            { key: "id", title: "#", width: 60, render: (b) => <Text size="sm" fw={600}>#{b.id}</Text> },
            { key: "createdAt", title: "Taken", render: (b) => <Text size="sm" title={dt(b.createdAt)}>{dt(b.createdAt)} <Text span size="xs" c="dimmed">({ago(b.createdAt)})</Text></Text> },
            { key: "createdBy", title: "By" },
            { key: "note", title: "Note", render: (b) => b.note || <Text size="sm" c="dimmed">–</Text> },
            { key: "size", title: "Size", align: "right", render: (b) => bytes(b.size) },
            { key: "sha256", title: "SHA-256", render: (b) => <Tooltip label={b.sha256}><Code>{b.sha256.slice(0, 12)}</Code></Tooltip> },
            {
              key: "actions", title: "", sortable: false, align: "right", value: () => "",
              render: (b) => (
                <Group gap={6} justify="flex-end" wrap="nowrap">
                  <Tooltip label="View"><Button size="xs" variant="subtle" onClick={() => setViewId(b.id)} aria-label={`View backup ${b.id}`} data-testid={`view-backup-${b.id}`}><IconEye size={14} /></Button></Tooltip>
                  <Button size="xs" variant="light" leftSection={<IconArrowsDiff size={14} />} onClick={() => setDiffOf(b)} data-testid={`diff-backup-${b.id}`}>Compare</Button>
                  <Tooltip label="Download .config"><Button size="xs" variant="subtle" onClick={() => download(`/api/servers/${serverId}/backups/${b.id}?download=1`)} aria-label={`Download backup ${b.id}`} data-testid={`download-backup-${b.id}`}><IconDownload size={14} /></Button></Tooltip>
                  <ConfirmButton
                    title={`Restore backup #${b.id}?`}
                    typeToConfirm={serverName} confirmLabel="Restore and restart"
                    leftSection={<IconRestore size={14} />}
                    message={<Stack gap="xs">
                      <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} p="xs">
                        The whole server configuration is replaced by the snapshot from <b>{dt(b.createdAt)}</b> and <b>the VPN Server restarts</b>. All VPN sessions are disconnected.
                      </Alert>
                      <Text size="sm">Every change made after this snapshot (hubs, users, certificates, passwords…) is lost. The manager takes an automatic snapshot of the current configuration first.</Text>
                      <Text size="sm">If the snapshot has a different administrator password or certificate, update the manager's stored credential / pinned fingerprint afterwards.</Text>
                    </Stack>}
                    onConfirm={() => restore(b)}
                  >
                    <span data-testid={`restore-backup-${b.id}`}>Restore</span>
                  </ConfirmButton>
                </Group>
              ),
            },
          ]}
        />
      )}
      <DiffModal serverId={serverId} backup={diffOf} backups={list.data ?? []} onClose={() => setDiffOf(null)} />
      <ViewBackupModal serverId={serverId} id={viewId} onClose={() => setViewId(null)} />
    </Section>
  );
}

function UploadConfig({ serverId, serverName }: { serverId: number; serverName: string }) {
  const qc = useQueryClient();
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const looksValid = /declare\s+root/.test(content);
  const upload = async () => {
    try {
      await post(`/api/servers/${serverId}/config/upload`, { content, confirm: serverName });
      notifications.show({ color: "green", message: "Configuration uploaded — the VPN Server is restarting", autoClose: 10000 });
      setContent("");
      setFileName(null);
      void qc.invalidateQueries({ queryKey: ["backups", serverId] });
      void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
    } catch (e) {
      notifyError(e, "Upload configuration");
      throw e;
    }
  };
  return (
    <Section title="Upload a configuration file" description="Replace the entire server configuration with a vpn_server.config file (SetConfig). A snapshot of the current configuration is taken automatically first.">
      <Stack>
        <Group>
          <FileButton onChange={async (f) => { if (f) { setContent(await f.text()); setFileName(f.name); } }} accept=".config,.txt,text/plain">
            {(props) => <Button {...props} variant="light" leftSection={<IconUpload size={16} />} data-testid="config-file">Choose file…</Button>}
          </FileButton>
          {fileName && <Text size="sm">{fileName} · {bytes(new TextEncoder().encode(content).length)}</Text>}
          {content && <SegmentedControl size="xs" value={view} onChange={(v) => setView(v as "edit" | "preview")} data={[{ value: "edit", label: "Edit" }, { value: "preview", label: "Preview" }]} />}
        </Group>
        {view === "edit" || !content
          ? <Textarea placeholder="…or paste the configuration here" autosize minRows={6} maxRows={20} ff="monospace" value={content} onChange={(e) => setContent(e.currentTarget.value)} data-testid="config-text" styles={{ input: { fontSize: 12 } }} />
          : <TextView text={content} height={420} />}
        {content && !looksValid && <Alert color="orange" variant="light" icon={<IconAlertTriangle size={16} />}>This does not look like a SoftEther configuration file (no <Code>declare root</Code> block).</Alert>}
        <Group justify="flex-end">
          <ConfirmButton
            title="Upload and apply this configuration?"
            color="red" variant="filled" size="sm" typeToConfirm={serverName} confirmLabel="Apply and restart"
            disabled={!content.trim() || !looksValid}
            leftSection={<IconUpload size={16} />}
            message={<Stack gap="xs">
              <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} p="xs">
                The complete configuration of <b>{serverName}</b> is replaced and <b>the VPN Server restarts</b>. All sessions are disconnected.
              </Alert>
              <Text size="sm">A malformed file can leave the server unreachable. If the file changes the administrator password or server certificate, update the manager's credential / pin afterwards.</Text>
            </Stack>}
            onConfirm={upload}
          >
            <span data-testid="upload-config">Apply configuration…</span>
          </ConfirmButton>
        </Group>
      </Stack>
    </Section>
  );
}

export default function ConfigPage() {
  const { serverId } = useScope();
  const { server, role, isAdmin } = useServerAccess(serverId);
  const [tab, setTab] = useState<string | null>("live");
  const name = server.data?.name ?? "";
  return (
    <>
      <PageHeader title="Configuration & backups" description="View the live server configuration, keep versioned backups, compare them, and restore or upload a configuration." />
      {server.data && !isAdmin ? (
        <Alert color="gray" variant="light" icon={<IconLock size={16} />}>
          The configuration contains password hashes and private keys and is available to <b>admins</b> only (your role: {role}).
        </Alert>
      ) : !server.data ? <Empty>Loading…</Empty> : (
        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List mb="md">
            <Tabs.Tab value="live" leftSection={<IconDatabase size={14} />} data-testid="tab-live">Live configuration</Tabs.Tab>
            <Tabs.Tab value="backups" leftSection={<IconHistory size={14} />} data-testid="tab-backups">Backups</Tabs.Tab>
            <Tabs.Tab value="upload" leftSection={<IconUpload size={14} />} data-testid="tab-upload">Upload</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="live"><LiveConfig serverId={serverId} serverName={name} /></Tabs.Panel>
          <Tabs.Panel value="backups"><Backups serverId={serverId} serverName={name} /></Tabs.Panel>
          <Tabs.Panel value="upload"><UploadConfig serverId={serverId} serverName={name} /></Tabs.Panel>
        </Tabs>
      )}
    </>
  );
}
