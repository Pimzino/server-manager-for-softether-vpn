// Helpers shared by the hub-core pages (Status, Properties, Options, Client Message, RADIUS, Certificates, Logging).
// Kept local to these pages: nothing here is part of the design system or the shared domain components.
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@mantine/core";
import { IconPlugConnectedX, IconRefresh } from "@tabler/icons-react";
import { post } from "../../../lib/api";
import { agoShort } from "../../../lib/format";
import { useHubAccess } from "../../../components/domain/hooks";
import { EmptyState, useShell } from "../../../design";

/**
 * Scope of a hub page plus reachability. `ready` is true when the connection is known and its last status
 * check didn't fail: pages gate their RPCs on it so a server that is down shows one explanation instead of
 * one failing call per section (design guide §8).
 */
export function useHubPage() {
  const access = useHubAccess();
  const s = access.server.data;
  const reachable = s?.state?.ok !== false;
  return { ...access, reachable, ready: !!s && reachable && !!access.hub };
}

/** "Can’t reach …" state with Edit Connection… and Try Again, shown instead of the page body. */
export function HubUnreachable({ serverId }: { serverId: number }) {
  const { server } = useHubAccess();
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

/** Small uppercase-free caption line under a control (character counters, units). */
export function Caption({ children, tone, testId }: { children: ReactNode; tone?: "red" | "orange"; testId?: string }) {
  return (
    <div className="sem-form-row-description" data-testid={testId} style={tone ? { color: `var(--sem-${tone})` } : undefined}>
      {children}
    </div>
  );
}

/** Stable JSON comparison for "is the form dirty" checks. */
export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
