/*
 * The project page's rules (F-PROJ-13, M3-12), pure: what the header says of
 * the project's situation, a repository's flags, whether a moved deadline
 * reopens the project and how many repositories it reaches, a checkpoint's
 * status, the refetch cadence, and the words of each refusal the page meets.
 * `ProjectPage.tsx` and its sections draw them.
 */
import { z } from "zod";

import type {
  ProjectCheckpointErrorCode,
  ProjectDetail,
  ProjectErrorCode,
  ProjectRepoView,
  ReviewCheckpoint,
} from "@quiz/contracts";
import { isVoidCheckpoint, reopens } from "@quiz/domain";

import { ApiError } from "../api";
import type { Dict } from "../i18n";
import type { Tone } from "../ui";

/**
 * The body of Publish's `409 unassigned_students` (F-PROJ-06): the claimed
 * students in no group, empty when the group project has no group at all.
 * Parsed here until merge task M3-08b adds `ProjectUnassigned` beside
 * `ProjectRefusal` in `contracts/src/project.ts`; this schema then goes.
 */
export const UnassignedBody = z.object({
  error: z.literal("unassigned_students"),
  students: z.array(z.object({ enrollmentId: z.string(), nom: z.string(), prenom: z.string() })),
});
export type UnassignedStudent = z.infer<typeof UnassignedBody>["students"][number];

/** The students Publish refused over, or null when `error` is something else. */
export function unassignedStudents(error: unknown): UnassignedStudent[] | null {
  if (!(error instanceof ApiError)) return null;
  const parsed = UnassignedBody.safeParse(error.body);
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
 * the server names when there is one. Release and Sync are said, not drawn,
 * until their routes exist (M3-08b, M3-07): the header then turns them into
 * the primary button.
 */
export type StatusKey =
  | "project.status.archived"
  | "project.status.draft"
  | "project.status.scheduled"
  | "project.status.release"
  | "project.status.sync"
  | "project.status.open"
  | "project.status.released"
  | "project.status.lockedFreezing"
  | "project.status.locked";

export function statusKey(p: ProjectDetail): StatusKey {
  if (p.archivedAt) return "project.status.archived";
  if (p.state === "draft") return p.publishMode === "scheduled" ? "project.status.scheduled" : "project.status.draft";
  if (p.primaryAction === "release") return "project.status.release";
  if (p.primaryAction === "sync") return "project.status.sync";
  if (p.state === "published") return "project.status.open";
  if (p.releasedAt) return "project.status.released";
  return p.counts.frozen < p.counts.live ? "project.status.lockedFreezing" : "project.status.locked";
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

/** The words of the refusals the page meets, lifecycle's and checkpoints' alike; the rest read the server's message. */
const REFUSAL_KEY: Partial<Record<ProjectErrorCode | ProjectCheckpointErrorCode, keyof Dict>> = {
  not_draft: "project.refusal.notDraft",
  distribution_missing: "project.refusal.distributionMissing",
  deadline_past: "project.refusal.deadlinePast",
  strategy_frozen: "project.refusal.strategyFrozen",
  publish_mode_frozen: "project.refusal.publishModeFrozen",
  repo_unavailable: "project.refusal.repoUnavailable",
  due_past: "project.refusal.duePast",
  due_after_deadline: "project.refusal.dueAfterDeadline",
  duplicate_checkpoint: "project.refusal.duplicateCheckpoint",
  checkpoint_dispatched: "project.refusal.checkpointDispatched",
};

/** The code of a refusal of the API (`{ error }` in its body), or null. */
export function refusalCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error.body as { error?: unknown } | null)?.error;
  return typeof code === "string" ? code : null;
}

/** The dictionary key wording a refusal the page knows, or null (the server's message then). */
export function refusalKey(error: unknown): keyof Dict | null {
  const code = refusalCode(error);
  return code ? (REFUSAL_KEY[code as ProjectErrorCode | ProjectCheckpointErrorCode] ?? null) : null;
}
