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

/**
 * A checkpoint is void once its date is no longer before the project's
 * deadline (the deadline moved earlier): it never fires, and may be deleted
 * (product owner, 2026-10-02; merge task M3-05b).
 */
export function isVoidCheckpoint(dueAt: Date, deadlineAt: Date): boolean {
  return dueAt.getTime() >= deadlineAt.getTime();
}

/** The longest checkpoint name, the bound of `CheckpointName` in `@quiz/contracts`. */
export const CHECKPOINT_NAME_MAX = 50;

/**
 * The checkpoint name a teacher's free text stands for (a wire tag: the
 * `milestone:` of criteria.yml, the argument of `score grade --milestone`):
 * lower case, œ and æ spelt out, accents folded, every run of characters a tag refuses one
 * dash, cut to `CHECKPOINT_NAME_MAX`, starting with a letter or digit and
 * ending without a dash. `"fin de la séance (2 périodes)"` is
 * `"fin-de-la-seance-2-periodes"`; "" when the text has no letter nor digit.
 * Not `slugify`: a text that already is a tag (`milestone_1`, `a--b`) stays
 * as it is, since criteria.yml may spell it so.
 */
export function checkpointTag(text: string): string {
  return text
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[_-]+/, "")
    .slice(0, CHECKPOINT_NAME_MAX)
    .replace(/-+$/, "");
}

/**
 * Why a checkpoint cannot be created at `dueAt` (its resolved date): at or
 * before now (`due_past`), or void from the start (`due_after_deadline`).
 * Null when it may.
 */
export function checkpointRefusal(dueAt: Date, deadlineAt: Date, now: Date): "due_past" | "due_after_deadline" | null {
  if (dueAt.getTime() <= now.getTime()) return "due_past";
  if (isVoidCheckpoint(dueAt, deadlineAt)) return "due_after_deadline";
  return null;
}

/**
 * What a checkpoint fires now, by its project's grading mode: the CI's
 * `grade-milestone` dispatch (`auto`, F-PROJ-11) or the platform's milestone
 * pass (`criteria`, ADR-106 §5) — once not dispatched, its date come, not
 * void, on a project out of its draft and not archived. Null otherwise, and
 * always for a project graded `none`.
 */
export function checkpointPass(
  checkpoint: { dueAt: Date; dispatchedAt: Date | null },
  project: { deadlineAt: Date; state: string; gradingMode: string; archivedAt: Date | null },
  now: Date,
): "dispatch" | "milestone" | null {
  const fires =
    checkpoint.dispatchedAt === null &&
    checkpoint.dueAt.getTime() <= now.getTime() &&
    !isVoidCheckpoint(checkpoint.dueAt, project.deadlineAt) &&
    project.state !== "draft" &&
    project.archivedAt === null;
  if (!fires) return null;
  return project.gradingMode === "auto" ? "dispatch" : project.gradingMode === "criteria" ? "milestone" : null;
}
