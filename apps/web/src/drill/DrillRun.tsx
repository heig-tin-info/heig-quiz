/**
 * Today's session, one card at a time (F-DRILL-03, ADR-041 §6).
 *
 * A card is served (`POST …/serve`: a new seed, the question through
 * `studentView`, invariant 4) and drawn by its type's OWN student player,
 * through the client registry the attempt uses (`QuestionHost`) — the drill
 * has no rendering path of its own. The answer is graded by the server, which
 * rates it and reschedules the card; the page then shows the correctness, the
 * rating, the next review and the key, through the type's own `Review`
 * (`QuestionReviewHost`), with a single primary "Next".
 *
 * The clock is the server's (invariant 5). The page only reports when the
 * question is on screen and when it is not (`POST …/shown`): the tab hidden,
 * the page left. Nothing it sends can lengthen the time counted (ADR-041 §11).
 *
 * The four decisions:
 *   - Type: the progress line and the question; the verdict is a badge and
 *     one line, the key is the type's own review.
 *   - Color: one accent, the primary button (Check, then Next). The verdict
 *     speaks in the semantic tones, never in accent.
 *   - Space: 16 inside the card, 24 between the card and the action.
 *   - Finish: one card on the canvas, hairlines, no shadow.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleDot, WifiOff, XCircle } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { DrillCorrectness, DrillDeviceClass, DrillReviewResult, DrillSessionCard } from "@quiz/contracts";

import { useI18n, useT, type Dict } from "../i18n";
import { drillServeKey } from "../queryKeys";
import { QuestionReviewHost } from "../questionTypes";
import { isAnswered, QuestionHost } from "../student/QuestionHost";
import {
  Alert,
  Badge,
  Button,
  Card,
  ProgressSegments,
  QueryError,
  Skeleton,
  useNow,
  type IconType,
  type Tone,
} from "../ui";
import { answerCard, reportShown, serveCard } from "./api";
import { dueIn } from "./format";

export const CORRECTNESS: Record<DrillCorrectness, { label: keyof Dict; tone: Tone; icon: IconType }> = {
  right: { label: "drill.result.right", tone: "green", icon: CheckCircle2 },
  partial: { label: "drill.result.partial", tone: "amber", icon: CircleDot },
  wrong: { label: "drill.result.wrong", tone: "red", icon: XCircle },
};

const RATING: Record<number, keyof Dict> = {
  1: "drill.rating.1",
  2: "drill.rating.2",
  3: "drill.rating.3",
  4: "drill.rating.4",
};

/** What one card of the session came to: its review, or skipped when it could not be served. */
export type DrillOutcome = DrillReviewResult | "skipped";

export function DrillRun({
  cards,
  device,
  onFinish,
}: {
  /** The session as it was when the student started it: a refetch must not reshuffle it. */
  cards: readonly DrillSessionCard[];
  device: DrillDeviceClass;
  onFinish: (outcomes: DrillOutcome[]) => void;
}) {
  const t = useT();
  const [outcomes, setOutcomes] = useState<DrillOutcome[]>([]);
  const index = Math.min(outcomes.length, cards.length - 1);
  const card = cards[index]!;
  const [reviewed, setReviewed] = useState<DrillReviewResult | null>(null);
  // The verdict and each new card start at the top of the run: on a phone the
  // student pressed the button at the bottom of a long question, and the
  // page would otherwise open on the middle of the key.
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    top.current?.scrollIntoView?.({ block: "start" });
  }, [index, reviewed]);

  const next = (outcome: DrillOutcome) => {
    const all = [...outcomes, outcome];
    setReviewed(null);
    if (all.length >= cards.length) onFinish(all);
    else setOutcomes(all);
  };

  return (
    <div ref={top} className="mx-auto max-w-180 space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p aria-live="polite" className="text-[13px] font-semibold uppercase tracking-wide text-fg-muted">
            {t("drill.progress", { n: index + 1, total: cards.length })}
          </p>
          {card.isNew ? <Badge tone="zinc">{t("drill.new")}</Badge> : null}
          <span className="ml-auto text-[13px] text-fg-muted">{card.courseCode}</span>
        </div>
        <ProgressSegments
          label={t("drill.progressLabel", { n: index + 1, total: cards.length })}
          segments={cards.map((c, i) => ({
            id: c.id,
            mark: i < outcomes.length || (i === index && reviewed) ? "answered" : "unanswered",
            current: i === index,
          }))}
        />
      </div>
      <DrillCard
        key={card.id}
        card={card}
        device={device}
        last={index === cards.length - 1}
        onReviewed={setReviewed}
        onNext={next}
      />
    </div>
  );
}

/** `navigator.onLine`, followed. A drill answer sent offline would fail; the page says why first. */
function useOnline(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("online", onChange);
      window.addEventListener("offline", onChange);
      return () => {
        window.removeEventListener("online", onChange);
        window.removeEventListener("offline", onChange);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

/**
 * The visibility reports of one served card (ADR-041 §4): hidden when the
 * tab is, shown again when it comes back, hidden when the page is left with
 * the card unanswered. The serve itself opened the interval. A report that
 * fails is dropped: it can only ever lower the time counted.
 */
function useShownReports(cardId: string, active: boolean, settled: { current: boolean }) {
  useEffect(() => {
    if (!active) return;
    const send = (shown: boolean) => void reportShown(cardId, shown).catch(() => {});
    if (document.visibilityState === "hidden") send(false);
    const onChange = () => send(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => {
      document.removeEventListener("visibilitychange", onChange);
      if (!settled.current) send(false);
    };
  }, [cardId, active, settled]);
}

function DrillCard({
  card,
  device,
  last,
  onReviewed,
  onNext,
}: {
  card: DrillSessionCard;
  device: DrillDeviceClass;
  last: boolean;
  onReviewed: (result: DrillReviewResult) => void;
  onNext: (outcome: DrillOutcome) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const now = useNow(60_000);
  const online = useOnline();
  const [answer, setAnswer] = useState<unknown>(null);
  const [result, setResult] = useState<DrillReviewResult | null>(null);
  const settled = useRef(false);

  const served = useQuery({
    queryKey: drillServeKey(card.id),
    queryFn: () => serveCard(card.id),
    // Serving again before the answer returns the same view (the server
    // keeps the seed); after it, never: the card is done for today.
    enabled: result === null,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  useShownReports(card.id, served.isSuccess && result === null, settled);

  const submit = useMutation({
    mutationFn: () => answerCard(card.id, isAnswered(card.type, answer) ? answer : null, device),
    onSuccess: (review) => {
      // Before the render that tears the reports down: the answer closed the interval.
      settled.current = true;
      setResult(review);
      onReviewed(review);
    },
  });

  if (served.isLoading) {
    return (
      <Card className="space-y-3 p-5">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </Card>
    );
  }
  if (served.isError || !served.data) {
    return (
      <div className="space-y-3">
        <QueryError
          title={t("drill.serveFailed")}
          error={served.error}
          onRetry={() => void served.refetch()}
          retrying={served.isFetching}
        />
        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => onNext("skipped")}>
            {t("drill.skip")}
          </Button>
        </div>
      </div>
    );
  }

  const student = served.data.student;
  if (result) {
    const verdict = CORRECTNESS[result.correctness];
    return (
      <div className="space-y-6">
        <Card className="space-y-4 p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone={verdict.tone} icon={verdict.icon}>
              {t(verdict.label)}
            </Badge>
            <p className="text-sm text-fg-muted">
              {t("drill.result.line", {
                rating: t(RATING[result.rating] ?? "drill.rating.3"),
                when: dueIn(result.dueAt, now, locale),
              })}
            </p>
          </div>
          <QuestionReviewHost
            t={t}
            type={served.data.type}
            student={student}
            answer={isAnswered(card.type, answer) ? answer : null}
            solution={result.solution}
            details={null}
            points={result.points}
            maxPoints={result.maxPoints}
            audience="student"
          />
        </Card>
        <div className="flex justify-end">
          <Button onClick={() => onNext(result)}>
            {last ? t("drill.finish") : t("drill.next")}
          </Button>
        </div>
      </div>
    );
  }

  const answered = isAnswered(card.type, answer);
  return (
    <div className="space-y-6">
      <Card className="p-5 sm:p-6">
        <QuestionHost
          type={served.data.type}
          student={student}
          answer={answer}
          onChange={setAnswer}
          readOnly={submit.isPending}
        />
      </Card>
      {!online ? (
        <Alert tone="warning" icon={WifiOff} title={t("drill.offline.title")}>
          {t("drill.offline.body")}
        </Alert>
      ) : submit.isError ? (
        <Alert tone="danger" icon={AlertTriangle} title={t("drill.answerFailed")}>
          {t("drill.answerFailed.body")}
        </Alert>
      ) : null}
      <div className="flex justify-end">
        {/* One button. With nothing written it still sends — an empty
            answer is a review too (rated Again), and the key follows. */}
        <Button
          loading={submit.isPending}
          disabled={!online}
          onClick={() => submit.mutate()}
        >
          {answered ? t("drill.check") : t("drill.reveal")}
        </Button>
      </div>
    </div>
  );
}
