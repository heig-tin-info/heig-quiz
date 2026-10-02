/**
 * Whether a project may be accepted now, judged on the project alone
 * (F-PROJ-05, merge task M3-03): its start passed, its deadline not
 * (`now >= deadline` is passed; no grace), an individual project (a group
 * project waits for merge task M3-15), a distribution repository to hand
 * out. The student's side (seat, GitHub account, installation) is the
 * API's.
 *
 * `now` is the server's clock (invariant 5), never read here.
 */

/** Why the project cannot be accepted now: the code of the 409. */
export type ProjectAcceptRefusal = "not_started" | "deadline_passed" | "no_group" | "distribution_missing";

/** The facts of a project the rule reads. */
export interface ProjectAcceptLike {
  startAt: Date;
  deadlineAt: Date;
  groupMode: boolean;
  distributionFullName: string | null;
}

/** Why `project` cannot be accepted at `now`, or null when it may. */
export function acceptRefusal(project: ProjectAcceptLike, now: Date): ProjectAcceptRefusal | null {
  if (now.getTime() < project.startAt.getTime()) return "not_started";
  if (now.getTime() >= project.deadlineAt.getTime()) return "deadline_passed";
  if (project.groupMode) return "no_group";
  if (project.distributionFullName === null) return "distribution_missing";
  return null;
}
