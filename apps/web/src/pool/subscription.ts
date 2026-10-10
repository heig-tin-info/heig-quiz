/**
 * A teacher's subscription to a public pool (ADR-095): one hook for the two
 * writes, so the pool screen's Subscribe and the Settings tab's Unsubscribe
 * refresh the same reads (the shelf, the pool, its sharing sheet).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../api";
import { useErrorToast } from "../notify";
import { poolKey, poolMembersKey, poolsKey } from "../queryKeys";

export function usePoolSubscription(poolId: string) {
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const done = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: poolsKey }),
      qc.invalidateQueries({ queryKey: poolKey(poolId) }),
      qc.invalidateQueries({ queryKey: poolMembersKey(poolId) }),
    ]);
  };
  const subscribe = useMutation({
    mutationFn: () => api(`/app/api/pools/${poolId}/subscription`, { method: "PUT" }),
    onSuccess: done,
    onError: toastError("error.save"),
  });
  const unsubscribe = useMutation({
    mutationFn: () => api(`/app/api/pools/${poolId}/subscription`, { method: "DELETE" }),
    onSuccess: done,
    onError: toastError("error.save"),
  });
  return { subscribe, unsubscribe };
}
