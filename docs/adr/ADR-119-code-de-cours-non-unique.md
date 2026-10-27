# ADR-119 — A course's code is a free label, no longer unique on the platform

## Status

Accepted (2026-10-26, decision of the product owner).

Scope: the `code` of a course (`courses.code`, F-ORG-12) and every place that
created, edited or looked up a course by it.

Relations: amends [ADR-105](ADR-105-cours-d-initiation.md) §1 (the training
course's code).

## Context

A course's `code` is the school's abbreviation (`PRG1`). It carried a
platform-wide unique constraint (`courses_code_unique`): a create or an edit
that reused another course's code was refused with `409 duplicate_code`, and
the client asked for a more specific code ("PRG1-IL").

The uniqueness served nothing functional. URLs and every reference use the
course's UUID; the code is only shown — the breadcrumb, the sidebar's course
tree, the student cards ("PRG1 · Prog-A"), the sort order. It did, however,
put two teachers of the same school course, or of two schools sharing an
abbreviation, in collision: the second had to deform the official
abbreviation to create their course.

## Decision

1. The code is a free display label, like the course's name: two courses may
   share one. The database keeps it required (`notNull`) and drops the unique
   constraint; no create or edit is refused for it.
2. The code identifies nothing: a course is always referenced by its UUID.
   A reader sees the code next to the course's name (in the sidebar's tree,
   the name as the tooltip), or next to a classroom's name; two courses that
   share a code are told apart by what stands beside it.
3. The training course (ADR-105 §1) is coded `INIT` for every teacher; the
   search for the smallest free `INIT-<n>` is gone.
4. The heig-classroom importer still names a destination course by its code;
   a code that matches no course or more than one is refused for that row,
   as an ambiguous classroom name already is.

## Consequences

- A migration drops `courses_code_unique`.
- `duplicate_code` is removed from the API and from the client's error
  dictionary, with its message (`courses.codeTaken`); the code's hint no
  longer says it is unique.
- The development seed upserts its demo course on a fixed id instead of on
  the code, and stays idempotent. A database seeded before this change gets
  a second demo course on its next seed.
- The course list is ordered by code, then name, then id, so two courses
  sharing a code keep a stable order; a drill session groups its cards by the
  course's id, never its code.
- The MCP `create_course` tool still asks the model to check `list_courses`
  first, by name and code, so it does not create a course twice.

## Alternatives considered

- **Unique per school or per staff member.** There is no school entity, and
  the collision is exactly between colleagues; it would move the problem
  without solving it.
- **Keep the constraint and suggest a suffix.** It is what existed: it made
  teachers deform an official abbreviation for no functional gain.
