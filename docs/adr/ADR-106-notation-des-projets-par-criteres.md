# ADR-106 — Grading a project by criteria on the platform: the criteria as data, the evidence run in `apps/runner`, an LLM pass, criteria the teacher validates

## Status

Proposed (2026-10-12). The five product decisions and the masking, opt-in
and runner rules are **decisions of the product owner** (2026-10-12); the
target commit, overlay, commands, score model, report, milestone edge cases,
LLM budget, tarball fetch and retention are the orchestrator's, after the
spec challenge and the lean review of the same day.

Scope: how a project whose staff chose the `criteria` grading mode is graded —
its criteria, the evidence the platform collects, the LLM pass, the
milestones, the teacher's validation, the release and what the student sees.
Projects in `auto` or `none` mode are untouched (§10).

Relations: amends D17 and the D05 addendum (`docs/merge/08-decisions.md`);
F-PROJ intro, F-PROJ-01, -03, -10, -11, -14, -15, adds F-PROJ-23 to -26
(docs/spec/02); N-SEC-20, N-SEC-21, N-DATA-02, -03, -05, -07 (docs/spec/03);
00 §0.6; 01 (final score); 05 §5.5, §5.7, §5.10, §5.11; settles parts of open questions 43 and 52(a)
(docs/spec/06). Amends, each with its scope: [ADR-007](ADR-007-runner-self-hosted.md)
(the CI's review tier), [ADR-016](ADR-016-runner-sur-vm-separee.md) point 2
(a new runner action), [ADR-058](ADR-058-passerelle-llm.md) §1 and its L2
amendment (purpose `project`), [ADR-062](ADR-062-depot-de-distribution.md)
addendum 1 (the overlay reuses the restore's reference),
[ADR-063](ADR-063-correction-llm.md) §2 and §4 (failures reused; the
rationale's audience, for project criteria only),
[ADR-101](ADR-101-budget-du-runner.md) (the `project` action's own ceilings).
`CLAUDE.md` invariants 12, 14 and 15. Builds on
[ADR-064](ADR-064-echeance-des-projets-baux.md) (effective deadline,
freezes), [ADR-012](ADR-012-gel-note-deux-temps.md) (receipt time) and
[ADR-074](ADR-074-carnet-de-notes-marques-stockees.md) (the gradebook reads the
release).

## Context

A lab project lives in a GitHub repository per student or group
(`apps/api/src/modules/project`). Today it is graded by a two-tier CI
(StudentScore 0.7.5, `heig-tin-info/score`, on the CI runners of ADR-007): on
every push the objective tier runs the tests and posts one
`GRADE points/max` annotation (F-PROJ-10); at the deadline and at a
checkpoint Quiz sends a `repository_dispatch` (`grade-final`,
`grade-milestone`) and the repository's own workflow runs an LLM review with
the organization's `ANTHROPIC_API_KEY` (F-PROJ-11, D17). The platform never
reads `criteria.yml`: it ingests one total per run
(`packages/domain/src/ciScore.ts`), keeps four slots (current, frozen,
review, teacher; `finalScore.ts`) and releases a total.

The marks obtained this way on labo 00 (Prog-A, `labo-prog-00`, 26
repositories, locked, not released) are neither objective nor correct, in the
product owner's judgement: the review runs in code the student controls, its
result is one number with no per-criterion trace the teacher can check, and
the platform cannot show the student why.

StudentScore's `criteria.yml` already describes what a teacher needs (§2).
What is missing is that the platform own it: the criteria as data, the
evidence collected and run where the student cannot touch it, proposals per
criterion the teacher validates, and a table of criteria the student reads.

Other courses (Prog-C labo01–04) rely on the CI review today, and
Labo-Intersection has a CI checkpoint in flight (`mid-review`, dispatched
2026-10-11): nothing may switch them by itself.

## Decision

### 1. The `criteria` grading mode, by the staff's choice

`gradingMode` gains a third value, `criteria`, beside `auto` and `none`
(F-PROJ-01). It is **opt-in** (product owner):

- A member of the course's staff chooses it on a **draft**, or — one
  deliberate exception, for the pilot — on a **locked project not yet
  released**. Never on a `published` project, never after the release, never
  automatically (the presence of `criteria.yml` in the source switches
  nothing). Leaving `criteria` follows the same rule.
- The switch is **refused** unless the distribution holds a valid
  `criteria.yml` (§2): the answer carries the parser's errors, with their
  paths. It is refused too, with its reason, when the source's workflow needs
  packages the lab image lacks (an `apt-packages` input, a `pip install` in
  its commands): the evidence run has no network (§3).
- On a locked project, choosing `criteria` runs nothing by itself: the staff
  start the final pass by **Regrade** (§4).

Audited, as every project setting.

### 2. The criteria snapshot

- **The file.** StudentScore's schema v2: `schema_version: 2`,
  `grading: {context, student, sources}`, `criteria:` a tree of sections
  whose leaves carry `description|desc`, `max_points`, `bonus_points`,
  `awarded_points`, `rationale`, `prompt`, `test`, `milestone`
  (`[a-z0-9][a-z0-9_-]{0,49}`); points may be written `"50%"`.
- **Parser.** A pure parser lives in `packages/domain` (a port of
  `schema.py`): it returns the normalised tree or the list of errors with
  their paths. Schema v1 (`$`-prefixed keys) is deferred. `criteriaTotal`
  (§7) ports the arithmetic.
- **Snapshot.** A project in `criteria` mode stores the parsed tree and the
  file's blob sha (`project_criteria`), read from the **distribution**
  repository at the switch, at publication, at each source sync (F-PROJ-12)
  and on the staff's *Reload from source*. A reload that does not parse keeps
  the previous snapshot and shows the errors; a reload whose snapshot drops a
  tag an existing checkpoint uses is refused (`409 checkpoint_untagged`).
  The snapshot is read-only in the project's settings, beside the mode's
  settings `testsCriterion`, `buildCommand`, `testCommand` and
  `evidenceOutputs` (§3). Audited: the switch and the reload.
- **Three kinds of criterion**, decided per leaf:
  - **automatic**: the project's `testsCriterion` (product owner: a project
    setting, pre-filled from the workflow's `tests-criterion` input, default
    `rendu.all-tests-passed`), graded as the share of passed JUnit cases of
    the evidence run; or a leaf carrying `test:`, whose value is a pytest
    node id or a name prefix, graded as the share of passed JUnit cases whose
    name starts with it. A criterion that is the `testsCriterion` and carries
    a `prompt` is automatic only.
  - **llm**: a leaf with a `prompt`, proposed by the LLM pass (§4).
  - **teacher-only**: any other leaf; it has no row until a teacher writes
    one.
- **Identity criteria are never sent to the model** (product owner). A
  criterion that judges an identity — who committed (labo 00's
  `git.commits`), whose name a report carries (`rapport.presentation`) —
  carries no `prompt` in `criteria.yml`, so it is teacher-only by the rule
  above (or automatic through a `test:` on the extracted report). A
  deterministic commit-authors check from the push receipts is a possible
  follow-up, not part of this decision.

### 3. The evidence run: the platform collects and tests

A job `project.evidence`, one per repository, produces the evidence of one
(repository, target sha):

- **Target commit**: the last commit received before the repository's
  effective deadline (push receipts, ADR-012) that no bot pushed, whether or
  not CI ran on it; a milestone pass uses the same rule at the checkpoint's
  date (§5).
- **Fetch**: GitHub's tarball endpoint at the target sha, never a clone. Its
  redirect target (a `codeload` URL with `token=`) is never logged, stored,
  nor put in an error payload, and the redaction learns `token=`
  (invariant 15). The downloaded size is capped. The tarball's top-level
  directory, `<owner>-<repo>-<sha>`, carries the student's login: it is
  stripped before anything is rendered or stored.
- **No evidence**: a repository with no student commit, a tarball above the
  cap, or a repository deleted on GitHub gets no pass; its criteria get
  0-point `proposed` rows whose reason is `no_commit`, `archive_too_large` or
  `repo_missing`, shown in the grading screen (§8) — never `to_verify`.
- **Overlay**: the API composes the archive: the repository's tree with the
  distribution's **current** protected files in place of the student's, as a
  restore takes them (ADR-062 addendum 1). Only protected files are
  overlaid; the distribution sha is recorded on the evidence row. The
  student's copy of a protected file is never what is graded.
- **The runner's `project` action** (product owner; ADR-016 amended): the
  archive goes to the runner under `CLAUDE.md` invariant 12's archive rule.
  The image is the lab image `lab-c` (its packages: 05 §5.5; no network).
  The commands are the project's settings, fixed argv arrays: `buildCommand`,
  default `["make","prepare"]`, then `testCommand`, default
  `["pytest","--junitxml=report.xml","-q"]`. What comes back is the output
  files named by `evidenceOutputs` (default `["report.xml","build/"]`; each
  and all under a cap), under invariant 12's outbound rule, with stdout and
  stderr, capped. The flag list of `containerArgs` does not change. The
  action has its own timeout and tmpfs ceilings, which are the runner's
  configuration, never a per-request override, and the API's wait budget
  for it is its own (ADR-101 amended).
- **Pacing**: one job per repository, a few at a time, on the runner's
  grading priority; a pass is paced so that it never fills the runner's
  queue (ADR-101). Neither `project.evidence` nor `project.review` takes a
  project lease (`lease.ts`): each is idempotent per (repository, pass).
- **Stored**: per (repository, sha): the JUnit result per test case, stdout
  and stderr, the output files, the distribution sha.
- **Forgeability**: the student's code still runs in the evidence run, so a
  test it subverts can still lie; what changes is that the tests, the
  Makefile and the criteria are the distribution's. The spec keeps calling a
  score **indicative** until the teacher validates and releases it (N-SEC-21);
  the evidence is never called "authoritative".
- **Retention** (N-DATA-03): the evidence files are deleted with the project,
  or six months after its release, whichever comes first; the JUnit summary
  and the criterion rows stay.

### 4. The LLM pass

When a repository's evidence completes, it enqueues that repository's
`project.review` job (one per repository, as `grading.llm`), which calls the
model for the llm criteria. *Amended 2026-10-12 (L-02b): the evidence job
writes the automatic rows from the JUnit results; the review job writes the
llm rows, both through one writer of `project_criterion_grades`.*

- **Purpose `project`** joins `LLM_PURPOSES` (ADR-058 §1); the call goes
  through the gateway, billed to the project's creator (`llm_calls.user_id`)
  and **exempt from the user share** like `grade` (`USER_SHARE_EXEMPT`,
  ADR-058 L2 (a)). The global daily cap is the only budget; no per-course
  budget.
- **Masking** (product owner; N-DATA-05): every text sent — the files
  `grading.sources` names, the JUnit summary, the output files — is masked
  with `maskNames` (ADR-063 §4) over the classroom's roster and the
  repository members: their names, e-mail addresses and GitHub logins. The repository's and the
  student's names are never in the request; identity criteria never are
  (§2).
- **One structured call per repository**: the system prompt is
  `grading.context`; the prompt is the llm criteria not locked (id,
  description, max, `prompt`) and the rendered sources; the reply is a strict
  JSON schema keyed by criterion id (as `llm.py`), each with points and a
  rationale, clamped to `[0, max]` per criterion. The repository's content is
  data, not instructions, and the system prompt says so.
- **Rows per criterion** (`project_criterion_grades`), in the vocabulary of
  `gradings` exactly: source `GRADING_SOURCES` (`auto` for an automatic
  criterion, `llm`, `manual` for a teacher's row), state `GRADING_STATES`
  (`proposed`, `validated`, `superseded`), a `supersedes_id` chain, a partial
  unique index on the validated row per (repository, criterion id), points,
  max, rationale, the pass, and a reason when the row records a failure. A
  milestone lock is its own nullable column, `locked_by_checkpoint_id` with
  `locked_at`, orthogonal to the state (§5).
- **Failures** as ADR-063 §2: `llm_budget`, `llm_not_configured`,
  `grader_error`, each a 0-point `proposed` row with its reason, never a
  retry loop; the next Regrade settles them.
- **Regrade**, per repository and per project, by the staff, after a
  confirmation stating the estimated cost (N repositories × 1 call). It
  supersedes the current `proposed` rows of the unlocked automatic and llm
  criteria with new ones, reusing the stored evidence of the same
  (repository, target sha, distribution sha) and re-running it otherwise; it
  never supersedes a `manual` row nor a locked one. Capped at **3 a day per
  project** (ADR-058 L2 (b)), a repository's or the project's regrade
  counting one. Audited.

### 5. Milestones are checkpoints

A review checkpoint (F-PROJ-11) of a project in `criteria` mode is a
milestone: its name is the `milestone:` tag of the criteria it grades, and a
checkpoint whose name tags no criterion of the snapshot is refused
(`409 checkpoint_untagged`).

- At its date the ticker claims the milestone pass of every repository whose
  effective deadline has not come in the existing `grade_dispatches` ledger
  (`trigger = 'checkpoint'`, the checkpoint's id) and enqueues
  `project.evidence` instead of calling GitHub (invariant 5: claim and
  enqueue only). The pass grades **the tagged criteria only**, at the last
  non-bot commit received before the date (§3), and sets their rows'
  `locked_by_checkpoint_id`: the final pass and a Regrade leave them alone.
- The teacher may always correct a locked row (product owner): a `manual`
  row superseding it, still locked.
- A repository with no evidence at the date: its tagged criteria get 0-point
  rows with their reason (§3), locked.
- A repository accepted after the checkpoint keeps its tagged criteria
  unlocked: the final pass grades them.
- A deadline moved later **before the release** keeps the milestone locks;
  the final pass's rows are superseded and the validations undone
  (F-PROJ-09's reopen). After the release it keeps the validations and the
  released snapshot: a released grade never changes by a side effect
  (F-PROJ-09 unchanged).
- A checkpoint left behind by a deadline moved earlier never fires, as today.
- A CI checkpoint already dispatched (Labo-Intersection's `mid-review`) is
  not converted.

### 6. The final pass, and the table the student reads

At a repository's **definitive freeze** (F-PROJ-11) the ticker claims the
final pass in `grade_dispatches` (`trigger = 'deadline'`) and enqueues
`project.evidence`; the pass grades the unlocked criteria. A deadline moved
later deletes that `deadline` row as the reopen does today
(`project/deadline.ts`), so the next freeze claims a new pass (before the
release only, §5). On a locked project switched to `criteria` (§1), the
staff's Regrade runs this pass.

There is **no stored report**: the report is the criteria table with its
rationale column, rendered on read from the current rows by one pure
function with an audience parameter, used by the project's student view
(§9) and the staff's screen (§8); its student rendering carries neither a
row's source nor the model. It is never committed to the repository. A
rationale is **plain text**: never rendered as markdown or HTML, shown
escaped in a table cell on both screens (N-SEC-14's rule).

### 7. The score model

- A fourth final-score source, **`criteria`**, computed in
  `resolveFinalScore` between `teacher` and `review` (`FINAL_SCORE_SOURCES`;
  the gradebook's cell source, I42): the final score is the teacher's
  repository score, else `criteria`, else the review's, else the frozen
  score, else the current one (teacher > criteria > review > frozen >
  current).
- `criteria` exists only for a **validated** repository (§8); otherwise it
  is empty, never 0, and the order falls through to the review, frozen or
  current score.
- `criteria` is computed from the repository's **validated** rows only:
  max = the sum of the positive `max_points`; a negative `max_points` is a
  penalty subtracted; bonus points are added; the total is clamped to
  `[0, max + bonus]` (StudentScore's `_clamp`, ported); the grade comes
  through `projectGrade`, capped at 6.
- The repository-level teacher score and comment (`PATCH …/score`,
  F-PROJ-14) are unchanged and stay the override.
- The student's CI `GRADE` badge stays, **indicative** (F-PROJ-15, N-SEC-21):
  the platform's evidence is the one graded.

### 8. The teacher's grading screen and the release gate

`/projects/:id/grading`, modelled on the evaluation grading table
(`apps/web/src/grading`: the bar with ‹ › and progress, Validate → Next →
Release): a rail of repositories, to validate or validated; the criteria
table of the selected repository (criterion, expected = its description,
max, awarded editable, the source as an icon CI / AI / teacher, the
rationale folded, the reason of a failed or missing pass). An edit writes a
`manual` row. A repository is **validated** when every criterion of the
snapshot has a current `validated` row — no new repository state;
**Validate** marks its proposed rows `validated`. A teacher-only criterion
gets its row only from a teacher, explicitly (0 included), never by
default: while one has no row, Validate and the bulk action are refused
with `409 criteria_incomplete`, listing the repositories and criteria.
**Release** is refused while a live student or group repository (a staff
test repository excepted, ADR-077) is not validated (`409 not_validated`,
beside the existing `not_frozen` and `to_verify`); a bulk **Validate the
rest as proposed** validates them.

Its routes and audit actions are listed in 05 §5.11: every body a schema
of `packages/contracts`, reads behind `staffAccess` and every write also
behind `requireCourseRole` (invariant 6), each audit action in the closed
union (invariant 9).

### 9. The student view

Through the one exit `modules/project/studentView.ts` (N-SEC-20), the
student's project page gains a **criteria table**: criterion, expected, max,
obtained. Obtained is **empty** for an llm criterion until a pass graded it
and for a teacher-only one until the teacher wrote it; every row not yet
validated and released is marked **indicative** (F-PROJ-14) — the automatic
criterion, and an llm row after a milestone pass, included; a **lock** icon
marks a locked row. The **rationale
column** appears after the repository's definitive freeze, marked
provisional, and becomes final, from the validated rows, after the release
(product owner, decision 2); before the definitive freeze the payload
carries no rationale at all, a milestone pass's included — absent, not
hidden. This amends N-SEC-20, the D05 addendum and
ADR-063 §4 together, for project criteria only: an essay's or a diagram's
justification stays the teacher's. The student payload never carries a row's
source, a row's reason (`no_commit`, `archive_too_large`, `repo_missing`,
`llm_*`, `grader_error`), the model, the pass, a superseded row, an
evidence file, another repository's rows, nor a row of a project not in
`criteria` mode. Tested as N-SEC-20's exit: a second student's rows and
rationales, a superseded rationale, and a milestone rationale read before
the freeze, searched for in every response and event of the first.

### 10. What does not change

- Projects in `auto` and `none` mode: the CI's `GRADE` ingestion (F-PROJ-10),
  the final review dispatch and the checkpoints' dispatches (F-PROJ-11) stay
  as they are; nothing switches them.
- In `criteria` mode the CI's `GRADE` is still ingested, as the student's
  indicative feedback and as the fallback below `criteria` in the
  final-score order (§7); nothing is dispatched to the repository.
- The in-flight Labo-Intersection checkpoint runs as dispatched.
- The CI's `llm-review` tier and the organization's `ANTHROPIC_API_KEY`
  check (F-GH-03) are decommissioned **progressively**, course by course,
  once their projects run in `criteria` mode (M3-14f).

Invariants: `CLAUDE.md` invariant 12 carries the `project` action's archive
rule, invariant 14 the target commit the server chooses from its push
receipts, invariant 15 the tarball redirect; 10, 11 and 13 are unchanged.

Delivery: task cards L-02a to L-02g (`docs/merge/09-tasks.md`, `PROGRESS.md`).

## Consequences

- The grade rests on criteria the teacher wrote, evidence the student does
  not control (the distribution's tests and Makefile), and per-criterion
  proposals a teacher validated; the student reads why.
- The platform pays the model (one call per repository per pass) on the
  institutional key; the organization secret is no longer needed for these
  projects.
- The runner gains a second kind of request (an archive and fixed commands)
  and a lab image; the archive unpacking is new attack surface inside the
  sandbox, bounded by the sanitization and the unchanged hardening.
- A rationale written by a model reaches a student, provisional before the
  release. The teacher's validation is the gate of the final one.
- A project whose tests need the network cannot use this mode until its
  dependencies are in the image.
- Two systems coexist until M3-14f: CI review for `auto` projects, platform
  pass for `criteria` ones.

## Alternatives considered

- **CI artifacts as evidence** (the repository's workflow uploads JUnit and
  `build/`): rejected by the product owner (decision 1) — the artifacts come
  from a run the student's code controls.
- **Switching to `criteria` automatically when the source has
  `criteria.yml`**: rejected (owner) — it would switch courses that rely on
  the CI review without their teachers' consent.
- **Committing the report to the repository**, as the CI does: rejected — it
  writes into the student's repository, and a table rendered by the student
  view is the one exit N-SEC-20 can test.
- **A stored report row**: rejected (lean review) — a second copy of the
  rows that a validation would have to keep in step.
- **A repository state for "validated"** and **row states of their own**
  (`provisional`, `locked`): rejected — `gradings`' vocabulary already says
  it; the lock is a column.
- **Sending identity criteria to the model with the names unmasked**:
  rejected (owner) — N-DATA-05.
- **A clone in the runner**: rejected — invariant 11, the network stays
  closed; the server fetches.
- **Per-course LLM budget**: not needed; the daily cap and the regrade cap
  bound it.
