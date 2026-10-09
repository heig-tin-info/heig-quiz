/**
 * Today's session, one card at a time (F-DRILL-03, ADR-041 §6), and its end.
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
 * question is on screen and when it is not (`POST …/shown`). Those reports
 * can only shorten the time counted (ADR-041 §11) — which is why the hidden
 * one must not be lost: an interval left open is credited up to the idle cap.
 *
 * Under the answer, before the correction, the student may say how sure they
 * are (ADR-085): five options, nothing selected, keys 0 to 4, never required.
 * It is sent with the answer and changes nothing of the rating; after the
 * correction one line says it back, highlighted when the student was sure
 * and wrong.
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
import { AlertTriangle, CheckCircle2, CircleDot, Eye, PartyPopper, XCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { DrillCorrectness, DrillDeviceClass, DrillReviewResult, DrillSessionCard } from "@quiz/contracts";
import { DRILL_CONFIDENCE_LEVELS, drillConfidenceOutcome, type DrillConfidence } from "@quiz/domain";

import { useDocumentVisible } from "../attempt/signals";
import { useI18n, useT, type Dict } from "../i18n";
import { drillServeKey } from "../queryKeys";
import { useShortcuts } from "../shortcuts";
import { QuestionReviewHost } from "../questionTypes";
import { isAnswered, QuestionHost } from "../student/QuestionHost";
import {
  Alert,
  Badge,
  Button,
  Card,
  isTyping,
  ProgressSegments,
  QueryError,
  Segmented,
  SegmentedBar,
  Skeleton,
  useNow,
  type BarTone,
  type IconType,
  type Tone,
} from "../ui";
import { answerCard, reportShown, serveCard } from "./api";
import { CONFIDENCE, dueIn } from "./format";

/** How a correctness reads: the verdict's words (the grading's), its badge, its share of the summary bar. */
const CORRECTNESS: Record<
  DrillCorrectness,
  { label: keyof Dict; tone: Tone; bar: BarTone; icon: IconType }
> = {
  right: { label: "grading.verdict.correct", tone: "green", bar: "success", icon: CheckCircle2 },
  partial: { label: "grading.verdict.partial", tone: "amber", bar: "partial", icon: CircleDot },
  wrong: { label: "grading.verdict.wrong", tone: "red", bar: "danger", icon: XCircle },
};

/** The FSRS rating, 1 Again to 4 Easy, in the student's words. */
const RATING = ["drill.rating.1", "drill.rating.2", "drill.rating.3", "drill.rating.4"] as const;

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
  const index = outcomes.length;
  const card = cards[index]!;

  const next = (outcome: DrillOutcome) => {
    const all = [...outcomes, outcome];
    if (all.length >= cards.length) onFinish(all);
    else setOutcomes(all);
  };

  return (
    <div className="mx-auto max-w-180 space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p aria-live="polite" className="text-[13px] font-semibold uppercase tracking-wide text-fg-muted">
            {t("grading.item.position", { n: index + 1, total: cards.length })}
          </p>
          {card.isNew ? <Badge tone="zinc">{t("drill.new")}</Badge> : null}
          <span className="ml-auto text-[13px] text-fg-muted">{card.courseCode}</span>
        </div>
        <ProgressSegments
          label={t("player.progress", { n: index + 1, total: cards.length })}
          segments={cards.map((c, i) => ({
            id: c.id,
            mark: i < index ? "answered" : "unanswered",
            current: i === index,
          }))}
        />
      </div>
      <DrillCard key={card.id} card={card} device={device} last={index === cards.length - 1} onNext={next} />
    </div>
  );
}

/**
 * The visibility reports of one served card (ADR-041 §4). The serve opened
 * the interval; while the card is answerable, each time it comes on screen it
 * is reported shown, and each time it leaves — the tab hidden, the page left,
 * a remount — it is reported hidden, unless the answer already closed it.
 * One effect per state, so StrictMode's remount ends on "shown".
 */
function useShownReports(cardId: string, active: boolean, settled: { current: boolean }) {
  const visible = useDocumentVisible();
  useEffect(() => {
    if (!active || !visible) return;
    const send = (shown: boolean) => void reportShown(cardId, shown).catch(() => {});
    send(true);
    return () => {
      if (!settled.current) send(false);
    };
  }, [cardId, active, visible, settled]);
}

function DrillCard({
  card,
  device,
  last,
  onNext,
}: {
  card: DrillSessionCard;
  device: DrillDeviceClass;
  last: boolean;
  onNext: (outcome: DrillOutcome) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const now = useNow(60_000);
  const [answer, setAnswer] = useState<unknown>(null);
  const [result, setResult] = useState<DrillReviewResult | null>(null);
  const [confidence, setConfidence] = useState<DrillConfidence | null>(null);
  const settled = useRef(false);
  // A new card and its verdict both start at their top: on a phone the
  // student pressed the button under a long question, and the page would
  // otherwise open on the middle of the next one, or of the key.
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    top.current?.scrollIntoView?.({ block: "start" });
  }, [result]);

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
    mutationFn: () => answerCard(card.id, isAnswered(card.type, answer) ? answer : null, device, confidence),
    onSuccess: (review) => {
      // Before the render that tears the reports down: the answer closed the interval.
      settled.current = true;
      setResult(review);
    },
  });

  const body = () => {
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
          <QueryError title={t("drill.serveFailed")} query={served} />
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
                  rating: t(RATING[result.rating - 1]!),
                  when: dueIn(result.dueAt, now, locale),
                })}
              </p>
            </div>
            <ConfidenceLine correctness={result.correctness} confidence={confidence} />
            <QuestionReviewHost
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
            <Button onClick={() => onNext(result)}>{last ? t("drill.finish") : t("drill.next")}</Button>
          </div>
        </div>
      );
    }

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
        <ConfidencePicker
          value={confidence}
          onChange={setConfidence}
          disabled={submit.isPending}
        />
        {submit.isError ? (
          <Alert tone="danger" icon={AlertTriangle} title={t("drill.answerFailed")}>
            {t("drill.answerFailed.body")}
          </Alert>
        ) : null}
        <div className="flex justify-end">
          {/* One button. With nothing written it still sends — an empty
              answer is a review too (rated Again), and the key follows. */}
          <Button loading={submit.isPending} onClick={() => submit.mutate()}>
            {isAnswered(card.type, answer) ? t("drill.check") : t("drill.reveal")}
          </Button>
        </div>
      </div>
    );
  };

  // The progress line stays in sight above the card it scrolled to.
  return (
    <div ref={top} className="scroll-mt-28">
      {body()}
    </div>
  );
}

/**
 * "How sure are you?" (ADR-085): the five levels as one segmented control,
 * nothing selected until the student picks one, and the digits 0 to 4 as its
 * keys — unless the caret is in a field of the answer, where a digit is part
 * of what is typed. Pressing the selected level's digit again clears it:
 * the question stays optional to the end.
 */
function ConfidencePicker({
  value,
  onChange,
  disabled,
}: {
  value: DrillConfidence | null;
  onChange: (value: DrillConfidence | null) => void;
  disabled: boolean;
}) {
  const t = useT();
  const id = useId();
  useShortcuts([{ keys: "0–4", label: t("drill.confidence.shortcut") }], !disabled);
  useEffect(() => {
    if (disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const target = e.target as HTMLInputElement | null;
      // A radio or a checkbox (the control's own, or a choice of the answer)
      // takes no digit; a text field does.
      if (isTyping(target) && target?.type !== "radio" && target?.type !== "checkbox") return;
      const level = DRILL_CONFIDENCE_LEVELS.find((l) => String(l) === e.key);
      if (level === undefined) return;
      e.preventDefault();
      onChange(level === value ? null : level);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled, value, onChange]);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p id={id} className="text-sm text-fg-muted">
        {t("drill.confidence.question")} <span className="text-fg-faint">({t("drill.confidence.optional")})</span>
      </p>
      {/* The five pills fit 390 px in both languages; narrower, the track
          scrolls inside its row rather than the page. */}
      <div className="max-w-full overflow-x-auto">
        <Segmented<string>
          name={`${id}-confidence`}
          labelledBy={id}
          size="sm"
          value={value === null ? "" : String(value)}
          options={DRILL_CONFIDENCE_LEVELS.map((l) => ({ value: String(l), label: t(CONFIDENCE[l]) }))}
          onChange={(v) => onChange(Number(v) as DrillConfidence)}
          disabled={disabled}
        />
      </div>
    </div>
  );
}

/**
 * The confidence said back after the correction (ADR-085 §3): nothing when it
 * was skipped; the highlight when the student was sure and wrong; a plain
 * line otherwise, "lucky" when they were right with no idea.
 */
function ConfidenceLine({
  correctness,
  confidence,
}: {
  correctness: DrillCorrectness;
  confidence: DrillConfidence | null;
}) {
  const t = useT();
  if (confidence === null) return null;
  const level = t(CONFIDENCE[confidence]);
  switch (drillConfidenceOutcome(correctness, confidence)) {
    case "confident_error":
      return (
        <Alert tone="warning" icon={Eye} title={t("drill.confidence.confidentError")}>
          {t("drill.confidence.confidentError.body", { level })}
        </Alert>
      );
    case "lucky":
      return <p className="text-sm text-fg-muted">{t("drill.confidence.lucky", { level })}</p>;
    default:
      return <p className="text-sm text-fg-muted">{t("drill.confidence.said", { level })}</p>;
  }
}

/** The end of today's session: how it went, and the way back. */
export function DrillSummary({ outcomes, onHome }: { outcomes: DrillOutcome[]; onHome: () => void }) {
  const t = useT();
  const reviews = outcomes.filter((o) => o !== "skipped");
  const count = (c: DrillCorrectness) => reviews.filter((r) => r.correctness === c).length;
  return (
    <Card className="space-y-5 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <PartyPopper aria-hidden className="mt-0.5 size-5 shrink-0 text-fg-faint" />
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-bold leading-snug tracking-tight">{t("drill.done.title")}</p>
          <p className="mt-0.5 text-sm text-fg-muted">
            {reviews.length === 1 ? t("drill.done.body.one") : t("drill.done.body", { n: reviews.length })}
          </p>
        </div>
      </div>
      {reviews.length > 0 ? (
        <div className="space-y-2">
          <SegmentedBar
            parts={(Object.keys(CORRECTNESS) as DrillCorrectness[]).map((c) => ({
              tone: CORRECTNESS[c].bar,
              value: count(c),
              label: t(CORRECTNESS[c].label),
            }))}
          />
          <p className="text-[13px] tabular-nums text-fg-muted">
            {t("drill.done.counts", { right: count("right"), partial: count("partial"), wrong: count("wrong") })}
          </p>
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button onClick={onHome}>{t("drill.done.home")}</Button>
      </div>
    </Card>
  );
}
