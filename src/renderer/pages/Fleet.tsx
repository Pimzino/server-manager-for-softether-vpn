// Overview of every saved connection: health, load and the busiest hubs. Shows the welcome screen
// when there are no connections yet.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Group, MultiSelect, SegmentedControl } from "@mantine/core";
import {
  IconArrowDown, IconArrowUp, IconLock, IconLockOpen, IconPencil, IconPlayerPlay, IconPlus, IconRefresh, IconServer2, IconTrash,
} from "@tabler/icons-react";
import { del, post } from "../lib/api";
import { notifyError, notifySuccess, useFleet } from "../lib/hooks";
import { agoShort, bytes, dt, num, serverVersionShort, trafficOf } from "../lib/format";
import type { HubListItem, Server } from "../lib/types";
import { hubBase, serverBase } from "../sections";
import {
  confirmAction, DataTable, ErrorState, Metric, MetricGrid, MetricSkeleton, Mono, PageHeader, Section, StatusBadge, Tag, TableSkeleton,
  serverStatus, useShell, type ContextMenuItem,
} from "../design";
import Welcome from "./Welcome";

const statusOf = (s: Server) => s.state?.status as Record<string, number> | null | undefined;
const hubsOf = (s: Server): HubListItem[] => s.state?.hubs?.HubList ?? [];
/** End an error message with a full stop so the “Checked …” sentence that follows reads correctly. */
const sentence = (t: string) => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
const STATUS_RANK = { error: 0, locked: 1, unknown: 2, busy: 2, warning: 2, ok: 3, off: 4 } as const;

function Problems({ servers }: { servers: Server[] }) {
  const shell = useShell();
  const nav = useNavigate();
  const problems = servers.map((s) => ({ s, st: serverStatus(s) })).filter(({ st }) => st.status === "error" || st.status === "locked");
  if (!problems.length) return null;
  return (
    <div className="sem-callouts" data-testid="fleet-problems">
      {problems.map(({ s, st }) => (
        <div key={s.id} className="sem-callout" data-tone={st.status === "locked" ? "yellow" : "red"}>
          {st.status === "locked" ? <IconLock size={16} stroke={1.7} /> : <IconServer2 size={16} stroke={1.7} />}
          <div className="sem-callout-text">
            <b>{s.name}</b> {st.status === "locked" ? "is locked because its password isn’t saved." : "can’t be reached."}
            {st.status === "error" && <div className="sem-callout-detail">{sentence(s.state?.error ?? "The last status check failed.")} Checked {agoShort(s.state?.checkedAt)}.</div>}
          </div>
          {st.status === "locked"
            ? <Button size="xs" variant="default" onClick={() => shell.openUnlock(s.id)}>Unlock…</Button>
            : <Button size="xs" variant="default" onClick={() => nav(serverBase(s.id))}>Show</Button>}
        </div>
      ))}
    </div>
  );
}

export default function Fleet() {
  const q = useFleet();
  const nav = useNavigate();
  const qc = useQueryClient();
  const shell = useShell();
  const [filter, setFilter] = useState("all");
  const [tags, setTags] = useState<string[]>([]);
  const [selection, setSelection] = useState<(string | number)[]>([]);

  const all = q.data?.servers ?? [];
  const allTags = useMemo(() => [...new Set(all.flatMap((s) => s.tags))].sort(), [all]);
  const servers = useMemo(() => all.filter((s) => {
    if (tags.length && !tags.some((t) => s.tags.includes(t))) return false;
    const st = serverStatus(s).status;
    if (filter === "online" && st !== "ok") return false;
    if (filter === "attention" && st !== "error" && st !== "locked") return false;
    return true;
  }), [all, tags, filter]);

  const totals = useMemo(() => {
    const t = { online: 0, sessions: 0, users: 0, hubs: 0, recv: 0, send: 0 };
    for (const s of servers) {
      if (serverStatus(s).status === "ok") t.online++;
      const st = statusOf(s);
      t.sessions += st?.NumSessionsTotal_u32 ?? 0;
      t.users += st?.NumUsers_u32 ?? 0;
      t.hubs += st?.NumHubTotal_u32 ?? hubsOf(s).length;
      const tr = trafficOf(st);
      t.recv += tr.recv; t.send += tr.send;
    }
    return t;
  }, [servers]);

  const topHubs = useMemo(() => servers
    .flatMap((s) => hubsOf(s).map((h) => ({ server: s, hub: h })))
    .sort((a, b) => (b.hub.NumSessions_u32 ?? 0) - (a.hub.NumSessions_u32 ?? 0) || a.hub.HubName_str.localeCompare(b.hub.HubName_str))
    .slice(0, 8), [servers]);

  if (q.data && all.length === 0) return <Welcome />;

  const rowMenu = (s: Server, selected: Server[]): ContextMenuItem[] => {
    const many = selected.length > 1;
    const st = serverStatus(s);
    return [
      ...(!many ? [
        { label: "Open", icon: <IconServer2 size={14} />, onClick: () => nav(serverBase(s.id)) },
        { label: "Edit Connection…", icon: <IconPencil size={14} />, onClick: () => shell.openConnection(s.id) },
        ...(st.status === "locked" ? [{ label: "Unlock…", icon: <IconLockOpen size={14} />, onClick: () => shell.openUnlock(s.id) }] : []),
      ] : []),
      { label: many ? `Run RPC on ${selected.length} Servers…` : "Run RPC…", icon: <IconPlayerPlay size={14} />, onClick: () => shell.openBulk(selected.map((x) => x.id)) },
      { label: many ? `Refresh ${selected.length} Servers` : "Refresh Status", icon: <IconRefresh size={14} />, onClick: async () => {
        await Promise.all(selected.map((x) => post(`/api/servers/${x.id}/refresh`).catch((e) => notifyError(e, `Couldn’t refresh ${x.name}`))));
        void qc.invalidateQueries();
      } },
      "divider",
      { label: many ? `Delete ${selected.length} Connections…` : "Delete Connection…", icon: <IconTrash size={14} />, danger: true, onClick: async () => {
        const ok = await confirmAction({
          title: many ? <>Delete {selected.length} connections?</> : <>Delete the connection “{s.name}”?</>,
          message: "The VPN Servers aren’t changed. The saved connections, their passwords and their configuration backups are removed from this app.",
          confirmLabel: many ? "Delete Connections" : "Delete Connection",
        });
        if (!ok) return;
        for (const x of selected) { try { await del(`/api/servers/${x.id}`); } catch (e) { notifyError(e, `Couldn’t delete ${x.name}`); } }
        void qc.invalidateQueries();
        notifySuccess(many ? `Deleted ${selected.length} connections` : `Deleted ${s.name}`);
      } },
    ];
  };

  return (
    <>
      <PageHeader
        title="Overview"
        meta={q.data ? <>{all.length} {all.length === 1 ? "server" : "servers"} · {all.filter((s) => serverStatus(s).status === "ok").length} online</> : undefined}
        actions={(
          <>
            <Button variant="default" leftSection={<IconPlayerPlay size={14} />} onClick={() => shell.openBulk(selection.length ? selection.map(Number) : undefined)} data-testid="fleet-bulk">
              {selection.length > 1 ? `Run on ${selection.length} Servers…` : "Run on Servers…"}
            </Button>
            <Button leftSection={<IconPlus size={14} />} onClick={() => shell.openConnection()} data-testid="fleet-add">Add Connection…</Button>
          </>
        )}
      />

      {q.error && !q.data && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}

      {q.isLoading ? <MetricSkeleton count={5} /> : (
        <MetricGrid testId="fleet-metrics">
          <Metric label="Servers online" value={<>{totals.online}<span className="sem-metric-of">/{servers.length}</span></>} tone={totals.online < servers.length ? "orange" : undefined} testId="kpi-online" />
          <Metric label="VPN sessions" value={num(totals.sessions)} testId="kpi-sessions" />
          <Metric label="Virtual Hubs" value={num(totals.hubs)} testId="kpi-hubs" />
          <Metric label="Users" value={num(totals.users)} hint="Across all hubs" testId="kpi-users" />
          <Metric label="Traffic since start" value={bytes(totals.recv + totals.send)} testId="kpi-traffic"
            hint={<span className="sem-inline-icons"><IconArrowDown size={11} />{bytes(totals.recv)} <IconArrowUp size={11} />{bytes(totals.send)}</span>} />
        </MetricGrid>
      )}

      {q.data && <Problems servers={servers} />}

      <Section title="Servers">
        {q.isLoading ? <TableSkeleton columns={6} /> : (
          <DataTable
            testId="fleet-servers"
            aria-label="Servers"
            data={servers}
            rowKey={(s) => s.id}
            selectable="multi"
            selection={selection}
            onSelectionChange={setSelection}
            onRowOpen={(s) => nav(serverBase(s.id))}
            contextMenu={rowMenu}
            rowTestId={(s) => `fleet-row-${s.id}`}
            initialSort={{ key: "name", dir: "asc" }}
            rowTone={(s) => (s.enabled ? undefined : "dim")}
            empty={{ title: "No servers match", description: "Change the filter to see more servers." }}
            filters={(
              <Group gap={8} wrap="nowrap">
                <SegmentedControl value={filter} onChange={setFilter} data={[
                  { value: "all", label: "All" }, { value: "online", label: "Online" }, { value: "attention", label: "Needs Attention" },
                ]} data-testid="fleet-filter" />
                {allTags.length > 0 && <MultiSelect data={allTags} value={tags} onChange={setTags} placeholder={tags.length ? undefined : "Tags"} clearable size="xs" w={180} aria-label="Filter by tag" />}
              </Group>
            )}
            columns={[
              { key: "status", title: "Status", width: 104, value: (s) => STATUS_RANK[serverStatus(s).status], render: (s) => {
                const st = serverStatus(s);
                const checked = s.state?.checkedAt ? `Checked ${agoShort(s.state.checkedAt)} (${dt(s.state.checkedAt)})` : undefined;
                return <StatusBadge status={st.status} tooltip={[st.detail, checked].filter(Boolean).join(" · ") || undefined}>{st.label}</StatusBadge>;
              } },
              { key: "name", title: "Name", render: (s) => (
                <span className="sem-cell-title">
                  <span className="sem-strong">{s.name}</span>
                  {s.hub && <Tag color="purple" title={`Hub administrator of ${s.hub}`}>Hub: {s.hub}</Tag>}
                  {s.tags.map((t) => <Tag key={t} variant="outline">{t}</Tag>)}
                </span>
              ) },
              { key: "endpoint", title: "Address", value: (s) => `${s.host}:${s.port}`, render: (s) => <Mono dim>{s.host}:{s.port}</Mono> },
              { key: "version", title: "Version", width: 100, value: (s) => serverVersionShort(s.state?.info) ?? "", render: (s) => serverVersionShort(s.state?.info) ?? <span className="sem-dim">–</span> },
              { key: "sessions", title: "Sessions", align: "right", width: 80, value: (s) => statusOf(s)?.NumSessionsTotal_u32 ?? -1, render: (s) => num(statusOf(s)?.NumSessionsTotal_u32) },
              { key: "hubs", title: "Hubs", align: "right", width: 60, value: (s) => statusOf(s)?.NumHubTotal_u32 ?? hubsOf(s).length, render: (s) => num(statusOf(s)?.NumHubTotal_u32 ?? (s.state?.hubs ? hubsOf(s).length : undefined)) },
              { key: "traffic", title: "Traffic ↓ / ↑", align: "right", width: 140, value: (s) => { const t = trafficOf(statusOf(s)); return t.recv + t.send; }, render: (s) => {
                const st = statusOf(s);
                if (!st) return <span className="sem-dim">–</span>;
                const t = trafficOf(st);
                return <span className="sem-num">{bytes(t.recv)} / {bytes(t.send)}</span>;
              } },
              { key: "latency", title: "Latency", align: "right", width: 76, value: (s) => s.state?.latencyMs ?? 1e9, render: (s) => (s.state?.ok && s.state.latencyMs != null ? `${s.state.latencyMs} ms` : <span className="sem-dim">–</span>) },
            ]}
          />
        )}
      </Section>

      <Section title="Busiest Virtual Hubs" description="Across the servers listed above, by current sessions.">
        <DataTable
          testId="fleet-hubs"
          aria-label="Busiest Virtual Hubs"
          data={q.data ? topHubs : undefined}
          loading={q.isLoading}
          rowKey={(r) => `${r.server.id}/${r.hub.HubName_str}`}
          searchable={false}
          footer={false}
          selectable="single"
          onRowOpen={(r) => nav(hubBase(r.server.id, r.hub.HubName_str))}
          empty={{ title: "No hub data yet", description: "Hubs appear once servers have been reached." }}
          columns={[
            { key: "hub", title: "Hub", value: (r) => r.hub.HubName_str, render: (r) => <span className="sem-strong">{r.hub.HubName_str}</span> },
            { key: "server", title: "Server", value: (r) => r.server.name },
            { key: "status", title: "Status", width: 100, value: (r) => (r.hub.Online_bool ? 1 : 0), render: (r) => <StatusBadge status={r.hub.Online_bool ? "ok" : "off"}>{r.hub.Online_bool ? "Online" : "Offline"}</StatusBadge> },
            { key: "sessions", title: "Sessions", align: "right", width: 80, value: (r) => r.hub.NumSessions_u32, render: (r) => num(r.hub.NumSessions_u32) },
            { key: "users", title: "Users", align: "right", width: 70, value: (r) => r.hub.NumUsers_u32, render: (r) => num(r.hub.NumUsers_u32) },
            { key: "traffic", title: "Traffic ↓ / ↑", align: "right", width: 150, value: (r) => { const t = trafficOf(r.hub, "Ex."); return t.recv + t.send; }, render: (r) => { const t = trafficOf(r.hub, "Ex."); return <span className="sem-num">{bytes(t.recv)} / {bytes(t.send)}</span>; } },
            { key: "last", title: "Last activity", width: 120, value: (r) => String(r.hub.LastCommTime_dt ?? ""), render: (r) => <span className="sem-dim">{agoShort(r.hub.LastCommTime_dt)}</span> },
          ]}
        />
      </Section>
    </>
  );
}
