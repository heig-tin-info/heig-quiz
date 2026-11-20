# ADR-135 — Project grade adjustment

## Status

Proposed (2026-11-19). The request and decisions 1 to 17 below are the product
owner's (2026-11-19), the defaults the spec challenger proposed included.
Amended 2026-11-20 by [ADR-139](ADR-139-contestation-d-une-correction.md) §13
(§9 only): the follow-up is done — every criterion write on a released
project, and the explicit reload of its criteria, is the owner's.

Scope: a project repository's grade after its points; the role needed for a
grading write on a released project; the release's snapshot of a grade.

Relations: amends [F-PROJ-14, F-PROJ-15 and F-GBOOK-03](../spec/02-exigences-fonctionnelles.md)
and the project routes of [05 §5.11](../spec/05-architecture.md#511-github-the-journal-and-projects);
amends [ADR-068](ADR-068-roles-de-l-equipe-du-cours.md) §3 (a project's grading
writes after its release); reads [ADR-106](ADR-106-notation-des-projets-par-criteres.md) §7
(the final score's order), [ADR-119](ADR-119-criteres-v3-preuves-de-la-ci.md) §11
(the stored `released_grade`) and [ADR-074](ADR-074-carnet-de-notes-marques-stockees.md)
(a stored gradebook mark).

## Context

A teacher sometimes moves a project grade after a talk with the student, or
because an explanation given afterwards holds. That is neither a change of
the criteria nor of their points: it is the grade itself. Until now the only
lever was the teacher's score (F-PROJ-14), which replaces the points, loses
what the criteria said, and does not say why the grade moved.

## Decision

1. **A third layer, after the grade.** A repository's grade is computed in
   three steps, in this order, and nowhere else: the points — the final
   score, `resolveFinalScore` (teacher > criteria > review > CI) —; their
   grade by the project's scale, `projectScoreGrade` (rounded to the tenth
   by the project's rounding); then **the adjustment**, `adjustGrade` of
   `packages/domain/src/gradeAdjustment.ts`. A teacher's stored gradebook
   mark still wins over the adjusted grade (`resolveCell`, ADR-074).
2. **Two kinds.** `relative`: a delta, a multiple of 0.1 within ±5, never 0;
   it survives a regrade — the base moves, the delta stays. `absolute`: a
   grade 1.0 … 6.0 at the tenth, which pins the grade. The result is
   `round_tenth_nearest(clamp(base + delta, 1, 6))`, or the pinned grade,
   computed live and never stored.
3. **An absolute pin keeps its base.** The base grade it was written over is
   stored; when the live base differs, the staff are told ("base moved from
   X to Y") and keep the pin (written again, over the base of now) or clear
   it. A regrade never re-bases it silently. A relative delta stores its
   base too, for the audit, and is never flagged.
4. **A justification, required**: trimmed, 1 … 2000 characters.
5. **One rule, every view.** The grading table, the repository's sheet and
   rows, the release, the gradebook, the exports and the student's released
   grade all read the grade through `adjustGrade`, by the server's
   `repoScores` (the final score's `grade` is the adjusted one).
6. **Per repository**, a group's included: the dialog names every member
   the grade is theirs.
7. **Storage**, on `project_repos` (the `project` module's table):
   `grade_adjust_kind`, `grade_adjust_value`, `grade_adjust_base`,
   `grade_adjust_comment`, `grade_adjusted_by`, `grade_adjusted_at`, and
   `released_adjustment_comment`, the release's copy of the comment beside
   the teacher's `released_comment`, which it never overwrites.
8. **When.** Only on a graded project (`409 grading_none`), a repository
   frozen for good (`409 not_frozen`, as the teacher's score) that has a
   grade (`409 no_grade`: no final score, no maximum, or the CI's share of a
   project graded by criteria), an absolute pin included. A clear needs no
   grade. An adjustment bypasses no release gate (`not_validated`,
   `to_verify`).
9. **Who** (amends ADR-068 §3). Before the project's release, an owner or
   an assistant of the course; after it, the owner alone (`403
   owner_required`), as an evaluation's grading after its release. The same
   rule now holds for the teacher's score (`PATCH …/repos/:rid/score`),
   which every member could write before: on a released project, the
   teacher's score and the adjustment are the owner's. Checked in the
   route's loader, before the body, and again in the write's transaction,
   under the project's lock that the release takes too (a release committed
   between the two is seen). *Amended 2026-11-20 (ADR-139 §13, the
   follow-up this point announced):* the criteria's writes on a released
   project are the owner's too — a criterion's points (`PUT
   …/repos/:rid/criteria/:criterionId`, the MCP `grade_criterion`
   included), a repository's and the project's validation (`POST
   …/repos/:rid/validate`, `POST …/validate`) and a Regrade (`POST
   …/regrade`, `POST …/repos/:rid/regrade`, whose results replace validated
   rows, ADR-132 §5): checked in the loader, and, for the points and the
   validations, again by the writer under the project's share lock, before
   any repository's (`writeCriterionGrades`, `validateProposals`), and for
   a schema-3 Regrade by its claim (`claimRegrades` under its share lock;
   a schema-2 Regrade claims nothing, the loader decides); one refusal, `requireReleasedOwner`, for
   every grading write. The explicit reload of a released project's
   snapshot (`POST …/criteria/reload`) is the owner's too: it can
   take a contested criterion out (ADR-139 §13). **The one path left
   open** is a sync's automatic refresh of the criteria (ADR-132, any staff
   member's sync): it may replace the snapshot after the release — a
   contested criterion it removes leaves its contestation to be refused
   only, a changed maximum moves the criterion's best value.
10. **The release** writes the ADJUSTED grade into `released_grade` and the
    adjustment's comment into `released_adjustment_comment`. "Changed after
    release" (`changedAfterRelease`) becomes grade-based: the live adjusted
    grade against `released_grade`, read at the tenth, and the adjustment's
    comment against its released copy; points that moved without moving the
    grade are no change. The gradebook reads `released_grade` for the
    students and the live adjusted grade for the staff, so it follows a
    release again.
11. **The student** reads, with the released grade, the teacher's comment
    and then a "Grade adjusted" line holding the released justification —
    never the kind, the delta, the value nor the base, and nothing before a
    release wrote it. Hiding the delta is a display choice, not a
    confidentiality rule: the released points and the public scale make it
    deducible.
12. **Audit**: `project_repo.grade_adjust`, beside `project_repo.grade_override`,
    with the adjustment before and after (`kind`, `value`, `comment`,
    `base`, the `grade` it gave) and `cleared`. It is the adjustment's only
    history. No notification: the student learns of it at the next release.
13. **Routes and contract**: `PUT /app/api/projects/:id/repos/:rid/grade-adjustment`
    (`GradeAdjustmentWrite`, invariant 7; a value the domain refuses is a
    400) and `DELETE` on the same path; both answer `ProjectRepoScores`.
    The staff's repository view carries `scores.adjustment` (kind, value,
    comment, writer's name, date, `base`, and `moved` — `{ from, to }`
    for a pin whose base moved, else null) and
    the grading screen's entry `grade` and `adjustment`.
14. **Exports.** The gradebook's CSV follows the cell (the adjusted grade).
    No project-level export of grades exists; none is added.
15. **The screen.** On the Grading tab of a project graded by criteria, the
    mark at the end of a row is a button that opens a dialog: Relative or
    Absolute, the value (step 0.1), the justification, the preview "base →
    result", the members of a group, one primary **Adjust**, and **Remove
    the adjustment** when there is one. An adjusted grade wears a small mark
    whose bubble holds the justification; a moved base wears the warning.
    The repository's sheet shows the adjustment read-only, for every graded
    mode; setting one outside the `criteria` mode is the API's for now.

## Consequences

- The grade a teacher meant is kept as such, with its reason, and the
  criteria keep saying what the work was worth.
- An assistant can no longer change a released project's teacher score:
  the owner does, as for a released evaluation.
- A points-only change after the release that does not move the grade no
  longer asks for a release again; a comment-only adjustment change does.
- The staff's views read the adjusters' names: one more query, only when
  an adjustment exists; the release and the gradebook never do.
- The six adjustment columns are written whole: a check constraint
  (`project_repos_grade_adjust_whole`) holds them all set or all null.

## Alternatives considered

- **Change the teacher's score instead.** It hides the reason, loses the
  criteria's total and moves points, not the grade the teacher decided.
- **Freeze the adjusted grade at the write.** A regrade would then silently
  keep a stale grade; a live rule with an explicit "base moved" for a pin is
  safer and keeps one computation.
- **A history table of adjustments.** The audit log already records every
  write with its before and after.
- **Show the delta to the student.** Rejected as a display choice: the
  justification says why, the grade says how much.
