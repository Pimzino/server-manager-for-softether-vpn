// Forms in the System Settings style: grouped boxes (FormSection) of label/control rows (FormRow),
// with a save bar (FormActions) that appears when there are unsaved changes.
import { useId, type ReactNode } from "react";
import { Button, Group } from "@mantine/core";

export function FormSection({ title, description, children, footer, testId }: {
  title?: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; testId?: string;
}) {
  return (
    <fieldset className="sem-form-section" data-testid={testId}>
      {title && <legend className="sem-form-section-title">{title}</legend>}
      {description && <p className="sem-form-section-description">{description}</p>}
      <div className="sem-form-box">{children}</div>
      {footer && <div className="sem-form-section-footer">{footer}</div>}
    </fieldset>
  );
}

/**
 * One setting: label (+ description) on the left, control on the right.
 * `stacked` puts the control under the label (textareas, tables, long selects).
 * Give the control no label of its own; pass `htmlFor`/`id` or wrap a Mantine input — FormRow
 * passes its id to the first control through the render function form: children(id).
 */
export function FormRow({ label, description, children, stacked, align = "center", testId, error }: {
  label: ReactNode; description?: ReactNode; children: ReactNode | ((id: string) => ReactNode);
  stacked?: boolean; align?: "center" | "start"; testId?: string; error?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="sem-form-row" data-stacked={stacked || undefined} data-align={align} data-testid={testId}>
      <div className="sem-form-row-label">
        <label htmlFor={id}>{label}</label>
        {description && <div className="sem-form-row-description">{description}</div>}
      </div>
      <div className="sem-form-row-control">
        {typeof children === "function" ? children(id) : children}
        {error && <div className="sem-form-row-error">{error}</div>}
      </div>
    </div>
  );
}

/**
 * Save bar for editable pages. Sticks to the bottom of the page while there are changes.
 * Discard reverts, Save applies. Keyboard: Cmd/Ctrl+S is wired by pages that want it.
 */
export function FormActions({ dirty, valid = true, saving, onSave, onDiscard, saveLabel = "Save", note, testId }: {
  dirty: boolean; valid?: boolean; saving?: boolean; onSave: () => void; onDiscard?: () => void; saveLabel?: string; note?: ReactNode; testId?: string;
}) {
  return (
    <div className="sem-form-actions" data-dirty={dirty || undefined} data-testid={testId}>
      <span className="sem-form-actions-note">{dirty ? (note ?? "You have unsaved changes.") : null}</span>
      <Group gap={8}>
        {onDiscard && <Button variant="default" disabled={!dirty || saving} onClick={onDiscard}>Revert</Button>}
        <Button disabled={!dirty || !valid} loading={saving} onClick={onSave} data-testid={testId ? `${testId}-save` : undefined}>{saveLabel}</Button>
      </Group>
    </div>
  );
}
