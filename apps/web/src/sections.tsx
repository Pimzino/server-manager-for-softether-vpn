import { lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import {
  IconGauge, IconPlugConnected, IconStack2, IconCertificate, IconTopologyStar3, IconShieldCheck, IconBrandOpenSource,
  IconWorld, IconArrowsExchange, IconRoute, IconFileText, IconDatabase, IconLink, IconKey, IconTerminal2,
  IconListCheck, IconUsers, IconUsersGroup, IconFilter, IconDevices, IconTable, IconSettings, IconNetwork,
  IconLock, IconBrandWindows, IconMessage, IconAdjustments, IconLicense, IconUserShield, IconPackageExport,
} from "@tabler/icons-react";

export interface Section {
  path: string;
  label: string;
  group: string;
  icon: ReactNode;
  component: LazyExoticComponent<ComponentType>;
  /** Visible to hub-admin-mode connections and hub-scoped users */
  hubAdminOk?: boolean;
}

const i = (C: typeof IconGauge) => <C size={16} />;

export const serverSections: Section[] = [
  { path: "", label: "Overview", group: "Server", icon: i(IconGauge), component: lazy(() => import("./pages/server/Overview")), hubAdminOk: true },
  { path: "hubs", label: "Virtual Hubs", group: "Server", icon: i(IconStack2), component: lazy(() => import("./pages/server/Hubs")), hubAdminOk: true },
  { path: "connections", label: "Connections", group: "Server", icon: i(IconDevices), component: lazy(() => import("./pages/server/Connections")) },
  { path: "listeners", label: "Listeners & ports", group: "Network", icon: i(IconPlugConnected), component: lazy(() => import("./pages/server/Listeners")) },
  { path: "bridges", label: "Local bridges", group: "Network", icon: i(IconArrowsExchange), component: lazy(() => import("./pages/server/Bridges")) },
  { path: "l3", label: "Layer 3 switches", group: "Network", icon: i(IconRoute), component: lazy(() => import("./pages/server/L3Switches")) },
  { path: "ddns", label: "DDNS & VPN Azure", group: "Network", icon: i(IconWorld), component: lazy(() => import("./pages/server/Ddns")) },
  { path: "protocols", label: "OpenVPN / SSTP", group: "Protocols", icon: i(IconBrandOpenSource), component: lazy(() => import("./pages/server/Protocols")) },
  { path: "ipsec", label: "IPsec / L2TP / EtherIP", group: "Protocols", icon: i(IconShieldCheck), component: lazy(() => import("./pages/server/Ipsec")) },
  { path: "wireguard", label: "WireGuard", group: "Protocols", icon: i(IconKey), component: lazy(() => import("./pages/server/WireGuard")) },
  { path: "certificate", label: "Certificate & TLS", group: "Security", icon: i(IconCertificate), component: lazy(() => import("./pages/server/Certificate")) },
  { path: "security", label: "Admin password", group: "Security", icon: i(IconLock), component: lazy(() => import("./pages/server/Security")) },
  { path: "cluster", label: "Clustering", group: "Advanced", icon: i(IconTopologyStar3), component: lazy(() => import("./pages/server/Cluster")) },
  { path: "settings", label: "Server settings", group: "Advanced", icon: i(IconSettings), component: lazy(() => import("./pages/server/Settings")) },
  { path: "logs", label: "Logs & syslog", group: "Advanced", icon: i(IconFileText), component: lazy(() => import("./pages/server/Logs")) },
  { path: "config", label: "Configuration & backups", group: "Advanced", icon: i(IconDatabase), component: lazy(() => import("./pages/server/Config")) },
  { path: "license", label: "License & VLAN", group: "Advanced", icon: i(IconLicense), component: lazy(() => import("./pages/server/License")) },
  { path: "caps", label: "Capabilities", group: "Advanced", icon: i(IconListCheck), component: lazy(() => import("./pages/server/Caps")), hubAdminOk: true },
  { path: "console", label: "API console", group: "Advanced", icon: i(IconTerminal2), component: lazy(() => import("./pages/server/Console")), hubAdminOk: true },
];

export const hubSections: Section[] = [
  { path: "", label: "Status", group: "Hub", icon: i(IconGauge), component: lazy(() => import("./pages/hub/Status")) },
  { path: "settings", label: "Properties", group: "Hub", icon: i(IconSettings), component: lazy(() => import("./pages/hub/Settings")) },
  { path: "options", label: "Admin & ext options", group: "Hub", icon: i(IconAdjustments), component: lazy(() => import("./pages/hub/Options")) },
  { path: "message", label: "Client message", group: "Hub", icon: i(IconMessage), component: lazy(() => import("./pages/hub/Message")) },
  { path: "users", label: "Users", group: "Identity", icon: i(IconUsers), component: lazy(() => import("./pages/hub/Users")) },
  { path: "groups", label: "Groups", group: "Identity", icon: i(IconUsersGroup), component: lazy(() => import("./pages/hub/Groups")) },
  { path: "radius", label: "RADIUS", group: "Identity", icon: i(IconUserShield), component: lazy(() => import("./pages/hub/Radius")) },
  { path: "certs", label: "Trusted CAs & CRL", group: "Identity", icon: i(IconCertificate), component: lazy(() => import("./pages/hub/Certs")) },
  { path: "sessions", label: "Sessions", group: "Traffic", icon: i(IconDevices), component: lazy(() => import("./pages/hub/Sessions")) },
  { path: "tables", label: "MAC & IP tables", group: "Traffic", icon: i(IconTable), component: lazy(() => import("./pages/hub/Tables")) },
  { path: "access", label: "Access lists", group: "Policy", icon: i(IconFilter), component: lazy(() => import("./pages/hub/Access")) },
  { path: "acl", label: "Source IP control", group: "Policy", icon: i(IconBrandWindows), component: lazy(() => import("./pages/hub/AcList")) },
  { path: "cascades", label: "Cascade links", group: "Networking", icon: i(IconLink), component: lazy(() => import("./pages/hub/Cascades")) },
  { path: "securenat", label: "SecureNAT", group: "Networking", icon: i(IconNetwork), component: lazy(() => import("./pages/hub/SecureNat")) },
  { path: "logging", label: "Logging", group: "Networking", icon: i(IconFileText), component: lazy(() => import("./pages/hub/Logging")) },
  { path: "deploy", label: "Client deployment", group: "Clients", icon: i(IconPackageExport), component: lazy(() => import("./pages/hub/Deploy")) },
];
