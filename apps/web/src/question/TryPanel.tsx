import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, FlaskConical, Play } from "lucide-react";
import { useEffect, useState } from "react";

import type { PreviewResult, TryResult } from "@quiz/contracts";
import type { CodeAnswer, CodeRunOptions, CodeStudent } from "@quiz/qt-code/client";

import { api, apiErrorMessage } from "../api";
import { canRunManually, runCode } from "../runner/codeRun";
import { useT } from "../i18n";
import { emptyAnswerOf, QuestionPlayerHost, QuestionReviewHost } from "../questionTypes";
import { Alert, Button, Card, EmptyState, QueryError, SectionHeading, Skeleton } from "../ui";

/**
 * The teacher's rehearsal (F-QST-09): answer your own question, see the
 * grading, publish with your eyes open. Nothing is persisted — `POST /try`
 * grades in process and stores nothing.
 *
 * The panel plays the REAL student view (`POST /preview`, seed 0) through
 * the type's own `Player`, and shows the verdict through its `Review`: what
 * the teacher rehearses is what a student will get, not a second rendering
 * written for this screen.
 *
 * `code` degrades instead of failing: with `RUNNER_MODE=stub` — the default
 * on a machine without a container engine (decision D14) — the answer comes
 * back `runner_unavailable`, and that is a message, not an error state.
 *
 * Its "Run" button, on the other hand, is live even there when the question
 * says `runtime: "runno"`: the browser runs the teacher's own trial, exactly
 * as it will run the student's (ADR-015). Grading stays the server's.
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
    queryKey: ["question", questionId, "preview", source],
    queryFn: () =>
      api(`/app/api/questions/${questionId}/preview`, {
        method: "POST",
        body: JSON.stringify({ source }),
      }),
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
        <SectionHeading title={t("question.try.title")} description={t("question.try.hint")} />
        {/*
         * `circuit` gets no `onSimulate` here, and its player hides the
         * button accordingly. The API has no route that simulates a question
         * OUTSIDE an attempt — `POST /attempts/:id/simulate` is the only one,
         * and this panel has no attempt — so offering the button would be
         * offering something nothing can serve, exactly as the `code` branch
         * below has no backend run. The teacher's own check is "Simulate the
         * reference" on the edit tab, which posts to `POST /questions/:id/try`.
         */}
        <QuestionPlayerHost
          t={t}
          type={type}
          student={student}
          answer={answer}
          onChange={setAnswer}
          readOnly={false}
          {...(type === "code" && student !== undefined
            ? {
                allowManualRun: canRunManually(student as CodeStudent),
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
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          <Button onClick={() => grade.mutate()} loading={grade.isPending}>
            <Play /> {t("question.try.grade")}
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
        </div>
      </Card>

      {grade.isError ? (
        <QueryError
          title={t("question.try.failed")}
          error={grade.error}
          onRetry={() => grade.mutate()}
          retrying={grade.isPending}
          fallback={t("error.server")}
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
      ) : result.status === "llm_unavailable" ? (
        <Alert tone="warning" icon={AlertTriangle} title={t("question.try.llmUnavailable")} />
      ) : (
        <Card className="space-y-4 p-5">
          <SectionHeading
            title={t("question.try.score", { points: result.points, max: result.maxPoints })}
          />
          <QuestionReviewHost
            t={t}
            type={type}
            student={student}
            answer={answer}
            solution={result.solution}
            details={result.details}
            points={result.points}
            maxPoints={result.maxPoints}
            audience="teacher"
          />
        </Card>
      )}
    </div>
  );
}
