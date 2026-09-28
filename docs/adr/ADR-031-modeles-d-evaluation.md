# ADR-031 — Evaluation templates at course level

## Status

Accepted (2026-09-27, issue #151, decisions settled with the product owner on
the issue). Delivered in several pull requests: this ADR and the spec first,
then the smallest usable slice (migration `0019_evaluation_templates`, *Save
as template*, the course's list with delete, *Instantiate*), then editing a
template in place, then pulling a revision into an instance. The promote
screen is deferred (06 no. 25). The rest of the delivery was re-split on
2026-09-28: see the addendum at the end.

## Context

A course is taught year after year (glossary: "persistent from one year to
the next"), but everything an evaluation is — its questions, their points and
order, its milestones, its settings, its grade scale, its feedback policy —
lives in ONE classroom (F-EVAL-01). Next autumn's class of the same course
starts from the evaluation of last autumn by F-EVAL-14's *Duplicate*, which
copies whatever that one run became: its dates, its access code, its IP
list, and any change made in a hurry for one room. There is no place where
"the exam of PRG1" is kept as such, and deleting last year's classroom
deletes it (F-ORG-09).

Issue #151 asks for that place: an evaluation kept at the course level, from
which each classroom's evaluation is made.

Three facts of the current schema shape the answer:

- the configuration of an evaluation is already grouped — `settings`,
  `grading_scale`, `feedback_policy`, `mcq_policy`, `duration_s` on the row,
  the frozen question versions, points, order and milestones in
  `evaluation_items` — and every rule on it (`configLock`, the feedback and
  retake rules, negative marking) is written once, against that row;
- since the ADR-014 addendum of 2026-09-27, `classroom_id IS NULL` already
  means something: an anonymous poll, owned by `created_by`
  (`evaluations_home_ck`, `ownedPollAccess`). A template stored "without a
  classroom" would be read as a poll by every site that tests that null, and
  managed by its creator alone — a 404 for the rest of the course's staff,
  which breaks invariant 6;
- `evaluation_items.question_version_id` has no `ON DELETE` action, so a
  pool whose versions an evaluation pins cannot be deleted today: the delete
  fails on the foreign key and the teacher reads a 500.

## Decision

### 1. A template is a row of `evaluations`; there is no second table

A new column `evaluations.course_id` (FK `courses`, `ON DELETE CASCADE`) is
set on a template and on nothing else. Its presence is what makes a row a
template: there is no `kind` column to keep in step with it.

- **Exactly one home.** `evaluations_home_ck` becomes: a classroom
  (`classroom_id` set, `course_id` null), OR a course — a template
  (`course_id` set, `classroom_id` null), OR an owner — an anonymous poll
  (both null, `mode = 'poll'`, `created_by` set).
- **A template carries nothing of a run**, and the database says so:
  `evaluations_template_ck` requires, when `course_id` is set,
  `opens_at`, `closes_at` and `access_code` null, `ip_allowlist` empty,
  `state = 'draft'`, `mode <> 'poll'`, `revision` set and
  `origin_template_id` null. A template that carries a date, a code or an IP
  cannot be written by any path.
- **Revision and origin.** `revision` (integer, on a template, 1 at
  creation); `origin_template_id` (self FK, `ON DELETE SET NULL`) and
  `origin_revision` on an instance — the template it was made from, and at
  which revision.
- **One helper for "owned poll".** Every site that reads
  `classroom_id IS NULL` as "an anonymous poll" goes through ONE predicate —
  `classroom_id is null and course_id is null and mode = 'poll'` — in SQL
  and its row twin in TypeScript: `ownedPollAccess` and
  `findManagedEvaluation` (`guards.ts`), `staffOf` (`grading/events.ts`),
  `homeTopic` (`realtime/bus.ts`), the poll views (`poll/*`). The helpers
  that only mean "no roster" (`seatsOf`, `enrolledCounts`) stay correct as
  they are: a template has no roster either. The partial index
  `evaluations_owned_poll_idx` gets the same predicate.
- **Access.** A loader `loadTemplate` finds a template through `staffAccess`
  on its course, the one predicate of invariant 6: every member of the
  course's staff manages the course's templates, and anyone else gets the
  404 of a template that does not exist. `loadEvaluation` keeps its inner
  join on `classrooms`, so no generic evaluation route (items, settings,
  dashboard, grading, results, the MCP tools built on them) ever sees a
  template.
- **A separate contract.** `EvaluationTemplate` in `@quiz/contracts` is the
  template's own shape, with `courseId` and `revision`; `Evaluation.classroomId`
  stays non-null.

### 2. Kinds: `exam` and `exercise`, never `poll`

A poll is created and started in one call (ADR-014) and has nothing to keep.
*Save as template* on a poll answers `422 template_poll`; the CHECK above
refuses it underneath.

### 3. What a template holds

Everything except `opens_at`, `closes_at`, `access_code` and
`ip_allowlist`: the items (frozen versions, points, order, milestones),
`settings` in full — timing kind, lobby, navigation, presentation, shuffling,
Safe Exam Browser, fullscreen, visibility log, retakes, negative marking —
`grading_scale`, `feedback_policy`, `mcq_policy` and `duration_s`. An
instance whose timing is `deadline` is born without dates, and the existing
`timing_incomplete` guard (F-EVAL-04, #76) keeps it closed until the teacher
fills them.

### 4. Revision

`revision` increments on every committed change to the items, their points
or order, or to a template-level setting; a title change does not move it.
There is no explicit "publish revision" step. (The counter exists from the
first slice at 1; editing a template in place, which moves it, is the third
pull request.)

### 5. Deletion

- Deleting a template leaves its instances running; their
  `origin_template_id` becomes null (`origin_revision` stays, as a record).
- Deleting a course cascades to its templates, and the confirmation names
  how many.
- Deleting a classroom never touches a template: a template belongs to the
  course (F-ORG-09 reworded).
- **Deleting a pool is refused** (`409 pool_in_use`) while a template or an
  evaluation pins one of its versions. The refusal names the holders the
  caller can open and only counts the others (`hidden`), so it never leaks
  another course's titles.

### 6. Smaller rules

- At instantiation, a question version marked deprecated warns and does not
  block; a question whose pool is no longer linked to the course blocks
  (`422 template_pool_unlinked`, listing the items), because the instance
  could not have been authored with it either (F-EVAL-01). The same rule and
  the same answer apply to a duplicate (F-EVAL-14): every copy into a
  classroom goes through `copyEvaluation`, which checks the target course.
- An instance is made in a classroom of the SAME course; any other classroom
  is the 404 of a classroom the template does not reach.
- Pulling a newer revision into an instance checks "no attempt" in the same
  transaction as the update (the fourth pull request).
- A template stays `draft` forever (the CHECK), so neither the ticker, nor
  the student home, nor any attempt path ever meets one.
- "Start from a template" appears at evaluation creation only when the
  course has at least one template: the novice path (08) is unchanged.
- Audit: `template.create`, `template.instantiate`, `template.delete` join
  the closed union of `audit.ts` (invariant 9), then `template.update` with
  editing in place (A2).

### 7. Delivery

1. This ADR and the spec (01, 02, 05, 06).
2. The smallest usable slice: migration, `loadTemplate` with a 404 test on
   every route, *Save as template*, the course's list with delete,
   *Instantiate*, the audit events, en/fr strings.
3. Editing a template in place, the revision counter, the "behind template"
   badge, the outdated-question flags.
4. Pulling a template revision into an instance.
5. The promote screen — deferred until a term of use of 2–4 shows what it
   must do.

Items 1 and 2 are merged. Items 3 and 4 were re-split on 2026-09-28 into
A1 (the course page), A2 (creating an empty template and editing one in
place) and B (pulling a revision, with the "behind template" badge); the
addendum below is the current plan. A1 is merged; A2 is done in both
halves: the API (F-EVAL-24, F-EVAL-25: the routes, `TemplatePatch`,
`TemplateDetail`, the revision helper, the lock of *Instantiate*,
`template.update`) and the web (*New template* on the course page, and the
template's editor at `/templates/:id`, built from the evaluation editor's
own blocks handed a template's routes rather than from a copy of them).
B is not started.

## Consequences

- The null of `classroom_id` no longer names one shape. Every site that
  tested it for "poll" now tests the owned-poll predicate: `ownedPollAccess`
  and the second query of `findManagedEvaluation` in `guards.ts`, `staffOf`
  in `grading/events.ts`, `homeTopic` in `realtime/bus.ts`, the `anonymous`
  flag of the poll views and the public loader in `poll/*`. A db test shows
  that a template is reachable through no poll route and by its creator
  through no owned-poll path.
- A course's evaluation outlives its classrooms, and a new classroom starts
  from it in one action with nothing of last year's dates or codes.
- A pool pinned by an evaluation or a template can no longer be deleted; the
  teacher reads why instead of a 500. The old evaluations must go first — or
  the pool stays, which is the point of freezing versions (F-EVAL-03).
- Every existing rule on an evaluation's configuration applies to a template
  unchanged, because it is the same row read by the same code.
- `evaluations` carries four more nullable columns and a second CHECK. The
  migration adds columns and replaces two constraints; no existing row
  changes shape (none has a `course_id`).

### Rollback

The migration adds four nullable columns and replaces one CHECK with two
(and the owned-poll index with a narrower one). It cannot be undone by
dropping the columns alone: the home CHECK of `0018_poll_audience` reads a
row with no classroom as an owned poll, so it refuses to be restored while a
template row exists, and the previous code would read such a row the same
way. A rollback therefore first deletes the templates
(`DELETE FROM evaluations WHERE course_id IS NOT NULL`, their items
cascading), then drops the four columns and restores the constraints and the
index of `0018_poll_audience`. Templates are lost; their instances are
ordinary evaluations and stay.

## Alternatives considered

- **A separate `evaluation_templates` table** (with its own items table).
  Every rule on an evaluation's configuration, every contract and every
  editor screen would have a second copy to keep in step, and instantiating
  would be a translation between two schemas. Rejected.
- **An `evaluation_specs` extraction**: the configuration moved to its own
  table, referenced by both an evaluation and a template. It is the cleanest
  model on paper, and a migration of every evaluation, every query that
  reads `settings` and every item path, for a feature that needs none of
  that to work. Rejected.
- **A `kind` column** (`evaluation` / `template` / `poll`). The home columns
  already say it; a `kind` would be a second source of truth that a row
  written by another path could contradict. Rejected: `course_id` present is
  the kind.
- **Storing a template as `classroom_id IS NULL`** with a flag. Collides with
  the anonymous poll of ADR-014: the template would be owned by its creator
  (404 for the rest of the staff, invariant 6) and read as a poll by every
  site that tests that null. Rejected.
- **An explicit "publish revision" step**, as for question versions. A
  question version is immutable because students answered it; a template is
  never answered — its instances are, and they hold their own copy. A
  draft/published split on the template would add a state and a button to
  guard nothing. Rejected: every committed change is the next revision.
- **Polls as templates.** A poll is created and started in one call and
  lives minutes; its "template" is the question itself, which the pool
  already keeps. Rejected (422).

## Addendum (2026-09-28)

Settled with the product owner after the smallest slice shipped, for the rest
of the work (issue #151). A teacher never discovered templates: a course was
only a card on the Courses home, and the card hid its templates list while it
was empty.

### a. The course page is the one surface for templates

Every course gets a page of its own, `/courses/:id` (F-ORG-12): its
classrooms (the archived ones behind "Show archived"), its linked pools, and
its evaluation templates. Its one primary action is *New classroom*. On that
page the templates section is **always shown**, with an empty state that
names the one door there is today — *Save as template* in an evaluation's
menu. The card on the Courses home no longer lists templates at all: it is a
summary whose title opens the page. This reverses the slice-2 rule "the list
shows nothing while empty", and the novice home (08) stays as it was, since
that list left the card instead of growing an empty block on it.

### b. Delivery, re-split

- **A1** — the course page (web only, no API change).
- **A2** — creating an EMPTY template at course level together with editing
  a template in place: `POST /courses/:id/templates` (a new F-EVAL-24),
  taking a title, a mode (`exam` | `exercise`) and a preset; a `poll` is
  `422 template_poll`; audited as `template.create` without `from`. The two
  ship together because an empty template that cannot be filled is a dead
  end, which is also why A1 has no *New template* button.
- **B** — pulling a template revision into an instance. The "behind
  template" badge ships with it, so the badge arrives with its fix rather
  than as a warning nobody can act on.
- The promote screen stays deferred (06 no. 25).

### c. Editing a template goes through parallel routes

Editing a template uses routes of its own under
`/app/api/templates/:id/...`, loaded by `loadTemplate` only. `loadEvaluation`
keeps its inner join on `classrooms`, so no generic evaluation route —
items, settings, dashboard, grading, preview, results, and the MCP tools
built on them — ever sees a template; the code is shared at the service
level, not by widening a loader. A `TemplatePatch` contract is the
evaluation patch minus `opensAt`, `closesAt`, `accessCode` and
`ipAllowlist`, declared `.strict()` so that an unknown key is refused rather
than stripped: sending a run field is a 400 from the schema, never a silent
no-op nor a 500 from `evaluations_template_ck`. The pools a template may draw from are the
course's linked pools: `coursePoolIds` takes a home — a course, for a
template, or a classroom — and stays the one source of the rule, beside
the one test `inLinkedPool`.

### d. One helper bumps the revision

The revision moves in ONE service helper, called by every template write
inside that write's transaction, as `revision = revision + 1` in SQL (never
read-modify-write). There is exactly one bump per request that changes at
least one stored template-level value (items, points, order, settings); a
title-only request, or one that changes nothing, does not bump. A database
trigger was considered and rejected: it would be the first trigger of the
repository, it puts the logic out of sight of the code that reads it, and it
would need disabling at creation, where the items are written under
revision 1.

### e. Instantiate copies what it records

*Instantiate* reads the revision and the items in one transaction that locks
the template row (`SELECT … FOR UPDATE`), so the `origin_revision` recorded
on the instance is the revision whose content was copied, even while a
colleague edits the template.
