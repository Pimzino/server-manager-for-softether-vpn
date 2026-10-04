// Server › Configuration & Backups: versioned snapshots of vpn_server.config kept by this app (scheduled,
// on demand, and automatic safety snapshots before restores and uploads), compare any snapshot with another one
// or with the live configuration, restore, save to disk, and upload a configuration file.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Code, Group, SegmentedControl, Select, Switch, Textarea, TextInput, Tooltip } from "@mantine/core";
import {
  IconArrowsDiff, IconClockHour4, IconDatabase, IconDeviceFloppy, IconEye, IconFileUpload, IconHistory, IconLock, IconPlus, IconRestore, IconSettings,
} from "@tabler/icons-react";
import { download, get, openFile, post, rpc, type ApiError } from "../../lib/api";
import { notifyError, notifySuccess, useScope } from "../../lib/hooks";
import { agoShort, b64ToText, bytes, dt, downloadText, num, plural } from "../../lib/format";
import type { AppSettings } from "../../lib/types";
import {
  confirmAction, DataTable, EmptyState, ErrorState, FormRow, FormSection, LoadingState, Mono, PageHeader, QueryState, Section, Sheet, Tag,
  type ContextMenuItem, type RowKey, type TagColor,
} from "../../design";
import { Callout } from "../../components/domain/ui";
import { TextView, Unreachable, safeName, useReachable } from "./_server-advanced/shared";

interface Backup { id: number; createdAt: number; createdBy: string; sha256: string; size: number; note: string }
interface BackupFull extends Backup { content: string }
type DiffLine = { type: "same" | "add" | "del"; text: string; a?: number; b?: number } | { type: "skip"; count: number };
interface Diff { changed: number; lines: DiffLine[] }

const KIND: Record<string, { label: string; color: TagColor }> = {
  manual: { label: "Manual", color: "accent" },
  scheduled: { label: "Scheduled", color: "gray" },
  safety: { label: "Safety", color: "orange" },
};
const kindOf = (b: Backup) => b.createdBy === "scheduler" ? "scheduled" : /^Automatic snapshot/.test(b.note) ? "safety" : "manual";

/** "Saved to <file>" after a native Save dialog (nothing when it was cancelled), as on Logs & Syslog. */
function savedToast(r: { saved: boolean; filePath?: string }) {
  if (r.saved) notifySuccess(`Saved to ${r.filePath?.split(/[\\/]/).pop() ?? "the file"}`);
}
function saveBackup(serverId: number, b: Backup) {
  return download(`/api/servers/${serverId}/backups/${b.id}?download=1`).then(savedToast, (e) => notifyError(e, "Couldn’t save the backup"));
}

// ------------------------------------------------------------------------------ restore / upload

function useRestore(serverId: number, serverName: string) {
  const qc = useQueryClient();
  return async (b: Backup) => {
    const ok = await confirmAction({
      title: <>Restore backup #{b.id}?</>,
      message: <>The whole configuration of <b>{serverName}</b> is replaced by the snapshot from {dt(b.createdAt)}, and the VPN Server restarts. Every VPN session is disconnected.</>,
      details: (
        <div className="sem-stack" style={{ gap: 6, marginTop: 4 }}>
          <span className="sem-dim">Changes made after this snapshot (hubs, users, certificates, passwords…) are lost. A snapshot of the current configuration is taken first, so you can go back.</span>
          <span className="sem-dim">If the snapshot has a different administrator password or certificate, update this connection afterwards.</span>
        </div>
      ),
      confirmLabel: "Restore and Restart",
      typeToConfirm: serverName,
      typeLabel: <>To confirm, type the connection name <Code className="sem-code-inline">{serverName}</Code></>,
      testId: `restore-backup-${b.id}`,
    });
    if (!ok) return false;
    try {
      await post(`/api/servers/${serverId}/backups/${b.id}/restore`, { confirm: serverName });
      notifySuccess(`Backup #${b.id} restored. The VPN Server is restarting.`);
      void qc.invalidateQueries({ queryKey: ["backups", serverId] });
      void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
      return true;
    } catch (e) {
      notifyError(e, "Couldn’t restore the backup");
      return false;
    }
  };
}

function UploadSheet({ serverId, serverName, opened, onClose }: { serverId: number; serverName: string; opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [busy, setBusy] = useState(false);
  const looksValid = /declare\s+root/.test(content);
  const close = () => { if (busy) return; setContent(""); setFileName(null); setView("edit"); onClose(); };
  const choose = async () => {
    try {
      const f = await openFile({ title: "Choose a Configuration File", filters: [{ name: "SoftEther configuration", extensions: ["config", "txt"] }, { name: "All files", extensions: ["*"] }] });
      if (!f) return;
      setContent(f.content.replace(/^﻿/, ""));
      setFileName(f.name);
    } catch (e) { notifyError(e, "Couldn’t read the file"); }
  };
  const apply = async () => {
    const ok = await confirmAction({
      title: "Apply this configuration?",
      message: <>The complete configuration of <b>{serverName}</b> is replaced and the VPN Server restarts. Every VPN session is disconnected.</>,
      details: <span className="sem-dim">A malformed file can leave the server unreachable. A snapshot of the current configuration is taken first. If the file changes the administrator password or the certificate, update this connection afterwards.</span>,
      confirmLabel: "Apply and Restart",
      typeToConfirm: serverName,
      typeLabel: <>To confirm, type the connection name <Code className="sem-code-inline">{serverName}</Code></>,
      testId: "upload-config",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await post(`/api/servers/${serverId}/config/upload`, { content, confirm: serverName });
      notifySuccess("Configuration applied. The VPN Server is restarting.");
      void qc.invalidateQueries({ queryKey: ["backups", serverId] });
      void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
      setBusy(false);
      close();
    } catch (e) {
      notifyError(e, "Couldn’t apply the configuration");
      setBusy(false);
    }
  };
  const size = new TextEncoder().encode(content).length;
  return (
    <Sheet
      opened={opened} onClose={close} busy={busy} size={880} testId="upload-sheet"
      title="Upload Configuration" subtitle="Replace the whole server configuration with a vpn_server.config file."
      icon={<IconFileUpload size={19} stroke={1.5} />}
      footer={(
        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
          <span className="sa-viewer-meta" style={{ flex: 1 }}>{content ? `${bytes(size)} · ${content.split(/\r?\n/).length.toLocaleString()} lines` : ""}</span>
          <Button variant="default" onClick={close} disabled={busy}>Cancel</Button>
          <Button color="red" onClick={() => void apply()} loading={busy} disabled={!content.trim() || !looksValid} data-testid="upload-config">Apply Configuration…</Button>
        </div>
      )}
    >
      <div className="sem-stack" style={{ gap: 12 }}>
        <div className="sa-viewer-bar" style={{ marginBottom: 0 }}>
          <Button variant="default" leftSection={<IconFileUpload size={14} />} onClick={() => void choose()} data-testid="config-file">Choose File…</Button>
          {fileName && <Mono dim>{fileName}</Mono>}
          <span className="sa-spacer" />
          {content && (
            <SegmentedControl size="xs" value={view} onChange={(v) => setView(v as "edit" | "preview")} aria-label="View"
              data={[{ value: "edit", label: "Edit" }, { value: "preview", label: "Preview" }]} />
          )}
        </div>
        {view === "edit" || !content ? (
          <Textarea
            placeholder="Or paste the contents of vpn_server.config here." autosize minRows={14} maxRows={22} value={content}
            onChange={(e) => setContent(e.currentTarget.value)} spellCheck={false} aria-label="Configuration"
            styles={{ input: { fontFamily: "var(--sem-font-mono)", fontSize: "var(--sem-fz-small)" } }} data-testid="config-text"
          />
        ) : <TextView text={content} height={380} testId="config-preview" />}
        {content && !looksValid && (
          <Callout tone="yellow" testId="config-invalid">This doesn’t look like a SoftEther configuration file: there’s no <Code className="sem-code-inline">declare root</Code> block.</Callout>
        )}
        <Callout tone="gray" icon={<IconHistory size={16} stroke={1.7} />}>A snapshot of the current configuration is taken before the new one is applied.</Callout>
      </div>
    </Sheet>
  );
}

// ------------------------------------------------------------------------------ view / diff

function DiffView({ diff, aLabel, bLabel }: { diff: Diff; aLabel: string; bLabel: string }) {
  if (diff.changed === 0) {
    return (
      <div className="sem-inset" data-testid="diff-identical">
        <EmptyState compact icon={<IconArrowsDiff size={24} stroke={1.4} />} title="No differences" description={<>{aLabel} and {bLabel.charAt(0).toLowerCase() + bLabel.slice(1)} are the same.</>} />
      </div>
    );
  }
  const adds = diff.lines.filter((l) => l.type === "add").length;
  const dels = diff.lines.filter((l) => l.type === "del").length;
  return (
    <div>
      <div className="sa-viewer-bar">
        <Tag color="green" testId="diff-adds">+{num(adds)}</Tag>
        <Tag color="red" testId="diff-dels">−{num(dels)}</Tag>
        <span className="sa-viewer-meta"><span className="sem-text-red">− {aLabel}</span> · <span style={{ color: "var(--sem-green)" }}>+ {bLabel}</span></span>
      </div>
      <div className="sa-text" style={{ height: "calc(100vh - 330px)" }}>
        <table className="sa-diff" data-testid="diff-view">
          <tbody>
            {diff.lines.map((l, i) => l.type === "skip" ? (
              <tr key={i} data-difftype="skip"><td colSpan={4}>⋯ {plural(l.count, "unchanged line")}</td></tr>
            ) : (
              <tr key={i} data-difftype={l.type}>
                <td className="sa-diff-no">{l.a ?? ""}</td>
                <td className="sa-diff-no">{l.b ?? ""}</td>
                <td className="sa-diff-sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : ""}</td>
                <td className="sa-diff-text">{l.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiffSheet({ serverId, backup, initialOther, backups, onClose }: {
  serverId: number; backup: Backup | null; initialOther: string; backups: Backup[]; onClose: () => void;
}) {
  const [otherSel, setOther] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);
  const other = otherSel ?? initialOther;
  // Orient the diff old → new: "+" lines are what changed after the older snapshot.
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
  const aLabel = `Backup #${aId}`;
  const bLabel = bRef === "live" ? "Live configuration" : `Backup #${bRef}`;
  const close = () => { setOther(null); setRaw(false); onClose(); };
  return (
    <Sheet
      opened={!!backup} onClose={close} size="min(1180px, 94vw)" testId="diff-sheet"
      icon={<IconArrowsDiff size={19} stroke={1.5} />} title={<>Compare Backup #{backup?.id}</>}
      subtitle={backup && <>Taken {dt(backup.createdAt)}{backup.note ? ` · ${backup.note}` : ""}</>}
      footer={<Group justify="flex-end"><Button onClick={close}>Done</Button></Group>}
    >
      <div className="sa-viewer-bar">
        <span className="sem-dim">With</span>
        <Select
          size="xs" w={380} allowDeselect={false} value={other} onChange={(v) => setOther(v ?? "live")} aria-label="Compare with" data-testid="diff-other"
          data={[{ value: "live", label: "Live configuration (now)" }, ...backups.filter((b) => b.id !== backup?.id).map((b) => ({ value: String(b.id), label: `#${b.id} · ${dt(b.createdAt)}${b.note ? ` · ${b.note}` : ""}` }))]}
        />
        <Tooltip label="Counters and timestamps change all the time and are hidden unless you include them." multiline maw={300}>
          <Switch size="xs" label="Include counters and timestamps" checked={raw} onChange={(e) => setRaw(e.currentTarget.checked)} data-testid="diff-raw" />
        </Tooltip>
      </div>
      <QueryState query={q} inline>
        {q.data && <DiffView diff={q.data} aLabel={aLabel} bLabel={bLabel} />}
      </QueryState>
    </Sheet>
  );
}

function ViewBackupSheet({ serverId, backup, onClose, onCompare, onRestore }: {
  serverId: number; backup: Backup | null; onClose: () => void; onCompare: (b: Backup) => void; onRestore: (b: Backup) => void;
}) {
  const id = backup?.id ?? null;
  const q = useQuery<BackupFull, ApiError>({ queryKey: ["backup", serverId, id], queryFn: () => get<BackupFull>(`/api/servers/${serverId}/backups/${id}`), enabled: id !== null });
  const b = backup;
  return (
    <Sheet
      opened={!!b} onClose={onClose} size="min(1180px, 94vw)" testId="backup-sheet"
      icon={<IconHistory size={19} stroke={1.5} />} title={<>Backup #{id}</>}
      subtitle={b && <>{KIND[kindOf(b)].label} · taken {dt(b.createdAt)} by {b.createdBy}{b.note ? ` · ${b.note}` : ""}</>}
      footer={b && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
          <span className="sa-viewer-meta" style={{ flex: 1 }}>SHA-256 <Mono dim>{b.sha256.slice(0, 16)}…</Mono></span>
          <Button variant="default" leftSection={<IconRestore size={14} />} c="var(--sem-red)" onClick={() => onRestore(b)} data-testid="backup-sheet-restore">Restore…</Button>
          <Button variant="default" leftSection={<IconArrowsDiff size={14} />} onClick={() => onCompare(b)}>Compare…</Button>
          <Button variant="default" leftSection={<IconDeviceFloppy size={14} />} onClick={() => void saveBackup(serverId, b)}>Save As…</Button>
          <Button onClick={onClose}>Done</Button>
        </div>
      )}
    >
      <QueryState query={q} inline>
        {q.data && <TextView text={q.data.content} height="calc(100vh - 330px)" testId="backup-content" />}
      </QueryState>
    </Sheet>
  );
}

// ------------------------------------------------------------------------------ backups

function NewBackupSheet({ serverId, opened, onClose }: { serverId: number; opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const create = useMutation<{ id: number; changed: boolean }, ApiError, void>({
    mutationFn: () => post(`/api/servers/${serverId}/backups`, { note: note.trim() }),
    onSuccess: (r) => {
      notifySuccess(`Backup #${r.id} created`);
      void qc.invalidateQueries({ queryKey: ["backups", serverId] });
      setNote("");
      onClose();
    },
    onError: (e) => notifyError(e, "Couldn’t back up the configuration"),
  });
  return (
    <Sheet
      opened={opened} onClose={() => { setNote(""); onClose(); }} busy={create.isPending} title="Back Up Configuration" testId="backup-new-sheet"
      subtitle="Save a snapshot of the current configuration in this app." icon={<IconDatabase size={19} stroke={1.5} />}
      footer={(
        <Group justify="flex-end" gap={8}>
          <Button variant="default" onClick={() => { setNote(""); onClose(); }}>Cancel</Button>
          <Button onClick={() => create.mutate()} loading={create.isPending} data-testid="create-backup">Back Up</Button>
        </Group>
      )}
    >
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <FormSection>
          <FormRow label="Note" description="Optional. Helps you find this snapshot later.">{(id) => (
            <TextInput id={id} placeholder="Before enabling IPsec" value={note} onChange={(e) => setNote(e.currentTarget.value)} maxLength={500} data-autofocus data-testid="backup-note" />
          )}</FormRow>
        </FormSection>
      </form>
    </Sheet>
  );
}

function BackupsView({ serverId, serverName, list, onNew }: {
  serverId: number; serverName: string; list: ReturnType<typeof useBackups>; onNew: () => void;
}) {
  const nav = useNavigate();
  const settings = useQuery<AppSettings, ApiError>({ queryKey: ["settings"], queryFn: () => get<AppSettings>("/api/settings") });
  const [selection, setSelection] = useState<RowKey[]>([]);
  const [viewing, setViewing] = useState<Backup | null>(null);
  const [diff, setDiff] = useState<{ b: Backup; other: string } | null>(null);
  const [kind, setKind] = useState("all");
  const restore = useRestore(serverId, serverName);
  const backups = list.data ?? [];
  const byId = (k: RowKey) => backups.find((b) => b.id === k);
  const selected = selection.map(byId).filter((b): b is Backup => !!b);
  const shown = backups.filter((b) => kind === "all" || kindOf(b) === kind);
  const compareSelected = () => {
    if (selected.length === 1) setDiff({ b: selected[0], other: "live" });
    else if (selected.length === 2) {
      const [x, y] = [...selected].sort((m, n) => m.createdAt - n.createdAt);
      setDiff({ b: x, other: String(y.id) });
    }
  };
  const save = (b: Backup) => void saveBackup(serverId, b);
  const menu = (b: Backup, sel: Backup[]): ContextMenuItem[] => {
    const other = sel.length === 2 && sel.some((x) => x.id === b.id) ? sel.find((x) => x.id !== b.id) : undefined;
    return [
      { label: "View", icon: <IconEye size={14} />, onClick: () => setViewing(b), testId: `view-backup-${b.id}` },
      { label: "Compare with Live Configuration", icon: <IconArrowsDiff size={14} />, onClick: () => setDiff({ b, other: "live" }), testId: `diff-backup-${b.id}` },
      ...(other ? [{ label: <>Compare with #{other.id}</>, icon: <IconArrowsDiff size={14} />, onClick: () => compareSelected() }] : []),
      { label: "Save As…", icon: <IconDeviceFloppy size={14} />, onClick: () => save(b), testId: `download-backup-${b.id}` },
      "divider",
      { label: "Restore…", icon: <IconRestore size={14} />, danger: true, onClick: () => void restore(b), testId: `restore-backup-${b.id}` },
    ];
  };
  const s = settings.data?.backup;
  const counts = { manual: 0, scheduled: 0, safety: 0 } as Record<string, number>;
  for (const b of backups) counts[kindOf(b)]++;

  return (
    <>
      <div className="sem-callouts">
        <Callout
          tone="gray" icon={<IconClockHour4 size={16} stroke={1.7} />} testId="backup-schedule"
          action={<Button size="xs" variant="default" leftSection={<IconSettings size={13} />} onClick={() => nav("/preferences")}>Change Schedule…</Button>}
        >
          {!s ? "Loading the backup schedule…" : s.enabled
            ? <>Scheduled backups run every {plural(s.intervalHours, "hour")} when the configuration changed. The latest {num(s.retention)} snapshots are kept.</>
            : <>Scheduled backups are off. Snapshots are taken on demand and before restores and uploads; the latest {num(s.retention)} are kept.</>}
        </Callout>
      </div>
      <Section title="Snapshots" description="Double-click a snapshot to read it. Select two to compare them, or one to compare it with the live configuration.">
        <DataTable
          testId="backups-table" aria-label="Configuration backups"
          data={list.data ? shown : undefined} loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}
          rowKey={(b) => b.id} selectable="multi" selection={selection} onSelectionChange={(k) => setSelection(k)}
          onRowOpen={setViewing} contextMenu={menu} rowTestId={(b) => `backup-row-${b.id}`}
          initialSort={{ key: "createdAt", dir: "desc" }} searchPlaceholder="Filter snapshots"
          filters={(
            <SegmentedControl size="xs" value={kind} onChange={setKind} aria-label="Kind" data-testid="backup-kind"
              data={[{ value: "all", label: `All ${backups.length}` }, ...Object.entries(KIND).map(([k, v]) => ({ value: k, label: `${v.label} ${counts[k]}` }))]} />
          )}
          toolbar={(
            <>
              <Button size="xs" variant="default" leftSection={<IconArrowsDiff size={13} />} disabled={selected.length < 1 || selected.length > 2}
                onClick={compareSelected} data-testid="backups-compare">{selected.length === 2 ? "Compare Selected" : "Compare with Live"}</Button>
              <Button size="xs" variant="default" leftSection={<IconRestore size={13} />} disabled={selected.length !== 1} c={selected.length === 1 ? "var(--sem-red)" : undefined}
                onClick={() => selected[0] && void restore(selected[0])} data-testid="backups-restore">Restore…</Button>
            </>
          )}
          empty={{
            title: "No backups yet", icon: <IconHistory size={26} stroke={1.4} />,
            description: "Take a snapshot now, or turn on scheduled backups in Preferences.",
            action: <Button size="xs" leftSection={<IconPlus size={13} />} onClick={onNew}>Back Up Now…</Button>,
          }}
          columns={[
            { key: "id", title: "#", width: 56, align: "right", render: (b) => <span className="sem-strong sem-num">{b.id}</span> },
            { key: "createdAt", title: "Taken", width: 190, render: (b) => <span className="sem-num" title={dt(b.createdAt)}>{dt(b.createdAt)}</span> },
            { key: "age", title: "Age", width: 90, value: (b) => b.createdAt, render: (b) => <span className="sem-dim">{agoShort(b.createdAt)}</span> },
            { key: "kind", title: "Kind", width: 130, value: (b) => KIND[kindOf(b)].label, render: (b) => <Tag color={KIND[kindOf(b)].color}>{KIND[kindOf(b)].label}</Tag> },
            { key: "note", title: "Note", truncate: true, render: (b) => b.note ? <span title={b.note}>{b.note}</span> : <span className="sem-dim">–</span> },
            { key: "size", title: "Size", align: "right", width: 84, render: (b) => <span className="sem-num">{bytes(b.size)}</span> },
            { key: "sha256", title: "SHA-256", width: 120, render: (b) => <span className="sem-mono sem-dim" title={b.sha256}>{b.sha256.slice(0, 12)}</span> },
          ]}
        />
      </Section>
      <ViewBackupSheet serverId={serverId} backup={viewing} onClose={() => setViewing(null)}
        onCompare={(b) => { setViewing(null); setDiff({ b, other: "live" }); }}
        onRestore={(b) => { void restore(b).then((ok) => { if (ok) setViewing(null); }); }} />
      <DiffSheet key={diff ? `${diff.b.id}-${diff.other}` : "none"} serverId={serverId} backup={diff?.b ?? null} initialOther={diff?.other ?? "live"} backups={backups} onClose={() => setDiff(null)} />
    </>
  );
}

// ------------------------------------------------------------------------------ live

function LiveConfig({ serverId, serverName, shown, onShow }: { serverId: number; serverName: string; shown: boolean; onShow: () => void }) {
  const q = useQuery<{ FileName_str?: string; FileData_bin?: string }, ApiError>({
    queryKey: ["rpc", serverId, "GetConfig", {}],
    queryFn: () => rpc(serverId, "GetConfig", {}),
    enabled: shown, retry: false, staleTime: 30_000,
  });
  const text = useMemo(() => b64ToText(q.data?.FileData_bin), [q.data]);
  const fname = (q.data?.FileName_str || "vpn_server.config").replace(/^\$/, "");
  if (!shown) {
    return (
      <Section title="Live Configuration">
        <div className="sem-inset">
          <EmptyState
            icon={<IconLock size={26} stroke={1.4} />} title="The configuration contains secrets"
            description="It includes password hashes and private keys. Treat anything you copy or save from it as a secret."
            action={<Button leftSection={<IconEye size={14} />} onClick={onShow} data-testid="show-live-config">Show Configuration</Button>}
            testId="live-config-locked"
          />
        </div>
      </Section>
    );
  }
  return (
    <Section
      title="Live Configuration"
      description={<>The server’s current <Mono>{fname}</Mono>, as returned by GetConfig.</>}
      actions={q.data && (
        <>
          <Button size="xs" variant="default" onClick={() => void q.refetch()} loading={q.isFetching}>Reload</Button>
          <Button size="xs" variant="default" leftSection={<IconDeviceFloppy size={13} />} data-testid="download-live-config"
            onClick={() => void downloadText(`${safeName(serverName)}-${fname}`, text).then(savedToast, (e) => notifyError(e, "Couldn’t save the configuration"))}>Save As…</Button>
        </>
      )}
    >
      {q.error ? <ErrorState error={q.error} inline onRetry={() => void q.refetch()} />
        : !q.data ? <div className="sa-text" style={{ height: 200, display: "grid", placeItems: "center" }}><LoadingState compact label="Reading the configuration…" /></div>
        : <TextView text={text} height="calc(100vh - 360px)" testId="live-config" />}
    </Section>
  );
}

// ------------------------------------------------------------------------------ page

function useBackups(serverId: number, enabled: boolean) {
  return useQuery<Backup[], ApiError>({ queryKey: ["backups", serverId], queryFn: () => get<Backup[]>(`/api/servers/${serverId}/backups`), enabled });
}

export default function ConfigPage() {
  const { serverId } = useScope();
  const { s, reachable } = useReachable(serverId);
  const list = useBackups(serverId, !!s);
  const [view, setView] = useState<"backups" | "live">("backups");
  const [liveShown, setLiveShown] = useState(false);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const name = s?.name ?? "";
  const latest = list.data?.[0];

  return (
    <>
      <PageHeader
        title="Configuration & Backups"
        meta={list.data && (latest
          ? <><span>{plural(list.data.length, "snapshot")}</span><span className="sem-dim">·</span><span>Latest #{latest.id}, <span title={dt(latest.createdAt)}>{agoShort(latest.createdAt)}</span></span></>
          : <span>No snapshots yet</span>)}
        description="Snapshots of the server configuration: compare them, restore one, or upload a file."
        actions={s && (
          <>
            <Button variant="default" leftSection={<IconFileUpload size={14} />} onClick={() => setUploading(true)} disabled={!reachable} data-testid="tab-upload">Upload Configuration…</Button>
            <Button leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)} disabled={!reachable} data-testid="backup-new">Back Up Now…</Button>
          </>
        )}
      />
      <div className="sa-views">
        <SegmentedControl
          value={view} onChange={(v) => setView(v as "backups" | "live")} aria-label="View"
          data={[
            { value: "backups", label: <span data-testid="tab-backups">Backups</span> },
            { value: "live", label: <span data-testid="tab-live">Live Configuration</span> },
          ]}
        />
      </div>
      {view === "backups" && s && <BackupsView serverId={serverId} serverName={name} list={list} onNew={() => setCreating(true)} />}
      {view === "live" && (s && !reachable ? <Unreachable serverId={serverId} />
        : <LiveConfig serverId={serverId} serverName={name} shown={liveShown} onShow={() => setLiveShown(true)} />)}
      <NewBackupSheet serverId={serverId} opened={creating} onClose={() => setCreating(false)} />
      <UploadSheet serverId={serverId} serverName={name} opened={uploading} onClose={() => setUploading(false)} />
    </>
  );
}
