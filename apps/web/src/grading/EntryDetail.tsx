import { Check, MessageSquare, PencilLine } from "lucide-react";

import type { GradingEntry, GradingQueueItem } from "@quiz/contracts";

import { useT } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { QuestionReviewHost } from "../questionTypes";
import { Badge, Button, Kbd } from "../ui";
import { HistoryPopover } from "./HistoryPopover";
import { confidenceLabel, confidenceTone, round2, sourceLabel, sourceTone } from "./labels";

/**
 * One answer, open.
 *
 * The verdict is rendered by the question type's own `Review`, handed the
 * grading's `details` — per choice, per matcher, per blank, per test case.
 * That is the whole point of passing `details` down instead of printing a
 * score: "3 / 6" tells a teacher nothing about which half was wrong, and the
 * type is the only thing that knows how to say it (F-GRADE-04, WP10 DoD).
 */
export function EntryDetail({
  entry,
  item,
  explanation,
  onValidate,
  validating,
  onOverride,
}: {
  entry: GradingEntry;
  item: GradingQueueItem;
  /** The question's explanation, when the results view could be read. */
  explanation?: string | null;
  onValidate: () => void;
  validating: boolean;
  onOverride: () => void;
}) {
  const t = useT();
  const grading = entry.grading;
  const absent = entry.answerId === null && entry.answer === null;

  return (
    <div className="space-y-4 border-t border-line px-4 py-4 sm:px-5">
      {absent ? <p className="text-sm italic text-fg-faint">{t("grading.noAnswer")}</p> : null}

      <QuestionReviewHost
        t={t}
        type={item.type}
        student={entry.student}
        answer={entry.answer}
        solution={entry.solution}
        details={grading?.details ?? null}
        points={grading ? grading.points : null}
        maxPoints={grading?.maxPoints ?? item.points}
        audience="teacher"
      />

      {/* A comment is the teacher's only when the grading is: an automatic
          pass puts its own note here ("runner unavailable"), and labelling
          that "visible to the student" would be a promise nobody made. */}
      {grading?.comment ? (
        <div className="rounded-field border border-line-strong bg-surface p-3">
          <p className="flex items-center gap-1.5 text-xs text-fg-faint">
            <MessageSquare className="size-3.5" />
            {t(grading.source === "manual" ? "grading.comment" : "grading.machineComment")}
          </p>
          <p className="mt-1 text-[13px] text-fg">{grading.comment}</p>
        </div>
      ) : null}

      {explanation ? (
        <div className="rounded-field bg-surface-2 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-fg-faint">
            {t("grading.explanation")}
          </p>
          <MarkdownView size="sm" className="mt-1" source={explanation} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {grading && grading.state === "proposed" ? (
          <Button variant="secondary" onClick={onValidate} loading={validating}>
            <Check /> {t("grading.validate")}
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onOverride}>
          <PencilLine /> {t("grading.override")}
        </Button>
        <span className="flex-1" />
        {grading ? (
          <span className="flex items-center gap-2">
            {grading.confidence ? (
              <Badge tone={confidenceTone(grading.confidence)}>
                {confidenceLabel(t, grading.confidence)}
              </Badge>
            ) : null}
            <Badge tone={sourceTone(grading.source)}>{sourceLabel(t, grading.source)}</Badge>
            <span className="text-[15px] font-semibold tabular-nums">
              {t("grading.score", {
                points: round2(grading.points),
                max: round2(grading.maxPoints),
              })}
            </span>
          </span>
        ) : null}
        <HistoryPopover history={entry.history} />
      </div>

      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-faint">
        <span className="flex items-center gap-1">
          <Kbd>V</Kbd> {t("grading.keys.validate")}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>←</Kbd>
          <Kbd>→</Kbd> {t("grading.keys.navigate")}
        </span>
        <span className="flex items-center gap-1">
          <Kbd>O</Kbd> {t("grading.keys.override")}
        </span>
      </p>
    </div>
  );
}
