// Dense native-style table: sortable columns, filter field, single/multi row selection with keyboard,
// right-click context menu, double-click/Enter to open, sticky header, empty/loading/error states.
// API is a superset of the web product's DataTable, so ported pages keep their column definitions.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Button, Checkbox, CloseButton, TextInput } from "@mantine/core";
import { IconChevronDown, IconChevronUp, IconSearch } from "@tabler/icons-react";
import { EmptyState, ErrorState, TableSkeleton } from "./States";
import { useContextMenu, type ContextMenuItem } from "./ContextMenu";

export type { ContextMenuItem };

export interface Column<T> {
  key: string;
  title: ReactNode;
  render?: (row: T) => ReactNode;
  /** Value used for sorting and filtering; defaults to row[key]. */
  value?: (row: T) => string | number | boolean | null | undefined;
  sortable?: boolean;
  width?: number | string;
  align?: "left" | "right" | "center";
  /** Monospace cell (addresses, ids). */
  mono?: boolean;
  /** Truncate with an ellipsis (needs a width). Cells never wrap unless `wrap` is set. */
  truncate?: boolean;
  /** Allow the text to wrap onto several lines (long messages, notes). */
  wrap?: boolean;
}

export type RowKey = string | number;

export interface DataTableProps<T> {
  data: T[] | undefined;
  columns: Column<T>[];
  rowKey: (row: T) => RowKey;
  loading?: boolean;
  /** Query error: rendered as an ErrorState in place of the rows. */
  error?: unknown;
  onRetry?: () => void;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Custom filter predicate (default: any column value contains the text). */
  filterFn?: (row: T, query: string) => boolean;
  /** Controls placed after the filter field (segmented filters, selects). */
  filters?: ReactNode;
  /** Actions on the right of the table toolbar. */
  toolbar?: ReactNode;
  /** Empty-state content when there is no data at all. A string/node becomes the title. */
  empty?: ReactNode | { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode };
  /** Called on click (after selection). Kept for web-product compatibility; prefer onRowOpen for navigation. */
  onRowClick?: (row: T) => void;
  /** Double-click or Enter on a row. */
  onRowOpen?: (row: T) => void;
  initialSort?: { key: string; dir: "asc" | "desc" };
  /** Scroll inside the table (both axes) with a sticky header; otherwise the page scrolls and the header sticks to it. */
  maxHeight?: number | string;
  selectable?: "single" | "multi" | false;
  /** Controlled selection (row keys). */
  selection?: RowKey[];
  onSelectionChange?: (keys: RowKey[], rows: T[]) => void;
  contextMenu?: (row: T, selected: T[]) => ContextMenuItem[];
  rowTestId?: (row: T) => string;
  /** Dim or colour a row. */
  rowTone?: (row: T) => "dim" | "danger" | "warning" | undefined;
  /** "12 items" line under the table. Default true. */
  footer?: boolean;
  testId?: string;
  "aria-label"?: string;
}

type Sort = { key: string; dir: "asc" | "desc" } | null;

function isEmptyObj(e: DataTableProps<unknown>["empty"]): e is { title: ReactNode; description?: ReactNode; action?: ReactNode; icon?: ReactNode } {
  return !!e && typeof e === "object" && "title" in (e as object);
}

export function DataTable<T>(props: DataTableProps<T>) {
  const {
    data, columns, rowKey, loading, error, onRetry, searchable = true, searchPlaceholder = "Filter", filterFn, filters, toolbar, empty,
    onRowClick, onRowOpen, initialSort, maxHeight, selectable = false, contextMenu, rowTestId, rowTone, footer = true, testId,
  } = props;
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>(initialSort ?? null);
  const [innerSel, setInnerSel] = useState<RowKey[]>([]);
  const selection = props.selection ?? innerSel;
  const [cursor, setCursor] = useState<RowKey | null>(null);
  const anchor = useRef<RowKey | null>(null);
  const cm = useContextMenu();
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);

  // Scroll sideways only when the columns don't fit, so the header can stick to the page otherwise.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => {
      const t = el.querySelector("table");
      setOverflow(!!t && t.scrollWidth > el.clientWidth + 1);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const t = el.querySelector("table");
    if (t) ro.observe(t);
    return () => ro.disconnect();
  }, [data, columns]);

  const valueOf = useCallback((c: Column<T>, row: T) =>
    (c.value ? c.value(row) : (row as Record<string, unknown>)[c.key]) as string | number | boolean | null | undefined, []);

  const rows = useMemo(() => {
    let r = data ?? [];
    if (q) {
      const needle = q.toLowerCase();
      r = r.filter((row) => filterFn ? filterFn(row, needle) : columns.some((c) => String(valueOf(c, row) ?? "").toLowerCase().includes(needle)));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        r = [...r].sort((a, b) => {
          const va = valueOf(col, a), vb = valueOf(col, b);
          const cmp = typeof va === "number" && typeof vb === "number" ? va - vb
            : typeof va === "boolean" && typeof vb === "boolean" ? Number(va) - Number(vb)
            : String(va ?? "").localeCompare(String(vb ?? ""), undefined, { numeric: true, sensitivity: "base" });
          return sort.dir === "asc" ? cmp : -cmp;
        });
      }
    }
    return r;
  }, [data, q, sort, columns, filterFn, valueOf]);

  const keyed = useMemo(() => rows.map((r) => ({ k: rowKey(r), r })), [rows, rowKey]);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const selectedRows = useMemo(() => (data ?? []).filter((r) => selectedSet.has(rowKey(r))), [data, selectedSet, rowKey]);

  const setSelection = (keys: RowKey[]) => {
    if (!props.selection) setInnerSel(keys);
    props.onSelectionChange?.(keys, (data ?? []).filter((r) => keys.includes(rowKey(r))));
  };

  // Drop selected keys that disappeared from the data
  useEffect(() => {
    if (!data || !selection.length) return;
    const present = new Set(data.map(rowKey));
    const kept = selection.filter((k) => present.has(k));
    if (kept.length !== selection.length) setSelection(kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const select = (k: RowKey, e?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) => {
    setCursor(k);
    if (!selectable) return;
    if (selectable === "multi" && e?.shiftKey && anchor.current !== null) {
      const a = keyed.findIndex((x) => x.k === anchor.current), b = keyed.findIndex((x) => x.k === k);
      if (a >= 0 && b >= 0) { setSelection(keyed.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.k)); return; }
    }
    anchor.current = k;
    if (selectable === "multi" && (e?.metaKey || e?.ctrlKey)) {
      setSelection(selectedSet.has(k) ? selection.filter((x) => x !== k) : [...selection, k]);
    } else {
      setSelection([k]);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("input, textarea, button:not(.sem-table-row-btn)")) return;
    if (!keyed.length) return;
    const idx = keyed.findIndex((x) => x.k === (cursor ?? selection[selection.length - 1]));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? Math.min(keyed.length - 1, idx + 1) : Math.max(0, idx < 0 ? 0 : idx - 1);
      const k = keyed[next].k;
      if (selectable === "multi" && e.shiftKey) select(k, { shiftKey: true }); else select(k);
      bodyRef.current?.querySelector(`[data-rowindex="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && idx >= 0) {
      e.preventDefault();
      onRowOpen?.(keyed[idx].r);
    } else if (e.key === " " && selectable === "multi" && idx >= 0) {
      e.preventDefault();
      select(keyed[idx].k, { metaKey: true });
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && selectable === "multi") {
      e.preventDefault();
      setSelection(keyed.map((x) => x.k));
    } else if (e.key === "Escape" && selection.length) {
      setSelection([]);
    }
  };

  const onContext = (e: MouseEvent, row: T) => {
    if (!contextMenu) return;
    e.preventDefault();
    const k = rowKey(row);
    const already = selectedSet.has(k);
    if (!already) select(k);
    cm.open(e, contextMenu(row, already ? selectedRows : [row]));
  };

  const header = (c: Column<T>) => {
    if (c.sortable === false) return <span className="sem-th-label">{c.title}</span>;
    const active = sort?.key === c.key;
    const Icon = active && sort!.dir === "desc" ? IconChevronDown : IconChevronUp;
    return (
      <button
        type="button"
        className="sem-th-sort"
        data-active={active || undefined}
        onClick={() => setSort(active && sort!.dir === "asc" ? { key: c.key, dir: "desc" } : active ? null : { key: c.key, dir: "asc" })}
      >
        <span className="sem-th-label">{c.title}</span>
        <Icon size={11} stroke={2.2} className="sem-th-icon" />
      </button>
    );
  };

  const total = data?.length ?? 0;
  const multi = selectable === "multi";
  const allChecked = multi && keyed.length > 0 && keyed.every((x) => selectedSet.has(x.k));
  const someChecked = multi && keyed.some((x) => selectedSet.has(x.k));
  const hasToolbar = searchable || filters || toolbar;

  let bodyContent: ReactNode = null;
  if (error && !data) bodyContent = <ErrorState error={error} onRetry={onRetry} inline />;
  else if (loading && !data) bodyContent = <TableSkeleton columns={Math.min(columns.length, 5)} />;
  else if (total === 0) {
    bodyContent = isEmptyObj(empty)
      ? <EmptyState compact title={empty.title} description={empty.description} action={empty.action} icon={empty.icon} />
      : <EmptyState compact title={empty ?? "Nothing here yet"} />;
  } else if (rows.length === 0) {
    bodyContent = <EmptyState compact title={<>No results for “{q}”</>} action={<Button size="xs" variant="default" onClick={() => setQ("")}>Clear Filter</Button>} />;
  }

  return (
    <div className="sem-table-wrap" data-testid={testId}>
      {hasToolbar && (
        <div className="sem-table-toolbar">
          {searchable && (
            <TextInput
              className="sem-table-filter"
              placeholder={searchPlaceholder}
              leftSection={<IconSearch size={13} stroke={1.8} />}
              rightSection={q ? <CloseButton size="xs" onClick={() => setQ("")} aria-label="Clear filter" /> : null}
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Escape") setQ(""); }}
              size="xs"
              aria-label="Filter rows"
              data-testid={testId ? `${testId}-filter` : undefined}
            />
          )}
          {filters}
          <div className="sem-table-toolbar-spacer" />
          {toolbar}
        </div>
      )}
      <div
        ref={scrollRef}
        className="sem-table-scroll"
        data-scroll={maxHeight ? "inner" : "page"}
        data-overflow={overflow || undefined}
        style={maxHeight ? { maxHeight } : undefined}
        tabIndex={keyed.length ? 0 : -1}
        onKeyDown={onKeyDown}
        aria-label={props["aria-label"] ? `${props["aria-label"]}${keyed.length ? " (use arrow keys to select, Enter to open)" : ""}` : undefined}
      >
        <table
          className="sem-table" data-selectable={selectable || undefined} data-clickable={!!(onRowClick || onRowOpen) || undefined}
          role={selectable ? "grid" : undefined} aria-label={props["aria-label"]} aria-multiselectable={multi || undefined} aria-rowcount={rows.length + 1}
        >
          <colgroup>
            {multi && <col style={{ width: 30 }} />}
            {columns.map((c) => <col key={c.key} style={{ width: c.width }} />)}
          </colgroup>
          <thead>
            <tr>
              {multi && (
                <th className="sem-th-check">
                  <Checkbox
                    size="xs" aria-label="Select all rows" checked={allChecked} indeterminate={someChecked && !allChecked}
                    onChange={() => setSelection(allChecked ? [] : keyed.map((x) => x.k))}
                  />
                </th>
              )}
              {columns.map((c) => (
                <th key={c.key} style={{ textAlign: c.align }} data-align={c.align} aria-sort={sort?.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                  {header(c)}
                </th>
              ))}
            </tr>
          </thead>
          {!bodyContent && (
            <tbody ref={bodyRef}>
              {keyed.map(({ k, r }, i) => {
                const sel = selectedSet.has(k);
                return (
                  <tr
                    key={k}
                    data-rowindex={i}
                    data-selected={sel || undefined}
                    data-cursor={cursor === k || undefined}
                    data-tone={rowTone?.(r)}
                    aria-selected={selectable ? sel : undefined}
                    data-testid={rowTestId?.(r)}
                    onClick={(e) => { select(k, e); onRowClick?.(r); }}
                    onDoubleClick={() => onRowOpen?.(r)}
                    onContextMenu={(e) => onContext(e, r)}
                  >
                    {multi && (
                      <td className="sem-td-check" onClick={(e) => { e.stopPropagation(); select(k, { metaKey: true }); }}>
                        <Checkbox size="xs" checked={sel} onChange={() => undefined} aria-label="Select row" tabIndex={-1} />
                      </td>
                    )}
                    {columns.map((c) => (
                      <td key={c.key} style={{ textAlign: c.align }} data-mono={c.mono || undefined} data-truncate={c.truncate || undefined} data-wrap={c.wrap || undefined}>
                        {c.render ? c.render(r) : String(valueOf(c, r) ?? "")}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
        {bodyContent && <div className="sem-table-state">{bodyContent}</div>}
      </div>
      {footer && total > 0 && (
        <div className="sem-table-footer" aria-live="polite">
          {rows.length === total ? `${total.toLocaleString()} ${total === 1 ? "item" : "items"}` : `${rows.length.toLocaleString()} of ${total.toLocaleString()}`}
          {selectable && selection.length > 0 && <> · {selection.length} selected</>}
          {loading && data && <span className="sem-table-refreshing"> · Updating…</span>}
        </div>
      )}
      {cm.menu}
    </div>
  );
}
