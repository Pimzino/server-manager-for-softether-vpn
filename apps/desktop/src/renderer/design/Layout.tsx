// Page-level layout primitives: Page, PageHeader, Section, SectionGrid, PropertyList/KeyValue, Metric/MetricGrid.
import type { CSSProperties, ReactNode } from "react";
import { Tooltip } from "@mantine/core";

/** Scrollable page body with standard padding. Every routed page renders inside one (the scope layouts provide it). */
export function Page({ children, width = "regular", testId }: { children: ReactNode; width?: "regular" | "wide" | "narrow" | "full"; testId?: string }) {
  return <div className="sem-page" data-width={width} data-testid={testId}>{children}</div>;
}

/**
 * Title block at the top of a page. `actions` are toolbar-style buttons aligned right
 * (primary action last). Keep `description` to one sentence.
 */
export function PageHeader({ title, description, actions, badge, icon, meta, testId }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; badge?: ReactNode; icon?: ReactNode;
  /** Small secondary line under the title (host:port, counts…) */
  meta?: ReactNode; testId?: string;
}) {
  return (
    <header className="sem-page-header" data-testid={testId}>
      {icon && <div className="sem-page-header-icon">{icon}</div>}
      <div className="sem-page-header-text">
        <div className="sem-page-header-title-row">
          <h1 className="sem-page-title">{title}</h1>
          {badge}
        </div>
        {meta && <div className="sem-page-meta">{meta}</div>}
        {description && <p className="sem-page-description">{description}</p>}
      </div>
      {actions && <div className="sem-page-actions">{actions}</div>}
    </header>
  );
}

/**
 * A titled block of content, separated from the previous one by space and a hairline — not a card.
 * variant "inset" draws a grouped box (System Settings style) around the children.
 */
export function Section({ title, description, actions, children, variant = "plain", testId, id, flush }: {
  title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode;
  variant?: "plain" | "inset"; testId?: string; id?: string;
  /** Children touch the box edges (tables inside an inset section). */
  flush?: boolean;
}) {
  return (
    <section className="sem-section" data-variant={variant} data-testid={testId} id={id}>
      {(title || actions) && (
        <div className="sem-section-head">
          <div className="sem-section-head-text">
            {title && <h2 className="sem-section-title">{title}</h2>}
            {description && <p className="sem-section-description">{description}</p>}
          </div>
          {actions && <div className="sem-section-actions">{actions}</div>}
        </div>
      )}
      {variant === "inset" ? <div className="sem-inset" data-flush={flush || undefined}>{children}</div> : children}
    </section>
  );
}

/** Two (or more) columns of sections on wide windows, one column on narrow ones. */
export function SectionGrid({ children, columns = 2, style }: { children: ReactNode; columns?: 2 | 3; style?: CSSProperties }) {
  return <div className="sem-section-grid" data-cols={columns} style={style}>{children}</div>;
}

export type PropertyItem = { label: ReactNode; value: ReactNode; hint?: ReactNode; mono?: boolean; key?: string };

/**
 * Label/value list (read-only properties). Pass `items`, or `rows` as [label, value] tuples
 * (same shape as the web product's KeyValue).
 */
export function PropertyList({ items, rows, labelWidth = 200, testId, dense }: {
  items?: PropertyItem[]; rows?: [ReactNode, ReactNode][]; labelWidth?: number; testId?: string; dense?: boolean;
}) {
  const list: PropertyItem[] = items ?? (rows ?? []).map(([label, value]) => ({ label, value }));
  return (
    <dl className="sem-props" style={{ ["--sem-props-label-w" as string]: `${labelWidth}px` }} data-dense={dense || undefined} data-testid={testId}>
      {list.map((it, i) => (
        <div className="sem-props-row" key={it.key ?? i}>
          <dt>{it.hint ? <Tooltip label={it.hint} multiline maw={320}><span className="sem-props-hint">{it.label}</span></Tooltip> : it.label}</dt>
          <dd data-mono={it.mono || undefined}>{it.value === undefined || it.value === null || it.value === "" ? <span className="sem-dim">–</span> : it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Web-product compatible alias. */
export function KeyValue({ rows, testId }: { rows: [ReactNode, ReactNode][]; testId?: string }) {
  return <PropertyList rows={rows} testId={testId} />;
}

/** A number with a label: the flat replacement for stat cards. Group them in a MetricGrid. */
export function Metric({ label, value, hint, tone, testId, onClick }: {
  label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "red" | "orange" | "green"; testId?: string; onClick?: () => void;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp className="sem-metric" data-tone={tone} data-testid={testId} onClick={onClick} type={onClick ? "button" : undefined}>
      <span className="sem-metric-label">{label}</span>
      <span className="sem-metric-value">{value}</span>
      {hint && <span className="sem-metric-hint">{hint}</span>}
    </Comp>
  );
}

export function MetricGrid({ children, testId, min = 150 }: { children: ReactNode; testId?: string; min?: number }) {
  return <div className="sem-metrics" data-testid={testId} style={{ ["--sem-metric-min" as string]: `${min}px` }}>{children}</div>;
}

/** Horizontal bar for used/total quantities (memory, licenses, quotas). No bar when `max` is 0 (not reported). */
export function Meter({ value, max, label, detail }: { value: number; max: number; label?: ReactNode; detail?: ReactNode }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const tone = pct > 90 ? "red" : pct > 75 ? "orange" : "accent";
  return (
    <div className="sem-meter">
      {(label || detail) && (
        <div className="sem-meter-head"><span className="sem-meter-label">{label}</span><span className="sem-meter-detail">{detail}</span></div>
      )}
      {max > 0 && <div className="sem-meter-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={typeof label === "string" ? label : undefined}>
        <div className="sem-meter-fill" data-tone={tone} style={{ width: `${pct}%` }} />
      </div>}
    </div>
  );
}

/** Monospace inline text (addresses, ids, fingerprints). */
export function Mono({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return <span className="sem-mono" data-dim={dim || undefined}>{children}</span>;
}

/** Secondary text colour inline. */
export function Dim({ children }: { children: ReactNode }) {
  return <span className="sem-dim">{children}</span>;
}

/** Keyboard shortcut hint: <Shortcut keys={["mod", "N"]} /> renders ⌘N on macOS, Ctrl+N on Windows. */
export function Shortcut({ keys }: { keys: string[] }) {
  const mac = document.documentElement.dataset.platform === "darwin";
  const map: Record<string, string> = mac
    ? { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", enter: "↩", esc: "⎋", backspace: "⌫" }
    : { mod: "Ctrl", shift: "Shift", alt: "Alt", ctrl: "Ctrl", enter: "Enter", esc: "Esc", backspace: "Backspace" };
  const parts = keys.map((k) => map[k.toLowerCase()] ?? k.toUpperCase());
  return <kbd className="sem-kbd">{mac ? parts.join("") : parts.join("+")}</kbd>;
}
