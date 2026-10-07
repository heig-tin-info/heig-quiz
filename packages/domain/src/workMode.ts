/**
 * A project's work mode (ADR-047, amended 2026-10-07 for M6-06) — pure
 * rules (invariant 8): who may choose it, when it freezes, what it does to
 * the student's access, whose workspace quota it consumes, what the portal
 * receives and when a student's workspace opens.
 *
 * The closed lists live HERE, `as const`; `@quiz/contracts` re-exports them
 * and builds its zod enums from them, so the two never drift.
 */
import { isLiveIndividualRepo, type RepoLifeLike } from "./groupRepo.js";
import { effectiveDeadline } from "./projectRuns.js";

/** Where the students work: their own tools, the portal's workspace, the workspace under Safe Exam Browser. */
export const WORK_MODES = ["free", "online", "online_seb"] as const;
export type WorkModeName = (typeof WORK_MODES)[number];

/** Why the caller may not set a project's mode: the code of the refusal. */
export const WORK_MODE_REFUSALS = ["owner_required", "codespace_not_granted", "work_mode_frozen", "work_mode_group"] as const;
export type WorkModeRefusalCode = (typeof WORK_MODE_REFUSALS)[number];

/**
 * Why the start route sends the student back to their project page
 * (`?workspace=<code>`): {@link workspaceStartRefusal}.
 */
export const WORKSPACE_START_REFUSALS = ["not_online", "seb_required", "not_accepted", "closed"] as const;
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
}

/**
 * THE rule of the mode's write, in the order a refusal is answered:
 *
 *   1. only an owner of the course sets it (`403 owner_required`);
 *   2. a mode that runs in the portal needs the owner's grant
 *      (`403 codespace_not_granted`); going back to `free` needs none;
 *   3. once a workspace was launched, the mode is frozen for good
 *      (`409 work_mode_frozen`, ADR-047 §3 as amended): a student's
 *      repository was handed out under it;
 *   4. a group project stays in the students' own tools (`409
 *      work_mode_group`, F-PROJ-06).
 *
 * `to` equal to `from` is never refused: the form may send the mode it
 * shows. `null` when the change may proceed.
 */
export function workModeRefusal(facts: WorkModeFacts, from: WorkModeName, to: WorkModeName): WorkModeRefusalCode | null {
  if (from === to) return null;
  if (!facts.owner) return "owner_required";
  if (isOnlineMode(to) && !facts.granted) return "codespace_not_granted";
  if (facts.launched) return "work_mode_frozen";
  if (isOnlineMode(to) && facts.groupMode) return "work_mode_group";
  return null;
}

/** The facts {@link workspaceStartRefusal} decides on. */
export interface WorkspaceStartFacts {
  project: { workMode: WorkModeName; deadlineAt: Date };
  /** The student's own repository of the project (online modes are individual); null without one. */
  repo: (RepoLifeLike & { deadlineAt: Date | null }) | null;
  /** The project's classroom is archived: it takes no new work. */
  classroomArchived: boolean;
  /** The request rides on a `seb` session confined to this project (D21, M6-07). */
  fromSeb: boolean;
}

/**
 * THE rule of the start route (ADR-047 §6 as amended 2026-10-07), the
 * twin of `acceptRefusal`: in order, a project in the students' own tools
 * (`not_online`), one under Safe Exam Browser asked from outside it — a
 * `seb` session of this project only (`seb_required`, D21) —, no live
 * repository of the student's (`not_accepted`, {@link isLiveIndividualRepo}),
 * their EFFECTIVE deadline passed or the classroom archived (`closed`).
 * Null: the workspace opens.
 */
export function workspaceStartRefusal(facts: WorkspaceStartFacts, now: Date): WorkspaceStartRefusalCode | null {
  const { project, repo } = facts;
  if (!isOnlineMode(project.workMode)) return "not_online";
  if (project.workMode === "online_seb" && !facts.fromSeb) return "seb_required";
  if (repo === null || !isLiveIndividualRepo(repo)) return "not_accepted";
  if (workspaceClosed(facts, effectiveDeadline(repo, project), now)) return "closed";
  return null;
}

/**
 * THE closing rule the start route and the git relay share: the classroom
 * archived, or `closesAt` reached on the server's clock — the effective
 * deadline for the start route, the deadline plus the grace for the relay.
 */
export function workspaceClosed(facts: { classroomArchived: boolean }, closesAt: Date, now: Date): boolean {
  return facts.classroomArchived || closesAt.getTime() <= now.getTime();
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

// ---------------------------------------------------------------- the git relay's tokens (ADR-078)

/**
 * Why Quiz refuses the portal a GitHub token or a relay declaration
 * (ADR-078 §2): `not_found` (404: no launch of that user on that project,
 * or a repository the grant never covers), `not_online` (409), `closed`
 * (409: past the effective deadline plus the grace, archived, staff-locked).
 */
export const GIT_TOKEN_REFUSALS = ["not_found", "not_online", "closed"] as const;
export type GitTokenRefusalCode = (typeof GIT_TOKEN_REFUSALS)[number];

/** The facts {@link gitTokenRefusal} decides on, read in one transaction. */
export interface GitTokenFacts {
  project: {
    workMode: WorkModeName;
    deadlineAt: Date;
    /** F-PROJ-01: the grace after the deadline, in minutes. */
    graceMinutes: number;
    distributionRepoId: number | null;
    distributionFullName: string | null;
  };
  /** A launch token was issued to the user for the project (`codespace_launches`). */
  launched: boolean;
  /** The user's own repository of the project (no group); null without one. */
  repo: (RepoLifeLike & { deadlineAt: Date | null; staffLock: boolean | null; githubRepoId: number | null }) | null;
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

/** The repository's effective deadline plus the project's grace (ADR-078 §7): when its write tokens stop. */
export function relayClosesAt(repo: { deadlineAt: Date | null }, project: { deadlineAt: Date; graceMinutes: number }): Date {
  return new Date(effectiveDeadline(repo, project).getTime() + project.graceMinutes * 60_000);
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
 *      pushes stay pending.
 *
 * Checks 1 (the signature) and 6 (GitHub) are the route's. Returns the
 * grant, or the refusal's code.
 */
export function gitTokenRefusal(facts: GitTokenFacts, now: Date): GitTokenRefusalCode | GitTokenGrantDecision {
  const { project, repo } = facts;
  if (!facts.launched || repo === null || !isLiveIndividualRepo(repo) || repo.githubRepoId === null) return "not_found";
  const closesAt = relayClosesAt(repo, project);
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
