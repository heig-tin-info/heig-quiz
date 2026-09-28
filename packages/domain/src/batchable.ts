/**
 * Which proposals the grading panel's "Validate N proposals" may settle in
 * one click (F-GRADE-04).
 *
 * A proposal is either a grader's OPINION — points it computed, or a
 * confidence it stated (an LLM, a runner's verdict) — or a PLACEHOLDER: 0
 * points with no confidence, written when nothing could judge the answer (an
 * essay graded by hand, a manual circuit, a runner that was not there).
 * Validating a placeholder in bulk turns "a person must look" into "worth
 * nothing" for a whole column at once, so only opinions are batchable; a
 * placeholder is validated one at a time, after it has been read.
 *
 * The API's batch (as SQL) and the panel's count (in the browser) both read
 * this rule, so the number on the button is the number the call validates.
 */
export interface BatchCandidate {
  state: string;
  points: number;
  confidence: string | null;
}

export function isBatchable(grading: BatchCandidate): boolean {
  return grading.state === "proposed" && (grading.points !== 0 || grading.confidence !== null);
}
