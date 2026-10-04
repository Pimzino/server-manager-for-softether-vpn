// Helpers shared by the hub Access Lists, Source IP Control, Cascade Connections and SecureNAT pages.
// Only things the design system doesn't provide: the page scope with reachability, the "can't reach"
// state (same as server/Overview), a segmented view switcher and a compact field grid for sheets.
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, SegmentedControl } from "@mantine/core";
import { IconPlugConnectedX, IconRefresh } from "@tabler/icons-react";
import { post } from "../../../lib/api";
import { agoShort } from "../../../lib/format";
import { useScope, useServer } from "../../../lib/hooks";
import type { Server } from "../../../lib/types";
import { EmptyState, useShell } from "../../../design";
import "./hpn.css";

/** Scope of a hub page plus whether the background poll can reach the server (gate RPCs on it). */
export function useHubPage() {
  const { serverId, hub = "" } = useScope();
  const server = useServer(serverId);
  const s = server.data;
  return { serverId, hub, server: s, ready: !!s, reachable: !!s && s.state?.ok !== false };
}

/** One explanation instead of one failing RPC per section when the server is down. */
export function Unreachable({ server }: { server: Server }) {
  const shell = useShell();
  const qc = useQueryClient();
  return (
    <div className="sem-unreachable" data-testid="hub-unreachable">
      <EmptyState
        icon={<IconPlugConnectedX size={30} stroke={1.4} />}
        title={<>Can’t reach {server.name}</>}
        description={<>{server.state?.error ?? "The last status check failed."}<br /><span className="sem-dim">Last checked {agoShort(server.state?.checkedAt)}.</span></>}
        action={(
          <div className="sem-row-inline">
            <Button variant="default" onClick={() => shell.openConnection(server.id)}>Edit Connection…</Button>
            <Button leftSection={<IconRefresh size={14} />} onClick={async () => {
              await post(`/api/servers/${server.id}/refresh`).catch(() => undefined);
              void qc.invalidateQueries({ queryKey: ["server", server.id] });
              void qc.invalidateQueries({ queryKey: ["rpc", server.id] });
            }}>Try Again</Button>
          </div>
        )}
      />
    </div>
  );
}

/**
 * Segmented view switcher (the macOS tab-view look): sits under a page header or at the top of a sheet.
 * Items may carry an error marker (a red dot) so a sheet can point at the tab with invalid fields.
 */
export function ViewSwitcher<V extends string>({ value, onChange, items, testId, fullWidth }: {
  value: V; onChange: (v: V) => void; testId?: string; fullWidth?: boolean;
  items: { value: V; label: ReactNode; disabled?: boolean; alert?: boolean; testId?: string }[];
}) {
  return (
    <div className="hpn-switcher" data-full={fullWidth || undefined}>
      <SegmentedControl
        value={value}
        onChange={(v) => onChange(v as V)}
        fullWidth={fullWidth}
        data-testid={testId}
        data={items.map((it) => ({
          value: it.value,
          disabled: it.disabled,
          label: (
            <span className="hpn-seg-label" data-testid={it.testId}>
              {it.label}
              {it.alert && <span className="hpn-seg-alert" role="img" aria-label="has errors" />}
            </span>
          ),
        }))}
      />
    </div>
  );
}

/** Inline group of controls inside a FormRow (address + mask, port from/to…). */
export function Fields({ children, cols }: { children: ReactNode; cols?: string }) {
  return <div className="hpn-fields" style={cols ? { gridTemplateColumns: cols } : undefined}>{children}</div>;
}

/** Small caption under a control group. */
export function Hint({ children }: { children: ReactNode }) {
  return <div className="hpn-hint">{children}</div>;
}
