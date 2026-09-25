/**
 * Starting another attempt on an exercise that allows several (F-EVAL-15,
 * ADR-025) — the ONE implementation behind both places that offer it: the
 * card of the student home and the results page an attempt ends on.
 *
 * Whether a retake is allowed is never decided here: the server says it on
 * the payload each screen already reads (`canRetake` on the card, `refusal`
 * on the feedback), and `POST /evaluations/:id/retake` applies the same rule
 * again (`409 retake_refused`). What lives here is what both screens must do
 * identically:
 *
 *   - under `keep: "last"`, ask first: a retake can LOWER the result, so the
 *     student is told before starting, not after (review of #116);
 *   - on success, make the attempt route open the NEW attempt (issue #120).
 *     `/take/:id` reads `POST /evaluations/:id/attempt` through a cached
 *     query keyed on the evaluation; the entry cached from attempt n (a
 *     submitted attempt) would otherwise be what the route renders first —
 *     the hand-in screen — and the player, bound to that attempt's id, would
 *     never move to attempt n + 1 when the refetch came back. Every entry of
 *     the evaluation is dropped and the retake's own answer seeded in its
 *     place, so the route renders attempt n + 1 at once, blank.
 */
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type { AttemptOrLobby, RetakeKeep } from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast } from "../notify";
import { attemptEntryKey, attemptKey, studentHomeKey } from "../queryKeys";
import type { Route } from "../router";

/** Every student results page (`attemptFeedbackKey`), whichever attempt. */
const anyFeedback = {
  predicate: (q: { queryKey: readonly unknown[] }) =>
    q.queryKey[0] === "attempt" && q.queryKey[2] === "feedback",
};

/** Hands the retake's answer to the attempt route (issue #120). */
function adoptRetake(qc: QueryClient, evaluationId: string, entry: AttemptOrLobby): void {
  // Every access code the route may have been entered with (`["attempt",
  // "enter", id, code]`): a later mount reads the `null` one, and none may
  // still hold attempt n.
  qc.removeQueries({ queryKey: ["attempt", "enter", evaluationId] });
  qc.setQueryData(attemptEntryKey(evaluationId, null), entry);
  if (entry.kind === "attempt") qc.setQueryData(attemptKey(entry.view.attempt.id), entry);
  // The card (count, button) and every results page (attempts taken, whether
  // one more is allowed) changed with the new attempt.
  void qc.invalidateQueries({ queryKey: studentHomeKey });
  void qc.invalidateQueries(anyFeedback);
}

export interface Retake {
  /** Confirms under `keep: "last"`, then starts the attempt and opens it. */
  start: (evaluationId: string, keep: RetakeKeep) => Promise<void>;
  /** The evaluation whose retake is on its way, for the button's spinner. */
  pendingFor: string | null;
}

export function useRetake(navigate: (r: Route) => void): Retake {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toastError = useErrorToast();
  const mutation = useMutation({
    mutationFn: (evaluationId: string) =>
      api<AttemptOrLobby>(`/app/api/evaluations/${evaluationId}/retake`, { method: "POST" }),
    onSuccess: (entry, evaluationId) => {
      adoptRetake(qc, evaluationId, entry);
      navigate({ view: "attempt", evaluationId });
    },
    onError: (error) => {
      // The server refused (`retake_refused`, with its reason) or failed:
      // the screens re-read their payload, which now says why.
      toastError("shome.retakeFailed")(error);
      void qc.invalidateQueries({ queryKey: studentHomeKey });
      void qc.invalidateQueries(anyFeedback);
    },
  });

  const start = async (evaluationId: string, keep: RetakeKeep) => {
    if (
      keep === "last" &&
      !(await confirm({
        title: t("shome.retakeLast.title"),
        message: t("shome.retakeLast.body"),
        confirmLabel: t("shome.retake"),
      }))
    ) {
      return;
    }
    mutation.mutate(evaluationId);
  };

  return { start, pendingFor: mutation.isPending ? (mutation.variables ?? null) : null };
}
