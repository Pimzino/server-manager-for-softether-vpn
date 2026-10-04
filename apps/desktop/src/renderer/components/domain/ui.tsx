// Small presentational helpers shared by server and hub pages that the design system doesn't cover:
// HelpLabel / HelpTip (catalog docs in a tooltip), SecretText (masked secret with reveal), NotApplicable
// (friendly "not supported" state), Callout (inline notice in any tone), Disclosure (collapsible group),
// SaveBar (sticky save bar that keeps the web product's test ids) and AuthTag.
//
// Everything is built from design tokens and the design system's own classes; nothing here hard-codes colours.
import { useState, type CSSProperties, type ReactNode } from "react";
import { ActionIcon, Button, Collapse, Group, Tooltip, UnstyledButton } from "@mantine/core";
import {
  IconAlertTriangle, IconChevronRight, IconCircleCheck, IconEye, IconEyeOff, IconInfoCircle, IconInfoSquareRounded,
} from "@tabler/icons-react";
import { ApiError } from "../../lib/api";
import { CopyField, ErrorState, Tag } from "../../design";
import { authLabel } from "./util";

/** Label followed by an info icon whose tooltip carries the catalog documentation. */
export function HelpLabel({ label, doc }: { label: ReactNode; doc?: string }) {
  if (!doc) return <>{label}</>;
  return (
    <span className="sem-row-inline" style={{ gap: "var(--sem-space-2)", flexWrap: "nowrap" }}>
      <span>{label}</span>
      <Tooltip label={doc} multiline maw={380} withArrow openDelay={250}>
        <span className="sem-dim" role="img" aria-label={`About ${typeof label === "string" ? label : "this setting"}`} style={{ display: "inline-flex", cursor: "help" }}>
          <IconInfoCircle size={13} stroke={1.6} />
        </span>
      </Tooltip>
    </span>
  );
}

/** Wrap anything in a multi-line tooltip; renders the children alone when there is no label. (server-a/shared) */
export function HelpTip({ label, children }: { label?: string; children: ReactNode }) {
  if (!label) return <>{children}</>;
  return <Tooltip label={label} multiline maw={340} withArrow><span>{children}</span></Tooltip>;
}

/** Masked secret with a reveal toggle and, once revealed, a copy button. */
export function SecretText({ value, canReveal = true, testId }: { value: string; canReveal?: boolean; testId?: string }) {
  const [shown, setShown] = useState(false);
  if (!value) return <span className="sem-dim">Not set</span>;
  return (
    <span className="sem-row-inline" style={{ flexWrap: "nowrap", gap: "var(--sem-space-2)" }} data-testid={testId}>
      {shown ? <CopyField value={value} /> : <span className="sem-mono" aria-label="Hidden secret">{"•".repeat(Math.min(24, Math.max(8, value.length)))}</span>}
      {canReveal && (
        <Tooltip label={shown ? "Hide" : "Show"} openDelay={300}>
          <ActionIcon variant="subtle" color="gray" size={22} onClick={() => setShown((s) => !s)} aria-label={shown ? "Hide secret" : "Show secret"}
            data-testid={testId ? `${testId}-reveal` : undefined}>
            {shown ? <IconEyeOff size={14} stroke={1.6} /> : <IconEye size={14} stroke={1.6} />}
          </ActionIcon>
        </Tooltip>
      )}
    </span>
  );
}

/**
 * SoftEther said the feature doesn't exist on this server: error 33 (not supported on this edition / OS)
 * or 147 (not available in the open-source build).
 */
export function isUnsupported(e: unknown) {
  return e instanceof ApiError && (e.softEtherCode === 33 || e.softEtherCode === 147);
}

/** Friendly grey notice for unsupported features; any other error falls back to an inline ErrorState. */
export function NotApplicable({ error, title, children, onRetry, testId }: {
  error: unknown; title: ReactNode; children: ReactNode; onRetry?: () => void; testId?: string;
}) {
  if (!isUnsupported(error)) return <ErrorState error={error} inline onRetry={onRetry} />;
  const code = (error as ApiError).softEtherCode;
  return (
    <Callout tone="gray" icon={<IconInfoSquareRounded size={16} stroke={1.7} />} title={title} testId={testId ?? "not-applicable"}>
      {children}
      <div className="sem-callout-detail">The server answered with SoftEther error {code} ({code === 147 ? "not available in the open-source edition" : "not supported"}).</div>
    </Callout>
  );
}

export type CalloutTone = "red" | "yellow" | "orange" | "purple" | "gray" | "green" | "accent";

// Tones the design system's .sem-callout doesn't define are painted with tokens here.
const EXTRA_TONES: Partial<Record<CalloutTone, string>> = {
  green: "var(--sem-green-soft)", accent: "var(--sem-accent-soft)", orange: "var(--sem-orange-soft)",
};
// Icon colours, as .sem-callout paints them (its rule only reaches direct <svg> children).
const ICON_COLOR: Record<CalloutTone, string> = {
  red: "var(--sem-red)", yellow: "var(--sem-orange)", orange: "var(--sem-orange)", purple: "var(--sem-purple)",
  gray: "var(--sem-gray)", green: "var(--sem-green)", accent: "var(--sem-accent)",
};

const DEFAULT_ICON: Record<CalloutTone, ReactNode> = {
  red: <IconAlertTriangle size={16} stroke={1.7} />, yellow: <IconAlertTriangle size={16} stroke={1.7} />, orange: <IconAlertTriangle size={16} stroke={1.7} />,
  purple: <IconInfoCircle size={16} stroke={1.7} />, gray: <IconInfoCircle size={16} stroke={1.7} />, green: <IconCircleCheck size={16} stroke={1.7} />,
  accent: <IconInfoCircle size={16} stroke={1.7} />,
};

/**
 * Inline notice (the design system's `.sem-callout`), for informational or warning text that belongs to a
 * section: replaces the web's coloured Mantine `Alert`s that were not errors. Errors use ErrorState.
 */
export function Callout({ tone = "gray", icon, title, children, action, testId }: {
  tone?: CalloutTone; icon?: ReactNode; title?: ReactNode; children?: ReactNode; action?: ReactNode; testId?: string;
}) {
  const extra = EXTRA_TONES[tone];
  const style: CSSProperties = { alignItems: title || children ? "flex-start" : "center" };
  if (extra) style.background = extra;
  return (
    <div className="sem-callout" data-tone={extra ? undefined : tone} style={style} role={tone === "red" ? "alert" : "note"} data-testid={testId}>
      <span style={{ display: "inline-flex", flex: "none", marginTop: title || children ? 1 : 0, color: ICON_COLOR[tone] }}>
        {icon ?? DEFAULT_ICON[tone]}
      </span>
      <div className="sem-callout-text">
        {title && <div className="sem-strong">{title}</div>}
        {children && <div style={{ marginTop: title ? 2 : 0 }}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

/** Collapsible group with a disclosure triangle (like "Advanced" in the connection sheet). */
export function Disclosure({ label, children, defaultOpen = false, badge, testId }: {
  label: ReactNode; children: ReactNode; defaultOpen?: boolean; badge?: ReactNode; testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <UnstyledButton className="sem-disclosure" data-open={open || undefined} onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid={testId}>
        <IconChevronRight size={12} stroke={2.2} /> {label} {badge}
      </UnstyledButton>
      <Collapse expanded={open}>{children}</Collapse>
    </div>
  );
}

/**
 * Sticky save bar for settings pages (hub-a/shared SaveBar). Same look as the design system's FormActions,
 * but keeps the web product's test ids: `${testId}` on Save and `${testId}-reset` on Revert.
 */
export function SaveBar({ dirty, saving, onSave, onReset, disabled, saveLabel = "Save", testId = "save", note }: {
  dirty: boolean; saving?: boolean; onSave: () => void; onReset: () => void; disabled?: boolean; saveLabel?: string; testId?: string; note?: ReactNode;
}) {
  return (
    <div className="sem-form-actions" data-dirty={dirty || undefined}>
      <span className="sem-form-actions-note">{dirty ? (note ?? "You have unsaved changes.") : null}</span>
      <Group gap={8}>
        <Button variant="default" disabled={!dirty || saving} onClick={onReset} data-testid={`${testId}-reset`}>Revert</Button>
        <Button disabled={!dirty || disabled} loading={saving} onClick={onSave} data-testid={testId}>{saveLabel}</Button>
      </Group>
    </div>
  );
}

/** User authentication type (AuthType_u32) as a Tag. */
export function AuthTag({ type, long }: { type: number; long?: boolean }) {
  const a = authLabel(type);
  return <Tag color={a?.color ?? "gray"}>{a ? (long ? a.label : a.short) : `Type ${type}`}</Tag>;
}

/** "Yes" / "No" for boolean properties; "No" in secondary colour. */
export function YesNo({ value }: { value: unknown }) {
  return value ? <span>Yes</span> : <span className="sem-dim">No</span>;
}
