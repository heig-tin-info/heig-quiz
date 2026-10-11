# ADR-105 — The training course: one per teacher, four missions on real screens, a progress card derived from the data

## Status

Accepted (2026-10-11, issue #776: the product owner approved the proposal in session
and left its open points to the implementation; the values taken are the
**Assumptions** section, each marked as such until he confirms or changes it). The
spec challenge of the same day corrected three claims of the first draft (no YAML
import exists; a staff attempt earns no drill card and no statistic; a seat is per
classroom). Delivery progress lives in `docs/merge/PROGRESS.md` and `changes/`.

Scope: how a new teacher learns the platform by using it — what is provisioned for
them, what content it holds, how their progress is shown — and nothing about what a
student sees.

Relations: builds on [ADR-018](ADR-018-vue-etudiant-reelle.md) (the staff seat and
the student view are the way to the student side; a staff attempt counts nowhere),
[ADR-095](ADR-095-catalogue-des-banques-publiques.md) (the training content is one
public pool, linked `read`), [ADR-013](ADR-013-partage-des-pools.md) §5 (a pool with
no member keeps its owner), [ADR-080](ADR-080-assistant-enseignant.md) (the guide
chapter is what the assistant reads; a palette command with an effect is never run
by it, §10), [ADR-022](ADR-022-jetons-api-et-serveur-mcp.md) and
[ADR-023](ADR-023-serveur-oauth-pour-mcp.md) (the MCP mission),
[ADR-087](ADR-087-nouveautes-de-la-plateforme.md) §9 (What's new and the coach
marks come first on a first visit), spec 08 §8.2 (the novice path). Adds F-ORG-17
(docs/spec/02) and settles open question 58 (docs/spec/06). Amends `apps/web/DESIGN.md`
("Empty state: one action") for the Courses home only: a text link may follow the
one action. Changes no rule of ADR-018, ADR-025, ADR-034, ADR-041, ADR-068 or ADR-095.

## Context

A teacher signs in for the first time and lands on an empty Courses home that says
"Create a course". The guide (`docs/guide/getting-started.md`) explains the frame;
nothing makes the teacher do the loop the platform exists for — write a question,
launch it, watch the class, grade, release — nor shows them the student side of it,
nor the tools around it (the assistant, MCP). Reading is not doing.

Three facts shape the answer. First, the teacher's default is the teacher view, and
crossing to the student side is two existing gestures: a staff seat through **Join
as student** on the classroom page, then **Switch to student view** (ADR-018). The
seat is badged, counted in no statistic, resettable (`DELETE
/evaluations/:id/attempt`), and it earns neither drill cards nor question statistics
(`drill/lifecycle.ts`, `stats/service.ts`). A teacher needs both gestures later to
rehearse their own exams, so the onboarding must make them do both, not do them for
them. Second, a public pool linked `read` (ADR-095 §4) makes a course's staff readers
of a colleague's questions without letting them edit: one central copy of the
training content, never a copy per teacher. Third, there is no import or export of
questions today: `canonical` is planned, not present (spec 05, `CLAUDE.md`); spec 08
§8.3's "YAML export and import" describes that plan. The training content therefore
ships as code, installed through the ordinary services, as `apps/api/src/seed/` does.

Constraints: invariant 2 (one primary action per screen; the classroom page's is per
tab, F-ORG-13, and `New ▾` on Activities), invariant 4 (the training questions reach
the teacher's student view through `toStudent` like any other), invariant 6 (the
course is an ordinary course reached through `staffAccess`), invariant 9 (new audit
actions), the seed rule of `CLAUDE.md` (never raw inserts), N-I18N-01 (UI strings in
both languages), `DESIGN.md` (an empty state has one action; coach marks play on a
screen's first visit), issue #722 (a roster line admits a sign-in, so fake students
are not a training material).

## Decision

### 1. One training course per teacher, provisioned by one action

`POST /app/api/training` (module `training`; a portal session of a teacher or an
admin, never a student, an API token or a delegated session) creates, with the
ordinary services of `org`:

- a course whose `training_for` column names the caller (`courses.training_for`,
  nullable, references `users`, **unique**: the constraint is the idempotence, as
  `pools_personal_uq` is for the personal pool; a second call returns the existing
  course, `created: false`). The course is named and coded by the service — name in
  the request's UI language, code `INIT-<n>` free at creation; both editable later as
  any course's, the column alone marks it. The caller is its only owner;
- one classroom, the current period (its `periodEnd` the end of the current
  semester), no roster, no seat;
- a `read` link to the public training pool (§2);
- the two evaluations of §3, from the content definitions, in the states §3 names.

Nothing else: no seat (mission 1 is the seat), no private pool (mission 3 is a
pool). Refused `409 training_not_installed` while the content is not installed.
Audited `training.provision`. A training course is an ordinary course everywhere
else: `staffAccess`, F-ORG-12, its deletion by its owner (F-ORG-09), which is how
"Restart the training" works (delete, then provision again; a pool the teacher made in
mission 3 is theirs and stays). An assistant (ADR-068) is a teacher here and gets
their own. An admin's course list under Super Powers shows every training course like
any course (Assumption 4).

### 2. The content: one public pool, shipped as code, installed by an admin task

The training content is ONE public pool, owned by the super admin's account
(Assumption 1), marked `pools.is_training` (a partial unique index: one per
instance; the install finds it by that mark, never by name). The questions and the
two evaluation definitions are a TypeScript content module,
`apps/api/src/modules/training/content.ts`, typed by `content-types.ts` and modelled on
`seed/content.ts`: French statements, a stable `internalName` per question, a config
validated by the type's schema at publish, no concept (ADR-081's vocabulary is the
courses', not the platform's). It is installed by the admin task
`training.install` (the task registry of the administration page, `POST
/app/api/admin/tasks/:key/run`): a missing question is created and published; a
question whose config or explanation differs from its latest published version gets a
new published version; an unchanged one is left alone. Evaluations already
instantiated keep their frozen versions and show "Update" (F-EVAL-03), so nothing
moves under a teacher's feet. Audited `training.install`. Teachers are readers of the
pool; it is listed in the catalogue like any public pool, under its owner's real name
(ADR-095 §6), and reached by `find_similar_questions`; its statements are about the
platform, so they collide with no course's content. This module gives way to
`canonical` when that package lands; the content does not change, its carrier does.

### 3. Four missions, each on a real screen, none examined

The teacher is never graded: a staff attempt counts nowhere (ADR-018), neither in a
statistic nor in the drill, and the record promises neither. The missions are the
text of a guide chapter, *The training course* (`docs/guide/training.md`), and of the
training classroom's help topic; the card of §4 links them. "Quiz" names what the
teacher takes as a student; "mission" names what they do as a teacher.

1. **Be a student** — "The welcome quiz" (« Le quiz d'accueil »): an exercise,
   Scheduled, open from the provisioning until the end of the classroom's period
   (the ticker closes it then, F-EVAL-04; a restart provisions a fresh one), free
   navigation, immediate correction, retakes allowed (ADR-025, which a staff seat
   gets like a student). One question per automatically graded type present on
   `main`: `mcq`, `short`, `cloze`, `categorize`, `math`, `circuit`, `code`. A
   statement teaches a gesture of the platform and its answer is discoverable on
   the screen around it; it points at the gesture, never at its wording, so a key
   is never a UI label (Assumption 5). The explanation, visible under the
   exercise's feedback policy, says what the teacher would configure to obtain
   that behaviour. Two clicks before it: **Join as student** on the classroom page
   (the coach anchor `classroom.join` already points at it), then **Switch to
   student view**.
2. **Run a class** — "The live quiz" (« Le quiz en direct »), a draft in Live mode:
   the three screens and the start checklist with the waiting-room preview
   (F-EVAL-23); the teacher opens the room, opens a second tab in the student view
   (the mode is per tab, ADR-018), starts, answers, closes; grades the `rich`
   question and the `diagram` question by hand (with the LLM proposal when the
   gateway is configured, ADR-063); releases; reads the released grade in the
   student view (the staff feedback page shows it through the live tally,
   `releasedGradesOf`; pinned by a DB test).
3. **Make it yours** — **New pool** on the pools page, **Link a pool** on the
   training course's page (F-ORG-12), then in that pool: create a question with the
   wand (ADR-059), try it, publish it. Save the welcome quiz as a template
   (F-EVAL-24), instantiate it, add the question, edit the question to meet the
   "newer version" badge (F-EVAL-03), preview it (stateless), take it from the seat
   of mission 1, reset one's own attempt.
4. **The tools around** — ask the assistant "how do I give a student extra time?"
   and let it open the roster (ADR-080 §10); create a personal token or connect
   Claude through MCP (ADR-022, ADR-023), create a question from there and find it
   in the pool. Journal, projects and groups are links to the guide, not missions.

Out of the training: no roster (the only seat is the teacher's), no SEB or kiosk
rehearsal (ADR-027, ADR-051), no impersonation (ADR-034), no GitHub project (an
organisation is needed, ADR-100), no poll type (`brainstorm` is a poll's), no blocks
until that type merges (a content update then adds it).

### 4. A progress card derived from the data, never stored

`GET /app/api/training` returns whether the content is installed, the caller's
training course (id, classroom id, and the id of the live quiz of mission 2 — the
classroom's oldest evaluation in Live mode, resolved by the server so the card never
matches a title the teacher may rename, null once deleted) or null, and the state
of each mission —
`todo`, `done` or `unavailable` — computed from existing tables and never stored:

| Mission | `done` when | `unavailable` when |
|---|---|---|
| 1 | a handed-in staff attempt of the caller on an exercise of the course | never |
| 2 | a released evaluation of the course | never |
| 3 | a published question in a pool linked `edit` to the course AND a template in the course | never |
| 4 | an `api_tokens` or `oauth_grants` row of the caller, ever (revoked rows are kept), OR an assistant conversation of the caller (purged after 30 days, ADR-080 §6: the mission then reads `todo` again, which is harmless) | the LLM gateway is off AND OAuth has no client |

Mission 4 is optional: "all done" is missions 1 to 3. The card shows on the training
classroom's **Activities** tab only, to the teacher the course was provisioned for
(`training_for`), above the activities. Its one accent is the next `todo` mission,
and it leads to the screen or the control where the mission happens — it never
performs the gesture (ADR-018: the switch stays secondary chrome, and doing it from
the card would not teach where it is). While a `todo` mission remains, `New ▾` is
secondary on that tab; the other tabs keep their own primary action (F-ORG-13). All
done: the card says so and links the guide. The coach tour of the classroom plays as
on any first visit, after What's new (ADR-087 §9); the card is content, not chrome,
and competes with neither.

### 5. Where it is offered

The empty state of the Courses home keeps its one action, **New course**, and gains
a text line under it: "First time here? Start with the training course"
(Assumption 2; `DESIGN.md` amended for this screen). A teacher whose home is not
empty (invited on a colleague's course) finds **Training course** in the account
menu and in the palette's Help group; it is a global palette command, which the
assistant is never offered (it reads the mounted screen's commands only, ADR-080
§10). Each provisions or opens the same course. Neither is shown while the content is
not installed. "All done" and the demotion of `New ▾` follow one pure rule shared by
the card and the page, so the two can never disagree; when mission 1 is next and the
teacher already holds a seat, the card shows a hint in words and `New ▾` keeps its
accent.

## Assumptions (the product owner's open points, values taken on 2026-10-11)

1. **The public training pool is owned by the super admin's account**
   (`SUPER_ADMIN_EMAIL`). Nothing forbids it (ADR-013 §5, ADR-054); if that address
   changes, the pool stays with the old account and the new admin edits it under
   Super Powers. Alternative left open: a platform account of its own.
2. **The empty state gains a text link, not a second button**; the account menu and
   the palette carry the entry elsewhere.
3. **Statements are about the platform**, not a neutral subject.
4. **The admin's course list shows every training course** like any course. If they
   pile up, a filter off by default may follow; it is not built now.
5. **French content only**, with the English UI showing French statements; no key is
   a UI label, so the language of the interface changes nothing to the answer.
6. The welcome quiz holds the automatically graded types only; `rich` and `diagram`
   are graded by hand in the live quiz; blocks joins by a content update.

## Consequences

- Benefits: the first success in two gestures and one click, on the real screens;
  the two gestures to the student side are learned where they will be needed; the
  content is maintained once and reaches every training course.
- Costs: a migration (`courses.training_for`, `pools.is_training`), the `training`
  module (provision, status, install task) and its DB tests, two contracts, two
  audit actions, the card and the two entries, a guide chapter and a help topic, the
  content itself, a `DESIGN.md` amendment.
- Risks: the live quiz's hand grading consumes the shared LLM cap (ADR-058 §5) when
  the teacher asks for a proposal, one small call per teacher; the nightly review
  (ADR-060) reviews the training questions like any other, which is wanted. A
  teacher who deletes the super admin's pool cannot: only its owner can.
- Nothing here touches a student: no student payload changes, no seat is created for
  anyone.

## Alternatives considered

- **One shared training classroom for every teacher.** Rejected: attempts and edits
  of one teacher would land in another's screen, and the course's staff would be
  every teacher of the instance.
- **A course template instantiated per teacher.** Rejected: templates belong to a
  course (F-EVAL-19), so the content would need a course of its own to live in.
- **A YAML folder installed by an import.** Rejected for now: no import exists, and
  `canonical` is planned after `ui-kit` (`CLAUDE.md`); building it here would jump
  that order. The content module is the same data in code.
- **A copy of the questions per teacher.** Rejected: copies diverge, and an improved
  statement never reaches a teacher already started (ADR-095 context).
- **A seat and a private pool at provisioning.** Rejected after the spec challenge:
  a seat is per classroom and the button disappears once it exists, so a
  provisioned seat removes the very gesture to teach; a private pool survives the
  course's deletion and piles up at each restart, while creating and linking a pool
  is a gesture worth teaching.
- **A `courses.kind` enum.** Rejected: it marks a course but names no teacher, so it
  gives neither idempotence nor "whose card is this"; `training_for` does both.
- **Stored progress (a checklist table).** Rejected: every line is a fact the tables
  already hold; a stored flag would drift from them and need its own writes, audit
  and reset.
- **A guided tour overlay.** Rejected as the vehicle: the coach marks already play a
  tour per screen and teach the chrome; the missions teach the loop.
- **Automatic provisioning at first sign-in.** Rejected: a teacher invited as an
  assistant arrives with a course already; an unasked course on everyone's home is
  noise, and the empty state is the moment the need is felt.
