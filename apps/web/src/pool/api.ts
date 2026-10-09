/**
 * The staff's reads of the pools: the caller's shelf (`GET /pools`) and one
 * pool (`GET /pools/:id`), the key, the URL and the type in one place for
 * every screen that reads them.
 */
import { useQuery } from "@tanstack/react-query";

import type { PoolDetail, PoolSummary } from "@quiz/contracts";

import { api, type ReadOptions } from "../api";
import { poolKey, poolsKey } from "../queryKeys";

/** Every pool the caller reaches, owned or shared with them. */
export function usePools(options: ReadOptions = {}) {
  return useQuery<PoolSummary[]>({
    queryKey: poolsKey,
    queryFn: () => api("/app/api/pools"),
    ...options,
  });
}

/** One pool: its folders, concepts and the caller's role. `undefined` while the id is not known yet: the query waits. */
export function usePool(id: string | undefined, options: ReadOptions = {}) {
  return useQuery<PoolDetail>({
    queryKey: poolKey(id),
    queryFn: () => api(`/app/api/pools/${id}`),
    ...options,
    enabled: id !== undefined && (options.enabled ?? true),
  });
}
