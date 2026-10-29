/**
 * "Show the points" in the evaluation preview: the teacher grades the
 * question on screen, with the answer as it stands, without handing the
 * paper in — to check that the key, the partial credit and the negative
 * marking (ADR-026) do what they meant before a student meets them.
 *
 * It is the preview's own grading call (`POST /preview/grade`), sent with
 * the one answer of the question on screen: the server grades it exactly as
 * it grades a hand-in, the evaluation's policies included, and stores
 * nothing. Once asked, the points stay for that question (issue #957): each
 * change of the answer grades it again, debounced, and until the new points
 * arrive the old ones are dimmed beside a spinner — never shown as if they
 * were the new answer's. A failure shows its error in their place, with the
 * button to try again. Another question is another component (its `key` in
 * `EvaluationPreviewPage`): it starts with the button and no points.
 */
import { useMutation } from "@tanstack/react-query";
import { Calculator, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PreviewGradeBody, type PreviewCorrection, type PreviewItemStatus, ANSWER_COORDINATES } from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { Badge, Button, cx } from "../ui";
import { STATUS_LABEL } from "./PreviewCorrection";

/** The pause after the last change of the answer before it is graded again. */
export const REGRADE_DEBOUNCE_MS = 400;

/** The last settled grading, and the answer it was for (compared by reference). */
type Graded = { answer: unknown } & ({ correction: PreviewCorrection } | { error: unknown });

/** No answer sent yet: distinct from `undefined`, a question never opened. */
const NONE = Symbol("none");

export function PreviewPoints({
  evaluationId,
  seed,
  itemId,
  answer,
}: {
  evaluationId: string;
  seed: number;
  itemId: string;
  /** `undefined` for a question never opened: it is worth zero. */
  answer: unknown;
}) {
  const t = useT();
  const [graded, setGraded] = useState<Graded | null>(null);
  const sent = useRef<unknown>(NONE);
  const grade = useMutation({
    mutationFn: (input: unknown) => {
      const answers = input === undefined ? {} : { [itemId]: input };
      return api<PreviewCorrection>(`/app/api/evaluations/${evaluationId}/preview/grade`, {
        method: "POST",
        body: JSON.stringify(PreviewGradeBody.parse({ seed, answers, coordinates: ANSWER_COORDINATES })),
      });
    },
  });

  // Per-call callbacks fire for the latest call only: a slow answer to an
  // older one never overwrites the newer.
  const send = (input: unknown) => {
    sent.current = input;
    grade.mutate(input, {
      onSuccess: (correction) => setGraded({ answer: input, correction }),
      onError: (error) => setGraded({ answer: input, error }),
    });
  };

  const shown = graded !== null || grade.isPending;
  useEffect(() => {
    if (!shown || sent.current === answer) return;
    // A click on Show the points meanwhile has sent this answer already.
    const timer = setTimeout(() => sent.current !== answer && send(answer), REGRADE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `send` is rebuilt on every render; the answer alone re-arms the timer.
  }, [shown, answer]);

  const stale = graded !== null && graded.answer !== answer;
  // The button is back after a failure: it then carries the one spinner.
  const retry = graded === null || "error" in graded;
  const item = graded && "correction" in graded ? graded.correction.items.find((i) => i.itemId === itemId) : undefined;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {retry ? (
        <Button variant="ghost" size="sm" onClick={() => send(answer)} loading={grade.isPending || stale}>
          <Calculator /> {t("preview.points.show")}
        </Button>
      ) : null}
      {graded ? (
        // The points change without a click: announced once settled.
        <span
          role="status"
          aria-live="polite"
          aria-busy={stale}
          className={cx("inline-flex items-center gap-1.5 transition-opacity", stale && "opacity-50")}
        >
          {item ? (
            item.status === "graded" && item.points !== null ? (
              <span className="text-[13px] font-semibold tabular-nums">
                {t("preview.points.value", { points: formatPoints(item.points), max: item.maxPoints })}
              </span>
            ) : (
              <Badge tone={item.status === "no_key" || item.status === "manual" ? "zinc" : "amber"}>
                {t(STATUS_LABEL[item.status as Exclude<PreviewItemStatus, "graded">])}
              </Badge>
            )
          ) : "error" in graded ? (
            <span className="text-[13px] text-danger">{apiErrorMessage(graded.error, t("preview.points.failed"))}</span>
          ) : null}
          {stale && !retry ? <Loader2 aria-hidden className="size-3.5 animate-spin text-fg-muted" /> : null}
        </span>
      ) : null}
    </div>
  );
}
