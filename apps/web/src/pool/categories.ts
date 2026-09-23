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
export function findCategory(nodes: readonly CategoryNode[], id: string): CategoryNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findCategory(node.children, id);
    if (found) return found;
  }
  return null;
}
