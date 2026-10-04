import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { useParams } from "react-router";
import { notifications } from "@mantine/notifications";
import { ApiError, get, rpc } from "./api";
import type { Catalog, Role, Server } from "./types";

export function useCatalog() {
  return useQuery({ queryKey: ["catalog"], queryFn: () => get<Catalog>("/api/catalog"), staleTime: Infinity });
}

export function useServers() {
  return useQuery({ queryKey: ["servers"], queryFn: () => get<Server[]>("/api/servers"), refetchInterval: 15_000 });
}

export function useServer(id: number | string | undefined) {
  return useQuery({
    queryKey: ["server", Number(id)],
    queryFn: () => get<Server>(`/api/servers/${id}`),
    enabled: id !== undefined,
    refetchInterval: 15_000,
  });
}

/** Route params for server / hub scoped pages. */
export function useScope() {
  const p = useParams();
  return { serverId: Number(p.serverId), hub: p.hub ? decodeURIComponent(p.hub) : undefined };
}

/**
 * Query a read-only SoftEther RPC. Key includes server + method + params so pages share cache.
 */
export function useRpc<T = Record<string, any>>(
  serverId: number, method: string, params: Record<string, unknown> = {},
  opts: Partial<UseQueryOptions<T, ApiError>> = {},
) {
  return useQuery<T, ApiError>({
    queryKey: ["rpc", serverId, method, params],
    queryFn: () => rpc<T>(serverId, method, params),
    enabled: Number.isFinite(serverId),
    retry: (count, err) => count < 1 && !(err instanceof ApiError && err.status < 500),
    ...opts,
  });
}

/**
 * Mutation for a state-changing SoftEther RPC. On success, invalidates all RPC queries of
 * the same server (cheap, keeps every view consistent) and shows a toast.
 */
export function useRpcMutation<P extends Record<string, unknown> = Record<string, unknown>, T = Record<string, any>>(
  serverId: number, method: string, opts: { success?: string | false; onSuccess?: (r: T, p: P) => void } = {},
) {
  const qc = useQueryClient();
  return useMutation<T, ApiError, P>({
    mutationFn: (params) => rpc<T>(serverId, method, params),
    onSuccess: (r, p) => {
      void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
      void qc.invalidateQueries({ queryKey: ["server", serverId] });
      if (opts.success !== false) notifications.show({ color: "green", message: opts.success ?? `${method} succeeded` });
      opts.onSuccess?.(r, p);
    },
    onError: (e) => notifyError(e, method),
  });
}

export function notifyError(e: unknown, title?: string) {
  notifications.show({ color: "red", title: title ?? "Error", message: e instanceof Error ? e.message : String(e), autoClose: 8000 });
}

const RANK: Record<Role, number> = { none: 0, viewer: 1, operator: 2, admin: 3 };
export function can(role: Role | undefined, min: Role) {
  return RANK[role ?? "none"] >= RANK[min];
}

/** Current user's role on the server in scope. */
export function useServerRole(serverId: number): Role {
  const { data } = useServer(serverId);
  return data?.myRole ?? "none";
}

/** Capabilities of the server (GetCaps), as a name -> value map. */
export function useCaps(serverId: number) {
  const q = useRpc<{ CapsList?: { CapsName_str: string; CapsValue_u32: number }[] }>(serverId, "GetCaps", {}, { staleTime: 5 * 60_000 });
  const map = new Map<string, number>();
  for (const c of q.data?.CapsList ?? []) map.set(c.CapsName_str, c.CapsValue_u32);
  return { ...q, caps: map, has: (name: string) => (map.get(name) ?? 0) !== 0 };
}
