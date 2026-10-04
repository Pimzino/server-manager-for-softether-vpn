// Empty, loading and error states. Every data view shows exactly one of: skeleton, error, empty, content.
import type { ReactNode } from "react";
import { Button, Group, Loader, Skeleton } from "@mantine/core";
import { IconAlertTriangle, IconCloudOff, IconLock, IconPlugConnectedX, IconRefresh, IconShieldExclamation } from "@tabler/icons-react";
import { ApiError } from "../lib/api";
import { useShell } from "./shellContext";
import { CopyField } from "./CopyField";

/** Centred placeholder for "nothing here yet". Title states the fact, description says what to do. */
export function EmptyState({ icon, title, description, action, compact, testId }: {
  icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; compact?: boolean; testId?: string;
}) {
  return (
    <div className="sem-empty" data-compact={compact || undefined} data-testid={testId}>
      {icon && <div className="sem-empty-icon">{icon}</div>}
      <div className="sem-empty-title">{title}</div>
      {description && <div className="sem-empty-description">{description}</div>}
      {action && <div className="sem-empty-action">{action}</div>}
    </div>
  );
}

/** Web-product compatible alias: <Empty>No rows</Empty>. */
export function Empty({ children }: { children: ReactNode }) {
  return <EmptyState compact title={children} />;
}

/** Inline spinner with optional text. Prefer skeletons for content that has a known shape. */
export function LoadingState({ label, compact }: { label?: ReactNode; compact?: boolean }) {
  return (
    <div className="sem-loading" data-compact={compact || undefined} role="status" aria-live="polite">
      <Loader size={compact ? 14 : 18} />
      {label && <span>{label}</span>}
    </div>
  );
}

export function TableSkeleton({ rows = 6, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="sem-skeleton-table" aria-busy="true" aria-label="Loading">
      <div className="sem-skeleton-row" data-head>{Array.from({ length: columns }, (_, i) => <Skeleton key={i} height={9} width={`${40 + ((i * 17) % 40)}%`} />)}</div>
      {Array.from({ length: rows }, (_, r) => (
        <div className="sem-skeleton-row" key={r}>
          {Array.from({ length: columns }, (_, i) => <Skeleton key={i} height={10} width={`${50 + (((r + 1) * (i + 3) * 13) % 45)}%`} />)}
        </div>
      ))}
    </div>
  );
}

export function PropertySkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="sem-skeleton-props" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sem-skeleton-prop"><Skeleton height={10} width={120} /><Skeleton height={10} width={`${35 + ((i * 23) % 40)}%`} /></div>
      ))}
    </div>
  );
}

export function MetricSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="sem-metrics" aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <div className="sem-metric" key={i}><Skeleton height={9} width={70} /><Skeleton height={20} width={60} mt={8} /></div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const CODE_TITLES: Record<number, string> = {
  1: "Couldn’t connect to the server", 8: "Virtual Hub not found", 9: "Authentication failed", 10: "The Virtual Hub is stopped",
  12: "Access denied", 29: "Not found", 33: "Not supported by this server", 38: "Invalid parameter", 45: "Invalid value",
  52: "Not enough privileges", 53: "Listener not found", 54: "A listener already uses this port", 57: "A hub with this name already exists",
  59: "A cascade with this name already exists", 66: "A user with this name already exists", 67: "A group with this name already exists",
  84: "Local bridge isn’t available on this server", 112: "Already exists", 147: "Not available in the open-source edition",
};

const KIND_TITLES: Record<string, string> = {
  "tls-mismatch": "The server’s certificate changed", tls: "The certificate couldn’t be verified", network: "Can’t reach the server",
  timeout: "The server didn’t respond", auth: "The password was rejected", http: "Unexpected response", protocol: "Unexpected response",
  "api-disabled": "The JSON-RPC API is turned off",
};

export const KIND_HELP: Record<string, string> = {
  "tls-mismatch": "The server presented a different certificate from the one you trusted. This is expected after the certificate was replaced, but it can also mean someone is intercepting the connection. Compare the new fingerprint with the one shown on the server before trusting it.",
  tls: "Check that the CA certificate issued the server’s certificate and that the host name matches it.",
  network: "Check the host name, the port, firewalls, and that the SoftEther listener is running.",
  timeout: "The server may be overloaded, or a firewall is silently dropping the connection.",
  auth: "Check the administrator password. In hub-admin mode, check the hub name and the hub’s own administrator password.",
  http: "Something answered on this port, but it isn’t a SoftEther VPN Server listener.",
  protocol: "Something answered on this port, but it isn’t a SoftEther VPN Server listener.",
  "api-disabled": "This server has its JSON-RPC web API disabled. Switch the connection’s transport to Native, which uses the same administration protocol as SoftEther’s Server Manager and vpncmd.",
};

/** Title + explanation for any error thrown by lib/api. */
export function describeError(error: unknown): { title: string; message: string; code?: number; kind?: string; locked?: boolean; unsupported?: boolean } {
  if (error instanceof ApiError) {
    const code = error.softEtherCode;
    if (error.locked) return { title: "Password required", message: "This connection has no saved password. Enter it to continue.", locked: true };
    if (code !== undefined) return { title: CODE_TITLES[code] ?? "The server refused the request", message: error.message, code, unsupported: code === 33 || code === 147 };
    if (error.kind) return { title: KIND_TITLES[error.kind] ?? "Connection failed", message: error.message, kind: error.kind };
    if (error.status === 404) return { title: "Not found", message: error.message };
    return { title: "Request failed", message: error.message };
  }
  return { title: "Something went wrong", message: error instanceof Error ? error.message : String(error) };
}

/**
 * Error panel. SoftEther error codes get a friendly title plus the server's own text and the code;
 * connection failures get an explanation; locked servers get an Unlock button.
 * `inline` renders a compact banner for use inside sections.
 */
export function ErrorState({ error, onRetry, serverId, inline, testId, onTrust }: {
  error: unknown; onRetry?: () => void; serverId?: number; inline?: boolean; testId?: string;
  /** When the certificate changed: called with the presented fingerprint to re-pin. */
  onTrust?: (fingerprint: string) => void;
}) {
  const shell = useShell();
  const d = describeError(error);
  const presented = error instanceof ApiError ? error.presentedFingerprint : undefined;
  const lockedId = d.locked ? serverId ?? Number(window.location.hash.match(/#\/servers\/(\d+)/)?.[1]) : undefined;
  const Icon = d.locked ? IconLock : d.kind === "tls-mismatch" || d.kind === "tls" ? IconShieldExclamation
    : d.kind ? IconPlugConnectedX : d.unsupported ? IconCloudOff : IconAlertTriangle;
  const tone = d.unsupported ? "gray" : d.locked ? "yellow" : d.kind === "tls-mismatch" ? "orange" : "red";
  return (
    <div className="sem-error" data-inline={inline || undefined} data-tone={tone} role="alert" data-testid={testId ?? "error-state"}>
      <div className="sem-error-icon"><Icon size={inline ? 16 : 22} stroke={1.6} /></div>
      <div className="sem-error-body">
        <div className="sem-error-title">{d.title}</div>
        <div className="sem-error-message">{d.message}</div>
        {d.kind && KIND_HELP[d.kind] && <div className="sem-error-help">{KIND_HELP[d.kind]}</div>}
        {presented && (
          <div className="sem-error-fp"><span className="sem-dim">Presented certificate</span><CopyField value={presented} mono size="sm" /></div>
        )}
        {d.code !== undefined && <div className="sem-error-code">SoftEther error {d.code}</div>}
        {(onRetry || (d.locked && lockedId) || (presented && onTrust)) && (
          <Group gap={8} mt={10}>
            {d.locked && lockedId !== undefined && Number.isFinite(lockedId) && (
              <Button size="xs" leftSection={<IconLock size={14} />} onClick={() => shell.openUnlock(lockedId)} data-testid="error-unlock">Unlock…</Button>
            )}
            {presented && onTrust && <Button size="xs" color="orange" onClick={() => onTrust(presented)} data-testid="trust-presented">Trust New Certificate…</Button>}
            {onRetry && <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={onRetry}>Try Again</Button>}
          </Group>
        )}
      </div>
    </div>
  );
}

/** Web-product compatible alias. */
export function ErrorAlert({ error }: { error: unknown }) {
  return <ErrorState error={error} inline />;
}

/**
 * Loading / error wrapper for a query-like object. Shows `skeleton` (default: spinner) while loading,
 * ErrorState on error (with Try Again), else children.
 */
export function QueryState({ query, children, skeleton, inline }: {
  query: { isLoading: boolean; error: unknown; refetch?: () => unknown }; children: ReactNode; skeleton?: ReactNode; inline?: boolean;
}) {
  if (query.isLoading) return <>{skeleton ?? <LoadingState compact />}</>;
  if (query.error) return <ErrorState error={query.error} inline={inline} onRetry={query.refetch ? () => void query.refetch!() : undefined} />;
  return <>{children}</>;
}
