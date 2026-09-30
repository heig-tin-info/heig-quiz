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
