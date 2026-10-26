import { createElement } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from "@tanstack/react-query";
import { useParams } from "react-router";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangleFilled, IconCircleCheckFilled } from "@tabler/icons-react";
import { ApiError, get, rpc } from "./api";
import type { Catalog, FleetSummary, MethodInfo, Server } from "./types";
import { confirmRpc, isConfirmCancelled, type ConfirmOptions } from "../design/ConfirmDialog";

export function useCatalog() {
  return useQuery({ queryKey: ["catalog"], queryFn: () => get<Catalog>("/api/catalog"), staleTime: Infinity });
}

/** Catalog entry of one RPC method (risk, area, docs). */
export function useMethod(method: string): MethodInfo | undefined {
  return useCatalog().data?.methods[method];
}

export function useServers() {
  return useQuery({ queryKey: ["servers"], queryFn: () => get<Server[]>("/api/servers"), refetchInterval: 15_000 });
}

export function useServer(id: number | string | undefined) {
  return useQuery({
    queryKey: ["server", Number(id)],
    queryFn: () => get<Server>(`/api/servers/${id}`),
    enabled: id !== undefined && Number.isFinite(Number(id)),
    refetchInterval: 15_000,
  });
}

export function useFleet() {
  return useQuery({ queryKey: ["fleet-summary"], queryFn: () => get<FleetSummary>("/api/fleet/summary"), refetchInterval: 15_000 });
}

/** Route params for server / hub scoped pages. */
export function useScope() {
  const p = useParams();
  return { serverId: Number(p.serverId), hub: p.hub ? decodeURIComponent(p.hub) : undefined };
}

/** Query a read-only SoftEther RPC. Key includes server + method + params so pages share cache. */
export function useRpc<T = Record<string, any>>(
  serverId: number, method: string, params: Record<string, unknown> = {},
  opts: Partial<UseQueryOptions<T, ApiError>> = {},
) {
  return useQuery<T, ApiError>({
    queryKey: ["rpc", serverId, method, params],
    queryFn: () => rpc<T>(serverId, method, params),
    enabled: Number.isFinite(serverId),
    retry: (count, err) => count < 1 && !(err instanceof ApiError && (err.status < 500 || err.locked || !!err.kind)),
    ...opts,
  });
}

export interface RpcMutationOptions<P, T> {
  /** Toast text on success; false = silent. Default "<Method> succeeded". */
  success?: string | false;
  onSuccess?: (r: T, p: P) => void;
  /**
   * Confirmation before the call. Methods the catalog marks as "danger" are confirmed automatically
   * with a built-in message; pass options (or a function of the params) to customise it,
   * or `false` when the page already asked (e.g. inside a ConfirmButton).
   * Passing options also forces a confirmation for write methods.
   */
  confirm?: false | ConfirmOptions | ((params: P) => ConfirmOptions);
}

/**
 * Mutation for a state-changing SoftEther RPC. Confirms dangerous methods first; on success
 * invalidates all RPC queries of the same server and shows a toast. When the user cancels the
 * confirmation the mutation rejects with a ConfirmCancelled error, which is never toasted
 * (check with isConfirmCancelled() if you await mutateAsync).
 */
export function useRpcMutation<P extends Record<string, unknown> = Record<string, unknown>, T = Record<string, any>>(
  serverId: number, method: string, opts: RpcMutationOptions<P, T> = {},
) {
  const qc = useQueryClient();
  const catalog = useCatalog();
  return useMutation<T, ApiError, P>({
    mutationFn: async (params) => {
      const info = catalog.data?.methods[method];
      const custom = typeof opts.confirm === "function" ? opts.confirm(params) : opts.confirm;
      if (opts.confirm !== false && (custom || info?.risk === "danger")) {
        const server = qc.getQueryData<Server>(["server", serverId]);
        await confirmRpc(method, params, { server, info, override: custom || undefined });
      }
      return rpc<T>(serverId, method, params);
    },
    onSuccess: (r, p) => {
      void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
      void qc.invalidateQueries({ queryKey: ["server", serverId] });
      if (opts.success !== false) notifySuccess(opts.success ?? `${method} succeeded`);
      opts.onSuccess?.(r, p);
    },
    onError: (e) => { if (!isConfirmCancelled(e)) notifyError(e, `${method} failed`); },
  });
}

export function notifyError(e: unknown, title?: string) {
  if (isConfirmCancelled(e)) return;
  notifications.show({
    color: "red",
    title: title ?? "Something went wrong",
    message: e instanceof Error ? e.message : String(e),
    autoClose: 8000,
    icon: createElement(IconAlertTriangleFilled, { size: 16 }),
  });
}

export function notifySuccess(message: string, title?: string) {
  notifications.show({ color: "green", title, message, autoClose: 3500, icon: createElement(IconCircleCheckFilled, { size: 16 }) });
}

/** Capabilities of the server (GetCaps), as a name -> value map. */
export function useCaps(serverId: number) {
  const q = useRpc<{ CapsList?: { CapsName_str: string; CapsValue_u32: number }[] }>(serverId, "GetCaps", {}, { staleTime: 5 * 60_000 });
  const map = new Map<string, number>();
  for (const c of q.data?.CapsList ?? []) map.set(c.CapsName_str, c.CapsValue_u32);
  return { ...q, caps: map, has: (name: string) => (map.get(name) ?? 0) !== 0 };
}

/** Invalidate everything the server scope shows (toolbar Refresh). */
export function useRefreshServer() {
  const qc = useQueryClient();
  return (serverId: number) => {
    void qc.invalidateQueries({ queryKey: ["rpc", serverId] });
    void qc.invalidateQueries({ queryKey: ["server", serverId] });
  };
}

/** Label for an enum value using the catalog (falls back to the raw number). */
export function enumLabel(catalog: Catalog | undefined, enumName: string, value: number | undefined, pretty?: Record<number, string>): string {
  if (value === undefined || value === null) return "–";
  if (pretty?.[value]) return pretty[value];
  const v = catalog?.enums[enumName]?.values.find((x) => x.value === value);
  return v ? v.key : String(value);
}

/** Catalog doc for a field of a type, used as input descriptions. */
export function fieldDoc(catalog: Catalog | undefined, typeName: string, field: string): string | undefined {
  return catalog?.types[typeName]?.fields.find((f) => f.name === field)?.doc || undefined;
}
