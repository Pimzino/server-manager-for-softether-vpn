// Toolbar controls: icon buttons with tooltips and shortcuts, grouped like native toolbar items.
// Used in the window toolbar and in page headers / table toolbars.
import { forwardRef, type ReactNode } from "react";
import { Tooltip, UnstyledButton } from "@mantine/core";
import { Shortcut } from "./Layout";

export interface ToolbarButtonProps {
  icon: ReactNode;
  /** Accessible name and tooltip text. Also shown next to the icon when showLabel is set. */
  label: string;
  onClick?: () => void;
  shortcut?: string[];
  active?: boolean;
  disabled?: boolean;
  showLabel?: boolean;
  tone?: "default" | "danger" | "accent";
  testId?: string;
}

export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(function ToolbarButton(
  { icon, label, onClick, shortcut, active, disabled, showLabel, tone = "default", testId, ...rest }, ref,
) {
  const btn = (
    <UnstyledButton
      ref={ref}
      className="sem-tb-btn"
      data-active={active || undefined}
      data-labelled={showLabel || undefined}
      data-tone={tone}
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      data-testid={testId}
      {...rest}
    >
      {icon}
      {showLabel && <span className="sem-tb-label">{label}</span>}
    </UnstyledButton>
  );
  if (showLabel && !shortcut) return btn;
  return (
    <Tooltip label={<span className="sem-tip">{label}{shortcut && <Shortcut keys={shortcut} />}</span>} openDelay={450}>
      {btn}
    </Tooltip>
  );
});

/** Visually groups related toolbar buttons (e.g. back/forward). */
export function ToolbarGroup({ children, label }: { children: ReactNode; label?: string }) {
  return <div className="sem-tb-group" role="group" aria-label={label}>{children}</div>;
}

export function ToolbarSeparator() {
  return <div className="sem-tb-sep" aria-hidden />;
}

export function ToolbarSpacer() {
  return <div className="sem-tb-spacer" />;
}
