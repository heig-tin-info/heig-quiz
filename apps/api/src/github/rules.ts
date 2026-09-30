/**
 * TEMPORARY — the pure rule `studentize.ts` applies, waiting for
 * `@quiz/domain`. Merge task M1-01 (PR #370) moves it to
 * `packages/domain/src/github.ts` under the same name and signature; once it
 * is on `main`, import it from `@quiz/domain` in `studentize.ts`, delete this
 * file, and drop the `parseStudentIgnore` cases of `studentize.test.ts` (the
 * domain tests them). Nothing else may import it.
 */

/**
 * Relative paths listed in a `.studentignore`. Anything that could leave the
 * tree or touch the git metadata (`..`, `.git`) is dropped, not honored.
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
