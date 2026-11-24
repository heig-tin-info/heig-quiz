/**
 * Search in a rendered Markdown document: what a query matches, as offsets
 * in the document's text nodes. Painting the matches is `highlight.ts`'s.
 *
 * The comparison ignores case and accents ("resume" finds "Résumé"), treats
 * every kind of space as one (the French narrow no-break space before a
 * colon, `docrender/typography.ts`, is typed as a plain space), and the
 * typographic apostrophe as the straight one. Each UTF-16 unit folds to
 * exactly one unit, so an offset in the folded text IS an offset in the DOM.
 */

/** Folds one UTF-16 unit to one unit: lower case, no accent, plain space and apostrophe. */
function foldUnit(unit: string): string {
  if (/\s/.test(unit)) return " ";
  if (unit === "’" || unit === "‘" || unit === "ʼ") return "'";
  const code = unit.charCodeAt(0);
  // A half of a surrogate pair cannot be normalised on its own; it is compared as is.
  if (code >= 0xd800 && code <= 0xdfff) return unit;
  const folded = unit.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (folded.length === 1) return folded;
  const lower = unit.toLowerCase();
  return lower.length === 1 ? lower : unit;
}

/** `text` folded for search, unit for unit (same length, same offsets). */
export function foldText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += foldUnit(text[i]!);
  return out;
}

/** The folded form of what the student typed: trimmed, and nothing when only spaces. */
export function foldQuery(query: string): string {
  return foldText(query.trim());
}

/** Where `needle` starts in `haystack`, both folded: every match, left to right, never overlapping. */
export function matchOffsets(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) found.push(i);
  return found;
}

/** The part of one match inside one text node. */
export interface MatchSegment {
  node: Text;
  start: number;
  end: number;
}

/** One match: its segments in document order (a match may span `<em>` or `<code>`). */
export type TextMatch = MatchSegment[];

/**
 * Every match of `query` in the text of `root`, in document order. KaTeX
 * writes each formula twice, MathML for a screen reader and HTML for the
 * eye: only the visible copy is searched.
 */
export function findTextMatches(root: Element, query: string): TextMatch[] {
  const needle = foldQuery(query);
  if (!needle) return [];
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest(".katex-mathml") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push({ node: n, start: text.length });
    text += foldText(n.data);
  }
  /** The index of the node holding the unit at `offset`. */
  const locate = (offset: number) => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (nodes[mid]!.start <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return matchOffsets(text, needle).map((at) => {
    const end = at + needle.length;
    const segments: TextMatch = [];
    for (let i = locate(at); i < nodes.length && nodes[i]!.start < end; i++) {
      const { node, start } = nodes[i]!;
      const from = Math.max(at - start, 0);
      const to = Math.min(end - start, node.data.length);
      if (to > from) segments.push({ node, start: from, end: to });
    }
    return segments;
  });
}
