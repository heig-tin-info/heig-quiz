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

/** The lower-case letters NFKD keeps whole, and what `foldText` spells them as (the SQL fold of the catalogue reads this too). */
export const FOLD_LIGATURES: readonly (readonly [string, string])[] = [
  ["œ", "oe"],
  ["æ", "ae"],
  ["ß", "ss"],
];

/**
 * Lower-case, accents dropped, the ligatures `œ`, `æ`, `ß` (which NFKD keeps)
 * spelled out: what a label and a search term are compared as. The one fold
 * of concept keys and of the catalogue's search.
 */
export function foldText(text: string): string {
  const plain = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  return FOLD_LIGATURES.reduce((out, [ligature, spelled]) => out.replaceAll(ligature, spelled), plain);
}

/**
 * The matching key of a label. `+` and `#` survive inside a word, so `c`,
 * `c++` and `c#` stay three keys (`C ++` is `c++`); a `#` opening a word is
 * dropped (`#include`). The ligatures `œ`, `æ`, `ß`, which NFKD keeps, are
 * spelled out (`nœud` = `noeud`). A label made of linking words only keeps
 * them rather than collapsing to nothing.
 */
export function conceptKey(label: string): string {
  const words = foldText(label)
    .replace(/\s+(?=\+)/g, "")
    .split(/[^\p{L}\p{N}+#]+/u)
    .map((w) => w.replace(/^#+/, ""))
    .filter(Boolean);
  const meaningful = words.filter((w) => !LINKING_WORDS.has(w));
  return (meaningful.length > 0 ? meaningful : words).map(singular).join("-");
}

/**
 * The label a teacher typed, cleaned for display as a new concept's label
 * (an alias is cleaned the same way):
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
 * The edits between two keys when they are close enough for a "did you
 * mean" (see {@link tolerance}), else null. 0 means the same key. The one
 * rule of {@link closeConcepts} and {@link probableDuplicates}.
 */
export function keyDistance(a: string, b: string): number | null {
  const tol = tolerance(Math.min(a.length, b.length));
  if (Math.abs(a.length - b.length) > tol) return null;
  const distance = a === b ? 0 : editDistance(a, b);
  return distance > tol ? null : distance;
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
      const distance = keyDistance(key, conceptKey(name));
      if (distance === null) continue;
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
  labels: readonly { label: string; qualifier: string; lang?: ConceptLanguage }[];
  /**
   * Other names it answers to, bare (curated aliases, ADR-081 §6). An alias is matched exactly like a label: an input whose key is
   * a label's or an alias's resolves, and the same key on two concepts is
   * ambiguous.
   */
  aliases: readonly string[];
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
    names: [...c.labels.map((l) => l.label), ...c.aliases],
  }));
  const matches = closeConcepts(input, names);
  const exact = matches.filter((m) => m.kind === "exact");
  if (exact.length === 1) return { kind: "resolved", id: exact[0]!.id };
  if (exact.length > 1)
    return { kind: "ambiguous", candidates: exact.map((m) => m.id) };
  return { kind: "unknown", candidates: matches.map((m) => m.id) };
}

/**
 * Why an alias is refused or needs the admin's confirmation (ADR-081 §6,
 * fifth addendum). The alias is compared by {@link conceptKey} with the BARE
 * labels and the aliases of the other concepts that are not merged — the very
 * names {@link resolveConceptLabel} matches an unqualified input against — so
 * an alias that would make some input ambiguous is found here, before it is
 * stored.
 */
export type AliasCheck =
  /** The alias is a name the concept already has (a label, or the same alias): nothing to store. */
  | { kind: "redundant"; of: "label" | "alias" }
  /** Other concepts answer to this key already: stored only when forced. */
  | { kind: "collides"; with: { id: string; via: "label" | "alias" }[] }
  | { kind: "free" };

export function checkAlias(
  alias: string,
  self: ResolvableConcept,
  concepts: readonly ResolvableConcept[],
): AliasCheck {
  const key = conceptKey(alias);
  if (self.labels.some((l) => conceptKey(l.label) === key)) return { kind: "redundant", of: "label" };
  if (self.aliases.some((a) => conceptKey(a) === key)) return { kind: "redundant", of: "alias" };
  const hits: { id: string; via: "label" | "alias" }[] = [];
  for (const c of concepts) {
    if (c.id === self.id || c.mergedInto) continue;
    if (c.labels.some((l) => conceptKey(l.label) === key)) hits.push({ id: c.id, via: "label" });
    else if (c.aliases.some((a) => conceptKey(a) === key)) hits.push({ id: c.id, via: "alias" });
  }
  return hits.length > 0 ? { kind: "collides", with: hits } : { kind: "free" };
}

/**
 * What a merge does with aliases (ADR-081 §6, fifth addendum), as the texts
 * the winner ends up with: the loser's aliases `moved` to it, its labels
 * `added` as aliases when `keepLabels` (qualified ones as `label (qualifier)`),
 * and the loser's aliases `dropped` because the winner answers to their key
 * already (a label or an alias, the names {@link checkAlias} calls redundant).
 * A label the winner answers to is simply not added. Each key is taken once.
 */
export function mergedAliases(
  loser: ResolvableConcept,
  winner: ResolvableConcept,
  keepLabels: boolean,
): { moved: string[]; added: string[]; dropped: string[] } {
  const known = new Set([...winner.labels.map((l) => conceptKey(l.label)), ...winner.aliases.map(conceptKey)]);
  const out = { moved: [] as string[], added: [] as string[], dropped: [] as string[] };
  for (const alias of loser.aliases) {
    const key = conceptKey(alias);
    if (known.has(key)) out.dropped.push(alias);
    else out.moved.push(alias);
    known.add(key);
  }
  if (keepLabels) {
    for (const { label, qualifier } of loser.labels) {
      const text = qualifier ? `${label} (${qualifier})` : label;
      const key = conceptKey(text);
      if (known.has(key)) continue;
      known.add(key);
      out.added.push(text);
    }
  }
  return { moved: out.moved.sort(), added: out.added.sort(), dropped: out.dropped.sort() };
}

/**
 * The concepts a FILTER word designates (ADR-081 third addendum §7): the one
 * it resolves to — by id, by its qualified form or by one exact match — or,
 * when it is ambiguous, every homonym it may mean. Never a close-only
 * candidate: "did you mean" is a suggestion, not a match. Empty when the
 * word designates nothing; the caller says so rather than filtering on it.
 */
export function filterIds(resolution: LabelResolution): string[] {
  if (resolution.kind === "resolved") return [resolution.id];
  if (resolution.kind === "ambiguous") return [...resolution.candidates];
  return [];
}

/**
 * Why two concepts are flagged (ADR-081 fifth addendum §4), in precedence
 * order: a pair carries the first reason that holds.
 * - `alias`: {@link checkAlias} finds that an alias of one collides with
 *   the other (one of its labels or aliases), so the typed word is ambiguous
 *   for every teacher;
 * - `translation`: a label of one has the same qualified key as a label of
 *   the other (the per-language unique index makes that a French label
 *   against an English one);
 * - `homonym`: the same bare label under different qualifiers. Often
 *   legitimate: the admin checks the qualifiers, a merge is not proposed;
 * - `close`: two labels a few edits apart ({@link keyDistance}, the
 *   resolver's own rule), but not the same.
 */
export const DUPLICATE_REASONS = ["alias", "translation", "homonym", "close"] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

/**
 * The kinds a model files a pair under (ADR-081 fifth addendum §4, PR4b): the
 * reasons that need no alias (it never sees them), and `related` — distinct
 * concepts that are connected, never merged (the relations of step 7).
 */
export const AI_DUPLICATE_KINDS = ["translation", "homonym", "close", "related"] as const satisfies readonly (DuplicateReason | "related")[];
export type AiDuplicateKind = (typeof AI_DUPLICATE_KINDS)[number];

type Label = ResolvableConcept["labels"][number];

/** A live concept and its labels' keys, computed once. */
interface Live<C extends ResolvableConcept = ResolvableConcept> {
  concept: C;
  labels: { label: Label; bare: string; full: string }[];
}

/** The labels of two concepts that share a qualified key (a French one against an English one, per the unique index). */
const translationMatch = (x: Live, y: Live): [Label, Label] | undefined => {
  for (const l of x.labels) {
    const o = y.labels.find((m) => m.full === l.full);
    if (o) return [l.label, o.label];
  }
  return undefined;
};

/** Whether an alias of `c` collides with `other`, asked of {@link checkAlias} as if `c` had no other name (an alias is never "redundant" with itself). */
const clashes = (c: ResolvableConcept, other: ResolvableConcept) =>
  c.aliases.some((a) => checkAlias(a, { ...c, labels: [], aliases: [] }, [other]).kind === "collides");

const TESTS: Record<DuplicateReason, (x: Live, y: Live) => boolean> = {
  alias: (x, y) => clashes(x.concept, y.concept) || clashes(y.concept, x.concept),
  translation: (x, y) => translationMatch(x, y) !== undefined,
  homonym: (x, y) => x.labels.some((l) => y.labels.some((o) => l.bare === o.bare && l.full !== o.full)),
  close: (x, y) => x.labels.some((l) => y.labels.some((o) => (keyDistance(l.bare, o.bare) ?? 0) > 0)),
};

export interface DuplicatePair<C> {
  a: C;
  b: C;
  reason: DuplicateReason;
  /** For a `translation`: the label of `a` and the label of `b` that match. */
  match?: [Label, Label];
}

/**
 * The pairs of concepts that are probably one (ADR-081 fifth addendum §4),
 * computed from labels, qualifiers and aliases alone: no model, nothing
 * stored. Merged concepts are left out. At most one pair, with its first
 * {@link DuplicateReason}, per two concepts; ordered by reason, then ids,
 * the lower id first.
 *
 * Every pair is compared (a concept's keys are computed once), so the cost
 * is quadratic in the vocabulary: meant for hundreds of concepts, which the
 * vocabulary is (tens of thousands of comparisons).
 */
export function probableDuplicates<C extends ResolvableConcept>(concepts: readonly C[]): DuplicatePair<C>[] {
  const live = concepts
    .filter((c) => !c.mergedInto)
    .sort((p, q) => (p.id < q.id ? -1 : 1))
    .map((concept) => ({
      concept,
      labels: concept.labels.map((label) => ({
        label,
        bare: conceptKey(label.label),
        full: qualifiedConceptKey(label.label, label.qualifier),
      })),
    }));
  const out: DuplicatePair<C>[] = [];
  for (const [i, x] of live.entries()) {
    for (const y of live.slice(i + 1)) {
      const reason = DUPLICATE_REASONS.find((r) => TESTS[r](x, y));
      const match = reason === "translation" ? translationMatch(x, y) : undefined;
      if (reason) out.push({ a: x.concept, b: y.concept, reason, ...(match && { match }) });
    }
  }
  const rank = (r: DuplicateReason) => DUPLICATE_REASONS.indexOf(r);
  // `sort` is stable and the pairs came in id order.
  return out.sort((p, q) => rank(p.reason) - rank(q.reason));
}

/**
 * Which of two probable duplicates goes into the other (a merge target is
 * validated, fifth addendum §2), or null when neither can be the target.
 * With two validated ones the less used goes; the first on a tie.
 */
export function mergeDirection<C extends { status: string; questionCount: number }>(
  a: C,
  b: C,
): { loser: C; target: C } | null {
  if (a.status !== "validated" && b.status !== "validated") return null;
  if (a.status !== "validated") return { loser: a, target: b };
  if (b.status !== "validated") return { loser: b, target: a };
  return b.questionCount < a.questionCount ? { loser: b, target: a } : { loser: a, target: b };
}

/** The longest label, and qualifier, a concept takes (the contracts' bound). */
export const CONCEPT_LABEL_MAX = 120;
export const CONCEPT_QUALIFIER_MAX = 120;
/** The longest description of one language of a concept. */
export const CONCEPT_DESCRIPTION_MAX = 500;
/** A label must hold a letter or a digit, so that its key is never empty. */
export const CONCEPT_LABEL_PATTERN = /[\p{L}\p{N}]/u;

/** A qualifier as stored: trimmed, inner spaces collapsed; nothing else touched. */
export function cleanConceptQualifier(qualifier: string): string {
  return qualifier.trim().replace(/\s+/g, " ");
}

export type ConceptLanguage = "fr" | "en";
