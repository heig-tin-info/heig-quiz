/**
 * The LLM reviews a project requests from its student repositories (ported
 * from classroom's `dispatch.ts`, `grading.ts` and `milestones.ts`).
 *
 * Once a repository's score is frozen for good (its effective deadline +
 * grace, ADR-012, ADR-064), the server fires ONE `repository_dispatch` to it
 * carrying the frozen commit and that EFFECTIVE deadline (the caller passes
 * it as `deadlineAt`, M3-05b); the repository's `grading.yml` runs its LLM
 * review, whose run comes back through the ordinary ingestion as a `review`
 * run. A review checkpoint (classroom's "milestone",
 * `docs/merge/07-incompatibilities.md` §7.4) does the same before the
 * deadline, on the last commit no bot pushed received before it. The API's
 * `modules/project/review.ts` sends them.
 *
 * These are the pure decisions. The event types and the `client_payload`
 * keys (`assignment_id`, `milestone`, …) are read by the workflows already
 * living in the student repositories: they are wire names, kept as they are.
 */

import { addZonedDays } from "./zone.js";

// `GRADING_WORKFLOW_PATH` and `runKind` live in `projectRuns.ts` (M3-04).

export interface FinalReviewDispatch {
  /** Frozen commit to review (`client_payload.sha`). */
  sha: string;
  eventType: "grade-final";
  clientPayload: {
    sha: string;
    assignment_id: string;
    deadline: string;
    trigger: "deadline";
  };
}

/**
 * What to dispatch for one repository after the freeze. Null when there is
 * nothing to review: no frozen run, the student never produced an eligible
 * one.
 */
export function planFinalReviewDispatch(
  project: { id: string; deadlineAt: Date },
  frozenSha: string | null,
): FinalReviewDispatch | null {
  if (!frozenSha) return null;
  return {
    sha: frozenSha,
    eventType: "grade-final",
    clientPayload: {
      sha: frozenSha,
      assignment_id: project.id,
      deadline: project.deadlineAt.toISOString(),
      trigger: "deadline",
    },
  };
}

export interface CheckpointReviewDispatch {
  /** Last commit received before the checkpoint (`client_payload.sha`). */
  sha: string;
  eventType: "grade-milestone";
  clientPayload: {
    sha: string;
    assignment_id: string;
    milestone_id: string;
    /** Tag matched by the `milestone:` entries of `criteria.yml`. */
    milestone: string;
    due: string;
    trigger: "milestone";
  };
}

/**
 * What to dispatch for one repository at a review checkpoint. Null when the
 * student never pushed before it — nothing to review, like the missing
 * frozen run of the deadline.
 */
export function planCheckpointReviewDispatch(
  projectId: string,
  checkpoint: { id: string; name: string; dueAt: Date },
  sha: string | null,
): CheckpointReviewDispatch | null {
  if (!sha) return null;
  return {
    sha,
    eventType: "grade-milestone",
    clientPayload: {
      sha,
      assignment_id: projectId,
      milestone_id: checkpoint.id,
      milestone: checkpoint.name,
      due: checkpoint.dueAt.toISOString(),
      trigger: "milestone",
    },
  };
}

/**
 * The instant of a checkpoint authored as J±n: `offsetDays` CALENDAR days
 * around the deadline (negative before it) in the school's time zone, at
 * the deadline's local time (product owner, 2026-10-02; merge task M3-05a)
 * — never 24-hour days, which put J−3 of a deadline at 23:59 at 00:59 or
 * 22:59 across a change of the clocks. Re-resolved, by this one rule, when
 * the deadline moves.
 */
export function checkpointDueAt(deadlineAt: Date, offsetDays: number): Date {
  return addZonedDays(deadlineAt, offsetDays);
}
