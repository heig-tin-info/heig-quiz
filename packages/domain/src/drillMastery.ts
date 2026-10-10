/**
 * The mastery on a course's concepts, a pure roll-up (ADR-081 sixth addendum
 * §9, #599 step 9a; ADR-041 §15): cards in, one line per concept out. The
 * teacher's read calls it with a classroom's cards; the student's (9b) with
 * one student's.
 *
 * A card counts toward EVERY listed concept that covers one of its
 * question's concepts. A card no listed concept covers, or whose question has
 * no concept, goes to the outside bucket, line by concept (`null` for none).
 * A listed concept no card counts toward is a line without evidence
 * (`retrievability` null). With no listed concept the view is flat: the lines
 * are those of every card's concepts and there is no outside bucket.
 */

/** A reviewed card, its retrievability now already computed (0 to 1). */
export interface MasteryCard {
  id: string;
  userId: string;
  retrievability: number;
  /** The concepts of the card's question, as they stand now. */
  conceptIds: readonly string[];
}

/** One concept (`null`: the questions without any), the cards counted toward it. */
export interface MasteryLine {
  conceptId: string | null;
  cards: number;
  students: number;
  /** Mean over the cards, 0 to 1; null when no card counts: no evidence. */
  retrievability: number | null;
}

export interface MasteryRollup {
  /** Whether the course lists concepts. */
  declared: boolean;
  /** The listed concepts, or, when none is listed, every concept met. */
  lines: MasteryLine[];
  /** What no listed concept covers; null when nothing, and when not declared. */
  outside: { cards: number; students: number; retrievability: number; lines: MasteryLine[] } | null;
}

type Tie = (a: string | null, b: string | null) => number;
type Acc = { cards: number; students: Set<string>; sum: number };

const fresh = (): Acc => ({ cards: 0, students: new Set(), sum: 0 });
const add = (acc: Acc, card: MasteryCard) => {
  acc.cards += 1;
  acc.students.add(card.userId);
  acc.sum += card.retrievability;
};
const defaultTie: Tie = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);

/** Weakest first, lines without evidence last, then `tie` on the concept (a missing one last by default). */
export function compareMastery(a: MasteryLine, b: MasteryLine, tie: Tie = defaultTie): number {
  if (a.retrievability === null || b.retrievability === null) {
    if (a.retrievability === b.retrievability) return tie(a.conceptId, b.conceptId);
    return a.retrievability === null ? 1 : -1;
  }
  return a.retrievability - b.retrievability || tie(a.conceptId, b.conceptId);
}

/**
 * @param listed the course's concept ids
 * @param coverage for each listed concept, the concepts it covers (itself included)
 * @param tie orders two lines of equal mastery by concept (labels, in the caller's language)
 */
export function drillMastery(
  cards: readonly MasteryCard[],
  listed: readonly string[],
  coverage: ReadonlyMap<string, readonly string[]>,
  tie?: Tie,
): MasteryRollup {
  const lines = (accs: Map<string | null, Acc>): MasteryLine[] =>
    [...accs]
      .map(([conceptId, a]) => ({
        conceptId,
        cards: a.cards,
        students: a.students.size,
        retrievability: a.cards === 0 ? null : a.sum / a.cards,
      }))
      .sort((a, b) => compareMastery(a, b, tie));
  const bucket = (accs: Map<string | null, Acc>, id: string | null) => {
    if (!accs.has(id)) accs.set(id, fresh());
    return accs.get(id)!;
  };
  /** A question without concept is the `null` line. */
  const concepts = (card: MasteryCard) => (card.conceptIds.length > 0 ? card.conceptIds : [null]);
  const declared = listed.length > 0;

  // Which listed concepts each concept counts toward: coverage, inverted once.
  const coveredBy = new Map<string, string[]>();
  for (const l of listed) for (const id of coverage.get(l) ?? []) coveredBy.set(id, [...(coveredBy.get(id) ?? []), l]);

  const inList = new Map<string | null, Acc>(listed.map((l) => [l, fresh()]));
  const outside = fresh();
  // Not declared, every card is outside the (empty) list: the flat view is its lines.
  const outsideLines = new Map<string | null, Acc>();
  for (const card of cards) {
    const hits = new Set(card.conceptIds.flatMap((id) => coveredBy.get(id) ?? []));
    for (const l of hits) add(inList.get(l)!, card);
    if (hits.size > 0) continue;
    add(outside, card);
    for (const id of concepts(card)) add(bucket(outsideLines, id), card);
  }
  if (!declared) return { declared, lines: lines(outsideLines), outside: null };
  return {
    declared,
    lines: lines(inList),
    outside:
      outside.cards === 0
        ? null
        : {
            cards: outside.cards,
            students: outside.students.size,
            retrievability: outside.sum / outside.cards,
            lines: lines(outsideLines),
          },
  };
}
