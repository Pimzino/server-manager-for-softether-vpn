import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  Alert, Anchor, Badge, Box, Button, Drawer, Group, Highlight, Loader, Progress, ScrollArea, SegmentedControl, Select, Stack, Switch, Text, TextInput,
} from "@mantine/core";
import { IconDownload, IconFileText, IconRefresh, IconSearch } from "@tabler/icons-react";
import { DataTable } from "../../components/DataTable";
import { PageHeader, QueryState, Section } from "../../components/common";
import { useServerAccess } from "../../components/server-b/ui";
import { notifyError, useRpc, useScope } from "../../lib/hooks";
import { rpc } from "../../lib/api";
import { ago, bytes, dt } from "../../lib/format";

interface LogFile { ServerName_str: string; FilePath_str: string; FileSize_u32: number; UpdatedTime_dt: string }
interface Row extends LogFile { category: string; hub: string; name: string; date: string }

const CATEGORIES: Record<string, { label: string; color: string; doc: string }> = {
  server_log: { label: "Server log", color: "blue", doc: "Server-wide events: listeners, connections, admin RPC calls, errors." },
  security_log: { label: "Security log", color: "orange", doc: "Per-hub security events: logins, authentication failures, session creation, policy violations." },
  packet_log: { label: "Packet log", color: "grape", doc: "Per-hub packet logs (if enabled on the hub's Logging page) — can be very large." },
};

function toRow(f: LogFile): Row {
  const parts = f.FilePath_str.split(/[\\/]/);
  const category = parts.length > 1 ? parts[0] : "other";
  const name = parts[parts.length - 1];
  const hub = parts.length > 2 ? parts.slice(1, -1).join("/") : "";
  const m = name.match(/(\d{4})(\d{2})(\d{2})(?:_(\d{2}))?/);
  const date = m ? `${m[1]}-${m[2]}-${m[3]}${m[4] ? ` ${m[4]}h` : ""}` : "";
  return { ...f, category, hub, name, date };
}

const TAIL_OPTIONS = [
  { value: "65536", label: "Last 64 KB" },
  { value: "262144", label: "Last 256 KB" },
  { value: "1048576", label: "Last 1 MB" },
  { value: "4194304", label: "Last 4 MB" },
  { value: "0", label: "Entire file" },
];
const MAX_LINES = 20000;

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

function LogViewer({ serverId, file, onClose }: { serverId: number; file: Row | null; onClose: () => void }) {
  const [tail, setTail] = useState("262144");
  const [text, setText] = useState<string>("");
  const [meta, setMeta] = useState<{ from: number; size: number; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [q, setQ] = useState("");
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [follow, setFollow] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async (signal?: { cancelled: boolean }) => {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      // Refresh the size first — the file keeps growing.
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
  const needle = q.trim().toLowerCase();
  const matches = useMemo(() => (needle ? lines.reduce((n, l) => n + (l.toLowerCase().includes(needle) ? 1 : 0), 0) : 0), [lines, needle]);
  const shown = useMemo(() => {
    const idx = lines.map((l, i) => [i, l] as const);
    const filtered = onlyMatches && needle ? idx.filter(([, l]) => l.toLowerCase().includes(needle)) : idx;
    return filtered.length > MAX_LINES ? filtered.slice(filtered.length - MAX_LINES) : filtered;
  }, [lines, needle, onlyMatches]);

  useEffect(() => {
    if (viewport.current) viewport.current.scrollTo({ top: viewport.current.scrollHeight });
  }, [shown.length, text]);

  const downloadFull = async () => {
    if (!file) return;
    setDownloading(true);
    try {
      const data = await readRange(serverId, file, 0);
      const url = URL.createObjectURL(new Blob([data as BlobPart], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${file.ServerName_str ? file.ServerName_str + "-" : ""}${file.FilePath_str.replace(/[\\/]/g, "_")}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      notifyError(e, "ReadLogFile");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Drawer opened={!!file} onClose={onClose} position="right" size="80%" title={<Group gap="xs"><IconFileText size={18} /><Text fw={600}>{file?.FilePath_str}</Text>{file && <Badge variant="light" color={CATEGORIES[file.category]?.color ?? "gray"}>{CATEGORIES[file.category]?.label ?? file.category}</Badge>}</Group>}>
      <Stack gap="sm" data-testid="log-viewer">
        <Group justify="space-between" wrap="wrap">
          <Group gap="xs" wrap="wrap">
            <Select data={TAIL_OPTIONS} value={tail} onChange={(v) => setTail(v ?? "262144")} allowDeselect={false} w={150} size="xs" aria-label="Amount to load" data-testid="log-tail" />
            <TextInput size="xs" placeholder="Search…" leftSection={<IconSearch size={14} />} value={q} onChange={(e) => setQ(e.currentTarget.value)} w={240} data-testid="log-search" />
            {needle && <Badge variant="light" color={matches ? "yellow" : "gray"} data-testid="log-matches">{matches} matching line(s)</Badge>}
            <Switch size="xs" label="Only matching lines" checked={onlyMatches} onChange={(e) => setOnlyMatches(e.currentTarget.checked)} disabled={!needle} />
            <Switch size="xs" label="Wrap" checked={wrap} onChange={(e) => setWrap(e.currentTarget.checked)} />
            <Switch size="xs" label="Follow (5 s)" checked={follow} onChange={(e) => setFollow(e.currentTarget.checked)} data-testid="log-follow" />
          </Group>
          <Group gap="xs">
            <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={() => void load()} loading={loading && !follow}>Reload</Button>
            <Button size="xs" variant="light" leftSection={<IconDownload size={14} />} onClick={downloadFull} loading={downloading} data-testid="log-download">Download full file</Button>
          </Group>
        </Group>
        {meta && (
          <Text size="xs" c="dimmed">
            {meta.truncated ? `Showing the last ${bytes(meta.size - meta.from)} of ${bytes(meta.size)}` : `Entire file, ${bytes(meta.size)}`} · {lines.length.toLocaleString()} line(s)
            {shown.length < (onlyMatches && needle ? matches : lines.length) && ` · only the last ${MAX_LINES.toLocaleString()} lines are rendered`}
            {file?.ServerName_str && ` · server ${file.ServerName_str}`}
          </Text>
        )}
        {loading && !text && (
          <Stack align="center" py="xl"><Loader /><Progress value={progress} w={240} size="sm" /></Stack>
        )}
        {error != null && <Alert color="red" variant="light" title="Could not read the log file">{error instanceof Error ? error.message : String(error)}</Alert>}
        {!loading && !error && meta && lines.length === 0 && <Text c="dimmed" size="sm">The file is empty.</Text>}
        {lines.length > 0 && (
          <ScrollArea h="calc(100vh - 220px)" viewportRef={viewport} type="auto" style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 6 }}>
            <Box component="pre" m={0} p="xs" style={{ fontFamily: "var(--mantine-font-family-monospace)", fontSize: 12, lineHeight: 1.45, whiteSpace: wrap ? "pre-wrap" : "pre", wordBreak: wrap ? "break-all" : undefined }} data-testid="log-content">
              {shown.map(([i, l]) => {
                const hit = !!needle && l.toLowerCase().includes(needle);
                return (
                  <div key={i} style={{ display: "flex", gap: 12, background: hit ? "var(--mantine-color-yellow-light)" : undefined }}>
                    <span style={{ color: "var(--mantine-color-dimmed)", userSelect: "none", minWidth: 48, textAlign: "right" }}>{i + 1}</span>
                    {hit ? <Highlight highlight={q.trim()} component="span" ff="monospace" fz={12}>{l}</Highlight> : <span>{l}</span>}
                  </div>
                );
              })}
            </Box>
          </ScrollArea>
        )}
      </Stack>
    </Drawer>
  );
}

export default function LogsPage() {
  const { serverId } = useScope();
  const { server } = useServerAccess(serverId);
  const q = useRpc<{ LogFiles?: LogFile[] }>(serverId, "EnumLogFile", {}, { refetchInterval: 30_000 });
  const rows = useMemo(() => (q.data?.LogFiles ?? []).map(toRow), [q.data]);
  const [cat, setCat] = useState<string>("all");
  const [hub, setHub] = useState<string | null>(null);
  const [open, setOpen] = useState<Row | null>(null);

  const counts = useMemo(() => {
    const c: Record<string, { n: number; size: number }> = {};
    for (const r of rows) { c[r.category] ??= { n: 0, size: 0 }; c[r.category].n++; c[r.category].size += r.FileSize_u32; }
    return c;
  }, [rows]);
  const cats = ["server_log", "security_log", "packet_log", ...Object.keys(counts).filter((k) => !CATEGORIES[k])];
  const hubs = [...new Set(rows.filter((r) => (cat === "all" || r.category === cat) && r.hub).map((r) => r.hub))].sort();
  const filtered = rows.filter((r) => (cat === "all" || r.category === cat) && (!hub || r.hub === hub));
  const multiServer = new Set(rows.map((r) => r.ServerName_str)).size > 1;

  return (
    <>
      <PageHeader
        title="Logs"
        description="Browse, search and download the log files saved on the VPN Server. Syslog forwarding is configured on the Server settings page; per-hub logging options on each hub's Logging page."
        actions={<Button variant="default" size="xs" leftSection={<IconRefresh size={14} />} onClick={() => q.refetch()} loading={q.isFetching}>Refresh</Button>}
      />
      <Section title="Log files" description={<>Click a file to view its tail. <Anchor component={Link} to={`/servers/${serverId}/settings`} size="sm">Syslog settings</Anchor></>}>
        <QueryState query={q}>
          <Group mb="sm" gap="sm" wrap="wrap">
            <SegmentedControl
              value={cat} onChange={(v) => { setCat(v); setHub(null); }}
              data={[
                { value: "all", label: `All (${rows.length})` },
                ...cats.map((c) => ({ value: c, label: `${CATEGORIES[c]?.label ?? c} (${counts[c]?.n ?? 0})` })),
              ]}
              data-testid="log-category"
            />
            {hubs.length > 0 && (
              <Select placeholder="All hubs" data={hubs} value={hub} onChange={setHub} clearable size="sm" w={200} aria-label="Filter by hub" data-testid="log-hub-filter" />
            )}
            {cat !== "all" && CATEGORIES[cat] && <Text size="xs" c="dimmed">{CATEGORIES[cat].doc} Total {bytes(counts[cat]?.size ?? 0)}.</Text>}
          </Group>
          <DataTable
            testId="log-files-table"
            data={filtered}
            rowKey={(r) => `${r.ServerName_str}|${r.FilePath_str}`}
            onRowClick={setOpen}
            initialSort={{ key: "UpdatedTime_dt", dir: "desc" }}
            maxHeight={640}
            empty="No log files"
            columns={[
              { key: "category", title: "Type", render: (r) => <Badge variant="light" color={CATEGORIES[r.category]?.color ?? "gray"}>{CATEGORIES[r.category]?.label ?? r.category}</Badge> },
              { key: "hub", title: "Virtual Hub", render: (r) => r.hub || <Text size="sm" c="dimmed">–</Text> },
              { key: "FilePath_str", title: "File", render: (r) => <Text size="sm" ff="monospace">{r.FilePath_str}</Text> },
              { key: "date", title: "Log date" },
              { key: "FileSize_u32", title: "Size", align: "right", render: (r) => bytes(r.FileSize_u32) },
              { key: "UpdatedTime_dt", title: "Last written", render: (r) => <Text size="sm" title={dt(r.UpdatedTime_dt)}>{ago(r.UpdatedTime_dt)}</Text> },
              ...(multiServer ? [{ key: "ServerName_str", title: "Cluster server" }] : []),
            ]}
          />
        </QueryState>
      </Section>
      <LogViewer serverId={serverId} file={open} onClose={() => setOpen(null)} />
      {server.data?.hub && <Text size="xs" c="dimmed">Connected in hub admin mode: only this hub's security and packet logs are listed.</Text>}
    </>
  );
}
