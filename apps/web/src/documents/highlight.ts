/**
 * Paints the search matches of a Markdown document: every match in one
 * tone, the current one in another (`.doc-match`, `.doc-current` and their
 * `::highlight()` twins, `style.css`).
 *
 * Where the CSS Custom Highlight API exists, nothing of the rendered HTML
 * changes: the ranges are registered under two names. The registry is the
 * page's, not the viewer's, and several viewers may be mounted at once (the
 * player's panel keeps one per document), so the names hold the union of
 * every painter's ranges. Where it does not (an older Safari or Firefox, and
 * Safe Exam Browser on macOS is WebKit), the matches are wrapped in `<mark>`
 * elements, which {@link MatchPainter.clear} takes out again, leaving the
 * text nodes as they were.
 */
import "./highlight.css";

import type { TextMatch } from "./search";

export const MATCH_HIGHLIGHT = "doc-match";
export const CURRENT_HIGHLIGHT = "doc-current";

export interface MatchPainter {
  /**
   * Paints `matches` (found in the current DOM, after {@link clear}) and
   * returns one range per match, for geometry: which one is on screen, where
   * to scroll.
   */
  paint(matches: TextMatch[]): Range[];
  /** Marks the current match (-1: none). */
  select(index: number): void;
  /** Takes every match out; the text nodes are whole again. */
  clear(): void;
}

/** The ranges of every painter of the page, by painter. */
const painted = new Map<object, { all: Range[]; current: Range | null }>();

function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && CSS.highlights != null && typeof Highlight === "function";
}

/** Registers the union of every painter's ranges under the two names. */
function publish(): void {
  const all: Range[] = [];
  const current: Range[] = [];
  for (const entry of painted.values()) {
    all.push(...entry.all);
    if (entry.current) current.push(entry.current);
  }
  CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...all));
  CSS.highlights.set(CURRENT_HIGHLIGHT, new Highlight(...current));
}

function rangeOf(match: TextMatch): Range {
  const range = new Range();
  const first = match[0]!;
  const last = match[match.length - 1]!;
  range.setStart(first.node, first.start);
  range.setEnd(last.node, last.end);
  return range;
}

function highlightPainter(): MatchPainter {
  const key = {};
  let ranges: Range[] = [];
  return {
    paint(matches) {
      ranges = matches.map(rangeOf);
      painted.set(key, { all: ranges, current: null });
      publish();
      return ranges;
    },
    select(index) {
      painted.set(key, { all: ranges, current: ranges[index] ?? null });
      publish();
    },
    clear() {
      ranges = [];
      if (painted.delete(key)) publish();
    },
  };
}

function markPainter(root: Element): MatchPainter {
  let marks: HTMLElement[][] = [];
  return {
    paint(matches) {
      const doc = root.ownerDocument;
      marks = matches.map(() => []);
      // From the last segment back: splitting a text node keeps the offsets
      // of everything before the split valid.
      for (let m = matches.length - 1; m >= 0; m--) {
        const match = matches[m]!;
        for (let s = match.length - 1; s >= 0; s--) {
          const { node, start, end } = match[s]!;
          const middle = node.splitText(start);
          middle.splitText(end - start);
          const mark = doc.createElement("mark");
          mark.className = MATCH_HIGHLIGHT;
          middle.replaceWith(mark);
          mark.append(middle);
          marks[m]!.unshift(mark);
        }
      }
      return marks.map((group) => {
        const range = doc.createRange();
        range.setStartBefore(group[0]!);
        range.setEndAfter(group[group.length - 1]!);
        return range;
      });
    },
    select(index) {
      marks.forEach((group, i) => {
        for (const mark of group) mark.classList.toggle(CURRENT_HIGHLIGHT, i === index);
      });
    },
    clear() {
      const parents = new Set<Node>();
      for (const mark of marks.flat()) {
        const parent = mark.parentNode;
        if (!parent) continue;
        mark.replaceWith(...mark.childNodes);
        parents.add(parent);
      }
      for (const parent of parents) parent.normalize();
      marks = [];
    },
  };
}

/** The painter for `root`: highlights where the browser has them, marks otherwise. */
export function createPainter(root: Element, { marks = !highlightsSupported() } = {}): MatchPainter {
  return marks ? markPainter(root) : highlightPainter();
}
