/**
 * The pure half of a project's student handout (ported from classroom's
 * `github/studentize.ts`); the file-system work around it stays in
 * `apps/api/src/github/`.
 */

/**
 * Relative paths listed in a `.studentignore` (teacher-only paths removed
 * from a project's student handout): one per line, `#` for comments, no
 * globs. Anything that could leave the tree or touch the git metadata (`..`,
 * `.`, `.git`) is dropped, not honored.
 */
export function parseStudentIgnore(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const path = line.replace(/^\/+/, "").replace(/\/+$/, "");
    const parts = path.split("/");
    if (path === "" || parts.some((p) => p === "" || p === "." || p === "..")) continue;
    if (parts[0] === ".git") continue;
    out.push(path);
  }
  return out;
}

/** The handout's own conventions: the overlay directory and the ignore file (`apps/api/src/github/studentize.ts`). */
export const HANDOUT_OVERLAY = "student";
export const HANDOUT_IGNORE = ".studentignore";

/** One entry of a repository's tree: a file (`blob`) or a directory (`tree`). */
export interface TreeEntry {
  path: string;
  type: "blob" | "tree";
}

/** An entry of the handed-out tree, and the source path it comes from (`student/x` for an overlaid `x`). */
export interface HandoutEntry extends TreeEntry {
  from: string;
}

/** `path` is `root` or lies under it. */
export const pathWithin = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/**
 * The tree the students receive under the `squash` strategy, from the
 * source's tree and its `.studentignore` (`parseStudentIgnore`): what
 * `applyStudentHandout` does on disk, on paths. The `student/` directory is
 * overlaid on the root (an overlaid file replaces the root's) and removed,
 * then every ignored path and its content, and the ignore file itself.
 * Sorted by path.
 */
export function handoutTree(entries: readonly TreeEntry[], ignored: readonly string[]): HandoutEntry[] {
  const overlaid = entries.some((e) => e.path === HANDOUT_OVERLAY && e.type === "tree");
  const out = new Map<string, HandoutEntry>();
  for (const e of entries) {
    if (overlaid && pathWithin(e.path, HANDOUT_OVERLAY)) continue;
    out.set(e.path, { path: e.path, type: e.type, from: e.path });
  }
  if (overlaid) {
    for (const e of entries) {
      if (!e.path.startsWith(`${HANDOUT_OVERLAY}/`)) continue;
      const path = e.path.slice(HANDOUT_OVERLAY.length + 1);
      out.set(path, { path, type: e.type, from: e.path });
    }
  }
  return [...out.values()]
    .filter((e) => e.path !== HANDOUT_IGNORE && !ignored.some((root) => pathWithin(e.path, root)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
