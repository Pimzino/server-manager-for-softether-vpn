// Where the user is: derived from the URL and the route registry. Used by the toolbar, the scope
// navigation, the quick switcher and the window title.
import { useMemo } from "react";
import { useLocation } from "react-router";
import { useServers } from "../lib/hooks";
import type { Server } from "../lib/types";
import { deployBase, deploySections, hubBase, hubSections, serverBase, serverSections, type Section } from "../sections";

export type ScopeKind = "fleet" | "server" | "hub" | "deploy" | "preferences" | "other";

export interface CurrentScope {
  kind: ScopeKind;
  serverId?: number;
  hub?: string;
  server?: Server;
  /** Base path of the scope ("/servers/3", "/servers/3/hubs/SALES", "/deploy"). */
  base: string;
  /** Sections available in this scope (already filtered for hub-admin connections). */
  sections: Section[];
  section?: Section;
}

export function visibleServerSections(server: Server | undefined): Section[] {
  return server?.hub ? serverSections.filter((s) => s.hubAdminOk) : serverSections;
}

function matchSection(pathname: string, base: string, sections: Section[]): Section | undefined {
  const rest = pathname.slice(base.length).replace(/^\//, "");
  const first = rest.split("/")[0] ?? "";
  return sections.find((s) => s.path === first) ?? (first === "" ? sections.find((s) => s.path === "") : undefined);
}

export function scopeOf(pathname: string, servers: Server[] | undefined): CurrentScope {
  const hubM = pathname.match(/^\/servers\/(\d+)\/hubs\/([^/]+)/);
  if (hubM) {
    const serverId = Number(hubM[1]);
    const hub = decodeURIComponent(hubM[2]);
    const base = hubBase(serverId, hub);
    return { kind: "hub", serverId, hub, server: servers?.find((s) => s.id === serverId), base, sections: hubSections, section: matchSection(pathname, base, hubSections) };
  }
  const srvM = pathname.match(/^\/servers\/(\d+)/);
  if (srvM) {
    const serverId = Number(srvM[1]);
    const server = servers?.find((s) => s.id === serverId);
    const base = serverBase(serverId);
    const sections = visibleServerSections(server);
    return { kind: "server", serverId, server, base, sections, section: matchSection(pathname, base, sections) };
  }
  if (pathname.startsWith(deployBase)) {
    return { kind: "deploy", base: deployBase, sections: deploySections, section: matchSection(pathname, deployBase, deploySections) ?? deploySections[0] };
  }
  if (pathname.startsWith("/preferences")) return { kind: "preferences", base: "/preferences", sections: [] };
  if (pathname === "/" || pathname === "") return { kind: "fleet", base: "/", sections: [] };
  return { kind: "other", base: pathname, sections: [] };
}

export function useCurrentScope(): CurrentScope {
  const { pathname } = useLocation();
  const servers = useServers();
  return useMemo(() => scopeOf(pathname, servers.data), [pathname, servers.data]);
}
