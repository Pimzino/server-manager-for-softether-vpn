// Helpers shared by the client deployment pages (deploy/* and hub/Deploy). Local to these pages:
// the design system has no code block, switch row, step header or build-capability hook, so they live here.
import type { CSSProperties, ReactNode } from "react";
import { Switch, Tooltip } from "@mantine/core";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { IconBrandGithub, IconCheck, IconUpload } from "@tabler/icons-react";
import { get } from "../../../lib/api";
import { CopyButton, FormRow, StatusBadge, Tag } from "../../../design";
import type { InstallerBuild, MsiOptions } from "../../../components/domain/deploy";

// ------------------------------------------------------------------ build capabilities

/** GET /api/deploy/capabilities: what this machine can build (MSI needs msitools / WiX, setup.exe needs the stubs). */
export interface Capabilities {
  platform: string;
  vpn: { available: boolean };
  msi: { available: boolean; tool: "wixl" | "wix3" | null; version: string | null; path: string | null; hint: string };
  setupExe: { available: boolean; arch: string[]; hint: string };
}

export const capabilitiesKey = ["deploy", "capabilities"] as const;

export function useCapabilities() {
  return useQuery({ queryKey: capabilitiesKey, queryFn: () => get<Capabilities>("/api/deploy/capabilities"), staleTime: 60_000 });
}

/** Re-detect the toolchain (tools installed while the app runs) and update the cache. */
export function useRecheckCapabilities() {
  const qc = useQueryClient();
  return async () => {
    const r = await get<Capabilities>("/api/deploy/capabilities?refresh=1");
    qc.setQueryData(capabilitiesKey, r);
    return r;
  };
}

export const toolLabel = (c: Capabilities["msi"]) =>
  c.tool === "wix3" ? `WiX Toolset ${c.version ?? ""}`.trim() : c.tool === "wixl" ? `msitools ${c.version ?? ""}`.trim() : "MSI tools";

/** "MSI tools ready" / "MSI tools missing" badge for page headers. */
export function MsiToolBadge({ caps, testId }: { caps: Capabilities | undefined; testId?: string }) {
  if (!caps) return null;
  return caps.msi.available
    ? <StatusBadge status="ok" tooltip={caps.msi.path ?? undefined} testId={testId}>{toolLabel(caps.msi)}</StatusBadge>
    : <StatusBadge status="error" tooltip={caps.msi.hint} testId={testId}>MSI tools missing</StatusBadge>;
}

export const invalidateDeploy = (qc: QueryClient) => qc.invalidateQueries({ queryKey: ["deploy"] });

// ------------------------------------------------------------------ builds

/**
 * A row of GET /api/deploy/installers. Custom-profile MSIs carry MsiOptions; builds made from a hub's
 * Client Deployment page (kind vpn/msi/exe) carry { template, credential } and the hub/user they were made for.
 */
export interface BuildRecord extends Omit<InstallerBuild, "options"> {
  kind: "msi" | "exe" | "vpn" | string;
  serverId: number | null;
  hub: string | null;
  username: string | null;
  templateId: number | null;
  fileName: string | null;
  productCode: string | null;
  options: Partial<MsiOptions> & { template?: string; credential?: string };
}

export const isHubBuild = (b: Pick<BuildRecord, "serverId">) => b.serverId !== null && b.serverId !== undefined;
export const safeFile = (s: string) => s.replace(/[^\w.-]+/g, "_");
export const buildFileName = (b: Pick<BuildRecord, "name" | "productVersion" | "fileName">) => b.fileName ?? `${safeFile(b.name)}-${b.productVersion}.msi`;
/** ProductCode from the record, else from the Property table dump in the log. */
export const productCodeFrom = (b: Pick<BuildRecord, "productCode" | "log">) =>
  b.productCode ?? (/ProductCode\t(\{[0-9A-F-]{36}\})/i.exec(b.log ?? "")?.[1]?.toUpperCase() ?? null);

export const KIND_SHORT: Record<string, string> = { msi: "MSI", exe: "setup.exe", vpn: ".vpn" };

export function BuildStatus({ status }: { status: string }) {
  if (status === "ready") return <StatusBadge status="ok">Ready</StatusBadge>;
  if (status === "failed") return <StatusBadge status="error">Failed</StatusBadge>;
  if (status === "building") return <StatusBadge status="busy">Building</StatusBadge>;
  return <StatusBadge status="unknown">{status}</StatusBadge>;
}

// ------------------------------------------------------------------ packages

export function EditionTag({ edition }: { edition: string }) {
  return edition === "dev"
    ? <Tooltip label="Developer Edition 5.x (service SEVPNCLIENTDEV)"><span><Tag color="purple">Developer 5.x</Tag></span></Tooltip>
    : <Tooltip label="Stable Edition 4.x (service SEVPNCLIENT)"><span><Tag color="accent">Stable 4.x</Tag></span></Tooltip>;
}

export function SourceTag({ source }: { source: string }) {
  return source === "github"
    ? <Tag icon={<IconBrandGithub size={11} />}>GitHub</Tag>
    : <Tag icon={<IconUpload size={11} />}>Upload</Tag>;
}

export const REQUIRED_FILES = ["vpnclient.exe", "vpncmd.exe", "hamcore.se2"];

// ------------------------------------------------------------------ layout helpers

/** Monospace, scrollable block for generated files, logs and commands. */
export function CodeBlock({ text, maxHeight = 420, wrap, testId, copy = true }: {
  text: string; maxHeight?: number | string; wrap?: boolean; testId?: string; copy?: boolean;
}) {
  const style: CSSProperties = {
    margin: 0, padding: "var(--sem-space-5) var(--sem-space-6)", background: "var(--sem-bg-code)", color: "var(--sem-text)",
    border: "0.5px solid var(--sem-separator)", borderRadius: "var(--sem-radius-md)", fontFamily: "var(--sem-font-mono)",
    fontSize: "var(--sem-fz-caption)", lineHeight: 1.55, overflow: "auto", maxHeight, whiteSpace: wrap ? "pre-wrap" : "pre",
    wordBreak: wrap ? "break-all" : undefined, userSelect: "text", WebkitUserSelect: "text", tabSize: 4,
  };
  return (
    <div style={{ position: "relative", width: "100%", minWidth: 0 }}>
      <pre style={style} data-testid={testId}>{text}</pre>
      {copy && text && (
        <div style={{ position: "absolute", top: "var(--sem-space-3)", right: "var(--sem-space-5)" }}><CopyButton value={text} /></div>
      )}
    </div>
  );
}

/** FormRow whose control is a switch at the trailing edge (System Settings style). */
export function SwitchRow({ label, description, checked, onChange, disabled, testId, error }: {
  label: ReactNode; description?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; testId?: string; error?: ReactNode;
}) {
  return (
    <FormRow label={label} description={description} error={error}>
      {(id) => (
        <div style={{ alignSelf: "flex-end" }}>
          <Switch id={id} checked={checked} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} withThumbIndicator={false} data-testid={testId} />
        </div>
      )}
    </FormRow>
  );
}

/** Footer layout for sheets: optional leading content, buttons trailing (primary last). */
export function SheetFooter({ leading, children }: { leading?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--sem-space-4)", width: "100%" }}>
      {leading}
      <div style={{ flex: 1 }} />
      {children}
    </div>
  );
}

/** Assistant-style step indicator: "1 Package › 2 Profiles › …". Completed steps are clickable. */
export function StepHeader({ steps, active, onStep, testId }: { steps: string[]; active: number; onStep?: (i: number) => void; testId?: string }) {
  return (
    <ol data-testid={testId} style={{ display: "flex", alignItems: "center", gap: "var(--sem-space-3)", listStyle: "none", margin: "0 0 var(--sem-space-6)", padding: 0, flexWrap: "wrap" }}>
      {steps.map((s, i) => {
        const done = i < active, current = i === active;
        const clickable = !!onStep && i !== active;
        return (
          <li key={s} style={{ display: "flex", alignItems: "center", gap: "var(--sem-space-3)" }}>
            {i > 0 && <span className="sem-dim" aria-hidden>›</span>}
            <button
              type="button" disabled={!clickable} onClick={() => onStep?.(i)} aria-current={current ? "step" : undefined}
              style={{
                display: "inline-flex", alignItems: "center", gap: "var(--sem-space-3)", border: 0, background: current ? "var(--sem-accent-soft)" : "transparent",
                color: current ? "var(--sem-accent-text)" : done ? "var(--sem-text)" : "var(--sem-text-2)", borderRadius: "var(--sem-radius-sm)",
                padding: "var(--sem-space-1) var(--sem-space-4)", font: "inherit", fontWeight: current ? 600 : 400, cursor: clickable ? "pointer" : "default",
              }}
            >
              <span style={{
                display: "inline-grid", placeItems: "center", width: 18, height: 18, borderRadius: "50%", fontSize: "var(--sem-fz-caption)", fontWeight: 600,
                background: current ? "var(--sem-accent)" : done ? "var(--sem-green-soft)" : "var(--sem-fill-quiet)",
                color: current ? "var(--sem-text-on-accent)" : done ? "var(--sem-green)" : "var(--sem-text-2)",
              }}>{done ? <IconCheck size={11} stroke={2.6} /> : i + 1}</span>
              {s}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Label: value pairs in one line (the "effective" summary under forms). */
export function InlineFacts({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <div className="sem-row-inline" style={{ gap: "var(--sem-space-3) var(--sem-space-7)" }}>
      {items.map(([k, v], i) => (
        <span key={i} className="sem-row-inline" style={{ gap: "var(--sem-space-3)" }}><span className="sem-dim">{k}</span>{v}</span>
      ))}
    </div>
  );
}
