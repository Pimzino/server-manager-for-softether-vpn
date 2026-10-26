// Server › Logs & Syslog: the log files saved on the VPN Server (server, hub security and packet logs),
// a viewer that reads a file's tail with find/follow, Save As… for whole files, and syslog forwarding.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Group, Progress, SegmentedControl, Select } from "@mantine/core";
import { IconCopy, IconDeviceFloppy, IconEye, IconFileText, IconRefresh, IconSend } from "@tabler/icons-react";
import { rpc, saveFile } from "../../lib/api";
import { notifyError, notifySuccess, useRpc, useScope } from "../../lib/hooks";
import { agoShort, bytes, dt, num, plural } from "../../lib/format";
import { DataTable, ErrorState, FormSection, LoadingState, Mono, PageHeader, Sheet, Tag, type ContextMenuItem, type TagColor } from "../../design";
import { Callout } from "../../components/domain/ui";
import { bytesToB64 } from "../../components/domain/util";
import {
  LinesView, SYSLOG_SHORT, SyslogFields, TextFilterBar, Unreachable, safeName, useReachable, useSyslogForm, useTextFilter,
} from "./_server-advanced/shared";

interface LogFile { ServerName_str: string; FilePath_str: string; FileSize_u32: number; UpdatedTime_dt: string }
interface Row extends LogFile { category: string; hub: string; name: string; date: string }

const CATEGORIES: Record<string, { label: string; short: string; color: TagColor; doc: string }> = {
  server_log: { label: "Server log", short: "Server", color: "accent", doc: "Server-wide events: listeners, connections, administration calls and errors." },
  security_log: { label: "Security log", short: "Security", color: "orange", doc: "Per-hub security events: logins, failed authentication, new sessions and policy violations." },
  packet_log: { label: "Packet log", short: "Packets", color: "purple", doc: "Per-hub packet logs, when enabled on the hub’s Logging page. They can be very large." },
};

function toRow(f: LogFile): Row {
  const parts = f.FilePath_str.split(/[\\/]/);
  const category = parts.length > 1 ? parts[0] : "other";
  const name = parts[parts.length - 1];
  const hub = parts.length > 2 ? parts.slice(1, -1).join("/") : "";
  const m = name.match(/(\d{4})(\d{2})(\d{2})(?:_(\d{2}))?/);
  const date = m ? `${m[1]}-${m[2]}-${m[3]}${m[4] ? ` ${m[4]}:00` : ""}` : "";
  return { ...f, category, hub, name, date };
}

const TAIL_OPTIONS = [
  { value: "65536", label: "Last 64 KB" },
  { value: "262144", label: "Last 256 KB" },
  { value: "1048576", label: "Last 1 MB" },
  { value: "4194304", label: "Last 4 MB" },
  { value: "0", label: "Whole file" },
];
const MAX_LINES = 20_000;

function b64Bytes(b64: string | undefined) {
  if (!b64) return new Uint8Array();
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Read [offset, end) of a log file with repeated ReadLogFile calls (the server returns bounded chunks). */
async function readRange(serverId: number, f: LogFile, offset: number, onProgress?: (got: number) => void, signal?: { cancelled: boolean }): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let pos = offset;
  let total = 0;
  for (let i = 0; i < 4096 && !signal?.cancelled; i++) {
    const r = await rpc<{ Buffer_bin?: string }>(serverId, "ReadLogFile", { ServerName_str: f.ServerName_str, FilePath_str: f.FilePath_str, Offset_u32: pos });
    const b = b64Bytes(r.Buffer_bin);
    if (b.length === 0) break;
    chunks.push(b);
    total += b.length;
    pos += b.length;
    onProgress?.(total);
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

const fileName = (f: LogFile) => `${f.ServerName_str ? `${safeName(f.ServerName_str)}-` : ""}${f.FilePath_str.replace(/[\\/]/g, "_")}`;

/** Save the whole file through the native Save dialog. */
async function saveWholeFile(serverId: number, f: LogFile) {
  const data = await readRange(serverId, f, 0);
  const r = await saveFile({ suggestedName: fileName(f), content: bytesToB64(data), encoding: "base64", filters: [{ name: "Log files", extensions: ["log", "txt"] }] });
  if (r.saved) notifySuccess(`Saved ${bytes(data.length)} to ${r.filePath?.split(/[\\/]/).pop()}`);
  return r;
}

function CategoryTag({ c }: { c: string }) {
  const m = CATEGORIES[c];
  return <Tag color={m?.color ?? "gray"} title={m?.doc}>{m?.short ?? c}</Tag>;
}

function LogViewer({ serverId, file, onClose }: { serverId: number; file: Row | null; onClose: () => void }) {
  const [tail, setTail] = useState("262144");
  const [text, setText] = useState("");
  const [meta, setMeta] = useState<{ from: number; size: number; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [wrap, setWrap] = useState(false);
  const [follow, setFollow] = useState(false);
  const [saving, setSaving] = useState(false);
  const filter = useTextFilter();
  const viewport = useRef<HTMLDivElement>(null);

  const load = useCallback(async (signal?: { cancelled: boolean }) => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      // The file keeps growing: refresh its size first.
      const list = await rpc<{ LogFiles?: LogFile[] }>(serverId, "EnumLogFile");
      const cur = list.LogFiles?.find((x) => x.FilePath_str === file.FilePath_str && x.ServerName_str === file.ServerName_str);
      const size = cur?.FileSize_u32 ?? file.FileSize_u32;
      const want = Number(tail);
      const from = want > 0 ? Math.max(0, size - want) : 0;
      const data = await readRange(serverId, file, from, (g) => setProgress(size > from ? Math.min(100, (g / (size - from)) * 100) : 100), signal);
      if (signal?.cancelled) return;
      let t = new TextDecoder().decode(data).replace(/^﻿/, "");
      if (from > 0) t = t.slice(t.indexOf("\n") + 1); // drop the partial first line
      setText(t);
      setMeta({ from, size: Math.max(size, from + data.length), truncated: from > 0 });
    } catch (e) {
      if (!signal?.cancelled) setError(e);
    } finally {
      if (!signal?.cancelled) { setLoading(false); setProgress(0); }
    }
  }, [serverId, file, tail]);

  useEffect(() => {
    const sig = { cancelled: false };
    setText("");
    setMeta(null);
    if (file) void load(sig);
    return () => { sig.cancelled = true; };
  }, [file, tail, load]);

  useEffect(() => { if (!file) { setFollow(false); filter.setQ(""); } }, [file]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!follow || !file) return;
    const t = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(t);
  }, [follow, file, load]);

  const lines = useMemo(() => {
    const all = text.split(/\r?\n/);
    if (all.length && all[all.length - 1] === "") all.pop();
    return all;
  }, [text]);
  const hits = useMemo(() => (filter.needle ? lines.reduce((n, l) => n + (l.toLowerCase().includes(filter.needle) ? 1 : 0), 0) : 0), [lines, filter.needle]);

  // Stay at the end of the log (newest lines), like `tail -f`.
  useEffect(() => { if (!filter.needle) viewport.current?.scrollTo({ top: viewport.current.scrollHeight }); }, [text, filter.needle]);

  const shownCount = filter.only && filter.needle ? hits : lines.length;
  const cat = file ? CATEGORIES[file.category] : undefined;
  return (
    <Sheet
      opened={!!file} onClose={onClose} size="min(1180px, 94vw)" testId="log-viewer-sheet"
      icon={<IconFileText size={19} stroke={1.5} />}
      title={file?.name ?? ""}
      subtitle={file && <>{cat?.label ?? file.category}{file.hub && <> · {file.hub}</>}{file.ServerName_str && <> · {file.ServerName_str}</>} · <Mono dim>{file.FilePath_str}</Mono></>}
      footer={(
        <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
          <span className="sa-viewer-meta" style={{ flex: 1, minWidth: 0 }} data-testid="log-meta">
            {meta && <>
              {meta.truncated ? `Last ${bytes(meta.size - meta.from)} of ${bytes(meta.size)}` : `Whole file, ${bytes(meta.size)}`} · {plural(lines.length, "line")}
              {shownCount > MAX_LINES && ` · showing the last ${num(MAX_LINES)}`}
              {follow && " · following"}
            </>}
          </span>
          <Button variant="default" leftSection={<IconRefresh size={14} />} onClick={() => void load()} loading={loading && !follow} data-testid="log-reload">Reload</Button>
          <Button variant="default" leftSection={<IconDeviceFloppy size={14} />} loading={saving} data-testid="log-download"
            onClick={async () => {
              if (!file) return;
              setSaving(true);
              try { await saveWholeFile(serverId, file); } catch (e) { notifyError(e, "Couldn’t save the log file"); } finally { setSaving(false); }
            }}>Save As…</Button>
          <Button onClick={onClose} data-testid="log-close">Done</Button>
        </div>
      )}
    >
      <div data-testid="log-viewer">
        <TextFilterBar filter={filter} hits={hits} testId="log" hitsTestId="log-matches">
          <Select data={TAIL_OPTIONS} value={tail} onChange={(v) => setTail(v ?? "262144")} allowDeselect={false} w={130} size="xs" aria-label="Amount to load" data-testid="log-tail" />
          <Checkbox size="xs" label="Wrap lines" checked={wrap} onChange={(e) => setWrap(e.currentTarget.checked)} data-testid="log-wrap" />
          <Checkbox size="xs" label="Follow" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} data-testid="log-follow"
            title="Reload every 5 seconds and stay at the end" />
        </TextFilterBar>
        {error != null ? <ErrorState error={error} inline onRetry={() => void load()} testId="log-error" />
          : loading && !text ? (
            <div className="sa-text" style={{ height: "calc(100vh - 330px)", display: "grid", placeItems: "center" }}>
              <div style={{ display: "grid", gap: 10, justifyItems: "center" }}>
                <LoadingState label="Reading the log file…" compact />
                <Progress value={progress} w={220} size="sm" aria-label="Progress" />
              </div>
            </div>
          ) : (
            <LinesView lines={lines} filter={filter} height="calc(100vh - 330px)" wrap={wrap} testId="log-content" maxLines={MAX_LINES}
              viewportRef={viewport} firstHit="last" empty={meta ? "The file is empty." : " "} />
          )}
      </div>
    </Sheet>
  );
}

function SyslogSheet({ serverId, opened, onClose }: { serverId: number; opened: boolean; onClose: () => void }) {
  const form = useSyslogForm(serverId, opened);
  useEffect(() => { if (opened) form.reset(); }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Sheet
      opened={opened} onClose={onClose} busy={form.save.isPending} title="Syslog Forwarding" testId="syslog-sheet"
      subtitle="Send log records to a syslog server as well as writing the log files." icon={<IconSend size={18} stroke={1.5} />}
      footer={(
        <Group justify="flex-end" gap={8}>
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button disabled={!form.dirty || !form.valid} loading={form.save.isPending} data-testid="save-syslog"
            onClick={() => void form.submit().then(onClose, () => undefined)}>Save</Button>
        </Group>
      )}
    >
      {form.q.error ? <ErrorState error={form.q.error} inline onRetry={() => void form.q.refetch()} />
        : !form.q.data ? <LoadingState compact label="Loading…" />
        : (
          <FormSection>
            <SyslogFields form={form} />
          </FormSection>
        )}
      {(form.f.SaveType_u32 ?? 0) === 3 && <div style={{ marginTop: 10 }}><Callout tone="yellow">Packet logs can be very large. Make sure the syslog server and the network can take the volume.</Callout></div>}
    </Sheet>
  );
}

export default function LogsPage() {
  const { serverId } = useScope();
  const { s, reachable, hubMode } = useReachable(serverId);
  const enabled = !!s && reachable;
  const q = useRpc<{ LogFiles?: LogFile[] }>(serverId, "EnumLogFile", {}, { enabled, refetchInterval: 30_000 });
  const syslog = useRpc<{ SaveType_u32?: number; Hostname_str?: string; Port_u32?: number }>(serverId, "GetSysLog", {}, { enabled: enabled && !hubMode, retry: false });
  const rows = useMemo(() => (q.data?.LogFiles ?? []).map(toRow), [q.data]);
  const [cat, setCat] = useState<string>("all");
  const [hub, setHub] = useState<string | null>(null);
  const [open, setOpen] = useState<Row | null>(null);
  const [syslogOpen, setSyslogOpen] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, { n: number; size: number }> = {};
    for (const r of rows) { c[r.category] ??= { n: 0, size: 0 }; c[r.category].n++; c[r.category].size += r.FileSize_u32; }
    return c;
  }, [rows]);
  const total = rows.reduce((n, r) => n + r.FileSize_u32, 0);
  const cats = ["server_log", "security_log", "packet_log", ...Object.keys(counts).filter((k) => !CATEGORIES[k])];
  const hubs = [...new Set(rows.filter((r) => (cat === "all" || r.category === cat) && r.hub).map((r) => r.hub))].sort();
  const filtered = rows.filter((r) => (cat === "all" || r.category === cat) && (!hub || r.hub === hub));
  const multiServer = new Set(rows.map((r) => r.ServerName_str)).size > 1;
  const key = (r: Row) => `${r.ServerName_str}|${r.FilePath_str}`;

  const save = async (r: Row) => {
    setSavingKey(key(r));
    try { await saveWholeFile(serverId, r); } catch (e) { notifyError(e, "Couldn’t save the log file"); } finally { setSavingKey(null); }
  };
  const menu = (r: Row): ContextMenuItem[] => [
    { label: "Open", icon: <IconEye size={14} />, onClick: () => setOpen(r), testId: "log-open" },
    { label: "Save As…", icon: <IconDeviceFloppy size={14} />, onClick: () => void save(r), disabled: savingKey !== null, testId: "log-save-as" },
    "divider",
    { label: "Copy Path", icon: <IconCopy size={14} />, onClick: () => void navigator.clipboard.writeText(r.FilePath_str).catch(() => undefined) },
  ];
  const sl = syslog.data;
  const syslogLabel = sl ? (sl.SaveType_u32 ? `${SYSLOG_SHORT[sl.SaveType_u32] ?? "On"} to ${sl.Hostname_str}:${sl.Port_u32 || 514}` : "Off") : undefined;

  return (
    <>
      <PageHeader
        title="Logs & Syslog"
        meta={q.data && <>
          <span>{plural(rows.length, "log file")}</span><span className="sem-dim">·</span><span className="sem-num">{bytes(total)}</span>
          {syslogLabel && <><span className="sem-dim">·</span><span data-testid="syslog-summary">Syslog: {syslogLabel}</span></>}
        </>}
        description="Log files saved on the VPN Server. Double-click a file to read it."
        actions={!hubMode && <Button variant="default" leftSection={<IconSend size={14} />} onClick={() => setSyslogOpen(true)} disabled={!enabled} data-testid="open-syslog">Syslog…</Button>}
      />
      {hubMode && (
        <div className="sem-callouts">
          <Callout tone="purple">Connected with a hub administrator password: only this hub’s security and packet logs are listed.</Callout>
        </div>
      )}
      {s && !reachable ? <Unreachable serverId={serverId} /> : (
        <DataTable
          testId="log-files-table" aria-label="Log files"
          data={q.data ? filtered : undefined} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}
          rowKey={key} selectable="single" onRowOpen={setOpen} contextMenu={menu}
          rowTestId={(r) => `log-row-${r.FilePath_str.replace(/[\\/]/g, "_")}`}
          initialSort={{ key: "UpdatedTime_dt", dir: "desc" }}
          searchPlaceholder="Filter files"
          filters={(
            <>
              <SegmentedControl
                size="xs" value={cat} onChange={(v) => { setCat(v); setHub(null); }} data-testid="log-category" aria-label="Log type"
                data={[
                  { value: "all", label: `All ${rows.length}` },
                  ...cats.map((c) => ({ value: c, label: `${CATEGORIES[c]?.short ?? c} ${counts[c]?.n ?? 0}` })),
                ]}
              />
              {hubs.length > 0 && (
                <Select placeholder="All hubs" data={hubs} value={hub} onChange={setHub} clearable size="xs" w={160} aria-label="Virtual Hub" data-testid="log-hub-filter" />
              )}
            </>
          )}
          empty={{ title: "No log files", description: "The server hasn’t written any logs yet, or logging is turned off.", icon: <IconFileText size={26} stroke={1.4} /> }}
          columns={[
            { key: "name", title: "File", render: (r) => <span className="sem-row-inline" style={{ gap: 6, flexWrap: "nowrap" }}><IconFileText size={14} stroke={1.5} className="sem-dim" /><span className="sem-mono">{r.name}</span></span> },
            { key: "category", title: "Type", width: 96, value: (r) => CATEGORIES[r.category]?.label ?? r.category, render: (r) => <CategoryTag c={r.category} /> },
            { key: "hub", title: "Virtual Hub", width: 150, truncate: true, render: (r) => r.hub || <span className="sem-dim">–</span> },
            { key: "date", title: "Log date", width: 130, render: (r) => <span className="sem-num">{r.date || "–"}</span> },
            { key: "FileSize_u32", title: "Size", align: "right", width: 90, render: (r) => <span className="sem-num">{bytes(r.FileSize_u32)}</span> },
            { key: "UpdatedTime_dt", title: "Last written", width: 120,
              render: (r) => savingKey === key(r) ? <span className="sem-dim">Saving…</span> : <span className="sem-dim" title={dt(r.UpdatedTime_dt)}>{agoShort(r.UpdatedTime_dt)}</span> },
            ...(multiServer ? [{ key: "ServerName_str", title: "Cluster server", width: 140 }] : []),
          ]}
        />
      )}
      {cat !== "all" && CATEGORIES[cat] && <p className="sem-page-description" style={{ marginTop: 8 }}>{CATEGORIES[cat].doc} Total {bytes(counts[cat]?.size ?? 0)}.</p>}
      <LogViewer serverId={serverId} file={open} onClose={() => setOpen(null)} />
      {!hubMode && <SyslogSheet serverId={serverId} opened={syslogOpen} onClose={() => setSyslogOpen(false)} />}
    </>
  );
}
