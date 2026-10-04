// Helpers shared by the server "network" pages (Virtual Hubs, Connections, Listeners, Local Bridges,
// Layer 3 Switches, DDNS). Built only from design-system components and tokens.
import { useId, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Group } from "@mantine/core";
import { IconPlugConnectedX, IconRefresh } from "@tabler/icons-react";
import { post } from "../../../lib/api";
import { notifySuccess, useServer } from "../../../lib/hooks";
import { agoShort } from "../../../lib/format";
import { EmptyState, Sheet, useShell } from "../../../design";

/**
 * Connection facts every server page needs. `live` is false while the server record loads and when the
 * background poll already knows the server is down: gate RPC queries on it so a dead server doesn't get
 * one failing call per section (design guide §8).
 */
export function useServerPage(serverId: number) {
  const server = useServer(serverId);
  const s = server.data;
  const reachable = s?.state?.ok !== false;
  return { server, s, hubMode: !!s?.hub, reachable, live: !!s && reachable };
}

/** One explanation with Try Again when the server can't be reached (same as the Overview page). */
export function Unreachable({ serverId }: { serverId: number }) {
  const { s } = useServerPage(serverId);
  const shell = useShell();
  const qc = useQueryClient();
  if (!s) return null;
  return (
    <div className="sem-unreachable" data-testid="page-unreachable">
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

/**
 * A Sheet whose body is a form: Enter submits, the footer holds Cancel and the primary button
 * (which names the verb). `note` sits on the left of the footer (a validation hint or a count).
 */
export function FormSheet({
  opened, onClose, title, subtitle, icon, busy, submitLabel, onSubmit, valid = true, testId, submitTestId, size = 560, note, danger, children,
}: {
  opened: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; busy?: boolean;
  submitLabel: string; onSubmit: () => void; valid?: boolean; testId?: string; submitTestId?: string; size?: number;
  note?: ReactNode; danger?: boolean; children: ReactNode;
}) {
  const formId = useId();
  return (
    <Sheet
      opened={opened} onClose={onClose} busy={busy} title={title} subtitle={subtitle} icon={icon} size={size} testId={testId}
      footer={(
        <Group justify="space-between" wrap="nowrap" gap={12}>
          <span className="sem-dim" style={{ fontSize: "var(--sem-fz-small)", minWidth: 0 }}>{note}</span>
          <Group gap={8} wrap="nowrap">
            <Button variant="default" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="submit" form={formId} loading={busy} disabled={!valid} color={danger ? "red" : undefined} data-testid={submitTestId}>{submitLabel}</Button>
          </Group>
        </Group>
      )}
    >
      <form id={formId} onSubmit={(e) => { e.preventDefault(); if (valid && !busy) onSubmit(); }} noValidate>
        {children}
        {/* Enter in a text field submits the form even though the button lives in the footer. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Sheet>
  );
}

/**
 * Revert / Apply buttons under a settings group that is applied with one RPC (UDP ports, special listeners,
 * proxy). Settings pages with a single form use FormActions instead; these pages have several independent groups.
 */
export function ApplyBar({ dirty, valid = true, saving, onApply, onRevert, applyLabel = "Apply", note, testId }: {
  dirty: boolean; valid?: boolean; saving?: boolean; onApply: () => void; onRevert: () => void; applyLabel?: string; note?: ReactNode; testId?: string;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" gap={12} mt={8} px={2}>
      <span className="sem-dim" style={{ fontSize: "var(--sem-fz-small)", minWidth: 0 }}>{dirty ? note ?? "You have unsaved changes." : null}</span>
      <Group gap={8} wrap="nowrap">
        <Button variant="default" disabled={!dirty || saving} onClick={onRevert} data-testid={testId ? `${testId}-reset` : undefined}>Revert</Button>
        <Button disabled={!dirty || !valid} loading={saving} onClick={onApply} data-testid={testId}>{applyLabel}</Button>
      </Group>
    </Group>
  );
}

/** Read/remember a per-viewer UI preference (auto-refresh interval…). Storage may be unavailable. */
export function loadPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(`sem.pref.${key}`) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch { return fallback; }
}
export function savePref(key: string, value: string) {
  try { localStorage.setItem(`sem.pref.${key}`, value); } catch { /* storage blocked: preference not remembered */ }
}

/** Copy text from a context menu, with a short confirmation toast. */
export async function copyText(text: string, what = "Copied to the clipboard") {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  notifySuccess(what);
}
