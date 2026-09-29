import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle, EyeOff, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";

import type { PreviewSolution } from "@quiz/contracts";

import { apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { QuestionReviewHost } from "../questionTypes";
import { emptyAnswerOf, QuestionHost } from "../student/QuestionHost";
import { Alert, Button, Card, Skeleton } from "../ui";

/** One question as the server built it for a student (`studentView`, invariant 4). */
export interface StudentQuestion {
  type: string;
  student: unknown;
  points: number;
}

/**
 * Where a preview's key comes from, asked for on the "Show answers" click
 * only: the preview itself never carries it.
 */
export interface SolutionSource {
  queryKey: readonly unknown[];
  queryFn: () => Promise<PreviewSolution>;
}

/**
 * The types whose key reads plainly in their review without a grading: the
 * right choices, the expected blanks. The others come one by one, once their
 * review is known to draw something useful from the key alone.
 */
const SHOWS_ANSWERS = new Set(["mcq", "cloze"]);

/**
 * The body of a teacher's preview of ONE question: its points, then the
 * student's rendering through the player's own `QuestionHost` — never a
 * second rendering. Shared by the preview of an item of the evaluation
 * (`ItemPreviewSheet`) and by the picker's reading pane (`AddQuestionsSheet`).
 *
 * The teacher may type in the fields — a preview one cannot touch does not
 * answer "does this read right?" — and the answer lives here and dies with
 * the component. Nothing is saved, run or graded.
 */
export function PreviewedQuestion({
  query,
  solution,
}: {
  query: UseQueryResult<StudentQuestion>;
  solution: SolutionSource;
}) {
  const t = useT();
  if (query.isLoading) {
    return (
      <Card className="space-y-3 p-5 sm:p-6">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }
  if (query.isError || !query.data) {
    return (
      <Alert tone="warning" icon={AlertTriangle} title={t("question.previewFailed")}>
        {apiErrorMessage(query.error, t("error.server"))}
      </Alert>
    );
  }
  return <PlayedQuestion view={query.data} solution={solution} />;
}

/**
 * A loaded preview, played. "Show answers" REPLACES the player with the
 * type's own review of what the teacher answered, beside the key a student
 * reads once it is shown — nothing is graded, so there is no verdict. "Hide
 * answers" gives the player back with the answer as it was: it lives here,
 * above the swap. The key is hidden on every open and on every new question,
 * so a preview on a classroom's projector never shows it unasked.
 */
export function PlayedQuestion({
  view,
  solution,
  label,
}: {
  view: StudentQuestion;
  solution: SolutionSource;
  /** The player's own line above the question, where the surface wants it. */
  label?: string;
}) {
  const t = useT();
  const [answer, setAnswer] = useState<unknown>(() => emptyAnswerOf(view.type, view.student));
  const [shown, setShown] = useState(false);
  const { type, student } = view;
  useEffect(() => {
    setAnswer(emptyAnswerOf(type, student));
    setShown(false);
  }, [type, student]);
  // Fresh on every "Show": a draft may have changed in the editor meanwhile.
  const key = useQuery({ ...solution, enabled: shown });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {label ? (
          <p className="text-[13px] font-semibold uppercase tracking-wide text-fg-muted">{label}</p>
        ) : null}
        <span className="flex-1" />
        <p className="text-[13px] text-fg-muted">
          {view.points === 1 ? t("player.point") : t("player.points", { n: view.points })}
        </p>
        {SHOWS_ANSWERS.has(view.type) ? (
          <Button variant="secondary" size="sm" aria-pressed={shown} onClick={() => setShown(!shown)}>
            {shown ? <EyeOff /> : <KeyRound />}
            {shown ? t("preview.answers.hide") : t("preview.answers.show")}
          </Button>
        ) : null}
      </div>
      <Card className="p-5 sm:p-6">
        {!shown ? (
          <QuestionHost
            type={view.type}
            student={view.student}
            answer={answer}
            onChange={setAnswer}
            readOnly={false}
          />
        ) : key.isError ? (
          <Alert tone="warning" icon={AlertTriangle} title={t("preview.answers.failed")}>
            {apiErrorMessage(key.error, t("error.server"))}
          </Alert>
        ) : !key.data || key.isFetching ? (
          <div className="space-y-3">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <QuestionReviewHost
            t={t}
            type={view.type}
            student={view.student}
            answer={answer}
            solution={key.data.solution}
            details={null}
            points={null}
            maxPoints={view.points}
            audience="student"
          />
        )}
      </Card>
    </div>
  );
}
