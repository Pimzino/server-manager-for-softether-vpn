// Shared types and helpers for the client deployment pages (profiles, packages, installers).
// Ported from apps/web components/deploy/shared.tsx: useGlobalRole is gone (no roles), AuthBadge is a Tag,
// and fileToPem(File) became bytesToPem(bytes) / pickPemFile() in files.ts (re-exported here).
import { useQuery } from "@tanstack/react-query";
import { get } from "../../lib/api";
import { Tag, type TagColor } from "../../design";

export { bytesToPem, pickPemFile } from "./files";

/** Placeholder the backend understands as "keep the stored secret". */
export const KEEP = "********";

export type AuthType = "anonymous" | "password" | "radius" | "certificate";
export type ProxyType = "direct" | "http" | "socks4" | "socks5";

/** Mirrors profileSchema in apps/desktop/src/main/core/deploy/vpnfile.ts. */
export interface ProfileSettings {
  accountName: string;
  host: string;
  port: number;
  hub: string;
  authType: AuthType;
  username: string;
  password?: string;
  hashedPassword?: string;
  clientCertPem?: string;
  clientKeyPem?: string;
  serverCertPem?: string;
  checkServerCert: boolean;
  addDefaultCa: boolean;
  deviceName: string;
  startup: boolean;
  maxConnection: number;
  useEncrypt: boolean;
  useCompress: boolean;
  halfConnection: boolean;
  noUdpAcceleration: boolean;
  disableQoS: boolean;
  noRoutingTracking: boolean;
  requireBridgeRoutingMode: boolean;
  requireMonitorMode: boolean;
  additionalConnectionInterval: number;
  connectionDisconnectSpan: number;
  numRetry: number;
  retryInterval: number;
  hideStatusWindow: boolean;
  hideNicInfoWindow: boolean;
  proxyType: ProxyType;
  proxyHost: string;
  proxyPort: number;
  proxyUsername: string;
}

export interface Profile {
  id: number;
  name: string;
  description: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  settings: ProfileSettings & { hasPassword: boolean; hasClientKey: boolean };
}

export interface PackageFile { name: string; size: number; sha256: string }
export interface ClientPackage {
  id: number;
  filename: string;
  version: string;
  arch: "x64" | "x86" | "arm64";
  sha256: string;
  size: number;
  uploadedBy: string;
  createdAt: number;
  source: "upload" | "github" | string;
  url?: string;
  edition: "dev" | "stable";
  files: PackageFile[];
}

export type CredentialMode = "embedded" | "install-time" | "none";

/** Mirrors msiOptionsSchema in apps/desktop/src/main/core/deploy/msi.ts. */
export interface MsiOptions {
  productName: string;
  manufacturer: string;
  productVersion: string;
  upgradeCode?: string;
  installFolder: string;
  connectAfterInstall: boolean;
  deleteProfileAfterImport: boolean;
  startMenuShortcut: boolean;
  uiHelperAtLogon: boolean;
  credentialMode: CredentialMode;
  clientConfigPassword?: string;
  preserveOnUpgrade: boolean;
  configureTimeoutSec: number;
  nicName: string;
}

export interface InstallerBuild {
  id: number;
  name: string;
  productVersion: string;
  upgradeCode: string;
  packageId: number | null;
  profileIds: number[];
  options: MsiOptions;
  sha256: string | null;
  size: number | null;
  status: "ready" | "failed" | "building" | string;
  log: string;
  createdBy: string;
  createdAt: number;
}

export interface DeployStatus { msitools: { ok: boolean; version?: string; error?: string } }

export const AUTH_LABEL: Record<AuthType, string> = {
  anonymous: "Anonymous",
  password: "Standard password",
  radius: "RADIUS / NT domain",
  certificate: "Client certificate",
};
export const AUTH_COLOR: Record<AuthType, TagColor> = { anonymous: "gray", password: "accent", radius: "purple", certificate: "teal" };

/** Profile authentication type as a Tag. */
export function AuthBadge({ type }: { type: AuthType }) {
  return <Tag color={AUTH_COLOR[type] ?? "gray"}>{AUTH_LABEL[type] ?? type}</Tag>;
}

export const CRED_LABEL: Record<CredentialMode, string> = {
  embedded: "Embedded in profile",
  "install-time": "Supplied at install time",
  none: "None (user enters)",
};

/** NIC names accepted by SoftEther: VPN, VPN2 … VPN127. */
export const NIC_RE = /^VPN([1-9]|[1-9]\d|1[01]\d|12[0-7])?$/;
export const NIC_OPTIONS = ["VPN", ...Array.from({ length: 126 }, (_, i) => `VPN${i + 2}`)];
export const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,5}(\.\d{1,5})?$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const deployKeys = {
  profiles: ["deploy", "profiles"] as const,
  packages: ["deploy", "packages"] as const,
  installers: ["deploy", "installers"] as const,
  status: ["deploy", "status"] as const,
};

export function useProfiles() {
  return useQuery({ queryKey: deployKeys.profiles, queryFn: () => get<Profile[]>("/api/deploy/profiles") });
}
export function usePackages() {
  return useQuery({ queryKey: deployKeys.packages, queryFn: () => get<ClientPackage[]>("/api/deploy/packages") });
}
export function useInstallers() {
  return useQuery({ queryKey: deployKeys.installers, queryFn: () => get<InstallerBuild[]>("/api/deploy/installers") });
}
export function useDeployStatus() {
  return useQuery({ queryKey: deployKeys.status, queryFn: () => get<DeployStatus>("/api/deploy/status"), staleTime: 60_000 });
}

/** Size of a PEM's DER content, e.g. "1,234 bytes DER" ("" for none or the KEEP placeholder). */
export function pemSummary(pem: string | undefined): string {
  if (!pem || pem === KEEP) return "";
  const b64 = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  const bytesLen = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  return `${bytesLen.toLocaleString()} bytes DER`;
}

/** "1.0.9" -> "1.0.10", "2.1" stays valid only if it matches VERSION_RE. */
export function bumpVersion(v: string): string {
  const parts = v.split(".").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p))) return "1.0.0";
  parts[parts.length - 1] += 1;
  return parts.join(".");
}

/** ProductCode of a build, parsed from the Property table dump in the build log. */
export function productCodeOf(log: string | undefined): string | null {
  const m = /ProductCode\t(\{[0-9A-F-]{36}\})/i.exec(log ?? "");
  return m ? m[1].toUpperCase() : null;
}
