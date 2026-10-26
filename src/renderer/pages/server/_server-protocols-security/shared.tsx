// Helpers shared by the server Protocols / IPsec / WireGuard / Certificate / Security / License / Caps pages.
// Built only from design tokens and design-system classes; the few things the design system doesn't have
// (a multi-line code block, a port chip list) are defined here.
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Anchor, Button } from "@mantine/core";
import { IconPlugConnectedX, IconRefresh, IconStack2 } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../../../lib/api";
import { agoShort } from "../../../lib/format";
import { useRpc, useScope, useServer } from "../../../lib/hooks";
import { serverBase } from "../../../sections";
import { CopyButton, EmptyState } from "../../../design";
import { Callout } from "../../../components/domain/ui";

/** Route scope + connection facts for a server page. Queries should be gated on `ready`. */
export function useServerPage() {
  const { serverId } = useScope();
  const server = useServer(serverId);
  const s = server.data;
  const reachable = s?.state?.ok !== false;
  const hubMode = !!s?.hub;
  return { serverId, server, s, reachable, hubMode, ready: !!s && reachable };
}

/** One explanation instead of a failing RPC per section when the background poll says the server is down. */
export function Unreachable({ serverId, name, error, checkedAt }: { serverId: number; name: string; error?: string | null; checkedAt?: number | null }) {
  const qc = useQueryClient();
  return (
    <div className="sem-unreachable" data-testid="page-unreachable">
      <EmptyState
        icon={<IconPlugConnectedX size={30} stroke={1.4} />}
        title={<>Can’t reach {name}</>}
        description={<><span style={{ overflowWrap: "anywhere" }}>{error ?? "The last status check failed."}</span><br /><span className="sem-dim">Last checked {agoShort(checkedAt)}.</span></>}
        action={(
          <Button leftSection={<IconRefresh size={14} />} onClick={async () => {
            await post(`/api/servers/${serverId}/refresh`).catch(() => undefined);
            void qc.invalidateQueries({ queryKey: ["server", serverId] });
            void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
          }}>Try Again</Button>
        )}
      />
    </div>
  );
}

/** Server-wide page opened on a hub-admin connection: SoftEther refuses these RPCs with the hub's password. */
export function HubModeNotice({ hub, what }: { hub: string; what: string }) {
  return (
    <Callout tone="purple" icon={<IconStack2 size={16} stroke={1.7} />} title="Hub administrator connection" testId="hub-mode-notice">
      This connection uses the password of the Virtual Hub “{hub}”, so {what} Connect with the server administrator password to manage it.
    </Callout>
  );
}

/** Multi-line monospace block with a copy button (PEM, configuration templates). */
export function CodeBlock({ code, testId, maxHeight = 260, label }: { code: string; testId?: string; maxHeight?: number; label?: string }) {
  return (
    <div style={{ position: "relative" }}>
      <pre
        className="sem-mono"
        data-testid={testId}
        style={{
          margin: 0, padding: "var(--sem-space-5) var(--sem-space-9) var(--sem-space-5) var(--sem-space-5)", maxHeight, overflow: "auto",
          background: "var(--sem-bg-code)", border: "0.5px solid var(--sem-separator)", borderRadius: "var(--sem-radius-md)",
          fontSize: "var(--sem-fz-small)", lineHeight: 1.5, color: "var(--sem-text)", whiteSpace: "pre", userSelect: "text",
        }}
      >{code}</pre>
      <span style={{ position: "absolute", top: "var(--sem-space-2)", right: "var(--sem-space-2)" }}>
        <CopyButton value={code} label={label ?? "Copy"} testId={testId ? `${testId}-copy` : undefined} />
      </span>
    </div>
  );
}

/** The server-wide UDP ports (GetPortsUDP) as chips with a link to Listeners & Ports. */
export function UdpPorts({ serverId, enabled = true, testId }: { serverId: number; enabled?: boolean; testId?: string }) {
  const udp = useRpc<{ Ports_u32?: number[] }>(serverId, "GetPortsUDP", {}, { retry: false, enabled });
  const ports = udp.data?.Ports_u32 ?? [];
  return (
    <span className="sem-port-row" data-testid={testId}>
      {udp.isLoading ? <span className="sem-dim">Loading…</span>
        : udp.error ? <span className="sem-dim">Not reported by this server</span>
        : ports.length ? <span className="sem-chips">{ports.map((p) => <span key={p} className="sem-chip" style={{ display: "inline-flex", alignItems: "center" }}>{p}</span>)}</span>
        : <span className="sem-dim">None</span>}
      <Anchor component={Link} to={`${serverBase(serverId)}/listeners`} size="sm">Listeners & Ports…</Anchor>
    </span>
  );
}

/** A compact bulleted list in secondary text (notes under a section). */
export function Notes({ children }: { children: ReactNode[] }) {
  return (
    <ul className="sem-dim" style={{ margin: 0, paddingLeft: "var(--sem-space-7)", display: "flex", flexDirection: "column", gap: "var(--sem-space-2)" }}>
      {children.map((c, i) => <li key={i}>{c}</li>)}
    </ul>
  );
}

/** File-name friendly version of a connection or certificate name. */
export const safeName = (s: string) => s.replace(/[^\w.-]/g, "_");
