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

/** A mode that runs inside the online workspace portal. */
export function isOnlineMode(mode: WorkModeName): mode is Exclude<WorkModeName, "free"> {
  return mode !== "free";
}

/**
 * Whether a project in `mode` is sent to the portal (`codespace.sync`):
 * `online` only. `online_seb` waits for its Browser Exam Keys (M6-07) —
 * the portal refuses an exam without them.
 */
export function syncsToPortal(mode: WorkModeName): mode is "online" {
  return mode === "online";
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
}

/**
 * THE rule of the start route (ADR-047 §6 as amended 2026-10-07), the
 * twin of `acceptRefusal`: in order, a project in the students' own tools
 * (`not_online`), one under Safe Exam Browser — never outside it, and SEB
 * comes with M6-07 (`seb_required`) —, no live repository of the student's
 * (`not_accepted`, {@link isLiveIndividualRepo}), their EFFECTIVE deadline
 * passed or the classroom archived (`closed`). Null: the workspace opens.
 */
export function workspaceStartRefusal(facts: WorkspaceStartFacts, now: Date): WorkspaceStartRefusalCode | null {
  const { project, repo } = facts;
  if (project.workMode === "free") return "not_online";
  if (project.workMode === "online_seb") return "seb_required";
  if (repo === null || !isLiveIndividualRepo(repo)) return "not_accepted";
  if (facts.classroomArchived || effectiveDeadline(repo, project).getTime() <= now.getTime()) return "closed";
  return null;
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
