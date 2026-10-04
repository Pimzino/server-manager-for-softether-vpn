// Helpers shared by the hub Users, Groups, Sessions and MAC & IP Tables pages (group "hub-identity-traffic").
// Only design-system components and tokens are used; nothing here hard-codes colours or sizes.
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, SegmentedControl } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangleFilled, IconCircleCheckFilled, IconPlugConnectedX, IconRefresh } from "@tabler/icons-react";
import { post } from "../../../lib/api";
import { useScope, useServer } from "../../../lib/hooks";
import { agoShort } from "../../../lib/format";
import { EmptyState, useShell } from "../../../design";

type Struct = Record<string, any>;

/** Route scope of a hub page, plus whether the background poll says the server answers. */
export function useHubScope() {
  const { serverId, hub = "" } = useScope();
  const server = useServer(serverId);
  const reachable = server.data?.state?.ok !== false;
  return { serverId, hub, server, reachable, ready: !!server.data && reachable };
}

/** One "Can’t reach …" state instead of a failing RPC per table (design guide §8, "Server down"). */
export function Unreachable({ serverId }: { serverId: number }) {
  const server = useServer(serverId);
  const shell = useShell();
  const qc = useQueryClient();
  const s = server.data;
  if (!s) return null;
  return (
    <div className="sem-unreachable" data-testid="hub-unreachable">
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
 * Sheet footer: an optional validation message on the left, buttons on the right
 * (secondary left of primary, primary rightmost).
 */
export function SheetFooter({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="sem-row-inline" style={{ width: "100%", justifyContent: "space-between", flexWrap: "nowrap" }}>
      <span className="sem-form-actions-note" style={{ minWidth: 0 }} data-testid="sheet-note">{note}</span>
      <div className="sem-row-inline" style={{ flex: "none", flexWrap: "nowrap", gap: "var(--sem-space-4)" }}>{children}</div>
    </div>
  );
}

/** Pane switcher at the top of a multi-pane Sheet (the macOS segmented "tab view"). */
export function PaneSwitcher<T extends string>({ value, onChange, panes, testId }: {
  value: T; onChange: (v: T) => void; panes: { value: T; label: ReactNode; disabled?: boolean }[]; testId?: string;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "center", margin: "var(--sem-space-2) 0 var(--sem-space-5)" }}>
      <SegmentedControl
        size="xs" value={value} onChange={(v) => onChange(v as T)} data-testid={testId}
        data={panes.map((p) => ({ value: p.value, label: p.label, disabled: p.disabled }))}
      />
    </div>
  );
}

/** Toast for a bulk operation: green when everything worked, orange with the failures otherwise. */
export function notifyBulk(verb: string, noun: [string, string], results: { ok: boolean; label: string; error?: string }[]) {
  const failed = results.filter((r) => !r.ok);
  const done = results.length - failed.length;
  const word = (n: number) => (n === 1 ? noun[0] : noun[1]);
  notifications.show({
    color: failed.length ? "orange" : "green",
    title: failed.length ? `${verb} ${done} of ${results.length} ${word(results.length)}` : undefined,
    message: failed.length
      ? failed.slice(0, 5).map((f) => `${f.label}: ${f.error ?? "failed"}`).join("\n") + (failed.length > 5 ? `\n…and ${failed.length - 5} more` : "")
      : `${verb} ${done} ${word(done)}.`,
    autoClose: failed.length ? 8000 : 3500,
    icon: failed.length ? <IconAlertTriangleFilled size={16} /> : <IconCircleCheckFilled size={16} />,
  });
}

/** Unicast + broadcast bytes of a user / group struct (EnumUser prefixes them with "Ex."). */
export function trafficOf(u: Struct, prefix = "") {
  const n = (k: string) => Number(u[`${prefix}${k}`] ?? 0);
  return {
    rx: n("Recv.UnicastBytes_u64") + n("Recv.BroadcastBytes_u64"),
    tx: n("Send.UnicastBytes_u64") + n("Send.BroadcastBytes_u64"),
  };
}

/** Traffic counters of GetUser / GetGroup as property rows. */
export const TRAFFIC_ROWS: [string, string][] = [
  ["Unicast sent", "Send.UnicastBytes_u64"], ["Unicast packets sent", "Send.UnicastCount_u64"],
  ["Broadcast sent", "Send.BroadcastBytes_u64"], ["Broadcast packets sent", "Send.BroadcastCount_u64"],
  ["Unicast received", "Recv.UnicastBytes_u64"], ["Unicast packets received", "Recv.UnicastCount_u64"],
  ["Broadcast received", "Recv.BroadcastBytes_u64"], ["Broadcast packets received", "Recv.BroadcastCount_u64"],
];
