import { useMemo, useState, type ReactNode } from "react";
import { Box, Center, Group, Loader, ScrollArea, Table, Text, TextInput, UnstyledButton } from "@mantine/core";
import { IconChevronDown, IconChevronUp, IconSearch, IconSelector } from "@tabler/icons-react";

export interface Column<T> {
  key: string;
  title: ReactNode;
  render?: (row: T) => ReactNode;
  /** Value used for sorting and searching; defaults to row[key]. */
  value?: (row: T) => string | number | boolean | null | undefined;
  sortable?: boolean;
  width?: number | string;
  align?: "left" | "right" | "center";
}

interface Props<T> {
  data: T[] | undefined;
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  loading?: boolean;
  searchable?: boolean;
  empty?: ReactNode;
  toolbar?: ReactNode;
  onRowClick?: (row: T) => void;
  initialSort?: { key: string; dir: "asc" | "desc" };
  maxHeight?: number;
  testId?: string;
}

export function DataTable<T>({
  data, columns, rowKey, loading, searchable = true, empty, toolbar, onRowClick, initialSort, maxHeight, testId,
}: Props<T>) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState(initialSort ?? null);

  const valueOf = (c: Column<T>, row: T) => (c.value ? c.value(row) : (row as Record<string, unknown>)[c.key]) as string | number | boolean | null | undefined;

  const rows = useMemo(() => {
    let r = data ?? [];
    if (q) {
      const needle = q.toLowerCase();
      r = r.filter((row) => columns.some((c) => String(valueOf(c, row) ?? "").toLowerCase().includes(needle)));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        r = [...r].sort((a, b) => {
          const va = valueOf(col, a), vb = valueOf(col, b);
          const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : String(va ?? "").localeCompare(String(vb ?? ""), undefined, { numeric: true });
          return sort.dir === "asc" ? cmp : -cmp;
        });
      }
    }
    return r;
  }, [data, q, sort, columns]);

  const header = (c: Column<T>) => {
    if (c.sortable === false) return c.title;
    const active = sort?.key === c.key;
    const Icon = active ? (sort!.dir === "asc" ? IconChevronUp : IconChevronDown) : IconSelector;
    return (
      <UnstyledButton
        onClick={() => setSort(active && sort!.dir === "asc" ? { key: c.key, dir: "desc" } : active ? null : { key: c.key, dir: "asc" })}
        style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 600 }}
      >
        {c.title}
        <Icon size={14} opacity={active ? 1 : 0.4} />
      </UnstyledButton>
    );
  };

  return (
    <Box data-testid={testId}>
      {(searchable || toolbar) && (
        <Group justify="space-between" mb="sm" wrap="wrap" gap="sm">
          {searchable ? (
            <TextInput
              placeholder="Filter…"
              leftSection={<IconSearch size={16} />}
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              w={260}
              size="sm"
              aria-label="Filter rows"
            />
          ) : <div />}
          <Group gap="xs">{toolbar}</Group>
        </Group>
      )}
      <ScrollArea.Autosize mah={maxHeight} type="auto">
        <Table striped highlightOnHover={!!onRowClick} verticalSpacing="xs" stickyHeader={!!maxHeight}>
          <Table.Thead>
            <Table.Tr>
              {columns.map((c) => (
                <Table.Th key={c.key} style={{ width: c.width, textAlign: c.align }}>{header(c)}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((row) => (
              <Table.Tr key={rowKey(row)} onClick={onRowClick ? () => onRowClick(row) : undefined} style={onRowClick ? { cursor: "pointer" } : undefined}>
                {columns.map((c) => (
                  <Table.Td key={c.key} style={{ textAlign: c.align }}>
                    {c.render ? c.render(row) : String(valueOf(c, row) ?? "")}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea.Autosize>
      {loading && <Center py="lg"><Loader size="sm" /></Center>}
      {!loading && rows.length === 0 && (
        <Center py="lg"><Text c="dimmed" size="sm" component="div">{q ? "No rows match the filter" : (empty ?? "Nothing here yet")}</Text></Center>
      )}
      {!loading && data && data.length > 0 && (
        <Text size="xs" c="dimmed" mt={4}>{rows.length === data.length ? `${data.length} item(s)` : `${rows.length} of ${data.length} item(s)`}</Text>
      )}
    </Box>
  );
}
