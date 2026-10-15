/**
 * The queue's tree reading (#897): the concepts drawn indented by hierarchy.
 */
import type { Concept } from "@quiz/contracts";

import type { Locale } from "../i18n";
import { broaderOf, byConceptName } from "./names";

/** A row of the tree: its concept, how deep, its other broader concepts, and whether it is only on the path. */
export interface TreeRow<C extends Concept> {
  concept: C;
  depth: number;
  /** The broader concepts other than the one it is drawn under, by name. */
  alsoUnder: C[];
  /** An ancestor of a shown concept, not shown itself: drawn only as the path. */
  pathOnly: boolean;
}

/**
 * The `shown` concepts, each under the broader concept its path follows (the
 * first by name, `broaderTrail`'s rule), roots first, siblings by name: every
 * concept once, a poly-hierarchy's other broader concepts in `alsoUnder`. A
 * shown concept brings its ancestors along that path, from `byId`, as
 * `pathOnly` rows when they are not shown themselves. The server refuses
 * cycles; should one be stored, the walk still ends, its concepts drawn from
 * the first by name.
 */
export function conceptTree<C extends Concept>(
  byId: ReadonlyMap<string, C>,
  shown: readonly C[],
  locale: Locale,
): TreeRow<C>[] {
  const broaderById = new Map<string, C[]>();
  const kept: C[] = [];
  for (const start of shown) {
    for (let at: C | undefined = start; at && !broaderById.has(at.id); ) {
      const broader: C[] = broaderOf(at, byId, locale);
      broaderById.set(at.id, broader);
      kept.push(at);
      at = broader[0];
    }
  }
  const sorted = kept.sort(byConceptName(locale));
  const children = new Map<string | undefined, C[]>();
  for (const c of sorted) {
    const parent = broaderById.get(c.id)![0]?.id;
    const siblings = children.get(parent) ?? children.set(parent, []).get(parent)!;
    siblings.push(c);
  }
  const shownIds = new Set(shown.map((c) => c.id));
  const rows: TreeRow<C>[] = [];
  const drawn = new Set<string>();
  const draw = (c: C, depth: number) => {
    if (drawn.has(c.id)) return;
    drawn.add(c.id);
    rows.push({ concept: c, depth, alsoUnder: broaderById.get(c.id)!.slice(1), pathOnly: !shownIds.has(c.id) });
    for (const child of children.get(c.id) ?? []) draw(child, depth + 1);
  };
  for (const root of children.get(undefined) ?? []) draw(root, 0);
  // A cycle has no root: its concepts are drawn from the first by name.
  for (const c of sorted) draw(c, 0);
  return rows;
}
