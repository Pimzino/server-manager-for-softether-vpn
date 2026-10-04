import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Alert, Badge, Button, Code, Collapse, Group, JsonInput, Menu, ScrollArea, Select, SimpleGrid, Stack, Table, Tabs, Text, UnstyledButton,
} from "@mantine/core";
import { IconChevronDown, IconChevronRight, IconDownload, IconPlayerPlay, IconTemplate } from "@tabler/icons-react";
import { post } from "../../lib/api";
import { can, notifyError, useCatalog } from "../../lib/hooks";
import { downloadText } from "../../lib/format";
import type { CatalogField, Server } from "../../lib/types";
import { RpcField, defaultValue, fieldLabel } from "../RpcForm";
import { ConfirmButton, Empty, QueryState } from "../common";

interface BulkResult { serverId: number; serverName?: string; ok: boolean; result?: Record<string, unknown>; error?: string }

const PRESETS: { label: string; method: string; params: Record<string, unknown> }[] = [
  { label: "Create a password user on a hub", method: "CreateUser", params: { HubName_str: "", Name_str: "", Realname_utf: "", Note_utf: "", AuthType_u32: 1, Auth_Password_str: "" } },
  { label: "Delete a user from a hub", method: "DeleteUser", params: { HubName_str: "", Name_str: "" } },
  { label: "Set a hub online / offline", method: "SetHubOnline", params: { HubName_str: "", Online_bool: true } },
  { label: "Create a Virtual Hub", method: "CreateHub", params: { HubName_str: "", AdminPasswordPlainText_str: "", Online_bool: true, MaxSession_u32: 0, NoEnum_bool: false, HubType_u32: 0 } },
  { label: "Read server status", method: "GetServerStatus", params: {} },
  { label: "List Virtual Hubs", method: "EnumHub", params: {} },
];

const RISK_COLOR = { read: "gray", write: "blue", danger: "red" } as const;

function summarize(r: Record<string, unknown> | undefined): string {
  if (!r) return "";
  const arrays = Object.entries(r).filter(([, v]) => Array.isArray(v));
  if (arrays.length) return arrays.map(([k, v]) => `${k}: ${(v as unknown[]).length} item(s)`).join(", ");
  const keys = Object.keys(r);
  return keys.length ? `${keys.length} field(s) returned` : "OK";
}

function ResultRow({ r }: { r: BulkResult }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Table.Tr style={{ cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <Table.Td w={28}>{open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}</Table.Td>
        <Table.Td><Text size="sm" fw={600}>{r.serverName ?? `#${r.serverId}`}</Text></Table.Td>
        <Table.Td><Badge color={r.ok ? "green" : "red"} variant="light">{r.ok ? "Success" : "Failed"}</Badge></Table.Td>
        <Table.Td><Text size="sm" c={r.ok ? undefined : "red"} lineClamp={2}>{r.ok ? summarize(r.result) : r.error}</Text></Table.Td>
      </Table.Tr>
      <Table.Tr style={{ display: open ? undefined : "none" }}>
        <Table.Td colSpan={4} p={0}>
          <Collapse expanded={open}>
            <ScrollArea.Autosize mah={360} p="xs">
              <Code block>{JSON.stringify(r.ok ? r.result : { error: r.error }, null, 2)}</Code>
            </ScrollArea.Autosize>
          </Collapse>
        </Table.Td>
      </Table.Tr>
    </>
  );
}

/** Run one SoftEther RPC across several selected servers via POST /api/fleet/rpc. */
export function BulkPanel({ selected }: { selected: Server[] }) {
  const catalog = useCatalog();
  const [method, setMethod] = useState<string | null>(null);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [json, setJson] = useState("{}");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>("form");
  const [showAll, setShowAll] = useState(false);

  const info = method ? catalog.data?.methods[method] : undefined;
  const inputType = info?.input ? catalog.data?.types[info.input] : undefined;

  const methodOptions = useMemo(() => {
    if (!catalog.data) return [];
    const byArea = new Map<string, { value: string; label: string }[]>();
    for (const m of Object.values(catalog.data.methods)) {
      const list = byArea.get(m.area) ?? [];
      list.push({ value: m.name, label: m.name });
      byArea.set(m.area, list);
    }
    return [...byArea.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, items]) => ({ group, items: items.sort((a, b) => a.value.localeCompare(b.value)) }));
  }, [catalog.data]);

  const updateParams = (p: Record<string, unknown>) => { setParams(p); setJson(JSON.stringify(p, null, 2)); setJsonError(null); };
  const pickMethod = (m: string | null, preset?: Record<string, unknown>) => {
    setMethod(m);
    setShowAll(false);
    updateParams(preset ?? {});
  };

  const run = useMutation<{ results: BulkResult[] }, Error, void>({
    mutationFn: () => post<{ results: BulkResult[] }>("/api/fleet/rpc", { method, params, serverIds: selected.map((s) => s.id) }),
    onError: (e) => notifyError(e, "Bulk operation failed"),
  });

  const fields: CatalogField[] = inputType?.fields ?? [];
  const visibleFields = showAll ? fields : fields.filter((f) => f.name in params || !/^(policy:|Recv\.|Send\.|Ex\.)/.test(f.name));
  const risk = info?.risk ?? "read";
  const needsOperator = risk !== "read";
  const lacking = selected.filter((s) => !can(s.myRole, risk === "danger" ? "admin" : needsOperator ? "operator" : "viewer"));
  const results = run.data?.results;
  const okCount = results?.filter((r) => r.ok).length ?? 0;
  const canRun = !!method && selected.length > 0 && !jsonError;
  const runLabel = `Run on ${selected.length} server${selected.length === 1 ? "" : "s"}`;

  return (
    <QueryState query={catalog}>
      <Stack data-testid="bulk-panel">
        {selected.length === 0 && <Alert color="gray" variant="light">Select one or more servers in the table above to run an RPC on all of them.</Alert>}
        <Group align="flex-end" wrap="wrap">
          <Select
            label="RPC method" placeholder="Search methods…" searchable data={methodOptions} value={method} onChange={(m) => pickMethod(m)} w={340}
            nothingFoundMessage="No such method" data-testid="bulk-method" maxDropdownHeight={400}
          />
          <Menu withinPortal position="bottom-start">
            <Menu.Target><Button variant="light" leftSection={<IconTemplate size={16} />}>Templates</Button></Menu.Target>
            <Menu.Dropdown>
              {PRESETS.map((p) => <Menu.Item key={p.label} onClick={() => pickMethod(p.method, p.params)}>{p.label} <Text span size="xs" c="dimmed" ff="monospace">{p.method}</Text></Menu.Item>)}
            </Menu.Dropdown>
          </Menu>
        </Group>

        {info && (
          <Stack gap={4}>
            <Group gap="xs">
              <Badge color={RISK_COLOR[risk]} variant="light">{risk === "read" ? "read-only" : risk === "danger" ? "dangerous (admin)" : "write (operator)"}</Badge>
              <Badge variant="outline" color="gray">{info.area}</Badge>
              {info.hubScoped && <Badge variant="outline" color="grape">hub-scoped — set HubName_str</Badge>}
            </Group>
            <Text size="sm" c="dimmed" lineClamp={4}>{info.doc}</Text>
          </Stack>
        )}

        {info && (
          <Tabs value={tab} onChange={setTab} keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="form">Form</Tabs.Tab>
              <Tabs.Tab value="json">JSON</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="form" pt="sm">
              {!inputType ? <Empty>This method takes no parameters.</Empty> : (
                <Stack gap="xs">
                  <Text size="xs" c="dimmed">Only the fields you set are sent; SoftEther uses defaults for the rest. {fields.length > visibleFields.length && `${fields.length - visibleFields.length} advanced field(s) hidden.`}</Text>
                  <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
                    {visibleFields.map((f) => (
                      <RpcField key={f.name} field={f} catalog={catalog.data!} value={f.name in params ? params[f.name] : defaultValue(f)}
                        onChange={(v) => updateParams({ ...params, [f.name]: v })} />
                    ))}
                  </SimpleGrid>
                  <Group gap="xs">
                    {fields.length > visibleFields.length || showAll ? (
                      <Button size="xs" variant="subtle" onClick={() => setShowAll((s) => !s)}>{showAll ? "Hide advanced fields" : "Show all fields"}</Button>
                    ) : null}
                    {Object.keys(params).length > 0 && <Button size="xs" variant="subtle" color="gray" onClick={() => updateParams({})}>Clear values</Button>}
                  </Group>
                  {Object.keys(params).length > 0 && (
                    <Text size="xs" c="dimmed">Sending: {Object.keys(params).map(fieldLabel).join(", ")}</Text>
                  )}
                </Stack>
              )}
            </Tabs.Panel>
            <Tabs.Panel value="json" pt="sm">
              <JsonInput
                label="Parameters (JSON object)" autosize minRows={6} maxRows={24} value={json} formatOnBlur data-testid="bulk-json"
                onChange={(s) => {
                  setJson(s);
                  try {
                    const v = JSON.parse(s || "{}");
                    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("Must be a JSON object");
                    setParams(v as Record<string, unknown>); setJsonError(null);
                  } catch (e) { setJsonError((e as Error).message); }
                }}
                error={jsonError}
              />
            </Tabs.Panel>
          </Tabs>
        )}

        {info && lacking.length > 0 && (
          <Alert color="orange" variant="light">
            Your role is insufficient for {method} on {lacking.map((s) => s.name).join(", ")}; those calls will be rejected.
          </Alert>
        )}

        {info && (
          <Group justify="flex-end">
            {risk === "read" ? (
              <Button leftSection={<IconPlayerPlay size={16} />} disabled={!canRun} loading={run.isPending} onClick={() => run.mutate()} data-testid="bulk-run">{runLabel}</Button>
            ) : (
              <ConfirmButton
                variant="filled" size="sm" color={risk === "danger" ? "red" : "blue"} disabled={!canRun} loading={run.isPending}
                leftSection={<IconPlayerPlay size={16} />} title={`Run ${method} on ${selected.length} server(s)?`} confirmLabel="Run"
                typeToConfirm={risk === "danger" ? method! : undefined}
                message={<Stack gap={4}>
                  <Text size="sm">This changes configuration on: <b>{selected.map((s) => s.name).join(", ")}</b>.</Text>
                  <Code block>{JSON.stringify(params, null, 2)}</Code>
                  <Text size="xs" c="dimmed">Each call is authorised and audited individually.</Text>
                </Stack>}
                onConfirm={() => run.mutateAsync()}
              ><span data-testid="bulk-run">{runLabel}</span></ConfirmButton>
            )}
          </Group>
        )}

        {results && (
          <Stack gap="xs" data-testid="bulk-results">
            <Group justify="space-between">
              <Group gap="xs">
                <Text fw={600}>Results</Text>
                <Badge color="green" variant="light">{okCount} succeeded</Badge>
                {results.length - okCount > 0 && <Badge color="red" variant="light">{results.length - okCount} failed</Badge>}
              </Group>
              <UnstyledButton onClick={() => downloadText(`bulk-${method}-${new Date().toISOString().slice(0, 19)}.json`, JSON.stringify({ method, params, results }, null, 2), "application/json")}>
                <Group gap={4}><IconDownload size={14} /><Text size="sm">Download JSON</Text></Group>
              </UnstyledButton>
            </Group>
            <Table withTableBorder>
              <Table.Thead><Table.Tr><Table.Th /><Table.Th>Server</Table.Th><Table.Th>Result</Table.Th><Table.Th>Details</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>{results.map((r) => <ResultRow key={r.serverId} r={r} />)}</Table.Tbody>
            </Table>
          </Stack>
        )}
      </Stack>
    </QueryState>
  );
}
