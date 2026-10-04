import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import {
  Accordion, Alert, Autocomplete, Badge, Box, Button, Card, Center, CopyButton, Group, JsonInput, Kbd, Loader, Menu, NavLink, Paper,
  ScrollArea, SegmentedControl, Spoiler, Stack, Table, Text, TextInput, Title, Tooltip, UnstyledButton,
} from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import { useQueryClient } from "@tanstack/react-query";
import {
  IconAlertTriangle, IconChevronDown, IconClearAll, IconCopy, IconDatabaseImport, IconEraser, IconHistory, IconLock, IconPlayerPlay, IconSearch,
} from "@tabler/icons-react";
import { ConfirmButton, ErrorAlert, PageHeader, QueryState } from "../../components/common";
import { RpcField, emptyParams } from "../../components/RpcForm";
import { JsonResult } from "../../components/server-a/JsonResult";
import { ApiError, rpc } from "../../lib/api";
import { can, useCatalog, useRpc, useScope, useServer } from "../../lib/hooks";
import type { Catalog, MethodInfo, Role } from "../../lib/types";
import type { HubListItem } from "../../lib/types";

// ---------- constants ----------

const AREA_LABEL: Record<string, string> = {
  server: "Server", listener: "Listeners & ports", cluster: "Clustering", certificate: "Certificate & TLS", hub: "Virtual Hubs",
  user: "Users", group: "Groups", access: "Access lists", session: "Sessions & tables", cascade: "Cascade connections",
  securenat: "SecureNAT", bridge: "Local bridge & VLAN", l3switch: "Layer 3 switches", log: "Logs & syslog", config: "Configuration",
  ipsec: "IPsec / L2TP / EtherIP", protocols: "OpenVPN / SSTP / protocols", ddns: "DDNS & VPN Azure", wireguard: "WireGuard",
  license: "License", security: "Security", diagnostics: "Diagnostics",
};
const AREA_ORDER = Object.keys(AREA_LABEL);
const RISK_COLOR: Record<MethodInfo["risk"], string> = { read: "green", write: "orange", danger: "red" };
const RISK_ROLE: Record<MethodInfo["risk"], Role> = { read: "viewer", write: "operator", danger: "admin" };
const HUB_FIELDS = ["HubName_str", "HubName_Ex_str", "RpcHubName_str"];
/** Server-level methods the backend lets hub-limited users call. */
const NAV_METHODS = new Set(["EnumHub", "GetServerInfo", "GetCaps", "Test"]);
const SECRET_RE = /password|secret|psk|privatekey|private_key|presharedkey|hashedkey|ntlm/i;
const HISTORY_MAX = 50;
const HISTORY_RESULT_MAX = 100_000;

interface HistoryEntry {
  id: string;
  at: number;
  method: string;
  params: Record<string, unknown>;
  ok: boolean;
  ms: number;
  result?: unknown;
  error?: { message: string; code?: number; status?: number };
}

// ---------- helpers ----------

function hubFieldOf(catalog: Catalog, m: MethodInfo): string | null {
  const t = m.input ? catalog.types[m.input] : undefined;
  return t?.fields.find((f) => HUB_FIELDS.includes(f.name))?.name ?? null;
}

function firstSentence(doc: string) {
  const s = doc.split(/(?<=\.)\s/)[0] ?? doc;
  return s.length > 110 ? s.slice(0, 107) + "…" : s;
}

function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) =>
      [k, SECRET_RE.test(k) && typeof x === "string" && x ? "" : redact(x)]));
  }
  return v;
}

function hasSecrets(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasSecrets);
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).some(([k, x]) => (SECRET_RE.test(k) && typeof x === "string" && !!x) || hasSecrets(x));
  return false;
}

function loadHistory(key: string): HistoryEntry[] {
  try { const s = sessionStorage.getItem(key); return s ? (JSON.parse(s) as HistoryEntry[]) : []; } catch { return []; }
}
function saveHistory(key: string, h: HistoryEntry[]) {
  try { sessionStorage.setItem(key, JSON.stringify(h)); } catch { /* storage full or unavailable */ }
}

function RiskBadge({ risk, size = "xs" }: { risk: MethodInfo["risk"]; size?: string }) {
  return <Badge size={size} variant="light" color={RISK_COLOR[risk]}>{risk}</Badge>;
}

// ---------- method picker ----------

function MethodPicker({ methods, selected, onSelect }: { methods: MethodInfo[]; selected: string | null; onSelect: (m: string) => void }) {
  const [q, setQ] = useState("");
  const [risk, setRisk] = useState("all");
  const [area, setArea] = useState<string | null>(null);
  const needle = q.trim().toLowerCase();
  const filtered = methods.filter((m) =>
    (risk === "all" || m.risk === risk) &&
    (!area || m.area === area) &&
    (!needle || m.name.toLowerCase().includes(needle) || m.doc.toLowerCase().includes(needle)));
  // Name matches first, then doc matches.
  filtered.sort((a, b) => {
    if (needle) {
      const an = a.name.toLowerCase().includes(needle) ? 0 : 1, bn = b.name.toLowerCase().includes(needle) ? 0 : 1;
      if (an !== bn) return an - bn;
    }
    return a.name.localeCompare(b.name);
  });
  const areas = [...new Set(methods.map((m) => m.area))].sort((a, b) => AREA_ORDER.indexOf(a) - AREA_ORDER.indexOf(b));
  const groups = needle
    ? [{ area: "__search", items: filtered }]
    : areas.map((a) => ({ area: a, items: filtered.filter((m) => m.area === a) })).filter((g) => g.items.length);

  return (
    <Paper withBorder radius="md" p="xs" w={{ base: "100%", md: 330 }} style={{ flexShrink: 0 }} data-testid="console-method-picker">
      <Stack gap={6}>
        <TextInput placeholder={`Search ${methods.length} methods…`} leftSection={<IconSearch size={16} />} value={q}
          onChange={(e) => setQ(e.currentTarget.value)} aria-label="Search methods" data-testid="console-method-search" />
        <SegmentedControl size="xs" fullWidth value={risk} onChange={setRisk} data={[
          { value: "all", label: "All" }, { value: "read", label: "Read" }, { value: "write", label: "Write" }, { value: "danger", label: "Danger" },
        ]} aria-label="Risk filter" />
        <Menu position="bottom-start" withinPortal>
          <Menu.Target>
            <Button variant="default" size="xs" rightSection={<IconChevronDown size={14} />} justify="space-between" fullWidth>
              {area ? AREA_LABEL[area] ?? area : "All areas"}
            </Button>
          </Menu.Target>
          <Menu.Dropdown mah={360} style={{ overflowY: "auto" }}>
            <Menu.Item onClick={() => setArea(null)}>All areas</Menu.Item>
            {areas.map((a) => <Menu.Item key={a} onClick={() => setArea(a)}>{AREA_LABEL[a] ?? a} <Text span c="dimmed" size="xs">({methods.filter((m) => m.area === a).length})</Text></Menu.Item>)}
          </Menu.Dropdown>
        </Menu>
        <ScrollArea h={620} type="auto" offsetScrollbars>
          {groups.length === 0 && <Center py="lg"><Text size="sm" c="dimmed">No methods match</Text></Center>}
          {groups.map((g) => (
            <Box key={g.area} mb={6}>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" px={8} pt={6} pb={2}>
                {g.area === "__search" ? `${g.items.length} result(s)` : AREA_LABEL[g.area] ?? g.area}
              </Text>
              {g.items.map((m) => (
                <NavLink
                  key={m.name}
                  active={m.name === selected}
                  onClick={() => onSelect(m.name)}
                  label={<Text size="sm" ff="monospace" fw={m.name === selected ? 700 : 500}>{m.name}</Text>}
                  description={<Text size="xs" c="dimmed" lineClamp={1}>{firstSentence(m.doc)}</Text>}
                  rightSection={<RiskBadge risk={m.risk} />}
                  py={4}
                  data-testid={`console-method-${m.name}`}
                />
              ))}
            </Box>
          ))}
        </ScrollArea>
      </Stack>
    </Paper>
  );
}

// ---------- output docs ----------

function TypeFields({ catalog, typeName }: { catalog: Catalog; typeName: string }) {
  const t = catalog.types[typeName];
  if (!t) return <Text size="sm" c="dimmed">No schema for {typeName}</Text>;
  const nested = t.fields.map((f) => f.items ?? f.type).filter((x): x is string => !!x && !!catalog.types[x]);
  return (
    <Stack gap="xs">
      <Table withTableBorder verticalSpacing={4} fz="xs">
        <Table.Thead><Table.Tr><Table.Th>Field</Table.Th><Table.Th>Type</Table.Th><Table.Th>Description</Table.Th></Table.Tr></Table.Thead>
        <Table.Tbody>
          {t.fields.map((f) => (
            <Table.Tr key={f.name}>
              <Table.Td><Text ff="monospace" size="xs" fw={600}>{f.name}</Text></Table.Td>
              <Table.Td><Text size="xs" c="dimmed">{f.kind}{f.enum ? ` ${f.enum}` : ""}{f.items ? ` of ${f.items}` : ""}{f.type ? ` ${f.type}` : ""}</Text></Table.Td>
              <Table.Td><Text size="xs">{f.doc}</Text>
                {f.enum && catalog.enums[f.enum] && (
                  <Text size="xs" c="dimmed">{catalog.enums[f.enum].values.map((v) => `${v.value}=${v.key}`).join(", ")}</Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {[...new Set(nested)].map((n) => (
        <div key={n}>
          <Text size="xs" fw={700} mt={4}>{n}</Text>
          <TypeFields catalog={catalog} typeName={n} />
        </div>
      ))}
    </Stack>
  );
}

// ---------- page ----------

export default function ConsolePage() {
  const { serverId } = useScope();
  const qc = useQueryClient();
  const server = useServer(serverId);
  const catalog = useCatalog();
  const [search, setSearch] = useSearchParams();
  const s = server.data;
  const role = s?.myRole;
  const limited = !!s?.hub || !!s?.visibleHubs;
  const hubs = useRpc<{ HubList?: HubListItem[] }>(serverId, "EnumHub", {}, { enabled: !!s });
  const hubNames = useMemo(() => (hubs.data?.HubList ?? []).map((h) => h.HubName_str).sort(), [hubs.data]);

  const methods = useMemo(() => {
    const all = Object.values(catalog.data?.methods ?? {});
    return limited ? all.filter((m) => m.hubScoped || NAV_METHODS.has(m.name)) : all;
  }, [catalog.data, limited]);

  const methodName = search.get("method");
  const method = methodName ? methods.find((m) => m.name === methodName) ?? null : null;
  const hubField = catalog.data && method && method.hubScoped ? hubFieldOf(catalog.data, method) : null;

  const [hub, setHub] = useState<string>("");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("{}");
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [loadingCurrent, setLoadingCurrent] = useState(false);
  const [last, setLast] = useState<HistoryEntry | null>(null);
  const histKey = `sem.console.history.${serverId}`;
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory(histKey));
  const resultRef = useRef<HTMLDivElement>(null);
  const pendingRestore = useRef<HistoryEntry | null>(null);

  // Default hub: hub-admin hub, else first visible hub.
  useEffect(() => {
    if (hub) return;
    const def = s?.hub ?? hubNames[0];
    if (def) setHub(def);
  }, [s?.hub, hubNames, hub]);

  // Reset params when the method changes (keeps the hub).
  useEffect(() => {
    if (!catalog.data || !method) return;
    const pending = pendingRestore.current;
    pendingRestore.current = null;
    if (pending && pending.method === method.name) { applyEntry(pending); return; }
    const p = emptyParams(catalog.data, method.input);
    if (hubField && hub) p[hubField] = hub;
    setParams(p);
    setJsonText(JSON.stringify(p, null, 2));
    setJsonErr(null);
    setLast(null);
  }, [method?.name, catalog.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the hub field in sync with the hub selector.
  useEffect(() => {
    if (!hubField || !hub) return;
    setParams((p) => (p[hubField] === hub ? p : { ...p, [hubField]: hub }));
  }, [hub, hubField]);

  useEffect(() => { if (mode === "json") setJsonText(JSON.stringify(params, null, 2)); }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  const select = (name: string) => {
    const next = new URLSearchParams(search);
    next.set("method", name);
    setSearch(next, { replace: true });
  };

  const need = method ? RISK_ROLE[method.risk] : "viewer";
  // Hub-limited users hold hub grants the server-level role doesn't reflect; the backend decides.
  const allowed = !method ? false : limited && method.hubScoped ? true : can(role, need);
  const getCounterpart = method && /^Set/.test(method.name) ? methods.find((m) => m.name === method.name.replace(/^Set/, "Get")) : undefined;

  const switchMode = (m: string) => {
    if (m === "form" && mode === "json") {
      try {
        const v = JSON.parse(jsonText);
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Params must be a JSON object");
        setParams(v);
        if (hubField && typeof v[hubField] === "string") setHub(v[hubField]);
      } catch (e) { setJsonErr((e as Error).message); return; }
    }
    if (m === "json") setJsonText(JSON.stringify(params, null, 2));
    setJsonErr(null);
    setMode(m as "form" | "json");
  };

  const currentParams = (): Record<string, unknown> | null => {
    if (mode === "form") return params;
    try {
      const v = JSON.parse(jsonText);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Params must be a JSON object");
      return v;
    } catch (e) { setJsonErr((e as Error).message); return null; }
  };

  const pushHistory = (e: HistoryEntry) => {
    setHistory((h) => {
      const stored: HistoryEntry = {
        ...e,
        params: redact(e.params) as Record<string, unknown>,
        result: e.result !== undefined && JSON.stringify(e.result).length > HISTORY_RESULT_MAX ? undefined : e.result,
      };
      const next = [stored, ...h].slice(0, HISTORY_MAX);
      saveHistory(histKey, next);
      return next;
    });
  };

  const execute = async () => {
    if (!method || running) return;
    const p = currentParams();
    if (!p) return;
    if (method.hubScoped && hubField && !p[hubField]) { setJsonErr(`${hubField} is required for this hub-scoped method`); return; }
    setRunning(true);
    const t0 = performance.now();
    const base = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), method: method.name, params: p };
    try {
      const r = await rpc(serverId, method.name, p);
      const e: HistoryEntry = { ...base, ok: true, ms: Math.round(performance.now() - t0), result: r };
      setLast(e);
      pushHistory(e);
      if (method.risk !== "read") {
        void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
        void qc.invalidateQueries({ queryKey: ["server", serverId] });
      }
    } catch (err) {
      const ae = err instanceof ApiError ? err : null;
      const e: HistoryEntry = {
        ...base, ok: false, ms: Math.round(performance.now() - t0),
        error: { message: (err as Error).message, code: ae?.softEtherCode, status: ae?.status },
      };
      setLast(e);
      pushHistory(e);
    } finally {
      setRunning(false);
      setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
    }
  };

  const loadCurrent = async () => {
    if (!getCounterpart || !catalog.data) return;
    setLoadingCurrent(true);
    try {
      const gp: Record<string, unknown> = {};
      const gHub = hubFieldOf(catalog.data, getCounterpart);
      if (gHub && hub) gp[gHub] = hub;
      // Carry over identifying fields (e.g. Name_str) the user already typed.
      const gt = getCounterpart.input ? catalog.data.types[getCounterpart.input] : undefined;
      for (const f of gt?.fields ?? []) if (params[f.name] !== undefined && params[f.name] !== "" && !(f.name in gp)) gp[f.name] = params[f.name];
      const r = await rpc(serverId, getCounterpart.name, gp);
      const merged = { ...params, ...r };
      if (hubField && hub) merged[hubField] = hub;
      setParams(merged);
      setJsonText(JSON.stringify(merged, null, 2));
    } catch (e) {
      setJsonErr(`${getCounterpart.name} failed: ${(e as Error).message}`);
    } finally { setLoadingCurrent(false); }
  };

  function applyEntry(h: HistoryEntry) {
    setParams(h.params);
    setJsonText(JSON.stringify(h.params, null, 2));
    setJsonErr(null);
    const m = methods.find((x) => x.name === h.method);
    const f = m && catalog.data ? hubFieldOf(catalog.data, m) : null;
    if (f && typeof h.params[f] === "string" && h.params[f]) setHub(h.params[f] as string);
    setLast(h);
  }

  const restore = (h: HistoryEntry) => {
    if (method?.name === h.method) { applyEntry(h); return; }
    pendingRestore.current = h;
    select(h.method);
  };

  useHotkeys([["mod+Enter", () => { if (method && allowed && method.risk !== "danger") void execute(); }]], []);

  const jsonRpcBody = method ? JSON.stringify({ jsonrpc: "2.0", id: "rpc_call_id", method: method.name, params: redact(params) }, null, 2) : "";
  const curl = method ? `curl -X POST '${location.origin}/api/servers/${serverId}/rpc/${method.name}' \\\n  -H 'content-type: application/json' -H 'x-sem-csrf: 1' \\\n  -b cookies.txt \\\n  -d '${JSON.stringify(redact(params)).replace(/'/g, "'\\''")}'` : "";

  const inputType = method?.input && catalog.data ? catalog.data.types[method.input] : undefined;
  const formFields = (inputType?.fields ?? []).filter((f) => f.name !== hubField);

  return (
    <>
      <PageHeader
        title="API console"
        description={<>Call any SoftEther VPN JSON-RPC method on this server through the management gateway. Every call is permission-checked and write calls are audited. Press <Kbd>Ctrl</Kbd>/<Kbd>⌘</Kbd> + <Kbd>Enter</Kbd> to execute.</>}
      />
      {limited && (
        <Alert color="grape" variant="light" mb="md" icon={<IconLock size={16} />}>
          {s?.hub ? `This server is managed with hub administrator credentials for ${s.hub}` : "Your access is limited to specific Virtual Hubs"}; only hub-scoped methods are listed.
        </Alert>
      )}
      <QueryState query={catalog}>
        <Group align="flex-start" gap="md" wrap="wrap">
          <MethodPicker methods={methods} selected={method?.name ?? null} onSelect={select} />

          <Stack style={{ flex: 1, minWidth: 320 }} gap="md">
            {!method ? (
              <Card withBorder radius="md" padding="xl">
                <Stack align="center" gap="xs">
                  <Title order={4}>Select a method</Title>
                  <Text c="dimmed" size="sm" ta="center" maw={520}>
                    Pick one of the {methods.length} API methods on the left. Methods are grouped by area and tagged by risk:
                    {" "}<RiskBadge risk="read" /> no changes, <RiskBadge risk="write" /> changes configuration, <RiskBadge risk="danger" /> disruptive or security-critical.
                  </Text>
                  <Group gap="xs" mt="sm">
                    {["GetServerInfo", "GetServerStatus", "EnumHub", "GetCaps"].filter((n) => methods.some((m) => m.name === n)).map((n) => (
                      <Button key={n} size="xs" variant="light" onClick={() => select(n)} ff="monospace">{n}</Button>
                    ))}
                  </Group>
                </Stack>
              </Card>
            ) : (
              <Card withBorder radius="md" padding="lg" data-testid="console-editor">
                <Stack gap="sm">
                  <Group justify="space-between" align="flex-start" wrap="wrap">
                    <div>
                      <Group gap="xs">
                        <Title order={3} ff="monospace" data-testid="console-method-name">{method.name}</Title>
                        <RiskBadge risk={method.risk} size="sm" />
                        <Badge size="sm" variant="outline" color="gray">{AREA_LABEL[method.area] ?? method.area}</Badge>
                        {method.hubScoped && <Badge size="sm" variant="outline" color="grape">hub-scoped</Badge>}
                      </Group>
                      <Text size="xs" c="dimmed" mt={2}>
                        Input <Text span ff="monospace" size="xs">{method.input ?? "none"}</Text> → output <Text span ff="monospace" size="xs">{method.output}</Text> · requires <b>{need}</b>
                      </Text>
                    </div>
                    <Menu position="bottom-end" withinPortal>
                      <Menu.Target><Button size="xs" variant="default" leftSection={<IconCopy size={14} />} rightSection={<IconChevronDown size={12} />}>Copy as</Button></Menu.Target>
                      <Menu.Dropdown>
                        <CopyButton value={curl}>{({ copy }) => <Menu.Item onClick={copy}>curl (management API)</Menu.Item>}</CopyButton>
                        <CopyButton value={jsonRpcBody}>{({ copy }) => <Menu.Item onClick={copy}>SoftEther JSON-RPC request body</Menu.Item>}</CopyButton>
                        <CopyButton value={JSON.stringify(redact(params), null, 2)}>{({ copy }) => <Menu.Item onClick={copy}>Params JSON</Menu.Item>}</CopyButton>
                      </Menu.Dropdown>
                    </Menu>
                  </Group>

                  <Spoiler maxHeight={66} showLabel="Show more" hideLabel="Show less">
                    <Text size="sm">{method.doc}</Text>
                  </Spoiler>

                  {method.risk === "danger" && (
                    <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />} py="xs">
                      This method is disruptive or security-critical (it may disconnect clients, cut off management access or change credentials). You will be asked to type the method name to confirm.
                    </Alert>
                  )}
                  {!allowed && (
                    <Alert color="gray" variant="light" icon={<IconLock size={16} />} py="xs">
                      Your role (<b>{role ?? "none"}</b>) cannot execute this method; it requires <b>{need}</b>.
                    </Alert>
                  )}

                  {hubField && (
                    <Autocomplete
                      label="Virtual Hub"
                      description={<>Sets <Text span ff="monospace" size="xs">{hubField}</Text></>}
                      data={hubNames}
                      value={hub}
                      onChange={setHub}
                      readOnly={!!s?.hub}
                      required
                      maw={360}
                      data-testid="console-hub"
                    />
                  )}

                  {method.input && inputType && inputType.fields.length > 0 ? (
                    <>
                      <Group justify="space-between" wrap="wrap">
                        <SegmentedControl size="xs" value={mode} onChange={switchMode} data={[{ value: "form", label: "Form" }, { value: "json", label: "Raw JSON" }]} data-testid="console-mode" />
                        <Group gap="xs">
                          {getCounterpart && (
                            <Tooltip label={`Fill the fields with the current values from ${getCounterpart.name}, so unchanged fields are preserved`}>
                              <Button size="xs" variant="light" leftSection={<IconDatabaseImport size={14} />} loading={loadingCurrent} onClick={loadCurrent} data-testid="console-load-current">
                                Load current ({getCounterpart.name})
                              </Button>
                            </Tooltip>
                          )}
                          <Button size="xs" variant="subtle" color="gray" leftSection={<IconEraser size={14} />} onClick={() => {
                            const p = emptyParams(catalog.data!, method.input);
                            if (hubField && hub) p[hubField] = hub;
                            setParams(p); setJsonText(JSON.stringify(p, null, 2)); setJsonErr(null);
                          }}>Reset</Button>
                        </Group>
                      </Group>
                      {mode === "form" ? (
                        <Stack gap="sm" data-testid="console-form">
                          {formFields.length === 0 && <Text size="sm" c="dimmed">No parameters besides the hub name.</Text>}
                          {formFields.map((f) => (
                            <RpcField key={f.name} field={f} catalog={catalog.data!} value={params[f.name]}
                              onChange={(v) => setParams((p) => ({ ...p, [f.name]: v }))} />
                          ))}
                        </Stack>
                      ) : (
                        <JsonInput
                          label="Params"
                          description={`JSON object of type ${method.input}`}
                          value={jsonText}
                          onChange={(v) => { setJsonText(v); setJsonErr(null); }}
                          onBlur={() => {
                            try {
                              const v = JSON.parse(jsonText);
                              if (v && typeof v === "object" && !Array.isArray(v)) {
                                setParams(v);
                                if (hubField && typeof v[hubField] === "string") setHub(v[hubField]);
                              }
                            } catch { /* shown by validationError */ }
                          }}
                          validationError="Invalid JSON"
                          formatOnBlur autosize minRows={8} maxRows={30}
                          styles={{ input: { fontFamily: "var(--mantine-font-family-monospace)", fontSize: 12 } }}
                          data-testid="console-json"
                        />
                      )}
                    </>
                  ) : (
                    <Text size="sm" c="dimmed">This method takes no parameters.</Text>
                  )}
                  {jsonErr && <Text size="sm" c="red">{jsonErr}</Text>}
                  {!limited && hasSecrets(params) && <Text size="xs" c="dimmed">Secret-looking fields are redacted in history and copied snippets.</Text>}

                  <Group justify="flex-end">
                    {method.risk === "danger" ? (
                      <ConfirmButton
                        title={`Execute ${method.name}?`}
                        message={<><Text size="sm" mb="xs">{firstSentence(method.doc)}</Text><Text size="sm">This is a <b>dangerous</b> operation and will be recorded in the audit log.</Text></>}
                        typeToConfirm={method.name}
                        confirmLabel="Execute"
                        variant="filled"
                        size="sm"
                        disabled={!allowed}
                        loading={running}
                        leftSection={<IconPlayerPlay size={16} />}
                        onConfirm={execute}
                      >Execute</ConfirmButton>
                    ) : (
                      <Button leftSection={<IconPlayerPlay size={16} />} onClick={() => void execute()} loading={running} disabled={!allowed}
                        color={method.risk === "write" ? "orange" : undefined} data-testid="console-execute">
                        Execute
                      </Button>
                    )}
                  </Group>
                </Stack>
              </Card>
            )}

            {method && last && last.method === method.name && (
              <Card withBorder radius="md" padding="lg" ref={resultRef} data-testid="console-result">
                <Group justify="space-between" mb="sm">
                  <Group gap="xs">
                    <Title order={4}>Result</Title>
                    <Badge color={last.ok ? "green" : "red"} variant="light" data-testid="console-result-status">{last.ok ? "Success" : "Error"}</Badge>
                    <Text size="xs" c="dimmed">{last.ms} ms · {new Date(last.at).toLocaleTimeString()}</Text>
                  </Group>
                </Group>
                {last.ok ? (
                  last.result !== undefined
                    ? <JsonResult value={last.result} filename={`${method.name}-${new Date(last.at).toISOString().replace(/[:.]/g, "-")}.json`} />
                    : <Text size="sm" c="dimmed">Result too large to keep in history — execute again to view it.</Text>
                ) : (
                  <>
                    <ErrorAlert error={new ApiError(last.error?.status ?? 500, { error: last.error?.message, softEtherCode: last.error?.code })} />
                    {last.error?.code !== undefined && catalog.data?.errors[String(last.error.code)] && catalog.data.errors[String(last.error.code)] !== last.error.message && (
                      <Text size="sm" c="dimmed">SoftEther: {catalog.data.errors[String(last.error.code)]}</Text>
                    )}
                  </>
                )}
              </Card>
            )}

            {method && catalog.data && (
              <Accordion variant="contained" radius="md" multiple>
                {method.input && catalog.data.types[method.input] && (
                  <Accordion.Item value="in">
                    <Accordion.Control>Input schema · <Text span ff="monospace" size="sm">{method.input}</Text></Accordion.Control>
                    <Accordion.Panel><TypeFields catalog={catalog.data} typeName={method.input} /></Accordion.Panel>
                  </Accordion.Item>
                )}
                <Accordion.Item value="out">
                  <Accordion.Control>Output schema · <Text span ff="monospace" size="sm">{method.output}</Text></Accordion.Control>
                  <Accordion.Panel><TypeFields catalog={catalog.data} typeName={method.output} /></Accordion.Panel>
                </Accordion.Item>
              </Accordion>
            )}

            <Card withBorder radius="md" padding="lg" data-testid="console-history">
              <Group justify="space-between" mb="sm">
                <Group gap="xs"><IconHistory size={18} /><Title order={4}>History</Title><Text size="xs" c="dimmed">this browser session · last {HISTORY_MAX}</Text></Group>
                {history.length > 0 && (
                  <Button size="xs" variant="subtle" color="gray" leftSection={<IconClearAll size={14} />} onClick={() => { setHistory([]); saveHistory(histKey, []); }} data-testid="console-history-clear">Clear</Button>
                )}
              </Group>
              {history.length === 0 ? <Text size="sm" c="dimmed">No calls yet.</Text> : (
                <ScrollArea.Autosize mah={360} type="auto">
                  <Table highlightOnHover verticalSpacing={4} fz="sm">
                    <Table.Thead><Table.Tr><Table.Th>Time</Table.Th><Table.Th>Method</Table.Th><Table.Th>Hub</Table.Th><Table.Th>Status</Table.Th><Table.Th ta="right">Duration</Table.Th></Table.Tr></Table.Thead>
                    <Table.Tbody>
                      {history.map((h) => {
                        const hubVal = HUB_FIELDS.map((f) => h.params[f]).find((v) => typeof v === "string" && v) as string | undefined;
                        return (
                          <Table.Tr key={h.id} style={{ cursor: "pointer" }} onClick={() => restore(h)} data-testid="console-history-row">
                            <Table.Td><Text size="xs" c="dimmed">{new Date(h.at).toLocaleTimeString()}</Text></Table.Td>
                            <Table.Td><UnstyledButton><Text ff="monospace" size="sm" fw={600}>{h.method}</Text></UnstyledButton></Table.Td>
                            <Table.Td><Text size="xs">{hubVal ?? ""}</Text></Table.Td>
                            <Table.Td>
                              {h.ok ? <Badge size="xs" color="green" variant="light">OK</Badge>
                                : <Tooltip label={h.error?.message} multiline w={320}><Badge size="xs" color="red" variant="light">{h.error?.code !== undefined ? `Error ${h.error.code}` : `HTTP ${h.error?.status ?? "?"}`}</Badge></Tooltip>}
                            </Table.Td>
                            <Table.Td ta="right"><Text size="xs" c="dimmed">{h.ms} ms</Text></Table.Td>
                          </Table.Tr>
                        );
                      })}
                    </Table.Tbody>
                  </Table>
                </ScrollArea.Autosize>
              )}
              {history.length > 0 && <Text size="xs" c="dimmed" mt={4}>Click a row to restore its parameters and result. Passwords and keys are not kept.</Text>}
            </Card>
            {running && <Center><Loader size="sm" /></Center>}
          </Stack>
        </Group>
      </QueryState>
    </>
  );
}

