/**
 * The student's item order, derived from the attempt seed, and the items the
 * navigation rule locks (F-EVAL-07, F-EVAL-09, F-LIVE-08).
 */
import type { EvaluationSettings } from "@quiz/contracts";
import { lockedItems, placeIntros, sectionedOrder, type PlacedIntro } from "@quiz/domain";

import type { JoinedItem } from "../evaluation/service.js";
import type { AnswerRecord } from "./access.js";

export interface OrderedItem extends JoinedItem {
  /** Rank in the student's own order; `item.position` stays canonical. */
  rank: number;
  /**
   * ADR-143: the text shown before the item in THIS order and the section it
   * belongs to — a section's text on the first of its items drawn.
   */
  placed: PlacedIntro;
}

/** What the section rules read of a joined item. */
const sectionItem = (j: JoinedItem) => j.item;

/**
 * F-EVAL-09. The order is derived from the attempt seed, never stored, so a
 * reload, the teacher preview and a regrade reproduce the same sequence.
 * `position` remains the canonical order for grading and CSV export. With
 * sections (ADR-143) the items are shuffled inside each section, the
 * sections kept in place; without one, the order is the one every attempt
 * was drawn with before them (`sectionedOrder`).
 */
export function orderItems(
  items: readonly JoinedItem[],
  settings: EvaluationSettings,
  seed: number,
  evaluationId: string,
): OrderedItem[] {
  const ordered = sectionedOrder(items, sectionItem, { shuffle: settings.shuffleItems, seed, evaluationId });
  const placed = placeIntros(items, ordered, sectionItem);
  return ordered.map((item, rank) => ({ ...item, rank, placed: placed[rank]! }));
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
