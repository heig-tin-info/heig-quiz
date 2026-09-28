import type { GradingEntry, GradingQueue, GradingQueueItem } from "@quiz/contracts";
import { attemptTotal, formatPoints } from "@quiz/domain";

import { useT } from "../i18n";
import { typeLabel } from "../questionTypes";
import { Badge } from "../ui";
import type { GradingOrder } from "./labels";
import type { StateFilter } from "./useGradingTraversal";

/** A student's running total: what they have, out of what, and whether it is settled. */
export interface StudentTotal {
  points: number;
  max: number;
  /** A proposal not validated yet, or an answer not graded at all. */
  provisional: boolean;
}

/**
 * The total of one student's copy, or null for an empty one. The server's
 * one total: signed per question, floored at 0 (`attemptTotal`, ADR-026). A
 * proposal not validated yet, or an answer not graded at all (counted 0),
 * makes the sum a forecast, not the grade.
 */
export function studentTotal(
  entries: readonly GradingEntry[],
  itemsById: ReadonlyMap<string, GradingQueueItem>,
): StudentTotal | null {
  if (entries.length === 0) return null;
  return {
    points: attemptTotal(entries.map((e) => e.grading?.points ?? 0)),
    max: entries.reduce(
      (sum, e) => sum + (e.grading?.maxPoints ?? itemsById.get(e.itemId)?.points ?? 0),
      0,
    ),
    provisional: entries.some((e) => !e.grading || e.grading.state !== "validated"),
  };
}

/**
 * What the step is, beside its counter (#108). A question: its type, its
 * points and how many answers it has. A student: how many answers, and
 * their running total — the question's points mean nothing across a whole
 * copy, the student's total is what a teacher checks at the end of one.
 * The total is read from the queue as the server sent it, so only while
 * the state filter keeps every answer: a total of the proposals alone
 * would be a number that is no one's grade.
 */
export function StepBadges({
  order,
  stateFilter,
  item,
  queue,
  total,
  itemsById,
}: {
  order: GradingOrder;
  stateFilter: StateFilter;
  /** The step's question, by question. */
  item: GradingQueueItem | undefined;
  queue: GradingQueue | undefined;
  /** The answers the step counts, filters applied. */
  total: number;
  itemsById: ReadonlyMap<string, GradingQueueItem>;
}) {
  const t = useT();
  const sum =
    order === "student" && stateFilter === "all" && queue
      ? studentTotal(queue.entries, itemsById)
      : null;
  return (
    <>
      {item ? (
        <>
          <Badge tone="zinc">{typeLabel(t, item.type)}</Badge>
          <Badge tone="zinc">{t("grading.points", { n: item.points })}</Badge>
        </>
      ) : null}
      <Badge tone="zinc">{t("grading.answers", { n: total })}</Badge>
      {sum ? (
        <Badge tone="zinc">
          {t(sum.provisional ? "grading.studentTotal.provisional" : "grading.studentTotal", {
            points: formatPoints(sum.points),
            max: formatPoints(sum.max),
          })}
        </Badge>
      ) : null}
    </>
  );
}
