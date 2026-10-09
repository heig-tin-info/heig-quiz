# ADR-079 — The conditions of an evaluation: announced by the teacher, imposed by the platform

## Status

Accepted (2026-10-07, decided by the product owner in conversation on
issue #584, "Manque un laïus sur les conditions de l'évaluation").
Requirement F-EVAL-33. Delivered in three pull requests: the conditions
themselves (this record's §1–§4, §6), the per-course catalog (§5, shipped:
see its as-built note) and the trusted-client gap (§7). Check the code for
what has shipped.

Amended 2026-10-08 (requested by a teacher in #584, decided by the product
owner, 2026-10-08): §6 only — the student reads the conditions
grouped by kind instead of in two blocks (announced, imposed). See the
amendment under §6; the rest of the record is unchanged.

Amended 2026-10-09 (product owner): §5 only — the catalog is a section of
the course's Settings tab, no longer a tab of its own, and only the
course's owners write it; assistants read it. See the amendment under §5.

Amended 2026-10-09 by [ADR-088](ADR-088-journal-d-integrite.md): §2 only —
a poll never shows the journal's line, and the line will name pasting from
outside the page once ADR-088's paste step ships (pending); until then it
names leaving the page only.

Scope: `EvaluationSettings.conditions`, the derivation `imposedConditions`
(`packages/domain/src/evaluationConditions.ts`), the student views that carry
`EvaluationConditions` (waiting room, ready screen, attempt, and for a
trusted client the evaluation card and `/pair`) and the evaluation's settings
editor.

Relations: amends [ADR-076](ADR-076-demarrage-explicite-d-une-tentative.md) §1
(the ready screen's rules become the conditions) and the waiting room's rules
card of F-EVAL-16; generalises [ADR-069](ADR-069-calculatrice-fournie.md) §2
(the platform states only what it enforces); depends on
[ADR-068](ADR-068-roles-de-l-equipe-du-cours.md) §3 for the catalog's writers
(owner-only since the amendment of 2026-10-09).

## Context

Before an exam a student needs to know what they may use: notes, a formula
sheet, a calculator, a phone. The waiting room and the ready screen stated
three fixed rules (navigation, saving, one attempt) plus negative marking and
the calculator, and nothing the teacher could say. Teachers wrote the rest on
the board, or forgot to. Two risks shape the answer: a platform that claims a
prohibition it cannot enforce ("phones forbidden") misleads the student, and
a text that changes after the exam leaves no record of what was announced.

## Decision

1. **Announced conditions are a snapshot.** An evaluation's settings hold a
   list of `{ kind, text, catalogId? }`, `kind` one of `allowed`,
   `forbidden`, `provided`, `info`; at most 20 items, each text 1 to 200
   characters, trimmed. The text is the teacher's own words, never
   translated, and rendered as plain text — never markdown nor HTML. The
   list lives in the existing JSON column (no migration), absent meaning
   none, read through `conditionsOf`, and a patch replaces it whole, like
   the retake rule.
2. **Imposed conditions are derived, never stored, and only state facts the
   platform enforces or records.** One pure function, `imposedConditions`,
   returns keys with their parameters, in a fixed order: a trusted client in
   force (Safe Exam Browser, a school station: other applications are
   unavailable — `forbidden`); the calculator provided (`provided`; `none`
   says nothing, since Quiz forbids no other calculator); the duration with
   the student's extra time, or the closing instant; the number of attempts;
   a navigation that does not go back; negative marking; the journal of
   leaving the page (and of pasting from outside it once ADR-088's paste
   step ships, pending) when `logVisibility` is on; the autosave. The network
   allowlist and the shuffles are left out (not the student's to act on),
   and so is `requireFullscreen` while no player requests full screen or
   records leaving it: a line saying so would be false.
3. **Exams and exercises only.** A poll is refused `422
   conditions_not_allowed` (emptying the list passes) and reads as having
   none, exactly as the calculator (ADR-069).
4. **Frozen like every setting.** The existing `configLock` covers it: no
   writer while the evaluation runs or once an attempt exists. Duplicates,
   templates and classroom duplicates copy settings, so they carry the
   conditions; a template pull (F-EVAL-26) keeps the instance's settings and
   therefore does not bring them, and its confirmation says so.
5. **A per-course catalog.** Frequent conditions are kept in a
   catalog of the course, managed by every staff member (ADR-068 §3), with
   archiving only, never deletion; picking an entry copies its text into the
   evaluation (the snapshot of §1) and records `catalogId`. The editor
   creates one-off conditions too, and preserves a `catalogId` it finds.
   `catalogId` is staff data: no student view carries it.

   *As built (2026-10-07, PR 2 of #584):* the table `course_conditions`
   (`org` module: `kind`, `text` 1..200, `position`, `archived_at`) and the
   routes `/courses/:id/conditions` (list: every entry, the active ones
   first, the client filtering on `archivedAt`; create; `PATCH /:cid`; `PUT /order` with every active id once, else
   `409 stale_order`; `POST /:cid/archive|unarchive`, an unarchived entry
   going last), loaded under `staffAccess` with no role step. Audited as
   `course.condition_create|update|archive|unarchive`; a reorder is not.
   The course page has a Conditions tab ("Add condition" its primary); the
   settings editor of an evaluation or a template lists the active entries
   of its course as checkboxes — ticking appends `{ kind, text, catalogId }`,
   unticking removes the entry with that id — and an entry whose
   `catalogId` is not in the active catalog shows as a one-off condition.
   No student route reads the table (tested on the waiting room, the ready
   screen and the attempt).

   *Amended 2026-10-09 (product owner):* the catalog is a setting of the
   course, not a main content of its page. The Conditions tab is removed;
   the catalog is a section of the course's Settings tab, with its own
   secondary "Add condition" (the Settings tab keeps no primary), and the
   old address `/courses/:id/conditions` opens the Settings tab. Only the
   course's owners write it: every write route (create, `PATCH /:cid`,
   `PUT /order`, `archive`, `unarchive`) takes the owner role (`403
   owner_required` for an assistant, ADR-068 §2); the list stays readable by
   every staff member, since an assistant still ticks its entries in the
   conditions of an evaluation or a template. An assistant sees the active
   entries as plain text, with one line saying they are the owners' to
   change. Supersedes "managed by every staff member" and "with no role
   step" above.
6. **One renderer, two blocks.** *(The two blocks and the per-line word are
   obsolete: see the amendment of 2026-10-08 below.)* The student reads "Announced by your
   teacher" first, in the teacher's order, then "Imposed by the platform", in
   the fixed order. Every line carries its kind as an icon AND a word, never
   a colour alone. The list replaces the rules card of the waiting room and
   of the ready screen (the ready screen omits the time, which the sentence
   by Start states), is reopenable from the player's bar (a quiet button and
   a palette command, never a second floating button: the calculator holds
   the bottom right) and is previewed on the launch step. The settings editor
   shows, under the teacher's list, the imposed lines its settings produce.
   The launch checklist counts the announced conditions on its rules line,
   and never warns about an evaluation without any. There is no "I have
   read" acknowledgment.

   *Amended 2026-10-08 (issue #584):* a student looks for what they may
   bring, not for who said it; a forbidden item split across two blocks was
   missed. The renderer draws **one block per kind, in the order Forbidden,
   Allowed, Provided, Good to know**; a kind without a line draws no block.
   Inside a block, the teacher's announced lines come first, in their order,
   then the platform's imposed lines, in their fixed order (§2). The block's
   heading names the kind, so each line keeps only its icon: the kind is
   still carried by a word, never by a colour, and no colour is used. The
   grouping is one pure function, `conditionsByKind` beside
   `imposedConditions`; a screen that omits an imposed line (the ready
   screen's time) filters before grouping. The data are unchanged: the
   student views still carry `announced` and `imposed` apart. The settings
   editor's preview of the imposed lines, drawn outside any block, keeps the
   kind's word on each line.
7. **The trusted-client gap.** A student sitting in Safe Exam
   Browser or on a kiosk enters past the portal's waiting room; the
   conditions are therefore also shown before the SEB launch and on the
   phone's `/pair` page.
   *As built (2026-10-07, PR 3 of #584):* the student's open evaluation
   card carries `conditions` when the exam has a trusted client (`null`
   otherwise, and on upcoming and past cards: the portal's waiting room
   states them), and `/pair`'s
   `PairableEvaluation` always does; both are built by
   `evaluationConditionsOf` with the seat's extra time, inside the existing
   loaders (the student home's seats, `pairableEvaluations`), and carry no
   `catalogId`. The SEB launch dialog draws them with its steps, its body
   scrolling under a footer that keeps the download in view (until
   2026-10-08 drawn above the steps; since then beside them from `lg`,
   under them below it, because twenty conditions pushed the steps out of a
   laptop screen; `apps/web/DESIGN.md`, Dialog); `/pair` draws the chosen
   exam's list between the exam and "Start on this station", none while
   several exams await a choice. The direct start (ADR-076 §4) is unchanged.

## Consequences

- The student views carry `EvaluationConditions`: the announced kind and
  text, the imposed keys. The attempt's `settings` no longer carry the list,
  so the catalog reference never reaches a student. A database test searches
  every student payload for it.
- The `EvaluationRules` of the waiting room and the ready screen shrink to
  the conditions; the navigation, negative-marking and calculator fields
  they carried are imposed lines now, and the student's extra time travels
  in the duration or deadline line, which the ready screen's sentence by
  Start reads too.
- A teacher can still write something the platform cannot check ("phones
  forbidden"): it reads as the teacher's word, first in its kind's block
  (§6 as amended 2026-10-08), which is what it is.
- `requireFullscreen` remains inert, and is now documented as such.

## Alternatives considered

1. **A free markdown text.** Richer, but unstructured (no kind to show, no
   catalog to reuse), and a second markdown exit to the student.
2. **The platform states every setting.** It would claim things it cannot
   see or enforce, which ADR-069 already refused for the calculator.
3. **Referencing catalog entries live.** An edited entry would rewrite what
   students were told after the fact; the snapshot keeps the record.
4. **An "I have read the conditions" checkbox.** Refused by the owner: one
   more click before the clock, and no protection a court or a teacher needs.
