# ADR-013 — Pool sharing: three roles, one resolution order, succession by seniority

## Status

Accepted (2026-09-21, phase 2). Settles F-POOL-05, F-POOL-06 and open question 9 of
`docs/spec/06-questions-ouvertes.md`.

**Amended 2026-09-30 by ADR-054:** "admin" in the resolution order of §3 (and "an owner
everywhere" in §4) now reads "an admin with Super Powers on". Without them an admin resolves
like any teacher; the pure rule's fact is `reachesAll`, formerly `isAdmin`.

**Amended 2026-10-04 (product owner), scope: what the pool list SHOWS** — decision 7 below.
Access to pools and the resolution order of §3 are unchanged; §7 also records the widening
of who may fetch an owner's uploaded avatar, which follows from it.

**Amended 2026-10-08 by [ADR-081](ADR-081-vocabulaire-de-notions.md#third-addendum-2026-10-08-the-cut-over),
scope: the wording of §1.** Since the cut-over from tags to concepts, a `contributor` writes
the question's concepts, not tags; the vocabulary itself is the instance's, not the pool's
(ADR-081, addendum §5, for who creates and edits a concept).

**Amended 2026-10-10 (product owner, issue #680 lot 1), scope: §1 (what the owner decides) and
§4 (visibility).** Only publication is stored and decided: `pools.is_public`. What a pool is
SHOWN as is derived from the roster (decision 8 below). The owner also writes a pool's
description (decision 9). Access (§2), the resolution order (§3) and the succession (§5) are
unchanged; `poolAccess` reads `is_public` where it read `visibility = 'public'`.

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
   also writes questions, categories, the question's concepts (tags before the ADR-081
   cut-over) and assets; `owner` also manages the members, the
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

   **A demoted member loses their seat, for good** (product decision, 2026-09-29). When a
   deliberate action — a revoked grant, the last course seat removed — demotes an account to
   student, the same hook, right after the succession, deletes every `pool_members` row it
   holds (`vacateSeats`); both run before the role is stored, so a failure leaves the account
   unchanged and a later deliberate sync runs them again. A revoked grant whose follow-up failed is
   not retried by itself, and a login never vacates; such a case waits for an admin (accepted: a
   single transaction cannot hold the notifications the succession sends). A later promotion gives nothing back: a colleague invites them again. A login
   that computes `student` keeps the seat, for the reason it never transfers — what the IdP
   releases varies — but the seat opens nothing: `poolAccess` also requires the stored role to
   be staff, and the pool audience and the succession skip non-staff accounts. There is no
   data migration: seats kept from demotions before this decision are not swept, since a
   stored `student` cannot tell a deliberate demotion from a login that did not release the
   staff affiliation.

6. **A notification is a ROW, plus a hint.** `notifications` (`user_id`, `payload` jsonb,
   `read_at`) is written by one function, `notify`, which also publishes a `notifications`
   hint on `user:<id>`. The stream carries no data (ADR-005) and the client re-reads its own
   inbox over HTTP. Two kinds so far: `pool_shared` and `pool_ownership`.

7. **What the pool list shows** *(amendment, 2026-10-04, decided by the product owner)*.
   - **Used.** `usedCount` is the number of DISTINCT live questions of the pool (every
     version together, soft-deleted ones left out, so it never exceeds `questionCount`) frozen
     in an item of an `exam` or an `exercise` that has at least one STARTED attempt of a
     student account — no guest, no staff walk (`isStaffAttempt`, ADR-018). A poll never
     counts. It is a historical fact: the `stats_since` reset of ADR-038 does not apply.
     It is counted through `questions.pool_id`, so a moved question carries its history.
     Any role that can list the pool sees it: an aggregate, never who sat what.
   - **Owner.** Every row shows its owner as an avatar alone (`PersonAvatar`, the name as
     its label), the reader's own pool included, in the accent tone. The list carries the
     owner's names and picture URL (`ownerGivenName`, `ownerFamilyName`, `ownerAvatarUrl`).
     The cards keep their attribution line.
   - **My role, always.** The column is never empty. "Owner" there means only
     `pools.owner_id` or an `owner` seat: the list shows `heldRole`, resolved by
     `heldPoolRole` — §3 with Super Powers set aside. An admin with Super Powers who is
     neither sees the role they would hold without them, while `role`, the effective one,
     still gates what the screen offers.

   *Consequence introduced by the implementation, not a product-owner decision:* for the
   owner's uploaded picture to load rather than fall back to initials, `seesUser`
   (`guards.ts`) now lets a teacher fetch the uploaded picture of the owner of any pool they
   reach through `poolAccess` — public pools included, so every teacher sees the uploaded
   avatar of a public pool's owner. Students still never do. Reverting that widening would
   leave the avatar as initials for those viewers, nothing more.

8. **Derived visibility** *(amendment, 2026-10-10)*. §4's "visibility follows the members" is
   generalised: `pools.visibility` is replaced by `pools.is_public boolean` (the owner's
   deliberate act, audited `pool.publish` / `pool.unpublish`; a personal pool cannot be
   published). The visibility a pool displays is computed in SQL (so the list can sort on it):
   **public** if `is_public`; else **shared** if the pool has at least one member or a linked
   course whose staff includes someone other than the owner; else **private** (a pool linked only
   to its owner's own course stays private). There is no "make private" action that evicts
   members: a pool becomes private when its people are removed. A public pool is already readable
   by every teacher, so inviting offers `contributor` and `owner` only (`409
   role_covered_by_public` otherwise); `reader` rows that exist stay, so unpublishing never
   silently cuts them. The Sharing section lists the linked courses, read-only, with their effect
   (their staff can edit, rule 3 of §3).
9. **Description** *(amendment, 2026-10-10)*. `pools.description` (at most 280 characters) is
   written by an `owner` of the pool, as the name and the icon are (§1). The model may PROPOSE
   one through the ADR-058 gateway (purpose `describe`; sent: the pool name, its concept labels
   and at most two statement excerpts from the student view, the scope accepted for ADR-081);
   the proposal is stored nowhere and becomes the description only when the owner accepts it
   (`PATCH` with `descriptionFromAi`). `description_source` (`owner` / `ai`) records who wrote
   it, and an AI text is refused over text the owner wrote (`409 description_owned`). Accepting is
   a `pool.update`.

## Consequences

- The pool list answers `role`, `ownerName`, `memberCount` and `icon` in ONE query per
  request: the same pure rule is applied to facts gathered by correlated subqueries.
- A member's own topic (`user:<id>`) is what carries a roster change, because `pool:<id>` is
  computed when an SSE connection opens — the colleague who has just been named is precisely
  the one not listening to it yet.
- A pool survives the departure of its owner without an administrator being involved, and
  the inheriting teacher learns about it from a notification that survives a reload.
- Because rule 3 makes the staff of a linked course `contributor`, linking a pool to a
  course is itself a write on the pool: a NEW link needs the caller's effective role to be
  at least `contributor` (`403 pool_link_forbidden` otherwise). A link already there
  survives a `PUT` that keeps it, and unlinking needs only the course.
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
