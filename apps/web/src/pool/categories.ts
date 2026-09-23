import type { CategoryNode } from "@quiz/contracts";

/**
 * The two walks of a pool's category tree, written once. The pool page, the
 * bulk bar, the sidebar tree and the question's metadata panel each used to
 * carry a private copy.
 */

/** "Pointeurs / Arithmétique" for every node, and the tree's own order. */
export function categoryPaths(
  nodes: readonly CategoryNode[],
  prefix = "",
): { id: string; label: string }[] {
  return nodes.flatMap((node) => {
    const label = prefix ? `${prefix} / ${node.name}` : node.name;
    return [{ id: node.id, label }, ...categoryPaths(node.children, label)];
  });
}

/** The node of `id` anywhere in the tree. */
export function findCategory<T extends { id: string; children: readonly T[] }>(
  nodes: readonly T[],
  id: string,
): T | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findCategory(node.children, id);
    if (found) return found;
  }
  return null;
}

// --- Moving folders ------------------------------------------------------------

/** The part of a folder the moves read: any tree of `CategoryNode` shape. */
interface Folder {
  id: string;
  parentId: string | null;
  children: readonly Folder[];
}

/** One line of `PUT /pools/:id/categories/order`. */
export interface OrderItem {
  id: string;
  parentId: string | null;
  position: number;
}

/** Where a folder goes: under `parentId` (null is the root), at `index` among its new siblings. */
export interface FolderTarget {
  parentId: string | null;
  index: number;
}

/** `id` and every folder under it: the places a folder can never be moved into. */
export function subtreeIds(nodes: readonly Folder[], id: string): Set<string> {
  const ids = new Set<string>();
  const node = findCategory(nodes, id);
  const walk = (n: Folder) => {
    ids.add(n.id);
    n.children.forEach(walk);
  };
  if (node) walk(node);
  return ids;
}

function childrenOf(nodes: readonly Folder[], parentId: string | null): readonly Folder[] {
  if (parentId === null) return nodes;
  return findCategory(nodes, parentId)?.children ?? [];
}

/**
 * The payload that moves `id` to `target`: both sibling lists it touches —
 * the one it leaves and the one it joins — renumbered from 0, so positions
 * stay dense and the server never has to guess an order. `null` when the move
 * is not one: a folder into itself or its own subtree, or where it already is.
 */
export function moveFolder(
  nodes: readonly Folder[],
  id: string,
  target: FolderTarget,
): OrderItem[] | null {
  const node = findCategory(nodes, id);
  if (!node) return null;
  if (target.parentId !== null && subtreeIds(nodes, id).has(target.parentId)) return null;
  const leaving = childrenOf(nodes, node.parentId).filter((n) => n.id !== id);
  const joining =
    target.parentId === node.parentId
      ? [...leaving]
      : childrenOf(nodes, target.parentId).filter((n) => n.id !== id);
  const index = Math.max(0, Math.min(target.index, joining.length));
  const from = childrenOf(nodes, node.parentId).findIndex((n) => n.id === id);
  if (target.parentId === node.parentId && index === from) return null;
  joining.splice(index, 0, node);
  const items = joining.map((n, i) => ({ id: n.id, parentId: target.parentId, position: i }));
  if (target.parentId !== node.parentId) {
    items.push(...leaving.map((n, i) => ({ id: n.id, parentId: node.parentId, position: i })));
  }
  return items;
}

/** The four keyboard moves of a folder, as targets; `null` where the move does not exist. */
export function neighbourMoves(
  nodes: readonly Folder[],
  id: string,
): Record<"up" | "down" | "indent" | "outdent", FolderTarget | null> {
  const node = findCategory(nodes, id);
  if (!node) return { up: null, down: null, indent: null, outdent: null };
  const siblings = childrenOf(nodes, node.parentId);
  const i = siblings.findIndex((n) => n.id === id);
  const previous = i > 0 ? siblings[i - 1]! : null;
  const parent = node.parentId ? findCategory(nodes, node.parentId) : null;
  return {
    up: i > 0 ? { parentId: node.parentId, index: i - 1 } : null,
    down: i < siblings.length - 1 ? { parentId: node.parentId, index: i + 1 } : null,
    // Into the folder just above, as its last child: the outline editor's Tab.
    indent: previous ? { parentId: previous.id, index: previous.children.length } : null,
    // Out of the parent, right after it: Shift+Tab.
    outdent: parent
      ? {
          parentId: parent.parentId,
          index: childrenOf(nodes, parent.parentId).findIndex((n) => n.id === parent.id) + 1,
        }
      : null,
  };
}

/**
 * The tree as it will be once `items` is applied: what the categories page
 * draws the moment a folder is dropped, before the server has answered. The
 * server applies the same payload, so the refetch that follows agrees.
 */
export function applyOrder<T extends Folder & { position: number; children: readonly T[] }>(
  nodes: readonly T[],
  items: readonly OrderItem[],
): T[] {
  const flat: T[] = [];
  const walk = (n: T) => {
    flat.push(n);
    n.children.forEach(walk);
  };
  nodes.forEach(walk);
  const moved = new Map(items.map((i) => [i.id, i]));
  const rows = flat.map((n) => {
    const item = moved.get(n.id);
    return item ? { ...n, parentId: item.parentId, position: item.position } : { ...n };
  });
  const byParent = new Map<string | null, T[]>();
  for (const row of rows) {
    const list = byParent.get(row.parentId) ?? [];
    list.push(row);
    byParent.set(row.parentId, list);
  }
  const build = (parentId: string | null): T[] =>
    (byParent.get(parentId) ?? [])
      .sort((a, b) => a.position - b.position)
      .map((row) => ({ ...row, children: build(row.id) }));
  return build(null);
}
