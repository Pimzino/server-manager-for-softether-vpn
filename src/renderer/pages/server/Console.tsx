// Server › API Console: call any SoftEther admin RPC in the catalog on this server. A searchable method list
// (grouped by area, tagged by risk), a form generated from the method's input type (or raw JSON), the result as a
// JSON tree / text / tables, the input and output schemas, and a history of calls for this session.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Autocomplete, Button, CloseButton, JsonInput, Menu, SegmentedControl, Select, TextInput, UnstyledButton } from "@mantine/core";
import { useHotkeys } from "@mantine/hooks";
import {
  IconChevronDown, IconClearAll, IconCopy, IconDatabaseImport, IconEraser, IconHistory, IconPlayerPlay, IconRestore, IconSearch, IconTerminal2,
} from "@tabler/icons-react";
import { ApiError, put, rpc } from "../../lib/api";
import { notifyError, notifySuccess, useCatalog, useRpc, useScope } from "../../lib/hooks";
import type { Catalog, MethodInfo, HubListItem, Server } from "../../lib/types";
import {
  confirmRpc, type ConfirmOptions, DataTable, EmptyState, ErrorState, FormRow, FormSection, isConfirmCancelled, Mono, PageHeader, QueryState, Section, Shortcut,
  StatusBadge, Tag, TableSkeleton, type ContextMenuItem, type TagColor,
} from "../../design";
import { Callout, Disclosure } from "../../components/domain/ui";
import { RpcField, emptyParams } from "../../components/domain/RpcForm";
import { JsonResult } from "../../components/domain/JsonResult";
import { useReachable } from "./_server-advanced/shared";

// ------------------------------------------------------------------------------ constants

const AREA_LABEL: Record<string, string> = {
  server: "Server", listener: "Listeners & ports", cluster: "Clustering", certificate: "Certificate & TLS", hub: "Virtual Hubs",
  user: "Users", group: "Groups", access: "Access lists", session: "Sessions & tables", cascade: "Cascade connections",
  securenat: "SecureNAT", bridge: "Local bridge & VLAN", l3switch: "Layer 3 switches", log: "Logs & syslog", config: "Configuration",
  ipsec: "IPsec, L2TP & EtherIP", protocols: "OpenVPN, SSTP & protocols", ddns: "DDNS & VPN Azure", wireguard: "WireGuard",
  license: "License", security: "Security", diagnostics: "Diagnostics",
};
const AREA_ORDER = Object.keys(AREA_LABEL);
const RISK: Record<MethodInfo["risk"], { label: string; color: TagColor; help: string }> = {
  read: { label: "Read", color: "green", help: "Reads information. Changes nothing." },
  write: { label: "Write", color: "orange", help: "Changes the server’s configuration." },
  danger: { label: "Danger", color: "red", help: "Disruptive or security-critical: it may disconnect clients, cut off management access or change credentials." },
};
const HUB_FIELDS = ["HubName_str", "HubName_Ex_str", "RpcHubName_str"];
/** Server-level methods a hub administrator may still call. */
const NAV_METHODS = new Set(["EnumHub", "GetServerInfo", "GetCaps", "Test"]);
const SECRET_RE = /password|secret|psk|privatekey|private_key|presharedkey|hashedkey|ntlm/i;
const HISTORY_MAX = 50;
const HISTORY_RESULT_MAX = 100_000;

interface HistoryEntry {
  id: string; at: number; method: string; params: Record<string, unknown>; ok: boolean; ms: number;
  result?: unknown; error?: { message: string; code?: number; status?: number; kind?: string };
}

// ------------------------------------------------------------------------------ helpers

function hubFieldOf(catalog: Catalog, m: MethodInfo): string | null {
  const t = m.input ? catalog.types[m.input] : undefined;
  return t?.fields.find((f) => HUB_FIELDS.includes(f.name))?.name ?? null;
}
function firstSentence(doc: string) {
  const s = doc.split(/(?<=\.)\s/)[0] ?? doc;
  return s.length > 110 ? `${s.slice(0, 107)}…` : s;
}
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_RE.test(k) && typeof x === "string" && x ? "" : redact(x)]));
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
const copy = (t: string, what: string) => void navigator.clipboard.writeText(t).then(() => notifySuccess(`${what} copied`), () => undefined);

/**
 * Calls that change the password this connection logs in with. The API Console then saves the new password for the
 * connection (as the Admin Password page does), so the app doesn't lock itself out. Returns the new password, or
 * null when the call doesn't change it (or the password isn't given in plain text).
 */
function newConnectionPassword(method: string, p: Record<string, unknown>, s: Server | undefined): string | null {
  if (!s) return null;
  if (method === "SetServerPassword" && !s.hub && typeof p.PlainTextPassword_str === "string" && p.PlainTextPassword_str) return p.PlainTextPassword_str;
  if (method === "SetHub" && s.hub && typeof p.HubName_str === "string" && p.HubName_str.toLowerCase() === s.hub.toLowerCase()
    && typeof p.AdminPasswordPlainText_str === "string" && p.AdminPasswordPlainText_str) return p.AdminPasswordPlainText_str;
  return null;
}

/** Console-specific confirmation copy where the generic copy promises page behaviour the console doesn't have. */
function consoleConfirm(method: string, p: Record<string, unknown>, s: Server): ConfirmOptions | undefined {
  if (method === "SetServerPassword") {
    const plain = typeof p.PlainTextPassword_str === "string" && !!p.PlainTextPassword_str;
    return {
      title: "Change the administrator password?",
      message: "vpncmd, Server Manager, scripts and cluster members that use the current password stop working until they use the new one.",
      details: <div className="sem-dim">{plain
        ? <>This app then saves the new password for “{s.name}” and reconnects.</>
        : <>The new password isn’t given in plain text, so this app can’t update “{s.name}”: edit the connection with the new password afterwards.</>}</div>,
      confirmLabel: "Change Password",
      typeToConfirm: s.name,
      typeLabel: <>To confirm, type the connection name <span className="sem-code-inline">{s.name}</span></>,
    };
  }
  if (method === "SetServerCert") {
    return {
      title: "Replace the server certificate?",
      message: "Clients and managers that trust the current certificate must trust the new one before they can connect.",
      details: <div className="sem-dim">The API Console doesn’t re-pin it: this connection asks you to trust the new fingerprint on its next call. The Certificate & TLS page does both in one step.</div>,
      confirmLabel: "Replace Certificate",
    };
  }
  return undefined;
}

function RiskTag({ risk }: { risk: MethodInfo["risk"] }) {
  return <Tag color={RISK[risk].color} title={RISK[risk].help}>{RISK[risk].label}</Tag>;
}

// ------------------------------------------------------------------------------ method list

function MethodPicker({ methods, selected, onSelect }: { methods: MethodInfo[]; selected: string | null; onSelect: (m: string) => void }) {
  const [q, setQ] = useState("");
  const [risk, setRisk] = useState("all");
  const [area, setArea] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const needle = q.trim().toLowerCase();
  const filtered = methods.filter((m) =>
    (risk === "all" || m.risk === risk) && (!area || m.area === area) &&
    (!needle || m.name.toLowerCase().includes(needle) || m.doc.toLowerCase().includes(needle)));
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
  const order = groups.flatMap((g) => g.items.map((m) => m.name));

  // Keep the selected method in view (keyboard navigation, restoring from history).
  useEffect(() => {
    if (!selected) return;
    listRef.current?.querySelector(`[data-method="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    if (!order.length) return;
    const i = selected ? order.indexOf(selected) : -1;
    const next = e.key === "Home" ? 0 : e.key === "End" ? order.length - 1 : e.key === "ArrowDown" ? Math.min(order.length - 1, i + 1) : Math.max(0, i - 1);
    onSelect(order[next]);
  };

  return (
    <aside className="sa-picker" data-testid="console-method-picker" aria-label="Methods">
      <div className="sa-picker-head">
        <TextInput
          placeholder={`Search ${methods.length} methods`} leftSection={<IconSearch size={13} stroke={1.7} />} value={q} size="xs"
          rightSection={q ? <CloseButton size="xs" aria-label="Clear search" onClick={() => setQ("")} /> : undefined}
          onChange={(e) => setQ(e.currentTarget.value)} aria-label="Search methods" data-testid="console-method-search"
          onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); listRef.current?.focus(); if (!selected && order[0]) onSelect(order[0]); } }}
        />
        <SegmentedControl size="xs" fullWidth value={risk} onChange={setRisk} aria-label="Risk" data-testid="console-risk"
          data={[{ value: "all", label: "All" }, { value: "read", label: "Read" }, { value: "write", label: "Write" }, { value: "danger", label: "Danger" }]} />
        <Select size="xs" value={area ?? ""} onChange={(v) => setArea(v || null)} allowDeselect={false} aria-label="Area" data-testid="console-area"
          data={[{ value: "", label: "All areas" }, ...areas.map((a) => ({ value: a, label: `${AREA_LABEL[a] ?? a} (${methods.filter((m) => m.area === a).length})` }))]} />
      </div>
      <div className="sa-picker-list" ref={listRef} tabIndex={0} role="listbox" aria-label="Methods" onKeyDown={onKey}
        aria-activedescendant={selected ? `console-opt-${selected}` : undefined}>
        {groups.length === 0 && <EmptyState compact title="No methods match" description="Try another search or filter." />}
        {groups.map((g) => (
          <div key={g.area} role="group" aria-label={g.area === "__search" ? "Results" : AREA_LABEL[g.area] ?? g.area}>
            <div className="sa-picker-group">{g.area === "__search" ? `${g.items.length} ${g.items.length === 1 ? "result" : "results"}` : AREA_LABEL[g.area] ?? g.area}</div>
            {g.items.map((m) => (
              <UnstyledButton
                key={m.name} id={`console-opt-${m.name}`} className="sa-method" role="option" aria-selected={m.name === selected} tabIndex={-1}
                data-method={m.name} data-testid={`console-method-${m.name}`}
                onClick={() => { onSelect(m.name); listRef.current?.focus({ preventScroll: true }); }}
              >
                <span className="sa-method-name">{m.name}</span>
                <RiskTag risk={m.risk} />
                <span className="sa-method-doc">{firstSentence(m.doc)}</span>
              </UnstyledButton>
            ))}
          </div>
        ))}
      </div>
      <div className="sa-picker-foot">{filtered.length === methods.length ? `${methods.length} methods` : `${filtered.length} of ${methods.length} methods`}</div>
    </aside>
  );
}

// ------------------------------------------------------------------------------ schema

function TypeFields({ catalog, typeName, depth = 0 }: { catalog: Catalog; typeName: string; depth?: number }) {
  const t = catalog.types[typeName];
  if (!t) return <span className="sem-dim">No schema for {typeName}.</span>;
  const nested = [...new Set(t.fields.map((f) => f.items ?? f.type).filter((x): x is string => !!x && !!catalog.types[x] && x !== typeName))];
  return (
    <div className="sem-stack" style={{ gap: 10 }}>
      <DataTable
        data={t.fields} rowKey={(f) => f.name} searchable={false} footer={false} aria-label={`${typeName} fields`}
        columns={[
          { key: "name", title: "Field", width: 230, mono: true, render: (f) => <span className="sem-mono sem-strong">{f.name}</span> },
          { key: "kind", title: "Type", width: 170, truncate: true,
            render: (f) => <span className="sem-dim" title={[f.kind, f.enum, f.items && `of ${f.items}`, f.type].filter(Boolean).join(" ")}>{f.kind}{f.enum ? ` ${f.enum}` : ""}{f.items ? ` of ${f.items}` : ""}{f.type ? ` ${f.type}` : ""}</span> },
          { key: "doc", title: "Description", wrap: true, sortable: false, render: (f) => (
            <span>{f.doc || <span className="sem-dim">–</span>}
              {f.enum && catalog.enums[f.enum] && <span className="sem-dim" style={{ display: "block" }}>{catalog.enums[f.enum].values.map((v) => `${v.value} = ${v.key}`).join(", ")}</span>}
            </span>
          ) },
        ]}
      />
      {depth < 2 && nested.map((n) => (
        <div key={n}>
          <div className="sem-section-title" style={{ margin: "4px 0 6px" }}><Mono>{n}</Mono></div>
          <TypeFields catalog={catalog} typeName={n} depth={depth + 1} />
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------ page

export default function ConsolePage() {
  const { serverId } = useScope();
  const qc = useQueryClient();
  const { s, reachable, hubMode } = useReachable(serverId);
  const catalog = useCatalog();
  const [search, setSearch] = useSearchParams();
  const hubs = useRpc<{ HubList?: HubListItem[] }>(serverId, "EnumHub", {}, { enabled: !!s && reachable });
  const hubNames = useMemo(() => (hubs.data?.HubList ?? []).map((h) => h.HubName_str).sort(), [hubs.data]);

  const methods = useMemo(() => {
    const all = Object.values(catalog.data?.methods ?? {});
    return hubMode ? all.filter((m) => m.hubScoped || NAV_METHODS.has(m.name)) : all;
  }, [catalog.data, hubMode]);

  const methodName = search.get("method");
  const method = methodName ? methods.find((m) => m.name === methodName) ?? null : null;
  const hubField = catalog.data && method && method.hubScoped ? hubFieldOf(catalog.data, method) : null;

  const [hub, setHub] = useState("");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("{}");
  const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [loadingCurrent, setLoadingCurrent] = useState(false);
  const [docOpen, setDocOpen] = useState(false);
  const [last, setLast] = useState<HistoryEntry | null>(null);
  const histKey = `sem.console.history.${serverId}`;
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory(histKey));
  const resultRef = useRef<HTMLDivElement>(null);
  const pendingRestore = useRef<HistoryEntry | null>(null);
  const confirming = useRef(false);

  // Default hub: the hub-admin hub, else the first hub.
  useEffect(() => {
    if (hub) return;
    const def = s?.hub ?? hubNames[0];
    if (def) setHub(def);
  }, [s?.hub, hubNames, hub]);

  // New method: fresh parameters (keeps the hub), unless restoring a history entry.
  useEffect(() => {
    if (!catalog.data || !method) return;
    setDocOpen(false);
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

  // Keep the hub field in sync with the hub picker.
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

  const getCounterpart = method && /^Set/.test(method.name) ? methods.find((m) => m.name === method.name.replace(/^Set/, "Get")) : undefined;

  const parseJson = (): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(jsonText);
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("The parameters must be a JSON object.");
      return v as Record<string, unknown>;
    } catch (e) { setJsonErr((e as Error).message); return null; }
  };
  const switchMode = (m: string) => {
    if (m === "form" && mode === "json") {
      const v = parseJson();
      if (!v) return;
      setParams(v);
      if (hubField && typeof v[hubField] === "string") setHub(v[hubField] as string);
    }
    if (m === "json") setJsonText(JSON.stringify(params, null, 2));
    setJsonErr(null);
    setMode(m as "form" | "json");
  };
  const currentParams = () => (mode === "form" ? params : parseJson());

  const pushHistory = (e: HistoryEntry) => {
    setHistory((h) => {
      const stored: HistoryEntry = {
        ...e, params: redact(e.params) as Record<string, unknown>,
        result: e.result !== undefined && JSON.stringify(e.result).length > HISTORY_RESULT_MAX ? undefined : e.result,
      };
      const next = [stored, ...h].slice(0, HISTORY_MAX);
      saveHistory(histKey, next);
      return next;
    });
  };

  const execute = async () => {
    if (!method || running || !catalog.data || !s || !reachable) return;
    const p = currentParams();
    if (!p) return;
    if (method.hubScoped && hubField && !p[hubField]) { setJsonErr(`Choose a Virtual Hub: ${hubField} is required by this method.`); return; }
    if (method.risk === "danger") {
      // ⌘↩ still fires while the confirmation is open: never stack a second dialog (or run twice).
      if (confirming.current) return;
      confirming.current = true;
      try {
        // The built-in copy names what breaks and asks to type a name for irreversible calls (DeleteHub, SetConfig…).
        await confirmRpc(method.name, p, { server: s, info: method, override: consoleConfirm(method.name, p, s) });
      } catch (e) { if (!isConfirmCancelled(e)) notifyError(e, "Couldn’t run the method"); return; }
      finally { confirming.current = false; }
    }
    setRunning(true);
    const t0 = performance.now();
    const base = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), method: method.name, params: p };
    try {
      const r = await rpc(serverId, method.name, p);
      const e: HistoryEntry = { ...base, ok: true, ms: Math.round(performance.now() - t0), result: r };
      setLast(e);
      pushHistory(e);
      const pw = newConnectionPassword(method.name, p, s);
      if (pw !== null) {
        try {
          const updated = await put<Server>(`/api/servers/${serverId}`, { password: pw });
          if (updated.state?.ok) notifySuccess(`“${s.name}” now uses the new password`);
          else notifyError(new Error(updated.state?.error ?? "The connection check failed."), "Saved the new password, but can’t connect with it");
        } catch (err) {
          notifyError(err, "The password changed on the server, but this app couldn’t save it");
        }
        void qc.invalidateQueries({ queryKey: ["servers"] });
      }
      if (method.risk !== "read") {
        void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
        void qc.invalidateQueries({ queryKey: ["server", serverId] });
      }
    } catch (err) {
      const ae = err instanceof ApiError ? err : null;
      const e: HistoryEntry = {
        ...base, ok: false, ms: Math.round(performance.now() - t0),
        error: { message: (err as Error).message, code: ae?.softEtherCode, status: ae?.status, kind: ae?.kind },
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
      // Carry over identifying fields (e.g. Name_str) already filled in.
      const gt = getCounterpart.input ? catalog.data.types[getCounterpart.input] : undefined;
      for (const f of gt?.fields ?? []) if (params[f.name] !== undefined && params[f.name] !== "" && !(f.name in gp)) gp[f.name] = params[f.name];
      const r = await rpc(serverId, getCounterpart.name, gp);
      const merged: Record<string, unknown> = { ...params, ...r };
      if (hubField && hub) merged[hubField] = hub;
      setParams(merged);
      setJsonText(JSON.stringify(merged, null, 2));
      setJsonErr(null);
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
  const resetParams = () => {
    if (!catalog.data || !method) return;
    const p = emptyParams(catalog.data, method.input);
    if (hubField && hub) p[hubField] = hub;
    setParams(p); setJsonText(JSON.stringify(p, null, 2)); setJsonErr(null);
  };

  useHotkeys([["mod+Enter", () => { if (method) void execute(); }]], []);

  const safeParams = redact(params);
  const jsonRpcBody = method ? JSON.stringify({ jsonrpc: "2.0", id: "rpc_call_id", method: method.name, params: safeParams }, null, 2) : "";
  const curlHost = s && s.host.includes(":") && !s.host.startsWith("[") ? `[${s.host}]` : s?.host;
  const curl = method && s ? [
    `curl -k -u '${s.hub ?? "administrator"}:PASSWORD' 'https://${curlHost}:${s.port}/api/' \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '${JSON.stringify({ jsonrpc: "2.0", id: "rpc_call_id", method: method.name, params: safeParams }).replace(/'/g, "'\\''")}'`,
  ].join("\n") : "";

  const inputType = method?.input && catalog.data ? catalog.data.types[method.input] : undefined;
  const formFields = (inputType?.fields ?? []).filter((f) => f.name !== hubField);
  const historyMenu = (h: HistoryEntry): ContextMenuItem[] => [
    { label: "Restore Parameters and Result", icon: <IconRestore size={14} />, onClick: () => restore(h), testId: "console-history-restore" },
    { label: "Copy Parameters", icon: <IconCopy size={14} />, onClick: () => copy(JSON.stringify(h.params, null, 2), "Parameters") },
    ...(h.ok && h.result !== undefined ? [{ label: "Copy Result", icon: <IconCopy size={14} />, onClick: () => copy(JSON.stringify(h.result, null, 2), "Result") }] : []),
  ];

  return (
    <>
      <PageHeader
        title="API Console"
        description={<>Call any of the {methods.length || "catalog’s"} SoftEther admin methods on this server. Press <Shortcut keys={["mod", "enter"]} /> to run the selected method.</>}
      />
      {hubMode && (
        <div className="sem-callouts">
          <Callout tone="purple">This connection uses the administrator password of {s?.hub}, so only methods that work on a Virtual Hub are listed.</Callout>
        </div>
      )}
      <QueryState query={catalog} skeleton={<TableSkeleton rows={10} columns={3} />}>
        <div className="sa-console" style={{ marginTop: 18 }}>
          <MethodPicker methods={methods} selected={method?.name ?? null} onSelect={select} />

          <div style={{ minWidth: 0 }}>
            {!method ? (
              <div className="sem-inset">
                <EmptyState
                  icon={<IconTerminal2 size={28} stroke={1.4} />} title="Choose a method"
                  description={<>Pick one of the {methods.length} methods on the left. Tags show what a method does: <RiskTag risk="read" /> changes nothing, <RiskTag risk="write" /> changes the configuration, <RiskTag risk="danger" /> is disruptive or security-critical and asks you to confirm.</>}
                  action={(
                    <div className="sem-row-inline" style={{ justifyContent: "center" }}>
                      {["GetServerInfo", "GetServerStatus", "EnumHub", "GetCaps"].filter((n) => methods.some((m) => m.name === n)).map((n) => (
                        <Button key={n} size="xs" variant="default" onClick={() => select(n)} styles={{ label: { fontFamily: "var(--sem-font-mono)" } }}>{n}</Button>
                      ))}
                    </div>
                  )}
                  testId="console-empty"
                />
              </div>
            ) : (
              <section data-testid="console-editor">
                <div className="sa-method-head">
                  <div style={{ minWidth: 0 }}>
                    <h2 className="sa-method-title" data-testid="console-method-name">{method.name}</h2>
                    <div className="sa-method-tags">
                      <RiskTag risk={method.risk} />
                      <Tag variant="outline">{AREA_LABEL[method.area] ?? method.area}</Tag>
                      {method.hubScoped && <Tag color="purple" variant="outline">Virtual Hub</Tag>}
                      <span className="sem-dim" style={{ fontSize: "var(--sem-fz-small)" }}>
                        <Mono dim>{method.input ?? "no input"}</Mono> → <Mono dim>{method.output}</Mono>
                      </span>
                    </div>
                  </div>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <Button size="xs" variant="default" leftSection={<IconCopy size={13} />} rightSection={<IconChevronDown size={12} />} data-testid="console-copy-as">Copy As</Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item onClick={() => copy(jsonRpcBody, "JSON-RPC request")}>JSON-RPC Request</Menu.Item>
                      <Menu.Item onClick={() => copy(curl, "curl command")}>curl Command</Menu.Item>
                      <Menu.Item onClick={() => copy(JSON.stringify(safeParams, null, 2), "Parameters")}>Parameters (JSON)</Menu.Item>
                      <Menu.Divider />
                      <Menu.Label>Secrets are left out.</Menu.Label>
                    </Menu.Dropdown>
                  </Menu>
                </div>
                <p className="sa-doc" data-clamped={!docOpen || undefined} data-testid="console-doc">{method.doc}</p>
                {method.doc.length > 260 && (
                  <Button size="compact-xs" variant="subtle" onClick={() => setDocOpen((o) => !o)} mt={2}>{docOpen ? "Show Less" : "Show More"}</Button>
                )}
                {method.risk === "danger" && (
                  <div style={{ marginTop: 10 }}>
                    <Callout tone="red" testId="console-danger">{RISK.danger.help} You’ll be asked to confirm before it runs.</Callout>
                  </div>
                )}

                {hubField && (
                  <FormSection>
                    <FormRow label="Virtual Hub" description={<>Sets <Mono dim>{hubField}</Mono></>}>{(id) => (
                      <Autocomplete id={id} data={hubNames} value={hub} onChange={setHub} readOnly={hubMode} w={280} placeholder="Hub name" data-testid="console-hub" />
                    )}</FormRow>
                  </FormSection>
                )}

                {method.input && inputType && inputType.fields.length > 0 ? (
                  <>
                    <div className="sa-run-bar">
                      <SegmentedControl size="xs" value={mode} onChange={switchMode} aria-label="Parameters editor" data-testid="console-mode"
                        data={[{ value: "form", label: "Form" }, { value: "json", label: "JSON" }]} />
                      <span className="sem-row-inline" style={{ gap: 6 }}>
                        {getCounterpart && (
                          <Button size="xs" variant="default" leftSection={<IconDatabaseImport size={13} />} loading={loadingCurrent} onClick={() => void loadCurrent()}
                            title={`Fill in the current values from ${getCounterpart.name}, so fields you don’t change keep their value`} data-testid="console-load-current">
                            Load Current Values
                          </Button>
                        )}
                        <Button size="xs" variant="default" leftSection={<IconEraser size={13} />} onClick={resetParams} data-testid="console-reset">Reset</Button>
                      </span>
                    </div>
                    {mode === "form" ? (
                      <div data-testid="console-form">
                        {formFields.length === 0
                          ? <p className="sem-dim" style={{ marginTop: 12 }}>No parameters besides the Virtual Hub.</p>
                          : (
                            <FormSection>
                              {formFields.map((f) => (
                                <RpcField key={f.name} field={f} catalog={catalog.data!} value={params[f.name]} onChange={(v) => setParams((p) => ({ ...p, [f.name]: v }))} />
                              ))}
                            </FormSection>
                          )}
                      </div>
                    ) : (
                      <div style={{ marginTop: 12 }}>
                        <JsonInput
                          aria-label="Parameters" description={<>JSON object of type <Mono dim>{method.input}</Mono></>}
                          value={jsonText} onChange={(v) => { setJsonText(v); setJsonErr(null); }}
                          onBlur={() => {
                            try {
                              const v = JSON.parse(jsonText);
                              if (v && typeof v === "object" && !Array.isArray(v)) { setParams(v); if (hubField && typeof v[hubField] === "string") setHub(v[hubField]); }
                            } catch { /* shown by validationError */ }
                          }}
                          validationError="Not valid JSON" formatOnBlur autosize minRows={8} maxRows={28} spellCheck={false}
                          styles={{ input: { fontFamily: "var(--sem-font-mono)", fontSize: "var(--sem-fz-small)" } }} data-testid="console-json"
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <p className="sem-dim" style={{ marginTop: 12 }}>This method takes no parameters.</p>
                )}

                <div className="sa-run-bar">
                  <span className="sem-dim" style={{ fontSize: "var(--sem-fz-small)" }}>
                    {jsonErr ? <span className="sem-text-red" data-testid="console-error">{jsonErr}</span>
                      : hasSecrets(params) ? "Passwords and keys are left out of the history and copied snippets."
                      : <>Press <Shortcut keys={["mod", "enter"]} /> to run.</>}
                  </span>
                  <Button leftSection={<IconPlayerPlay size={14} />} onClick={() => void execute()} loading={running} disabled={!s || !reachable}
                    color={method.risk === "danger" ? "red" : undefined} data-testid="console-execute">
                    {method.risk === "danger" ? "Run…" : "Run"}
                  </Button>
                </div>

                {last && last.method === method.name && (
                  <Section
                    title={<span className="sa-result-head">Result
                      <StatusBadge status={last.ok ? "ok" : "error"} testId="console-result-status">{last.ok ? "Success" : "Error"}</StatusBadge>
                      <span className="sem-dim" style={{ fontWeight: 400, fontSize: "var(--sem-fz-small)" }}>{last.ms} ms · {new Date(last.at).toLocaleTimeString()}</span>
                    </span>}
                    testId="console-result"
                  >
                    <div ref={resultRef}>
                      {last.ok ? (
                        last.result !== undefined
                          ? <JsonResult value={last.result} filename={`${method.name}-${new Date(last.at).toISOString().replace(/[:.]/g, "-")}.json`} />
                          : <p className="sem-dim">The result was too large to keep in the history. Run the method again to see it.</p>
                      ) : (
                        <>
                          <ErrorState inline error={new ApiError(last.error?.status ?? 500, { error: last.error?.message, softEtherCode: last.error?.code, kind: last.error?.kind })} />
                          {last.error?.code !== undefined && catalog.data?.errors[String(last.error.code)] && catalog.data.errors[String(last.error.code)] !== last.error.message && (
                            <p className="sem-dim" style={{ margin: "6px 0 0" }} data-testid="console-error-doc">SoftEther: {catalog.data.errors[String(last.error.code)]}</p>
                          )}
                        </>
                      )}
                    </div>
                  </Section>
                )}

                {catalog.data && (
                  <Section title="Schema">
                    <div className="sem-stack" style={{ gap: 4 }}>
                      {method.input && catalog.data.types[method.input] && (
                        <Disclosure label={<>Input · <Mono>{method.input}</Mono></>} testId="console-schema-input">
                          <div style={{ padding: "8px 0 10px" }}><TypeFields catalog={catalog.data} typeName={method.input} /></div>
                        </Disclosure>
                      )}
                      <Disclosure label={<>Output · <Mono>{method.output}</Mono></>} testId="console-schema-output">
                        <div style={{ padding: "8px 0 10px" }}><TypeFields catalog={catalog.data} typeName={method.output} /></div>
                      </Disclosure>
                    </div>
                  </Section>
                )}
              </section>
            )}

            <Section
              title="History" description={`The last ${HISTORY_MAX} calls of this session. Double-click one to restore it.`}
              testId="console-history"
              actions={history.length > 0 && (
                <Button size="xs" variant="default" leftSection={<IconClearAll size={13} />} onClick={() => { setHistory([]); saveHistory(histKey, []); }} data-testid="console-history-clear">Clear History</Button>
              )}
            >
              <DataTable
                data={history} rowKey={(h) => h.id} aria-label="Call history" selectable="single" onRowOpen={restore} contextMenu={historyMenu}
                rowTestId={() => "console-history-row"} searchable={history.length > 8} searchPlaceholder="Filter calls" maxHeight={340}
                empty={{ title: "No calls yet", description: "Calls you run appear here.", icon: <IconHistory size={24} stroke={1.4} /> }}
                columns={[
                  { key: "at", title: "Time", width: 96, render: (h) => <span className="sem-dim sem-num" title={new Date(h.at).toLocaleString()}>{new Date(h.at).toLocaleTimeString()}</span> },
                  { key: "method", title: "Method", render: (h) => <span className="sem-mono sem-strong">{h.method}</span> },
                  { key: "hub", title: "Hub", width: 160, truncate: true, value: (h) => (HUB_FIELDS.map((f) => h.params[f]).find((v) => typeof v === "string" && v) as string | undefined) ?? "",
                    render: (h) => (HUB_FIELDS.map((f) => h.params[f]).find((v) => typeof v === "string" && v) as string | undefined) ?? <span className="sem-dim">–</span> },
                  { key: "ok", title: "Status", width: 120, render: (h) => h.ok ? <StatusBadge status="ok">OK</StatusBadge>
                    : <StatusBadge status="error" tooltip={h.error?.message}>{h.error?.code !== undefined ? `Error ${h.error.code}` : h.error?.kind ? "Failed" : `HTTP ${h.error?.status ?? "?"}`}</StatusBadge> },
                  { key: "ms", title: "Duration", width: 90, align: "right", render: (h) => <span className="sem-dim sem-num">{h.ms} ms</span> },
                ]}
              />
            </Section>
          </div>
        </div>
      </QueryState>
    </>
  );
}
