# ADR-068 — Course staff roles: owner and assistant

## Status

Accepted (2026-10-04, product owner decisions of 2026-10-02 and 2026-10-04).

Amended 2026-10-09 (product owner, [ADR-079](ADR-079-conditions-de-l-evaluation.md)
§5): §3 only — the writes to a course's catalog of conditions (F-ORG-16) join
the owner-only routes; reading it stays every member's.

Scope: what a member of a course's staff may do on the course, its classrooms and
its evaluations; who reaches them is unchanged (`staffAccess`, invariant 6).

Relations: amends F-ORG-12 (`docs/spec/02-exigences-fonctionnelles.md`), the
"Roles" rule of the reuse record (`docs/spec/history/reuse-heig-classroom.md`
§7.3) and decision D04 (c) of the merge (`docs/merge/08-decisions.md`); follows
the reach-then-role shape of [ADR-013](ADR-013-partage-des-pools.md); admins
under [ADR-054](ADR-054-super-powers-admin.md). Settled question 51
(`docs/spec/history/settled-questions.md`).

## Context

Until now every seat of a course's staff held every right on the course
(`docs/spec/history/reuse-heig-classroom.md` §7.3; D04): a seat was the access predicate `staffAccess`, and nothing
else. heig-classroom's "assistant" label was dropped at the merge (D04 (c)).

The merge widened the staff from a classroom to the whole course (D04 (a)), and
heig-classroom's assistants arrive with it. A teaching assistant then could remove the
teacher from the staff, delete the course or one of its classrooms, unlink its pools or
release a grade. The product owner asked for two roles, and for the line between them.

The pools already solved the same shape (ADR-013): a predicate that says who SEES an
entity (404 when it fails, invariant 6), and a role that says what the caller may DO
(403 when it fails, since they already know the entity exists).

## Decision

1. **Two roles on a seat** — `course_staff.role`, `owner` or `assistant`
   (`CourseRole` in `@quiz/contracts`). An owner runs the course; an assistant does the
   day-to-day work in every classroom of it.

2. **Reach, then role.** `staffAccess` is unchanged and still defines reach: any seat,
   whatever its role, loads the course, its classrooms, evaluations, gradings… and anyone
   else gets the 404 of a missing entity. The role is a second step, `requireCourseRole`
   in `guards.ts`, whose refusal is **`403 owner_required`**. It runs inside the route's
   loader (`withCourseRole`, the twin of the pools' `withRole`), after the 404 and before
   the body is parsed: an assistant's malformed body is the same 403 as a well-formed one.
   The pure rules are `effectiveCourseRole`, `courseRoleAllows` and `staffChangeRefusal`
   in `@quiz/domain` (`courseRole.ts`).

3. **What only an owner may do:**

   | Route | Why |
   | --- | --- |
   | `POST /courses/:id/staff`, `PATCH /courses/:id/staff/:uid`, `DELETE /courses/:id/staff/:uid` (another's seat) | who is on the staff, and with which role |
   | `PATCH /courses/:id`, `DELETE /courses/:id` | the course's name, code and existence |
   | `PUT /courses/:id/pools` | which pools the course draws from |
   | `POST /questions/move` with `linkCourses` | the move links its target pool to the courses that play the questions: only to courses the caller owns. An assistant's course blocks it like a course out of reach (`409 course_forbidden`), but is named in full since they reach it; each blocking course's `mayLink` says which, and the web app offers no linking when one is false |
   | `POST /courses/:id/classrooms`, `DELETE /classrooms/:id` | the course's classrooms |
   | `POST /evaluations/:id/release`, `/unrelease`, `/publish-correction`; `POST /projects/:id/release` (F-PROJ-14) | what reaches the students as final |
   | `POST /courses/:id/conditions`, `PATCH /courses/:id/conditions/:cid`, `PUT /courses/:id/conditions/order`, `POST /courses/:id/conditions/:cid/archive\|unarchive` (amended 2026-10-09) | the course's catalog of conditions, a course setting (F-ORG-16, ADR-079 §5); its list stays every member's |

   Everything else stays open to every member: hiding the course for oneself, templates,
   a classroom's settings (rename, archive, GitHub, journal, drill), the roster, the
   evaluations and their settings, grading, validating, regrading, reopening.

4. **The accepted loophole.** An assistant may set an evaluation's feedback policy to
   `immediate`, which shows students their results without a release. Closing it would
   mean splitting the evaluation settings by role for a case the product owner judged
   rare and visible (the setting is audited). It is accepted and documented, not closed.

5. **A course keeps at least one owner.** Removing or demoting the last owner is
   **`409 last_owner`**, which replaces `last_staff` (the last seat is necessarily an
   owner, so the old rule is subsumed). The count and the write run in one transaction
   that reads the course's seats `FOR UPDATE`: two owners demoting each other at the same
   instant cannot both pass the count, the second waits for the first and counts again.
   Only owners change roles; an owner may demote or remove themselves unless they are the
   last owner.

6. **Leaving.** Any member may remove their OWN seat (`DELETE /courses/:id/staff/:uid`
   with their own id): the loader skips the role step for that one case, still before the
   body, and the last-owner rule still holds.

7. **A second seat is refused.** `POST /courses/:id/staff` for an account already on the
   staff is **`409 already_staff`** (it used to be a silent no-op); a role changes by the
   PATCH, never by adding the person again. A new seat is an `assistant` unless the
   request says `owner` — a default of the contract (`StaffAdd`), not of the database:
   the weaker role is the one a slip of the hand can give. `createCourse` seats its
   creator as owner explicitly. Audit: `course.staff_add` carries the role,
   `course.staff_remove` the role the seat had, and the new `course.staff_role_change`
   carries `{ userId, from, to }`.

8. **Administrators.** Under Super Powers (reach `all`, ADR-054) an admin is an owner of
   every course, seat or none; without them an admin resolves like any teacher — by their
   seat's role, and the 404 without one.

9. **The payloads say the role, once.** Each staff member carries `role`, and each
   `CourseSummary` of `GET /courses` the caller's `myRole` — a list that holds every
   course the caller reaches, hidden ones and, under Super Powers, every course. The web
   app decides "is an owner" in one place, `useIsCourseOwner(courseId)` over that list
   (`courseRoleAllows`), and hides what only an owner may do instead of drawing buttons
   that can only fail (header actions on Classrooms, Linked pools and Members; Edit and
   Delete in the course settings, with one line saying why; the unlink; a classroom's
   Delete; Release, Unrelease and Publish the correction). A classroom's detail names its
   course already; `EvaluationDetail` carries its `courseId`, because a classroom's course
   cannot be found in the list once the classroom is archived (the list's classrooms are
   the live ones). The server refuses anyway.

10. **Migration.** `course_staff.role text NOT NULL DEFAULT 'owner'` (migration
    `0062_course_staff_role`): every seat that existed becomes an owner, so nobody loses a
    right they had. The import from heig-classroom (`scripts/import-classroom`) maps a
    classroom's owner and its `teacher` seats to `owner`, its `assistant` seats to
    `assistant`, and never demotes: an account that owns one classroom of the course owns
    the course, and a seat Quiz already held keeps its role unless the import makes it an
    owner.

11. **Duplicating a classroom (F-ORG-10)** is not built yet. It creates a classroom in the
    course, so it must use the owner scope like `POST /courses/:id/classrooms`.

## Consequences

- Invariant 6 keeps its one predicate for reach; `CLAUDE.md` says that what a member may
  DO is the second step, a 403, as for pools.
- The MCP tools call the HTTP routes, so they inherit the rule; `create_classroom` and
  `link_pool_to_course` say they are owner-only, and `list_courses` returns `myRole`.
- A per-classroom restriction of staff (D04's noted risk) remains a possible later
  refinement; the roles do not address it.

## Alternatives considered

- **A permission matrix per action.** Rejected: two roles cover what was asked, and the
  pools' precedent shows one ordered role is enough to reason about.
- **Refusing with a 404.** Rejected: the assistant legitimately sees the course; a 404
  would leave the screens unable to tell "gone" from "not yours to change" (ADR-013 §2).
- **Database default `assistant`.** Rejected: the migration would have demoted every
  existing member, including every course's creator.
