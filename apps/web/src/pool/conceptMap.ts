/**
 * The view model of a pool's concept map (ADR-116 §2, §3, §6), pure: what one
 * level of the map draws, which path of the address still holds, and what a
 * search keeps. The counts are the server's (`PoolConceptMap`); nothing here
 * counts a question.
 *
 * The hierarchy is unfolded: a concept with several broader concepts is a
 * child of each, so it appears in several levels, never twice in one.
 */
import type { ConceptRef, PoolConceptMap, PoolConceptNode } from "@quiz/contracts";
import { broaderAncestorsOf, narrowerDescendantsOf } from "@quiz/domain";

import { refName } from "../concepts/names";

export interface MapIndex {
  byId: ReadonlyMap<string, PoolConceptNode>;
  /** The direct narrower concepts of `id` within the reach, in the map's order (by label). */
  children: (id: string) => readonly string[];
  /** The top concepts: those with no broader concept. */
  roots: readonly string[];
  broader: PoolConceptMap["broader"];
}

export function mapIndex(map: PoolConceptMap): MapIndex {
  const byId = new Map(map.nodes.map((n) => [n.concept.id, n]));
  const narrower = new Map<string, Set<string>>();
  for (const { concept, target } of map.broader) {
    if (!byId.has(concept) || !byId.has(target)) continue;
    if (!narrower.has(target)) narrower.set(target, new Set());
    narrower.get(target)!.add(concept);
  }
  const hasBroader = new Set(map.broader.filter((e) => byId.has(e.target)).map((e) => e.concept));
  const ordered = (ids: ReadonlySet<string> | undefined) =>
    ids ? map.nodes.map((n) => n.concept.id).filter((id) => ids.has(id)) : [];
  const children = new Map([...narrower].map(([id, set]) => [id, ordered(set)]));
  return {
    byId,
    children: (id) => children.get(id) ?? [],
    roots: map.nodes.map((n) => n.concept.id).filter((id) => !hasBroader.has(id)),
    broader: map.broader,
  };
}

/**
 * What a search keeps (ADR-116 §6): `concepts`, the matching concepts with
 * their ancestors (so the path to them stays drawable) and their
 * descendants; `itself`, those whose "itself" cell stays — a match or a
 * concept under one, never an ancestor kept only for the path.
 */
export interface Branches {
  concepts: ReadonlySet<string>;
  itself: ReadonlySet<string>;
}

export type MapCell =
  /** `zooms`: the level below draws some of its narrower concepts. */
  | { kind: "concept"; node: PoolConceptNode; value: number; zooms: boolean }
  | { kind: "itself"; node: PoolConceptNode; value: number };

/**
 * The cells of one level: at the root, the top concepts; at a concept, its
 * narrower concepts and, when some of its questions are on none of them, an
 * "itself" cell (§2). Each concept cell's value is its covered count.
 */
export function levelCells(index: MapIndex, at: string | null, kept: Branches | null = null): MapCell[] {
  const keep = (id: string) => kept === null || kept.concepts.has(id);
  const ids = at === null ? index.roots : index.children(at);
  const cells: MapCell[] = ids.filter(keep).map((id) => {
    const node = index.byId.get(id)!;
    return { kind: "concept", node, value: node.covered, zooms: index.children(id).some(keep) };
  });
  const node = at === null ? undefined : index.byId.get(at);
  if (node && node.own > 0 && (kept === null || kept.itself.has(node.concept.id))) {
    cells.push({ kind: "itself", node, value: node.own });
  }
  return cells;
}

/**
 * The longest prefix of `ids` that is a path of the map: a top concept, then
 * each id a narrower concept of the one before. An address whose concept or
 * edge has gone lands on the deepest level still there.
 */
export function validPath(index: MapIndex, ids: readonly string[]): string[] {
  const path: string[] = [];
  for (const id of ids) {
    const fits = path.length === 0 ? index.roots.includes(id) : index.children(path.at(-1)!).includes(id);
    if (!fits) break;
    path.push(id);
  }
  return path;
}

/** Whether a concept's name holds the search, as the table's filter reads it. */
export const nameHolds = (concept: ConceptRef, needle: string) =>
  refName(concept).toLowerCase().includes(needle.trim().toLowerCase());

/** What a search keeps of the map, or `null` when nothing is typed. */
export function branches(index: MapIndex, needle: string): Branches | null {
  if (needle.trim() === "") return null;
  const matches = [...index.byId.values()].filter((n) => nameHolds(n.concept, needle)).map((n) => n.concept.id);
  const below = [...narrowerDescendantsOf(index.broader, matches).values()].flat();
  const itself = new Set([...matches, ...below]);
  const above = [...broaderAncestorsOf(index.broader, matches).values()].flat();
  return { concepts: new Set([...itself, ...above]), itself };
}

/** The part of the path a search still draws; the address keeps the whole of it. */
export function shownPath(path: readonly string[], kept: Branches | null): string[] {
  const end = kept === null ? -1 : path.findIndex((id) => !kept.concepts.has(id));
  return end === -1 ? [...path] : path.slice(0, end);
}
