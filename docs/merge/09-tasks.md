---
search:
  exclude: true
---

# 9. Task cards

One card = one branch = one PR. Ids are `M<phase>-<nn>`; `L-<nn>` are
after the merge. `‖` = can run in parallel with the tasks named. Section
references (§3.1…) point into this folder.

The cards of the tasks `done` or `dropped` in [`PROGRESS.md`](PROGRESS.md)
are in [`history/09-tasks-delivered.md`](history/09-tasks-delivered.md),
under the same headings and anchors; this file keeps the open ones.

<a id="m0-decisions-and-paper"></a><a id="m0-01-settle-the-blocking-decisions"></a><a id="m0-02-measure-production-read-only"></a><a id="m0-03-adrs"></a><a id="m0-04-spec-amendments"></a><a id="m0-05-claudemd-agentsmd-reviewer-prompts"></a><a id="m1-foundations-prod-safe-invisible"></a><a id="m1-01-classrooms-pure-domain-into-packagesdomain"></a><a id="m1-02-github-adapter-layer-configuration-image"></a><a id="m1-03-activitykind-and-the-activitysummary-union"></a><a id="m1-04-missing-primitives-and-long-form-styles"></a><a id="m1-05-web-route-and-mock-skeleton"></a><a id="m1-06-import-script-skeleton-identity-matching-login-adoption"></a><a id="m2-github-substrate"></a><a id="m2-01-github-schema-and-contracts"></a><a id="m2-02-installations-org-link-lazy-healing"></a><a id="m2-03-github-account-linking"></a><a id="m2-04-webhook-intake-handler-registry-delivery-reconciliation"></a><a id="m2-05-periodic-tasks-scheduled_tasks"></a><a id="m2-06-quizs-apps-production-staging-and-staging-safety"></a><a id="m2-07-web-the-classrooms-settings-tab-github-section-link-card"></a><a id="m2-08-student-link-from-settings-login-on-the-roster"></a><a id="m3-01-project-schema-and-contracts"></a><a id="m3-02-project-lifecycle"></a><a id="m3-03-acceptance-and-provisioning"></a><a id="m3-04-ingestion-and-grading-pipeline"></a><a id="m3-05-split-orchestrator-2026-10-02"></a><a id="m3-05a-deadline-freeze-reopen-per-repository-deadlines"></a><a id="m3-05b-final-review-dispatch-review-checkpoints"></a><a id="m3-06-reconciliation-of-grades-and-repositories"></a><a id="m3-07-sync-of-the-source-repository"></a><a id="m3-08-split-orchestrator-2026-10-02"></a><a id="m3-08a-teacher-views-the-project-page-the-runs-the-live-state"></a><a id="m3-08b-teacher-score-release-invitation-resend-protection-re-enable"></a><a id="m3-09-split-orchestrator-2026-10-04"></a><a id="m3-09a-the-students-project-view-the-cards-the-students-resend"></a><a id="m3-09b-notifications-of-projects"></a><a id="m3-09c-real-time-notices-of-projects-f-proj-21"></a><a id="m3-10-web-projects-in-activities-new"></a><a id="m3-11-web-new-project-form"></a><a id="m3-12-split-orchestrator-2026-10-04"></a><a id="m3-12a-web-project-page-reads-lifecycle-deadline-checkpoints"></a><a id="m3-12b-web-per-repository-writes-and-the-review-state"></a><a id="m3-12c-web-the-release"></a><a id="m3-13-web-student-projectrow"></a><a id="m3-14-pilot-and-load-test"></a><a id="m3-14f-drop-the-anthropic_api_key-organization-secret-check"></a><a id="findings-as-tasks-first-walk-2026-10-06"></a><a id="findings-as-tasks-second-walk-2026-10-06"></a><a id="findings-as-tasks-third-look-2026-10-06"></a><a id="m3-15-groups-api"></a><a id="m3-15a-group-sets-and-a-projects-copy-database-only"></a><a id="m3-15b-group-repositories-and-their-membership-on-github"></a><a id="m3-15b-1-group-repositories-at-accept-the-invited-accounts-synchronous-revocations"></a><a id="m3-15b-2-the-follow-on-github-groupsync-the-per-group-stop-confirmations"></a><a id="m3-15b-2a-per-group-stop-the-groupsync-job-needs_confirmation-access-to-revoke"></a><a id="m3-15b-2b-resync-with-the-set-and-the-drift"></a><a id="m3-16-groups-web"></a><a id="m3-16a-the-groups-tab-a-sets-page-the-projects-set"></a><a id="m3-16b-rows-per-group-drift-resync-confirmations"></a><a id="m3-17-groups-formed-by-the-students-adr-070-lot-2"></a><a id="m4-journal"></a><a id="m4-01-renderer-package-journal-schema-and-contracts"></a><a id="m4-02-journal-read-side-and-ingestion"></a><a id="m4-03-journal-writes"></a><a id="m4-04-web-journal-reader"></a><a id="m4-05-web-the-journal-section-of-settings-the-teacher-journal-tab"></a><a id="m4-06-web-the-journals-wysiwyg-editor"></a><a id="m4-07-api-journal-modes-schema-github-mode-read-only"></a><a id="m4-08-api-the-quiz-mode-backend"></a><a id="m4-09-web-mode-choice-standard-editor-github-mode-read-only"></a><a id="m4-10-rename-reorder-nest-quiz-mode"></a><a id="m4-11-move-to-github"></a><a id="m4-12-bring-back-into-quiz"></a><a id="m4-13-copy-a-journal-from-another-classroom-later"></a><a id="m5-student-classroom-page-and-gradebook"></a><a id="m5-01-api-the-students-classroom"></a><a id="m5-02-web-student-classroom-page"></a><a id="m5-03-gradebook-module"></a><a id="m5-04-web-grades-tabs"></a><a id="m6-01-hs256-and-codespace-contracts"></a><a id="m6-02-packagesseb"></a><a id="m6-03-import-appscodespace"></a><a id="m6-04-codespace-cicd"></a><a id="m6-05-engine-vm-capacity-hygiene-seccomp"></a><a id="m6-06-quiz-codespace-module"></a><a id="m6-10-git-relay-through-quiz-issued-scoped-tokens-adr-078"></a><a id="m7-finishing"></a><a id="m7-01-palette-help-tours"></a><a id="m7-02-user-guide"></a><a id="m8-01-import-script-complete"></a><a id="m8-02-legacy-url-resolver"></a><a id="m8-03-caddy-fragments"></a><a id="m8-04-codespace-identity-remap-if-m6-is-in-scope"></a><a id="m8-05-cutover-runbook"></a><a id="m8-06-rehearsal"></a><a id="m8-07-the-cutover"></a><a id="m9-01-point-of-no-return-and-decommission"></a><a id="l-02a-criteria-snapshot-adr-106-1-2"></a><a id="l-02b-runner-project-action-and-the-evidence-run-adr-106-3"></a><a id="l-02c-final-pass-proposals-regrade-adr-106-4-6"></a><a id="l-02d-milestone-locks-adr-106-5"></a><a id="l-02e-teacher-grading-screen-and-release-gate-adr-106-7-8"></a><a id="l-02f-student-criteria-table-adr-106-9"></a><a id="l-06a-criteria-v3-schemas-parser-semantics-fraction-arithmetic-adr-119-25"></a><a id="l-06b-ci-dispatch-and-intake-score_is_grade-migration-adr-119-6-11"></a><a id="l-06c-llm-inputs-and-the-privacy-page-adr-119-7"></a><a id="l-06d-creation-panel-protected-tree-segmented-control-adr-119-9"></a><a id="l-06e-commit-graph-and-ci-logs-on-the-grading-screen-adr-119-8"></a><a id="m8-migration-and-cutover"></a><a id="m9-decommission"></a>

## The brief to hand to an agent

Replace `<ID>` and paste as the agent's prompt; the card carries the rest.

> You implement task **<ID>** of the heig-classroom → Quiz merge (ADR-035).
> Read, in this order: `CLAUDE.md`, `AGENTS.md`, `docs/merge/README.md`,
> the row of <ID> in `docs/merge/PROGRESS.md` and its handoff notes, the
> card <ID> in `docs/merge/09-tasks.md`, the sections it references, and the
> decisions it depends on in `docs/merge/08-decisions.md` (stop if one is
> `open`). Classroom's code is read in a detached reference checkout (see
> README "Sources"); never edit `~/heig-classroom`.
> Work in a worktree on branch `merge/<ID>-<slug>`. First commit: set <ID>
> to `in progress` in `PROGRESS.md` with your branch; push; open a **draft**
> PR titled `<ID>: …` whose body has a **State** section (done / next /
> blocked) that you update at every push. Follow `/feature`: plan,
> implement, run `lean-reviewer` and `invariant-reviewer`, fix. Run tests
> per package (`AGENTS.md` §7). Last commit: `PROGRESS.md` row to `done`
> with the PR number and a one-line handoff for the next task; add to
> `07-incompatibilities.md` anything new you found. Do not merge: report
> back.

**Every code task also**: keeps its migrations additive (one migration per
PR); adds its tables' import step and fixture rows to the import script
(from M1-06 on); forwards classroom fixes newer than the sync point for the
files it ports; writes en + fr for every string.

---

## M3 — Projects

The pilot's open follow-up has no card of its own; its finding was
recorded on the card [M3-14](history/09-tasks-delivered.md#m3-14-pilot-and-load-test)
(2026-10-06), and is carried here. M3-14f, its sibling, is delivered.

### M3-14g — Leaving the course staff ends one's staff seats
- **Depends on**: M3-14c.
- **Note** (ADR-077 Q7; product owner, 2026-10-06: keep as is for now, a
  follow-up): removing a member from a course's staff (ADR-068) leaves their
  staff seats in its classrooms, and with M3-14c their test repositories'
  grants. To decide: remove the seats (and revoke) with the staff seat, or
  keep them.

The pilot's load test (100 repositories at a deadline applied in < 5 min,
the tick with 100 due projects) was deferred (product owner, 2026-10-06).

## M6 — Online workspace and SEB (after the cutover if D09 says so)

### M6-07 — SEB for projects
- **Depends on**: M6-02, M6-06.
- **Goal**: §6.3 points 2–5.
- **Acceptance**: route sweep covers project routes; `/launch` refused in
  exam mode without a valid header; `simulated` impossible in production;
  **proof B recorded** before the first SEB project.
- **As delivered** (branch `merge/M6-07-seb-projects`). Migrations
  `0080_seb_projects` (Quiz) and the portal's `0002_platform_seb`.
  **Proof B is done for evaluations (2026-10-10) and pending for projects**: the manual procedure is 06 §6.3, "Proof B, by
  hand", for the product owner; nothing opens SEB projects to students
  before it is recorded here.
  - Point 2, the platform builds every `.seb`: `auth/seb.ts`
    `sendLaunchFile` (ticket, `auth.seb_launch`, file) serves both the
    evaluation's and the project's (`GET /app/api/projects/:id/seb`, the
    `codespace` module: own portal session, a claimed seat in the
    classroom of a published `online_seb` project, `sebProjectSeat`). The
    start URL is the ticket route for both; `sebAllowedHosts(config,
    activity)` adds the portal's host for a project, then
    `SEB_EXTRA_ALLOWED_HOSTS` (new Quiz setting, host names, `*`
    wildcards but never wildcards alone, empty by default) for both — empty, the evaluation's bytes
    and Config Key are unchanged (`seb.snapshot.test.ts` untouched). The
    ticket route checks the header against either file before consuming
    the ticket, then against the ticket's own; a project's session lands
    on `/projects/:id`. What differs between the two activities is one
    table, `SEB_ACTIVITY`; the ticket's activity is read without consuming
    it (`pendingLaunchTicket`), so the header is checked against that
    activity's file and a wrong one never burns the ticket.
  - Point 3, one activity: `sessions.project_id` and
    `launch_tickets.project_id` (cascade, a check: never both with
    `evaluation_id`); `SessionAuth.projectId` (required, like
    `evaluationId`); the route config gains
    `activities` (absent: evaluation): `serves()` refuses a confined
    session whose activity the route does not list, so `SITTING` stays
    the evaluation's and `PROJECT_SEB` (`GET /app/api/student/projects/:id`,
    `GET /app/codespace/start/:id`) the project's; `GET /me` lists both
    and says `projectId`. `findStudentProjectView` reads THIS project for
    its `seb` session, through its seat, as a portal session would
    (`sebProjectSession`); any other confined session stays the 404.
    `sebProjectSeat` is that same loader plus the `online_seb` and
    classroom checks.
    Supersession and the mismatch audit are per activity (subject
    `project`). `seb.db.test.ts` now runs with the App and the portal
    configured: its sweeps walk every project route, and a project's
    session has its own sweep (`PROJECT_SEB_ROUTES`).
  - Point 4: from that session the start route mints the launch token
    with `seb: {configKey}` (the session's stored key) — `workspaceStartRefusal`
    gained `fromSeb`; `seb_required` is now "from the portal" only; the
    audit adds `seb: true`, never the key. The portal's `/launch` in exam
    mode refuses a token without the claim, then verifies the header
    against the claim's key (`@quiz/seb`), then the BEKs if any, then sets
    its IP-bound `exam_session`.
  - Point 5: BEKs optional on the portal (an empty list is the Config Key
    alone, the exam no longer refused without one); `online_seb` is synced
    (`isOnlineMode`; `syncsToPortal` removed) with `browserExamKeys: []`,
    the resync's `seb_required` lifted. **BEK list: after proof B step 7
    (per-student `.seb` likely gives per-student BEKs)**: SEB's BEK covers
    the configuration, and Quiz's file is per student (the ticket in its
    start URL), so a staff-typed list is expected to match nobody. The Quiz
    side (column, route, staff field) was written then removed at review;
    evaluations have none either.
  - Portal: `src/seb/` keeps `verify.ts` (on `@quiz/seb`'s hashes and
    headers, imported from there, BEKs optional) and `check.ts` (the proxy's cookie check, the outside-SEB
    page); its plist, Config Key, `.seb` file, `/exam/:id.seb` route and
    vectors are deleted (the vectors live in `packages/seb`); its
    `SEB_EXTRA_ALLOWED_HOSTS`, `config_key` and `seb_config` are gone. The
    PUT answers `configKey: null, sebLink: null`.
  - Web: the student's *Open in Safe Exam Browser* (`SebLaunchModal`,
    workspace copy) on an `online_seb` project; inside SEB the app renders
    that project page only (*Open workspace* its one action, no GitHub
    action, the page framing itself); the staff's Resync under SEB. en/fr;
    mock `?sebproject=1` and the `pj-draft-manual` SEB project; scenes
    `project-workspace-seb`,
    `student-project-workspace-seb-launch`, `student-project-in-seb`.
  - Plan B (an auto-submitted POST to the portal) not built: Quiz's CSP
    forbids inline scripts, and the portal would need a `POST /launch`;
    it waits for proof B's evidence (06 §6.3).

### M6-08 — Freeze and collect contract on the portal (ADR-075)
- **Depends on**: M6-03, M6-05. ‖ M6-06.
- **Goal**: an exam mode of `apps/codespace` (no git channel, `--network none`,
  work volume only, per attempt); a `workspace.freeze` HS256 service message
  and a single-use signed collect endpoint (one file or a capped tar of
  declared names); destruction of the volume after Quiz acknowledges the
  hash; a safety cap; the `apps/codespace` `CLAUDE.md` records that this mode
  drops the git-channel divergence; contracts in `packages/contracts`
  (M6-01).
- **Acceptance**: a frozen workspace refuses any write; collect is single use
  and refused without a valid token; no container of this mode has a network
  or a credential (closed list asserted); a destroyed volume is gone;
  integration against a stub Quiz.

### M6-09 — `qt-workspace` type and Quiz side (ADR-075)
- **Depends on**: M6-06, M6-08; D21's `.seb` filter (M6-07) for SEB.
  Kiosk use waits for proof B.
- **Goal**: `packages/qt-workspace` through both registry entry points
  (04 §4.15); publication checks (`workspace.requires_supervision`,
  `workspace.capacity`); seed builder from `toStudent`'s output; the
  deadline + 3 s freeze-and-collect job (singleton per attempt, the
  attempt's deadline with accommodations); blob answer with server-stamped
  hash; two-phase grading on the runner, `proposed` state; grading panel
  shows the file; audit events; en/fr; the `code` fallback swap.
- **Acceptance**: a fully configured question through the seed builder, the
  serialized payload and file tree searched for hidden cases and the
  reference; a late write is impossible after the freeze; an exercise
  refuses the type; portal-down opening is refused with the fallback
  offered; `invariant-reviewer` finds no second exit of question content.

## Loose ends recorded on delivered cards

Open follow-ups that are not tasks of their own; the detail is on each
delivered card.

- [M3-03](history/09-tasks-delivered.md#m3-03-acceptance-and-provisioning): the journal's `targetOf`
  (`journal/writes.ts`) could use `classroomInstallation`.
- [M3-04](history/09-tasks-delivered.md#m3-04-ingestion-and-grading-pipeline): storing a repository's
  name without its owner, still open (recorded on M3-08b's card).
- [M3-08b](history/09-tasks-delivered.md#m3-08b-teacher-score-release-invitation-resend-protection-re-enable):
  a manual re-dispatch of an unconfirmed review.
- [M3-12a](history/09-tasks-delivered.md#m3-12a-web-project-page-reads-lifecycle-deadline-checkpoints):
  the full draft edit (start, grace, grading, scale, publication mode).
- [M6-10](history/09-tasks-delivered.md#m6-10-git-relay-through-quiz-issued-scoped-tokens-adr-078):
  `codespace_relays` rows are not purged with their project; the daily
  reconciliation's head refresh does not read the relays; an App push looks
  `pushAuthor` up twice.
- [M8-01](history/09-tasks-delivered.md#m8-01-import-script-complete): the follow-ups of the code
  review of #550, not blocking (group stops, member placement, `addedAt`,
  `repoMembers` batching, among others); relevant to the M8-06 rehearsal.
- [M8-02](history/09-tasks-delivered.md#m8-02-legacy-url-resolver): not done, the HMAC-honouring of
  an old unsubscribe link and an absolute `Location`; the non-blocking
  follow-ups of the code review of #547.

## L — After the merge

- **L-01** Platform `llm` module (qt-rich, the `short` LLM matcher,
  projects). *2026-10-12*: the module exists (the gateway, ADR-058; essay
  and diagram grading, ADR-063); its projects part is L-02 below.
- **L-02** Runner grading of a project (tarball at the frozen sha, size
  cap, toolchain images, network closed). *2026-10-12*: decided as the
  `criteria` grading mode of [ADR-106](../adr/ADR-106-notation-des-projets-par-criteres.md),
  delivered by the cards L-02a…g (L-02g below; L-02a…f, delivered, in
  [the history](history/09-tasks-delivered.md#l-after-the-merge)). *2026-10-26*: its evidence moves
  to the repository's CI ([ADR-119](../adr/ADR-119-criteres-v3-preuves-de-la-ci.md)),
  cards L-06a…g (L-06f and L-06g at the end of this section; L-06a…e,
  delivered, in the history).
- **L-03** `packages/ui-kit` extraction (what ADR-029 wanted, as a
  workspace package).
- **L-04** WYSIWYG journal editor (RichText adapter: repository-path
  images, no markdown normalisation, round-trip tests).
- **L-05** Project templates at course level.

### L-02g — Labo 00 pilot (ADR-106 §1, §10)
- **Depends on**: L-02c, L-02e.
- **Goal**: labo 00 (`heigvd-2026-prog-a/labo-prog-00`, locked, unreleased)
  switched to `criteria`: its `criteria.yml` edited in the source repository
  (tolerant tests instead of `repairs.txt`; no `prompt` on the identity
  criterion `git.commits`, so it is teacher-only; `rapport.presentation`
  keeps a prompt that checks only that a name and first-name line is
  present, names being masked for the model), a Regrade of its 26 repositories, the result compared with
  the review slot; find out why `review_grade_run_id` is NULL on every row
  while its 26 review runs are `ok`.
- **Acceptance**: every repository has proposals; the comparison is
  recorded in `PROGRESS.md`; the product owner validates and releases.

Criteria v3, the CI produces the evidence
([ADR-119](../adr/ADR-119-criteres-v3-preuves-de-la-ci.md)). A project whose
snapshot is schema version 2 keeps ADR-106's runner path until it is
released; L-06g removes that path last (product owner, 2026-10-27).

### L-06f — StudentScore 1.0 and the lab repositories (external)
- **Depends on**: L-06a (the schemas), before L-06b's migration runs.
- **Goal**: StudentScore 1.0 (`heig-tin-info/score`) implements both
  schemas and the reusable workflow `run.yml`, tagged and pinned by sha;
  the next labs are written in v3 with the shim; every live project that
  used `score_is_grade` moves its CI to StudentScore 1.0.
- **Acceptance**: a `quiz-grade` dispatch on a staff test repository of a
  v3 project is accepted and its rows written; a push run's `GRADE` is
  points over the command leaves' positive maxima.

### L-06g — Removal of the v2 path (ADR-119 §10)
- **Depends on**: L-06b; merged only once `labo-04-pcb` and `labo-03-darts`
  are released.
- **Goal**: remove `testsCriterion`, `test:`, `identityCriterion`,
  `buildCommand`, `testCommand`, `evidenceOutputs`, the JUnit reading and
  the overlay, `apps/runner`'s `project` action, its ceilings and the
  `lab-c` image, and v2 parsing; `CLAUDE.md` invariant 12's archive sentence
  made conditional and invariant 14's runner part deleted, as ADR-119 §13
  proposes.
- **Acceptance**: no project with a v2 snapshot is unreleased; the released
  projects' rows and snapshots read as before; the runner's `containerArgs`
  and env list are unchanged, the `project` route gone.
