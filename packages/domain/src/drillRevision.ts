/**
 * Targeted revision by concept (ADR-115, F-DRILL-08): a round of extra
 * practice on one concept of the course, outside FSRS and the level. The
 * pure rules of a round — which of the student's own cards it holds and in
 * what order, the relearning step of a wrong answer, the time an answer
 * took and the round's two counters. No scheduler here: a round never
 * reads nor writes a card's FSRS state.
 */
import type { DrillCorrectness } from "./drillRating.js";
import { DWELL_IDLE_CAP_MS } from "./stats.js";

/** The cards of one round at most. */
export const DRILL_REVISION_ROUND_SIZE = 10;
/** A card answered wrong at its first pass comes back this many places later, once. */
export const DRILL_REVISION_REQUEUE_GAP = 3;

/** One of the student's own cards that covers the chosen concept. */
export interface RevisionCandidate {
  id: string;
  /** Never reviewed by the daily session. */
  isNew: boolean;
  /** From `drillRetrievability` now; read for a reviewed card only. */
  retrievability: number;
  createdAt: Date;
  /** Served in a round already today (the drill's day). */
  practisedToday: boolean;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The ordered card ids of a round: the cards not practised today first, then
 * those practised today ("Another round" brings other cards first); within
 * each group the reviewed cards, the most nearly forgotten ahead, then the new
 * ones, oldest first; the id breaks every tie. At most `size`.
 */
export function composeRevisionRound(
  cards: readonly RevisionCandidate[],
  size: number = DRILL_REVISION_ROUND_SIZE,
): string[] {
  const group = (practised: boolean) => {
    const own = cards.filter((c) => c.practisedToday === practised);
    const reviewed = own.filter((c) => !c.isNew).sort((a, b) => a.retrievability - b.retrievability || byId(a, b));
    const fresh = own.filter((c) => c.isNew).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || byId(a, b));
    return [...reviewed, ...fresh];
  };
  return [...group(false), ...group(true)].slice(0, Math.max(0, size)).map((c) => c.id);
}

/** A place in a round's queue: a card, at its first pass or its second. */
export interface RevisionEntry {
  cardId: string;
  pass: 1 | 2;
}

/** An answer already given in the round. */
export interface RevisionAnswer extends RevisionEntry {
  correctness: DrillCorrectness;
}

/**
 * What is left of a round's queue once `answers` (in the order they were
 * given) are replayed over its `order`: each answer takes its entry out; a
 * WRONG answer at the first pass puts the card back once, `gap` places
 * after where it stood, or at the end when fewer are left. A partial answer
 * is not requeued, nor a second pass.
 */
export function revisionQueue({
  order,
  answers,
  gap = DRILL_REVISION_REQUEUE_GAP,
}: {
  order: readonly string[];
  answers: readonly RevisionAnswer[];
  gap?: number;
}): RevisionEntry[] {
  const queue: RevisionEntry[] = order.map((cardId) => ({ cardId, pass: 1 }));
  for (const answer of answers) {
    const at = queue.findIndex((e) => e.cardId === answer.cardId && e.pass === answer.pass);
    if (at < 0) continue;
    queue.splice(at, 1);
    if (answer.pass === 1 && answer.correctness === "wrong") {
      queue.splice(Math.min(at + gap, queue.length), 0, { cardId: answer.cardId, pass: 2 });
    }
  }
  return queue;
}

/** The next entry of the round, or null when the round is done. */
export function revisionNext(input: Parameters<typeof revisionQueue>[0]): RevisionEntry | null {
  return revisionQueue(input)[0] ?? null;
}

/** The time an answer took, from the server's serve to its answer, within 0 and the idle cap (ADR-039). */
export function revisionTimeMs(servedAt: Date, answeredAt: Date): number {
  return Math.min(DWELL_IDLE_CAP_MS, Math.max(0, answeredAt.getTime() - servedAt.getTime()));
}

/**
 * A round's two counters: the distinct cards answered at their first pass,
 * and those of them answered right. A second pass counts in neither.
 */
export function revisionSummary(answers: readonly RevisionAnswer[]): { cardsServed: number; cardsCorrect: number } {
  const first = answers.filter((a) => a.pass === 1);
  return {
    cardsServed: new Set(first.map((a) => a.cardId)).size,
    cardsCorrect: new Set(first.filter((a) => a.correctness === "right").map((a) => a.cardId)).size,
  };
}
