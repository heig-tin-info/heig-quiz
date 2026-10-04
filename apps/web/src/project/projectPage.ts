/*
 * The project page's rules (F-PROJ-13, M3-12), pure: what the header says of
 * the project's situation, a repository's flags and the state of its final
 * review, whether a moved deadline reopens the project and how many
 * repositories it reaches, a checkpoint's status, the refetch cadence, the
 * teacher's score rules the sheet draws, and the words of each refusal the
 * page meets. `ProjectPage.tsx` and its sections draw them.
 */
import {
  ProjectReleaseRefusal,
  ProjectUnassigned,
  type ProjectAcceptErrorCode,
  type ProjectCheckpointErrorCode,
  type ProjectDetail,
  type ProjectErrorCode,
  type ProjectRepoReview,
  type ProjectRepoView,
  type ProjectSummary,
  type ReviewCheckpoint,
} from "@quiz/contracts";
import { isVoidCheckpoint, reopens } from "@quiz/domain";

import { ApiError, refusalCodeOf, wordedRefusal } from "../api";
import type { Dict, TFunction } from "../i18n";
import type { RouteOf } from "../router";
import type { Tone } from "../ui";

export type UnassignedStudent = ProjectUnassigned["students"][number];

/** The students Publish refused over (`409 unassigned_students`, F-PROJ-06), or null when `error` is something else. */
export function unassignedStudents(error: unknown): UnassignedStudent[] | null {
  if (!(error instanceof ApiError)) return null;
  const parsed = ProjectUnassigned.safeParse(error.body);
  return parsed.success ? parsed.data.students : null;
}

/** The page refetches every 30 s while its tab is visible (TanStack stops a hidden tab's interval). */
export const REFETCH_MS = 30_000;
/** …and once a few seconds after a response whose live state was not all read in time. */
export const LIVE_STALE_REFETCH_MS = 3_000;

export const projectRefetchInterval = (detail: ProjectDetail | undefined): number =>
  detail?.liveStale ? LIVE_STALE_REFETCH_MS : REFETCH_MS;

/**
 * The sentence under the title: the project's situation, and the one action
 * the server names when there is one. It describes the primary button when
 * there is one (Publish, Release, a release again once a score moved after
 * the release); Sync is said, not drawn, until its route exists (M3-07).
 * `date` is the instant the sentence names: the start of a scheduled draft,
 * the release, else the deadline.
 */
export type StatusKey =
  | "project.status.archived"
  | "project.status.draft"
  | "project.status.scheduled"
  | "project.status.release"
  | "project.status.rerelease"
  | "project.status.sync"
  | "project.status.open"
  | "project.status.released"
  | "project.status.lockedFreezing"
  | "project.status.locked";

export function projectStatus(p: ProjectDetail): { key: StatusKey; date: string } {
  const key = ((): StatusKey => {
    if (p.archivedAt) return "project.status.archived";
    if (p.state === "draft") return p.publishMode === "scheduled" ? "project.status.scheduled" : "project.status.draft";
    if (p.primaryAction === "release") return p.releasedAt ? "project.status.rerelease" : "project.status.release";
    if (p.primaryAction === "sync") return "project.status.sync";
    if (p.state === "published") return "project.status.open";
    if (p.releasedAt) return "project.status.released";
    return p.counts.frozen < p.counts.live ? "project.status.lockedFreezing" : "project.status.locked";
  })();
  const date =
    key === "project.status.scheduled"
      ? p.startAt
      : key === "project.status.released" || key === "project.status.rerelease"
        ? p.releasedAt!
        : p.deadlineAt;
  return { key, date };
}

/** Whether any grade of the page was converted by the linear scale instead of "score is the grade" (one warning). */
export function hasFellBack(p: ProjectDetail): boolean {
  return p.rows.some(({ repo }) => {
    if (!repo) return false;
    const { current, frozen, review, final } = repo.scores;
    return [current, frozen, review, final].some((s) => s?.grade?.fellBack);
  });
}

/**
 * The line under the deadline field: a manual draft counted as a duration
 * says so; a locked project warns that a later date reopens it; otherwise
 * the browser's zone, when it is not the school's.
 */
export function deadlineDesc(p: ProjectDetail, zone: string | null, t: TFunction): string | undefined {
  if (p.state === "draft" && p.durationMinutes !== null) {
    return t("project.deadline.byDuration", { days: Math.round(p.durationMinutes / 1440) });
  }
  if (p.state === "locked") return t("project.deadline.reopenDesc");
  return zone ? t("project.zone", { zone }) : undefined;
}

/** A repository's flag, as a tag of the table: its word and its tone (danger red, to look at amber, a fact zinc). */
export interface RepoFlag {
  key: keyof Dict;
  tone: Tone;
}

/**
 * The flags of a repository's row (M3-08a's `flags`, plus the degraded
 * lock of M3-05a), in the order they are drawn: what is wrong first.
 */
export function repoFlags(repo: ProjectRepoView): RepoFlag[] {
  const flags: RepoFlag[] = [];
  if (repo.flags.deleted) flags.push({ key: "project.flag.deleted", tone: "zinc" });
  if (repo.flags.multiple) flags.push({ key: "project.flag.multiple", tone: "red" });
  if (repo.flags.protectionSuspended) flags.push({ key: "project.flag.conflict", tone: "amber" });
  if (repo.flags.toVerify) flags.push({ key: "project.flag.toVerify", tone: "amber" });
  if (repo.flags.changedAfterRelease) flags.push({ key: "project.flag.changed", tone: "amber" });
  if (repo.flags.malformed !== null) flags.push({ key: "project.flag.malformed", tone: "zinc" });
  if (repo.degraded) flags.push({ key: repo.archived ? "project.flag.degraded" : "project.flag.noRuleset", tone: "zinc" });
  return flags;
}

/** A repository the deadline and lock routes act on: provisioned, not deleted, its project not archived. */
export const actionable = (repo: ProjectRepoView, project: Pick<ProjectDetail, "archivedAt">): boolean =>
  repo.provisionStatus === "ok" && !repo.flags.deleted && project.archivedAt === null;

/**
 * The state of a repository's final review (F-PROJ-11, M3-08b's `review`):
 * its word (a tag), its tone, and the line that says why or what next when
 * the word is not enough (`detail`, taking `{date, sha}` for an asked
 * review) — null when the word is enough.
 */
export interface ReviewView {
  key: keyof Dict;
  tone: Tone;
  detail: keyof Dict | null;
}

/**
 * ONE table, read by the row's tag and the sheet's detail: a fact in zinc
 * (pending, asked, no review), done in green, a degraded "no review" in
 * amber (archived as its lock, or the protection suspended: re-enabling it
 * makes the review due again), and "not confirmed" in red — claimed,
 * GitHub's acceptance never recorded, never sent again: the teacher's score
 * settles the repository. A pending review says it waits for the freeze
 * only while the repository is not frozen (`frozenAt` null): frozen and
 * pending, it is due and the job will ask for it.
 */
export function reviewView(review: ProjectRepoReview, frozenAt: string | null): ReviewView {
  switch (review.status) {
    case "pending":
      return {
        key: "project.reviewState.pending",
        tone: "zinc",
        detail: frozenAt === null ? "project.reviewState.pending.detail" : null,
      };
    case "none":
      return {
        key: "project.reviewState.none",
        tone: "zinc",
        detail: review.reason === "no_frozen_run" ? "project.reviewState.noFrozenRun.detail" : null,
      };
    case "skipped":
      return {
        key: "project.reviewState.none",
        tone: "amber",
        detail:
          review.reason === "archived"
            ? "project.reviewState.archived.detail"
            : "project.reviewState.protectionSuspended.detail",
      };
    case "unconfirmed":
      return { key: "project.reviewState.unconfirmed", tone: "red", detail: "project.reviewState.unconfirmed.detail" };
    case "asked":
      return { key: "project.reviewState.asked", tone: "zinc", detail: "project.reviewState.asked.detail" };
    case "done":
      return { key: "project.reviewState.done", tone: "green", detail: null };
  }
}

/**
 * The review tag of a table row, or null when it would say nothing: a
 * repository not frozen yet is trivially pending, and a project graded
 * `none` has no review on any row. The sheet shows the state whatever it is.
 */
export function reviewTag(repo: ProjectRepoView): ReviewView | null {
  if (repo.review.status === "pending" && repo.frozenAt === null) return null;
  if (repo.review.status === "none" && repo.review.reason === null) return null;
  return reviewView(repo.review, repo.frozenAt);
}

/** Why the sheet offers no teacher's score form: the project is not graded, or the repository is not frozen for good. */
export type TeacherScoreBlock = "grading_none" | "not_frozen" | null;

export function teacherScoreBlock(repo: ProjectRepoView, project: Pick<ProjectDetail, "gradingMode">): TeacherScoreBlock {
  if (project.gradingMode !== "auto") return "grading_none";
  if (repo.frozenAt === null) return "not_frozen";
  return null;
}

/**
 * What a refused release says (F-PROJ-14), from the body the contracts
 * describe (`ProjectReleaseRefusal`): `not_frozen` with how many live
 * repositories are frozen, `to_verify` with the students whose score waits
 * for the teacher's (named from the page's rows; "some repositories" when
 * none is listed), else the refusal as the page words every other one.
 */
export function releaseRefusal(error: unknown, project: ProjectDetail, t: TFunction): string {
  const body = error instanceof ApiError ? ProjectReleaseRefusal.safeParse(error.body) : null;
  if (body?.success) {
    if (body.data.error === "not_frozen") {
      return t("project.release.refusal.notFrozen", { frozen: body.data.frozen, live: body.data.live });
    }
    const { repos } = body.data;
    const names = project.rows
      .filter((r) => r.repo !== null && repos.includes(r.repo.id))
      .map((r) => `${r.student.nom} ${r.student.prenom}`);
    return t("project.release.refusal.toVerify", { names: names.join(", ") || t("project.release.refusal.someRepos") });
  }
  return refusalMessage(error, t);
}

/**
 * The repositories a project deadline moved to `deadlineAt` reopens
 * (F-PROJ-09): applied already, following the project's deadline (one with
 * an own deadline keeps it), live. Zero when the move is no reopen.
 */
export function reopenedRepos(p: ProjectDetail, deadlineAt: string, now: number): number {
  const deadline = new Date(deadlineAt);
  const at = new Date(now);
  return p.rows.filter(
    ({ repo }) =>
      repo !== null &&
      actionable(repo, p) &&
      repo.deadlineAt === null &&
      reopens(repo.deadlineAppliedAt ? new Date(repo.deadlineAppliedAt) : null, deadline, at),
  ).length;
}

/** Whether moving the project's deadline to `deadlineAt` reopens it, or one of its repositories. */
export function isReopen(p: ProjectDetail, deadlineAt: string, now: number): boolean {
  const applied = p.deadlineAppliedAt ? new Date(p.deadlineAppliedAt) : null;
  return reopens(applied, new Date(deadlineAt), new Date(now)) || reopenedRepos(p, deadlineAt, now) > 0;
}

export type CheckpointStatus = "dispatched" | "void" | "scheduled";

/** Sent to every repository it was due to; void, never firing (the deadline moved before it); or still to come. */
export function checkpointStatus(c: ReviewCheckpoint, deadlineAt: string): CheckpointStatus {
  if (c.dispatchedAt) return "dispatched";
  return isVoidCheckpoint(new Date(c.dueAt), new Date(deadlineAt)) ? "void" : "scheduled";
}

export const shortSha = (sha: string): string => sha.slice(0, 7);

/** A repository on GitHub, by its full name. */
export const repoHref = (fullName: string): string => `https://github.com/${fullName}`;

/** The name of a repository without its organization: what the table has room for. */
export const repoShortName = (fullName: string): string => fullName.slice(fullName.indexOf("/") + 1);

/**
 * The words of the refusals the page meets — the lifecycle's, the
 * checkpoints', the staff's writes, and the resend's `github_account_stale`
 * (a code of Accept's list the resend shares); the rest read the server's message.
 */
type KnownCode = ProjectErrorCode | ProjectCheckpointErrorCode | Extract<ProjectAcceptErrorCode, "github_account_stale">;
const REFUSAL_KEY: Partial<Record<KnownCode, keyof Dict>> = {
  not_draft: "project.refusal.notDraft",
  distribution_missing: "project.refusal.distributionMissing",
  deadline_past: "project.refusal.deadlinePast",
  strategy_frozen: "project.refusal.strategyFrozen",
  publish_mode_frozen: "project.refusal.publishModeFrozen",
  repo_unavailable: "project.refusal.repoUnavailable",
  // ADR-070 (M3-15a): a group project's set.
  no_group_set: "project.noGroupSet.title",
  unknown_group_set: "project.refusal.unknownGroupSet",
  due_past: "project.refusal.duePast",
  due_after_deadline: "project.refusal.dueAfterDeadline",
  duplicate_checkpoint: "project.refusal.duplicateCheckpoint",
  checkpoint_dispatched: "project.refusal.checkpointDispatched",
  // The staff's writes (M3-08b): the teacher's score, the release, the resend, the re-enable.
  not_frozen: "project.refusal.notFrozen",
  grading_none: "project.refusal.gradingNone",
  score_max_required: "project.refusal.scoreMaxRequired",
  score_max_mismatch: "project.refusal.scoreMaxMismatch",
  score_above_max: "project.refusal.scoreAboveMax",
  invitation_not_pending: "project.refusal.invitationNotPending",
  resend_too_soon: "project.refusal.resendTooSoon",
  invite_failed: "project.refusal.inviteFailed",
  github_account_stale: "project.refusal.githubAccountStale",
};

/** The dictionary key wording a refusal the page knows, or null (the server's message then). */
export function refusalKey(error: unknown): keyof Dict | null {
  const code = refusalCodeOf(error);
  return code ? (REFUSAL_KEY[code as KnownCode] ?? null) : null;
}

/** What a failed write says: the refusal worded when the page knows it, else the server's message, else `error.save`. */
export const refusalMessage = (error: unknown, t: TFunction): string => wordedRefusal(error, REFUSAL_KEY, t);

/**
 * The page of the group set a group project follows, coming back to the
 * project (`fromProject`, W9); null while it names none.
 */
export const groupSetPageOf = (p: Pick<ProjectSummary, "id" | "classroomId" | "groupSetId">): RouteOf<"groupSet"> | null =>
  p.groupSetId === null ? null : { view: "groupSet", classroomId: p.classroomId, id: p.groupSetId, fromProject: p.id };
