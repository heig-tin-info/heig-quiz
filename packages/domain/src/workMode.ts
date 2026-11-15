/**
 * A project's work mode (ADR-047, amended 2026-10-07 for M6-06) — pure
 * rules (invariant 8): who may choose it, when it freezes, what it does to
 * the student's access, whose workspace quota it consumes, what the portal
 * receives and when a student's workspace opens.
 *
 * The closed lists live HERE, `as const`; `@quiz/contracts` re-exports them
 * and builds its zod enums from them, so the two never drift.
 */
import { acceptsKiosk, deviceLevelClients, type DeviceLevel } from "./deviceLevels.js";
import type { TrustedClient } from "./evaluationConfig.js";
import { isLiveIndividualRepo, isLiveRepo, type RepoLifeLike } from "./groupRepo.js";
import { effectiveDeadline, writableUnderCommit, type DeadlineStrategyName } from "./projectRuns.js";

/** Where the students work: their own tools, the portal's workspace, the workspace under Safe Exam Browser. */
export const WORK_MODES = ["free", "online", "online_seb"] as const;
export type WorkModeName = (typeof WORK_MODES)[number];

/** Why the caller may not set a project's mode: the code of the refusal. */
export const WORK_MODE_REFUSALS = [
  "owner_required",
  "codespace_not_granted",
  "work_mode_frozen",
  "work_mode_group",
  "kiosk_unavailable",
] as const;
export type WorkModeRefusalCode = (typeof WORK_MODE_REFUSALS)[number];

/**
 * Why the start route sends the student back to their project page
 * (`?workspace=<code>`): {@link workspaceStartRefusal}.
 */
export const WORKSPACE_START_REFUSALS = ["not_online", "seb_required", "kiosk_required", "not_accepted", "closed"] as const;
export type WorkspaceStartRefusalCode = (typeof WORKSPACE_START_REFUSALS)[number];

/**
 * A mode that runs inside the online workspace portal: what is sent to it
 * (`codespace.sync`), `online_seb` with its Browser Exam Keys — none means
 * the Config Key alone (D21, M6-07).
 */
export function isOnlineMode(mode: WorkModeName): mode is Exclude<WorkModeName, "free"> {
  return mode !== "free";
}

/**
 * The GitHub permission a student's invitation carries (ADR-047 §2):
 * `push` in their own tools (unchanged), `pull` in the online workspace —
 * only the portal writes —, and no invitation at all under Safe Exam
 * Browser (null): no access before grading.
 */
export function collaboratorPermission(mode: WorkModeName): "push" | "pull" | null {
  if (mode === "free") return "push";
  return mode === "online" ? "pull" : null;
}

/**
 * A project's work setting as stored (ADR-089, amendment of 2026-11-15,
 * point 2): its mode and its device level. `devices` is `any` exactly when
 * the mode is unsupervised (`free`, `online`); `online_seb` holds one of
 * the three supervised levels. The body's schema refuses another pair, the
 * column's check backs it up.
 */
export interface WorkSetting {
  mode: WorkModeName;
  devices: DeviceLevel;
}

/**
 * THE mapping between a project's stored setting and what its screen shows
 * (ADR-089, amendment point 2, "One column, one mapping"): out of the
 * workspace, the students' own tools; in it, a device level — `any` is
 * `online`, the three others `online_seb` with that level.
 * {@link projectDeviceLevel} is its inverse.
 */
export function workSettingFor(online: boolean, level: DeviceLevel): WorkSetting {
  if (!online) return { mode: "free", devices: "any" };
  return level === "any" ? { mode: "online", devices: "any" } : { mode: "online_seb", devices: level };
}

/** The device level a setting is in force at: `any` unless supervised. */
export function projectDeviceLevel(setting: WorkSetting): DeviceLevel {
  return setting.mode === "online_seb" ? setting.devices : "any";
}

/** The trusted clients a project's workspace opens from: none outside `online_seb`. */
export function projectTrustedClients(setting: WorkSetting): readonly TrustedClient[] {
  return deviceLevelClients(projectDeviceLevel(setting));
}

/** The facts {@link workModeRefusal} decides on. */
export interface WorkModeFacts {
  /** The caller is an owner of the project's course (ADR-068, Super Powers included). */
  owner: boolean;
  /** The caller's `teacher_grants` row has `codespace_enabled`. */
  granted: boolean;
  /** A workspace was launched for the project by a student seat (a launch token issued). */
  launched: boolean;
  /** The project is a group project (F-PROJ-06: their own tools only). */
  groupMode: boolean;
  /**
   * The platform offers kiosk stations to projects (the API's
   * `kioskProjectsOn`, ADR-089 amendment point 1).
   */
  kioskOffered: boolean;
}

/**
 * THE rule of the setting's write, on (mode, devices) pairs, in the order a
 * refusal is answered:
 *
 *   1. only an owner of the course sets it (`403 owner_required`);
 *   2. a mode that runs in the portal needs the owner's grant
 *      (`403 codespace_not_granted`); going back to `free` needs none;
 *   3. once a workspace was launched, the pair is frozen for good — the
 *      mode and the level alike (`409 work_mode_frozen`, ADR-047 §3 as
 *      amended, ADR-089 amendment point 2): a student's repository was
 *      handed out under it;
 *   4. a group project stays in the students' own tools (`409
 *      work_mode_group`, F-PROJ-06);
 *   5. a change TO a level that accepts a kiosk station while the platform
 *      does not offer them to projects (`422 kiosk_unavailable`, ADR-089
 *      amendment point 1): the flag gates new choices; leaving such a level
 *      passes.
 *
 * `to` equal to `from` is never refused: the form may send the pair it
 * shows, and a live project keeps its level whatever the flag. `null` when
 * the change may proceed.
 */
export function workModeRefusal(facts: WorkModeFacts, from: WorkSetting, to: WorkSetting): WorkModeRefusalCode | null {
  if (from.mode === to.mode && from.devices === to.devices) return null;
  if (!facts.owner) return "owner_required";
  if (isOnlineMode(to.mode) && !facts.granted) return "codespace_not_granted";
  if (facts.launched) return "work_mode_frozen";
  if (isOnlineMode(to.mode) && facts.groupMode) return "work_mode_group";
  if (acceptsKiosk(projectDeviceLevel(to)) && !facts.kioskOffered) return "kiosk_unavailable";
  return null;
}

/**
 * The modes the caller may set now and the first refusal met — the staff's
 * view (`ProjectWorkspace`) of {@link workModeRefusal}: each mode judged as
 * the setting it would be written as, `online_seb` keeping the level in
 * force, or at SEB from another mode.
 */
export function workModeChoices(
  facts: WorkModeFacts,
  from: WorkSetting,
): { allowed: WorkModeName[]; refusal: WorkModeRefusalCode | null } {
  const judged = WORK_MODES.map((mode) => {
    const devices: DeviceLevel = mode !== "online_seb" ? "any" : from.mode === "online_seb" ? from.devices : "seb";
    return { mode, refusal: workModeRefusal(facts, from, { mode, devices }) };
  });
  return {
    allowed: judged.filter((j) => j.refusal === null).map((j) => j.mode),
    refusal: judged.find((j) => j.refusal !== null)?.refusal ?? null,
  };
}

/** The facts {@link workspaceStartRefusal} decides on. */
export interface WorkspaceStartFacts {
  project: WorkspaceProject & { devices: DeviceLevel };
  /** The student's own repository of the project (online modes are individual); null without one. */
  repo: (RepoLifeLike & WorkspaceRepo) | null;
  /** The project's classroom is archived: it takes no new work. */
  classroomArchived: boolean;
  /**
   * The trusted client of the session confined to THIS project the request
   * rides on (the API's `confinedProjectSession`: D21, ADR-089 §4); null
   * from the student's portal session.
   */
  via: TrustedClient | null;
}

/** What of a project the workspace's deadline rules read. */
export interface WorkspaceProject {
  workMode: WorkModeName;
  deadlineAt: Date;
  /** F-PROJ-09: `commit` leaves the repository writable past the deadline. */
  deadlineStrategy: DeadlineStrategyName;
  archivedAt: Date | null;
}

/** What of a student's repository the workspace's deadline rules read. */
export interface WorkspaceRepo {
  deadlineAt: Date | null;
  staffLock: boolean | null;
  deadlineAppliedAt: Date | null;
  lockedAt: Date | null;
}

/**
 * Whether a project's workspaces follow the repository's writability rather
 * than the deadline (#958, product owner 2026-10-29: "if they can push with
 * git, they can push by the other means too"): an `online` project under the
 * `commit` strategy. An exam under Safe Exam Browser keeps its deadline.
 */
function followsWritability(project: Pick<WorkspaceProject, "workMode" | "deadlineStrategy">): boolean {
  return project.workMode === "online" && project.deadlineStrategy === "commit";
}

/**
 * When a student's workspace closes, for the start route and the relay
 * alike: null while it follows a repository GitHub keeps writable
 * ({@link writableUnderCommit}); otherwise the effective deadline plus
 * `graceMinutes` (none for the start route, the project's for the relay).
 */
export function workspaceClosesAt(repo: WorkspaceRepo, project: WorkspaceProject, graceMinutes: number): Date | null {
  if (followsWritability(project) && writableUnderCommit(repo, project)) return null;
  return new Date(effectiveDeadline(repo, project).getTime() + graceMinutes * 60_000);
}

/**
 * The deadline the portal is given (`CodespaceAssignmentSync.deadlineAt`):
 * its launch gate and the workspace's countdown. None where workspaces
 * follow writability: Quiz's start route then decides, student by student.
 */
export function portalDeadline(project: Pick<WorkspaceProject, "workMode" | "deadlineStrategy" | "deadlineAt">): Date | null {
  return followsWritability(project) ? null : project.deadlineAt;
}

/**
 * THE rule of the start route (ADR-047 §6 as amended 2026-10-07), the
 * twin of `acceptRefusal`: in order, a project in the students' own tools
 * (`not_online`), a supervised one asked from a client its level does not
 * accept — a confined session of this project, of an accepted kind:
 * `seb_required` where SEB is accepted (D21), `kiosk_required` at Kiosk
 * only (ADR-089 amendment point 2) —, no live
 * repository of the student's (`not_accepted`, {@link isLiveIndividualRepo}),
 * their EFFECTIVE deadline passed — unless the workspace follows a writable
 * repository ({@link workspaceClosesAt}, #958) — or the classroom archived
 * (`closed`). Null: the workspace opens.
 */
export function workspaceStartRefusal(facts: WorkspaceStartFacts, now: Date): WorkspaceStartRefusalCode | null {
  const { project, repo } = facts;
  if (!isOnlineMode(project.workMode)) return "not_online";
  const clients = projectTrustedClients({ mode: project.workMode, devices: project.devices });
  if (clients.length > 0 && (facts.via === null || !clients.includes(facts.via))) {
    return clients.includes("seb") ? "seb_required" : "kiosk_required";
  }
  if (repo === null || !isLiveIndividualRepo(repo)) return "not_accepted";
  if (workspaceClosed(facts, workspaceClosesAt(repo, project, 0), now)) return "closed";
  return null;
}

/**
 * Whether a station may be paired for a project (ADR-089 §5): a level that
 * accepts a kiosk station — "SEB or kiosk" or "Kiosk only", hence
 * `online_seb` — before the student's effective deadline (ADR-078 §2; the
 * project's own without a repository yet). The seat, the project open and
 * the classroom not archived are the query's. The same rule for the phone's
 * list, the approval and the station's consumption.
 */
export function kioskProjectPairable(
  project: WorkSetting & { deadlineAt: Date },
  repo: { deadlineAt: Date | null } | null,
  now: Date,
): boolean {
  return (
    projectTrustedClients(project).includes("kiosk") &&
    effectiveDeadline(repo ?? { deadlineAt: null }, project).getTime() > now.getTime()
  );
}

/**
 * THE closing rule the start route and the git relay share: the classroom
 * archived, or `closesAt` reached on the server's clock
 * ({@link workspaceClosesAt}; null: no deadline closes it).
 */
export function workspaceClosed(facts: { classroomArchived: boolean }, closesAt: Date | null, now: Date): boolean {
  return facts.classroomArchived || (closesAt !== null && closesAt.getTime() <= now.getTime());
}

/** An owner seat of a course, as `course_staff` holds it. */
export interface OwnerSeat {
  userId: string;
  createdAt: Date;
}

/**
 * Who carries a project's workspace quota (ADR-047 as amended 2026-10-07,
 * decision C): its creator while they still hold an owner seat on the
 * course, otherwise the OLDEST owner seat (ties by user id, so the answer
 * never depends on the order rows come in). Null for a course without an
 * owner, which ADR-068's last-owner rule never leaves.
 */
export function quotaHolder(creatorId: string, owners: readonly OwnerSeat[]): string | null {
  if (owners.some((o) => o.userId === creatorId)) return creatorId;
  const oldest = [...owners].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  )[0];
  return oldest?.userId ?? null;
}

// ---------------------------------------------------------------- the staff's review session (ADR-129)

/** Why a review session of a repository is refused (ADR-129 §5, rows 4–7): {@link staffReviewRefusal}. */
export const STAFF_REVIEW_REFUSALS = ["review_not_granted", "review_archived", "review_repo_unavailable", "review_exam_open"] as const;
export type StaffReviewRefusalCode = (typeof STAFF_REVIEW_REFUSALS)[number];

/** The facts {@link staffReviewRefusal} decides on. */
export interface StaffReviewFacts {
  /** The project's quota holder holds an enabled workspace grant (`grantOf`). */
  holderGranted: boolean;
  classroomArchived: boolean;
  projectArchived: boolean;
  /** The reviewed repository: a student's, a group's or a staff seat's test one. */
  repo: Omit<RepoLifeLike, "groupId"> & { githubRepoId: number | null; deadlineAppliedAt: Date | string | null };
  workMode: WorkModeName;
}

/**
 * THE rule of the staff's review session (ADR-129 §5), the launch route's,
 * the token route's (§7) and the page's (§11), in order: the quota holder
 * holds no enabled grant (`review_not_granted`), the classroom or the
 * project archived (`review_archived`), the repository not live
 * (`review_repo_unavailable`: {@link isLiveRepo} and its GitHub id known), an `online_seb`
 * repository whose deadline is not applied yet — the exam may be running —
 * (`review_exam_open`). Never the deadline, a lock, the release or the
 * deadline strategy (§2). Null: the review may open.
 */
export function staffReviewRefusal(facts: StaffReviewFacts): StaffReviewRefusalCode | null {
  if (!facts.holderGranted) return "review_not_granted";
  if (facts.classroomArchived || facts.projectArchived) return "review_archived";
  if (!isLiveRepo(facts.repo) || facts.repo.githubRepoId === null) return "review_repo_unavailable";
  if (facts.workMode === "online_seb" && facts.repo.deadlineAppliedAt === null) return "review_exam_open";
  return null;
}

// ---------------------------------------------------------------- the git relay's tokens (ADR-078)

/**
 * Why Quiz refuses the portal a GitHub token or a relay declaration
 * (ADR-078 §2): `not_found` (404: no launch of that user on that project,
 * or a repository the grant never covers), `not_online` (409), `closed`
 * (409: past the effective deadline plus the grace — unless an `online`
 * workspace follows a writable repository —, archived, staff-locked).
 */
export const GIT_TOKEN_REFUSALS = ["not_found", "not_online", "closed"] as const;
export type GitTokenRefusalCode = (typeof GIT_TOKEN_REFUSALS)[number];

/** The facts {@link gitTokenRefusal} decides on, read in one transaction. */
export interface GitTokenFacts {
  project: WorkspaceProject & {
    /** F-PROJ-01: the grace after the deadline, in minutes. */
    graceMinutes: number;
    distributionRepoId: number | null;
    distributionFullName: string | null;
  };
  /** A launch token was issued to the user for the project (`codespace_launches`). */
  launched: boolean;
  /** The user's own repository of the project (no group); null without one. */
  repo: (RepoLifeLike & WorkspaceRepo & { githubRepoId: number | null }) | null;
  /** The classroom of the project is archived. */
  classroomArchived: boolean;
  /** `owner/name`, as the portal asks for it. */
  repository: string;
}

/**
 * What Quiz grants: the permission, the repository's GitHub id, and the
 * last instant a write grant may be used (null: the token's own expiry).
 */
export interface GitTokenGrantDecision {
  permission: "write" | "read";
  githubRepoId: number;
  useUntil: Date | null;
}

const sameRepository = (stored: string | null, asked: string): boolean =>
  stored !== null && stored.toLowerCase() === asked.toLowerCase();

/**
 * THE rule of `POST /app/codespace/git-token` and `POST
 * /app/codespace/relay-heads` (ADR-078 §2), in the record's order:
 *
 *   2. a launch of that user on that project (`not_found`);
 *   3. the repository is the user's own live repository (a `write` grant)
 *      or, for an `online_seb` project only, its distribution repository
 *      (a `read` grant, to seed the exam workspace); anything else
 *      `not_found`;
 *   4. an online mode (`not_online`);
 *   5. the user's repository open: the start route's closing rule
 *      ({@link workspaceClosed}) read at the effective deadline PLUS the
 *      grace (§7, confirmed by the product owner on 2026-10-07), and no
 *      staff lock (`closed`). The start route does not read the staff lock
 *      (ADR-047): a locked repository still opens a workspace, whose
 *      pushes stay pending. An `online` project under the `commit`
 *      strategy has no such bound while GitHub keeps the repository
 *      writable ({@link workspaceClosesAt}): it stays open while the
 *      classroom is not archived, and its write grant runs to the token's
 *      own expiry (#958, ADR-078 as amended 2026-10-29, product owner).
 *
 * Checks 1 (the signature) and 6 (GitHub) are the route's. Returns the
 * grant, or the refusal's code.
 */
export function gitTokenRefusal(facts: GitTokenFacts, now: Date): GitTokenRefusalCode | GitTokenGrantDecision {
  const { project, repo } = facts;
  if (!facts.launched || repo === null || !isLiveIndividualRepo(repo) || repo.githubRepoId === null) return "not_found";
  const closesAt = workspaceClosesAt(repo, project, project.graceMinutes);
  let grant: GitTokenGrantDecision;
  if (sameRepository(repo.fullName, facts.repository)) {
    grant = { permission: "write", githubRepoId: repo.githubRepoId, useUntil: closesAt };
  } else if (
    project.workMode === "online_seb" &&
    project.distributionRepoId !== null &&
    sameRepository(project.distributionFullName, facts.repository)
  ) {
    grant = { permission: "read", githubRepoId: project.distributionRepoId, useUntil: null };
  } else {
    return "not_found";
  }
  if (!isOnlineMode(project.workMode)) return "not_online";
  // Safe Exam Browser is the start route's to check: the portal's request is not a browser's.
  if (workspaceClosed(facts, closesAt, now) || repo.staffLock === true) return "closed";
  return grant;
}
