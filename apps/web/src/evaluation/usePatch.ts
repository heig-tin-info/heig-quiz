import { useMutation, useQueryClient } from "@tanstack/react-query";

import { EvaluationPatch } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { activitiesKey, evaluationsKey } from "../queryKeys";
import { evaluationTarget, type EditTarget } from "./editTarget";

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

/**
 * Renaming an evaluation, wherever it starts: its heading in place
 * (`EvaluationConfig`) or "Rename" in a row's menu of the classroom's list
 * (`ClassroomActivities`). The configuration's own `PATCH` (`useConfigPatch`), the
 * title checked by the route's schema first, then the lists that show the
 * title refreshed. A title stays writable in every state (`WRITABLE_UNDER`),
 * so nothing here asks which one the evaluation is in. `onDone` runs once
 * the write and the refresh landed (the dialog closes then).
 */
export function useRenameEvaluation(id: string, classroomId: string | null) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const patch = useConfigPatch(evaluationTarget(id));
  const rename = (title: string, onDone?: () => void) => {
    const parsed = EvaluationPatch.safeParse({ title });
    if (!parsed.success) return;
    patch.mutate(parsed.data, {
      onSuccess: async () => {
        await Promise.all([
          classroomId ? qc.invalidateQueries({ queryKey: evaluationsKey(classroomId) }) : null,
          qc.invalidateQueries({ queryKey: activitiesKey }),
        ]);
        toast(t("sync.saved"), "success");
        onDone?.();
      },
      onError: toastError("eval.saveFailed"),
    });
  };
  return { rename, pending: patch.isPending };
}
