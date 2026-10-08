/**
 * Resolving what a teacher types to a concept of the vocabulary (ADR-081 §6).
 *
 * Two rules, shared by the manual input, the model's suggestions, the
 * curation screen and the migration of the old tags:
 *
 * - {@link conceptKey}: the form two spellings of one label share. It folds
 *   case and accents, a leading `#`, separators, French and English linking
 *   words and the regular plurals, so `Arithmétique de pointeurs` and
 *   `arithmetique-pointeurs` are the same key. An input whose key equals a
 *   label's or an alias's resolves to that concept without asking.
 * - {@link closeConcepts}: the concepts whose key is a few edits away, for a
 *   "did you mean" (`Poiners` → `pointeur`). Never applied silently: a close
 *   match is a proposal, and a typo is never stored as an alias.
 *
 * Synonyms and translations (`dépassement` / `overflow`) are out of reach of
 * a string rule: they are the curated aliases' and the model's job.
 */

/** Words that only link the others: `ordre d'évaluation` = `ordre évaluation`. */
const LINKING_WORDS = new Set([
  "a",
  "d",
  "de",
  "des",
  "du",
  "l",
  "la",
  "le",
  "les",
  "of",
  "the",
]);

/**
 * The singular of one word, enough for two spellings to meet:
 * - `sse`, `sses` → `ss`, so `classe`, `classes` and `class` meet, as do
 *   `adresse(s)` and `process(es)`;
 * - the `es` of `xes` (`indexes`), from five letters (`axes` is `axe`);
 * - the `x` of `aux`, `eux`, `oux` (`tableaux`, not `flux`);
 * - a final `s`, not after `s` or `u` (`kiss`, `virus`).
 * Words of three letters or fewer are left alone (`bus`, `cas`). The result
 * need not be a word (`deux` → `deu`): only that two spellings meet, and
 * that two concepts do not, matters.
 */
function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("sse")) return word.slice(0, -1);
  if (word.length > 4 && word.endsWith("xes")) return word.slice(0, -2);
  if (/(?:aux|eux|oux)$/.test(word)) return word.slice(0, -1);
  if (word.endsWith("s") && !/(?:ss|us)$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * The matching key of a label. `+` and `#` survive inside a word, so `c`,
 * `c++` and `c#` stay three keys (`C ++` is `c++`); a `#` opening a word is
 * dropped (`#include`). The ligatures `œ`, `æ`, `ß`, which NFKD keeps, are
 * spelled out (`nœud` = `noeud`). A label made of linking words only keeps
 * them rather than collapsing to nothing.
 */
export function conceptKey(label: string): string {
  const words = label
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/\s+(?=\+)/g, "")
    .split(/[^\p{L}\p{N}+#]+/u)
    .map((w) => w.replace(/^#+/, ""))
    .filter(Boolean);
  const meaningful = words.filter((w) => !LINKING_WORDS.has(w));
  return (meaningful.length > 0 ? meaningful : words).map(singular).join("-");
}

/**
 * The label a teacher typed, cleaned for display as a new concept's label:
 * the leading `#` and surrounding spaces dropped, inner spaces collapsed.
 * Case and accents are kept — they are the label, the key ignores them.
 */
export function cleanConceptLabel(label: string): string {
  return label.trim().replace(/^#\s*/, "").replace(/\s+/g, " ");
}

/**
 * The optimal-string-alignment distance: insertions, deletions,
 * substitutions and the swap of two adjacent characters each cost 1.
 */
export function editDistance(a: string, b: string): number {
  const width = b.length + 1;
  const cells = new Array<number>((a.length + 1) * width).fill(0);
  const at = (i: number, j: number): number => cells[i * width + j] ?? 0;
  for (let i = 0; i <= a.length; i++) {
    for (let j = 0; j <= b.length; j++) {
      let d = i === 0 ? j : j === 0 ? i : 0;
      if (i > 0 && j > 0) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d = Math.min(
          at(i - 1, j) + 1,
          at(i, j - 1) + 1,
          at(i - 1, j - 1) + cost,
        );
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d = Math.min(d, at(i - 2, j - 2) + 1);
        }
      }
      cells[i * width + j] = d;
    }
  }
  return at(a.length, b.length);
}

/**
 * How many edits two keys may differ by and still be a "did you mean",
 * from the SHORTER key: none up to four characters (`c` / `c++`, `tri` /
 * `trie`, `pile` / `pipe` are different concepts), one up to eight
 * (`moniteur` is not a typo of `pointeur`), then one per five characters,
 * three at most. Tuned on the production tags of 2026-10-08 (#599).
 */
function tolerance(length: number): number {
  if (length <= 4) return 0;
  if (length <= 8) return 1;
  return Math.min(3, Math.floor(length / 5));
}

/**
 * A concept as the matcher sees it: its id and every label and alias, BARE —
 * without the qualifier that tells homonyms apart (ADR-081 §5), so that
 * typing `adresse` finds both `adresse (mémoire)` and `adresse (postale)`.
 */
export interface ConceptNames {
  id: string;
  names: readonly string[];
}

export interface ConceptMatch {
  id: string;
  /** The label or alias of the concept that matched. */
  name: string;
  /** `exact`: same key, resolves without asking. `close`: a proposal. */
  kind: "exact" | "close";
  /** Edits between the keys; 0 for an exact match. */
  distance: number;
}

/**
 * The concepts `input` may designate, best first: the exact matches, then
 * the close ones by distance, then by name. One entry per concept, through
 * its best-matching name. An input whose key is empty matches nothing.
 */
export function closeConcepts(
  input: string,
  concepts: readonly ConceptNames[],
): ConceptMatch[] {
  const key = conceptKey(input);
  if (!key) return [];
  const matches: ConceptMatch[] = [];
  for (const concept of concepts) {
    let best: ConceptMatch | undefined;
    for (const name of concept.names) {
      const other = conceptKey(name);
      const tol = tolerance(Math.min(key.length, other.length));
      if (Math.abs(key.length - other.length) > tol) continue;
      const distance = other === key ? 0 : editDistance(key, other);
      if (distance > tol) continue;
      if (!best || distance < best.distance) {
        best = {
          id: concept.id,
          name,
          kind: distance === 0 ? "exact" : "close",
          distance,
        };
      }
    }
    if (best) matches.push(best);
  }
  return matches.sort(
    (x, y) => x.distance - y.distance || x.name.localeCompare(y.name),
  );
}

/**
 * What separates the label's key from the qualifier's in a stored key. A
 * {@link conceptKey} never contains it, so `adresse` + `mémoire` cannot meet
 * a label that happens to read `adresse memoire`.
 */
const QUALIFIER_SEPARATOR = "|";

/**
 * The key a concept is unique by, per language (ADR-081 §5, addendum §3):
 * the label's {@link conceptKey}, then, when the concept has a qualifier,
 * the separator and the qualifier's key. `adresse (mémoire)` is
 * `adress|memoire`; `pointeurs` is `pointeur`. The one rule both the stored
 * column and the lookup of a qualified input go through.
 */
export function qualifiedConceptKey(label: string, qualifier = ""): string {
  const qualifierKey = conceptKey(qualifier);
  const labelKey = conceptKey(label);
  return qualifierKey
    ? `${labelKey}${QUALIFIER_SEPARATOR}${qualifierKey}`
    : labelKey;
}

/**
 * A label written with its qualifier, `adresse (mémoire)`: the bare label
 * and the qualifier, or null when the input does not end with one
 * parenthesised group after some text.
 */
export function splitQualifiedLabel(
  input: string,
): { label: string; qualifier: string } | null {
  const match = /^(.*?\S)\s*\(([^()]*\S[^()]*)\)\s*$/u.exec(input.trim());
  if (!match) return null;
  return { label: match[1]!, qualifier: match[2]!.trim() };
}

/**
 * Every concept of the vocabulary as the resolver sees it, merged ones
 * included. Its keys are computed here, from its labels and qualifiers
 * ({@link qualifiedConceptKey}): a caller hands over what the concept says,
 * never a stored key, which only serves the database's unique index.
 */
export interface ResolvableConcept {
  id: string;
  /** The concept it was merged into, always the final one (addendum §3); null when not merged. */
  mergedInto: string | null;
  /** Its label and qualifier in each language that has a label. */
  labels: readonly { label: string; qualifier: string }[];
  /** Other names it answers to, bare (curated aliases, ADR-081 §6); none by default. */
  aliases?: readonly string[];
}

/**
 * What a typed label designates (ADR-081 addendum §2): one concept, several
 * (homonyms, or an alias shared by two concepts) or none, with the "did you
 * mean" candidates. Ids, best first.
 */
export type LabelResolution =
  | { kind: "resolved"; id: string }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unknown"; candidates: string[] };

/**
 * Resolves what a teacher, a picker or an MCP client typed (ADR-081 §6 as
 * amended by addendum §2):
 *
 * 1. a concept's id resolves to it, a merged one to the concept it was
 *    merged into (one hop: `merged_into` always names the final concept);
 * 2. a label written with its qualifier resolves to the concept whose
 *    qualified key it equals;
 * 3. otherwise the input is matched against the bare labels and aliases of
 *    the concepts that are not merged: one exact match resolves; several
 *    are ambiguous; close matches only are unknown, with them as
 *    candidates; nothing is unknown without candidates.
 *
 * A qualified input that names no qualified concept falls to step 3 as
 * typed, so a label that really contains parentheses still matches.
 */
export function resolveConceptLabel(
  input: string,
  concepts: readonly ResolvableConcept[],
): LabelResolution {
  const direct = concepts.find((c) => c.id === input.trim());
  if (direct) return { kind: "resolved", id: direct.mergedInto ?? direct.id };

  const live = concepts.filter((c) => !c.mergedInto);
  const qualified = splitQualifiedLabel(input);
  if (qualified) {
    const key = qualifiedConceptKey(qualified.label, qualified.qualifier);
    const hits = live.filter((c) =>
      c.labels.some((l) => qualifiedConceptKey(l.label, l.qualifier) === key),
    );
    if (hits.length === 1) return { kind: "resolved", id: hits[0]!.id };
    // One language's key may equal another concept's key in the other language.
    if (hits.length > 1)
      return { kind: "ambiguous", candidates: hits.map((c) => c.id) };
  }

  const names: ConceptNames[] = live.map((c) => ({
    id: c.id,
    names: [...c.labels.map((l) => l.label), ...(c.aliases ?? [])],
  }));
  const matches = closeConcepts(input, names);
  const exact = matches.filter((m) => m.kind === "exact");
  if (exact.length === 1) return { kind: "resolved", id: exact[0]!.id };
  if (exact.length > 1)
    return { kind: "ambiguous", candidates: exact.map((m) => m.id) };
  return { kind: "unknown", candidates: matches.map((m) => m.id) };
}

/** One tag of one pool, with the number of live questions that wear it. */
export interface PoolTagCount {
  poolId: string;
  tag: string;
  count: number;
}

/** The tags of every pool that share one {@link conceptKey}. */
export interface TagGroup<T extends PoolTagCount> {
  /** The shared key; the tag itself, lowercased, when its key is empty. */
  key: string;
  /** The questions of the whole group: the sum of its pairs' counts. */
  count: number;
  /** Most worn first, then by tag, then by pool. */
  pairs: T[];
}

/** The key a tag is grouped under: its {@link conceptKey}, or the tag itself when that is empty. */
export function tagGroupKey(tag: string): string {
  return conceptKey(tag) || tag.trim().toLowerCase();
}

/**
 * The deterministic pre-pass of the sorting of the existing tags (ADR-081,
 * second addendum §3): the (pool, tag) pairs of every pool grouped by
 * {@link conceptKey}, so `pointeur` in one pool and `Pointeurs` in another
 * are reviewed, and later proposed to the model, together. A group never
 * decides anything: a homonym (`pile`) still gets one decision per pair.
 * Groups come most worn first, then by key, so the order is stable.
 */
export function groupTagsByConceptKey<T extends PoolTagCount>(
  pairs: readonly T[],
): TagGroup<T>[] {
  const groups = new Map<string, TagGroup<T>>();
  for (const pair of pairs) {
    const key = tagGroupKey(pair.tag);
    const group = groups.get(key) ?? { key, count: 0, pairs: [] };
    group.count += pair.count;
    group.pairs.push(pair);
    groups.set(key, group);
  }
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  for (const group of groups.values()) {
    group.pairs.sort(
      (a, b) =>
        b.count - a.count || byText(a.tag, b.tag) || byText(a.poolId, b.poolId),
    );
  }
  return [...groups.values()].sort(
    (a, b) => b.count - a.count || byText(a.key, b.key),
  );
}

/** A qualifier as stored: trimmed, inner spaces collapsed; nothing else touched. */
export function cleanConceptQualifier(qualifier: string): string {
  return qualifier.trim().replace(/\s+/g, " ");
}

type ConceptLanguage = "fr" | "en";
const CONCEPT_LANGUAGES: readonly ConceptLanguage[] = ["fr", "en"];

/** One language of a new concept, as asked. */
export interface NewConceptSideInput {
  label: string;
  qualifier?: string | undefined;
  description?: string | undefined;
}

/** One language of a new concept, cleaned, with its {@link qualifiedConceptKey}. */
export interface NewConceptSide {
  label: string;
  qualifier: string;
  description: string;
  key: string;
}

/** One concept to create, and the items that asked for it. */
export interface NewConceptGroup<T> {
  sides: Record<ConceptLanguage, NewConceptSide>;
  items: T[];
}

export type NewConceptGrouping<T> =
  | { kind: "ok"; concepts: NewConceptGroup<T>[] }
  /** Two concepts of the batch would share one language's key but not the other's. */
  | { kind: "clash"; items: T[] };

/**
 * The new concepts a batch of decisions asks for (ADR-081, second addendum
 * §2): requests with the same keys in both languages are ONE concept, with
 * the first request's labels and qualifiers and, per language, the first
 * non-empty description. Two concepts that would share a key in one language
 * only cannot both exist (the key is unique per language): a clash naming
 * the items of every concept involved. Groups keep the order of their first
 * request.
 */
export function groupNewConcepts<T>(
  requests: readonly {
    item: T;
    fr: NewConceptSideInput;
    en: NewConceptSideInput;
  }[],
): NewConceptGrouping<T> {
  const byKeys = new Map<string, NewConceptGroup<T>>();
  for (const request of requests) {
    const sides = {} as Record<ConceptLanguage, NewConceptSide>;
    for (const lang of CONCEPT_LANGUAGES) {
      const label = cleanConceptLabel(request[lang].label);
      const qualifier = cleanConceptQualifier(request[lang].qualifier ?? "");
      sides[lang] = {
        label,
        qualifier,
        description: request[lang].description ?? "",
        key: qualifiedConceptKey(label, qualifier),
      };
    }
    const keys = JSON.stringify([sides.fr.key, sides.en.key]);
    const group = byKeys.get(keys);
    if (!group) {
      byKeys.set(keys, { sides, items: [request.item] });
      continue;
    }
    group.items.push(request.item);
    for (const lang of CONCEPT_LANGUAGES) {
      if (!group.sides[lang].description)
        group.sides[lang].description = sides[lang].description;
    }
  }
  const concepts = [...byKeys.values()];
  const uses = new Map<string, number>();
  const use = (lang: ConceptLanguage, key: string) => `${lang}:${key}`;
  for (const c of concepts) {
    for (const lang of CONCEPT_LANGUAGES) {
      const k = use(lang, c.sides[lang].key);
      uses.set(k, (uses.get(k) ?? 0) + 1);
    }
  }
  const clashing = concepts.filter((c) =>
    CONCEPT_LANGUAGES.some(
      (lang) => uses.get(use(lang, c.sides[lang].key))! > 1,
    ),
  );
  return clashing.length > 0
    ? { kind: "clash", items: clashing.flatMap((c) => c.items) }
    : { kind: "ok", concepts };
}
