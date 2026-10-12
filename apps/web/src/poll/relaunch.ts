/**
 * Whether "Start the poll" relaunches a question or starts a new one
 * (ADR-014, amendment 2026-10-12).
 *
 * A row of "Recent polls" opens in the "Ask a new question" editor,
 * prefilled. Started as it was loaded, it is the SAME question
 * (`POST /app/api/polls` with its id): its identity, its history and its
 * use count carry on. Edited, it is a new unsaved question
 * (`POST /app/api/polls/inline`), and the original — a pool's included —
 * is never written.
 */

/** The row the editor was prefilled from: what `GET /app/api/polls/questions/:id` answered. */
export interface RelaunchOrigin {
  id: string;
  type: string;
  config: unknown;
}

/**
 * The id to relaunch, or null to start the editor's content as a new
 * question. "Unchanged" is structural: key order and a key holding
 * `undefined` do not count as an edit, so editing a choice and editing it
 * back is unchanged again.
 */
export function relaunchId(origin: RelaunchOrigin | null, type: string, config: unknown): string | null {
  if (origin === null || origin.type !== type) return null;
  return sameValue(origin.config, config) ? origin.id : null;
}

/** Structural equality of two JSON-like values. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameValue(x, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameValue(ra[k], rb[k]));
}
