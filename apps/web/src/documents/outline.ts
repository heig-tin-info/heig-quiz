/**
 * The outline of a document: its entries in reading order, two levels deep,
 * and the nesting the outline panel draws them with.
 */
import type { JournalTocEntry } from "@quiz/contracts";

export interface OutlineItem {
  title: string;
  /** 1 or 2: a top entry, or one under the entry before it. */
  level: 1 | 2;
}


/**
 * The outline of a Markdown document, from its table of contents: the two
 * shallowest heading levels under the title. A lone `h1` is the document's
 * title, which the reader already sees on top: it is left out when the
 * document has other headings.
 */
export function markdownOutline(toc: readonly JournalTocEntry[]): { items: OutlineItem[]; ids: string[] } {
  let entries = toc.filter((e) => e.text.trim() !== "");
  const titles = entries.filter((e) => e.depth === 1);
  if (titles.length === 1 && entries.length > 1) entries = entries.filter((e) => e !== titles[0]);
  const top = Math.min(...entries.map((e) => e.depth));
  const kept = entries.filter((e) => e.depth <= top + 1);
  return {
    items: kept.map((e) => ({ title: e.text, level: e.depth === top ? 1 : 2 })),
    ids: kept.map((e) => e.id),
  };
}

/** An entry and the entries nested under it, for a list of lists. */
export interface OutlineNode {
  index: number;
  item: OutlineItem;
  children: OutlineNode[];
}

/** The flat outline as a tree: a level-2 entry hangs under the level-1 entry before it, or stands alone at the top. */
export function outlineTree(items: readonly OutlineItem[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  items.forEach((item, index) => {
    const node: OutlineNode = { index, item, children: [] };
    const parent = roots[roots.length - 1];
    if (item.level === 2 && parent && parent.item.level === 1) parent.children.push(node);
    else roots.push(node);
  });
  return roots;
}

/** The entry the reader is in: the last one starting at or before `position` (null positions never count). */
export function currentEntry(starts: readonly (number | null)[], position: number): number {
  let index = -1;
  starts.forEach((start, i) => {
    if (start !== null && start <= position) index = i;
  });
  return index;
}
