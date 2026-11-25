/**
 * A course image's base (ADR-146 §7), a pure rule (invariant 8): an image
 * whose first layers are an older `quiz-base` release than the current one
 * still runs, and is marked obsolete for its course's staff.
 *
 * A `quiz-base` version is its `VERSION` file's (`1.0.0`): dot-separated
 * decimal numbers, compared number by number, a missing one counting as 0
 * (`1.2` is `1.2.0`). Anything else is not a version this rule can order.
 */

const VERSION = /^\d{1,9}(\.\d{1,9}){0,3}$/;

/**
 * Orders two `quiz-base` versions: negative when `a` is older than `b`, 0
 * when equal, positive when newer; null when either is not a version.
 */
export function compareBaseVersions(a: string, b: string): number | null {
  if (!VERSION.test(a) || !VERSION.test(b)) return null;
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Whether an image built on `imageBase` is obsolete against the current
 * release `currentBase`: true when older, false when the same or newer, null
 * when either is unknown (no image in service yet, no release yet, a portal
 * that could not be asked) or not a version.
 */
export function imageObsolete(imageBase: string | null, currentBase: string | null): boolean | null {
  if (imageBase === null || currentBase === null) return null;
  const order = compareBaseVersions(imageBase, currentBase);
  return order === null ? null : order < 0;
}
