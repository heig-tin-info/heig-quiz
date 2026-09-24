/**
 * What an evaluation's configuration must hold before it may leave `draft`
 * (F-EVAL-04, decision D8).
 *
 * The API refuses a transition to `scheduled`, `lobby` or `running` with an
 * incomplete timing, and the configuration screen refuses to move on to the
 * launch step for the same reason. Both read the rule here, so the screen can
 * never let a teacher reach a button the server will then refuse (#76).
 */
import type { EvaluationTiming } from "./deadline.js";

/** The evaluation modes of F-EVAL-01, spelled as on the wire. */
export type EvaluationModeName = "exam" | "exercise" | "poll";

/**
 * A field the timing still needs. `timing` itself is the answer for an exam
 * set to `manual`: nothing can be filled in to fix it, another timing must be
 * chosen.
 */
export type TimingField = "durationS" | "opensAt" | "closesAt" | "timing";

export interface TimingInput {
  mode: EvaluationModeName;
  timing: EvaluationTiming;
  durationS: number | null;
  /** Only its presence matters here; an ISO string or a `Date`. */
  opensAt: unknown;
  closesAt: unknown;
}

/**
 * The fields to fill before the evaluation may open, in the order they sit on
 * the screen; empty when the timing is complete.
 *
 * - `duration`: a positive number of minutes per student.
 * - `deadline`: the common end AND the opening time. The opening time is the
 *   base of the accommodation in this timing: a student's extra time is
 *   `(closesAt − opensAt) × bonus` (decision D8), which has no value without it.
 * - `manual`: nothing to fill, but an `exam` must announce when it ends
 *   (F-EVAL-04), so an exam cannot use it.
 */
export function missingTimingFields(input: TimingInput): TimingField[] {
  switch (input.timing) {
    case "duration":
      return input.durationS !== null && input.durationS > 0 ? [] : ["durationS"];
    case "deadline": {
      const missing: TimingField[] = [];
      if (input.opensAt == null) missing.push("opensAt");
      if (input.closesAt == null) missing.push("closesAt");
      return missing;
    }
    case "manual":
      return input.mode === "exam" ? ["timing"] : [];
  }
}
