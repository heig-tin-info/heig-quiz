/**
 * The ready screen (ADR-076, issue #525): a running evaluation the student
 * opened and has not started.
 *
 * One primary action, "Start", and the sentence that announces what it does —
 * the clock of N minutes, a deadline, or no clock. "Later" is the quiet way
 * back. Opening a link starts nothing: no attempt row exists, the student is
 * not counted present, and this screen opens no stream. Pressing Start calls
 * `POST /evaluations/:id/attempt/start` and hands its answer to the entry
 * query, so the route renders the player (keyed on the attempt).
 *
 * It holds the evaluation's rules (the lobby's rules card) and no question
 * content (invariant 4).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { AttemptEntry, ReadyView } from "@quiz/contracts";

import { ApiError, api } from "../api";
import { useT, type TFunction } from "../i18n";
import { useErrorToast } from "../notify";
import { attemptEntryKey } from "../queryKeys";
import { Button } from "../ui";
import { isoDateTime } from "../ui/dates";
import { RulesCard, minutesWithBonus } from "./Lobby";

/** What Start announces: the clock of N minutes, a closing instant, or no clock. */
function clockSentence(view: ReadyView, t: TFunction): string {
  const { timing, announcedDurationS: durationS, closesAt } = view.evaluation;
  if (timing === "duration" && durationS !== null) {
    const n = minutesWithBonus(durationS, view.timeBonusPercent);
    return view.timeBonusPercent > 0
      ? t("ready.clock.durationBonus", { n, pct: view.timeBonusPercent })
      : t("ready.clock.duration", { n });
  }
  if (timing === "deadline" && closesAt !== null) {
    return t("ready.clock.deadline", { when: isoDateTime(closesAt) });
  }
  return t("ready.clock.manual");
}

export function Ready({
  view,
  onLater,
}: {
  view: ReadyView;
  /** Back home (the station's own screen on a kiosk). */
  onLater: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const { id, title } = view.evaluation;

  const start = useMutation({
    mutationFn: () =>
      api<AttemptEntry>(`/app/api/evaluations/${id}/attempt/start`, { method: "POST" }),
    // The entry query now holds the attempt (or the lobby, if the evaluation
    // went back to waiting): the route renders what it says.
    onSuccess: (entry) => qc.setQueryData(attemptEntryKey(id), entry),
    onError: (error) => {
      toastError("ready.startFailed")(error);
      // A refusal the server spells out (not open any more) has its screen on
      // the entry route: ask it again rather than leave a dead button.
      if (error instanceof ApiError && error.status < 500) {
        void qc.invalidateQueries({ queryKey: attemptEntryKey(id) });
      }
    },
  });

  const clock = clockSentence(view, t);

  return (
    <main className="mx-auto flex w-full max-w-160 flex-col items-center px-4 py-10 text-center sm:px-6">
      <p className="text-[13px] font-medium uppercase tracking-wide text-fg-faint">
        {t("ready.title")}
      </p>
      <h1 className="mt-2 text-[28px] font-bold leading-tight tracking-[-0.02em]">{title}</h1>

      <RulesCard view={view} className="mt-8" />

      <p id="ready-clock" className="mt-8 text-base text-fg-muted">
        {clock}
      </p>
      <Button
        size="lg"
        className="mt-4"
        aria-describedby="ready-clock"
        loading={start.isPending}
        onClick={() => start.mutate()}
      >
        {t("ready.start")}
      </Button>
      <Button variant="ghost" size="sm" className="mt-2" onClick={onLater}>
        {t("ready.later")}
      </Button>
    </main>
  );
}
