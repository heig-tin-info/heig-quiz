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
