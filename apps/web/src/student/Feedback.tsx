import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Hourglass, RotateCcw, type LucideIcon } from "lucide-react";

import type {
  FeedbackPending,
  ItemStanding,
  RetakeScope,
  RetakeStatus,
  ReviewItem,
  StudentFeedback,
} from "@quiz/contracts";
import { formatPoints } from "@quiz/domain";

import { api } from "../api";
import { Grade } from "../Grade";
import { useT, type Dict, type TFunction } from "../i18n";
import type { Route } from "../router";
import {
  Badge,
  Card,
  EmptyState,
  PageSkeleton,
  QueryError,
  Button,
  RelativeTime,
  Stat,
  type Tone,
} from "../ui";
import { attemptFeedbackKey } from "../queryKeys";
import { CopyItem } from "../CopyItem";
import { PendingLine } from "./cards";
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
 * answer (`retake.refusal`), never recomputed here. Once the teacher publishes
 * the correction of such an exercise (ADR-050), the page shows the correction
 * AND keeps that one action.
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
  exam_open: "feedback.pending.exam_open.title",
};

const PENDING_BODY: Record<FeedbackPending["reason"], keyof Dict> = {
  results_pending: "feedback.pending.results_pending.body",
  no_feedback: "feedback.pending.no_feedback.body",
  attempt_open: "feedback.pending.attempt_open.body",
  retakes_open: "feedback.pending.retakes_open.body",
  exam_open: "feedback.pending.exam_open.body",
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

/** "attempts: n of max", under the score or beside a published correction. */
function AttemptCount({ retake }: { retake: RetakeStatus }) {
  const t = useT();
  return (
    <p className="text-[13px] text-fg-muted">
      {retake.maxAttempts === null
        ? t("shome.attempts", { n: retake.attemptCount })
        : t("shome.attemptsOf", { n: retake.attemptCount, max: retake.maxAttempts })}
    </p>
  );
}

/** One retake the results page offers: what it asks again, its tier, its words. */
interface Offer {
  scope: RetakeScope;
  variant: "primary" | "secondary";
  label: string;
}

/**
 * The retakes on offer, ranked (ADR-090). With the standings of the latest
 * attempt (`review`, only sent under the scope `to_review`): redo the
 * questions to review — the primary, counted from the list — and redo
 * everything, secondary; with every question acquired, redoing everything
 * alone, and a line that says why. Without them, Try again.
 */
function offersOf(
  review: readonly ReviewItem[] | undefined,
  t: TFunction,
): { offers: Offer[]; note: string | null } {
  if (review === undefined) {
    return { offers: [{ scope: "all", variant: "primary", label: t("shome.retake") }], note: null };
  }
  const toReview = review.filter((row) => row.standing !== "acquired").length;
  if (toReview === 0) {
    return {
      offers: [{ scope: "all", variant: "primary", label: t("feedback.retake.all") }],
      note: t("feedback.retake.allAcquired"),
    };
  }
  return {
    offers: [
      { scope: "to_review", variant: "primary", label: t("feedback.retake.partial", { n: toReview }) },
      { scope: "all", variant: "secondary", label: t("feedback.retake.all") },
    ],
    note: null,
  };
}

/**
 * The one action of the results page between two attempts — two, ranked,
 * under the scope `to_review` ({@link offersOf}). Every offer goes through
 * the same `useRetake`, so the confirmation of `keep: "last"` applies to each.
 */
function RetakeOffer({
  retake,
  review,
  navigate,
}: {
  retake: RetakeStatus;
  review: readonly ReviewItem[] | undefined;
  navigate: (r: Route) => void;
}) {
  const t = useT();
  const start = useRetake(navigate);
  if (retake.refusal === null) {
    const { offers, note } = offersOf(review, t);
    return (
      <div className="flex flex-col items-center gap-3">
        {note ? <p className="text-sm text-fg-muted">{note}</p> : null}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {offers.map((offer) => (
            <Button
              key={offer.scope}
              variant={offer.variant}
              loading={start.pending?.evaluationId === retake.evaluationId && start.pending.scope === offer.scope}
              onClick={() => void start.start(retake.evaluationId, retake.keep, offer.scope)}
            >
              {offer.variant === "primary" ? <RotateCcw /> : null} {offer.label}
            </Button>
          ))}
        </div>
      </div>
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

const STANDING: Record<ItemStanding, { tone: Tone; icon: LucideIcon; label: keyof Dict }> = {
  acquired: { tone: "green", icon: CheckCircle2, label: "feedback.review.acquired" },
  to_review: { tone: "amber", icon: RotateCcw, label: "feedback.review.to_review" },
  pending: { tone: "zinc", icon: Hourglass, label: "feedback.review.pending" },
};

/**
 * ADR-090: where each question of the attempt stands, in the order the
 * student saw them — a word per question and nothing else, the server's
 * whole answer (`review`). A question awaiting a teacher is not "wrong".
 */
function ReviewList({ review }: { review: readonly ReviewItem[] }) {
  const t = useT();
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">{t("feedback.review.title")}</h2>
      <p className="text-sm text-fg-muted">{t("feedback.review.body")}</p>
      <Card className="p-0">
        <ul className="divide-y divide-line">
          {review.map((row) => {
            const { tone, icon, label } = STANDING[row.standing];
            return (
              <li key={row.itemId} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="text-sm">{t("feedback.review.item", { n: row.rank + 1 })}</span>
                <Badge tone={tone} icon={icon}>
                  {t(label)}
                </Badge>
              </li>
            );
          })}
        </ul>
      </Card>
    </section>
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
      // Right after a hand-in the attempt is still being graded — between two
      // attempts (ADR-025), or with a correction published while the exercise
      // runs (ADR-050), where nothing is released yet and points come in.
      const grading = data
        ? data.available
          ? data.evaluation.releasedAt === null && data.pendingCount > 0
          : (data.score?.pendingCount ?? 0) > 0
        : false;
      return grading && query.state.dataUpdateCount < SCORE_POLLS ? SCORE_POLL_MS : false;
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
            (ADR-025); the correction follows once the exercise closes, or
            once the teacher publishes it (ADR-050). */}
        {data.score ? (
          <div className="space-y-1.5">
            <Stat
              label={t("feedback.score")}
              value={`${formatPoints(data.score.points)} / ${formatPoints(data.score.totalPoints)}`}
            />
            <PendingLine count={data.score.pendingCount} />
            {data.retake ? <AttemptCount retake={data.retake} /> : null}
          </div>
        ) : null}
        <Card>
          <EmptyState
            icon={data.reason === "retakes_open" ? CheckCircle2 : Hourglass}
            title={t(PENDING_TITLE[data.reason])}
            {...(data.retake
              ? { action: <RetakeOffer retake={data.retake} review={data.review} navigate={navigate} /> }
              : {})}
          >
            {/* ADR-090: with the standings below, the score is not all the student reads. */}
            {t(data.review ? "feedback.pending.retakes_open.reviewBody" : PENDING_BODY[data.reason], {
              title: data.evaluation.title,
            })}
          </EmptyState>
        </Card>
        {data.review ? <ReviewList review={data.review} /> : null}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-180 space-y-8">
      {header(data.evaluation.releasedAt)}

      {/* No grade while a question waits for its grading, nor on an
          exercise before its release: the points alone (the server's call). */}
      <div className="space-y-1.5">
        <div className="grid gap-3 sm:grid-cols-2">
          {data.grade !== null ? (
            <Stat label={t("feedback.grade")} value={<Grade value={data.grade} />} />
          ) : null}
          <Stat
            label={t("feedback.points")}
            value={`${formatPoints(data.points)} / ${data.totalPoints}`}
          />
        </div>
        <PendingLine count={data.pendingCount} />
      </div>

      {/* The correction of an exercise published while it runs (ADR-050):
          the retakes go on, so the page still carries the next attempt. */}
      {data.retake ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <AttemptCount retake={data.retake} />
          <RetakeOffer retake={data.retake} review={data.review} navigate={navigate} />
        </div>
      ) : null}
      {/* ADR-090: the offer of a partial retake never comes without its list. */}
      {data.review ? <ReviewList review={data.review} /> : null}

      {data.items.length === 0 ? (
        <Card>
          <EmptyState icon={Hourglass} title={t("feedback.empty.title")}>
            {t("feedback.empty.body")}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-5">
          {data.items.map((item) => (
            <CopyItem key={item.itemId} item={item} audience="student" />
          ))}
        </div>
      )}
    </div>
  );
}
