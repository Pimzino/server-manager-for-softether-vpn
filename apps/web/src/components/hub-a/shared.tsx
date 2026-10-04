// Shared helpers for the Virtual Hub "hub-a" pages (status, properties, options, message,
// RADIUS, certificates, logging, source IP ACL).
import type { ReactNode } from "react";
import { Badge, Button, Group, Paper, Text, ThemeIcon } from "@mantine/core";
import { IconDeviceFloppy, IconRestore } from "@tabler/icons-react";
import { can, useCatalog, useScope, useServer } from "../../lib/hooks";
import type { Role } from "../../lib/types";

/** Route scope plus the current user's permissions on this server. */
export function useHubAccess() {
  const { serverId, hub } = useScope();
  const server = useServer(serverId);
  const role: Role = server.data?.myRole ?? "none";
  return {
    serverId,
    hub: hub ?? "",
    server,
    role,
    canWrite: can(role, "operator"),
    canAdmin: can(role, "admin"),
    /** Connected in hub-admin mode (password of this hub only), so server-admin-only calls fail. */
    hubAdminMode: !!server.data?.hub,
    base: `/servers/${serverId}/hubs/${encodeURIComponent(hub ?? "")}`,
  };
}

/** Field documentation from the API catalog: docs("VpnRpcRadius")("RadiusPort_u32"). */
export function useDocs(typeName: string) {
  const catalog = useCatalog();
  const t = catalog.data?.types[typeName];
  return (field: string, fallback = ""): string => t?.fields.find((f) => f.name === field)?.doc || fallback;
}

/** Enum values from the catalog as Select data (string values), with a fallback list. */
export function useEnumOptions(enumName: string, fallback: { value: number; label: string }[] = []) {
  const catalog = useCatalog();
  const e = catalog.data?.enums[enumName];
  const labels = new Map(fallback.map((f) => [f.value, f.label]));
  const values = e?.values.map((v) => ({ value: v.value, label: labels.get(v.value) ?? v.doc ?? v.key })) ?? fallback;
  return values.map((v) => ({ value: String(v.value), label: v.label }));
}

export function StatCard({ label, value, sub, icon, color = "blue", testId }: {
  label: ReactNode; value: ReactNode; sub?: ReactNode; icon?: ReactNode; color?: string; testId?: string;
}) {
  return (
    <Paper withBorder radius="md" p="md" data-testid={testId}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div style={{ minWidth: 0 }}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>{label}</Text>
          <Text fw={700} fz={24} lh={1.3}>{value}</Text>
          {sub && <Text size="xs" c="dimmed" component="div">{sub}</Text>}
        </div>
        {icon && <ThemeIcon variant="light" color={color} size={38} radius="md">{icon}</ThemeIcon>}
      </Group>
    </Paper>
  );
}

/** Save / reset footer used by the form-like pages. Hidden for read-only users. */
export function SaveBar({ dirty, saving, onSave, onReset, disabled, saveLabel = "Save changes", testId = "save" }: {
  dirty: boolean; saving?: boolean; onSave: () => void; onReset: () => void; disabled?: boolean; saveLabel?: string; testId?: string;
}) {
  return (
    <Group justify="flex-end" gap="xs" mt="md">
      {dirty && <Badge color="yellow" variant="light">Unsaved changes</Badge>}
      <Button variant="default" leftSection={<IconRestore size={16} />} disabled={!dirty || saving} onClick={onReset} data-testid={`${testId}-reset`}>Reset</Button>
      <Button leftSection={<IconDeviceFloppy size={16} />} disabled={!dirty || disabled} loading={saving} onClick={onSave} data-testid={testId}>{saveLabel}</Button>
    </Group>
  );
}

export const HUB_TYPE_LABELS: Record<number, string> = {
  0: "Standalone",
  1: "Static (cluster)",
  2: "Dynamic (cluster)",
};

/** Hex string ("01 23 AB" / "01:23:ab" / "0123ab") <-> base64 for *_bin fields. */
export function hexToB64(hex: string): string {
  const clean = hex.replace(/[\s:-]/g, "");
  if (!clean) return "";
  let bin = "";
  for (let i = 0; i < clean.length; i += 2) bin += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  return btoa(bin);
}

export function b64ToHex(b64: string | undefined, sep = " "): string {
  if (!b64) return "";
  const bin = atob(b64);
  return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()).join(sep);
}

export function isHex(s: string, bytes?: number): boolean {
  const clean = s.replace(/[\s:-]/g, "");
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) return false;
  return bytes === undefined || clean.length === 0 || clean.length === bytes * 2;
}
