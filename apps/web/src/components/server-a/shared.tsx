// Small helpers shared by the server-level pages (Overview, Connections, Listeners, Bridges, L3, DDNS, Caps, Console).
import type { ReactNode } from "react";
import { Card, Group, Text, ThemeIcon, Tooltip } from "@mantine/core";
import type { Catalog } from "../../lib/types";
import { isIPv4 } from "../../lib/format";

export function StatCard({ label, value, hint, icon, color = "blue", testId }: {
  label: ReactNode; value: ReactNode; hint?: ReactNode; icon?: ReactNode; color?: string; testId?: string;
}) {
  return (
    <Card withBorder radius="md" padding="md" data-testid={testId}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>{label}</Text>
          <Text size="xl" fw={700} mt={4} style={{ fontVariantNumeric: "tabular-nums" }}>{value}</Text>
          {hint && <Text size="xs" c="dimmed" mt={2}>{hint}</Text>}
        </div>
        {icon && <ThemeIcon variant="light" color={color} size="lg" radius="md">{icon}</ThemeIcon>}
      </Group>
    </Card>
  );
}

/** Human duration from milliseconds: "3d 4h 12m", "5m 10s". */
export function duration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) return "–";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Label for an enum value using the catalog (falls back to the raw number). */
export function enumLabel(catalog: Catalog | undefined, enumName: string, value: number | undefined, pretty?: Record<number, string>): string {
  if (value === undefined || value === null) return "–";
  if (pretty?.[value]) return pretty[value];
  const v = catalog?.enums[enumName]?.values.find((x) => x.value === value);
  return v ? v.key : String(value);
}

/** Catalog doc for a field of a type, used as input descriptions. */
export function fieldDoc(catalog: Catalog | undefined, typeName: string, field: string): string | undefined {
  return catalog?.types[typeName]?.fields.find((f) => f.name === field)?.doc || undefined;
}

/** Validate a dotted IPv4 subnet mask (contiguous ones). */
export function isMask(s: string): boolean {
  if (!isIPv4(s)) return false;
  const n = s.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
  const inv = (~n) >>> 0;
  return (inv & (inv + 1)) === 0;
}

export function ipToInt(s: string): number {
  return s.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}

/** Prefix length of a dotted mask ("255.255.255.0" -> 24). */
export function maskBits(mask: string): number | null {
  if (!isMask(mask)) return null;
  let n = ipToInt(mask), bits = 0;
  while (n & 0x80000000) { bits++; n = (n << 1) >>> 0; }
  return bits;
}

export function bitsToMask(bits: number): string {
  const n = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((sh) => (n >>> sh) & 255).join(".");
}

/** Common subnet mask choices for Select/Autocomplete inputs. */
export const MASK_OPTIONS = Array.from({ length: 33 }, (_, i) => 32 - i).map((b) => ({ value: bitsToMask(b), label: `${bitsToMask(b)} (/${b})` }));

export function Mono({ children }: { children: ReactNode }) {
  return <Text span ff="monospace" size="sm">{children}</Text>;
}

export function HelpTip({ label, children }: { label?: string; children: ReactNode }) {
  if (!label) return <>{children}</>;
  return <Tooltip label={label} multiline w={340} withArrow>{<span>{children}</span>}</Tooltip>;
}
