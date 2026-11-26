/**
 * A project's work mode (ADR-047, amended 2026-10-07 for M6-06) — pure
 * rules (invariant 8): who may choose it, when it freezes, what it does to
 * the student's access, whose workspace quota it consumes, what the portal
 * receives and when a student's workspace opens.
 *
 * The closed lists live HERE, `as const`; `@quiz/contracts` re-exports them
 * and builds its zod enums from them, so the two never drift.
 */
import { acceptsKiosk, deviceLevelClients, type DeviceLevel, type SupervisedDeviceLevel } from "./deviceLevels.js";
import type { TrustedClient } from "./evaluationConfig.js";
import { isLiveIndividualRepo, isLiveRepo, type RepoLifeLike } from "./groupRepo.js";
import { effectiveDeadline, writableUnderCommit, type DeadlineStrategyName } from "./projectRuns.js";

/**
 * Where the students work: their own tools, their own tools or the portal's
 * workspace at their choice (`hybrid`, ADR-149), the portal's workspace, the
 * workspace under Safe Exam Browser. In the order the staff's screen offers
 * them.
 */
export const WORK_MODES = ["free", "hybrid", "online", "online_seb"] as const;
export type WorkModeName = (typeof WORK_MODES)[number];

/** A mode that runs inside the online workspace portal ({@link isOnlineMode}). */
export type OnlineModeName = Exclude<WorkModeName, "free">;

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
 * the Config Key alone (D21, M6-07). `hybrid` too (ADR-149): its students
 * may start the workspace and push through the relay.
 */
export function isOnlineMode(mode: WorkModeName): mode is OnlineModeName {
  return mode !== "free";
}

/** The modes that run inside the portal, in {@link WORK_MODES}' order: those the deadline's collection considers (ADR-130). */
export const ONLINE_MODES: readonly OnlineModeName[] = WORK_MODES.filter(isOnlineMode);

/**
 * The mode the portal is told (`CodespaceAssignmentSync.mode`, ADR-149 §3):
 * `hybrid` is the portal's lab mode, as `online` is — the portal knows no
 * third mode, so none of its code changes for it.
 */
export function portalMode(mode: OnlineModeName): "online" | "online_seb" {
  return mode === "online_seb" ? "online_seb" : "online";
}

/**
 * THE portal's lab mode: a workspace without supervision, `online` and
 * `hybrid` (ADR-149 §3). Its workspaces follow the repository's writability
 * under `commit` (ADR-078 §11) and offer the teacher's update to merge
 * (ADR-132 §11; `hybrid` beside the pull request its students also get,
 * ADR-149 §4). `online_seb` is the exam mode, `free` has no workspace.
 */
export function isLabMode(mode: WorkModeName): boolean {
  return isOnlineMode(mode) && portalMode(mode) === "online";
}

/**
 * `hybrid`, the one mode with two write paths — the student's own git and
 * the workspace's relay (ADR-149): the deadline weighs who wrote last
 * before it collects a workspace (§2), and the portal refreshes a
 * workspace's staging repository from GitHub when it opens (§7,
 * `CodespaceAssignmentSync.refreshOnOpen`).
 */
export function hasTwoWritePaths(mode: WorkModeName): boolean {
  return mode === "hybrid";
}

/**
 * THE GitHub permission an invitation carries (ADR-047 §2 as amended by
 * ADR-145 and ADR-149): `push` in the students' own tools (unchanged) and
 * at their choice between them and the workspace (`hybrid`), `pull` in the
 * online workspace — only the portal writes —, and under Safe Exam Browser
 * nothing (null) unless `opened`: the course owner opened the repositories,
 * the project and its classroom are not archived, and the repository is one
 * the opening opens (`openingOf`, `reposOpening.ts`) — then `pull`, never
 * more. The caller judges `opened` (the API's `inviteAccount`, `access.ts`);
 * every invitation — an Accept, a resend, the reconciliation, the
 * opening's job — asks this.
 */
export function collaboratorPermission(mode: WorkModeName, opened = false): "push" | "pull" | null {
  if (mode === "free" || mode === "hybrid") return "push";
  if (mode === "online") return "pull";
  return opened ? "pull" : null;
}

/**
 * A project's work setting as stored (ADR-089, amendment of 2026-11-15,
 * point 2): its mode and its device level. `devices` is `any` exactly when
 * the mode is unsupervised (`free`, `hybrid`, `online`); `online_seb` holds one of
 * the three supervised levels. The body's schema refuses another pair, the
 * column's check backs it up.
 */
export interface WorkSetting {
  mode: WorkModeName;
  devices: DeviceLevel;
}

/** The body of the mode's write (`ProjectWorkModeBody` of `@quiz/contracts`): the level under supervision only. */
export type WorkSettingBody =
  | { mode: Exclude<WorkModeName, "online_seb"> }
  | { mode: "online_seb"; devices: SupervisedDeviceLevel };

/**
 * The three places a project's screen offers for the four modes (ADR-149
 * §1): the students' own tools, their choice between them and the
 * workspace, the workspace at a device level.
 */
export type WorkPlace = "own" | "hybrid" | "online";

/** The place a mode is shown as: the workspace at any device level is `online`. */
export function workPlaceOf(mode: WorkModeName): WorkPlace {
  return mode === "free" ? "own" : mode === "hybrid" ? "hybrid" : "online";
}

/** The places, in {@link WORK_MODES}' order. */
export const WORK_PLACES: readonly WorkPlace[] = [...new Set(WORK_MODES.map(workPlaceOf))];

/**
 * THE mapping between what a project's screen shows and the mode's write
 * (ADR-089, amendment point 2, "One column, one mapping"; ADR-149 §1): out
 * of the workspace, the students' own tools; at their choice, `hybrid`,
 * which has no level; in the workspace, a device level — `any` is
 * `online`, the three others `online_seb` with that level. Back,
 * {@link workSettingOf}: the stored `devices` is the level, `any` outside
 * `online_seb`.
 */
export function workSettingFor(place: WorkPlace, level: DeviceLevel): WorkSettingBody {
  if (place === "own") return { mode: "free" };
  if (place === "hybrid") return { mode: "hybrid" };
  return level === "any" ? { mode: "online" } : { mode: "online_seb", devices: level };
}

/** The setting a body of the mode's write stands for (`ProjectWorkModeBody`): the level is `any` unless supervised. */
export function workSettingOf(body: WorkSettingBody): WorkSetting {
  return body.mode === "online_seb" ? { mode: body.mode, devices: body.devices } : { mode: body.mode, devices: "any" };
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
 *      handed out under it — `hybrid` alike (ADR-149 §5) —, except the one
 *      change that only widens what students may do
 *      ({@link widensAfterLaunch});
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
  if (facts.launched && !widensAfterLaunch(from, to)) return "work_mode_frozen";
  if (isOnlineMode(to.mode) && facts.groupMode) return "work_mode_group";
  if (acceptsKiosk(to.devices) && !facts.kioskOffered) return "kiosk_unavailable";
  return null;
}

/**
 * The one change a launched workspace leaves open (ADR-149 §7, product
 * owner 2026-11-26): `online` to `hybrid`. The students keep the workspace
 * and gain their own git: nothing handed out under `online` is taken away.
 * Every other change after a launch narrows or swaps a write path, and is
 * frozen.
 */
export function widensAfterLaunch(from: WorkSetting, to: WorkSetting): boolean {
  return from.mode === "online" && to.mode === "hybrid";
}

/**
 * Whether a change of the work mode widens the permission of the
 * invitations already sent (ADR-149 §7, amending ADR-047 M6-06 (A)): to a
 * mode that invites with `push` from one that invited with less. The API's
 * `project.repos_access` job then brings every live grant to `push` on
 * GitHub; a narrowing never takes an access back.
 */
export function widensInvitations(from: WorkModeName, to: WorkModeName): boolean {
  return collaboratorPermission(to) === "push" && collaboratorPermission(from, true) !== "push";
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
 * git, they can push by the other means too"): an `online` or `hybrid`
 * project (ADR-149 §2) under the `commit` strategy. An exam under Safe Exam
 * Browser keeps its deadline.
 */
function followsWritability(project: Pick<WorkspaceProject, "workMode" | "deadlineStrategy">): boolean {
  return isLabMode(project.workMode) && project.deadlineStrategy === "commit";
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
  const clients = deviceLevelClients(project.devices);
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
  project: { devices: DeviceLevel; deadlineAt: Date },
  repo: { deadlineAt: Date | null } | null,
  now: Date,
): boolean {
  return (
    acceptsKiosk(project.devices) &&
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

/**
 * The refusals both kinds of review share (ADR-129 §5 rows 4–5, ADR-147 §3),
 * in order: the holder's grant, then the archives ({@link reviewGateRefusal}).
 */
const REVIEW_GATE_REFUSALS = ["review_not_granted", "review_archived"] as const;
type ReviewGateRefusalCode = (typeof REVIEW_GATE_REFUSALS)[number];

/** Why a review session of a repository is refused (ADR-129 §5, rows 4–7): {@link staffReviewRefusal}. */
export const STAFF_REVIEW_REFUSALS = [...REVIEW_GATE_REFUSALS, "review_repo_unavailable", "review_exam_open"] as const;
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
  const gate = reviewGateRefusal(facts);
  if (gate !== null) return gate;
  if (!isLiveRepo(facts.repo) || facts.repo.githubRepoId === null) return "review_repo_unavailable";
  if (facts.workMode === "online_seb" && facts.repo.deadlineAppliedAt === null) return "review_exam_open";
  return null;
}

type ReviewGateFacts = Pick<StaffReviewFacts, "holderGranted" | "classroomArchived" | "projectArchived">;

/** The rows both kinds of review share ({@link REVIEW_GATE_REFUSALS}). */
function reviewGateRefusal(facts: ReviewGateFacts): ReviewGateRefusalCode | null {
  if (!facts.holderGranted) return "review_not_granted";
  if (facts.classroomArchived || facts.projectArchived) return "review_archived";
  return null;
}

/**
 * Why an owner's review session of a project's distribution repository is
 * refused (ADR-147 §3): {@link distributionReviewRefusal}.
 */
export const DISTRIBUTION_REVIEW_REFUSALS = [...REVIEW_GATE_REFUSALS, "review_distribution_missing"] as const;
export type DistributionReviewRefusalCode = (typeof DISTRIBUTION_REVIEW_REFUSALS)[number];

/** The facts {@link distributionReviewRefusal} decides on. */
export interface DistributionReviewFacts extends ReviewGateFacts {
  /** The project's distribution repository is built: its name and GitHub id stored. */
  distributionBuilt: boolean;
}

/**
 * THE rule of the distribution's review session (ADR-147 §3), the launch
 * route's, the token route's and the page's, in order: the quota holder
 * holds no enabled grant (`review_not_granted`), the classroom or the
 * project archived (`review_archived`), no distribution repository built
 * (`review_distribution_missing`). Never the project's state (draft,
 * scheduled, open or closed alike), its mode, a deadline or a lock. Who
 * may ask, an owner, is the loader's step, not this rule's. Null: the
 * session may open.
 */
export function distributionReviewRefusal(facts: DistributionReviewFacts): DistributionReviewRefusalCode | null {
  const gate = reviewGateRefusal(facts);
  if (gate !== null) return gate;
  return facts.distributionBuilt ? null : "review_distribution_missing";
}

// ---------------------------------------------------------------- the git relay's tokens (ADR-078)

/**
 * Why Quiz refuses the portal a GitHub token or a relay declaration
 * (ADR-078 §2): `not_found` (404: no launch of that user on that project,
 * or a repository the grant never covers), `not_online` (409), `closed`
 * (409: past the effective deadline plus the grace — unless an `online` or
 * `hybrid` workspace follows a writable repository —, archived, staff-locked).
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
 *      pushes stay pending. An `online` or `hybrid` project under the `commit`
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
