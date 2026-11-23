/**
 * Sections (ADR-143, amending ADR-084): a text before an item that applies
 * to the following questions too. ONE definition, read by the API (the
 * student's order, where each text is shown, the removal of a section's
 * first item) and by the web app (the builder's span, the removal's
 * confirmation, the mock's order), so the builder can never describe a
 * section the player does not play.
 *
 * - A text whose scope is `following` OPENS a section: from its item up to,
 *   and excluding, the next item whose text is `following`, or to the end.
 * - A text whose scope is `item` is a passage before its own item, as
 *   ADR-084 has it; inside a section it does not end the section.
 * - The items before the first `following` text form a leading segment,
 *   which is no section.
 */
import { rng, shuffleWith, streamSeed } from "@quiz/core/rng";

/** What an item's text applies to: its own item, or the questions that follow it too. */
export const INTRO_SCOPES = ["item", "following"] as const;
export type IntroScope = (typeof INTRO_SCOPES)[number];

/** What the section rules read of an item. */
export interface SectionItem {
  id: string;
  intro: string | null;
  introScope: IntroScope;
}

/** Whether the item's text opens a section: a text, applying to the following questions. */
export const opensSection = (item: Omit<SectionItem, "id">): boolean =>
  item.intro !== null && item.introScope === "following";

/** One run of the item list: a section, opened by `head`, or the leading run (`head` null). */
export interface ItemSegment<T> {
  head: T | null;
  items: T[];
}

/**
 * The item list, in its canonical order, cut into segments: the leading run
 * (only when it holds items), then one segment per section. An empty list
 * has none.
 */
export function itemSegments<T>(items: readonly T[], read: (item: T) => SectionItem): ItemSegment<T>[] {
  const segments: ItemSegment<T>[] = [];
  for (const item of items) {
    const last = segments.at(-1);
    if (opensSection(read(item))) segments.push({ head: item, items: [item] });
    else if (last) last.items.push(item);
    else segments.push({ head: null, items: [item] });
  }
  return segments;
}

/**
 * The student's order of the items (F-EVAL-09). Without `shuffle`, the
 * canonical order. With it, the sections keep their authored order and the
 * items are shuffled inside each segment, all from ONE stream,
 * `streamSeed(seed, evaluationId, "items")`, consumed segment after
 * segment. A list with no section is one segment, so its order is exactly
 * `shuffle(items, streamSeed(seed, evaluationId, "items"))` — the order
 * every attempt before sections was drawn with, and that attempts, their
 * regrade and a reprinted paper recompute.
 */
export function sectionedOrder<T>(
  items: readonly T[],
  read: (item: T) => SectionItem,
  draw: { shuffle: boolean; seed: number; evaluationId: string },
): T[] {
  if (!draw.shuffle) return [...items];
  const next = rng(streamSeed(draw.seed, draw.evaluationId, "items"));
  return itemSegments(items, read).flatMap((segment) => shuffleWith(segment.items, next));
}

/** Where a text is shown: before this item, and the section it belongs to (its head's id). */
export interface PlacedIntro {
  /** The text shown before the item in this order; null for none. */
  intro: string | null;
  /** The id of the item that opens the item's section; null outside a section. */
  section: string | null;
}

/** Between a section's text and the item's own text, when one item shows both. */
export const INTRO_SEPARATOR = "\n\n";

/**
 * Which text is shown before each item of `ordered` (a {@link sectionedOrder}
 * of `canonical`), aligned with it. An `item` text stays on its item; a
 * section's text goes to the FIRST item of its section in this order — its
 * head without shuffle, whichever question was drawn first with it — so it is
 * never read mid-section. Should that item carry a text of its own, both are
 * shown as one passage, the section's first.
 */
export function placeIntros<T>(
  canonical: readonly T[],
  ordered: readonly T[],
  read: (item: T) => SectionItem,
): PlacedIntro[] {
  const headOf = new Map<string, SectionItem>();
  for (const segment of itemSegments(canonical, read)) {
    if (segment.head === null) continue;
    const head = read(segment.head);
    for (const item of segment.items) headOf.set(read(item).id, head);
  }
  const opened = new Set<string>();
  return ordered.map((entry) => {
    const item = read(entry);
    const head = headOf.get(item.id) ?? null;
    const own = item.introScope === "item" ? item.intro : null;
    if (head === null) return { intro: own, section: null };
    if (opened.has(head.id)) return { intro: own, section: head.id };
    opened.add(head.id);
    return { intro: own === null ? head.intro : `${head.intro}${INTRO_SEPARATOR}${own}`, section: head.id };
  });
}

/**
 * What becomes of the text of `itemId` when the item is removed: a
 * section's text moves to the next item when that item is in the same
 * section and has no text of its own (`moveTo`); otherwise the text goes
 * with its item (`dropped`, when there was one). Drag never moves a text:
 * only a removal does.
 */
export function textOnRemoval<T>(
  items: readonly T[],
  itemId: string,
  read: (item: T) => SectionItem,
): { moveTo: string | null; dropped: boolean } {
  const index = items.findIndex((item) => read(item).id === itemId);
  const removed = index < 0 ? null : read(items[index]!);
  if (removed === null || removed.intro === null) return { moveTo: null, dropped: false };
  const next = items[index + 1];
  const following = next === undefined ? null : read(next);
  if (opensSection(removed) && following !== null && following.intro === null) {
    return { moveTo: following.id, dropped: false };
  }
  return { moveTo: null, dropped: true };
}

/**
 * The span of each section, in canonical positions: the head's id, the ids
 * of the items it covers (the head included), for the builder's band ("
 * questions 5 to 7") and its rule beside them.
 */
export function sectionSpans<T>(items: readonly T[], read: (item: T) => SectionItem): Map<string, string[]> {
  const spans = new Map<string, string[]>();
  for (const segment of itemSegments(items, read)) {
    if (segment.head !== null) spans.set(read(segment.head).id, segment.items.map((item) => read(item).id));
  }
  return spans;
}
