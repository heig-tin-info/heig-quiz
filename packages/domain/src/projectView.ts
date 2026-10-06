/**
 * The rules of the staff's project page (F-PROJ-13, F-PROJ-14, merge task
 * M3-08a): the grade a score reads as, whether a final score moved since
 * the release, and the page's one primary action. The `project` module
 * reads the rows; these decide.
 */
import { projectGrade, type ProjectGrade, type ProjectScale } from "./projectGrade.js";

/** A score's grade by the project's scale, or null when it has no maximum to read it against. */
export function scoreGrade(points: number | null, max: number | null, scale: ProjectScale): ProjectGrade | null {
  return points !== null && max !== null && max > 0 ? projectGrade(points, max, scale) : null;
}

/**
 * Whether a final score differs from what the release wrote (D05 addendum,
 * F-PROJ-14): only once the project was released; a score that appeared,
 * vanished, or changed its points or its maximum since then.
 */
export function changedAfterRelease(
  released: boolean,
  final: { points: number; max: number | null } | null,
  snapshot: { points: number | null; max: number | null },
): boolean {
  if (!released) return false;
  return (final?.points ?? null) !== snapshot.points || (final?.max ?? null) !== snapshot.max;
}

/** The one primary action of the staff's project page (F-PROJ-13). */
export const PROJECT_PRIMARY_ACTIONS = ["publish", "sync", "release", "none"] as const;
export type ProjectPrimaryAction = (typeof PROJECT_PRIMARY_ACTIONS)[number];

export interface PrimaryActionInput {
  state: "draft" | "published" | "locked";
  archived: boolean;
  gradingMode: "auto" | "none";
  /** The source holds commits the distribution repository lacks (F-PROJ-12, M3-07). */
  sourceAhead: boolean;
  /** The repositories that take a deadline (provisioned, not deleted). */
  live: number;
  /** Of those, the ones definitively frozen. */
  frozen: number;
  /** Repositories whose final score rests on a run to verify (F-PROJ-08): the teacher's score settles each. */
  unverified: number;
  released: boolean;
  /** Repositories whose final score moved since the release. */
  changedAfterRelease: number;
}

/**
 * Whether the scores are final, so the release may be asked for (product
 * owner, 2026-10-02): a graded project whose every live repository is
 * frozen, and at least one, and no final score left to verify (M3-08b: a
 * score captured under a suspended protection, or on a restored head, is
 * released only once the teacher's score settles it). A deleted
 * repository, one never provisioned, or any repository of an archived
 * project does not hold it back.
 */
export function scoresFinal(p: Pick<PrimaryActionInput, "gradingMode" | "live" | "frozen" | "unverified">): boolean {
  return p.gradingMode === "auto" && p.live > 0 && p.frozen === p.live && p.unverified === 0;
}

/**
 * Publish for a draft; Release once the scores are final and not yet
 * released, or changed since; Sync when the source is ahead; nothing for an
 * archived project. The release comes before the sync: once every
 * repository is frozen, a sync reaches nobody's score.
 */
export function projectPrimaryAction(p: PrimaryActionInput): ProjectPrimaryAction {
  if (p.archived) return "none";
  if (p.state === "draft") return "publish";
  if (scoresFinal(p) && (!p.released || p.changedAfterRelease > 0)) return "release";
  if (p.sourceAhead) return "sync";
  return "none";
}

// ---------------------------------------------------------------- the final review's state (M3-08b)

/**
 * Where a repository's final review stands (F-PROJ-11 as amended, M3-05b;
 * shown by the staff's views, M3-08b):
 *   - `pending` — not frozen for good yet, or frozen and the dispatch not
 *     yet claimed (the job will ask for it);
 *   - `none` — no review will come: the project is not graded, or the
 *     repository froze with no frozen run (`reason: no_frozen_run`);
 *   - `skipped` — frozen but degraded: archived as its lock, or its
 *     protection suspended (`reason`); a re-enabled protection makes it
 *     `pending` again;
 *   - `unconfirmed` — claimed in the ledger, GitHub's acceptance never
 *     recorded (a crash, no answer, a 5xx): never sent again;
 *   - `asked` — GitHub accepted the dispatch at `askedAt`, of `sha`;
 *   - `done` — the review slot is filled (`runId`).
 */
export const PROJECT_REVIEW_STATUSES = ["pending", "none", "skipped", "unconfirmed", "asked", "done"] as const;
export type ProjectReviewStatus = (typeof PROJECT_REVIEW_STATUSES)[number];
export const PROJECT_REVIEW_REASONS = ["no_frozen_run", "archived", "protection_suspended"] as const;
export type ProjectReviewReason = (typeof PROJECT_REVIEW_REASONS)[number];

export interface ProjectReviewState {
  status: ProjectReviewStatus;
  reason: ProjectReviewReason | null;
  askedAt: Date | null;
  sha: string | null;
  runId: string | null;
}

export interface ReviewStateInput {
  gradingMode: "auto" | "none";
  frozenAt: Date | null;
  frozenGradeRunId: string | null;
  reviewGradeRunId: string | null;
  archivedAt: Date | null;
  protectionSuspendedAt: Date | null;
  /** The repository's `deadline` row of the dispatch ledger, when one was claimed. */
  dispatch: { sha: string; dispatchedAt: Date | null } | null;
}

/** {@link ProjectReviewState} of a repository, from its row and its ledger row. */
export function reviewState(repo: ReviewStateInput): ProjectReviewState {
  const base = { reason: null, askedAt: repo.dispatch?.dispatchedAt ?? null, sha: repo.dispatch?.sha ?? null, runId: null };
  if (repo.reviewGradeRunId !== null) return { ...base, status: "done", runId: repo.reviewGradeRunId };
  if (repo.dispatch) return { ...base, status: repo.dispatch.dispatchedAt === null ? "unconfirmed" : "asked" };
  if (repo.gradingMode !== "auto") return { ...base, status: "none" };
  if (repo.frozenAt === null) return { ...base, status: "pending" };
  if (repo.frozenGradeRunId === null) return { ...base, status: "none", reason: "no_frozen_run" };
  if (repo.archivedAt !== null) return { ...base, status: "skipped", reason: "archived" };
  if (repo.protectionSuspendedAt !== null) return { ...base, status: "skipped", reason: "protection_suspended" };
  return { ...base, status: "pending" };
}

/**
 * The dates the staff's project lists show (M3-14a). A draft in manual
 * publish mode has no start yet: its stored one is its creation, provisional
 * until it is published (`draftDates` of the project module), and a deadline
 * given as a duration does not exist either (creation plus the duration
 * never happens). A scheduled draft keeps what its author set, a manual
 * draft with an absolute deadline keeps the deadline, and a published or
 * locked project is what it is stored as.
 */
export function projectListDates<D>(p: {
  state: "draft" | "published" | "locked";
  publishMode: "manual" | "scheduled";
  durationMinutes: number | null;
  startAt: D;
  deadlineAt: D;
}): { startAt: D | null; deadlineAt: D | null } {
  if (p.state !== "draft" || p.publishMode !== "manual") return { startAt: p.startAt, deadlineAt: p.deadlineAt };
  return { startAt: null, deadlineAt: p.durationMinutes === null ? p.deadlineAt : null };
}
