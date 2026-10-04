// Result viewer for the API console: formatted JSON with copy/download, plus auto-detected record tables.
import { useMemo, useState } from "react";
import { ActionIcon, Badge, Code, CopyButton, Group, ScrollArea, SegmentedControl, Stack, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy, IconDownload } from "@tabler/icons-react";
import { DataTable, type Column } from "../DataTable";
import { downloadText } from "../../lib/format";

type Rec = Record<string, unknown>;

function isRecordArray(v: unknown): v is Rec[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => x !== null && typeof x === "object" && !Array.isArray(x));
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function RecordTable({ rows }: { rows: Rec[] }) {
  const cols = useMemo<Column<Rec & { __i: number }>[]>(() => {
    const keys: string[] = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    return keys.map((k) => ({
      key: k,
      title: <Text size="xs" ff="monospace" fw={700}>{k}</Text>,
      value: (r: Rec) => { const v = r[k]; return typeof v === "number" || typeof v === "boolean" ? (v as number) : cell(v); },
      render: (r: Rec) => {
        const v = r[k];
        if (typeof v === "boolean") return <Badge size="xs" variant="light" color={v ? "green" : "gray"}>{String(v)}</Badge>;
        const s = cell(v);
        return <Text size="xs" ff="monospace" style={{ whiteSpace: "nowrap", maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis" }} title={s}>{s}</Text>;
      },
    }));
  }, [rows]);
  const data = useMemo(() => rows.map((r, i) => ({ ...r, __i: i })), [rows]);
  return <DataTable data={data} columns={cols} rowKey={(r) => r.__i} maxHeight={480} />;
}

export function JsonResult({ value, filename, testId }: { value: unknown; filename: string; testId?: string }) {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const tables = useMemo(() => {
    if (!value || typeof value !== "object") return [];
    return Object.entries(value as Rec).filter(([, v]) => isRecordArray(v)) as [string, Rec[]][];
  }, [value]);
  const [view, setView] = useState<string>("json");
  const active = view !== "json" && tables.some(([k]) => k === view) ? view : "json";

  return (
    <Stack gap="xs" data-testid={testId}>
      <Group justify="space-between" wrap="wrap">
        {tables.length > 0 ? (
          <SegmentedControl size="xs" value={active} onChange={setView}
            data={[{ value: "json", label: "JSON" }, ...tables.map(([k, v]) => ({ value: k, label: `${k} (${v.length})` }))]} />
        ) : <Text size="xs" c="dimmed">{(text.length / 1024).toFixed(1)} KB</Text>}
        <Group gap={4}>
          <CopyButton value={text}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? "Copied" : "Copy JSON"}>
                <ActionIcon variant="subtle" onClick={copy} aria-label="Copy JSON" data-testid="console-copy">{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}</ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
          <Tooltip label="Download JSON">
            <ActionIcon variant="subtle" onClick={() => downloadText(filename, text, "application/json")} aria-label="Download JSON" data-testid="console-download"><IconDownload size={16} /></ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      {active === "json" ? (
        <ScrollArea.Autosize mah={560} type="auto">
          <Code block style={{ fontSize: 12, whiteSpace: "pre" }} data-testid="console-result-json">{text}</Code>
        </ScrollArea.Autosize>
      ) : (
        <RecordTable rows={tables.find(([k]) => k === active)![1]} />
      )}
    </Stack>
  );
}
