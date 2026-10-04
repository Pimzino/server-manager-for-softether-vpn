// Read-only values the user may want to copy: CopyField (any text), FingerprintField (SHA-256 fingerprints),
// CopyButton (icon only). Copying uses the async clipboard API, which Electron allows for the focused window.
import { useState, type ReactNode } from "react";
import { ActionIcon, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { colonFp, normFp } from "../lib/format";

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export function CopyButton({ value, label = "Copy", size = 22, testId }: { value: string; label?: string; size?: number; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip label={copied ? "Copied" : label} openDelay={300}>
      <ActionIcon
        variant="subtle" color="gray" size={size} aria-label={label} data-testid={testId}
        onClick={async (e) => { e.stopPropagation(); await copyText(value); setCopied(true); setTimeout(() => setCopied(false), 1400); }}
      >
        {copied ? <IconCheck size={14} color="var(--sem-green)" /> : <IconCopy size={14} stroke={1.6} />}
      </ActionIcon>
    </Tooltip>
  );
}

/** Text + copy button. `mono` for ids/addresses. `block` wraps long values in a well. */
export function CopyField({ value, display, mono = true, block, size = "md", testId }: {
  value: string; display?: ReactNode; mono?: boolean; block?: boolean; size?: "sm" | "md"; testId?: string;
}) {
  return (
    <span className="sem-copy" data-block={block || undefined} data-size={size} data-testid={testId}>
      <span className={mono ? "sem-mono sem-copy-value" : "sem-copy-value"}>{display ?? value}</span>
      <CopyButton value={value} />
    </span>
  );
}

/** Web-product compatible alias. */
export function Copyable({ value, mono = true }: { value: string; mono?: boolean }) {
  return <CopyField value={value} mono={mono} />;
}

/**
 * SHA-256 fingerprint shown as 32 byte pairs in groups of 8, so a human can compare it with the value
 * shown on the server (vpncmd ServerCertGet, the Windows Server Manager…). `compare` highlights it green
 * when equal, orange when different.
 */
export function FingerprintField({ value, compare, label, testId }: { value: string; compare?: string | null; label?: ReactNode; testId?: string }) {
  const pairs = colonFp(value).split(":").filter(Boolean);
  const rows: string[][] = [];
  for (let i = 0; i < pairs.length; i += 8) rows.push(pairs.slice(i, i + 8));
  const match = compare === undefined ? undefined : compare ? normFp(compare) === normFp(value) : false;
  return (
    <div className="sem-fp" data-match={match === undefined ? undefined : match ? "yes" : "no"} data-testid={testId ?? "fingerprint"}>
      {label && <div className="sem-fp-label">{label}</div>}
      <div className="sem-fp-body">
        <div className="sem-fp-grid sem-mono" aria-label={`Fingerprint ${colonFp(value)}`}>
          {rows.map((r, i) => <div key={i} className="sem-fp-row">{r.join(" ")}</div>)}
        </div>
        <CopyButton value={colonFp(value)} label="Copy fingerprint" testId="fingerprint-copy" />
      </div>
    </div>
  );
}
