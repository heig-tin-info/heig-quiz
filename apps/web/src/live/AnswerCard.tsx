import type { ReactNode } from "react";

import type { DashboardCell } from "@quiz/contracts";

import { useT } from "../i18n";
import { QuestionReviewHost, typeLabel } from "../questionTypes";
import { Badge, VerdictCell } from "../ui";
import { cellState } from "./cells";

/**
 * One student's answer to one question, as the staff read it from the live
 * grid: a header line (what it is, the cell's state, the points once they
 * exist) and the type's own `Review` under it. The one drawing of an answer
 * shared by the three readings of the grid (issue #353): the whole paper
 * (`InspectModal`), one cell (`AnswerModal`) and one question for the class
 * (`QuestionModal`), so an answer reads the same wherever it was opened from.
 *
 * `QuestionReviewHost`, `audience` "teacher", injects the French strings and
 * `MarkdownView` in its inline form, so a prompt with backticks, bold or a
 * formula reads here exactly as the student read it, and this file never
 * learns what any type's answer looks like.
 */
export function AnswerCard({
  heading,
  type,
  typeBadge = true,
  cell,
  showResults = true,
  maxPoints,
  studentConfig,
  answer,
  solution,
}: {
  /** What the card is: "Question 3" in a paper, the student in a question. */
  heading?: ReactNode;
  type: string;
  /** False where the type is already named above the cards. */
  typeBadge?: boolean;
  cell: DashboardCell | null;
  /** Whether a verdict replaces the progress state, as the grid's switch. */
  showResults?: boolean;
  maxPoints: number;
  studentConfig: unknown;
  answer: unknown;
  solution: unknown;
}) {
  const t = useT();
  return (
    <div className="rounded-card border border-line bg-surface-2/40 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-line pb-2">
        {heading ? <span className="text-[13px] font-semibold">{heading}</span> : null}
        {typeBadge ? <Badge tone="zinc">{typeLabel(t, type)}</Badge> : null}
        {cell ? (
          <span className="w-9">
            <VerdictCell state={cellState(cell, showResults)} />
          </span>
        ) : null}
        {/* Only a score that EXISTS is printed here: the type's own review
            already ends on a "Score — / n" line, and "graded once the
            evaluation is closed" repeated under every card is a paragraph
            nobody reads. */}
        {cell?.points == null ? null : (
          <span className="ml-auto text-xs tabular-nums text-fg-muted">
            {t("live.inspect.points", { points: cell.points, max: maxPoints })}
          </span>
        )}
      </div>
      <div className="min-w-0">
        <QuestionReviewHost
          type={type}
          student={studentConfig}
          answer={answer}
          solution={solution}
          details={null}
          points={cell?.points ?? null}
          maxPoints={maxPoints}
          audience="teacher"
        />
      </div>
    </div>
  );
}
