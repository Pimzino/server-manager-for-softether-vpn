// Types and helpers for hub-based client deployment (templates, hub profiles, per-user packages).
// Ported from apps/web components/deploy/hubdeploy.tsx: PolicyBadge is a Tag, downloadBuild() is async and
// uses the native Save dialog, and BuildResultModal became BuildResultSheet (with Show in Finder/Explorer).
import { useState } from "react";
import { Button } from "@mantine/core";
import { IconDownload, IconFolderOpen, IconKey, IconPackageExport } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { download, get, revealPath } from "../../lib/api";
import { bytes } from "../../lib/format";
import { notifyError } from "../../lib/hooks";
import { isMac } from "../../lib/platform";
import type { SaveResult } from "../../../shared/ipc";
import { CopyField, Mono, Sheet, Tag, type TagColor } from "../../design";
import { Callout } from "./ui";

export type PasswordPolicy = "embed-hash" | "rotate" | "install-time" | "prompt";

export interface TemplateSettings {
  connection: {
    accountNamePattern: string; publicHost: string; publicPort: number; pinServerCertificate: boolean; checkServerCert: boolean; addDefaultCa: boolean;
    startup: boolean; maxConnection: number; useEncrypt: boolean; useCompress: boolean; halfConnection: boolean; noUdpAcceleration: boolean;
    disableQoS: boolean; noRoutingTracking: boolean; additionalConnectionInterval: number; connectionDisconnectSpan: number;
    numRetry: number; retryInterval: number; hideStatusWindow: boolean; hideNicInfoWindow: boolean;
    proxyType: "direct" | "http" | "socks4" | "socks5"; proxyHost: string; proxyPort: number; proxyUsername: string;
  };
  credentials: { passwordUsers: PasswordPolicy; rotateLength: number };
  installer: {
    productName: string; manufacturer: string; baseVersion: string; installFolder: string; connectAfterInstall: boolean;
    deleteProfileAfterImport: boolean; startMenuShortcut: boolean; uiHelperAtLogon: boolean; preserveOnUpgrade: boolean;
    configureTimeoutSec: number; nicName: string; clientConfigPassword?: string; packageId: number | null; arch: "x64" | "x86";
  };
  branding: {
    iconIco: string | null; arpHelpLink: string; arpUrlInfoAbout: string; arpContact: string; arpHelpTelephone: string; arpComments: string;
    startMenuFolder: string; shortcutName: string; serviceDisplayName: string; serviceDescription: string;
  };
  setupExe: { companyName: string; productName: string; fileDescription: string; copyright: string; ui: "basic" | "full"; fileNamePattern: string };
  client: { brandBinaries: boolean; displayName: string; managerName: string; stringOverrides: Record<string, string> };
}

export interface Template {
  id: number; name: string; description: string; isDefault: boolean; createdBy: string; createdAt: number; updatedAt: number;
  settings: TemplateSettings;
}

/**
 * One row of GET /api/deploy/hubs. A server that can't be listed yields a row with only serverId, serverName
 * and `error` (plus `locked: true` when its password isn't saved and it hasn't been unlocked).
 * (The web's `myRole` is gone.)
 */
export interface HubProfile {
  serverId: number; serverName: string; hub: string; template: { id: number; name: string };
  host: string; port: number; accountName: string; enabled: boolean;
  overrides: { templateId: number | null; publicHost: string | null; publicPort: number | null; accountName: string | null };
  numUsers?: number; online?: boolean; error?: string; locked?: boolean;
}

export interface HubBuild {
  id: number; kind: "vpn" | "msi" | "exe"; username: string | null; fileName: string; productVersion: string; size: number; sha256: string;
  createdBy: string; createdAt: number;
}

export interface HubUser {
  name: string; realName: string; group: string; authType: number; authLabel: string; disabled: boolean;
  deployable: boolean; credential: string; reason?: string; lastBuild: HubBuild | null;
}

export interface HubDetail { profile: HubProfile; credentialPolicy: PasswordPolicy; users: HubUser[]; builds: HubBuild[] }

export interface BuiltPackage {
  id: number; kind: "vpn" | "msi" | "exe"; fileName: string; size: number; sha256: string; productVersion: string | null;
  issuedPassword?: string; credential: string; warnings: string[]; log: string;
}

/** Credential policies and per-user credential states. `color` is a design-system Tag colour. */
export const POLICY_LABEL: Record<string, { label: string; color: TagColor; help: string }> = {
  "embed-hash": { label: "Embedded hash", color: "orange", help: "The user’s current password hash is embedded. The package connects straight away, and the file is as sensitive as the password. Needs a server administrator connection." },
  rotate: { label: "New password", color: "purple", help: "A new random password is set on the server when the package is built, embedded, and shown to you once." },
  "rotate (on build)": { label: "New password on build", color: "purple", help: "A new password is set when the package is built." },
  "install-time": { label: "At install", color: "teal", help: "Nothing is embedded: pass VPNUSERNAME=… VPNPASSWORD=… to msiexec or setup.exe." },
  prompt: { label: "User enters", color: "gray", help: "Nothing is embedded: the user types the password in the VPN client." },
  anonymous: { label: "Anonymous", color: "gray", help: "Anonymous hub access; no credential." },
  certificate: { label: "Certificate", color: "red", help: "Needs the user’s certificate and key, which aren’t generated automatically." },
};

/** Credential policy as a Tag, with the explanation in its tooltip. */
export function PolicyBadge({ value }: { value: string }) {
  const p = POLICY_LABEL[value] ?? { label: value, color: "gray" as const, help: undefined };
  return <Tag color={p.color} title={p.help}>{p.label}</Tag>;
}

export const KIND_LABEL: Record<string, string> = { vpn: ".vpn profile", msi: "MSI installer", exe: "setup.exe" };

export function useTemplates() {
  return useQuery({ queryKey: ["deploy", "templates"], queryFn: () => get<Template[]>("/api/deploy/templates") });
}

/** Save a built package through the native Save dialog. Resolves { saved: false } when cancelled. */
export function downloadBuild(id: number): Promise<SaveResult> {
  return download(`/api/deploy/installers/${id}/download`);
}

const revealLabel = () => (isMac() ? "Show in Finder" : "Show in Explorer");

/**
 * Result of a build: Save… button, and the issued password (shown only here, once).
 * Test ids: build-result, issued-password, build-result-download, build-result-reveal.
 */
export function BuildResultSheet({ result, onClose }: { result: BuiltPackage | null; onClose: () => void }) {
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const close = () => { setSavedPath(null); onClose(); };
  const save = async () => {
    if (!result) return;
    setSaving(true);
    try {
      const r = await downloadBuild(result.id);
      if (r.saved && r.filePath) setSavedPath(r.filePath);
    } catch (e) {
      notifyError(e, "Couldn’t save the package");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Sheet
      opened={!!result}
      onClose={close}
      busy={saving}
      size={600}
      icon={<IconPackageExport size={19} stroke={1.5} />}
      title={result ? `${KIND_LABEL[result.kind] ?? result.kind} ready` : ""}
      subtitle={result ? result.fileName : undefined}
      testId="build-result-sheet"
      footer={result && (
        <div className="sem-row-inline" style={{ justifyContent: "flex-end", width: "100%" }}>
          {savedPath && (
            <Button variant="default" leftSection={<IconFolderOpen size={14} />} onClick={() => void revealPath(savedPath)} data-testid="build-result-reveal">{revealLabel()}</Button>
          )}
          <Button variant="default" onClick={close}>{savedPath ? "Done" : "Close"}</Button>
          <Button leftSection={<IconDownload size={14} />} loading={saving} onClick={save} data-testid="build-result-download">Save…</Button>
        </div>
      )}
    >
      {result && (
        <div className="sem-stack" data-testid="build-result">
          <div className="sem-row-inline" style={{ justifyContent: "space-between", width: "100%" }}>
            <span className="sem-dim">
              {bytes(result.size)} · SHA-256 <Mono>{result.sha256.slice(0, 16)}…</Mono>{result.productVersion ? ` · version ${result.productVersion}` : ""}
            </span>
            <PolicyBadge value={result.credential} />
          </div>
          {result.issuedPassword && (
            <Callout tone="purple" icon={<IconKey size={16} stroke={1.7} />} title="New password issued. It’s shown only once." testId="issued-password">
              <div>The user’s password on the VPN Server was changed to this value, and it’s embedded in the package. Record it now if the user needs it on other devices; it can’t be shown again.</div>
              <div style={{ marginTop: "var(--sem-space-4)" }}><CopyField value={result.issuedPassword} block /></div>
            </Callout>
          )}
          {result.warnings.map((w) => <Callout key={w} tone="yellow">{w}</Callout>)}
          {(result.credential === "embed-hash" || result.issuedPassword) && (
            <div className="sem-dim">This file contains a credential that works like the password. Deliver it through a secure channel, and delete copies after installation.</div>
          )}
          {savedPath && <div className="sem-dim" data-testid="build-result-saved">Saved to <Mono>{savedPath}</Mono></div>}
        </div>
      )}
    </Sheet>
  );
}
