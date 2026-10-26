// Run one admin RPC on several servers at once (POST /api/fleet/rpc).
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Checkbox, Group, Menu, Select, Stack, Textarea } from "@mantine/core";
import { IconPlayerPlay, IconTemplate } from "@tabler/icons-react";
import { post } from "../lib/api";
import { notifyError, useCatalog, useServers } from "../lib/hooks";
import type { BulkResult, Catalog, CatalogField } from "../lib/types";
import { confirmAction, DataTable, EmptyState, FormRow, FormSection, JsonView, Sheet, StatusBadge, StatusDot, Tag, serverStatus } from "../design";

const PRESETS: { label: string; method: string; params: Record<string, unknown> }[] = [
  { label: "Create a password user on a hub", method: "CreateUser", params: { HubName_str: "", Name_str: "", Realname_utf: "", Note_utf: "", AuthType_u32: 1, Auth_Password_str: "" } },
  { label: "Delete a user from a hub", method: "DeleteUser", params: { HubName_str: "", Name_str: "" } },
  { label: "Take a hub online or offline", method: "SetHubOnline", params: { HubName_str: "", Online_bool: true } },
  { label: "Create a Virtual Hub", method: "CreateHub", params: { HubName_str: "", AdminPasswordPlainText_str: "", Online_bool: true, MaxSession_u32: 0, NoEnum_bool: false, HubType_u32: 0 } },
  { label: "Read server status", method: "GetServerStatus", params: {} },
  { label: "List Virtual Hubs", method: "EnumHub", params: {} },
];

const RISK: Record<string, { color: "gray" | "accent" | "red"; label: string }> = {
  read: { color: "gray", label: "Read only" }, write: { color: "accent", label: "Changes settings" }, danger: { color: "red", label: "Disruptive" },
};

function defaultFor(f: CatalogField): unknown {
  switch (f.kind) {
    case "number": case "enum": return 0;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    default: return "";
  }
}

function templateFor(catalog: Catalog | undefined, method: string): Record<string, unknown> {
  const m = catalog?.methods[method];
  const t = m?.input ? catalog?.types[m.input] : undefined;
  const out: Record<string, unknown> = {};
  for (const f of t?.fields ?? []) if (!/^(policy:|Recv\.|Send\.|Ex\.)/.test(f.name)) out[f.name] = defaultFor(f);
  return out;
}

function summarize(r: Record<string, unknown> | undefined): string {
  if (!r) return "";
  const arrays = Object.entries(r).filter(([, v]) => Array.isArray(v));
  if (arrays.length) return arrays.map(([k, v]) => `${k.replace(/_.*$/, "")}: ${(v as unknown[]).length}`).join(", ");
  const n = Object.keys(r).length;
  return n ? `${n} fields returned` : "Done";
}

export function BulkRunSheet({ opened, initialIds, onClose }: { opened: boolean; initialIds?: number[]; onClose: () => void }) {
  const servers = useServers();
  const catalog = useCatalog();
  const [ids, setIds] = useState<number[]>([]);
  const [method, setMethod] = useState<string | null>(null);
  const [json, setJson] = useState("{}");
  const [results, setResults] = useState<BulkResult[] | null>(null);
  const [picked, setPicked] = useState<BulkResult | null>(null);
  const [busy, setBusy] = useState(false);

  // Pre-select once per opening, as soon as the server list is available
  const initialised = useRef(false);
  useEffect(() => {
    if (!opened) { initialised.current = false; return; }
    if (initialised.current || !servers.data) return;
    initialised.current = true;
    const usable = (servers.data ?? []).filter((s) => serverStatus(s).status !== "locked" && s.enabled);
    setIds(initialIds?.length ? initialIds : usable.filter((s) => s.state?.ok).map((s) => s.id));
    setResults(null); setPicked(null);
  }, [opened, servers.data, initialIds]);

  const info = method ? catalog.data?.methods[method] : undefined;
  const parsed = useMemo(() => { try { const v = JSON.parse(json || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? { ok: true as const, v } : { ok: false as const, e: "Parameters must be a JSON object." }; } catch (e) { return { ok: false as const, e: (e as Error).message }; } }, [json]);
  const options = useMemo(() => {
    if (!catalog.data) return [];
    const byArea = new Map<string, string[]>();
    for (const m of Object.values(catalog.data.methods)) byArea.set(m.area, [...(byArea.get(m.area) ?? []), m.name]);
    return [...byArea.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, items]) => ({ group, items: items.sort() }));
  }, [catalog.data]);

  const pick = (m: string | null, params?: Record<string, unknown>) => {
    setMethod(m);
    setJson(JSON.stringify(params ?? (m ? templateFor(catalog.data, m) : {}), null, 2));
  };

  const run = async () => {
    if (!method || !parsed.ok || !ids.length) return;
    const n = ids.length;
    const names = (servers.data ?? []).filter((s) => ids.includes(s.id)).map((s) => s.name);
    if (info?.risk !== "read") {
      const ok = await confirmAction({
        title: <>Run {method} on {n} {n === 1 ? "server" : "servers"}?</>,
        message: <>{info?.doc ? <>{info.doc} </> : null}It runs on {names.slice(0, 5).join(", ")}{names.length > 5 ? ` and ${names.length - 5} more` : ""}.</>,
        confirmLabel: `Run on ${n} ${n === 1 ? "Server" : "Servers"}`,
        tone: info?.risk === "danger" ? "danger" : "warning",
        typeToConfirm: info?.risk === "danger" ? method : undefined,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await post<{ results: BulkResult[] }>("/api/fleet/rpc", { method, params: parsed.v, serverIds: ids });
      setResults(r.results);
      setPicked(r.results[0] ?? null);
    } catch (e) { notifyError(e, "Bulk run failed"); } finally { setBusy(false); }
  };

  const list = servers.data ?? [];
  const okCount = results?.filter((r) => r.ok).length ?? 0;

  return (
    <Sheet
      opened={opened} onClose={onClose} busy={busy} size={760} testId="bulk-sheet"
      title="Run on Several Servers" subtitle="Send one admin RPC to many servers and compare the results."
      icon={<IconPlayerPlay size={19} stroke={1.6} />}
      footer={(
        <Group justify="space-between">
          <span className="sem-dim">{results ? `${okCount} of ${results.length} succeeded` : `${ids.length} selected`}</span>
          <Group gap={8}>
            <Button variant="default" onClick={onClose}>{results ? "Done" : "Cancel"}</Button>
            <Button onClick={run} loading={busy} disabled={!method || !parsed.ok || !ids.length} color={info?.risk === "danger" ? "red" : undefined} data-testid="bulk-run">
              Run on {ids.length} {ids.length === 1 ? "Server" : "Servers"}
            </Button>
          </Group>
        </Group>
      )}
    >
      <Stack gap={16}>
        <FormSection title="Servers">
          <div className="sem-check-list" data-testid="bulk-servers">
            {list.length === 0 && <EmptyState compact title="No servers yet" />}
            {list.map((s) => {
              const st = serverStatus(s);
              const disabled = st.status === "locked" || !s.enabled;
              return (
                <label key={s.id} className="sem-check-row" data-disabled={disabled || undefined}>
                  <Checkbox checked={ids.includes(s.id)} disabled={disabled} onChange={(e) => setIds((cur) => e.currentTarget.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id))} />
                  <StatusDot status={st.status} label={st.label} />
                  <span className="sem-check-label">{s.name}</span>
                  <span className="sem-dim sem-mono">{s.host}:{s.port}</span>
                  {disabled && <span className="sem-dim">{st.label}</span>}
                </label>
              );
            })}
          </div>
        </FormSection>
        <FormSection title="Operation">
          <FormRow label="Method" description={info?.doc}>
            <Group gap={8} wrap="nowrap">
              <Select data={options} value={method} onChange={(m) => pick(m)} searchable placeholder="Search 148 methods…" nothingFoundMessage="No such method" maxDropdownHeight={360} selectFirstOptionOnChange style={{ flex: 1 }} data-testid="bulk-method" />
              {info && <Tag color={RISK[info.risk].color}>{RISK[info.risk].label}</Tag>}
              <Menu position="bottom-end" withinPortal>
                <Menu.Target><Button variant="default" leftSection={<IconTemplate size={14} />}>Presets</Button></Menu.Target>
                <Menu.Dropdown>
                  {PRESETS.map((p) => <Menu.Item key={p.label} onClick={() => pick(p.method, p.params)} rightSection={<span className="sem-menu-shortcut sem-mono">{p.method}</span>}>{p.label}</Menu.Item>)}
                </Menu.Dropdown>
              </Menu>
            </Group>
          </FormRow>
          <FormRow label="Parameters" stacked error={!parsed.ok ? parsed.e : undefined}>
            <Textarea value={json} onChange={(e) => setJson(e.currentTarget.value)} autosize minRows={4} maxRows={12} ff="monospace" fz={12} spellCheck={false} data-testid="bulk-params" />
          </FormRow>
        </FormSection>
        {results && (
          <FormSection title="Results">
            <DataTable
              data={results} rowKey={(r) => r.serverId} searchable={false} footer={false} selectable="single"
              selection={picked ? [picked.serverId] : []} onSelectionChange={(_k, rows) => setPicked(rows[0] ?? null)}
              testId="bulk-results"
              columns={[
                { key: "server", title: "Server", value: (r) => r.serverName ?? `#${r.serverId}` },
                { key: "ok", title: "Result", width: 110, value: (r) => (r.ok ? 1 : 0), render: (r) => <StatusBadge status={r.ok ? "ok" : "error"}>{r.ok ? "Succeeded" : "Failed"}</StatusBadge> },
                { key: "summary", title: "Details", value: (r) => (r.ok ? summarize(r.result) : r.error ?? ""), render: (r) => <span className={r.ok ? undefined : "sem-text-red"}>{r.ok ? summarize(r.result) : r.error}</span> },
              ]}
            />
            {picked && <div style={{ marginTop: 10 }}><JsonView value={picked.ok ? picked.result : { error: picked.error }} maxHeight={260} /></div>}
          </FormSection>
        )}
      </Stack>
    </Sheet>
  );
}
