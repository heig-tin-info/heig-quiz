# ADR-017 — Moving a question to another pool

## Status

Accepted (2026-09-22, asked for by the product owner).

## Context

`F-POOL-04` gives a question one way out of its pool: a COPY, which is a new
question that points back at its origin. There is no way to say "this question
was filed in the wrong pool". The product owner asked for one, in these terms:
drag a question onto a pool in the sidebar to move it there, warn when a
classroom already plays it, and offer the same thing to a multi-selection from
the bulk bar.

A move is not a copy followed by a delete. `evaluation_items` freezes a
`question_version_id` (F-EVAL-03), and `DELETE /questions/:id` refuses outright
while any evaluation points at a published version (`409 in_use`,
`isQuestionInUse`). Copy-then-delete would therefore either be impossible for
exactly the questions worth moving, or would leave two questions behind, one of
them a ghost that no list shows and every past evaluation resolves.

Three things about a question are per-POOL and not per-question, and a move has
to answer for each of them:

- the **internal name** is unique per pool, case-insensitively
  (`questions_pool_name_uq`);
- the **category** belongs to a pool, so the source pool's category is
  meaningless in the target;
- the **tag vocabulary** (`pool_tags`, the one-line descriptions a teacher
  writes) is per pool, while the tags themselves (`question_tags`) are the
  question's.

And one thing is per COURSE: `course_pools` is the second way a pool is
reachable (`poolAccess`, ADR-013) and the set the evaluation builder draws
from. Moving a question out of a pool a course draws from, into one it does
not, leaves that course's staff unable to reach the question again — to put it
in the next evaluation, to re-freeze an item on a newer version — while the
items already frozen on it go on resolving perfectly.

## Decision

1. **The question keeps its id.** `POST /app/api/questions/move` updates
   `questions.pool_id` and `questions.category_id` and nothing else: the
   versions, the draft, the history and the `origin_question_id` provenance
   travel untouched. Every evaluation item stays valid, and a move made by
   mistake is undone by moving back.

2. **One route, a list of ids.** `MoveBody` is
   `{ questionIds[], targetPoolId, categoryId?, linkCourses? }`. The
   drag-and-drop sends a list of one; the bulk bar sends the selection. Two
   routes would be two places to keep the conflict rules in.

3. **Rights are the two halves of the operation**: `contributor` on EVERY
   source pool (what it takes to remove a question from one) and `contributor`
   on the target (what it takes to create one there). A target pool the caller
   cannot reach is a `404` indistinguishable from a missing pool (invariant 6);
   a pool they can see but may not write to is a `403`, like every other pool
   write (ADR-013).

4. **A name clash refuses the batch** — `409 name_taken`, naming the offending
   internal names. `copyQuestion` invents a free name (`… (copy)`) because a
   copy is a new object with no name of its own to defend; a move carries the
   name a teacher typed, which is what they search the palette for, and
   renaming it silently would be the move losing the thing being moved. The
   check runs before the transaction, covers the batch against itself (two
   pools can both hold a `ptr-01`), and nothing moves when it fires.

5. **Tags travel, the vocabulary is taught, the source keeps its
   documentation.** `question_tags` rows are the question's and are not
   touched. The target pool's `pool_tags` learns the tags with an empty
   description, exactly as `copyQuestion` already does. The source pool's
   `pool_tags` rows are LEFT: a teacher's sentence explaining what "pointeurs"
   means in that pool documents the pool, not the question that left, and
   deleting it on the way out would destroy writing nobody asked to destroy.

6. **Assets stay with the source pool.** `assets.pool_id` is not rewritten. An
   asset is addressed by id and served by the asset route, which authorizes
   through the attempt or through a pool the caller reaches; moving the rows
   would be a second, silent write into a pool the caller is only borrowing a
   question from.

7. **A classroom that plays the question is a refusal, not a warning.** When an
   evaluation item is frozen on a version of one of the questions, and the
   TARGET pool is not linked to that evaluation's course, the move is refused
   with `409 pool_not_linked` listing the courses and their classrooms. The
   client turns that into a confirmation ("This question is used in
   classroom «…» — add the pool to its course?") and RETRIES with
   `linkCourses: true`; the server then inserts the `course_pools` rows in the
   same transaction as the move. "Linking the pool" means exactly one thing:
   a row in `course_pools`, the same row `PUT /courses/:id/pools` writes.

8. **`linkCourses` never widens the caller's reach.** A course the caller has
   no staff seat on (`staffAccess`) is answered `409 course_forbidden`, naming
   it, and nothing is linked. Otherwise a teacher could attach their pool to a
   colleague's course — and, through `poolAccess`, hand that colleague's whole
   staff a seat in it — by moving one question.

9. **Audit**: one `question.move` entry per question (`fromPoolId`, `toPoolId`,
   `categoryId`, `internalName`) and one `course.pools_update` per course the
   move linked, with `reason: "question.move"`. No new action for the link: it
   is the same fact the course screen writes, and the reader of the log should
   not have to know two names for it.

## Consequences

- `poolChanged` fires for the source pool AND the target, so both open lists
  refresh; the linked courses get their `courses` hint too.
- The 409 is a THIRD answer on a question write, next to `in_use` and
  `validation`. It carries a machine `error` and a human `message`, so the SPA
  branches on the first and can show the second verbatim when it has no
  translation for a case.
- A move inside the SAME pool is legal and simply re-files the question under
  a category — which is what the bulk bar's existing "Move to a category"
  already does through `PATCH /questions/:id`. The two coexist: the patch is
  the cheap path when the pool does not change.
- The sidebar becomes a drop target, so it now lists pools the caller may
  WRITE to, not only the one being read. That is a navigation change, decided
  in the same commit and documented in `Shell.tsx`.

## What this ADR does NOT decide

`docs/spec/06-questions-ouvertes.md` is untouched. In particular, nothing here
settles the canonical export/import of a pool (F-POOL-07): a move is an
in-database relocation and says nothing about what an archive should contain
when the same question has lived in two pools. The `origin_question_id` chain
still only records copies, and a move leaves no trace of where the question
used to live other than the audit log — deliberately: a question that has moved
IS a question of its new pool, and a permanent "came from" field would turn
every filing mistake into history.

## Rejected alternatives

1. **Copy then soft-delete the original.** Impossible for the questions that
   matter (`409 in_use` refuses the delete), and it would break the identity an
   evaluation item depends on. It also doubles the pool's row count for a
   filing operation.
2. **Renaming on a clash, like `copyQuestion`.** Cheap to write, but it loses
   the name the teacher searches by, and for a twenty-question batch it would
   rename silently in the middle of a drag.
3. **A warning instead of a refusal on `pool_not_linked`.** The client would
   own the rule, and a CLI or a second front end would move questions out of a
   course's reach with no prompt at all. The server refuses; the client asks.
4. **Linking the pool automatically, with no question asked.** It grants the
   course's whole staff a seat in the pool (ADR-013). That is a sharing
   decision, and sharing decisions are made on purpose.
5. **Moving the assets and the `pool_tags` descriptions along.** It would make
   a move write into a pool the caller may only be a contributor of, to delete
   documentation they did not write.
