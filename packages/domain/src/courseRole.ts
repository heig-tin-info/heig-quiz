/**
 * The role of an account on a course's staff (ADR-068) — a pure rule
 * (invariant 8). `staffAccess` decides who REACHES a course (a seat, or Super
 * Powers); this decides what a member may DO there, and the last-owner rule
 * every change of the staff obeys.
 *
 * The union is spelled out here rather than imported from `@quiz/contracts`
 * (the domain depends on nothing but `@quiz/core`); it is structurally the
 * same type as `CourseRole` there, so the two assign to each other.
 */
export type CourseRoleName = "owner" | "assistant";

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
