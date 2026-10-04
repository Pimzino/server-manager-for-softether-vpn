// Shared types and helpers for the client deployment pages (profiles, packages, installers).
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@mantine/core";
import { get } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import type { Role } from "../../lib/types";

/** Placeholder the backend understands as "keep the stored secret". */
export const KEEP = "********";

export type AuthType = "anonymous" | "password" | "radius" | "certificate";
export type ProxyType = "direct" | "http" | "socks4" | "socks5";

/** Mirrors profileSchema in apps/server/src/deploy/vpnfile.ts. */
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

/** Mirrors msiOptionsSchema in apps/server/src/deploy/msi.ts. */
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
export const AUTH_COLOR: Record<AuthType, string> = { anonymous: "gray", password: "blue", radius: "grape", certificate: "teal" };

export function AuthBadge({ type }: { type: AuthType }) {
  return <Badge variant="light" color={AUTH_COLOR[type] ?? "gray"}>{AUTH_LABEL[type] ?? type}</Badge>;
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

/** Global (not per-server) role of the signed-in user; deploy routes are gated on it. */
export function useGlobalRole(): Role {
  return useAuth().user?.role ?? "none";
}

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

/**
 * Read a certificate / key file as PEM. Binary DER files (.cer/.der) are wrapped in a PEM
 * envelope so the backend's PEM parser accepts them.
 */
export async function fileToPem(file: File, kind: "CERTIFICATE" | "PRIVATE KEY"): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const text = new TextDecoder().decode(buf);
  if (text.includes("-----BEGIN")) return text.trim() + "\n";
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  const b64 = btoa(bin).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${kind}-----\n${b64}\n-----END ${kind}-----\n`;
}

/** Extract the PEM's certificate subject-less summary: base64 length and first/last chars. */
export function pemSummary(pem: string | undefined): string {
  if (!pem || pem === KEEP) return "";
  const b64 = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  const bytesLen = Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  return `${bytesLen} bytes DER`;
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
