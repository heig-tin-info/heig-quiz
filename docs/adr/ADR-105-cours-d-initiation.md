# ADR-105 — The training course: one per teacher, four missions on real screens, a progress card derived from the data

## Status

Proposed (2026-10-11, issue #776). The product owner's answers to the open points
of the last section settle it; delivery progress lives in `docs/merge/PROGRESS.md` and `changes/`.

Scope: how a new teacher learns the platform by using it — what is provisioned
for them, what content it holds, how their progress is shown — and nothing about
what a student sees.

Relations: builds on [ADR-018](ADR-018-vue-etudiant-reelle.md) (the staff seat and
the student view are the way to the student side; nothing here enrolls anyone
otherwise), [ADR-095](ADR-095-catalogue-des-banques-publiques.md) (the training
content is one public pool, linked `read`), [ADR-080](ADR-080-assistant-enseignant.md)
(the guide chapter is what the assistant reads about it), [ADR-022](ADR-022-jetons-api-et-serveur-mcp.md)
and [ADR-023](ADR-023-serveur-oauth-pour-mcp.md) (the MCP mission), spec 08 §8.2
(the novice path). Adds a requirement F-ORG-17 (docs/spec/02) and open question 58
(docs/spec/06) once accepted. Changes no rule of ADR-018, ADR-034, ADR-068 or ADR-095.

## Context

A teacher signs in for the first time and lands on an empty Courses home that
says "Create a course". The guide (`docs/guide/getting-started.md`) explains
the frame; nothing makes the teacher do the loop the platform exists for — write
a question, launch it, watch the class, grade, release — nor shows them the
student side of it, nor the tools around it (the assistant, MCP). Reading is
not doing.

Two facts shape the answer. First, the teacher's default is the teacher view,
and crossing to the student side is two existing gestures: a staff seat through
**Join as student** on the classroom page, then **Switch to student view**
(ADR-018). The seat is badged, counted in no statistic, and resettable
(`DELETE /evaluations/:id/attempt`). A teacher needs both gestures later to
rehearse their own exams, so the onboarding should teach them, not hide them.
Second, a public pool linked `read` (ADR-095 §4) makes a course's staff readers
of a colleague's questions without letting them edit, and its statistics keep
growing: one central copy of the training content, never a copy per teacher.

Constraints: invariant 2 (one primary action per screen), invariant 4 (the
training questions reach the teacher's student view through `toStudent` like
any other), invariant 6 (the course is an ordinary course reached through
`staffAccess`), the seed rule of `CLAUDE.md` (content installed through the
ordinary services, never raw inserts), N-I18N-01 (UI strings in both
languages), and issue #722 (a roster line admits a sign-in, so fake students
are not a training material).

## Decision

### 1. One training course per teacher, provisioned by one action

The empty state of the Courses home offers **Start with the training course**
beside **New course** (a second button of the empty state, the page's one
primary action staying **New course**; open point 2 may move it). The action
calls `POST /training` (the `org` module), a portal session of a teacher or an
admin, never a student, an API token or a delegated session. It creates, with
the ordinary services:

- a course of kind `training` (`courses.kind`, enum `regular | training`,
  default `regular`), named and coded by the service (name in the request's UI
  language, code `INIT-<n>`, unique) with the caller as its only owner;
- one classroom, the current period, drill enabled (F-DRILL-04), no roster;
- the caller's staff seat in it, through the same service as Join as student;
- a private empty pool "My first questions" owned by the caller, linked `edit`;
- a `read` link to the public training pool (§2);
- the two evaluations of §3, from the content definitions, in the states §3 names.

Idempotent: a caller who already owns a training course gets its id back and
nothing is created (`200`, the existing course). An assistant (ADR-068) is a
teacher here and gets their own. A `training` course is an ordinary course
everywhere else: `staffAccess`, F-ORG-12, deletion by its owner (F-ORG-09),
which is how "Restart the training" works (delete, then provision again).

### 2. The content: one public pool, shipped in the repository

The training content is ONE public pool owned by the platform (open point 1
names the account), installed and updated from a folder of the repository in
the YAML of the export format (spec 08 §8.3): the questions, and the two
evaluation definitions (an ordered list of question keys, the settings of §3).
An admin action, **Install or update the training content** on the
administration page, runs the ordinary import: a changed question publishes a
new version; the evaluations already instantiated keep their frozen versions
and show "Update" (F-EVAL-03), so nothing moves under a teacher's feet.
Teachers are readers of the pool: they cannot edit it, and its statistics
accumulate across every training course. The pool is listed in the catalogue
like any public pool and reached by `find_similar_questions` (ADR-095 §1);
its statements are about the platform, so it collides with no course's
content. Content is French (open point 5).

### 3. Four missions, each on a real screen, none examined

The teacher is never graded. The missions are the text of a guide chapter,
*The training course* (`docs/guide/`), and of the training classroom's help
topic; the card of §4 links to them. The word "quiz" names what the teacher
takes as a student; "mission" names what they do as a teacher.

1. **Be a student** — "The welcome quiz": an exercise, Scheduled and open,
   free navigation, immediate correction, retakes allowed (ADR-025), drill
   on. One question per type (open point 4). A statement teaches a gesture
   of the platform and its answer stays general-public, discoverable on the
   screen around it (where the student-view switch is; the shortcut of the
   palette; "a question reaches a student only once it is ___"); a code
   question is a hello world with the trial button; a circuit question lights
   an LED. The explanation, visible under the exercise's feedback policy,
   says what the teacher would configure to obtain that behaviour. The
   hand-in makes drill cards appear (F-DRILL-01). The seat exists already, so
   the mission is one click: **Switch to student view**.
2. **Run a class** — "The live quiz", a draft in Live mode: the three screens
   and the start checklist with the waiting-room preview (F-EVAL-23); the
   teacher opens the room, opens a second tab in the student view (the mode is
   per tab, ADR-018), starts, answers, closes; grades the one free-text
   question (with the LLM proposal when the gateway is configured, ADR-063);
   releases; checks the released grade in the student view.
3. **Make it yours** — in "My first questions": create a question with the
   wand (ADR-059), try it, publish it. Save the welcome quiz as a template
   (F-EVAL-24), instantiate it, add the question, then edit the question to
   meet the "newer version" badge (F-EVAL-03). Preview it (stateless), use
   **Join as student** by hand this time on the instantiated quiz, take it,
   reset one's own attempt.
4. **The tools around** — ask the assistant "how do I give a student extra
   time?" and let it open the roster (ADR-080 §10); create a personal token,
   connect Claude through MCP (ADR-022, ADR-023), create a question from there
   and find it in the pool. Journal, projects and groups are links to the
   guide, not missions.

Out of the training: no roster (the only seat is the teacher's), no SEB or
kiosk rehearsal (ADR-027, ADR-051), no impersonation (ADR-034), no GitHub
project (an organisation is needed, ADR-100).

### 4. A progress card derived from the data, never stored

The training classroom's page carries, above Activities, a card of the four
missions. Each line is a predicate on existing tables, computed by
`GET /training` and never stored: a handed-in staff attempt on the welcome
quiz; results released on the live quiz; a published question in the
caller's private pool; a template in the course; a personal token or an OAuth
client of the caller; an assistant conversation of the caller. The card's one
accent is the next undone mission, which opens the screen where it happens;
while a mission remains, the card holds the page's primary action and the
classroom's own actions step one tier down (invariant 2; the training
classroom has no student, so nothing of a run competes). All done: the card
says so and links the guide; nothing else changes. A classroom of a `regular`
course never shows it.

### 5. Where else it is offered

A teacher whose home is not empty (invited on a colleague's course) finds
**Training course** in the account menu and in the palette's Help group
(open point 2); it provisions or opens the same course.

## Consequences

- Benefits: the first success in two minutes, on the real screens; the two
  gestures to the student side are learned where they will be needed; the
  content is maintained once, and its statistics show which statement
  confuses teachers.
- Costs: a migration (`courses.kind`), a provisioning service and its DB
  test, the import action, two contracts (`POST /training`, `GET /training`),
  the card, a guide chapter and a help topic, the content itself. The admin's
  course list gains one course per teacher; a filter on kind may follow.
- Risks: the training pool's grading of the free-text question consumes the
  shared LLM cap (ADR-058 §5), one small call per teacher; the nightly review
  (ADR-060) reviews the training questions like any other, which is wanted.
- Nothing here touches a student: no student payload changes, no seat is
  created for anyone but the caller.

## Alternatives considered

- **One shared training classroom for every teacher.** Rejected: attempts and
  edits of one teacher would land in another's screen, and the course's staff
  would be every teacher of the instance.
- **A course template instantiated per teacher.** Rejected: templates belong
  to a course (F-EVAL-19), so the content would need a course of its own to
  live in; the YAML folder is already the expert format, and the import
  service exists.
- **A copy of the questions per teacher.** Rejected: copies diverge, their
  statistics restart, and an improved statement never reaches a teacher
  already started (ADR-095 context).
- **Stored progress (a checklist table).** Rejected: every line is a fact the
  tables already hold; a stored flag would drift from them and need its own
  writes, audit and reset.
- **A guided tour overlay (tooltips in sequence).** Rejected: it teaches the
  chrome, not the loop; it breaks on every layout change; and the platform's
  per-screen help already names each control.
- **Automatic provisioning at first sign-in.** Rejected: a teacher invited as
  an assistant arrives with a course already; an unasked course on everyone's
  home is noise, and the empty state is the moment the need is felt.

## Open points for the product owner

1. The owner of the public training pool: the super admin's account, or a
   platform account of its own (which then appears as a pool owner in the
   catalogue).
2. Where the action lives for a teacher whose home is not empty: the account
   menu, the palette, both; and whether the empty state's primary action
   becomes the training course rather than New course.
3. The topic of the questions: statements about the platform (proposed) or a
   neutral general-public subject.
4. One question per type, the heavy ones included (circuit, diagram, blocks,
   math), or the four cards of the novice path (08 §8.2) plus one example
   under "More".
5. French content only, with the English UI showing French questions.
