// Result viewer for RPC results (API console, raw views): a collapsible JSON tree, the plain text, and a table
// for every array of records in the result. Copy and Save JSON… act on the whole result.
import { useMemo, useState } from "react";
import { ActionIcon, SegmentedControl, Tooltip } from "@mantine/core";
import { IconDownload } from "@tabler/icons-react";
import { downloadText } from "../../lib/format";
import { notifyError } from "../../lib/hooks";
import { CopyButton, DataTable, JsonView, Tag, type Column } from "../../design";

type Rec = Record<string, unknown>;

function isRecordArray(v: unknown): v is Rec[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x));
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Auto-generated table for an array of records: one column per key seen in any row. */
export function RecordTable({ rows, name, testId }: { rows: Rec[]; name?: string; testId?: string }) {
  const cols = useMemo<Column<Rec & { __i: number }>[]>(() => {
    const keys: string[] = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    return keys.map((k) => ({
      key: k,
      title: <span className="sem-mono">{k}</span>,
      value: (r: Rec) => { const v = r[k]; return typeof v === "number" || typeof v === "boolean" ? (v as number) : cell(v); },
      align: rows.every((r) => r[k] === undefined || typeof r[k] === "number") ? "right" : undefined,
      render: (r: Rec) => {
        const v = r[k];
        if (typeof v === "boolean") return <Tag color={v ? "green" : "gray"}>{String(v)}</Tag>;
        const s = cell(v);
        return <span className="sem-mono sem-num" title={s.length > 40 ? s : undefined} style={{ display: "inline-block", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "bottom" }}>{s}</span>;
      },
    }));
  }, [rows]);
  const data = useMemo(() => rows.map((r, i) => ({ ...r, __i: i })), [rows]);
  return <DataTable data={data} columns={cols} rowKey={(r) => r.__i} maxHeight={480} aria-label={name ?? "Result rows"} testId={testId} />;
}

/**
 * RPC result viewer. `filename` is the suggested name for Save JSON…
 * Test ids: `console-copy`, `console-download`, `console-result-json` (tree), `console-result-text` (plain text),
 * `console-result-table` (table view).
 */
export function JsonResult({ value, filename, testId }: { value: unknown; filename: string; testId?: string }) {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const tables = useMemo(() => {
    if (!value || typeof value !== "object") return [];
    return Object.entries(value as Rec).filter(([, v]) => isRecordArray(v)) as [string, Rec[]][];
  }, [value]);
  const [view, setView] = useState<string>("tree");
  const active = view === "tree" || view === "text" || tables.some(([k]) => k === view) ? view : "tree";

  return (
    <div className="sem-stack" style={{ gap: "var(--sem-space-4)" }} data-testid={testId}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sem-space-5)", flexWrap: "wrap" }}>
        <SegmentedControl size="xs" value={active} onChange={setView} aria-label="Result view"
          data={[{ value: "tree", label: "JSON" }, { value: "text", label: "Text" }, ...tables.map(([k, v]) => ({ value: k, label: `${k} (${v.length})` }))]} />
        <span className="sem-row-inline" style={{ gap: "var(--sem-space-2)" }}>
          <span className="sem-dim sem-num">{(text.length / 1024).toFixed(1)} KB</span>
          <CopyButton value={text} label="Copy JSON" testId="console-copy" />
          <Tooltip label="Save JSON…" openDelay={300}>
            <ActionIcon variant="subtle" color="gray" size={22} aria-label="Save JSON" data-testid="console-download"
              onClick={() => { downloadText(filename, text, "application/json").catch((e) => notifyError(e, "Couldn’t save the file")); }}>
              <IconDownload size={14} stroke={1.6} />
            </ActionIcon>
          </Tooltip>
        </span>
      </div>
      {active === "tree" && <JsonView value={value} defaultDepth={3} maxHeight={560} copy={false} testId="console-result-json" />}
      {active === "text" && (
        <pre className="sem-json" style={{ maxHeight: 560, margin: 0, whiteSpace: "pre" }} data-testid="console-result-text"><code className="sem-mono sem-json-root">{text}</code></pre>
      )}
      {active !== "tree" && active !== "text" && <RecordTable rows={tables.find(([k]) => k === active)![1]} name={active} testId="console-result-table" />}
    </div>
  );
}
