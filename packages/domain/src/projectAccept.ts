/**
 * Whether a project may be accepted now, judged on the project alone
 * (F-PROJ-05, merge task M3-03): its start passed, its deadline not
 * (`now >= deadline` is passed; no grace), a distribution repository to
 * hand out. The student's side (seat, group, GitHub account, installation)
 * is the API's: a group project's `no_group` is judged on its copy (M3-15b).
 *
 * `now` is the server's clock (invariant 5), never read here.
 */

/** Why the project cannot be accepted now: the code of the 409. */
export type ProjectAcceptRefusal = "not_started" | "deadline_passed" | "distribution_missing";

/** The facts of a project the rule reads. */
export interface ProjectAcceptLike {
  startAt: Date;
  deadlineAt: Date;
  distributionFullName: string | null;
}

/** Whether the project's deadline has passed at `now` (no grace): Accept is closed — also a resync's R3 (ADR-070, M3-15b-2b). */
export const deadlinePassed = (project: { deadlineAt: Date }, now: Date): boolean => now.getTime() >= project.deadlineAt.getTime();

/** Why `project` cannot be accepted at `now`, or null when it may. */
export function acceptRefusal(project: ProjectAcceptLike, now: Date): ProjectAcceptRefusal | null {
  if (now.getTime() < project.startAt.getTime()) return "not_started";
  if (deadlinePassed(project, now)) return "deadline_passed";
  if (project.distributionFullName === null) return "distribution_missing";
  return null;
}
