/**
 * Pulling a template revision into an instance (F-EVAL-26, ADR-031 PR B) —
 * the two pure halves of it, read by the API (the gate, the preview) and by
 * the web app (the badge, the launch checklist's warning), so the screen can
 * never offer a pull the server refuses, nor hide one it allows.
 *
 * A pull replaces the instance's QUESTIONS ONLY — the frozen versions, points,
 * order, milestones, bonus flags and intros of the template — and keeps everything else of the
 * instance. It is therefore a write to the item list, and allowed exactly
 * where that list is editable (`itemListLock`: `draft` or `scheduled`, no
 * attempt of anybody, a teacher's own included).
 */
import { itemListLock, type EvaluationStateName } from "./itemList.js";

/** Where an instance stands against its template. */
export interface TemplateStanding {
  /** The template revision the instance's questions were copied from; null for no origin. */
  originRevision: number | null;
  /** The template's current revision; null when the instance has no template (any more). */
  templateRevision: number | null;
}

/** The template has moved since the instance was made or last pulled. */
export function templateBehind(s: TemplateStanding): boolean {
  return (
    s.originRevision !== null && s.templateRevision !== null && s.originRevision < s.templateRevision
  );
}

/**
 * The pull is offered: the template moved, and the instance's item list may
 * still change. The server's gate is `itemListLock` itself, re-read under the
 * instance's row lock; this is the same rule, read off what the page holds.
 */
export function templatePullable(
  s: TemplateStanding & { state: EvaluationStateName; attemptCount: number },
): boolean {
  return templateBehind(s) && itemListLock(s.state, s.attemptCount) === null;
}

/** What the diff of a pull compares on one item; the caller's items may carry more (a name). */
export interface PullItem {
  position: number;
  questionId: string;
  versionNumber: number;
  points: number;
  milestone: boolean;
  /** ADR-052. */
  bonus: boolean;
  /** ADR-084: the passage before the item, compared as written. */
  intro: string | null;
}

/** What a pull would change in the question list, instance → template. */
export interface ItemListDiff<T extends PullItem> {
  /** In the template, not in the instance. */
  added: T[];
  /** In the instance, not in the template: a local addition, or a question the template dropped. */
  removed: T[];
  /** The same question on both sides with another version, points, milestone, bonus flag or intro. */
  changed: { from: T; to: T }[];
  /** The questions both sides hold do not come in the same order. */
  reordered: boolean;
}

/**
 * The two-way summary of a pull. Items are paired by question — the k-th
 * occurrence of a question in the instance with its k-th occurrence in the
 * template, should a list hold one twice — since a pull gives every item a
 * new id and the question is what the teacher recognises.
 */
export function itemListDiff<T extends PullItem>(
  instance: readonly T[],
  template: readonly T[],
): ItemListDiff<T> {
  const byPosition = (a: T, b: T) => a.position - b.position;
  const mine = [...instance].sort(byPosition);
  const theirs = [...template].sort(byPosition);
  const waiting = new Map<string, T[]>();
  for (const item of mine) waiting.set(item.questionId, [...(waiting.get(item.questionId) ?? []), item]);

  const added: T[] = [];
  const pairs: { from: T; to: T }[] = [];
  for (const item of theirs) {
    const match = waiting.get(item.questionId)?.shift();
    if (match === undefined) added.push(item);
    else pairs.push({ from: match, to: item });
  }
  const paired = new Set(pairs.map((p) => p.from));
  const removed = mine.filter((item) => !paired.has(item));
  const changed = pairs.filter(
    ({ from, to }) =>
      from.versionNumber !== to.versionNumber ||
      from.points !== to.points ||
      from.milestone !== to.milestone ||
      from.bonus !== to.bonus ||
      from.intro !== to.intro,
  );
  // `pairs` is in the template's order; the instance's order of the same
  // questions must then be increasing too.
  const reordered = pairs.some((p, i) => i > 0 && p.from.position < pairs[i - 1]!.from.position);
  return { added, removed, changed, reordered };
}

/** Nothing of the question list would change: the pull only records the revision. */
export function isEmptyDiff(diff: ItemListDiff<PullItem>): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0 &&
    !diff.reordered
  );
}
