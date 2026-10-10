# ADR-098 — Student concept mastery: a level per course concept, from reviewed cards only

## Status

Accepted (2026-10-10, product owner, issue #599, comment of the same day on steps 7 to 9).
Delivery progress is in `docs/merge/PROGRESS.md` and `changes/`.

Scope: what a student reads of their own drill mastery per concept, and the one exit that serves it.

Relations: satisfies [ADR-081](ADR-081-vocabulaire-de-notions.md) §10 (showing concept labels to
students needs its own ADR) and uses its course concepts and broader relations (#599 steps 7a and
7c); keeps [ADR-041](ADR-041-entrainement-espace.md) §6 (no extra practice), §11 (serving rule) and
§15 (mastery is FSRS retrievability); completes F-DRILL-05 (docs/spec/02); adds an exit to
`docs/spec/05` §5.7. Closes the student half of the idea of issue #578.

## Context

A student sees concept labels nowhere: `toStudent` strips concepts and `COMMON_FORBIDDEN_STUDENT_KEYS`
lists them (invariant 4). The teacher already reads the classroom's mastery per concept
(`classroomMastery`, ADR-041 §15). F-DRILL-05 promises the student "a mastery indicator per concept"
but ADR-081 §10 deferred it. Issue #578 (closed) proposed a course heatmap for teacher and students
whose red tile opens a practice set. Its own pitfalls apply: dark is not red, small samples, a
discouraging map, forgetting. Three facts shape the answer. The raw concepts of a question are
curation material, including `proposed` labels, which are raw teacher text. Practice is capped by
design (ADR-041 §6, §11). And FSRS retrievability decays between reviews.

## Decision

1. **Only the course's declared concepts.** A student reads a level for a concept the classroom's
   course declares (`course_concepts`, #599 step 7a), never for the raw concepts of a question. The
   concept must be **validated**; a `proposed` one is never shown, even if a course lists it. Once
   broader relations exist (step 7c), a card counts toward every declared concept it reaches
   through them, up the hierarchy, and once per concept. A card whose concepts are all outside the
   course counts nowhere, and the student sees no "outside the course" bucket (that one is the
   teacher's, step 9a).
2. **A level only from 5 reviewed cards.** The evidence for a concept is the student's distinct
   cards on it with at least one review. Below 5, the row says **"No data yet"**, drawn differently
   from "To work on" (a neutral outline, none of the scale's colours; dark is not red, #578). The 5
   is the threshold of F-DRILL-07's calibration, kept as one constant in `@quiz/domain`.
3. **The level is a band of the mean retrievability now.** FSRS retrievability of each counted card
   (`drillRetrievability`, the rule of ADR-041 §15) is averaged per concept, then cut into three
   bands: **To work on** (below 0.7), **Getting there** (0.7 to below 0.9), **Solid** (0.9 and
   above, the scheduler's target retention). The exit answers the band and the number of cards the
   level rests on, never the number.
4. **Fading is accepted and said.** Retrievability decays by design, so a level can drop without any
   new mistake. The wording is forward-looking: the bands read "To work on", "Getting there",
   "Solid"; the section says the levels are **as of today** and **fade when a concept is not
   reviewed for a while**; no row says "failed" or "lost".
5. **No comparison.** No class average, rank, percentile or "better than", no other student's
   number, and no count of how many students have data. Rows follow the course's order of concepts
   (label order), not the level, so the list is not a ranking either.
6. **No practice button.** The page offers no "Practise this concept": a card is served only when
   today's session would hand it out (ADR-041 §6, §11), and a concept shortcut would be an extra
   practice and a lever to inflate the level. The one action of the drill page stays the day's
   session.
7. **Only cards the student may already see.** A card counts only when its key may already reach
   this student, the rule that serves it (`keyReleased` in `drill/review.ts`, ADR-041 §13): an
   exam's once its results are released, an exercise's once its own feedback policy shows the key.
   A card whose release was withdrawn is suspended and **excluded**. Nothing of an unreleased or
   future exam reaches the read: not a concept, not a count, not an effect on any level. Cards of an
   archived classroom do not appear (their classroom is not listed).
8. **A new student exit.** One function in the drill module's student view (working name
   `studentConceptMastery(db, classroomId, userId, now, lang)`) is the only code that turns a
   student's cards into labels. It filters by the card's owner, loads the classroom through
   `readableClassroom` with the student payload forced (so a teacher in the student view and an
   impersonation session read their own or the impersonated seat, never a staff payload), and
   returns, per course concept: a label in the student's language, a band or "no data", and the card
   count. It returns no id of a non-course concept, no question id, statement, internal name, card
   id, due date, review time or confidence. Its route serves portal sessions only, as the
   calibration's does (ADR-085 §8), never a `seb` or `kiosk` session.
9. **Its leak test** (05 §5.7): a classroom with a validated course concept, a proposed concept, a
   validated concept the course does not declare, questions carrying them with an internal name, an
   explanation and a statement, a released and an unreleased exam, a suspended card and another
   student's cards. It asserts the forbidden-key list over the response AND searches the
   serialized output for the statements, internal names and ids of the questions, the ids and
   labels of the non-course and proposed concepts, the other student's data and the unreleased
   exam's concepts, for each student caller (a student, a teacher in the student view, an
   impersonation session).
10. **Where and what the student sees.** The student's drill page, one section **Concepts** per
    classroom whose drill is on and where they hold a claimed seat; a course declaring no concept
    shows nothing, not "no data". A row: the label, the level or "No data yet", and "Based on N
    cards". Above the rows, the sentence of §4. No retrievability number, date, list of questions,
    per-card detail, comparison, or button other than the page's session. An opted-out student still
    reads their own levels (their cards keep their state, ADR-041 §15).
11. **Invariant 4 gets a pointer** with the implementation PR (step 9b), not in this one. In
    `CLAUDE.md`, after the sentence "One point of exit, in the `studentView` service of the `live`
    module: …" is complete, add: "**A student's concept mastery has one exit too**: the student
    view of the `drill` module (ADR-098), which names only the concepts the course declares,
    validated, and only from cards whose key the student may already see."
    `COMMON_FORBIDDEN_STUDENT_KEYS` keeps the concepts: this exit is not `toStudent`.

## Consequences

- F-DRILL-05 is rewritten to cite this ADR; ADR-081 §10 is satisfied; ADR-041 gets a pointer and
  §15 needs no change. With the implementation PR (9b), 05 §5.7 gains one paragraph (the exit), the
  `drill` row of the module table mentions the student read, and `CLAUDE.md` gets §11's sentence.
- 9b depends on step 7a of #599 (and 7c for the roll-up); the teacher's course-concept mastery (9a)
  shares the retrievability read.
- A level can fall without a mistake, and a lightly reviewed concept shows "No data yet" for
  weeks. Both are intended; the page says the first.
- Mastery reads today's classification of past evidence (ADR-081 §9): a question given a new
  concept moves its old reviews to it.
- A new exit is one more leak surface, held by §8's narrowness and §9's test.

## Alternatives considered

- **The #578 heatmap with a "Practise this concept" button.** Rejected: an extra practice breaks
  ADR-041 §6 and §11 and invites farming the level.
- **Showing the raw concepts of the questions.** Rejected: unbounded, includes `proposed` labels
  (raw teacher text) and concepts the course never taught.
- **Class average, comparison or ranking.** Rejected: discouraging, and it re-identifies students in
  small classes. The teacher has the aggregate (ADR-041 §15).
- **A level that never fades.** Rejected: not what retrievability measures; it would hide the
  forgetting the drill exists to counter.
- **A raw percentage.** Rejected: false precision on five cards, and it moves visibly day to day.
- **Evidence from evaluations as well as the drill.** Out of scope: ADR-041 §15 defines mastery on
  FSRS; graded work stays on the grades page.

## Open points

None for the product owner. Two choices were settled by the author and can change without touching
the rules: the band cut-offs of §3 and the section's place on the drill page (§10).
