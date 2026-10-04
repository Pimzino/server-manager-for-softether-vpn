// Helpers shared by the "server-advanced" pages: the reachability gate (one "Can’t reach …" state instead of
// one failing RPC per section), a line-numbered searchable text viewer (logs, configurations), and the
// syslog settings form used by both Server Settings and Logs & Syslog.
import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, CloseButton, NumberInput, Select, TextInput } from "@mantine/core";
import { IconPlugConnectedX, IconRefresh, IconSearch } from "@tabler/icons-react";
import { post } from "../../../lib/api";
import { useRpc, useRpcMutation, useServer } from "../../../lib/hooks";
import { agoShort, bytes } from "../../../lib/format";
import { EmptyState, ErrorState, FormRow, FormSection, PropertySkeleton, Tag, useShell } from "../../../design";
import { Callout, HelpLabel } from "../../../components/domain/ui";
import "./advanced.css";

// ------------------------------------------------------------------------------ reachability

/** The saved connection and whether the background poll can reach it (pages gate their RPCs on it). */
export function useReachable(serverId: number) {
  const server = useServer(serverId);
  const s = server.data;
  return { server, s, reachable: !!s && s.state?.ok !== false, hubMode: !!s?.hub };
}

/** Shown instead of the page body when the server is down (same pattern as Overview). */
export function Unreachable({ serverId, testId }: { serverId: number; testId?: string }) {
  const server = useServer(serverId);
  const shell = useShell();
  const qc = useQueryClient();
  const s = server.data;
  if (!s) return null;
  return (
    <div className="sem-unreachable" data-testid={testId ?? "page-unreachable"}>
      <EmptyState
        icon={<IconPlugConnectedX size={30} stroke={1.4} />}
        title={<>Can’t reach {s.name}</>}
        description={<>{s.state?.error ?? "The last status check failed."}<br /><span className="sem-dim">Last checked {agoShort(s.state?.checkedAt)}.</span></>}
        action={(
          <div className="sem-row-inline">
            <Button variant="default" onClick={() => shell.openConnection(s.id)}>Edit Connection…</Button>
            <Button leftSection={<IconRefresh size={14} />} onClick={async () => {
              await post(`/api/servers/${serverId}/refresh`).catch(() => undefined);
              void qc.invalidateQueries({ queryKey: ["server", serverId] });
              void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
            }}>Try Again</Button>
          </div>
        )}
      />
    </div>
  );
}

// ------------------------------------------------------------------------------ text viewer

function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  for (let hit = lower.indexOf(needle); hit >= 0; hit = lower.indexOf(needle, i)) {
    if (hit > i) out.push(text.slice(i, hit));
    out.push(<mark key={hit}>{text.slice(hit, hit + needle.length)}</mark>);
    i = hit + needle.length;
  }
  out.push(text.slice(i));
  return <>{out}</>;
}

/** Filter field + "N matching lines" + "Only matching lines", shared by the viewers. */
export function useTextFilter() {
  const [q, setQ] = useState("");
  const [only, setOnly] = useState(false);
  /** Return / Shift-Return in the find field moves between matches. */
  const [step, setStep] = useState(0);
  return { q, setQ: (v: string) => { setQ(v); setStep(0); }, only, setOnly, needle: q.trim().toLowerCase(), step, setStep };
}

export function TextFilterBar({ filter, hits, testId, hitsTestId, children, meta }: {
  filter: ReturnType<typeof useTextFilter>; hits: number; testId?: string; children?: ReactNode; meta?: ReactNode;
  /** Overrides the "<testId>-hits" test id (the web Logs page used "log-matches"). */
  hitsTestId?: string;
}) {
  const { q, setQ, only, setOnly, needle } = filter;
  return (
    <div className="sa-viewer-bar">
      <TextInput
        size="xs" w={240} placeholder="Find" aria-label="Find in text" value={q} onChange={(e) => setQ(e.currentTarget.value)}
        leftSection={<IconSearch size={13} stroke={1.7} />}
        rightSection={q ? <CloseButton size="xs" aria-label="Clear" onClick={() => setQ("")} /> : undefined}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); filter.setStep((n) => n + (e.shiftKey ? -1 : 1)); } }}
        title="Return: next match · Shift-Return: previous match"
        data-testid={testId ? `${testId}-search` : undefined}
      />
      {needle && <Tag color={hits ? "yellow" : "gray"} testId={hitsTestId ?? (testId ? `${testId}-hits` : undefined)}>{hits.toLocaleString()} matching {hits === 1 ? "line" : "lines"}</Tag>}
      <Checkbox size="xs" label="Only matching lines" checked={only} onChange={(e) => setOnly(e.currentTarget.checked)} disabled={!needle} />
      {children}
      <span className="sa-spacer" />
      {meta && <span className="sa-viewer-meta">{meta}</span>}
    </div>
  );
}

/**
 * Line-numbered monospace text with find highlighting. `lines` are pre-split; `startLine` offsets the
 * numbers (a log tail starts in the middle of the file). Renders at most `maxLines` (the last ones).
 */
export function LinesView({ lines, filter, height, wrap, testId, maxLines = 20_000, empty, viewportRef, firstHit = "first" }: {
  lines: string[]; filter: ReturnType<typeof useTextFilter>; height: number | string; wrap?: boolean; testId?: string;
  maxLines?: number; empty?: ReactNode; viewportRef?: Ref<HTMLDivElement>;
  /** Which match to reveal when the find text changes (logs: the newest, at the end). */
  firstHit?: "first" | "last";
}) {
  const { needle, only, step } = filter;
  const box = useRef<HTMLDivElement | null>(null);
  // Reveal the current match: the first (or last) one when the text changes, then Return steps through them.
  useEffect(() => {
    const el = box.current;
    if (!el || !needle) return;
    const hitsEl = el.querySelectorAll<HTMLElement>(".sa-line[data-hit]");
    if (!hitsEl.length) return;
    hitsEl.forEach((h) => h.removeAttribute("data-current"));
    const base = firstHit === "last" ? hitsEl.length - 1 : 0;
    const i = (((base + step) % hitsEl.length) + hitsEl.length) % hitsEl.length;
    hitsEl[i].setAttribute("data-current", "");
    hitsEl[i].scrollIntoView({ block: "center" });
  }, [needle, step, only, lines, firstHit]);
  const setRefs = (el: HTMLDivElement | null) => {
    box.current = el;
    if (typeof viewportRef === "function") viewportRef(el);
    else if (viewportRef && typeof viewportRef === "object") (viewportRef as { current: HTMLDivElement | null }).current = el;
  };
  const shown = useMemo(() => {
    const idx = lines.map((l, i) => [i, l] as const);
    const filtered = only && needle ? idx.filter(([, l]) => l.toLowerCase().includes(needle)) : idx;
    return filtered.length > maxLines ? filtered.slice(filtered.length - maxLines) : filtered;
  }, [lines, needle, only, maxLines]);
  const gutter = `${Math.max(3, String(lines.length).length) + 1}ch`;
  return (
    <div className="sa-text" style={{ height, ["--sa-gutter" as string]: gutter }} data-wrap={wrap || undefined} ref={setRefs} tabIndex={0}
      role="document" aria-label="Text content">
      {shown.length === 0
        ? <div className="sa-text-empty">{lines.length === 0 ? (empty ?? "Empty.") : "No lines match."}</div>
        : (
          <div className="sa-text-lines" data-testid={testId}>
            {shown.map(([i, l]) => {
              const hit = !!needle && l.toLowerCase().includes(needle);
              return (
                <div key={i} className="sa-line" data-hit={hit || undefined}>
                  <span className="sa-line-no">{i + 1}</span>
                  <span className="sa-line-text">{hit ? <Highlight text={l} needle={needle} /> : (l || " ")}</span>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}

/** Complete searchable text viewer: filter bar + line view. */
export function TextView({ text, height = 520, testId, actions, wrap }: {
  text: string; height?: number | string; testId?: string; actions?: ReactNode; wrap?: boolean;
}) {
  const filter = useTextFilter();
  const lines = useMemo(() => text.split(/\r?\n/), [text]);
  const hits = useMemo(() => (filter.needle ? lines.reduce((n, l) => n + (l.toLowerCase().includes(filter.needle) ? 1 : 0), 0) : 0), [lines, filter.needle]);
  const size = useMemo(() => new TextEncoder().encode(text).length, [text]);
  return (
    <div>
      <TextFilterBar filter={filter} hits={hits} testId={testId} meta={<>{lines.length.toLocaleString()} lines · {bytes(size)}</>}>{actions}</TextFilterBar>
      <LinesView lines={lines} filter={filter} height={height} wrap={wrap} testId={testId} />
    </div>
  );
}

// ------------------------------------------------------------------------------ syslog

export interface Syslog { SaveType_u32?: number; Hostname_str?: string; Port_u32?: number }

export const SYSLOG_TYPES = [
  { value: "0", label: "Nothing (syslog off)" },
  { value: "1", label: "Server log" },
  { value: "2", label: "Server log and hub security logs" },
  { value: "3", label: "Server, hub security and packet logs" },
];
export const SYSLOG_SHORT = ["Off", "Server log", "Server + security logs", "All logs, including packets"];

/** Host name, IPv4 or IPv6 literal. */
export function hostValid(h: string) {
  return /^[A-Za-z0-9]([A-Za-z0-9-]{0,62})?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62})?)*\.?$/.test(h) || /^[0-9a-fA-F:]+$/.test(h);
}

/** Syslog form state: loads GetSysLog, validates, saves with SetSysLog. */
export function useSyslogForm(serverId: number, enabled = true) {
  const q = useRpc<Syslog>(serverId, "GetSysLog", {}, { enabled });
  const [f, setF] = useState<Syslog>({});
  const reset = () => { if (q.data) setF({ ...q.data, Port_u32: q.data.Port_u32 || 514 }); };
  useEffect(reset, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useRpcMutation(serverId, "SetSysLog", { success: "Syslog settings saved" });
  const d = q.data;
  const on = (f.SaveType_u32 ?? 0) !== 0;
  const dirty = !!d && (f.SaveType_u32 !== d.SaveType_u32 || (f.Hostname_str ?? "") !== (d.Hostname_str ?? "") || f.Port_u32 !== (d.Port_u32 || 514));
  const hostErr = on && !(f.Hostname_str ?? "").trim() ? "Enter the syslog server." : f.Hostname_str?.trim() && !hostValid(f.Hostname_str.trim()) ? "Enter a host name or an IP address." : undefined;
  const portErr = on && (!f.Port_u32 || f.Port_u32 > 65535) ? "Enter a port from 1 to 65535." : undefined;
  const submit = () => save.mutateAsync({ ...d, ...f, Hostname_str: (f.Hostname_str ?? "").trim() });
  return { q, f, setF, reset, save, dirty, valid: !hostErr && !portErr, hostErr, portErr, on, submit };
}

/** The syslog fields as FormRows (inside the caller's FormSection or Sheet). */
export function SyslogFields({ form }: { form: ReturnType<typeof useSyslogForm> }) {
  const { f, setF, on, hostErr, portErr } = form;
  return (
    <>
      <FormRow label={<HelpLabel label="Send" doc="Which logs are forwarded to the syslog server, in addition to the log files on the VPN Server." />}>{(id) => (
        <Select id={id} data={SYSLOG_TYPES} value={String(f.SaveType_u32 ?? 0)} allowDeselect={false} w={320}
          onChange={(v) => setF((s) => ({ ...s, SaveType_u32: Number(v ?? 0) }))} data-testid="syslog-type" />
      )}</FormRow>
      <FormRow label="Syslog server" description="Host name or IP address (UDP)." error={hostErr}>{(id) => (
        <TextInput id={id} w={320} value={f.Hostname_str ?? ""} disabled={!on} placeholder={on ? "syslog.example.com" : undefined} spellCheck={false}
          onChange={(e) => setF((s) => ({ ...s, Hostname_str: e.currentTarget.value }))} data-testid="syslog-host" error={!!hostErr} />
      )}</FormRow>
      <FormRow label="Port" description="Usually 514." error={portErr}>{(id) => (
        <NumberInput id={id} w={120} min={1} max={65535} allowDecimal={false} allowNegative={false} value={f.Port_u32 ?? 514} disabled={!on}
          onChange={(v) => setF((s) => ({ ...s, Port_u32: Number(v) || 0 }))} data-testid="syslog-port" error={!!portErr} />
      )}</FormRow>
    </>
  );
}

/** Syslog settings as a FormSection with its own Revert / Save buttons (Server Settings page). */
export function SyslogSection({ serverId, enabled = true }: { serverId: number; enabled?: boolean }) {
  const form = useSyslogForm(serverId, enabled);
  return (
    <FormSection
      title="Syslog"
      description="Forward log records to a syslog server as well as writing them to the log files."
      testId="syslog-section"
      footer={form.q.data && <SectionButtons dirty={form.dirty} valid={form.valid} saving={form.save.isPending} onRevert={form.reset} onSave={() => void form.submit().catch(() => undefined)} testId="save-syslog" />}
    >
      {form.q.error ? <div style={{ padding: "10px 0" }}><ErrorState error={form.q.error} inline onRetry={() => void form.q.refetch()} /></div>
        : !form.q.data ? <div style={{ padding: "10px 0" }}><PropertySkeleton rows={3} /></div>
        : <SyslogFields form={form} />}
      {(form.f.SaveType_u32 ?? 0) === 3 && (
        <div style={{ padding: "0 0 10px" }}>
          <Callout tone="yellow">Packet logs can be very large. Make sure the syslog server and the network can take the volume.</Callout>
        </div>
      )}
    </FormSection>
  );
}

/** Revert / Save under a FormSection whose settings are applied by one RPC. */
export function SectionButtons({ dirty, valid = true, saving, onRevert, onSave, testId, saveLabel = "Save" }: {
  dirty: boolean; valid?: boolean; saving?: boolean; onRevert: () => void; onSave: () => void; testId: string; saveLabel?: string;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, marginTop: 2 }}>
      {dirty && <span className="sem-dim" style={{ marginRight: "auto" }}>Unsaved changes</span>}
      <Button size="xs" variant="default" disabled={!dirty || saving} onClick={onRevert} data-testid={`${testId}-reset`}>Revert</Button>
      <Button size="xs" disabled={!dirty || !valid} loading={saving} onClick={onSave} data-testid={testId}>{saveLabel}</Button>
    </div>
  );
}

/** "safe" file-name component. */
export function safeName(s: string) { return s.replace(/[^\w.-]+/g, "_"); }
