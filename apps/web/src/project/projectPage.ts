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
  type ProjectDetailGroup,
  type ProjectErrorCode,
  type ProjectRepoReview,
  type ProjectRepoView,
  type ProjectStudent,
  type ProjectSummary,
  type ReviewCheckpoint,
} from "@quiz/contracts";
import { isVoidCheckpoint, reopens } from "@quiz/domain";

import { ApiError, refusalCodeOf, wordedRefusal } from "../api";
import { studentName } from "../group/groupRules";
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
/** …and every few seconds after a response whose live state was not all read in time, or while a sync runs (M3-07). */
export const LIVE_STALE_REFETCH_MS = 3_000;

export const projectRefetchInterval = (detail: ProjectDetail | undefined): number =>
  detail?.liveStale || detail?.sync.inProgress ? LIVE_STALE_REFETCH_MS : REFETCH_MS;

/**
 * Whether the header offers Sync beside another primary action (F-PROJ-12,
 * M3-07): the server says the source is ahead (never on a project that
 * cannot sync: archived, its distribution not built), or a sync runs — a
 * draft syncs its distribution, a project awaiting its release its open
 * repositories. As the primary action, Sync is the server's word
 * (`primaryAction`).
 */
export const offersSync = (p: ProjectDetail): boolean => p.primaryAction !== "sync" && (p.sync.ahead !== null || p.sync.inProgress);

/**
 * The sentence under the title: the project's situation, and the one action
 * the server names when there is one. It describes the primary button when
 * there is one (Publish, Release, a release again once a score moved after
 * the release, Sync when the source is ahead, M3-07).
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
 * lock of M3-05a and *access to revoke* of a group repository, M3-16b), in
 * the order they are drawn: what is wrong first.
 */
export function repoFlags(repo: ProjectRepoView): RepoFlag[] {
  const flags: RepoFlag[] = [];
  if (repo.flags.deleted) flags.push({ key: "project.flag.deleted", tone: "zinc" });
  if (repo.flags.multiple) flags.push({ key: "project.flag.multiple", tone: "red" });
  if (repo.flags.protectionSuspended) flags.push({ key: "project.flag.conflict", tone: "amber" });
  if (repo.flags.toVerify) flags.push({ key: "project.flag.toVerify", tone: "amber" });
  if (repo.flags.changedAfterRelease) flags.push({ key: "project.flag.changed", tone: "amber" });
  // ADR-070 §4 (M3-16b): an access GitHub has not revoked yet — the job retries it; never red.
  if (repo.accessToRevoke) flags.push({ key: "project.flag.accessToRevoke", tone: "amber" });
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

/**
 * The sync of a repository, as a tag of its row and a fact of its sheet
 * (F-PROJ-12, M3-07): a failed sync first (red), else the pull request of
 * its default branch — open (amber, linked), merged (green), closed (zinc)
 * —, else an outcome worth a word (up to date, skipped); null when the
 * sync never reached it.
 */
export interface SyncView {
  key: keyof Dict;
  tone: Tone;
  /** The pull request's number, for the word. */
  n?: number;
  /** The pull request on GitHub. */
  href: string | null;
}

export function syncTag(repo: ProjectRepoView): SyncView | null {
  const { pr, outcome } = repo.sync;
  if (outcome === "failed") return { key: "project.syncTag.failed", tone: "red", href: null };
  if (pr) {
    return {
      key: `project.syncTag.${pr.state}`,
      tone: pr.state === "open" ? "amber" : pr.state === "merged" ? "green" : "zinc",
      n: pr.number,
      href: repo.fullName ? `${repoHref(repo.fullName)}/pull/${pr.number}` : null,
    };
  }
  if (outcome === "up_to_date") return { key: "project.syncTag.upToDate", tone: "zinc", href: null };
  if (outcome === "skipped") return { key: "project.syncTag.skipped", tone: "zinc", href: null };
  return null;
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
    const names = repoEntries(project)
      .filter((e) => e.repo !== null && repos.includes(e.repo.id))
      .map((e) => e.label);
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
  // The sync (M3-07).
  project_archived: "project.refusal.projectArchived",
  sync_in_progress: "project.refusal.syncInProgress",
  source_rewritten: "project.refusal.sourceRewritten",
  sync_failed: "project.refusal.syncFailed",
  // ADR-070's R2 (M3-15b-2b): a release while a confirmed resync of the groups is applied.
  group_sync_pending: "project.refusal.groupSyncPending",
  // *Resync with the set* (M3-15b-2b, M3-16b): `needs_confirmation` opens its dialog, worded here if it cannot.
  needs_confirmation: "groups.refusal.needsConfirmation",
  released: "project.refusal.released",
  classroom_archived: "project.refusal.classroomArchived",
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

// ---------------------------------------------------------------- one row per group (ADR-070 §4, M3-16b)

/**
 * One row of the repositories' table: a group of a group project — its
 * repository, read by every member, and its current members — or a student
 * (an individual project's, a student in no group of the copy, a
 * repository whose student left the roster). `label` names the row: the
 * group's name, or the student's.
 */
export type RepoEntry =
  | { kind: "group"; key: string; label: string; group: ProjectDetailGroup; members: ProjectStudent[]; repo: ProjectRepoView | null }
  | { kind: "student"; key: string; label: string; student: ProjectStudent; repo: ProjectRepoView | null; staff: boolean };

/**
 * The page's rows as the table draws them. Rows stay per student on the
 * wire (`ProjectDetailRow.group`); a group project's are gathered here into
 * one per group, its repository read once (B10: its scores too), its
 * members the roster students in it — a repository no roster student reads
 * any more (R1's group kept, or its members gone) is its group's row with no
 * member. The groups come by name, then the students in no group in the
 * server's order. An individual project keeps one row per student.
 */
export function repoEntries(p: Pick<ProjectDetail, "groupMode" | "rows">): RepoEntry[] {
  const students: RepoEntry[] = [];
  const groups = new Map<string, Extract<RepoEntry, { kind: "group" }>>();
  for (const { student, repo, group, staff } of p.rows) {
    if (!p.groupMode || group === null) {
      students.push({ kind: "student", key: repo?.id ?? student.enrollmentId ?? student.email, label: studentName(student), student, repo, staff });
      continue;
    }
    let entry = groups.get(group.id);
    if (!entry) {
      entry = { kind: "group", key: group.id, label: group.name, group, members: [], repo: null };
      groups.set(group.id, entry);
    }
    if (student.enrollmentId !== null) entry.members.push(student);
    entry.repo ??= repo;
  }
  const byName = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return [...byName, ...students];
}

/** The row of the repository `repoId`, for its sheet. */
export const repoEntryOf = (p: Pick<ProjectDetail, "groupMode" | "rows">, repoId: string): RepoEntry | undefined =>
  repoEntries(p).find((e) => e.repo?.id === repoId);

/**
 * *Resync with the set* is offered (ADR-070 §4, M3-15b-2b): the copy
 * drifted from its set, and the project is neither released nor archived
 * (the resync would be refused). Hidden otherwise, the drift with it.
 */
export const offersResync = (p: Pick<ProjectDetail, "groupsDrifted" | "releasedAt" | "archivedAt">): boolean =>
  p.groupsDrifted && p.releasedAt === null && p.archivedAt === null;
