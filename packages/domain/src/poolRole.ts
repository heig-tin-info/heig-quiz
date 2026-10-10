/**
 * The effective role of an account in a question pool (F-POOL-05, F-POOL-06,
 * ADR-013) — a pure rule (invariant 8), because it is resolved TWICE against
 * the database: row by row for one pool (`guards.poolRoleOf`) and in bulk for
 * the pool list (`pool/service.listPools`). One definition, one order, one
 * unit test; the two call sites only differ in how they load the facts.
 */
export const POOL_ROLES = ["reader", "contributor", "owner"] as const;
export type PoolRoleName = (typeof POOL_ROLES)[number];

export const POOL_DESCRIPTION_SOURCES = ["owner", "ai"] as const;
export type PoolDescriptionSource = (typeof POOL_DESCRIPTION_SOURCES)[number];

/** The longest pool description, in characters (ADR-013, amendment of 2026-10-10). */
export const POOL_DESCRIPTION_MAX = 280;

/** Who reads a pool beyond its members: nobody, its courses' staff, every teacher. DERIVED from the roster and `pools.is_public`, never stored. */
export const POOL_VISIBILITIES = ["private", "shared", "public"] as const;

/**
 * How a course draws from a pool (`course_pools.mode`, ADR-095): `edit` makes
 * the course staff contributors of it, `read` leaves them readers. A `read`
 * link is only made to a public pool.
 */
export const COURSE_POOL_MODES = ["edit", "read"] as const;
export type CoursePoolMode = (typeof COURSE_POOL_MODES)[number];

/** The stronger of two link modes: `edit` wins over `read`. */
export function strongerLinkMode(a: CoursePoolMode, b: CoursePoolMode): CoursePoolMode {
  return a === "edit" || b === "edit" ? "edit" : "read";
}

/** What the database knows about one (pool, account) pair. */
export interface PoolRoleFacts {
  /**
   * The caller reaches everyone's content: an administrator with Super
   * Powers on (ADR-054). Such a caller is an owner of every pool; an admin
   * WITHOUT them resolves like any teacher.
   */
  reachesAll: boolean;
  /** The account is `pools.owner_id`. */
  isOwner: boolean;
  /** The `pool_members` row, when there is one. */
  memberRole: PoolRoleName | null;
  /** On the staff of a course the pool is linked to for editing (`course_pools.mode = 'edit'`); a `read` link gives nothing here. */
  isCourseStaff: boolean;
  /** `pools.is_public` — readable by every teacher. */
  isPublic: boolean;
}

/**
 * Resolved from the strongest claim to the weakest:
 *
 *   1. `owner` — an admin with Super Powers (ADR-054), `pools.owner_id`, or a member row saying `owner`;
 *   2. the member role, as the owner of the pool set it. An explicit seat
 *      WINS over the course-staff rule below: naming a colleague `reader`
 *      has to mean something;
 *   3. `contributor` — the staff of a course the pool is linked to for editing. They can
 *      write in it today and must not be demoted by this rule landing;
 *   4. `reader` — a public pool, and the floor of the function: never more
 *      than the caller can prove.
 *
 * The caller has already been let in by `poolAccess`; this says what they may
 * DO, never whether they may see the pool.
 */
export function effectivePoolRole(facts: PoolRoleFacts): PoolRoleName {
  return facts.reachesAll ? "owner" : heldPoolRole(facts);
}

/**
 * The role an account holds in a pool IN ITS OWN RIGHT: claims 1 to 4 above
 * with Super Powers set aside. It is what the pool list SHOWS as "My role"
 * (ADR-013, amendment of 2026-10-04): "Owner" there means the account owns the
 * pool or holds an `owner` seat, never that an admin switched Super Powers
 * on. What the caller may DO is still {@link effectivePoolRole}.
 */
export function heldPoolRole(facts: Omit<PoolRoleFacts, "reachesAll">): PoolRoleName {
  if (facts.isOwner || facts.memberRole === "owner") return "owner";
  if (facts.memberRole) return facts.memberRole;
  if (facts.isCourseStaff) return "contributor";
  return "reader";
}

const RANK: Record<PoolRoleName, number> = { reader: 0, contributor: 1, owner: 2 };

/** An `owner` does everything a `contributor` does, and so on down. */
export function poolRoleAllows(held: PoolRoleName, needed: PoolRoleName): boolean {
  return RANK[held] >= RANK[needed];
}
