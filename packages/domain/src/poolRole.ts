/**
 * The effective role of an account in a question pool (F-POOL-05, F-POOL-06,
 * ADR-013) — a pure rule (invariant 8), because it is resolved TWICE against
 * the database: row by row for one pool (`guards.poolRoleOf`) and in bulk for
 * the pool list (`pool/service.listPools`). One definition, one order, one
 * unit test; the two call sites only differ in how they load the facts.
 *
 * The union is spelled out here rather than imported from `@quiz/contracts`
 * (the domain depends on nothing but `@quiz/core`); it is structurally the
 * same type as `PoolRole` there, so the two assign to each other.
 */
export type PoolRoleName = "reader" | "contributor" | "owner";

/** What the database knows about one (pool, account) pair. */
export interface PoolRoleFacts {
  /** A platform administrator reaches every pool as an owner. */
  isAdmin: boolean;
  /** The account is `pools.owner_id`. */
  isOwner: boolean;
  /** The `pool_members` row, when there is one. */
  memberRole: PoolRoleName | null;
  /** On the staff of a course the pool is linked to (`course_pools`). */
  isCourseStaff: boolean;
  /** `pools.visibility = 'public'` — readable by every teacher. */
  isPublic: boolean;
}

/**
 * Resolved from the strongest claim to the weakest:
 *
 *   1. `owner` — an admin, `pools.owner_id`, or a member row saying `owner`;
 *   2. the member role, as the owner of the pool set it. An explicit seat
 *      WINS over the course-staff rule below: naming a colleague `reader`
 *      has to mean something;
 *   3. `contributor` — the staff of a course the pool is linked to. They can
 *      write in it today and must not be demoted by this rule landing;
 *   4. `reader` — a public pool, and the floor of the function: never more
 *      than the caller can prove.
 *
 * The caller has already been let in by `poolAccess`; this says what they may
 * DO, never whether they may see the pool.
 */
export function effectivePoolRole(facts: PoolRoleFacts): PoolRoleName {
  if (facts.isAdmin || facts.isOwner || facts.memberRole === "owner") return "owner";
  if (facts.memberRole) return facts.memberRole;
  if (facts.isCourseStaff) return "contributor";
  return "reader";
}

const RANK: Record<PoolRoleName, number> = { reader: 0, contributor: 1, owner: 2 };

/** An `owner` does everything a `contributor` does, and so on down. */
export function poolRoleAllows(held: PoolRoleName, needed: PoolRoleName): boolean {
  return RANK[held] >= RANK[needed];
}
