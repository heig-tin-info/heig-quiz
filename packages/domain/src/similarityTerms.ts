/**
 * The words of a statement worth matching when looking for a question that
 * already says the same thing (ADR-022, addendum of 2026-10-01).
 *
 * The question index is a `simple` tsvector: no stemming and no stop words,
 * so a query made of every word of a statement would match half the pool on
 * `les`, `the` or `quelle`. This keeps what carries meaning — words of three
 * characters or more, outside a short French and English stop list —
 * lower-cased, deduplicated, in their first order, at most `max` of them.
 *
 * Every term is letters and digits only (`\p{L}\p{N}`), so the caller may
 * join them with ` | ` into a `to_tsquery` without any escaping.
 */

const STOP_WORDS = new Set([
  // French
  "les", "des", "une", "est", "sont", "que", "qui", "quoi", "quel", "quelle", "quels", "quelles",
  "lequel", "laquelle", "lesquels", "lesquelles", "dans", "pour", "par", "sur", "sous", "avec",
  "sans", "pas", "plus", "moins", "son", "sa", "ses", "aux", "ces", "cet", "cette", "leur", "leurs",
  "elle", "elles", "ils", "nous", "vous", "mais", "ont", "été", "être", "avoir", "fait", "comme",
  "tout", "tous", "toute", "toutes", "entre", "comment", "combien", "pourquoi", "suivant",
  "suivante", "suivants", "suivantes", "parmi", "donc", "car", "alors", "votre", "vos", "notre",
  "nos", "peut", "doit", "quand", "chaque", "lors", "afin", "ainsi", "cela", "ceci", "celui",
  "celle", "ceux", "très", "aussi", "encore", "déjà",
  // English
  "the", "and", "for", "with", "what", "which", "who", "whom", "that", "this", "these", "those",
  "are", "was", "were", "from", "into", "onto", "how", "why", "when", "where", "does", "did",
  "not", "has", "have", "had", "its", "can", "will", "would", "should", "could", "following",
  "than", "then", "there", "their", "them", "they", "you", "your", "our", "but", "all", "any",
  "each", "about", "between", "among", "below", "above", "given",
]);

/** The meaningful words of `text`, as `to_tsquery('simple')` terms. */
export function similarityTerms(text: string, max = 32): string[] {
  const out = new Set<string>();
  for (const word of text.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    out.add(word);
    if (out.size === max) break;
  }
  return [...out];
}
