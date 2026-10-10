/**
 * The order in which the vocabulary is offered for a typed search: one rule
 * for the admin's map dialog and the teacher's concept picker (ADR-081 §5,
 * addendum §2).
 */
import { CONCEPT_LANGS, type Concept } from "@quiz/contracts";
import { closeConcepts, resolveConceptLabel, type ResolvableConcept } from "@quiz/domain";

import { fuzzyScore } from "../fuzzy";
import type { Locale } from "../i18n";
import { conceptName } from "./names";

const namesOf = (c: Concept) => [c.labels.fr, c.labels.en].filter((l): l is string => l !== null);

/** A concept as the resolver of `@quiz/domain` sees it, as the server builds it (`toResolvable`). */
export const resolvable = (c: Concept): ResolvableConcept => ({
  id: c.id,
  mergedInto: c.mergedInto,
  labels: CONCEPT_LANGS.flatMap((lang) => {
    const label = c.labels[lang];
    return label === null ? [] : [{ label, qualifier: c.qualifiers[lang] }];
  }),
});

/** The concepts `query` designates directly, by the server's rule (addendum §2): one, homonyms, or none. */
function designated(query: string, concepts: readonly Concept[]): string[] {
  const r = resolveConceptLabel(query, concepts.map(resolvable));
  return r.kind === "resolved" ? [r.id] : r.kind === "ambiguous" ? r.candidates : [];
}

/** Whether `query` designates one of `concepts` (or several): then there is nothing to create. */
export const namesAConcept = (query: string, concepts: readonly Concept[]): boolean =>
  designated(query, concepts).length > 0;

/**
 * The concepts `query` designates, best first: what it designates directly
 * (an exact label, a label with its qualifier), then the close matches of the
 * shared matcher (`closeConcepts`), then every other concept the search still
 * matches, validated ones first. An empty search lists them all.
 *
 * `first` (the concepts already used in the pool, §5) moves those ahead of
 * the others, the direct matches excepted: what was typed exactly stays on
 * top, so Enter picks it.
 */
export function rankConcepts<C extends Concept>(
  query: string,
  concepts: readonly C[],
  locale: Locale,
  first: ReadonlySet<string> = new Set(),
): C[] {
  const byId = new Map(concepts.map((c) => [c.id, c]));
  const direct = new Set(designated(query, concepts));
  const matches = closeConcepts(
    query,
    concepts.map((c) => ({ id: c.id, names: namesOf(c) })),
  ).map((m) => m.id);
  const seen = new Set([...direct, ...matches]);
  const rest = concepts
    .filter((c) => !seen.has(c.id) && (query.trim() === "" || namesOf(c).some((n) => fuzzyScore(query, n) !== null)))
    .sort(
      (a, b) =>
        Number(a.status !== "validated") - Number(b.status !== "validated") ||
        conceptName(a, locale).localeCompare(conceptName(b, locale), locale),
    );
  const hits = [...new Set([...direct, ...matches])].flatMap((id) => byId.get(id) ?? []);
  const tier = (c: C) => (direct.has(c.id) ? 0 : 2) + (first.has(c.id) ? 0 : 1);
  // `sort` is stable: within a tier, the matcher's order holds.
  return [...hits, ...rest].sort((a, b) => tier(a) - tier(b));
}
