/**
 * Student handout conventions, applied to the source tree before it becomes
 * the squashed repository: at creation (GH-12) and on every update (GH-51).
 * The canonical assignment repository holds the WORKING teacher version, so
 * its CI proves the lab is solvable; what students receive is derived:
 *
 * - `student/` is an overlay copied over the root (typically the empty
 *   scaffold replacing the solution), then removed;
 * - `.studentignore` lists teacher-only paths, one per line (file or
 *   directory, relative to the root, `#` for comments, no globs), removed
 *   together with the file itself.
 *
 * Declarative on purpose: the portal never runs a script from the teacher's
 * repository on its VM. With neither present, the tree is left untouched.
 * The `whole` strategy distributes the history as is and skips all of this.
 */
import { cpSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import { parseStudentIgnore } from "@quiz/domain";

export const OVERLAY_DIR = "student";
export const IGNORE_FILE = ".studentignore";

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** True when `path` really lives under `root`, symlinked parents resolved. */
function insideRoot(root: string, path: string): boolean {
  const parent = dirname(path);
  if (!existsSync(parent)) return false;
  const real = realpathSync(parent);
  return real === root || real.startsWith(root + sep);
}

export interface StudentizeResult {
  /** The `student/` overlay was applied. */
  overlaid: boolean;
  /** Paths actually removed (the overlay and ignore file included). */
  removed: string[];
}

/** Turn the working tree in `dir` into the student handout, in place. */
export function applyStudentHandout(dir: string): StudentizeResult {
  const root = realpathSync(dir);
  const removed: string[] = [];

  // Read the ignore list first: the overlay may not bring its own.
  const ignorePath = join(root, IGNORE_FILE);
  const ignoreStat = lstatOrNull(ignorePath);
  const ignored = ignoreStat?.isFile() ? parseStudentIgnore(readFileSync(ignorePath, "utf8")) : [];

  const overlayPath = join(root, OVERLAY_DIR);
  // lstat: a `student` symlink is not an overlay (it could point anywhere).
  const overlaid = lstatOrNull(overlayPath)?.isDirectory() ?? false;
  if (overlaid) {
    // verbatimSymlinks: keep links as committed instead of rewriting them
    // to absolute paths into this temporary directory.
    cpSync(overlayPath, root, { recursive: true, force: true, verbatimSymlinks: true });
    rmSync(overlayPath, { recursive: true, force: true });
    removed.push(OVERLAY_DIR);
  }

  for (const rel of ignored) {
    const target = join(root, rel);
    if (!lstatOrNull(target) || !insideRoot(root, target)) continue;
    rmSync(target, { recursive: true, force: true });
    removed.push(rel);
  }
  if (lstatOrNull(ignorePath)) {
    rmSync(ignorePath, { force: true });
    removed.push(IGNORE_FILE);
  }
  return { overlaid, removed };
}
