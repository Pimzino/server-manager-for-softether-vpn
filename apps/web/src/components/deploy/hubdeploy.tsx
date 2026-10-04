import { Alert, Badge, Button, Code, Group, Modal, Stack, Text } from "@mantine/core";
import { IconAlertTriangle, IconDownload, IconKey } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { download, get } from "../../lib/api";
import { bytes } from "../../lib/format";
import { Copyable } from "../common";

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

export interface HubProfile {
  serverId: number; serverName: string; hub: string; template: { id: number; name: string };
  host: string; port: number; accountName: string; enabled: boolean;
  overrides: { templateId: number | null; publicHost: string | null; publicPort: number | null; accountName: string | null };
  numUsers?: number; online?: boolean; myRole?: string; error?: string;
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

export const POLICY_LABEL: Record<string, { label: string; color: string; help: string }> = {
  "embed-hash": { label: "Embedded hash", color: "orange", help: "The user's current password hash is embedded. Connects immediately; the file is password-equivalent. Needs the admin role on the server." },
  rotate: { label: "New password", color: "violet", help: "A new random password is set on the server when the package is built, embedded, and shown to you once." },
  "rotate (on build)": { label: "New password on build", color: "violet", help: "A new password will be set when the package is built." },
  "install-time": { label: "At install", color: "cyan", help: "Nothing embedded: pass VPNUSERNAME=… VPNPASSWORD=… to msiexec or setup.exe." },
  prompt: { label: "User enters", color: "gray", help: "Nothing embedded: the user types the password in the VPN client." },
  anonymous: { label: "Anonymous", color: "gray", help: "Anonymous hub access; no credential." },
  certificate: { label: "Certificate", color: "red", help: "Needs the user's certificate and key; not generated automatically." },
};

export function PolicyBadge({ value }: { value: string }) {
  const p = POLICY_LABEL[value] ?? { label: value, color: "gray" };
  return <Badge variant="light" color={p.color}>{p.label}</Badge>;
}

export const KIND_LABEL: Record<string, string> = { vpn: ".vpn profile", msi: "MSI installer", exe: "setup.exe" };

export function useTemplates() {
  return useQuery({ queryKey: ["deploy", "templates"], queryFn: () => get<Template[]>("/api/deploy/templates") });
}

export function downloadBuild(id: number) {
  download(`/api/deploy/installers/${id}/download`);
}

/** Result of a build: download button, and the issued password (shown only here, once). */
export function BuildResultModal({ result, onClose }: { result: BuiltPackage | null; onClose: () => void }) {
  return (
    <Modal opened={!!result} onClose={onClose} title={result ? `${KIND_LABEL[result.kind]} ready` : ""} centered size="lg" closeOnClickOutside={!result?.issuedPassword}>
      {result && (
        <Stack data-testid="build-result">
          <Group justify="space-between">
            <div>
              <Text fw={600}>{result.fileName}</Text>
              <Text size="xs" c="dimmed">{bytes(result.size)} · SHA-256 <Code>{result.sha256.slice(0, 16)}…</Code>{result.productVersion ? ` · version ${result.productVersion}` : ""}</Text>
            </div>
            <PolicyBadge value={result.credential} />
          </Group>
          {result.issuedPassword && (
            <Alert color="violet" icon={<IconKey size={18} />} title="New password issued — shown only once" data-testid="issued-password">
              <Text size="sm" mb="xs">The user's password on the VPN server was changed to this value, and it is embedded in the package. Record it now if the user needs it (for example for other devices); it cannot be displayed again.</Text>
              <Copyable value={result.issuedPassword} />
            </Alert>
          )}
          {result.warnings.map((w) => <Alert key={w} color="yellow" icon={<IconAlertTriangle size={16} />}>{w}</Alert>)}
          {(result.credential === "embed-hash" || result.issuedPassword) && (
            <Text size="xs" c="dimmed">This file contains a password-equivalent credential. Deliver it through a secure channel and delete copies after installation.</Text>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>Close</Button>
            <Button leftSection={<IconDownload size={16} />} onClick={() => downloadBuild(result.id)} data-testid="build-result-download">Download</Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
