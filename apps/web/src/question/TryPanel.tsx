import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, FlaskConical, Play } from "lucide-react";
import { useEffect, useState } from "react";

import { type MachineReason, type PreviewResult, type TryResult } from "@quiz/contracts";
import type {
  CodeAnswer,
  CodeImageAnswer,
  CodeImageStudent,
  CodeRunOptions,
  CodeRunStage,
  CodeStudent,
} from "@quiz/qt-code/client";

import { api, apiErrorMessage } from "../api";
import { AiJustification } from "../grading/AiJustification";
import { machineReason } from "../grading/labels";
import { canRunManually, runCode, runCodeImage } from "../runner/codeRun";
import { useT, type Dict, type TFunction } from "../i18n";
import { QuestionReviewHost } from "../questionTypes";
import { emptyAnswerOf, QuestionHost } from "../student/QuestionHost";
import { Alert, Button, Card, EmptyState, QueryError, SectionHeading, Skeleton } from "../ui";
import { EditorExpandLayer } from "./EditorExpandLayer";
import { questionPreviewQuery } from "./previewQuery";

/**
 * The teacher's rehearsal (F-QST-09): answer your own question, see the
 * grading, publish with your eyes open. Nothing is persisted — `POST /try`
 * grades in process and stores nothing.
 *
 * The panel plays the REAL student view (`POST /preview`, seed 0) through
 * the student's own host (`QuestionHost`) and the type's own `Player`, and
 * shows the verdict through its `Review`: what the teacher rehearses is what
 * a student will get, not a second rendering written for this screen.
 *
 * `code` degrades instead of failing: with `RUNNER_MODE=stub` — the default
 * on a machine without a container engine (decision D14) — the answer comes
 * back `runner_unavailable`, and that is a message, not an error state.
 *
 * Its "Run" button, on the other hand, is live even there when the question
 * says `runtime: "runno"`: the browser runs the teacher's own trial, exactly
 * as it will run the student's (ADR-015). Grading stays the server's.
 *
 * An essay or a diagram with a rubric comes back as the MODEL's proposal
 * when the server has one (ADR-063, amendment of 2026-10-23): the points it
 * would give, its confidence, its justification and its points per
 * criterion — what the author reads to test the rubric. It stays a
 * proposal (issue #267): the review shows no score, the heading says whose
 * points these are.
 */
export function TryPanel({
  questionId,
  type,
  source = "draft",
}: {
  questionId: string;
  type: string;
  /** The draft, or a published version number. */
  source?: "draft" | number;
}) {
  const t = useT();
  const [answer, setAnswer] = useState<unknown>(null);

  const preview = useQuery<PreviewResult>({
    ...questionPreviewQuery(questionId, source),
  });

  const student = preview.data?.student;
  // A fresh student view resets the answer: the empty answer of a type is
  // derived from it (a code question seeds its editable regions).
  useEffect(() => {
    if (student !== undefined) setAnswer(emptyAnswerOf(type, student));
  }, [student, type]);

  const grade = useMutation<TryResult>({
    mutationFn: () =>
      api(`/app/api/questions/${questionId}/try`, {
        method: "POST",
        body: JSON.stringify({ source, answer }),
      }),
  });

  if (preview.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (preview.isError) {
    return (
      <Alert tone="warning" icon={AlertTriangle} title={t("question.try.invalid")}>
        {apiErrorMessage(preview.error, t("question.previewFailed"))}
      </Alert>
    );
  }

  const result = grade.data;
  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <SectionHeading
          title={t("question.try.title")}
          // A parameterized question is tried on the first of its five draws
          // (ADR-056 §8): the server says which, and the hint says so.
          description={preview.data?.parameterized ? t("question.try.hintFirstDraw") : undefined}
        />
        {/*
         * `circuit` gets no `onSimulate` here, and its player hides the
         * button accordingly. The API has no route that simulates a question
         * OUTSIDE an attempt — `POST /attempts/:id/simulate` is the only one,
         * and this panel has no attempt — so offering the button would be
         * offering something nothing can serve, exactly as the `code` branch
         * below has no backend run. The teacher's own check is "Simulate the
         * reference" on the edit tab, which posts to `POST /questions/:id/try`.
         */}
        <QuestionHost
          type={type}
          student={student}
          answer={answer}
          onChange={setAnswer}
          readOnly={false}
          // The teacher's expand layer: the Try tab draws in it.
          Expand={EditorExpandLayer}
          {...(type === "code" && student !== undefined
            ? {
                allowManualRun: canRunManually(student as CodeStudent),
                testsPrimary: false,
                onRun: (value: unknown, options?: unknown) =>
                  runCode({
                    student: student as CodeStudent,
                    answer: value as CodeAnswer,
                    /*
                     * There is no backend run in this panel: the API grades a
                     * whole answer here (`POST /questions/:id/try`) and has no
                     * route that runs one. So the browser runner serves it, or
                     * nothing does — which is one line, not an error.
                     */
                    backend: async () => "unavailable" as const,
                    options: options as CodeRunOptions | undefined,
                  }),
              }
            : {})}
          {...(type === "codeimage" && student !== undefined
            ? {
                // The same reason as `code`: no route runs a question outside
                // an attempt, so only the browser runner can draw here.
                onRun: (value: unknown, options?: unknown) =>
                  runCodeImage({
                    student: student as CodeImageStudent,
                    answer: value as CodeImageAnswer,
                    backend: async () => "unavailable" as const,
                    options: options as { onStage?: (stage: CodeRunStage) => void } | undefined,
                  }),
              }
            : {})}
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {/*
           * For `code`, grading IS running the tests — every case, the hidden
           * ones included — so the one primary action says so. The player's
           * own buttons above stay a student's: visible cases, compile, free
           * try. Every other type keeps "Grade my answer".
           */}
          <Button onClick={() => grade.mutate()} loading={grade.isPending}>
            {type === "code" ? (
              <>
                <FlaskConical /> {t("question.try.runTests")}
              </>
            ) : (
              <>
                <Play /> {t("question.try.grade")}
              </>
            )}
          </Button>
          {result ? (
            <Button
              variant="secondary"
              onClick={() => {
                grade.reset();
                setAnswer(emptyAnswerOf(type, student));
              }}
            >
              {t("question.try.again")}
            </Button>
          ) : null}
          {type === "code" ? (
            <span className="text-[13px] text-fg-muted">{t("question.try.runTestsHint")}</span>
          ) : null}
        </div>
      </Card>

      {grade.isError ? (
        <QueryError
          title={t("question.try.failed")}
          error={grade.error}
          onRetry={() => grade.mutate()}
          retrying={grade.isPending}
        />
      ) : result === undefined ? (
        <Card>
          <EmptyState icon={FlaskConical} title={t("question.try.empty.title")} className="py-10">
            {t("question.try.empty.body")}
          </EmptyState>
        </Card>
      ) : result.status === "runner_unavailable" ? (
        <Alert tone="warning" icon={AlertTriangle} title={t("question.try.runnerUnavailable")}>
          {t("question.try.runnerUnavailableBody")}
        </Alert>
      ) : (
        <Card className="space-y-4 p-5">
          <SectionHeading
            title={tryHeading(t, result)}
            description={
              result.confidence
                ? t("question.try.aiConfidence", { level: t(`grading.filter.confidence.${result.confidence}`) })
                : undefined
            }
          />
          {/* Why the grader only proposed: usually the question's fault (#267),
              or the model could not be asked. */}
          {result.manual && result.comment ? (
            <p className="text-[13px] text-warning">{tryReason(t, result.comment)}</p>
          ) : null}
          <AiJustification details={result.details} />
          <QuestionReviewHost
            type={type}
            student={student}
            answer={answer}
            solution={result.solution}
            details={result.details}
            points={result.manual ? null : result.points}
            maxPoints={result.maxPoints}
            audience="teacher"
          />
        </Card>
      )}
    </div>
  );
}

/**
 * The verdict line: a score, or — a proposal not being a score, since a
 * person grades it (issue #267) — whose proposal it is: the model's, which
 * says its points as the model's (`confidence` comes with them), or nobody's.
 */
function tryHeading(t: TFunction, result: Extract<TryResult, { status: "graded" }>): string {
  const points = { points: result.points, max: result.maxPoints };
  if (!result.manual) return t("question.try.score", points);
  return result.confidence ? t("question.try.aiProposal", points) : t("question.try.manual");
}

/** The LLM's reasons, worded for a try (no class to grade by hand); the rest as the grading panel words them. */
const TRY_REASONS: Partial<Record<MachineReason, keyof Dict>> = {
  llm_budget: "question.try.reason.llm_budget",
  llm_not_configured: "question.try.reason.llm_not_configured",
  grader_error: "question.try.reason.grader_error",
};

function tryReason(t: TFunction, comment: string): string {
  const key = TRY_REASONS[comment as MachineReason];
  return key ? t(key) : machineReason(t, comment);
}
