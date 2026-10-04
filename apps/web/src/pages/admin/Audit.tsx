import { Fragment, useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Alert, Autocomplete, Badge, Button, Code, Collapse, Group, Pagination, Paper, ScrollArea, Select, SimpleGrid, Table, Text, TextInput, Tooltip,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconChevronDown, IconChevronRight, IconDownload, IconFilterOff, IconLock, IconRefresh, IconSearch } from "@tabler/icons-react";
import dayjs from "dayjs";
import { Empty, KeyValue, PageHeader, QueryState } from "../../components/common";
import { get } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { can, useServers } from "../../lib/hooks";
import { ago } from "../../lib/format";

interface AuditRow {
  id: number; ts: number; user_id: number | null; username: string | null; ip: string | null; action: string;
  server_id: number | null; server_name: string | null; hub: string | null; target: string | null;
  details: unknown; success: boolean; error: string | null;
}

const ACTION_PREFIXES = [
  "auth.", "auth.login", "auth.mfa", "auth.password_change",
  "user.", "user.create", "user.update", "user.delete", "user.grant_add", "user.grant_remove", "token.",
  "server.", "server.create", "server.update", "server.delete", "settings.update",
  "rpc.", "bulk.", "backup.", "profile.", "package.", "installer.",
];

const PAGE_SIZES = ["50", "100", "250", "500"];

function actionColor(a: string) {
  if (a.startsWith("auth.")) return "violet";
  if (a.startsWith("user.") || a.startsWith("token.")) return "orange";
  if (a.startsWith("server.") || a.startsWith("settings.")) return "red";
  if (a.startsWith("bulk.")) return "cyan";
  return "blue";
}

/** datetime-local value ("YYYY-MM-DDTHH:mm") -> epoch ms */
const toMs = (v: string) => (v ? dayjs(v).valueOf() : undefined);

export default function AuditPage() {
  const { user } = useAuth();
  const servers = useServers();
  const [q, setQ] = useState("");
  const [username, setUsername] = useState("");
  const [action, setAction] = useState("");
  const [serverId, setServerId] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState("100");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [dq] = useDebouncedValue(q, 350);
  const [dUser] = useDebouncedValue(username, 350);
  const [dAction] = useDebouncedValue(action, 350);

  const filters = useMemo(() => {
    const p = new URLSearchParams();
    if (dq.trim()) p.set("q", dq.trim());
    if (dUser.trim()) p.set("user", dUser.trim());
    if (dAction.trim()) p.set("action", dAction.trim());
    if (serverId) p.set("serverId", serverId);
    if (success) p.set("success", success);
    const f = toMs(from), t = toMs(to);
    if (f) p.set("from", String(f));
    if (t) p.set("to", String(t + 59_999)); // inclusive of the selected minute
    return p;
  }, [dq, dUser, dAction, serverId, success, from, to]);

  useEffect(() => { setPage(1); setExpanded(new Set()); }, [filters.toString(), pageSize]);

  const limit = Number(pageSize);
  const listParams = new URLSearchParams(filters);
  listParams.set("limit", String(limit));
  listParams.set("offset", String((page - 1) * limit));
  const audit = useQuery({
    queryKey: ["audit", listParams.toString()],
    queryFn: () => get<{ total: number; rows: AuditRow[] }>(`/api/audit?${listParams.toString()}`),
    placeholderData: keepPreviousData,
    enabled: can(user?.role, "operator"),
  });

  const csvParams = new URLSearchParams(filters);
  csvParams.set("format", "csv");
  csvParams.set("limit", "5000");
  const csvHref = `/api/audit?${csvParams.toString()}`;
  const total = audit.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / limit));
  const hasFilters = [...filters.keys()].length > 0;
  const clear = () => { setQ(""); setUsername(""); setAction(""); setServerId(null); setSuccess(null); setFrom(""); setTo(""); };
  const toggle = (id: number) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (!can(user?.role, "operator")) {
    return <><PageHeader title="Audit log" /><Alert color="gray" icon={<IconLock size={16} />}>The audit log requires the operator or admin role.</Alert></>;
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every sign-in, configuration change and SoftEther RPC executed through this management server, with who, when, from where and the outcome. Read-only RPCs are recorded only when they are denied."
        actions={
          <>
            <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => void audit.refetch()} loading={audit.isFetching} data-testid="audit-refresh">Refresh</Button>
            <Button component="a" href={csvHref} download leftSection={<IconDownload size={16} />} variant="light" data-testid="audit-export-csv">Export CSV</Button>
          </>
        }
      />
      <Paper withBorder radius="md" p="md" mb="md" data-testid="audit-filters">
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="sm">
          <TextInput label="Search" placeholder="Action, target, details, error, hub, server…" leftSection={<IconSearch size={14} />} value={q} onChange={(e) => setQ(e.currentTarget.value)} data-testid="audit-q" />
          <TextInput label="User" placeholder="Exact username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} data-testid="audit-user" />
          <Autocomplete label="Action prefix" placeholder="e.g. user. or rpc.CreateUser" data={ACTION_PREFIXES} value={action} onChange={setAction} data-testid="audit-action" />
          <Select label="Server" placeholder="Any server" clearable searchable value={serverId} onChange={setServerId}
            data={(servers.data ?? []).map((s) => ({ value: String(s.id), label: s.name }))} data-testid="audit-server" />
          <Select label="Outcome" placeholder="Any" clearable value={success} onChange={setSuccess}
            data={[{ value: "true", label: "Succeeded" }, { value: "false", label: "Failed" }]} data-testid="audit-success" />
          <TextInput type="datetime-local" label="From" value={from} onChange={(e) => setFrom(e.currentTarget.value)} max={to || undefined} data-testid="audit-from" />
          <TextInput type="datetime-local" label="To" value={to} onChange={(e) => setTo(e.currentTarget.value)} min={from || undefined} data-testid="audit-to"
            error={from && to && toMs(to)! < toMs(from)! ? "Before “From”" : undefined} />
          <Group align="flex-end">
            <Button variant="subtle" color="gray" leftSection={<IconFilterOff size={16} />} onClick={clear} disabled={!hasFilters && !q && !username && !action}>Clear filters</Button>
          </Group>
        </SimpleGrid>
      </Paper>

      <QueryState query={audit}>
        <ScrollArea type="auto">
          <Table striped highlightOnHover verticalSpacing="xs" miw={900} data-testid="audit-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={28} />
                <Table.Th>Time</Table.Th>
                <Table.Th>User</Table.Th>
                <Table.Th>Action</Table.Th>
                <Table.Th>Server / hub</Table.Th>
                <Table.Th>Target</Table.Th>
                <Table.Th>Result</Table.Th>
                <Table.Th>IP</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(audit.data?.rows ?? []).map((r) => {
                const open = expanded.has(r.id);
                return (
                  <Fragment key={r.id}>
                    <Table.Tr style={{ cursor: "pointer" }} onClick={() => toggle(r.id)} data-testid={`audit-row-${r.id}`}>
                      <Table.Td>{open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}</Table.Td>
                      <Table.Td><Tooltip label={ago(r.ts)}><Text size="sm" ff="monospace" style={{ whiteSpace: "nowrap" }}>{dayjs(r.ts).format("YYYY-MM-DD HH:mm:ss")}</Text></Tooltip></Table.Td>
                      <Table.Td><Text size="sm">{r.username ?? "–"}</Text></Table.Td>
                      <Table.Td><Badge variant="light" color={actionColor(r.action)} tt="none">{r.action}</Badge></Table.Td>
                      <Table.Td><Text size="sm">{r.server_name ?? (r.server_id ? `#${r.server_id}` : "–")}{r.hub ? <Text span c="dimmed" size="sm"> / {r.hub}</Text> : null}</Text></Table.Td>
                      <Table.Td><Text size="sm" lineClamp={1} maw={220}>{r.target ?? "–"}</Text></Table.Td>
                      <Table.Td>
                        {r.success ? <Badge color="green" variant="light">OK</Badge> : (
                          <Tooltip label={r.error ?? "Failed"} multiline w={320}><Badge color="red" variant="light">Failed</Badge></Tooltip>
                        )}
                      </Table.Td>
                      <Table.Td><Text size="xs" ff="monospace" c="dimmed">{r.ip ?? "–"}</Text></Table.Td>
                    </Table.Tr>
                    {open && (
                      <Table.Tr>
                        <Table.Td colSpan={8} p={0}>
                          <Collapse expanded={open}>
                            <SimpleGrid cols={{ base: 1, md: 2 }} p="sm">
                              <KeyValue rows={[
                                ["Entry ID", String(r.id)],
                                ["Timestamp", `${dayjs(r.ts).toISOString()} (${ago(r.ts)})`],
                                ["User", r.username ? `${r.username}${r.user_id ? ` (id ${r.user_id})` : ""}` : "–"],
                                ["Source IP", r.ip ?? "–"],
                                ["Server", r.server_name ? `${r.server_name}${r.server_id ? ` (id ${r.server_id})` : ""}` : "–"],
                                ["Virtual Hub", r.hub ?? "–"],
                                ["Target", r.target ?? "–"],
                                ["Error", r.error ? <Text size="sm" c="red">{r.error}</Text> : "–"],
                              ]} />
                              <div>
                                <Text size="xs" c="dimmed" fw={600} mb={4}>DETAILS</Text>
                                {r.details == null ? <Text size="sm" c="dimmed">No details recorded</Text> : (
                                  <ScrollArea.Autosize mah={320}><Code block>{JSON.stringify(r.details, null, 2)}</Code></ScrollArea.Autosize>
                                )}
                              </div>
                            </SimpleGrid>
                          </Collapse>
                        </Table.Td>
                      </Table.Tr>
                    )}
                  </Fragment>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea>
        {audit.data && audit.data.rows.length === 0 && <Empty>{hasFilters ? "No entries match the filters" : "The audit log is empty"}</Empty>}
        <Group justify="space-between" mt="md" wrap="wrap">
          <Text size="sm" c="dimmed" data-testid="audit-total">
            {total === 0 ? "0 entries" : `${((page - 1) * limit + 1).toLocaleString()}–${Math.min(page * limit, total).toLocaleString()} of ${total.toLocaleString()} entries`}
            {total > 5000 && " · CSV export includes the newest 5,000 matching entries"}
          </Text>
          <Group gap="sm">
            <Select size="xs" w={110} data={PAGE_SIZES.map((v) => ({ value: v, label: `${v} / page` }))} value={pageSize} onChange={(v) => setPageSize(v ?? "100")} allowDeselect={false} aria-label="Page size" />
            <Pagination total={pages} value={page} onChange={setPage} size="sm" data-testid="audit-pagination" />
          </Group>
        </Group>
      </QueryState>
    </>
  );
}
