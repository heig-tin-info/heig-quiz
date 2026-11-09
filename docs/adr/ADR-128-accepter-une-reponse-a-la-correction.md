# ADR-128 — Accepting an answer at grading time

## Status

Accepted (2026-11-09, decided by the product owner).

Scope: the answers an evaluation item counts right beyond its key, the
grading paths that apply them, the act that changes them, and the
question-type contract they go through.

Relations: amends [ADR-044](ADR-044-grille-de-correction.md) §2 (grouping
identical answers becomes real), [ADR-033](ADR-033-projection-de-la-correction.md)
and [ADR-118](ADR-118-criteres-structures-des-essais.md) §6 (a manual override
stays the teacher's word), [ADR-108](ADR-108-comptage-d-un-item-a-la-correction.md)
(statistics, copies) and F-GRADE-06 (regrade); depends on ADR-108 §3 and §6,
[ADR-068](ADR-068-roles-de-l-equipe-du-cours.md) §3,
[ADR-097](ADR-097-reponse-transmise-et-reponse-stockee.md) and
[ADR-056](ADR-056-questions-parametrees.md) §9.

## Context

Grading an exam, a teacher finds that a sub-answer of an auto-graded question
deserves credit though the key says otherwise: a cloze dropdown keyed `int`
where `invalid` is defensible. Until now the only ways out were to edit the
pool question and re-grade (which changes the question for every future use)
or to override every such answer by hand. The teacher wants to say once
"this answer, at this blank, is right" and have every answer that gave it
follow.

## Decision

1. **A durable rule of the evaluation item, never of the pool question.**
   Table `answer_acceptances` (grading module): item, `part`, `answer`,
   `attempt_id` (null: everyone who gave it), author and time; one rule per
   (item, part, answer, scope). Credit is 100 %: an accepted part counts
   exactly as a right one; there is no partial credit and no column for it.
2. **Every automatic grading of an official attempt applies it**, through
   `GradeContext.accepted`: the evaluation pass (the close, a re-run, a
   late, retake or paper copy) and the check of an exercise (ADR-124), which
   share one cell grader (`gradeCell`). A PRACTICE attempt (ADR-122), the
   drill, a preview and the dashboard's live colour keep grading against the
   pool's key. A runner's or a model's grading receives no acceptance.
3. **"The same answer" is the question type's** (`QuestionTypeServer.acceptance`:
   `given` lists an answer's acceptable parts with their identity and whether
   the key already counts it right; `label` reads an identity back, or says
   the config cannot hold it). For `cloze`: a text blank's identity is its
   text as the blank's own exact matching compares it (`exactKey`: normalised,
   case folded unless `caseSensitive`); a dropdown's, the canonical option
   (ADR-097), whatever the shuffle; number and regex blanks are never
   accepted. A blank right by acceptance carries `accepted: true` beside its
   `ok`. The client column names its part (`GradingColumn.part`); no type is
   named in the API or the web app. `categorize` plugs in the same way.
4. **Scope**: everyone who gave the answer (default) or one attempt. A
   parameterized question (ADR-056 §9) offers only the second: each student
   has their own key.
5. **The gate is the counting act's** (ADR-108 §3): only once the item list
   is frozen (`409 acceptance_not_frozen`), never on a poll nor for a type
   without the hook (`409 acceptance_unavailable`), before the close too,
   the owner's once released (`403 owner_required`). `PUT` accepts, `DELETE`
   with the same body stops; a write that changes nothing audits nothing.
6. **Manual overrides are left alone.** The act re-grades at once the answers
   it reaches whose grading in force is not a manual override; the others are
   counted `unchanged` and the card says how many. An answer not graded yet
   gets the rule from the pass that grades it. This amends ADR-033 and
   ADR-118 §6 only in saying it: the teacher's word on one answer outranks a
   rule on all of them.
7. **After the release**, the single writer does what ADR-108 §6 asks: the
   evaluation is marked "changed after release" and `results_updated` reaches
   only the students whose shown grade moved.
8. **A regrade keeps the rule** (F-GRADE-06); onto another version it drops
   every rule the new version does not hold under the same label (a part
   gone, a dropdown option gone or moved), and its note says which. A plain
   regrade still supersedes every grading of the item.
9. **Not copied**: a duplicate, a template, an instance or a pull of the
   evaluation carries no acceptance (ADR-108 §7 keeps its own rule for the
   counting).
10. **Statistics follow the gradings** (F-STAT-02): an accepted answer counts
    as right in the success rate and the debrief, unlike a counting change,
    which leaves them as they were (ADR-108).
11. **Audit**: `evaluation.answer_accepted`, with accepted or removed, the
    part, the answer, the scope, the counts re-graded and unchanged.
12. **Student exit**: the `accepted` mark travels only where the blank's
    verdict does (`studentDetails`); it names no answer of the key, and the
    review reads it as "Accepted".

## Consequences

ADR-044 §2's promise that a column's key groups identical answers becomes an
act. The identity must never be coarser than the column's sort key, so the
answers one acceptance reaches always sort together (`gradingSortKey`
documents it). Refusing an answer the key counts right, and the mcq, are out
of this decision.

## Alternatives considered

- **Editing the pool question and re-grading**: changes the question for
  every later use and every other evaluation; refused by the owner.
- **Partial credit per accepted answer**: refused; a column "for later" is not
  stored either.
- **Applying acceptances to practice and the drill**: refused; those grade
  against the pool's key, which is what the student revises.
