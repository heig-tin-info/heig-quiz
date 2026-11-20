# ADR-139 — Contesting a grading: one request per question or criterion, answered once by the owner, within a stored window

## Status

Accepted (2026-11-20, decided by the product owner on issue #1171 and its
"Spec challenge (2026-11-20)" comment). Delivered in four pull requests:
A — the exams (§1–§12), B — the projects (§13), C — the MCP proposals
(§14), D — the agreement figures (§15); this record covers all four, so
none of them needs another.

Scope: a student's contestation of the grading of one question of a released
exam (F-GRADE-08) or of one criterion of a released project graded by
criteria, its window, the owner's answer, the staff's reading of it, the
assistant's proposals, and the figures read from the grading history.

Relations: builds F-GRADE-08 (spec 02, amended in place); depends on
[ADR-068](ADR-068-roles-de-l-equipe-du-cours.md) §3 (a grading write after
the release is the owner's), [ADR-108](ADR-108-comptage-d-un-item-a-la-correction.md)
and [ADR-128](ADR-128-accepter-une-reponse-a-la-correction.md) (the gates,
the release consequences, the instruments a contestation leads to),
[ADR-018](ADR-018-vue-etudiant-reelle.md) (amended 2026-11-17: a staff seat
lives the student flow) and [ADR-027](ADR-027-tickets-de-lancement-et-sessions-typees.md)
(portal sessions only); amends [ADR-030](ADR-030-canaux-de-notification.md)
rule 12 (two kinds); PR B closes the follow-up of
[ADR-135](ADR-135-ajustement-de-la-note-d-un-projet.md) §9; PR C amends
[ADR-022](ADR-022-jetons-api-et-serveur-mcp.md) §C and its Consequences,
[ADR-113](ADR-113-portee-des-jetons-personnels.md) and the assistants guide
when it lands (§14).

## Context

After a graded test of November 2026, students disputed the grading of
several questions by e-mail and by word of mouth: the teacher found each copy
by hand, nothing recorded who asked what nor what was answered, and an
assistant connected through MCP could read the evaluation but neither propose
an answer nor reply. The instruments that correct a grade exist — the manual
override (F-GRADE-05), the regrade (F-GRADE-06), the counting of an item
(F-GRADE-10, ADR-108), the accepted answers (F-GRADE-11, ADR-128); the
REQUEST that leads to them, its deadline and its answer did not. F-GRADE-08
("a student may report a question from their results with a reason") was the
seed, never built. `question_reports` (issue #680) is another thing: a
colleague reporting a pool question to its writers.

## Decision

### The product owner's decisions (2026-11-20)

1. **Window**: 7 days after the release by default, on by default, editable
   until the release; afterwards the owner may close it early or extend it,
   and extending may reopen a closed one.
2. **One contestation per question (or criterion), one final answer**: no
   thread, no edit, no withdrawal; a further appeal is the school's formal
   path.
3. **The course owner answers**, as every grading write after a release
   (ADR-068 §3); every staff seat reads.
4. **Under Anonymise** the reason is folded behind "Show the reason": the
   teacher reads the answer first. The server sends the reason either way and
   never a name while anonymised.
5. **Nothing is suspended**: the grade stays released and exported; the
   results table and the gradebook flag "n open contestations".
6. **Plain text only**: reason and reply at most 2,000 characters, no
   Markdown, no attachment; the reason is mandatory.
7. **Verdicts** `accepted` or `refused`. A refusal carries a reply. An
   acceptance may leave the points as they are ("you are right, the comment
   was wrong"), or carry new points written as a manual override in the same
   act, the reply its comment (then the reply is mandatory). Nothing checks
   that "the grading changed": an item counted as a bonus rewrites no
   grading.
8. **Works already released** when this ships get seven days from their
   release: the rest of the window if it has not ended, nothing otherwise.
9. **Projects**: the owner corrects the criterion and validates the
   repository; the contestation is resolved and the student told, the new
   points read as indicative, and the grade moves at the owner's next
   release. No per-repository release.
10. **MCP**: students' answers and words leave to an external assistant only
    with a token of scope `quiz` (never `quiz:read`); the roster's names and
    addresses are masked in the answer and in the reason; a new consent line,
    and existing grants are asked again.
11. **Exams only, among the evaluations**: never an exercise (ADR-124: never
    graded), never a poll.
12. **The MCP tools propose, never apply**: the owner confirms one by one or
    as a batch.
13. **The proposal tools cover project criteria too**; the proposed points
    are stored on the contestation only, unseen by the student until the
    owner confirms.

### Lot 1 — exams (PR A)

1. **The window is a stored closing instant**, `evaluations.contestation_closes_at`,
   never `released_at + days` read at each request: an unrelease followed by a
   release gives a new `released_at`. The setting is the feedback policy's
   `contestationDays` (0 to 60, 0 = none, absent = 7, `contestationDaysOf`):
   copied with the policy by a duplicate, a template, an instance and a pull;
   written through the evaluation's PATCH, which leaves the feedback policy
   writable after the attempts and the release; a change after the release
   moves nothing. The release that finds the column null, on an exam whose
   policy is not `when: none` and whose days are > 0, sets it to its own
   instant (the server's clock) plus the days, in its transaction
   (`setRelease`, `coalesce`); a re-release and an unrelease never move it.
   Migration 0148 backfills `released_at + 7 days` on every released exam
   whose policy shows results (decision 8): one already past is simply
   closed.
2. **The owner's two acts**, `PUT /evaluations/:id/contestation-window`,
   `{ action: "close" }` (the server's now) or `{ action: "extend",
   closesAt }` (ahead of now, at most 90 days: `422 window_instant`, reason
   `not_future` | `too_far`), on a released exam whose policy shows results
   (`409 window_unavailable` otherwise), owner only (`403 owner_required`),
   audited `evaluation.contestation_window` with the act and the instant.
   Closing stops new contestations; the open ones stay open. Extending also
   opens a window where the release opened none (0 days, or a policy that
   showed nothing then): the results say so (`contestationApplies`). One
   predicate decides where a window applies, the release's and these acts'
   alike: `contestationWindowApplies` of `@quiz/domain` (an exam, released,
   a policy whose `when` is not `none`).
3. **What may be contested** is the pure rule of `@quiz/domain`
   (`contestation.ts`, `unitRefusal`, beside the window's
   `contestationWindowOpen`), on the facts of a unit that ONE builder
   (`contestedUnit`) reads from the validated grading in force — its points
   and its maximum — for the write and for the feedback page alike, so a
   page never offers what the write refuses: its
   results are shown to the student (`resultsState` available; nothing under
   `when: none`), its attempt is the one that counts (ADR-025), the question
   counts (a neutralized one does not, ADR-108), a validated grading is in
   force (not pending), below full points. An unanswered question is
   contestable: its zero is a grading. An excused student and a paper attempt
   are no special case.
4. **Filing**, `POST /attempts/:id/items/:itemId/contestation`
   (`ContestationFileBody`): the caller's own attempt or the 404 of a missing
   one (`ownAttempt`); portal sessions only — the route lists no session
   kind, so a `seb` or `kiosk` session is nobody (ADR-027) — and an
   impersonation stays read-only in production (ADR-034), nothing added.
   ONE conditional `INSERT … SELECT` decides: the window on the DATABASE's
   clock (`now() < contestation_closes_at`, invariant 5), a released
   evaluation whose policy shows results, a classroom not archived, and the
   validated grading in force, read in the same statement as
   `grading_at_filing_id` (it never names a superseded row). The loaded rows
   only choose the refusal: `409 contestation_closed` (not released, or no
   window) and `409 not_contestable` with the domain's `reason`
   (`not_shown`, `not_counted`, `not_counting`, `pending`, `full_points`;
   the contract's `NotContestable`) before the INSERT; its miss named after
   it — `409 contestation_exists`, `409 classroom_archived`, `pending` (the
   grading left meanwhile), else `contestation_closed`. The row is stamped
   by the database's `now()`. Audited `contestation.file`, the student the
   actor, never the reason. **A student removed from the roster** may still
   file on their own attempt while the window holds: exactly the reach of
   their feedback page today (decided by default, orchestrator,
   2026-11-20).
5. **The answer**, `POST /contestations/:id/resolve`
   (`ContestationResolveBody`: `verdict`, `reply`, optional `points` or an
   essay's `criteria`, `ManualGradingBody`'s fields): loaded through the
   contestation's evaluation (invariant 6), the course OWNER's always — also
   after an unrelease, which a contestation survives. Once (`409 not_open`,
   a conditional UPDATE on `state = 'open'`, nothing checked before it); a
   refusal or new points carry a reply — ONE rule, `answerExplained` of
   `@quiz/domain`, which the contract refines with (a 400), and which a
   project criterion's answer reuses. Without points, one UPDATE records the
   grading in force (`grading_at_resolution_id`). With points, a manual
   override (F-GRADE-05) of the cell in force — its answer and its maximum
   read from the validated grading, from the item and its answer row when
   none is — whose comment is the reply, through the single writer, and the
   answer written in ITS transaction after the new grading (the writer's
   `after` hook): both commit or neither. The override then does
   what every correction does: "changed after release" (F-GRADE-09), the
   `grading.override` audit, `results_updated` to a student whose shown grade
   moved — no suppression: both notifications arrive. Audited
   `contestation.resolve` (verdict, whether points were given, the gradings
   before and after; never a text).
6. **One table, the grading module's**: `contestations` (`attempt_id` and
   `item_id` cascading, unique together; `reason`; `filed_by`, `filed_at`;
   `grading_at_filing_id`; `state` `open | accepted | refused`; `reply`, not
   null, empty for none; `resolved_by`, `resolved_at`;
   `grading_at_resolution_id`), an index on the open ones by item. Never
   copied; deleted with its attempt or its item. Not polymorphic: a project's
   criterion gets its own table (§13).
7. **The student exit (invariant 4)**: a contestation travels ONLY in its
   student's own feedback payload (`studentFeedback`): per question
   `contestation` (`state`, `reason`, `filedAt`, `reply`, `resolvedAt`) or
   null, and `contestable`, the domain rule on the server's clock — an offer,
   which the write decides again; at the top `contestationClosesAt`. Nothing
   of it in the copy file (the contract's `StudentCopyRecord` strips it; the
   PDF draws only the fields it names), the debrief, the per-question view, another
   student's payload, the Grades page, the home, a notification (ids and the
   title only) or any staff export. The student's personal data export
   (ADR-112), built from their own feedback views, carries their own
   contestations, as it carries their answers.
8. **The staff's reading (invariant 6)**: the grading queue's entry carries
   its cell's contestation (`StaffContestation`: the student's fields, its
   `id`, `counted`), anonymised or not — it names nobody; each step counts
   the OPEN contestations of its question (`contested`); the results carry
   them per row and in total (`openContestations`) with the window's instant;
   the gradebook's column of the exam carries the total. The open figures
   count the class's official attempts: a teacher's test walk (ADR-018) and an
   attempt a paper copy replaced (ADR-125 §12) are in none; an exam takes no
   retake (ADR-025), so its official attempt is the one that counts, and the
   kept attempt is not recomputed for them. Never in the CSV. The refresh
   hints (N-SEC-20) go to the course's staff (`course:<id>`) and, for an
   answer, to its student (`user:<id>`), never to `classroom:<id>`, where
   every classmate listens; a filing tells the staff alone, its student has
   the request's reply.
9. **A staff seat's contestation** (ADR-018, amended 2026-11-17) is a test
   row: listed with the test attempts, counted nowhere, notifying nobody.
10. **Notifications** (ADR-030): `contestation_filed` to the course's staff,
    folded per evaluation with a count (`NOTIFICATION_FOLD_TARGETS`), off by
    e-mail and Teams by default, opening the grading panel on its contested
    filter; `contestation_resolved` to the student, on everywhere, opening
    their feedback page, neither the verdict nor the reply carried. The Teams
    app declares both (2.6.0).
11. **Retention**: a reason and a reply are free text, which may name their
    authors or others. They follow the attempt (deleted with it). The account
    pseudonymization (ADR-117) keeps them, as it keeps the answers and the
    gradings' comments: it replaces an identity and scrubs only the
    teacher's note on a roster line. Known limit, below.
12. **The words**: *contestation* in both languages, the act *Contest* /
    *Contester* (spec 01 §1.5); never *réclamation* nor *recours*, which the
    copy lint refuses.

### Lot 1b — projects (PR B)

13. On a released project GRADED BY CRITERIA (a project without criteria has
    no unit to contest), the student contests ONE criterion — its points and
    its rationale — from the project page, under the same rule of
    `@quiz/domain`, unchanged. One contestation per (repository, criterion);
    on a group repository it is the repository's: any member files it, every
    member reads it and its answer. Its own table, owned by the `project`
    module, beside the criteria it contests. The window is a stored closing
    instant set at the project's FIRST release, the same seven days by
    default and the same backfill for the projects already released, moved by
    the same two acts of the owner. Accepting is the owner correcting the
    criterion and validating the repository: the contestation is resolved and
    the students told, the new points read as indicative, and the grade moves
    at the owner's next release (decision 9); there is no per-repository
    release. The grade adjustment (ADR-135) stays its own gesture. With this
    lot, every criterion write on a released project becomes the owner's,
    which closes the follow-up of ADR-135 §9.

### Lot 2 — MCP proposals (PR C)

14. Three tools: `list_contestations` (the open contestations of an
    evaluation or a project, each with the question or the criterion, the
    student's answer, the key, the grading in force and the reason; an opaque
    id, never a name nor an address), `propose_contestation_resolution`
    (verdict, reply, optional points — a criterion's included) and
    `propose_accepted_answer` (the ADR-128 gesture: part, answer, scope,
    attached to the contestation). They store PROPOSALS on the contestation,
    never apply them; proposed points live there only, unseen by the
    student. The owner confirms in the "Contested" filter, one by one or as a
    batch. A proposal records the grading in force; its confirmation is
    refused `409` when that grading changed or the contestation was
    answered. The tools forward to the web app's routes, so the guards and the
    audit are the routes': `contestation.propose` with the actor `api_key`,
    the owner's confirmation as the owner. Only a token of scope `quiz`
    reaches them — every one of them, `list_contestations` included, since it
    sends students' answers and words out (decision 10). The roster's names
    and addresses are masked in the answer and in the reason as ADR-063 §4
    masks an essay (`maskNames`). The consent screen gains a line saying so,
    and every existing grant is asked again. This amends ADR-022 §C (its
    closed list; "no transition of grading" gains these proposals) and its
    Consequences, ADR-113 (a reading tool that is `quiz`, not `quiz:read`),
    and `docs/guide/assistants.md`; decided here, applied by PR C, which
    writes those amendments.

### Lot 3 — agreement figures (PR D)

15. Read-only, no new data: from the `gradings` history, per question and per
    evaluation, the share of the AI's proposals validated unchanged, the
    mean absolute difference in points when changed, split by the model's
    confidence; and the contestation rate and the share accepted, per
    question and per grading source. Shown on the grading panel's question
    bar and the evaluation's statistics only, never on the pool screen.

## Consequences

- A disputed grade has a trace: who asked, why, when, who answered, and the
  gradings in force at both acts, beside the `gradings` history.
- The owner's correction stays the existing instruments: an override in the
  answer itself, or the panel's own gestures (accept an answer for everyone,
  regrade, count as a bonus or not at all) before a bare acceptance.
- **Two clocks**: the window is decided by the database's `now()`; the
  views' `contestable` and the owner's acts read the server's clock. In
  production they are one clock; a test sets the server's to the wall
  clock's instant.
- **Known limits.** A pseudonymized account's reasons and replies are kept
  (§11): a reason may name its author or someone else, as an answer may. An
  attempt replaced by a paper copy after an unrelease leaves the grading
  queue with its contestation (the queue shows no replaced attempt); the row
  stays, answerable by its id, and counts in no open figure. The
  `contestation_resolved` bell is not withdrawn by an unrelease, unlike
  `results_released`: the page it opens may then show nothing until the
  release.
- Teams users re-upload the app (2.6.0) to receive the two kinds there.

## Alternatives considered

- **Direct MCP writes** (an assistant answering students or changing a grade
  itself): refused, decision 12; proposals the owner confirms.
- **A thread** (a conversation per contestation): refused, decision 2; one
  request, one final answer.
- **One polymorphic table** for questions and criteria: refused; each module
  owns its table, both follow one rule of `@quiz/domain`.
- **A window computed from `released_at`** at each request: refused; an
  unrelease and a release would restart it, and a project's every release
  would move it.
- **Checking that the grading changed before an acceptance**: refused,
  decision 7; not every instrument rewrites a grading.
- **Suspending the grade while a contestation is open**: refused, decision 5.
- **Blind second marking** (a second staff member grades without seeing the
  first): deferred to a separate issue; it needs its own data and decisions.
  Lot 3's figures are designed so that a second human marker fits them.
