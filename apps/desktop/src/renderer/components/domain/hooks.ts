// Scope and catalog hooks shared by server and hub pages.
// Roles are gone (whoever runs the app is the administrator), so these hooks no longer return role,
// canWrite, canAdmin, isOperator or isAdmin. The only remaining limit is SoftEther's own hub-admin mode:
// a connection made with a hub's password can't call server-wide RPCs.
import { useCatalog, useRpc, useScope, useServer } from "../../lib/hooks";
import type { HubListItem } from "../../lib/types";
import { hubBase } from "../../sections";

/** Route scope of a hub page. (hub-a/shared useHubAccess, minus roles) */
export function useHubAccess() {
  const { serverId, hub } = useScope();
  const server = useServer(serverId);
  return {
    serverId,
    hub: hub ?? "",
    server,
    /** Connected in hub-admin mode (password of this hub only), so server-admin-only calls fail. */
    hubAdminMode: !!server.data?.hub,
    /** Route of this hub ("/servers/1/hubs/DEFAULT"); append "/users" etc. */
    base: hubBase(serverId, hub ?? ""),
  };
}

/** Connection facts for server pages. (server-b/ui useServerAccess, minus roles) */
export function useServerAccess(serverId: number) {
  const server = useServer(serverId);
  const hubMode = !!server.data?.hub;
  return {
    server,
    /** The connection is in hub-admin mode. */
    hubMode,
    /** Server-wide RPCs are allowed (not hub-admin mode). Replaces the web's isOperator / isAdmin. */
    serverWide: !hubMode,
  };
}

/** Field documentation from the API catalog: useDocs("VpnRpcRadius")("RadiusPort_u32"). */
export function useDocs(typeName: string) {
  const catalog = useCatalog();
  const t = catalog.data?.types[typeName];
  return (field: string, fallback = ""): string => t?.fields.find((f) => f.name === field)?.doc || fallback;
}

/** Enum values from the catalog as Select data (string values), with a fallback list and preferred labels. */
export function useEnumOptions(enumName: string, fallback: { value: number; label: string }[] = []) {
  const catalog = useCatalog();
  const e = catalog.data?.enums[enumName];
  const labels = new Map(fallback.map((f) => [f.value, f.label]));
  const values = e?.values.map((v) => ({ value: v.value, label: labels.get(v.value) ?? v.doc ?? v.key })) ?? fallback;
  return values.map((v) => ({ value: String(v.value), label: v.label }));
}

/** Sorted Virtual Hub names of a server (EnumHub). */
export function useHubNames(serverId: number) {
  const q = useRpc<{ HubList?: HubListItem[] }>(serverId, "EnumHub");
  return { ...q, names: (q.data?.HubList ?? []).map((h) => h.HubName_str).sort((a, b) => a.localeCompare(b)) };
}
