import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Hourglass, RotateCcw } from "lucide-react";

import type { FeedbackPending, RetakeStatus, StudentFeedback } from "@quiz/contracts";
import { formatGrade, formatPoints } from "@quiz/domain";

import { api } from "../api";
import { useT, type Dict } from "../i18n";
import type { Route } from "../router";
import { MarkdownView } from "../markdown/MarkdownView";
import { QuestionReviewHost } from "../questionTypes";
import {
  Badge,
  Card,
  EmptyState,
  NotePanel,
  PageSkeleton,
  QueryError,
  Button,
  RelativeTime,
  Stat,
} from "../ui";
import { attemptFeedbackKey } from "../queryKeys";
import { useRetake } from "./retake";

/**
 * What a student sees of their own attempt (F-RES-04).
 *
 * Zen, like the player it follows: one column, one reading order, nothing to
 * decide. There is no primary action on this page on purpose — the student
 * came to read, and the only things they can do from here are elsewhere —
 * with ONE exception: between two attempts of an exercise that takes retakes
 * (F-EVAL-15, issues #120, #121), the page an attempt ends on is where the
 * student decides to try again, so it carries **Try again** — or says, in a
 * line, why there is no other attempt. Whether one is allowed is the server's
 * answer (`retake.refusal`), never recomputed here.
 *
 * What is shown is entirely the server's call. `available: false` carries a
 * reason and NO question content at all (deviation W6-9), and on the other
 * branch the answer, the key, the explanation and the teacher's comment are
 * each present only when the feedback policy let them through. This page
 * never reconstructs one from another.
 */

const PENDING_TITLE: Record<FeedbackPending["reason"], keyof Dict> = {
  results_pending: "feedback.pending.results_pending.title",
  no_feedback: "feedback.pending.no_feedback.title",
  attempt_open: "feedback.pending.attempt_open.title",
  retakes_open: "feedback.pending.retakes_open.title",
};

const PENDING_BODY: Record<FeedbackPending["reason"], keyof Dict> = {
  results_pending: "feedback.pending.results_pending.body",
  no_feedback: "feedback.pending.no_feedback.body",
  attempt_open: "feedback.pending.attempt_open.body",
  retakes_open: "feedback.pending.retakes_open.body",
};

/** Why no other attempt may start, for the refusals a student can meet here. */
const REFUSAL: Partial<Record<RetakeStatus["refusal"] & string, keyof Dict>> = {
  max_attempts: "feedback.retake.maxAttempts",
  closed: "feedback.retake.closed",
  not_open: "feedback.retake.notOpen",
  unfinished: "feedback.retake.unfinished",
};

/**
 * Right after a hand-in the attempt is still being graded (a job, ADR-025):
 * the score is re-read a few times, then left to the hint stream. A question
 * graded by hand keeps it pending for longer than a student waits here.
 */
const SCORE_POLL_MS = 2_500;
const SCORE_POLLS = 8;

/** The one action of the results page between two attempts. */
function RetakeOffer({
  retake,
  navigate,
}: {
  retake: RetakeStatus;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const start = useRetake(navigate);
  if (retake.refusal === null) {
    return (
      <Button
        variant="primary"
        loading={start.pendingFor === retake.evaluationId}
        onClick={() => void start.start(retake.evaluationId, retake.keep)}
      >
        <RotateCcw /> {t("shome.retake")}
      </Button>
    );
  }
  const why = REFUSAL[retake.refusal];
  if (!why) return null;
  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-sm text-fg-muted">{t(why, { max: retake.maxAttempts ?? 0 })}</p>
      {/* The attempt already open is the one thing left to do: resume it. */}
      {retake.refusal === "unfinished" ? (
        <Button
          variant="primary"
          onClick={() => navigate({ view: "attempt", evaluationId: retake.evaluationId })}
        >
          {t("shome.resume")}
        </Button>
      ) : null}
    </div>
  );
}

export function Feedback({
  attemptId,
  navigate,
}: {
  attemptId: string;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const feedback = useQuery<StudentFeedback>({
    queryKey: attemptFeedbackKey(attemptId),
    queryFn: () => api(`/app/api/attempts/${attemptId}/feedback`),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && !data.available && data.score?.pending && query.state.dataUpdateCount < SCORE_POLLS
        ? SCORE_POLL_MS
        : false;
    },
  });

  if (feedback.isLoading) {
    return <PageSkeleton body="summary-and-block" className="mx-auto max-w-180" />;
  }
  if (feedback.isError || !feedback.data) {
    return (
      <div className="mx-auto max-w-180">
        <QueryError
          title={t("feedback.loadFailed")}
          error={feedback.error}
          onRetry={() => void feedback.refetch()}
          retrying={feedback.isFetching}
          fallback={t("error.server")}
        />
      </div>
    );
  }

  const data = feedback.data;

  // The same page header on both branches: a student who opens this from a
  // notification must know what they are looking at before they know whether
  // there is anything in it.
  const header = (released: string | null) => (
    <header>
      <p className="text-[13px] text-fg-muted">{data.evaluation.title}</p>
      <h1 className="mt-1 text-[28px] font-bold leading-tight tracking-[-0.02em]">
        {t("feedback.title")}
      </h1>
      {released ? (
        <p className="mt-1.5 text-sm text-fg-muted">
          {t("feedback.released")} <RelativeTime iso={released} />
        </p>
      ) : null}
    </header>
  );

  if (!data.available) {
    return (
      <div className="mx-auto max-w-180 space-y-8">
        {header(null)}
        {/* F-EVAL-15: between two attempts, the score and nothing else
            (ADR-025); the correction follows once the exercise closes. */}
        {data.score ? (
          <div className="space-y-1.5">
            <Stat
              label={t("feedback.score")}
              value={`${formatPoints(data.score.points)} / ${formatPoints(data.score.totalPoints)}`}
            />
            {data.score.pending ? (
              <p className="text-[13px] text-fg-muted">{t("feedback.scorePending")}</p>
            ) : null}
            {data.retake ? (
              <p className="text-[13px] text-fg-muted">
                {data.retake.maxAttempts === null
                  ? t("shome.attempts", { n: data.retake.attemptCount })
                  : t("shome.attemptsOf", {
                      n: data.retake.attemptCount,
                      max: data.retake.maxAttempts,
                    })}
              </p>
            ) : null}
          </div>
        ) : null}
        <Card>
          <EmptyState
            icon={data.reason === "retakes_open" ? CheckCircle2 : Hourglass}
            title={t(PENDING_TITLE[data.reason])}
            {...(data.retake
              ? { action: <RetakeOffer retake={data.retake} navigate={navigate} /> }
              : {})}
          >
            {t(PENDING_BODY[data.reason], { title: data.evaluation.title })}
          </EmptyState>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-180 space-y-8">
      {header(data.evaluation.releasedAt)}

      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label={t("feedback.grade")} value={formatGrade(data.grade)} />
        <Stat
          label={t("feedback.points")}
          value={`${formatPoints(data.points)} / ${data.totalPoints}`}
        />
      </div>

      {data.items.length === 0 ? (
        <Card>
          <EmptyState icon={Hourglass} title={t("feedback.empty.title")}>
            {t("feedback.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-5">
          {data.items.map((item) => (
            <Card key={item.itemId} className="space-y-4 p-5 sm:p-6">
              <div className="flex items-center gap-3">
                <h2 className="text-base font-bold tracking-tight">
                  {/* 0-based on the wire; the player and the panel both count from 1. */}
                  {t("feedback.question", { n: item.position + 1 })}
                </h2>
                <span className="flex-1" />
                {item.points === null ? (
                  <Badge tone="zinc">{t("feedback.notGraded")}</Badge>
                ) : (
                  <span className="text-[15px] font-semibold tabular-nums">
                    {formatPoints(item.points)} / {item.maxPoints}
                  </span>
                )}
              </div>

              <QuestionReviewHost
                t={t}
                type={item.type}
                student={item.student}
                answer={item.answer}
                solution={item.solution}
                details={item.details}
                points={item.points}
                maxPoints={item.maxPoints}
                audience="student"
              />

              {item.explanation ? (
                <NotePanel eyebrow={t("feedback.explanation")}>
                  <MarkdownView size="sm" source={item.explanation} />
                </NotePanel>
              ) : null}

              {item.comment ? (
                <NotePanel eyebrow={t("feedback.comment")} tone="outlined">
                  <p className="text-sm">{item.comment}</p>
                </NotePanel>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
