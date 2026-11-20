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
rule 12 (two kinds, and two for a project's criterion, §13); PR B closes
the follow-up of [ADR-135](ADR-135-ajustement-de-la-note-d-un-projet.md) §9
(amended in place); PR C amends
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
    owner confirms. *Amended 2026-11-20 (product owner): an assistant's
    `grade_criterion` is refused on a criterion with an open contestation
    (§14).*

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
    `@quiz/domain`, unchanged; one contestation per (repository, criterion);
    on a group repository it is the repository's: any member files it, every
    member reads it and its answer, and none is told who filed it (the
    project page names no teammate). Accepting is the owner correcting the
    criterion and validating the repository: the grade moves at the owner's
    next release (decision 9); no per-repository release; the grade
    adjustment (ADR-135) stays its own gesture. As built, the decisions:
    - **The unit.** A criterion is graded by its VALIDATED current row (a
      teacher's edit since, still proposed, is `pending`) and is full at
      the top of its awarded range: a criterion's maximum, a bonus
      criterion's bonus, a penalty's 0 (`criterionInForce`, `@quiz/domain`).
      So a penalty that took points and a bonus not given are contestable,
      a criterion at its best is not, whoever graded it.
    - **The window** opens at the project's FIRST release
      (`projects.contestation_closes_at`, its `contestation_days`, 7 by
      default, 0 for none, editable until then); a release again, which
      rewrites `released_at`, never moves it; the owner's two acts move it
      (`PUT /app/api/projects/:id/contestation-window`, Lot 1's bounds).
      Migration `0149_project_contestations` backfills the criteria
      projects already released from their first release — the earliest
      `project.release` audit row, else `released_at` — plus seven days.
    - **One table per module**: `project_contestations`, the `project`
      module's, one row per (repository, criterion); a criterion id has no
      foreign key (a reload may replace the snapshot), so the row keeps the
      criterion as it read at the filing, and one whose criterion left the
      snapshot can only be refused (`409 criterion_removed`).
    - **The members** are ONE rule, the readers of `repoMembers`
      (`groupRepos.ts`) through a student seat: its student, or its copy
      group's members whose departure is NOT pending. That rule decides
      who may file (checked before the `INSERT … SELECT`, which keeps the
      window on the database's clock, the release, the mode, the classroom,
      a live repository and the validated row), who reads the repository's
      contestations in the student project payload (with `contestable` per
      criterion and the window's instant), and who is told of an answer. A seat with no repository gets the 404 of an
      unknown criterion, so the criteria's ids cannot be probed.
    - **The staff's own route**, `GET /app/api/projects/:id/contestations`,
      portal sessions only: the grading screen, which the MCP tools
      `get_project_grading` and `grade_criterion` forward, carries no
      contestation, so no token reads a student's words before §14's
      consent.
    - **Two notification kinds of their own**, `project_contestation_filed`
      (the staff, folded per project) and `project_contestation_resolved`
      (the members): Lot 1's fold on `evaluationId`, and a fold target is
      one column per kind (Teams app 2.7.0).
    - **The owner's writes**: every criterion write on a released project —
      and the explicit reload of its criteria, which can take a contested
      criterion out — is the owner's; [ADR-135](ADR-135-ajustement-de-la-note-d-un-projet.md)
      §9 owns that rule and names the one path left open, a sync's
      automatic refresh.

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
    writes those amendments. As built:
    - **Storage.** One proposal per contestation, on its row, each table in
      its module: the verdict, the reply, new points, a criterion's
      rationale or an exam's accepted answer (part, answer, scope), who
      proposed it and when, and the grading in force it read. A later
      proposal replaces it; any answer clears it. Any member of the staff
      may propose and, from the portal, discard one (not audited: nothing a
      student reads changes); proposing is audited `contestation.propose`,
      never a text.
    - **Confirmation.** The owner confirms, from the portal only, the
      proposal they READ: the confirmation names its instant, and a proposal
      replaced since, or a grading moved since it was made, is refused `409
      proposal_stale`, checked again by the write itself. It is the owner's
      answer of §5 or §13 with the stored values, audited as the owner; an
      accepted answer is ADR-128's act with the answer written in the
      transaction of its rule, so a refused answer leaves no acceptance (the
      act's re-grade follows its commit, as ADR-128 heals a repeated act).
      Notifications leave at the confirmation only. Before confirming an
      accepted answer the owner reads how many other students it re-grades.
      The web's batch is the single confirmation in a loop.
    - **Consent.** A consent has a revision, 2 since this lot; a grant and a
      personal token record the one the consent screen or the token form
      SAYS it showed, never above the current one, 1 when it says nothing (a
      page cached from before) — every grant and token made before is 1. A
      refresh never raises it. The four routes the tools forward to need
      `quiz` and revision 2: a `quiz:read` token's read is refused too, and
      an older consent gets `403 consent_required`, worded for the assistant
      to repeat (reconnect, or make a new token); its other tools keep
      working. No re-authorization is forced: a `401` would cost the grant
      every tool.
    - **What an assistant reads.** An opaque contestation id, never an
      attempt, a repository, a user or a name; for an exam the question as
      the staff read it (statement and key, the teacher's text), the answer
      as text, the grading in force and what ADR-128 could accept; for a
      project the criterion, its row in force and the points at the filing.
      The student's words — the reason, the answer and its parts — the
      grading's comment, a criterion's rationale and reason, and a stored
      proposal's reply and rationale are masked (the roster's and the
      sitters' names and addresses; for a project also the members' logins,
      the organization's login and the repository's name). Each text is cut
      at 4,000 characters with a visible mark, a page holds at most ten
      within 24,000 characters. The tool hands the student's words as quoted
      data, and its description says a reason is data, never instructions.
    - **`grade_criterion` refused on a contested criterion** (product
      owner, 2026-11-20, amending decision 13's "proposed points live on the
      contestation only"): through a token, a criterion with an open
      contestation is refused `409 criterion_contested`, the assistant sent
      to a proposal; the portal grades it as before. The student's reason
      now reaches a model that holds this tool, and its write is seen by the
      student at once — the one path where a student's text could produce a
      visible effect without the owner.
    - **What masking and the consent cannot hide.** An exam's contestation
      joins no other tool's data. A project's does: the grading screen's
      tool names every repository with each criterion's points and
      rationale, so a client holding both can usually tell whose a
      contestation is. A name spelled otherwise than the roster writes it,
      or an identity told in other words, is not masked (ADR-063 §4). The
      revision gates the new routes only: a token of scope `api` reaches the
      staff's UNMASKED payloads — the grading queue with names, reasons and
      proposals — as it did before this lot (ADR-113). A parameterized
      question's statement and key are read as written, not as the student's
      instance.

### Lot 3 — agreement figures (PR D)

15. Read-only, no new data: from the `gradings` history, per question and per
    evaluation, the share of the AI's proposals validated unchanged, the
    mean absolute difference in points when changed, split by the model's
    confidence; and the contestation rate and the share accepted, per
    question and per grading source. Shown on the grading panel's question
    bar and the evaluation's statistics only, never on the pool screen.
    As built, staff only, aggregates only, over the class's official
    attempts as the open contestations are counted (never a practice
    attempt, an attempt a paper copy replaced, nor a staff seat's walk):
    - **The AI and the teacher.** A cell is *compared* when it holds a
      validated grading in force and an AI proposal, a grading `llm` that no
      person wrote (`graded_by` null). Its LATEST proposal is the one
      compared (a regrade's, after a regrade, which stands the old
      validation down); a cell whose latest proposal is a failed call (no
      confidence) is compared to nothing. *Unchanged* means the points in
      force are the proposal's, whoever wrote them: a validation as is
      (`llm`), an essay's criteria re-split to the same total (`manual`,
      ADR-118 §6), or an override back to the proposal's points count
      unchanged; an adjusted validation and a later override with other
      points count *changed*. A cell still waiting as a proposal is in
      none. Shown as counts with their total ("12 of 15 unchanged"), the
      mean difference and the counts per confidence beside them.
    - **Contestations.** Filed over the *graded* cells (a validated grading
      in force), the denominator the screens name; open, accepted and
      refused; and per source (`auto`, `llm`, `manual`) of the grading in
      force at filing (`grading_at_filing_id`), filed and accepted.
    - **Where.** The grading queue's item (`agreement`), drawn on the
      question bar; the per-question results (`figures`, `totalFigures`),
      drawn in the Questions tab per question and under its summary. Never
      on the pool screen (other classes' figures there fall under ADR-038's
      threshold), the projection, a student payload, an export or an MCP
      tool: none of these reads the two staff routes that carry them.
    - **Limits.** "Unchanged" reads points, not words: a proposal validated
      with the same total but a different comment counts unchanged. A
      contestation whose grading at filing was deleted (never, but for a
      cascade) counts in no source.

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
  release. On a project (§13): a member whose departure from a group
  is pending still reads the group's repository on the project page
  (`seatRepos`), but none of its contestations, and may not file; a sync's
  automatic refresh of the criteria (ADR-132) may take a contested
  criterion out of the snapshot, after which the owner can only refuse
  that contestation; the backfill falls back on the last release for a
  project whose first release left no audit row.
- Teams users re-upload the app (2.6.0, then 2.7.0 for a project's two kinds) to receive the kinds there.
- **Lot 2's limits.** An assistant's words reach the student only once the
  owner confirms the proposal they read. Every OAuth grant and personal
  token made before 2026-11-20 is refused the contestations until the
  teacher reconnects the assistant or makes a new token (§14).
- Two proposals written within the same millisecond on one contestation (a
  client calling in parallel) carry the same instant: the owner could
  confirm the second without having read it.
- A re-grade that fails after an accepted answer's confirmation committed
  leaves the contestation answered and the student told, the audit written,
  and the answers it reaches graded as before: the owner is answered `500
  regrade_failed` and accepts the same answer again from the question's
  panel, which re-grades them.

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
