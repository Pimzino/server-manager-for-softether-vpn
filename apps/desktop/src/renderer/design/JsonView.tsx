// Collapsible, syntax-coloured JSON viewer for RPC results (API console, bulk results, raw views).
import { useState, type ReactNode } from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { CopyButton } from "./CopyField";

type J = unknown;

function Leaf({ v }: { v: J }) {
  if (v === null) return <span className="sem-json-null">null</span>;
  if (typeof v === "string") return <span className="sem-json-string">"{v}"</span>;
  if (typeof v === "number") return <span className="sem-json-number">{v}</span>;
  if (typeof v === "boolean") return <span className="sem-json-bool">{String(v)}</span>;
  return <span>{String(v)}</span>;
}

function Node({ k, v, depth, defaultDepth, last }: { k?: string; v: J; depth: number; defaultDepth: number; last: boolean }) {
  const isArr = Array.isArray(v);
  const isObj = !!v && typeof v === "object";
  const [open, setOpen] = useState(depth < defaultDepth);
  const key: ReactNode = k !== undefined ? <><span className="sem-json-key">"{k}"</span>: </> : null;
  if (!isObj) return <div className="sem-json-line">{key}<Leaf v={v} />{last ? "" : ","}</div>;
  const entries = isArr ? (v as J[]).map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, J>);
  const [o, c] = isArr ? ["[", "]"] : ["{", "}"];
  if (!entries.length) return <div className="sem-json-line">{key}{o}{c}{last ? "" : ","}</div>;
  return (
    <div>
      <div className="sem-json-line">
        <button type="button" className="sem-json-toggle" data-open={open || undefined} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? "Collapse" : "Expand"}>
          <IconChevronRight size={11} />
        </button>
        {key}{o}
        {!open && <><button type="button" className="sem-json-more" onClick={() => setOpen(true)}>{isArr ? `${entries.length} items` : `${entries.length} fields`}</button>{c}{last ? "" : ","}</>}
      </div>
      {open && (
        <>
          <div className="sem-json-children">
            {entries.map(([ek, ev], i) => (
              <Node key={ek} k={isArr ? undefined : ek} v={ev} depth={depth + 1} defaultDepth={defaultDepth} last={i === entries.length - 1} />
            ))}
          </div>
          <div className="sem-json-line">{c}{last ? "" : ","}</div>
        </>
      )}
    </div>
  );
}

export function JsonView({ value, defaultDepth = 2, maxHeight = 480, copy = true, testId }: {
  value: unknown; defaultDepth?: number; maxHeight?: number | string; copy?: boolean; testId?: string;
}) {
  return (
    <div className="sem-json" style={{ maxHeight }} data-testid={testId}>
      {copy && <div className="sem-json-copy"><CopyButton value={JSON.stringify(value, null, 2)} label="Copy JSON" /></div>}
      <div className="sem-mono sem-json-root"><Node v={value} depth={0} defaultDepth={defaultDepth} last /></div>
    </div>
  );
}
