# ADR-032 — Per-user display state lives in `user_course_prefs`

## Status

Accepted (2026-09-27, issue #155, settled with the product owner; with the
table `user_course_prefs` (migration `0019_user_course_prefs`), the routes
`POST /courses/:id/hide` and `POST /courses/:id/unhide` of the `org` module,
the `hidden` flag of `CourseSummary`, F-ORG-11 and 06 no. 26).

## Context

A teacher keeps every course they ever taught: a course is persistent from
one year to the next (01, "Course"), and deleting one deletes its classrooms,
its evaluations and its results (F-ORG-09). After a few years the course list,
the sidebar's course tree (#154) and the command palette are full of courses
the teacher no longer teaches, and nothing lets them tidy that up.

Three facts shape the answer:

- the need is PERSONAL: "the courses I no longer teach". A colleague on the
  same staff may still teach it;
- staff rights are flat (docs/spec/07, 7.3): whatever one member can do to the
  course, every member can. A course-wide archive would let any one colleague
  take the course out of everyone's sight;
- an admin reaches every course without holding a seat on its staff
  (`accessWhere` in `guards.ts`). A column on `course_staff` would leave the
  admin nothing to hide with — and the admin is the user with the longest
  list.

## Decision

1. **A table of its own, `user_course_prefs(user_id, course_id, hidden_at)`**,
   composite primary key, both foreign keys `ON DELETE CASCADE`. It is owned by
   the `org` module and holds one user's DISPLAY state for one course — never a
   right, never a state of the course. A row whose `hidden_at` is null is a
   visible course: the row is the home of any later per-user course preference
   (a favourite, an order), so unhiding clears the column rather than deleting
   the row.

2. **Hiding is a course route like the others.** `POST /courses/:id/hide` and
   `/unhide` load the course under `staffAccess` (invariant 6) — so an admin
   may hide too, and a caller off the staff gets the 404 of a missing course —
   and answer 204. They take no body, so the only input is the `IdParam` of
   `@quiz/contracts`.

3. **Navigation only.** `GET /courses` still returns every course the caller
   reaches, each with a `hidden` flag computed for the caller. The SPA leaves
   hidden courses out of its navigation — the course list (until "Show
   hidden"), the sidebar's course tree (except the course being read) and the
   command palette — and nowhere else: the pickers read the same list and keep
   offering them, and so does the MCP `list_courses`, because an assistant that
   cannot see a course creates it a second time. Every page of a hidden course
   stays readable.

4. **No audit event.** The audit log records what happened to the platform's
   data; a hide changes what one person's screen shows and nothing else.

5. **"Hidden", not "archived".** "Archived" is a state of a classroom, seen by
   the whole staff, which also closes its join code. Using the same word for a
   personal hide would promise the teacher an effect on their colleagues that
   does not exist. The course list therefore says "Show hidden", and the
   classrooms of a course keep "Show archived".

## Consequences

- The course summary gains a field that depends on WHO asks. It is computed
  by a left join in `listCourses`, with no second query.
- The flat "Classrooms" section of the sidebar still lists the live classrooms
  of a hidden course: that section is the "right now" list and is being
  filtered by period in #156, which is the filter that answers "a past year".
- A global archive can still be added later, on `courses`, without touching
  this table: the two would answer different questions.
- Deleting a user or a course takes its preference rows with it.

### Rollback

Drop the routes and the flag; the table can stay empty or be dropped with a
migration. Nothing else reads it.

## Alternatives considered

1. **`course_staff.hidden_at`.** One column instead of a table, but an admin
   has no row there, and the preference would vanish with the seat.
2. **A global archive on `courses`.** One colleague would hide the course
   from all, and it would tempt a cascade (join codes, running evaluations)
   that can break a live exam.
3. **Filtering hidden courses on the server** (`GET /courses?hidden=…`). Two
   readings of one list, and the pickers, the MCP and the "Show hidden" toggle
   would each need to ask for the right one; one list with a flag is read once
   and filtered where the navigation is drawn.
