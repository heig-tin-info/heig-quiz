/**
 * The rules of the student's side of a project (F-PROJ-04, F-PROJ-15,
 * N-SEC-20; merge task M3-09a): the one status word of their card and view,
 * the group of the Activities their project falls in, and which of their
 * repository's runs they read before the release. The `project` module
 * reads the rows; these decide.
 */

/**
 * The spec's words (F-PROJ-04), plus `released` once the scores are out
 * (F-PROJ-14): to accept (or not yet open, which `startAt` tells), in
 * progress once the repository exists, locked after the student's effective
 * deadline — or while GitHub holds the repository locked for them.
 */
export const STUDENT_PROJECT_STATUSES = ["to_accept", "in_progress", "locked", "released"] as const;
export type StudentProjectStatus = (typeof STUDENT_PROJECT_STATUSES)[number];

export interface StudentProjectFacts {
  startAt: Date;
  /** The student's EFFECTIVE deadline (`effectiveDeadline`): their own, else the project's. */
  deadlineAt: Date;
  /** The project's scores were released (F-PROJ-14). */
  released: boolean;
  /** The student's repository is provisioned. */
  accepted: boolean;
  /** GitHub holds the repository locked (the deadline's lock, or the staff's hand). */
  locked: boolean;
}

/** The status word of `facts` at `now`. */
export function studentProjectStatus(facts: StudentProjectFacts, now: Date): StudentProjectStatus {
  if (facts.released) return "released";
  if (facts.locked || now.getTime() >= facts.deadlineAt.getTime()) return "locked";
  return facts.accepted ? "in_progress" : "to_accept";
}

export type StudentActivityGroup = "open" | "upcoming" | "past";

/**
 * The group of the student's Activities a project falls in, by its dates
 * (F-ORG-15): Upcoming until it starts, Past once it is locked or released
 * for this student, Open now between the two.
 */
export function studentProjectGroup(facts: StudentProjectFacts, now: Date): StudentActivityGroup {
  if (now.getTime() < facts.startAt.getTime()) return "upcoming";
  const status = studentProjectStatus(facts, now);
  return status === "locked" || status === "released" ? "past" : "open";
}

/**
 * The run a student reads before the release (F-PROJ-15, N-SEC-20): the
 * frozen slot once their deadline is applied — never a run after it, even
 * while the grace still moves the frozen one —, the current slot before.
 * Never the review's nor the teacher's: those reach them with the release.
 * `frozen` says which it was.
 */
export function studentScoreRun<T>(repo: {
  deadlineAppliedAt: Date | null;
  current: T | null;
  frozen: T | null;
}): { run: T; frozen: boolean } | null {
  if (repo.deadlineAppliedAt !== null) return repo.frozen === null ? null : { run: repo.frozen, frozen: true };
  return repo.current === null ? null : { run: repo.current, frozen: false };
}
