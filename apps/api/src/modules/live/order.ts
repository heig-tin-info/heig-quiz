/**
 * The student's item order, derived from the attempt seed, and the items the
 * navigation rule locks (F-EVAL-07, F-EVAL-09, F-LIVE-08).
 */
import type { EvaluationSettings } from "@quiz/contracts";
import { shuffle, streamSeed } from "@quiz/core/rng";
import { lockedItems } from "@quiz/domain";

import type { JoinedItem } from "../evaluation/service.js";
import type { AnswerRecord } from "./access.js";

export interface OrderedItem extends JoinedItem {
  /** Rank in the student's own order; `item.position` stays canonical. */
  rank: number;
}

/**
 * F-EVAL-09. The order is derived from the attempt seed, never stored, so a
 * reload, the teacher preview and a regrade reproduce the same sequence.
 * `position` remains the canonical order for grading and CSV export.
 */
export function orderItems(
  items: readonly JoinedItem[],
  settings: EvaluationSettings,
  seed: number,
  evaluationId: string,
): OrderedItem[] {
  const ordered = settings.shuffleItems
    ? shuffle(items, streamSeed(seed, evaluationId, "items"))
    : [...items];
  return ordered.map((item, rank) => ({ ...item, rank }));
}

/**
 * Which items the server refuses a write to (F-EVAL-07, F-LIVE-08).
 *
 * `forward_only`: a validated question is closed. `milestones`: everything up
 * to and including the furthest checkpoint the student validated is closed.
 * Enforced HERE, on the server, and not only greyed out in the player — with
 * the SAME rule the player reads (`@quiz/domain#lockedItems`).
 */
export function lockedItemIds(
  settings: EvaluationSettings,
  ordered: readonly OrderedItem[],
  answered: ReadonlyMap<string, AnswerRecord>,
): Set<string> {
  return lockedItems(
    settings.navigation,
    ordered.map((o) => ({
      id: o.item.id,
      milestone: o.item.milestone,
      validated: answered.get(o.item.id)?.markedDone ?? false,
    })),
  );
}
