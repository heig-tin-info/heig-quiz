/**
 * The pure rules of the model pass that proposes the sorting of the existing
 * tags (ADR-081, second addendum §3): how the `conceptKey` groups are cut
 * into the batches of sequential calls, and how one call's answer is read
 * back into one proposal per (pool, tag) pair.
 *
 * The model works under throwaway handles, never ids: `c1`… for the
 * concepts of the registry, `n1`… for the new concepts proposed earlier in
 * the run, and the ids it picks for the new concepts of its own answer. A
 * handle it did not receive designates nothing, nor does an id of its own
 * that reuses a handle it received. A new concept whose key, in
 * either language, is one of the registry's becomes that concept; one whose
 * key is one an earlier new concept of the run already has becomes that
 * concept, labels included, so that accepting both pairs creates ONE
 * concept (`groupNewConcepts`).
 */
import {
  CONCEPT_DESCRIPTION_MAX,
  CONCEPT_HINT_MAX,
  CONCEPT_LABEL_MAX,
  CONCEPT_LABEL_PATTERN,
  CONCEPT_LANGUAGES,
  CONCEPT_QUALIFIER_MAX,
  cleanConceptLabel,
  cleanConceptQualifier,
  qualifiedConceptKey,
  type ConceptLanguage,
  type PoolTagCount,
  type TagGroup,
} from "./concepts.js";

/** The most groups, and pairs, one call is given. A group is never split. */
export interface SortBatchLimits {
  groups: number;
  pairs: number;
}

/**
 * The groups in order, cut into batches of at most `limits.groups` groups
 * and `limits.pairs` pairs; a group larger than `limits.pairs` alone is a
 * batch of its own (a group is never split, its pairs are read together).
 */
export function batchTagGroups<T extends PoolTagCount>(
  groups: readonly TagGroup<T>[],
  limits: SortBatchLimits,
): TagGroup<T>[][] {
  const batches: TagGroup<T>[][] = [];
  let current: TagGroup<T>[] = [];
  let pairs = 0;
  for (const group of groups) {
    const full =
      current.length === limits.groups ||
      pairs + group.pairs.length > limits.pairs;
    if (current.length > 0 && full) {
      batches.push(current);
      current = [];
      pairs = 0;
    }
    current.push(group);
    pairs += group.pairs.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** One language of a proposed new concept, cleaned. */
export interface SortConceptSide {
  label: string;
  qualifier: string;
  description: string;
}

export type SortNewConcept = Record<ConceptLanguage, SortConceptSide>;

/** A concept of the registry, as the pass reads it: its labels and qualifiers, a language possibly missing. */
export interface SortRegistryConcept {
  id: string;
  sides: Record<ConceptLanguage, { label: string; qualifier: string } | null>;
}

/** The model's answer for one pair, under handles. */
export interface SortVerdict {
  /** The pair's handle. */
  id: string;
  /** A handle: a registry concept, an earlier new concept, or a new concept of this answer. */
  concept: string | null;
  drop: string | null;
  broader: string | null;
  note: string | null;
}

/** A new concept of the model's answer, under the id it gave it. */
export interface SortReplyConcept {
  id: string;
  fr: SortConceptSide;
  en: SortConceptSide;
}

/** What a handle designates: an existing concept, or a new one with its labels. */
export type SortTarget =
  | { kind: "concept"; conceptId: string }
  | { kind: "new"; newConcept: SortNewConcept };

/**
 * What is proposed for one pair; `broader` and `note` are hints, kept as
 * said. The contracts' `TagSortingProposal` is this shape plus the model.
 */
export type SortProposal<R extends string> = (
  SortTarget | { kind: "drop"; dropReason: R }
) & { broader?: string; note?: string };

const hint = (text: string | null): string | undefined => {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  return t ? t.slice(0, CONCEPT_HINT_MAX) : undefined;
};

/** A side as stored, or null when its label is empty, too long, or holds no letter nor digit. */
function cleanSide(side: SortConceptSide): SortConceptSide | null {
  const label = cleanConceptLabel(side.label);
  if (
    !label ||
    label.length > CONCEPT_LABEL_MAX ||
    !CONCEPT_LABEL_PATTERN.test(label)
  )
    return null;
  return {
    label,
    qualifier: cleanConceptQualifier(side.qualifier).slice(
      0,
      CONCEPT_QUALIFIER_MAX,
    ),
    description: side.description
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, CONCEPT_DESCRIPTION_MAX),
  };
}

const keyOf = (side: { label: string; qualifier: string }) =>
  qualifiedConceptKey(side.label, side.qualifier);

/**
 * What a new concept of the model's answer becomes: null when a language's
 * label is invalid; the registry concept that holds one of its keys; the
 * new concept proposed earlier in the run that holds one, labels included;
 * else itself, added to `proposed` under the next handle `n<k>`.
 */
export function resolveNewConcept(
  raw: SortReplyConcept,
  registry: ReadonlyMap<string, SortRegistryConcept>,
  proposed: Map<string, SortNewConcept>,
): SortTarget | null {
  const fr = cleanSide(raw.fr);
  const en = cleanSide(raw.en);
  if (!fr || !en) return null;
  const sides: SortNewConcept = { fr, en };
  const holds = (
    side: { label: string; qualifier: string } | null,
    lang: ConceptLanguage,
  ) => side !== null && keyOf(side) === keyOf(sides[lang]);
  const existing = [...registry.values()].find((c) =>
    CONCEPT_LANGUAGES.some((lang) => holds(c.sides[lang], lang)),
  );
  if (existing) return { kind: "concept", conceptId: existing.id };
  const earlier = [...proposed.values()].find((c) =>
    CONCEPT_LANGUAGES.some((lang) => holds(c[lang], lang)),
  );
  if (earlier) return { kind: "new", newConcept: earlier };
  proposed.set(`n${proposed.size + 1}`, sides);
  return { kind: "new", newConcept: sides };
}

/**
 * One call's answer read back into a proposal per pair handle. A pair is
 * answered at most once (the first answer counts); a pair that is not
 * answered, or answered with an unknown handle, an invalid new concept, an
 * unknown drop reason, both a concept and a drop or neither, gets none.
 * `proposed`, the run's new concepts by handle, gains those the proposals
 * use (`resolveNewConcept`).
 */
export function readSortReply<R extends string>(input: {
  pairs: ReadonlySet<string>;
  registry: ReadonlyMap<string, SortRegistryConcept>;
  proposed: Map<string, SortNewConcept>;
  dropReasons: readonly R[];
  verdicts: readonly SortVerdict[];
  newConcepts: readonly SortReplyConcept[];
}): Map<string, SortProposal<R>> {
  const { registry, proposed } = input;
  /** The run's handles the model was sent: one created while reading this answer was not. */
  const sentRun = new Set(proposed.keys());
  const received = (handle: string) =>
    registry.has(handle) || sentRun.has(handle);
  /** The answer's own new concepts; an id that reuses a received handle designates nothing. */
  const colliding = new Set(
    input.newConcepts.filter((c) => received(c.id)).map((c) => c.id),
  );
  const local = new Map(
    input.newConcepts.filter((c) => !colliding.has(c.id)).map((c) => [c.id, c]),
  );
  /** A local new concept's id → what it became, once read. */
  const settled = new Map<string, SortTarget | null>();

  const target = (handle: string): SortTarget | null => {
    if (colliding.has(handle)) return null;
    const known = registry.get(handle);
    if (known) return { kind: "concept", conceptId: known.id };
    const earlier = sentRun.has(handle) ? proposed.get(handle) : undefined;
    if (earlier) return { kind: "new", newConcept: earlier };
    const raw = local.get(handle);
    if (!raw) return null;
    if (!settled.has(handle))
      settled.set(handle, resolveNewConcept(raw, registry, proposed));
    return settled.get(handle)!;
  };

  const out = new Map<string, SortProposal<R>>();
  for (const verdict of input.verdicts) {
    if (!input.pairs.has(verdict.id) || out.has(verdict.id)) continue;
    const concept = verdict.concept?.trim() || null;
    const drop = verdict.drop?.trim() || null;
    if ((concept === null) === (drop === null)) continue;
    const broader = hint(verdict.broader);
    const note = hint(verdict.note);
    const hints = {
      ...(broader ? { broader } : {}),
      ...(note ? { note } : {}),
    };
    const reason = input.dropReasons.find((r) => r === drop);
    const to =
      drop === null
        ? target(concept!)
        : reason
          ? { kind: "drop" as const, dropReason: reason }
          : null;
    if (to) out.set(verdict.id, { ...to, ...hints });
  }
  return out;
}
