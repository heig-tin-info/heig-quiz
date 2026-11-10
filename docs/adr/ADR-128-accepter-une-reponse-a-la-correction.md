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
   drill and the question's preview keep grading against the pool's key. A
   runner's or a model's grading receives no acceptance. The live
   dashboard's colour preview (ADR-020, `liveGrader`) does not read them
   either: it would cost a read on every autosave for a preview the grade
   replaces, so an accepted answer may show red there while the evaluation
   runs, never in the grading table, the results or a student's feedback.
3. **"The same answer" is the question type's** (`QuestionTypeServer.acceptance`:
   `given` lists an answer's acceptable parts with their identity and whether
   the key already counts it right; `label` reads an identity back, or says
   the config cannot hold it). For `cloze`: a text blank's identity is its
   text as the blank's own exact matching compares it (`exactKey`: normalised,
   case folded unless `caseSensitive`); a dropdown's, the canonical option
   (ADR-097), whatever the shuffle; number and regex blanks are never
   accepted. A blank right by acceptance carries `accepted: true` beside its
   `ok`. A client column names the parts it shows (`GradingColumn.parts`:
   one for a blank, several for a column summing up many cards) and places
   the host's control after each part's chip (`GradingCellInput.accept`);
   no type is named in the API or the web app. `categorize` plugs in the
   same way.
4. **Scope**: everyone who gave the answer (default) or one attempt. A
   parameterized question (ADR-056 §9) offers only the second: each student
   has their own key.
5. **The gate is the counting act's** (ADR-108 §3): only once the item list
   is frozen (`409 acceptance_not_frozen`), never on a poll nor for a type
   without the hook (`409 acceptance_unavailable`), before the close too,
   the owner's once released (`403 owner_required`). `PUT` accepts, `DELETE`
   with the same body stops; an act that changes no rule and re-grades
   nothing audits nothing (one that heals a failed re-grade is audited).
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
13. **One lock per item.** The item's `evaluation_items` row, `FOR NO KEY
    UPDATE` (`lockItems`, which leaves the foreign-key checks of answers and
    gradings written meanwhile alone), is the single serialization point of
    every writer of an item's gradings that acceptances concern, always
    after the attempts' locks (ADR-067) and before the gradings' and the
    evaluation's rows: the act writes its rule under it; a regrade takes it
    before retargeting the item and dropping rules; a manual override takes
    its attempt's lock, then it; a partial retake's copy takes it after its
    attempt locks; the counting act (ADR-108) takes it before the
    evaluation's row; and the single writer's guard of every automatic
    grading of an item that takes acceptances — the pass's and the
    exercise check's (`acceptanceGuard`) — takes it before reading, under
    it, the item's version and its rules. A grading computed on another
    version is dropped (the regrade's pass grades it); one computed with
    rules that moved since is graded again, which must keep its state. The
    act's guard also drops a cell whose grading in force is by then a manual
    override. The act re-grades what it reaches whether its rule was new or
    not, writing only what would change, so a repeated PUT or DELETE heals
    an act whose re-grade failed.

### Categorize (2026-11-10, product owner)

14. **Identity.** A part is a CARD, its answer the column the student put
    it in. A card left in the tray has no answer and is never accepted.
15. **Ordered mode.** With "the order counts", the answer is the column AND
    the rank (`<column>#<rank>`). A rank moves with every card above it, so
    such an answer is accepted for ONE answer only: the type says so
    through its hook's `singleAnswer(config)`, which the one rule of the
    scopes reads beside the parameterized one (`acceptanceScopes`,
    `@quiz/domain`): the queue's `scopes` and the act's check (`422
    acceptance_scope`, under the item's lock, on the version in force) come
    from it. This is the one extension the generic contract took for
    categorize; no type is named in the API or the web app.
16. **Scoring.** An accepted card counts as right inside the type's own
    scoring, under every policy, negative marking included
    (`categorizeCounts`, `@quiz/domain`). A target accepted where it was
    put is at its place: `t`, no longer `x` — an all-or-nothing answer may
    go from 0 to full, a penalty disappears. A distractor accepted where it
    was put stays a distractor and is no longer counted against the
    student, as if left out: it leaves `p`, stays in `D`, never raises `T`
    — under negative marking a student who placed it scores exactly as one
    who rightly left it out (decided 2026-11-10 in review, within the
    owner's "counts as right"). Its verdict reads right, "Accepted", in the
    table's count, the teacher's review and the student's.
17. **Summary column.** Past eight cards the table has one summary column
    (`GradingColumn.parts` lists every card) and no cell per card: the
    summary cell says how many cards of the answer are accepted, and a card
    is accepted from the answer panel, one row per offered card. The label
    of an answer names the card and the column ("double → Integer"), so the
    key's row and the panel read alone; a regrade onto a version that
    changed the card's text or the column's label drops the rule, as one
    that removed them.

    *Follow-up (not done):* a rule is kept across versions when its label
    is unchanged, which a mere rename breaks. A stable identity for a
    dropdown option, or an optional `sameAnswer(before, after, rule)` hook,
    would let the ids decide for a type whose ids are stable (categorize).

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
