import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ActionIcon, Alert, Badge, Button, Checkbox, Group, MultiSelect, Stack, Switch, Text, Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconCertificate, IconEdit, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-react";
import { DataTable } from "../components/DataTable";
import { ConfirmButton, OnlineBadge, PageHeader, QueryState, Section } from "../components/common";
import { AddServerWizard } from "../components/fleet/AddServerWizard";
import { EditServerModal } from "../components/fleet/EditServerModal";
import { BulkPanel } from "../components/fleet/BulkPanel";
import { shortFp, stateMismatch } from "../components/fleet/tls";
import { del, post, put } from "../lib/api";
import { useAuth } from "../lib/auth";
import { notifyError, useServers } from "../lib/hooks";
import { ago, dt } from "../lib/format";
import type { Server } from "../lib/types";

const ROLE_COLOR: Record<string, string> = { admin: "red", operator: "blue", viewer: "gray", none: "gray" };
const TLS_LABEL: Record<Server["tlsMode"], string> = { pin: "Pinned", ca: "CA", insecure: "Insecure" };

function version(s: Server) {
  const v = s.state?.info?.ServerVersionString_str as string | undefined;
  return v ? v.replace(/\s*\(.*\)\s*$/, "") : null;
}

export default function ServersPage() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const servers = useServers();
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ server: Server; repin: boolean } | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [tagFilter, setTagFilter] = useState<string[]>([]);

  // Deep link from the dashboard: /servers?add=1
  useEffect(() => {
    if (params.get("add") && isAdmin) {
      setAdding(true);
      params.delete("add");
      setParams(params, { replace: true });
    }
  }, [params, isAdmin]);

  const allTags = useMemo(() => [...new Set((servers.data ?? []).flatMap((s) => s.tags))].sort(), [servers.data]);
  const rows = useMemo(() => (servers.data ?? []).filter((s) => !tagFilter.length || tagFilter.some((t) => s.tags.includes(t))), [servers.data, tagFilter]);
  const selectedServers = (servers.data ?? []).filter((s) => selected.has(s.id));

  const invalidate = (id?: number) => {
    void qc.invalidateQueries({ queryKey: ["servers"] });
    void qc.invalidateQueries({ queryKey: ["fleet-summary"] });
    if (id !== undefined) void qc.invalidateQueries({ queryKey: ["server", id] });
  };

  const refresh = useMutation({
    mutationFn: (s: Server) => post<Server>(`/api/servers/${s.id}/refresh`),
    onSuccess: (s) => {
      invalidate(s.id);
      void qc.invalidateQueries({ queryKey: ["rpc", s.id] });
      notifications.show({ color: s.state?.ok ? "green" : "orange", message: s.state?.ok ? `${s.name} is reachable (${s.state.latencyMs} ms)` : `${s.name}: ${s.state?.error ?? "unreachable"}` });
    },
    onError: (e) => notifyError(e, "Refresh failed"),
  });
  const refreshAll = useMutation({
    mutationFn: async () => Promise.allSettled((servers.data ?? []).filter((s) => s.enabled).map((s) => post(`/api/servers/${s.id}/refresh`))),
    onSuccess: () => { invalidate(); notifications.show({ color: "green", message: "All servers refreshed" }); },
  });
  const toggle = useMutation({
    mutationFn: ({ s, enabled }: { s: Server; enabled: boolean }) => put<Server>(`/api/servers/${s.id}`, { enabled }),
    onSuccess: (s) => { invalidate(s.id); notifications.show({ color: "green", message: `${s.name} ${s.enabled ? "enabled" : "disabled"}` }); },
    onError: (e) => notifyError(e, "Could not update server"),
  });
  const remove = useMutation({
    mutationFn: (s: Server) => del(`/api/servers/${s.id}`),
    onSuccess: (_r, s) => {
      invalidate(s.id);
      setSelected((sel) => { const n = new Set(sel); n.delete(s.id); return n; });
      notifications.show({ color: "green", message: `Server ${s.name} removed` });
    },
    onError: (e) => notifyError(e, "Could not delete server"),
  });

  const allVisibleSelected = rows.length > 0 && rows.every((s) => selected.has(s.id));
  const someSelected = rows.some((s) => selected.has(s.id));
  const toggleAll = () => setSelected((sel) => {
    const n = new Set(sel);
    if (allVisibleSelected) rows.forEach((s) => n.delete(s.id)); else rows.forEach((s) => n.add(s.id));
    return n;
  });
  const toggleOne = (id: number) => setSelected((sel) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const mismatches = (servers.data ?? []).filter((s) => stateMismatch(s));

  return (
    <>
      <PageHeader
        title="Servers"
        description="Every SoftEther VPN Server registered with this management server. Connections are authenticated with the stored administrator password and protected by TLS certificate pinning or CA verification."
        actions={
          <>
            <Button variant="default" leftSection={<IconRefresh size={16} />} loading={refreshAll.isPending} onClick={() => refreshAll.mutate()} data-testid="servers-refresh-all">Refresh all</Button>
            {isAdmin && <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)} data-testid="add-server">Add server</Button>}
          </>
        }
      />

      {mismatches.length > 0 && (
        <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Certificate changed" mb="md" data-testid="tls-mismatch-alert">
          <Stack gap={4}>
            {mismatches.map((s) => (
              <Group key={s.id} gap="xs">
                <Text size="sm"><b>{s.name}</b> now presents <Text span ff="monospace" size="sm">{shortFp(stateMismatch(s))}</Text> instead of the pinned <Text span ff="monospace" size="sm">{shortFp(s.tlsFingerprint)}</Text>.</Text>
                {isAdmin && <Button size="compact-xs" variant="light" color="orange" leftSection={<IconCertificate size={12} />} onClick={() => setEditing({ server: s, repin: true })}>Review & re-pin</Button>}
              </Group>
            ))}
            <Text size="xs" c="dimmed">Management of these servers is blocked until the new certificate is verified and pinned.</Text>
          </Stack>
        </Alert>
      )}

      <QueryState query={servers}>
        <DataTable
          testId="servers-table"
          data={rows}
          rowKey={(s) => s.id}
          onRowClick={(s) => nav(`/servers/${s.id}`)}
          initialSort={{ key: "name", dir: "asc" }}
          empty={isAdmin ? "No servers yet — click “Add server” to register one." : "No servers have been shared with you."}
          toolbar={
            <>
              {allTags.length > 0 && <MultiSelect data={allTags} value={tagFilter} onChange={setTagFilter} placeholder={tagFilter.length ? undefined : "Filter by tag"} clearable size="sm" w={220} aria-label="Filter by tag" />}
              {selected.size > 0 && <Button size="xs" variant="subtle" color="gray" onClick={() => setSelected(new Set())}>Clear selection ({selected.size})</Button>}
            </>
          }
          columns={[
            {
              key: "select", sortable: false, width: 36,
              title: <Checkbox size="xs" checked={allVisibleSelected} indeterminate={someSelected && !allVisibleSelected} onChange={toggleAll} aria-label="Select all" data-testid="servers-select-all" />,
              render: (s) => (
                <div onClick={(e) => e.stopPropagation()}>
                  <Checkbox size="xs" checked={selected.has(s.id)} onChange={() => toggleOne(s.id)} aria-label={`Select ${s.name}`} data-testid={`server-select-${s.id}`} />
                </div>
              ),
            },
            { key: "name", title: "Name", render: (s) => <div><Text fw={600} size="sm">{s.name}</Text>{s.notes && <Text size="xs" c="dimmed" lineClamp={1} maw={220}>{s.notes}</Text>}</div> },
            { key: "endpoint", title: "Host", value: (s) => `${s.host}:${s.port}`, render: (s) => <Text size="sm" ff="monospace">{s.host}:{s.port}</Text> },
            {
              key: "mode", title: "Mode", value: (s) => (s.hub ? `hub ${s.hub}` : "server"),
              render: (s) => s.hub ? <Badge color="grape" variant="light">Hub admin: {s.hub}</Badge> : <Badge color="gray" variant="light">Server admin</Badge>,
            },
            {
              key: "tls", title: "TLS", value: (s) => s.tlsMode,
              render: (s) => (
                <Group gap={6} wrap="nowrap">
                  <Badge color={s.tlsMode === "insecure" ? "red" : s.tlsMode === "ca" ? "blue" : "green"} variant="light">{TLS_LABEL[s.tlsMode]}</Badge>
                  {s.tlsMode === "pin" && <Tooltip label={s.tlsFingerprint ?? ""} multiline w={300}><Text size="xs" ff="monospace" c="dimmed">{shortFp(s.tlsFingerprint)}</Text></Tooltip>}
                  {stateMismatch(s) && <Badge color="orange" size="xs">changed</Badge>}
                </Group>
              ),
            },
            { key: "tags", title: "Tags", value: (s) => s.tags.join(" "), render: (s) => <Group gap={4}>{s.tags.map((t) => <Badge key={t} size="xs" variant="outline">{t}</Badge>)}</Group> },
            {
              key: "status", title: "Status", value: (s) => (!s.enabled ? 0 : s.state?.ok ? 2 : 1),
              render: (s) => (
                <Stack gap={2}>
                  {!s.enabled ? <Badge color="gray" variant="light">Disabled</Badge> : (
                    <Tooltip label={s.state?.error ?? `Latency ${s.state?.latencyMs ?? "–"} ms`} multiline w={320} withArrow>
                      <span><OnlineBadge online={s.state?.ok} /></span>
                    </Tooltip>
                  )}
                  <Tooltip label={dt(s.state?.checkedAt)}><Text size="xs" c="dimmed">{s.state?.checkedAt ? ago(s.state.checkedAt) : "never checked"}</Text></Tooltip>
                </Stack>
              ),
            },
            { key: "version", title: "Version", value: (s) => version(s) ?? "", render: (s) => <Text size="sm">{version(s) ?? "–"}</Text> },
            { key: "myRole", title: "My role", render: (s) => <Badge color={ROLE_COLOR[s.myRole]} variant="light">{s.myRole}</Badge> },
            {
              key: "actions", title: "", sortable: false, align: "right",
              render: (s) => (
                <Group gap={4} justify="flex-end" wrap="nowrap" onClick={(e) => e.stopPropagation()}>
                  <Tooltip label="Refresh now">
                    <ActionIcon variant="subtle" onClick={() => refresh.mutate(s)} loading={refresh.isPending && refresh.variables?.id === s.id} aria-label={`Refresh ${s.name}`} data-testid={`server-refresh-${s.id}`}>
                      <IconRefresh size={16} />
                    </ActionIcon>
                  </Tooltip>
                  {isAdmin && (
                    <>
                      <Tooltip label={s.enabled ? "Disable" : "Enable"}>
                        <Switch size="xs" checked={s.enabled} onChange={(e) => toggle.mutate({ s, enabled: e.currentTarget.checked })} aria-label={`Enable ${s.name}`} data-testid={`server-enable-${s.id}`} />
                      </Tooltip>
                      <Tooltip label="Edit">
                        <ActionIcon variant="subtle" onClick={() => setEditing({ server: s, repin: false })} aria-label={`Edit ${s.name}`} data-testid={`server-edit-${s.id}`}><IconEdit size={16} /></ActionIcon>
                      </Tooltip>
                      <ConfirmButton
                        title={`Remove server ${s.name}?`}
                        message={<>The server is removed from the management server together with its stored credentials, cached state, configuration backups and access grants. The VPN Server itself is <b>not</b> changed.</>}
                        typeToConfirm={s.name} confirmLabel="Remove server" onConfirm={() => remove.mutateAsync(s)} leftSection={<IconTrash size={14} />}
                      >Delete</ConfirmButton>
                    </>
                  )}
                </Group>
              ),
            },
          ]}
        />
      </QueryState>

      <Section
        title="Bulk operations"
        description={selectedServers.length
          ? `Run one SoftEther RPC on the ${selectedServers.length} selected server(s): ${selectedServers.map((s) => s.name).join(", ")}. Example: create the same user on hub X on every selected server.`
          : "Run one SoftEther RPC on several servers at once — e.g. create the same user on a hub on every selected server."}
      >
        <BulkPanel selected={selectedServers} />
      </Section>

      <AddServerWizard opened={adding} onClose={() => setAdding(false)} existingTags={allTags} />
      <EditServerModal server={editing?.server ?? null} repin={editing?.repin} onClose={() => setEditing(null)} existingTags={allTags} />
    </>
  );
}
