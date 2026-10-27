/**
 * The composition of a drill session (F-DRILL-03, ADR-041 §6): the cards
 * due first, the most nearly forgotten ahead, then new cards up to the
 * day's cap, until the time budget is spent; courses and concepts interleaved
 * rather than in blocks.
 */
import { SCHOOL_TIME_ZONE, zoneOffset } from "./zone.js";

/** The target length of a session, before a teacher or the admin sets another (F-ADMIN-03). */
export const DRILL_SESSION_BUDGET_MS = 600_000;
/**
 * New cards a student meets per day before asking for more, so that one exam
 * does not flood the next day; also the size of each batch they ask for
 * (ADR-041 §6, amendment of 2026-10-27).
 */
export const DRILL_NEW_PER_DAY = 10;
/** The time counted for a card with no reference time at all. */
export const DRILL_UNKNOWN_REFERENCE_MS = 60_000;

/**
 * The share of cards the scheduler aims to have remembered when they come
 * due (ADR-041 §5). Here, beside the day, and not in `drillSchedule.ts`:
 * the web app draws it on the teacher's chart without pulling `ts-fsrs`.
 */
export const DRILL_TARGET_RETENTION = 0.9;

/**
 * The calendar day of `now` in `timeZone`, as two instants: its first
 * millisecond and the first of the next day. What "due today" and "new
 * cards per day" are measured against — a card due at 14:00 belongs to the
 * morning's session, and the cap resets at midnight, not 24 hours after the
 * last session.
 */
export function drillDayBounds(now: Date, timeZone: string = SCHOOL_TIME_ZONE): { start: Date; end: Date } {
  const offset = (at: Date) => zoneOffset(at, timeZone);
  const localNow = now.getTime() + offset(now);
  const localMidnight = localNow - (((localNow % 86_400_000) + 86_400_000) % 86_400_000);
  // Each bound takes the offset in force at that instant (a DST change may lie between).
  const start = localMidnight - offset(new Date(localMidnight - offset(now)));
  const nextMidnight = localMidnight + 86_400_000;
  const end = nextMidnight - offset(new Date(nextMidnight - offset(now)));
  return { start: new Date(start), end: new Date(end) };
}

/** Where the new cards of one student's day stand (ADR-041 §6, amendment of 2026-10-27). */
export interface DrillNewToday {
  /** New cards still allowed today: the cap, raised by a batch per unlock, minus those already introduced. Never negative. */
  allowed: number;
  /** New cards waiting beyond that allowance: what "more new questions" would unlock. */
  held: number;
  /** Whether asking for more unlocks a batch now: the allowance is spent and a new card waits. */
  unlockable: boolean;
}

/**
 * New cards still allowed today: `DRILL_NEW_PER_DAY`, and as many more for
 * each batch unlocked today, minus those already introduced. Never negative.
 */
export function drillNewAllowed(introduced: number, unlocks: number): number {
  return Math.max(0, DRILL_NEW_PER_DAY * (1 + Math.max(0, unlocks)) - introduced);
}

/**
 * The day's new cards: `DRILL_NEW_PER_DAY` per day, and as many more for
 * each batch the student unlocked today (`unlocks`); `introduced` were met
 * for the first time today, `waiting` are new and not held back today. A
 * batch is unlocked only once the allowance is spent, so a second click on
 * "more" before the first batch is met unlocks nothing.
 */
export function drillNewToday({
  introduced,
  unlocks,
  waiting,
}: {
  introduced: number;
  unlocks: number;
  waiting: number;
}): DrillNewToday {
  const allowed = drillNewAllowed(introduced, unlocks);
  const held = Math.max(0, waiting - allowed);
  return { allowed, held, unlockable: allowed === 0 && held > 0 };
}

export interface DrillCandidate {
  id: string;
  /** Never reviewed. */
  isNew: boolean;
  dueAt: Date;
  /** From `drillRetrievability` at the session's `now`. */
  retrievability: number;
  /** The expected time of one review on this device class, from `drillReferenceMs`; null counts `DRILL_UNKNOWN_REFERENCE_MS`. */
  referenceMs: number | null;
  /** What is interleaved: a course, a concept, or both joined — the caller's choice. */
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
