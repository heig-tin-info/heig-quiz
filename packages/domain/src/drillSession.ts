/**
 * The composition of a drill session (F-DRILL-03, ADR-041 §6): the cards
 * due first, the most nearly forgotten ahead, then new cards up to the
 * day's cap, until the time budget is spent; courses and tags interleaved
 * rather than in blocks.
 */

/** The target length of a session, before a teacher or the admin sets another (F-ADMIN-03). */
export const DRILL_SESSION_BUDGET_MS = 600_000;
/** New cards a student meets per day at most, so that one exam does not flood the next day. */
export const DRILL_NEW_PER_DAY = 10;
/** The time counted for a card with no reference time at all. */
export const DRILL_UNKNOWN_REFERENCE_MS = 60_000;

export interface DrillCandidate {
  id: string;
  /** Never reviewed. */
  isNew: boolean;
  dueAt: Date;
  /** From `drillRetrievability` at the session's `now`. */
  retrievability: number;
  /** The expected time of one review on this device class, from `drillReferenceMs`; null counts `DRILL_UNKNOWN_REFERENCE_MS`. */
  referenceMs: number | null;
  /** What is interleaved: a course, a tag, or both joined — the caller's choice. */
  group: string;
}

export interface DrillSessionInput {
  cards: readonly DrillCandidate[];
  now: Date;
  budgetMs: number;
  /** New cards still allowed today: the daily cap minus those already introduced today. */
  newAllowed: number;
}

/**
 * The ordered ids of today's session. Due cards (lowest retrievability
 * first, then oldest due) come before new ones (oldest first). Cards are
 * taken in that order while their reference times fit the budget; the first
 * one that does not ends the selection — except that a session never comes
 * back empty while a card is available, whatever the budget. Each block
 * (due, then new) is then interleaved by group. Nothing due and nothing
 * new: an empty session.
 */
export function composeDrillSession({ cards, now, budgetMs, newAllowed }: DrillSessionInput): string[] {
  const byId = (a: DrillCandidate, b: DrillCandidate) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byDue = (a: DrillCandidate, b: DrillCandidate) => a.dueAt.getTime() - b.dueAt.getTime() || byId(a, b);
  const due = cards
    .filter((c) => !c.isNew && c.dueAt.getTime() <= now.getTime())
    .sort((a, b) => a.retrievability - b.retrievability || byDue(a, b));
  const fresh = cards
    .filter((c) => c.isNew)
    .sort(byDue)
    .slice(0, Math.max(0, newAllowed));

  const taken: DrillCandidate[] = [];
  let spent = 0;
  for (const card of [...due, ...fresh]) {
    const cost = card.referenceMs ?? DRILL_UNKNOWN_REFERENCE_MS;
    if (taken.length > 0 && spent + cost > budgetMs) break;
    taken.push(card);
    spent += cost;
  }
  const seen = interleaveByGroup(taken.filter((c) => !c.isNew));
  return [...seen, ...interleaveByGroup(taken.filter((c) => c.isNew))].map((c) => c.id);
}

/**
 * Round-robin over the groups, each group keeping its own order, the groups
 * taken in the order their first card appears.
 */
function interleaveByGroup<T extends { group: string }>(items: readonly T[]): T[] {
  const queues = new Map<string, T[]>();
  for (const item of items) {
    const queue = queues.get(item.group);
    if (queue) queue.push(item);
    else queues.set(item.group, [item]);
  }
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round++) {
    for (const queue of queues.values()) if (round < queue.length) out.push(queue[round]!);
  }
  return out;
}
