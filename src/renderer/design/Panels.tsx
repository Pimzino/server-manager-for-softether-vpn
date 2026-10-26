// Overlays: Sheet (modal task dialog that slides from the toolbar, like a macOS sheet) and
// Inspector (non-modal detail panel docked on the right of the content).
import { useEffect, useRef, type ReactNode } from "react";
import { ActionIcon, Modal, Portal } from "@mantine/core";
import { IconX } from "@tabler/icons-react";

/**
 * Modal task dialog: add/edit forms, multi-step flows. Title in the header, content scrolls,
 * footer holds the buttons (secondary left of primary, primary rightmost). Esc cancels.
 */
export function Sheet({ opened, onClose, title, subtitle, icon, children, footer, size = 560, testId, closeOnClickOutside = false, busy }: {
  opened: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; children: ReactNode; footer?: ReactNode;
  size?: number | string; testId?: string; closeOnClickOutside?: boolean;
  /** Prevents closing (Esc, overlay) while an operation runs. */
  busy?: boolean;
}) {
  return (
    <Modal
      opened={opened}
      onClose={() => { if (!busy) onClose(); }}
      size={size}
      withCloseButton={false}
      closeOnClickOutside={closeOnClickOutside && !busy}
      closeOnEscape={!busy}
      yOffset="calc(var(--sem-toolbar-h) - 6px)"
      transitionProps={{ transition: "slide-down", duration: 200, timingFunction: "cubic-bezier(0.2, 0, 0, 1)" }}
      padding={0}
      classNames={{ content: "sem-sheet", body: "sem-sheet-body-wrap", inner: "sem-sheet-inner" }}
      overlayProps={{ backgroundOpacity: 0.18, blur: 0 }}
      data-testid={testId}
      aria-label={typeof title === "string" ? title : undefined}
    >
      <div className="sem-sheet-head">
        {icon && <div className="sem-sheet-icon">{icon}</div>}
        <div className="sem-sheet-titles">
          <h2 className="sem-sheet-title">{title}</h2>
          {subtitle && <div className="sem-sheet-subtitle">{subtitle}</div>}
        </div>
      </div>
      <div className="sem-sheet-body">{children}</div>
      {footer && <div className="sem-sheet-footer">{footer}</div>}
    </Modal>
  );
}

/**
 * True while a dialog, sheet, menu or dropdown is actually showing: Esc belongs to it, not to the Inspector.
 * Mantine keeps a closed Modal's root element mounted (every page with a Sheet, and the confirmation-dialog
 * manager after its first use), so the root's presence says nothing; only the content/dropdown elements do,
 * and they exist only while open (or animating closed after the same keypress).
 */
export function overlayOpen(): boolean {
  const els = document.querySelectorAll<HTMLElement>(
    ".mantine-Modal-content, .mantine-Menu-dropdown, .mantine-Popover-dropdown, .mantine-Combobox-dropdown, [role='dialog'][aria-modal='true']",
  );
  for (const el of els) {
    if (el.closest(".sem-inspector")) continue;
    if (typeof el.checkVisibility === "function" ? el.checkVisibility() : el.offsetParent !== null) return true;
  }
  return false;
}

/**
 * Detail panel for the selected row of a table (session details, user properties…). Non-modal:
 * the table stays usable, selecting another row swaps the content. Esc or the close button hides it.
 */
export function Inspector({ opened, onClose, title, subtitle, icon, actions, children, width, testId }: {
  opened: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; actions?: ReactNode;
  children: ReactNode; width?: number; testId?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!opened) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || overlayOpen()) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.({ preventScroll: true }); };
  }, [opened, onClose]);
  return (
    <Portal>
      <aside
        ref={ref}
        className="sem-inspector"
        data-open={opened || undefined}
        aria-hidden={!opened}
        role="complementary"
        aria-label={typeof title === "string" ? title : "Details"}
        tabIndex={-1}
        style={width ? { ["--sem-inspector-w" as string]: `${width}px` } : undefined}
        data-testid={testId}
      >
        {opened && (
          <>
            <div className="sem-inspector-head">
              {icon && <div className="sem-inspector-icon">{icon}</div>}
              <div className="sem-inspector-titles">
                <div className="sem-inspector-title">{title}</div>
                {subtitle && <div className="sem-inspector-subtitle">{subtitle}</div>}
              </div>
              <ActionIcon variant="subtle" color="gray" onClick={onClose} aria-label="Close details" data-testid="inspector-close"><IconX size={15} /></ActionIcon>
            </div>
            {actions && <div className="sem-inspector-actions">{actions}</div>}
            <div className="sem-inspector-body">{children}</div>
          </>
        )}
      </aside>
    </Portal>
  );
}
