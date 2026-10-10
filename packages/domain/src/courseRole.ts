/**
 * The role of an account on a course's staff (ADR-068) — a pure rule
 * (invariant 8). `staffAccess` decides who REACHES a course (a seat, or Super
 * Powers); this decides what a member may DO there, and the last-owner rule
 * every change of the staff obeys.
 */
import type { EvaluationModeName } from "./evaluationConfig.js";

export const COURSE_ROLES = ["owner", "assistant"] as const;
export type CourseRoleName = (typeof COURSE_ROLES)[number];

/** What the database knows about one (course, account) pair. */
export interface CourseRoleFacts {
  /** An administrator with Super Powers on (ADR-054): an owner of every course. */
  reachesAll: boolean;
  /** The `course_staff.role` of the caller's seat; null without a seat. */
  seatRole: CourseRoleName | null;
}

/**
 * Super Powers make an owner; otherwise the seat's own role, and null for a
 * caller without a seat (who never got past `staffAccess` in the first place).
 * An admin WITHOUT Super Powers resolves like any teacher.
 */
export function effectiveCourseRole(facts: CourseRoleFacts): CourseRoleName | null {
  if (facts.reachesAll) return "owner";
  return facts.seatRole;
}

const RANK: Record<CourseRoleName, number> = { assistant: 0, owner: 1 };

/** An `owner` does everything an `assistant` does. */
export function courseRoleAllows(held: CourseRoleName | null, needed: CourseRoleName): boolean {
  return held !== null && RANK[held] >= RANK[needed];
}

/** A change to one seat: removed, or set to a role. */
export type StaffChange = "remove" | CourseRoleName;

/**
 * Why a change to a seat must be refused, or null when it may go ahead:
 * a course keeps at least one owner, so the last owner can be neither
 * removed nor made an assistant. `owners` counts the course's owner seats
 * as they stand before the change; `targetRole` is the seat's current role.
 */
export function staffChangeRefusal(input: {
  owners: number;
  targetRole: CourseRoleName;
  next: StaffChange;
}): "last_owner" | null {
  const losesOwner = input.targetRole === "owner" && input.next !== "owner";
  return losesOwner && input.owners <= 1 ? "last_owner" : null;
}

/**
 * The role deleting an evaluation needs (ADR-068 §3, amended 2026-10-10):
 * an owner's as soon as something of it has reached the students or holds
 * their work — its results released, its correction published, or one
 * attempt of a student seat (a staff rehearsal, ADR-018, is not one). A poll
 * holds votes, never grades: its attempts do not count, only its release.
 * Anything else stays every member's.
 */
export function evaluationDeletionRole(facts: {
  mode: EvaluationModeName;
  released: boolean;
  correctionPublished: boolean;
  studentAttempts: number;
}): CourseRoleName {
  if (facts.released || facts.correctionPublished) return "owner";
  return facts.mode !== "poll" && facts.studentAttempts > 0 ? "owner" : "assistant";
}

/**
 * The role a grading write on an evaluation needs (ADR-068 §3, amended
 * 2026-10-10): once its results are released, a correction changes a
 * published grade (F-GRADE-09), which is the owner's as the release is. A
 * correction published while an exercise runs (ADR-050) is no release: its
 * answers are still graded by every member.
 */
export function evaluationGradingRole(facts: { released: boolean }): CourseRoleName {
  return facts.released ? "owner" : "assistant";
}
