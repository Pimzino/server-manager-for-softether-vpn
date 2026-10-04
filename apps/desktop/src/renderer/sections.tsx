// Route registry: every page of a server, of a Virtual Hub and of client deployment.
// The scope navigation, the quick switcher and the router are all generated from these lists.
//
// PAGE AGENTS: to ship a page, replace its `pending("…")` with `lazy(() => import("./pages/<scope>/<File>"))`.
// Keep path, label, group and icon unchanged unless the design guide says otherwise. One line per page.
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import {
  IconGauge, IconPlugConnected, IconStack2, IconCertificate, IconTopologyStar3, IconShieldCheck, IconBrandOpenSource,
  IconWorld, IconArrowsExchange, IconRoute, IconFileText, IconDatabase, IconLink, IconKey, IconTerminal2,
  IconListCheck, IconUsers, IconUsersGroup, IconFilter, IconDevices, IconTable, IconSettings, IconNetwork,
  IconLock, IconMessage, IconAdjustments, IconLicense, IconUserShield, IconPackageExport, IconAccessPoint,
  IconTopologyStar, IconPalette, IconFileCertificate, IconBox, IconPackage, type Icon,
} from "@tabler/icons-react";

export interface Section {
  /** Path relative to the scope ("" = index page). */
  path: string;
  label: string;
  /** Heading in the scope navigation. */
  group: string;
  icon: Icon;
  component: LazyExoticComponent<ComponentType>;
  /** Available to hub-admin-mode connections (server scope only). */
  hubAdminOk?: boolean;
  /** Extra words the quick switcher matches on. */
  keywords?: string;
}

/** Placeholder until the page is ported: shows which page will appear here. */
function pending(page: string): LazyExoticComponent<ComponentType> {
  return lazy(async () => {
    const m = await import("./pages/Pending");
    const Pending = m.default;
    return { default: () => <Pending page={page} /> };
  });
}

export const serverSections: Section[] = [
  { path: "", label: "Overview", group: "Server", icon: IconGauge, component: lazy(() => import("./pages/server/Overview")), hubAdminOk: true, keywords: "status dashboard" },
  { path: "hubs", label: "Virtual Hubs", group: "Server", icon: IconStack2, component: lazy(() => import("./pages/server/Hubs")), hubAdminOk: true },
  { path: "connections", label: "Connections", group: "Server", icon: IconDevices, component: lazy(() => import("./pages/server/Connections")), keywords: "tcp" },
  { path: "listeners", label: "Listeners & Ports", group: "Network", icon: IconPlugConnected, component: lazy(() => import("./pages/server/Listeners")), keywords: "udp icmp dns keep-alive" },
  { path: "bridges", label: "Local Bridges", group: "Network", icon: IconArrowsExchange, component: lazy(() => import("./pages/server/Bridges")), keywords: "tap ethernet" },
  { path: "l3", label: "Layer 3 Switches", group: "Network", icon: IconRoute, component: lazy(() => import("./pages/server/L3Switches")), keywords: "routing" },
  { path: "ddns", label: "DDNS & VPN Azure", group: "Network", icon: IconWorld, component: lazy(() => import("./pages/server/Ddns")), keywords: "dynamic dns nat traversal" },
  { path: "protocols", label: "OpenVPN & SSTP", group: "Protocols", icon: IconBrandOpenSource, component: lazy(() => import("./pages/server/Protocols")) },
  { path: "ipsec", label: "IPsec, L2TP & EtherIP", group: "Protocols", icon: IconShieldCheck, component: lazy(() => import("./pages/server/Ipsec")) },
  { path: "wireguard", label: "WireGuard", group: "Protocols", icon: IconKey, component: lazy(() => import("./pages/server/WireGuard")) },
  { path: "certificate", label: "Certificate & TLS", group: "Security", icon: IconCertificate, component: lazy(() => import("./pages/server/Certificate")), keywords: "cipher ssl" },
  { path: "security", label: "Admin Password", group: "Security", icon: IconLock, component: lazy(() => import("./pages/server/Security")) },
  { path: "cluster", label: "Clustering", group: "Advanced", icon: IconTopologyStar3, component: lazy(() => import("./pages/server/Cluster")), keywords: "farm" },
  { path: "settings", label: "Server Settings", group: "Advanced", icon: IconSettings, component: lazy(() => import("./pages/server/Settings")), keywords: "keep alive syslog" },
  { path: "logs", label: "Logs & Syslog", group: "Advanced", icon: IconFileText, component: lazy(() => import("./pages/server/Logs")) },
  { path: "config", label: "Configuration & Backups", group: "Advanced", icon: IconDatabase, component: lazy(() => import("./pages/server/Config")), keywords: "restore diff" },
  { path: "license", label: "License & VLAN", group: "Advanced", icon: IconLicense, component: lazy(() => import("./pages/server/License")) },
  { path: "caps", label: "Capabilities", group: "Advanced", icon: IconListCheck, component: lazy(() => import("./pages/server/Caps")), hubAdminOk: true },
  { path: "console", label: "API Console", group: "Advanced", icon: IconTerminal2, component: lazy(() => import("./pages/server/Console")), hubAdminOk: true, keywords: "rpc json" },
];

export const hubSections: Section[] = [
  { path: "", label: "Status", group: "Hub", icon: IconGauge, component: lazy(() => import("./pages/hub/Status")), keywords: "overview" },
  { path: "settings", label: "Properties", group: "Hub", icon: IconSettings, component: lazy(() => import("./pages/hub/Settings")) },
  { path: "options", label: "Admin & Extended Options", group: "Hub", icon: IconAdjustments, component: lazy(() => import("./pages/hub/Options")) },
  { path: "message", label: "Client Message", group: "Hub", icon: IconMessage, component: lazy(() => import("./pages/hub/Message")) },
  { path: "users", label: "Users", group: "Identity", icon: IconUsers, component: lazy(() => import("./pages/hub/Users")) },
  { path: "groups", label: "Groups", group: "Identity", icon: IconUsersGroup, component: lazy(() => import("./pages/hub/Groups")) },
  { path: "radius", label: "RADIUS", group: "Identity", icon: IconUserShield, component: lazy(() => import("./pages/hub/Radius")) },
  { path: "certs", label: "Trusted CAs & CRL", group: "Identity", icon: IconCertificate, component: lazy(() => import("./pages/hub/Certs")) },
  { path: "sessions", label: "Sessions", group: "Traffic", icon: IconDevices, component: lazy(() => import("./pages/hub/Sessions")) },
  { path: "tables", label: "MAC & IP Tables", group: "Traffic", icon: IconTable, component: lazy(() => import("./pages/hub/Tables")) },
  { path: "access", label: "Access Lists", group: "Policy", icon: IconFilter, component: lazy(() => import("./pages/hub/Access")), keywords: "firewall acl" },
  { path: "acl", label: "Source IP Control", group: "Policy", icon: IconAccessPoint, component: lazy(() => import("./pages/hub/AcList")) },
  { path: "cascades", label: "Cascade Connections", group: "Networking", icon: IconLink, component: lazy(() => import("./pages/hub/Cascades")), keywords: "site-to-site link" },
  { path: "securenat", label: "SecureNAT", group: "Networking", icon: IconNetwork, component: lazy(() => import("./pages/hub/SecureNat")), keywords: "dhcp" },
  { path: "logging", label: "Logging", group: "Networking", icon: IconFileText, component: lazy(() => import("./pages/hub/Logging")) },
  { path: "deploy", label: "Client Deployment", group: "Clients", icon: IconPackageExport, component: lazy(() => import("./pages/hub/Deploy")), keywords: "vpn profile msi" },
];

export const deploySections: Section[] = [
  { path: "hubs", label: "Hub Profiles", group: "Profiles", icon: IconTopologyStar, component: lazy(() => import("./pages/deploy/Hubs")) },
  { path: "profiles", label: "Custom Profiles", group: "Profiles", icon: IconFileCertificate, component: lazy(() => import("./pages/deploy/Profiles")), keywords: ".vpn" },
  { path: "templates", label: "Templates & Branding", group: "Profiles", icon: IconPalette, component: lazy(() => import("./pages/deploy/Templates")) },
  { path: "packages", label: "Client Packages", group: "Installers", icon: IconBox, component: lazy(() => import("./pages/deploy/Packages")) },
  { path: "installers", label: "MSI Installers", group: "Installers", icon: IconPackage, component: lazy(() => import("./pages/deploy/Installers")), keywords: "setup.exe" },
];

export const serverBase = (id: number) => `/servers/${id}`;
export const hubBase = (id: number, hub: string) => `/servers/${id}/hubs/${encodeURIComponent(hub)}`;
export const deployBase = "/deploy";
/** First deploy page, used when /deploy is opened. */
export const deployIndex = "hubs";
export const sectionPath = (base: string, s: Section) => (s.path ? `${base}/${s.path}` : base);
