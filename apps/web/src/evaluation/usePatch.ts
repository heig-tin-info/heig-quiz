import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../api";
import type { EditTarget } from "./editTarget";

/**
 * The one writer of a configuration screen, an evaluation's or a template's.
 * Every control sends the same `PATCH` on the target, and the answer is its
 * whole detail (`EvaluationDetail`, `TemplateDetail` with its revision), so
 * the cache is replaced rather than invalidated: the screen never blinks
 * between the click and the refetch, and a `409 locked` leaves the previous
 * value on screen, which is what it still is. What else the write changed
 * (a template's row on its course page) is refreshed.
 *
 * The body is the target's own (`EditTarget<P>`): an evaluation takes an
 * `EvaluationPatch`, a template a patch without dates, code or IP list.
 */
export function useConfigPatch<P>(target: EditTarget<P>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: P) =>
      api<unknown>(target.base, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: async (detail) => {
      qc.setQueryData(target.detailKey, detail);
      await Promise.all(target.alsoKeys.map((queryKey) => qc.invalidateQueries({ queryKey })));
    },
  });
}

/** The writer a screen holds, for the body `P`. */
export type ConfigWriter<P> = ReturnType<typeof useConfigPatch<P>>;
