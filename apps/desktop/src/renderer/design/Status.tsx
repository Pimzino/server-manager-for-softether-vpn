// Status indicators: StatusDot (a coloured dot), StatusBadge (dot + label pill), Tag (neutral label).
import type { ReactNode } from "react";
import { Tooltip } from "@mantine/core";
import type { Server } from "../lib/types";

export type Status = "ok" | "error" | "warning" | "off" | "unknown" | "locked" | "busy";
export type TagColor = "gray" | "accent" | "green" | "red" | "orange" | "yellow" | "purple" | "teal";

const STATUS_COLOR: Record<Status, string> = {
  ok: "green", error: "red", warning: "orange", off: "gray", unknown: "gray", locked: "yellow", busy: "accent",
};

/** 8 px dot. Always pair it with text (a label, tooltip or aria-label): colour alone carries no meaning. */
export function StatusDot({ status, label, size = 8, tooltip }: { status: Status; label?: string; size?: number; tooltip?: ReactNode }) {
  const dot = (
    <span
      className="sem-dot"
      data-color={STATUS_COLOR[status]}
      data-status={status}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size }}
    />
  );
  return tooltip ? <Tooltip label={tooltip}>{dot}</Tooltip> : dot;
}

/** Dot + label, for table cells and headers ("Online", "Offline", "Stopped"…). */
export function StatusBadge({ status, children, tooltip, testId }: { status: Status; children: ReactNode; tooltip?: ReactNode; testId?: string }) {
  const el = (
    <span className="sem-status" data-color={STATUS_COLOR[status]} data-testid={testId}>
      <span className="sem-dot" data-color={STATUS_COLOR[status]} data-status={status} aria-hidden />
      {children}
    </span>
  );
  return tooltip ? <Tooltip label={tooltip} multiline maw={360}>{el}</Tooltip> : el;
}

/** Online/offline shorthand compatible with the web product's OnlineBadge. */
export function OnlineBadge({ online, onLabel = "Online", offLabel = "Offline" }: { online: boolean | null | undefined; onLabel?: string; offLabel?: string }) {
  if (online === null || online === undefined) return <StatusBadge status="unknown">Unknown</StatusBadge>;
  return <StatusBadge status={online ? "ok" : "error"}>{online ? onLabel : offLabel}</StatusBadge>;
}

/** Small rounded label: roles, modes, counts, tags. Quiet by default. */
export function Tag({ children, color = "gray", variant = "soft", icon, title, testId }: {
  children: ReactNode; color?: TagColor; variant?: "soft" | "outline" | "solid"; icon?: ReactNode; title?: string; testId?: string;
}) {
  return (
    <span className="sem-tag" data-color={color} data-variant={variant} title={title} data-testid={testId}>
      {icon}
      {children}
    </span>
  );
}

/** Derived status of a saved connection, used by the sidebar, fleet table and headers. */
export function serverStatus(s: Pick<Server, "enabled" | "unlocked" | "passwordSaved" | "state">): { status: Status; label: string; detail?: string } {
  if (!s.enabled) return { status: "off", label: "Disabled" };
  if (!s.unlocked && !s.passwordSaved) return { status: "locked", label: "Locked", detail: "Enter the administrator password to connect." };
  if (!s.state || s.state.ok === null) return { status: "unknown", label: "Connecting…" };
  if (s.state.ok) return { status: "ok", label: "Online", detail: s.state.latencyMs != null ? `${s.state.latencyMs} ms` : undefined };
  return { status: "error", label: "Offline", detail: s.state.error ?? undefined };
}
