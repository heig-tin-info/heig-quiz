/**
 * A graded run's `results.json` read against the criteria (criteria-3
 * contract, ADR-119): what each `command` criterion's check proposes. The
 * file itself is validated by `ResultsFile` of `@quiz/contracts` (published
 * as `results-1.json`); this module only maps it, so it takes the validated
 * shape structurally.
 */
import { checkFraction, checkPoints, parseCheckScore, type CriteriaLeaf } from "./criteria.js";

/** The URL under which the platform publishes the results schema (its `$id`). */
export const RESULTS_SCHEMA_ID = "https://quiz.chevallier.io/schemas/results-1.json";
/** The URL under which the platform publishes the criteria schema (its `$id`). */
export const CRITERIA_SCHEMA_ID = "https://quiz.chevallier.io/schemas/criteria-3.json";
/** The most UTF-8 bytes of a criterion's `log` the platform keeps (its tail, {@link tailUtf8}). */
export const RESULT_LOG_MAX_BYTES = 8 * 1024;
/**
 * The most bytes of a `results.json` the platform reads (ADR-119 §4): a
 * file over it is refused whole, as a missing result (`no_result`). The
 * artifact's one entry is inflated under this same budget.
 */
export const RESULTS_FILE_MAX_BYTES = 256 * 1024;
/** What starts a log that was cut (StudentScore's `_TRUNCATED`). */
export const TRUNCATED_MARK = "[... truncated]\n";

/**
 * The end of `text` within `maxBytes` UTF-8 bytes (StudentScore's
 * `tail_cap`): unchanged when it fits; otherwise {@link TRUNCATED_MARK}
 * and as much of the tail as fits, never half a character.
 */
export function tailUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  const keep = Math.max(0, maxBytes - new TextEncoder().encode(TRUNCATED_MARK).length);
  let start = bytes.length - keep;
  // A UTF-8 continuation byte (10xxxxxx) is the middle of a character: start after it.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return TRUNCATED_MARK + new TextDecoder().decode(bytes.subarray(start));
}

/** A validated `results.json`: each criterion's `n/m` and its log, under its dotted id; anything else ignored. */
export interface CheckResults {
  criteria: Record<string, { score: string; log?: string | undefined }>;
}

/**
 * What a command criterion's check proposes, or why nothing.
 *
 * - `points`: the criterion's points for the check's fraction ({@link checkPoints}).
 * - `max`: the criterion's own bound, as its points are read: its maximum
 *   for a positive criterion, the bonus for a bonus criterion, the
 *   (negative) maximum for a penalty — so `points` lies between 0 and `max`.
 * - `log`: the check's log, its tail within {@link RESULT_LOG_MAX_BYTES}; null when none.
 * - `reason: "no_result"`: the file has no valid entry for it; a 0-point
 *   proposal the teacher sees with its reason.
 */
export type CheckOutcome = { id: string; points: number; max: number; log: string | null } | { id: string; reason: "no_result" };

/**
 * One outcome per `command` criterion, in the criteria's order. An id the
 * criteria do not hold, or a criterion without a command, is ignored.
 */
export function checkOutcomes(leaves: readonly CriteriaLeaf[], results: CheckResults): CheckOutcome[] {
  return leaves
    .filter((leaf) => leaf.command !== undefined)
    .map((leaf) => {
      const entry = Object.hasOwn(results.criteria, leaf.id) ? results.criteria[leaf.id] : undefined;
      const score = entry === undefined ? null : parseCheckScore(entry.score);
      if (entry === undefined || score === null) return { id: leaf.id, reason: "no_result" as const };
      return {
        id: leaf.id,
        points: checkPoints(leaf, checkFraction(score)),
        max: leaf.bonusPoints ?? leaf.maxPoints,
        log: entry.log === undefined ? null : tailUtf8(entry.log, RESULT_LOG_MAX_BYTES),
      };
    });
}
