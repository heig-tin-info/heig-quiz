/**
 * Opening an `online_seb` project's repositories to its students once the
 * lab is over (ADR-145, amending ADR-047 §2) — pure rules (invariant 8):
 * which repository may be opened, whether the course owner may open them
 * now, and the deadline move that the opened fact refuses.
 *
 * The opening is a fact of the project (`projects.repos_opened_at`, the
 * server's clock); the invitation's permission reads it
 * (`collaboratorPermission`, `workMode.ts`). The closed list of refusals
 * lives HERE, `as const`; `@quiz/contracts` re-exports it.
 */
import { isLiveIndividualRepo, type RepoLifeLike } from "./groupRepo.js";
import { studentCommitCount, type CountedReceipt } from "./projectStudent.js";
import { projectGraded, type ProjectGradingModeName } from "./projectView.js";
import type { WorkModeName } from "./workMode.js";

/**
 * Whether a repository holds its student's work (ADR-145 §7, product owner
 * 2026-11-24): at least one commit counted by the student's own rule
 * (`studentCommitCount`: received by the effective deadline, pushed by no
 * bot) — the receipts passed INCLUDE the workspace's collections (ADR-130
 * §6), each counted as one commit: a collection is the student's work
 * handed in by the platform. A repository its student never worked in
 * holds the statement and the tests only.
 */
export function holdsStudentWork(receipts: readonly CountedReceipt[], deadlineAt: Date): boolean {
  return studentCommitCount(receipts, deadlineAt) > 0;
}

/** What {@link repoOpenable} reads of a repository. */
export interface OpenableRepo extends RepoLifeLike {
  frozenAt: Date | string | null;
  /** {@link holdsStudentWork} of the repository. */
  work: boolean;
}

/**
 * Whether one repository of an `online_seb` project may be opened to its
 * student (ADR-145 §7): an individual one — a student's or a staff seat's
 * test repository (ADR-077) —, live, frozen for good, holding the student's
 * work. The project's own facts (opened, archived) are the caller's.
 */
export function repoOpenable(repo: OpenableRepo): boolean {
  return isLiveIndividualRepo(repo) && repo.frozenAt !== null && repo.work;
}

/**
 * A repository frozen for good that holds no work of its student (ADR-145
 * §7): the staff read it as "nothing to open" — its student accepted and
 * never worked (absent, a make-up to come).
 */
export function nothingToOpen(repo: OpenableRepo): boolean {
  return isLiveIndividualRepo(repo) && repo.frozenAt !== null && !repo.work;
}

/** Why the course owner may not open a project's repositories now: {@link reposOpeningRefusal}. */
export const REPOS_OPENING_REFUSALS = [
  "not_supervised",
  "project_archived",
  "classroom_archived",
  "repos_already_open",
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
  /** `repos_opened_at` is set. */
  opened: boolean;
  released: boolean;
  /** The live student repositories, and of those the ones frozen for good (`releaseCounts`). */
  live: number;
  frozen: number;
  /** The student repositories {@link repoOpenable}. */
  openable: number;
}

/**
 * THE rule of the owner's opening (ADR-145 §1, §7), in the order a refusal
 * is answered: not an `online_seb` project (`not_supervised`); the project
 * or its classroom archived; open already; a graded project whose scores
 * are not released (`not_released`), an ungraded one whose live
 * repositories are not all frozen for good, and at least one
 * (`repos_not_frozen`); no repository to open (`nothing_to_open`). Null:
 * the owner may open them. The role is the route's (`owner_required`).
 * Closing has no rule: it is allowed whenever they are open, an archived
 * project's included.
 */
export function reposOpeningRefusal(f: ReposOpeningFacts): ReposOpeningRefusalCode | null {
  if (f.workMode !== "online_seb") return "not_supervised";
  if (f.projectArchived) return "project_archived";
  if (f.classroomArchived) return "classroom_archived";
  if (f.opened) return "repos_already_open";
  if (projectGraded(f.gradingMode)) {
    if (!f.released) return "not_released";
  } else if (f.live === 0 || f.frozen < f.live) {
    return "repos_not_frozen";
  }
  return f.openable === 0 ? "nothing_to_open" : null;
}

/**
 * The deadline guard of ADR-145 §8: a deadline move — the project's or a
 * repository's own — that would reopen a repository of a project whose
 * repositories are open is refused (`409 repos_open`): the access is
 * closed first. Null: the move proceeds.
 */
export function deadlineMoveRefusal(f: { opened: boolean; reopened: number }): "repos_open" | null {
  return f.opened && f.reopened > 0 ? "repos_open" : null;
}
