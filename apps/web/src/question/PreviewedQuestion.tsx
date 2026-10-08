import { skipToken, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle, EyeOff, KeyRound } from "lucide-react";
import { useState } from "react";

import type { PreviewSolution } from "@quiz/contracts";

import { apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { emptyAnswerOf, QuestionHost } from "../student/QuestionHost";
import { Alert, Button, Card, NotePanel, Skeleton } from "../ui";
import { EditorExpandLayer } from "./EditorExpandLayer";

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
 * The types whose player marks the key on the question itself
 * (`PlayerProps.answerKey`): the right choices, the expected blanks. The
 * others come one by one, once their player draws the key.
 */
const SHOWS_ANSWERS = new Set(["mcq", "cloze"]);

/**
 * The body of a teacher's preview of ONE question: its points, then the
 * student's rendering through the player's own `QuestionHost` — never a
 * second rendering. Shared by the preview of an item of the evaluation
 * (`ItemPreviewSheet`) and by `QuestionPreview`, the reading pane of the
 * question picker and of the pool screen. "Show answers" is offered only
 * where a `solution` is given: the item preview and the picker, not the pool.
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
  solution?: SolutionSource;
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
 * A loaded preview, played. "Show answers" keeps the player — the question
 * does not move (issue #554) — and hands it the key a student reads once it
 * is shown, which the player marks in place (`PlayerProps.answerKey`), with
 * the question's explanation under it. Nothing is graded, so there is no
 * verdict, and the teacher's answer stays as it was. The key is hidden on
 * every open and on every new question, so a preview on a classroom's
 * projector never shows it unasked.
 *
 * The answer and the shown key belong to ONE question: a caller that swaps
 * the question under a mounted preview remounts it with a `key` per question.
 * A reset after render would leave one render in which the next question's
 * key is fetched unasked.
 */
export function PlayedQuestion({
  view,
  solution,
  label,
  showsAnswers = SHOWS_ANSWERS.has(view.type),
}: {
  view: StudentQuestion;
  /** Where the key comes from; without one, no "Show answers". */
  solution?: SolutionSource;
  /** The player's own line above the question, where the surface wants it. */
  label?: string;
  /**
   * Whether "Show answers" is offered; by default for `SHOWS_ANSWERS`.
   * The draws of a parameterized
   * draft offer it for `short` too: there the teacher checks each draw's
   * computed key WITH its tolerance ("6.85 ± 0.01"), which the values table
   * does not show, while the Try tab shows a short's key only beside the
   * grade of an answer typed (ADR-056 §8).
   */
  showsAnswers?: boolean;
}) {
  const t = useT();
  const [answer, setAnswer] = useState<unknown>(() => emptyAnswerOf(view.type, view.student));
  const [shown, setShown] = useState(false);
  // Fresh on every "Show": a draft may have changed in the editor meanwhile.
  // Not on a refocus, though: the shown key would flash a skeleton each time.
  const key = useQuery({
    queryKey: solution?.queryKey ?? [],
    queryFn: solution?.queryFn ?? skipToken,
    enabled: shown,
    refetchOnWindowFocus: false,
  });
  // A key being fetched again is not shown: the draft may have changed.
  const revealed = shown && key.data && !key.isFetching ? key.data : null;

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
        {solution && showsAnswers ? (
          <Button variant="secondary" size="sm" aria-pressed={shown} onClick={() => setShown(!shown)}>
            {shown ? <EyeOff /> : <KeyRound />}
            {shown ? t("preview.answers.hide") : t("preview.answers.show")}
          </Button>
        ) : null}
      </div>
      <Card className="space-y-4 p-5 sm:p-6">
        <QuestionHost
          type={view.type}
          student={view.student}
          answer={answer}
          onChange={setAnswer}
          readOnly={false}
          Expand={EditorExpandLayer}
          {...(revealed ? { answerKey: revealed.solution } : {})}
        />
        {!shown ? null : key.isError ? (
          <Alert tone="warning" icon={AlertTriangle} title={t("preview.answers.failed")}>
            {apiErrorMessage(key.error, t("error.server"))}
          </Alert>
        ) : !revealed ? (
          <Skeleton className="h-16 w-full" />
        ) : revealed.explanation ? (
          <NotePanel eyebrow={t("question.explanation")}>
            <MarkdownView size="sm" source={revealed.explanation} />
          </NotePanel>
        ) : null}
      </Card>
    </div>
  );
}
