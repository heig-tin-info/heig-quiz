# ADR-013 — Pool sharing: three roles, one resolution order, succession by seniority

## Status

Accepted (2026-09-21, phase 2). Settles F-POOL-05, F-POOL-06 and open question 9 of
`docs/spec/06-questions-ouvertes.md`.

## Context

Until now a question pool was reached by its owner and by the teaching staff of the courses
it is linked to (`course_pools`), with no permission matrix: whoever reached a pool could
write in it. `pool_members` existed in the schema, documented as "phase 2: no route writes
it, `poolAccess` does not read it".

F-POOL-05 asks for named sharing with three roles, F-POOL-06 for a public pool readable by
every teacher. Two facts shape the design:

- **an account is never deleted.** A teacher loses the role when their grant is revoked
  (`admin.ts`) or when their last course seat goes (`modules/org/`, formerly
  `courses.ts` until PR #57 of 2026-09-23); both recompute
  `users.role` through `roles.ts`. There is no delete route to hook a succession into;
- **the existing access rule is a LOADER, not a check** (invariant 6): an entity is loaded
  if and only if a SQL predicate holds, and a caller who fails it gets a 404. Adding roles
  must not turn that into a check performed after the fact.

## Decision

1. **Three roles, one vocabulary** — `reader`, `contributor`, `owner`
   (`pool_members.role`, migrated from `viewer`/`editor`). `reader` reads; `contributor`
   also writes questions, categories, tags and assets; `owner` also manages the members, the
   name, the icon, the visibility and the deletion.

2. **Two predicates, two answers.** `poolAccess` (SQL, in `guards.ts`) says who SEES a pool:
   its owner, a named member, every teacher when `visibility = 'public'`, and the staff of a
   linked course. Failing it is a **404**, as before — the existence of someone else's
   private pool never leaks. `poolRoleOf` says what the caller may DO, and failing THAT is a
   **403**: they already know the pool exists, and the SPA must be able to tell "gone" from
   "read-only".

3. **One resolution order, as a pure rule.** `effectivePoolRole` lives in `@quiz/domain`
   (invariant 8) because it is resolved twice against the database — per pool in
   `guards.poolRoleOf`, in bulk in `pool/service.listPools`. From the strongest claim to the
   weakest: admin / `pools.owner_id` / member-owner → `owner`; then the member role; then
   `contributor` for the staff of a linked course; then `reader` for a public pool; floor:
   `reader`. **An explicit seat wins over the course-staff rule** — naming a colleague
   `reader` has to mean something — and the course staff keeps `contributor`, which is what
   it could already do before this ADR.

4. **Visibility follows the members.** Inviting into a `private` pool sets it to `shared` in
   the same transaction: the visibility is a consequence of the roster, never a second thing
   to remember. `public` is a deliberate act of the owner (open question 9: a public pool is
   READABLE by every teacher, and writable by its owner and its members — not reserved to
   the admin, who is an owner everywhere anyway).

5. **Succession by seniority, hooked on the role recomputation.** When an account stops
   being `teacher`/`admin`, each pool it owns passes to its FIRST member by `created_at`,
   then the next; that member becomes `pools.owner_id` and their (now redundant) member row
   is deleted. The hook is `storeRole` in `roles.ts` — the ONE place a computed role is
   stored — and not `admin.ts`, because a revoked grant is only one of the two ways the role
   falls. A pool with no member keeps its owner: it stays reachable through its courses, and
   nothing is ever orphaned to nobody. One transaction per pool, idempotent, audited as
   `pool.transfer` with `actorType: "system"`.

6. **A notification is a ROW, plus a hint.** `notifications` (`user_id`, `payload` jsonb,
   `read_at`) is written by one function, `notify`, which also publishes a `notifications`
   hint on `user:<id>`. The stream carries no data (ADR-005) and the client re-reads its own
   inbox over HTTP. Two kinds so far: `pool_shared` and `pool_ownership`.

## Consequences

- The pool list answers `role`, `ownerName`, `memberCount` and `icon` in ONE query per
  request: the same pure rule is applied to facts gathered by correlated subqueries.
- A member's own topic (`user:<id>`) is what carries a roster change, because `pool:<id>` is
  computed when an SSE connection opens — the colleague who has just been named is precisely
  the one not listening to it yet.
- A pool survives the departure of its owner without an administrator being involved, and
  the inheriting teacher learns about it from a notification that survives a reload.
- The 403 is a new answer on pool routes. It is only ever returned to a caller who already
  passed `poolAccess`, so no 404 became a 403.

## Rejected alternatives

1. **The strongest of the member role and the course-staff rule** (a `max`): it never
   demotes anyone, but it makes an explicit `reader` seat a lie — the members screen would
   show `reader` while the colleague keeps writing.
2. **Succession to the administrator**: simple, but it makes an operator the owner of other
   people's teaching material and it breaks the "one person operates the instance" premise.
   The members are the people who were already working in the pool.
3. **A succession hooked on a `DELETE /admin/teachers/:gid` route**: it only covers the
   revoked grant, and it would miss the teacher who simply lost their last course seat.
4. **Notifications carried as SSE data frames**: a reload would lose them, and a data frame
   would have to be filtered per audience. A row plus a content-free hint keeps ADR-005
   intact and makes the inbox readable with the ordinary session.
5. **A permission column per action** (`can_publish`, `can_delete`, …): the spec asks for
   three roles, and a matrix nobody can recite is how an access rule ends up being checked
   in twenty places instead of loaded in one.
