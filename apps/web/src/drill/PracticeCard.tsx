/**
 * One card of practice, shared by today's session (`DrillRun`, ADR-041 §6)
 * and a round of targeted revision (`RevisePage`, ADR-115): the progress
 * line, the question served through `studentView` (invariant 4) and drawn
 * by its type's OWN player (`QuestionHost`), "How sure are you?" under it
 * (ADR-085), then the verdict, one line the caller writes, the confidence
 * said back and the key through the type's own `Review`, with one primary
 * action (Check, then Next).
 *
 * What differs between the two modes is passed in: how a card is served and
 * answered, the result line (the daily rating and next review, or "practice,
 * not counted"), whether the visibility reports are sent (the daily session
 * only: a round has none, ADR-115 §6), and whether this answer is the last.
 * The confidence is the caller's to send or to keep in the browser.
 */
import { useMutation, useQuery, type QueryKey } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, CircleDot, Eye, PartyPopper, XCircle } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { DrillCorrectness, DrillServed } from "@quiz/contracts";
import { DRILL_CONFIDENCE_LEVELS, drillConfidenceOutcome, type DrillConfidence } from "@quiz/domain";

import { useDocumentVisible } from "../attempt/signals";
import { useT, type Dict } from "../i18n";
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
  Skeleton,
  type BarTone,
  type IconType,
  type Segment,
  type Tone,
} from "../ui";
import { CONFIDENCE } from "./format";

/** How a correctness reads: the verdict's words (the grading's), its badge, its share of the summary bar. */
export const CORRECTNESS: Record<
  DrillCorrectness,
  { label: keyof Dict; tone: Tone; bar: BarTone; icon: IconType }
> = {
  right: { label: "grading.verdict.correct", tone: "green", bar: "success", icon: CheckCircle2 },
  partial: { label: "grading.verdict.partial", tone: "amber", bar: "partial", icon: CircleDot },
  wrong: { label: "grading.verdict.wrong", tone: "red", bar: "danger", icon: XCircle },
};

/** What both modes' answers carry: the verdict, the points and the key. */
export interface PracticeResult {
  correctness: DrillCorrectness;
  points: number;
  maxPoints: number;
  solution: unknown;
}

/** "Question 2 of 5", the card's "new" badge, a word on the right, and the strip of segments. */
export function PracticeProgress({
  index,
  segments,
  isNew,
  aside,
}: {
  index: number;
  segments: Segment[];
  isNew: boolean;
  aside: string;
}) {
  const t = useT();
  const total = segments.length;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p aria-live="polite" className="text-[13px] font-semibold uppercase tracking-wide text-fg-muted">
          {t("grading.item.position", { n: index + 1, total })}
        </p>
        {isNew ? <Badge tone="zinc">{t("drill.new")}</Badge> : null}
        <span className="ml-auto text-[13px] text-fg-muted">{aside}</span>
      </div>
      <ProgressSegments label={t("player.progress", { n: index + 1, total })} segments={segments} />
    </div>
  );
}

/**
 * The visibility reports of one served card (ADR-041 §4). The serve opened
 * the interval; while the card is answerable, each time it comes on screen it
 * is reported shown, and each time it leaves — the tab hidden, the page left,
 * a remount — it is reported hidden, unless the answer already closed it.
 * One effect per state, so StrictMode's remount ends on "shown". `report`
 * must be stable for the card (the caller memoizes it on the card's id).
 */
function useShownReports(
  report: ((shown: boolean) => void) | undefined,
  active: boolean,
  settled: { current: boolean },
) {
  const visible = useDocumentVisible();
  useEffect(() => {
    if (!report || !active || !visible) return;
    report(true);
    return () => {
      if (!settled.current) report(false);
    };
  }, [report, active, visible, settled]);
}

export function PracticeCard<R extends PracticeResult>({
  serveKey,
  serve,
  answer: send,
  report,
  line,
  finishes,
  onNext,
  onSkip,
}: {
  serveKey: QueryKey;
  serve: () => Promise<DrillServed>;
  /** The answer (null when nothing was written) and the confidence stated, for the caller to send or keep. */
  answer: (answer: unknown, confidence: DrillConfidence | null) => Promise<R>;
  /** The daily session's visibility reports; absent, none is sent. */
  report?: (shown: boolean) => void;
  /** The line beside the verdict. */
  line: (result: R) => ReactNode;
  /** Whether this answer ends the run: Finish instead of Next. */
  finishes: (result: R) => boolean;
  onNext: (result: R) => void;
  /** The card could not be served: past it. */
  onSkip: () => void;
}) {
  const t = useT();
  const [answer, setAnswer] = useState<unknown>(null);
  const [result, setResult] = useState<R | null>(null);
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
    queryKey: serveKey,
    queryFn: serve,
    // Serving again before the answer returns the same view (the server
    // keeps the seed); after it, never: the card is done for this pass.
    enabled: result === null,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });
  useShownReports(report, served.isSuccess && result === null, settled);

  const answered = served.data ? isAnswered(served.data.type, answer) : false;
  const submit = useMutation({
    mutationFn: () => send(answered ? answer : null, confidence),
    onSuccess: (r) => {
      // Before the render that tears the reports down: the answer closed the interval.
      settled.current = true;
      setResult(r);
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
            <Button variant="secondary" onClick={onSkip}>
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
              <p className="text-sm text-fg-muted">{line(result)}</p>
            </div>
            <ConfidenceLine correctness={result.correctness} confidence={confidence} />
            <QuestionReviewHost
              type={served.data.type}
              student={student}
              answer={answered ? answer : null}
              solution={result.solution}
              details={null}
              points={result.points}
              maxPoints={result.maxPoints}
              audience="student"
            />
          </Card>
          <div className="flex justify-end">
            <Button onClick={() => onNext(result)}>{finishes(result) ? t("drill.finish") : t("drill.next")}</Button>
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
        <ConfidencePicker value={confidence} onChange={setConfidence} disabled={submit.isPending} />
        {submit.isError ? (
          <Alert tone="danger" icon={AlertTriangle} title={t("drill.answerFailed")}>
            {t("drill.answerFailed.body")}
          </Alert>
        ) : null}
        <div className="flex justify-end">
          {/* One button. With nothing written it still sends — an empty
              answer is an answer too (wrong), and the key follows. */}
          <Button loading={submit.isPending} onClick={() => submit.mutate()}>
            {answered ? t("drill.check") : t("drill.reveal")}
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

/** The end of a run, either mode's: a title, one line, what the run came to, and its actions (the primary last). */
export function PracticeSummary({
  title,
  body,
  children,
  actions,
}: {
  title: string;
  body: string;
  children?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <Card className="space-y-5 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <PartyPopper aria-hidden className="mt-0.5 size-5 shrink-0 text-fg-faint" />
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-bold leading-snug tracking-tight">{title}</p>
          <p className="mt-0.5 text-sm text-fg-muted">{body}</p>
        </div>
      </div>
      {children}
      <div className="flex flex-wrap justify-end gap-2">{actions}</div>
    </Card>
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
