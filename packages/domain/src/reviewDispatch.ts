/**
 * The LLM reviews a project requests from its student repositories (ported
 * from classroom's `dispatch.ts`, `grading.ts` and `milestones.ts`, GR-16).
 *
 * Once a project's score is frozen (deadline + grace, ADR-012), the server
 * fires ONE `repository_dispatch` per student repository carrying the frozen
 * commit; the repository's `grading.yml` runs its LLM review, whose run comes
 * back through the ordinary ingestion as an `llm` run. A review checkpoint
 * (classroom's "milestone", `docs/merge/07-incompatibilities.md` §7.4) does
 * the same before the deadline, on the last commit received before it.
 *
 * These are the pure decisions. The event types and the `client_payload`
 * keys (`assignment_id`, `milestone`, …) are read by the workflows already
 * living in the student repositories: they are wire names, kept as they are.
 */

/** The one workflow whose runs carry a score. */
export const GRADING_WORKFLOW_PATH = ".github/workflows/grading.yml";

const DAY_MS = 86_400_000;

/**
 * GR-16: the grading workflow fired by the platform's `repository_dispatch`
 * is the authoritative LLM review; every other run is the indicative CI tier
 * — a student workflow listening to `repository_dispatch` cannot impersonate
 * the review.
 */
export function runKind(run: { event: string; path: string }): "ci" | "llm" {
  return run.event === "repository_dispatch" && run.path === GRADING_WORKFLOW_PATH ? "llm" : "ci";
}

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
 * The instant of a checkpoint authored as J±n: `offsetDays` whole days of
 * 24 h around the deadline (negative before it). Re-resolved when the
 * deadline moves.
 */
export function checkpointDueAt(deadlineAt: Date, offsetDays: number): Date {
  return new Date(deadlineAt.getTime() + offsetDays * DAY_MS);
}
