/**
 * Opening an `online_seb` project's repositories to its students once the
 * lab is over (ADR-145, amending ADR-047 §2) — pure rules (invariant 8):
 * what the opening does to one repository, and whether the course owner
 * may open them now.
 *
 * The opening is a fact of the project (`projects.repos_opened_at`, the
 * server's clock); the invitation's permission reads it through
 * `collaboratorPermission` (`workMode.ts`). The closed list of refusals
 * lives HERE, `as const`; `@quiz/contracts` re-exports it.
 */
import { isLiveIndividualRepo, type RepoLifeLike } from "./groupRepo.js";
import { projectGraded, type ProjectGradingModeName } from "./projectView.js";
import type { WorkModeName } from "./workMode.js";

/** What {@link openingOf} reads of a repository. */
export interface OpenableRepo extends RepoLifeLike {
  frozenAt: Date | string | null;
  /**
   * It holds its student's work (ADR-145 §7): a commit counted by the
   * student's own rule, or the workspace collected into it (ADR-130) — the
   * API's `holdsWork`.
   */
  work: boolean;
}

/**
 * What the opening does to one repository (ADR-145 §7): an individual one —
 * a student's, or a staff seat's test repository (ADR-077) —, live and
 * frozen for good, is `open`ed when it holds its student's work, and is
 * `nothing` to open otherwise (its student accepted and never worked: it
 * holds the statement and the tests). Null for any other repository, which
 * the opening does not concern (not frozen yet, deleted, a group's).
 */
export function openingOf(repo: OpenableRepo): "open" | "nothing" | null {
  if (!isLiveIndividualRepo(repo) || repo.frozenAt === null) return null;
  return repo.work ? "open" : "nothing";
}

/** Why the course owner may not open a project's repositories now: {@link reposOpeningRefusal}. */
export const REPOS_OPENING_REFUSALS = [
  "not_supervised",
  "project_archived",
  "classroom_archived",
  "not_released",
  "repos_not_frozen",
  "nothing_to_open",
] as const;
export type ReposOpeningRefusalCode = (typeof REPOS_OPENING_REFUSALS)[number];

/** The facts {@link reposOpeningRefusal} decides on. */
export interface ReposOpeningFacts {
  workMode: WorkModeName;
  gradingMode: ProjectGradingModeName;
  projectArchived: boolean;
  classroomArchived: boolean;
  released: boolean;
  /** The live student repositories, and of those the ones frozen for good (`releaseCounts`). */
  live: number;
  frozen: number;
  /** The student repositories the opening opens ({@link openingOf} `open`). */
  openable: number;
}

/**
 * THE rule of the owner's opening (ADR-145 §1, §7), in the order a refusal
 * is answered: not an `online_seb` project (`not_supervised`); the project
 * or its classroom archived; a graded project whose scores are not
 * released (`not_released`); a live repository not frozen for good, or
 * none live (`repos_not_frozen`) — graded or not: a make-up whose own
 * deadline was moved after the release still runs (the orchestrator's
 * reading of decision 8); no repository to open (`nothing_to_open`). Null:
 * the owner may open them. Opening what is open is no refusal (the route
 * writes nothing), closing has no rule, the role is the route's.
 */
export function reposOpeningRefusal(f: ReposOpeningFacts): ReposOpeningRefusalCode | null {
  if (f.workMode !== "online_seb") return "not_supervised";
  if (f.projectArchived) return "project_archived";
  if (f.classroomArchived) return "classroom_archived";
  if (projectGraded(f.gradingMode) && !f.released) return "not_released";
  if (f.live === 0 || f.frozen < f.live) return "repos_not_frozen";
  return f.openable === 0 ? "nothing_to_open" : null;
}
