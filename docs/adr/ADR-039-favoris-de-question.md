# ADR-039 — Favourite stars on questions: a second per-user preference table

## Status

Accepted (2026-09-29, settled with the product owner; with the table
`question_stars` (migration `0033_question_stars`), the routes
`PUT`/`DELETE /questions/star` and `DELETE /pools/:id/stars` of the `pool`
module, the `starred` flag and filter of `QuestionRow` / `QuestionSearch`,
and F-POOL-10).

## Context

Before a test, a teacher browses a pool — the arrows and the preview pane of
#325 — and picks a handful of candidates. Then they open the evaluation, or
its template, and must find those questions again in the question picker,
among fifty others, by memory. What is missing is a bookmark: mark a
question while browsing, find it at once when building.

Four facts shape the answer:

- the need is PERSONAL, like the hidden course of ADR-032: "the questions I
  am considering". A colleague sharing the pool is preparing another test;
- a pool may be read by people who may not write it: a `reader` member, and
  every teacher on a public pool (F-POOL-05, F-POOL-06). They build
  evaluations from it too;
- a question moves between pools (ADR-017) and keeps its id, so everything
  frozen on it resolves; a copy is a new question;
- ADR-032 already created a per-user display table, `user_course_prefs`,
  and said it was "the home of any later per-user course preference".

## Decision

1. **A table of its own, `question_stars(user_id, question_id, starred_at)`**,
   composite primary key, both foreign keys `ON DELETE CASCADE`, an index on
   `question_id` for the cascade. It is owned by the `pool` module. A row IS
   the star: unstarring deletes it.

   It is not `user_course_prefs`, because a star is about a QUESTION and
   that table is keyed on a course: a question belongs to no course, a pool
   feeds several, and a teacher stars in pools no course of theirs draws
   from. Widening `user_course_prefs` to "any entity" would trade two clear
   primary keys for a polymorphic one that no foreign key can check.

2. **Keyed on the question, not the pool.** "The favourites of this pool" is
   a join on `questions.pool_id`, never a stored pool id. So a question MOVED
   to another pool keeps its star, and a COPY — a new question — starts
   without one. A soft-deleted question's row stays; every reader (the
   `starred` flag, the `starred=1` filter, the clear and its count) hides it,
   so it comes back only with its question. A hard delete takes it along.

3. **Any role that sees the pool may star.** Every route loads the questions
   under `poolAccess` (invariant 6): a batch with one id the caller cannot
   reach is the 404 of a missing entity, and nothing is written. No pool role
   is asked for: a star changes nothing any other user can observe, so a
   reader and anyone on a public pool may star. The routes answer for the
   caller alone — `PUT`/`DELETE /questions/star` with `{ questionIds }`
   (1 to 200, the `MoveBody` bound), idempotent, 204; `DELETE
   /pools/:id/stars` clears the caller's stars on the live questions of that
   pool and returns how many went.

4. **Read with the list.** `GET /pools/:id/questions` computes `starred` for
   the caller by a left join on the primary key — one row at most per
   question, so the page, its order and its keyset cursor are unchanged — and
   `?starred=1` narrows the same query to the caller's favourites. The MCP
   `list_questions` goes through that route and therefore carries the flag;
   no MCP tool writes stars.

5. **No audit event, no refresh hint.** As in ADR-032: the audit log records
   what happened to the platform's data, and a star changes what one person
   sees. Nobody else is shown it, so nobody else needs a hint.

6. **The picker's scope is the shown pool.** The question picker
   (`AddQuestionsSheet`, evaluations and templates alike) shows one pool at a
   time; its "Favourites" section lists the caller's stars of THAT pool,
   loaded apart (`starred=1`, one page of 200), above the ordinary list, and
   steps aside while a search or a filter is set. "Add favourites" adds, in
   one `POST .../items`, those that are published, have a key, and are not
   already in the list, and reports the others by reason. It then OFFERS to
   unstar the questions it added; it never does so on its own, since a
   teacher may reuse the same shortlist for a make-up test.

## Consequences

- `QuestionRow` gains a field that depends on WHO asks, like
  `CourseSummary.hidden`. A cached list is per user already (the session
  cookie), so nothing is shared wrongly.
- The web client writes a star optimistically into every cached page of the
  pool and rolls back on a failure; only the small favourites query is
  refetched. A per-star invalidation would reload every page the teacher
  scrolled through.
- Deleting a user or a question takes its stars with it.

### Rollback

Drop the routes, the flag and the filter; the table can stay empty or be
dropped with a migration. Nothing else reads it.

## Alternatives considered

1. **A column in `user_course_prefs`, or a generic `user_prefs(entity,
   id)`.** Rejected in point 1: the wrong key, or no foreign key at all.
2. **Keyed on `(user, pool, question)`.** A move would strand the star in
   the old pool, or need the move to rewrite another table. The join costs
   nothing on a primary key.
3. **A shared, pool-wide "shortlist".** One colleague's shortlist would be
   everyone's, and a reader could not have one: exactly what the need is not.
4. **Excluding favourites from the picker's main list.** A second filter on
   every page, and a total that stops matching the pool's; showing a
   question in both places is the smaller surprise.
