# 9. Task cards

One card = one branch = one PR. Ids are `M<phase>-<nn>`; `L-<nn>` are
after the merge. `‖` = can run in parallel with the tasks named. Section
references (§3.1…) point into this folder.

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

## M0 — Decisions and paper

### M0-01 — Settle the blocking decisions
- **Who**: the product owner, with the orchestrating session.
- **Goal**: settle D01, D02, D04, D08 (after M0-02), D16; then the others
  as their phase approaches.
- **Acceptance**: `08-decisions.md` statuses updated with date and place.

### M0-02 — Measure production (read-only)
- **Depends on**: nothing. ‖ M0-01.
- **Needs**: the product owner's go for read access to both production
  databases (memory note: read-only psql through ssh) and to the GitHub App
  settings page.
- **Goal**: numbers that settle D04, D08, D09, D22 and I50:
  - identity: users per side; overlap on `swiss_edu_id`; among them, share
    with equal `oidc_sub`; classroom users with Keycloak-era subs; users
    without `swiss_edu_id`; `anon-*` users; addresses shared by two
    accounts after a union;
  - classroom content: classrooms (with org, owner, archived), pending staff
    seats and assistants, assignments by state / `work_mode` / group mode /
    grading mode, repos, grade runs, journals and their pages/assets bytes,
    unprocessed webhook deliveries;
  - the live App's permissions and events (is `Secrets:read` granted?).
- **Output**: `docs/merge/measures-2026-MM-DD.md` with the queries and the
  counts, **no personal data** (the repository is public).
- **Acceptance**: the file exists; D08 and D09 can be settled from it.

### M0-03 — ADRs
- **Depends on**: M0-01 (D01, D16). ‖ M0-04.
- **Goal**: ADR-035 Accepted; ADR-029 status "Superseded by ADR-035";
  classroom ADR-011 imported as ADR-011; classroom ADR-013/014/015
  imported as ADR-047/048/049, the next free numbers (036–046 were taken;
  bodies verbatim, a status line naming the former number and the
  renames: assignment ⇒ project, …); status notes or addenda on 006
  (project sweeps), 007 (applies again), 010 (GitHub + codespace secrets),
  012 (literal vs analogical reading), 016 (codespace beside the runner),
  027 (`seb` session per activity; cross-VM HS256 exception), 030 (project
  kinds); `zensical.toml` nav.
- **Acceptance**: `spec-challenger` run on ADR-035 has no open objection;
  docs build.

### M0-04 — Spec amendments
- **Depends on**: M0-01. ‖ M0-03.
- **Goal**: the amendments listed in §7.5; 07 frozen as history; the
  unsettled decisions copied into 06.
- **Acceptance**: `spec-challenger` pass; every term of §7.4 resolved in 01.

### M0-05 — `CLAUDE.md`, `AGENTS.md`, reviewer prompts
- **Depends on**: M0-03.
- **Goal**: invariant 4 generalised (activity student views, and the
  journal's student view as the journal's one exit: no draft, no page
  before its `visible_from`, no markdown, blob sha nor warning); invariant
  6 gains the student branch (`readableClassroom`: a claimed enrollment
  reads its classroom, anyone else gets the 404); invariants
  11–12 scoped to `apps/runner` (codespace's own `CLAUDE.md` comes with
  M6-03); invariant 14 gains the project clause; the `@heig-platform/ui`
  sentence replaced; layout gains `modules/github|project|journal|gradebook`
  and `packages/docrender`; `.claude/agents/invariant-reviewer.md` updated
  accordingly; a pointer to `docs/merge/` for merge work.
- **Acceptance**: `invariant-reviewer` prompt names the new rules.

## M1 — Foundations (prod-safe, invisible)

### M1-01 — Classroom's pure domain into `packages/domain`
- **Depends on**: M0-03. ‖ M1-02, M1-03, M1-04, M1-06.
- **Port from**: `C:packages/domain/src/{grade.ts (extractGrade),
  finalGrade.ts, groupRepo.ts, repoName.ts}` (journal part stays for
  M4-01), `planDispatch`, `planMilestoneDispatch`, `runKind`
  (`C:dispatch.ts`, `C:grading.ts`), `parseStudentIgnore`, `slugify`,
  `resolveOffset`; reuse Quiz's Zurich formatter. (`rateLimitReset` is
  transport knowledge: it stays in M1-02's `github/metrics.ts`.)
- **Tests**: the classroom unit tests of these files.
- **Acceptance**: `@quiz/domain` green; no DB, no `fetch`.
- **Pitfall**: `domain/roster.ts` exists in both — keep Quiz's, port only
  test cases it lacks.
- **As delivered** (#370): named with §7.4's words — `ciScore.ts`
  (`extractScore`), `finalScore.ts` (`resolveFinalScore`, `finalPoints`),
  `repoName.ts` (`repoName`, `slugify`; no `journalRepoName`; the results
  CSV filename now uses `slugify`), `groupRepo.ts`, `reviewDispatch.ts`
  (`runKind`, `planFinalReviewDispatch`, `planCheckpointReviewDispatch`,
  `checkpointDueAt`), `studentIgnore.ts` (`parseStudentIgnore`),
  `zone.ts` (`SCHOOL_TIME_ZONE`, `zoneOffset`, `zonedIso` = classroom's
  `zurichIso`; `DRILL_TIME_ZONE` gone); wire names unchanged (I16).
  Quiz's roster tests already covered classroom's.

### M1-02 — GitHub adapter layer, configuration, image
- **Depends on**: M0-03. ‖ M1-01.
- **Port from**: `C:github/*` (app, git, retry, lock, commit, revert,
  provision, collaborators, squash, studentize, sync, metrics) and
  `verifySignature` ⇒ `Q:apps/api/src/github/`. `parseStudentIgnore`
  and `zurichIso` (as `zonedIso`) come from `@quiz/domain` (M1-01, I17),
  not local copies; `rateLimitReset` stays in `github/metrics.ts`.
- **Change**: `Q:config.ts` (six `GITHUB_*`, off when empty, production
  refusals §3.3), `Q:redact.ts` (`x-access-token:`, `gh?_`), `Dockerfile`
  (`git`, `ca-certificates`), octokit + lockfile (atomic commit).
- **Tests**: app, collaborators, git, metrics, provision, retry,
  studentize (≈ 58 cases); config refusal tests.
- **Acceptance**: green without network; the image has git; the API boots
  unchanged with no `GITHUB_*`.

### M1-03 — `ActivityKind` and the `ActivitySummary` union
- **Depends on**: M0-03. ‖ M1-01.
- **Goal**: `Q:modules/activity/` with the `ActivityKind` interface
  (`listForTeacher`, `listForClassroom`, `studentCards`,
  `gradebookEntries`, `deadlines?`), one implementation (evaluation);
  `ActivitySummary` becomes a union with `kind: "evaluation"` (mode kept);
  `activity_*` notification payloads kind-neutral
  (`{activityKind, activityId, activityTitle}`) before they are built.
- **Acceptance**: `/activities` and every screen unchanged (screenshots
  identical); contract tests updated.
- **As delivered** (#373): `ActivityKind<K>` has `kind` and
  `listForTeacher` only, over a plain `KINDS` list in
  `modules/activity/service.ts`, which serves `GET /activities`. Each other
  member lands with the first task that calls it through `KINDS`:
  `studentCards` with M5-01, `gradebookEntries` with M5-03, `deadlines`
  with M3-05 (wired to the ticker there), the classroom list with the task
  that first needs a mixed-kind classroom list. **Rule**: a method that
  takes a classroom id is reached only after the route has loaded the
  classroom through `staffAccess` or `readableClassroom`; its reviewer
  checks it. `activity_available` is kind-neutral (migration 0037; I58–I60).

### M1-04 — Missing primitives and long-form styles
- **Depends on**: M0-05. ‖ M1-01…03.
- **Goal**: `GithubIcon`, `OrgAvatar`, `Progress` in `apps/web/src/ui/`
  (DevGallery entries); `.md-body.md-doc` long-form styles and the "Long-form
  reading" section of `apps/web/DESIGN.md` (restated in Quiz radii).
- **Acceptance**: ui tests, gallery screenshots; the question `MarkdownView`
  scenes unchanged.

### M1-05 — Web route and mock skeleton
- **Depends on**: M1-03. ‖ M1-04.
- **Goal**: routes `classroom` (role-dispatched, the student branch a
  placeholder behind a flag), `classroomSettings`, `studentCourses`,
  `classroomJournal`, `classroomGrades`,
  `project`, `projectGroups`; mock files `mock/github.ts`,
  `mock/project.ts`, `mock/journal.ts` with the flags `?projects=1`,
  `?unlinked=1`, `?journal=1`.
- **Acceptance**: router tests (nested and encoded paths, trailing slash);
  default scenes unchanged.

### M1-06 — Import script skeleton, identity matching, login adoption
- **Depends on**: D08 (after M0-02), D04. ‖ M1-01…05.
- **Goal**: `Q:apps/api/scripts/import-classroom.ts` per §2.5 — source
  connection, mapping file schema (zod), dry-run/apply, `import_classroom`
  schema (`id_map`, `runs`), report skeleton; steps implemented now: users
  (the cascade of §2.4), addresses, claims, avatars, teacher grants,
  courses, classrooms (without org link), course staff, enrollments, role
  recompute. If D08 says so: login adoption in `Q:auth/login.ts` + its ADR.
- **Fixture**: `apps/api/scripts/fixtures/classroom-seed.sql`, synthetic,
  anonymised, built from classroom's own seed.
- **Tests** (`*.db.test.ts`): import into PGlite; second run writes
  nothing; merge into an existing classroom; a duplicate identity is
  reported, not merged silently.
- **Acceptance**: dry-run report readable; no write outside the target DB.

## M2 — GitHub substrate

### M2-01 — `github` schema and contracts
- **Depends on**: M1-02, D02, M0-04, M0-05.
- **Create**: `Q:db/github.ts` (`github_organizations`,
  `github_classroom_links`, `github_accounts`, `webhook_deliveries`,
  `push_receipts`), one additive migration; `packages/contracts/src/github.ts`;
  import-script steps for these tables.
- **Acceptance**: migration runs on a production dump copy; idempotency
  indexes tested.
- **As delivered** (#402): tables in `Q:db/github.ts`, migration
  `0048_github` (five `CREATE TABLE`, FKs to `users` and `classrooms`
  only). Production-dump run waived by the orchestrator: create-only
  migration; staging applies it against a restored production dump at
  deploy. Choices the next tasks inherit:
  - `github_organizations`: one column per fact. Installed or not is
    `installation_id` null or not, nothing else; `status`
    (`GITHUB_ORG_STATUSES`: `active` / `deleted`) says whether the
    organization exists on GitHub. No CHECK, no avatar column, no
    timestamps. Rows are never deleted.
  - `webhook_deliveries.payload` is nullable: the purge sets it to null
    and keeps the row (the deduplication outlives it); `received_at` and
    `push_receipts.received_at` have NO default, the intake writes
    `app.clock.now()`.
  - `push_receipts` is keyed on `github_repo_id` (GitHub's repository id),
    not on a project repository's row: `github` owns no FK into `project`
    (spec 05 §5.3 amended). M3 joins through `project_repos.github_repo_id`
    and deletes a repository's receipts itself if it wants them gone.
  - Contracts (`packages/contracts/src/github.ts`): `GithubOrg` {id,
    login, `avatarUrl` (the avatar route below, or null), `installed`,
    `status`, `plan`}, `GithubClassroom` {`link: GithubClassroomLink |
    null` with `checks: GithubChecks {allRepositories: boolean | null,
    llmSecret}`, `suggestedOrgId`, `installUrl`}, `GithubAccountState`
    (`GET /app/api/me/github`). The web mock serves its three GETs on
    them (`contract.test.ts`, CHECKED).
- **For M8-01** (no import script yet, M1-06 is off the journal track):
  `organizations` → `github_organizations` (id kept; `status`
  `active` ⇒ `active`, `degraded` ⇒ `deleted`; `installation_id` NULL
  whatever classroom held, D23: the healing of M2-02 resolves Quiz's
  installation; `github_org_id`, `login`, `plan` copied);
  `classrooms.org_id` → `github_classroom_links` (`linked_by` = the
  remapped `teacher_id`, `linked_at` = the classroom's `created_at`);
  `users.github_*` → `github_accounts` for the rows with a
  `github_user_id`, on the remapped user (two classroom users merged into
  one Quiz user with two GitHub ids: report, keep the newer link);
  `webhook_deliveries`: the last 30 days, all processed at T0;
  `push_receipts`: `github_repo_id` from `student_repos.github_repo_id`
  (a receipt whose repository has none is dropped and counted), the id
  kept, `ON CONFLICT DO NOTHING`.

### M2-02 — Installations, org link, lazy healing
- **Depends on**: M2-01. ‖ M2-03.
- **Port from**: `C:modules/classrooms.ts` (setup URL, `GET /orgs`, the
  healing of §3.1).
- **Create**: `Q:modules/github/{routes,service,events}.ts`;
  `GET|PUT|DELETE /app/api/classrooms/:id/github` (connect / disconnect,
  staff only through `staffAccess`; the GET carries the checks of
  `05-web.md` §5.3 — installation and repository access, plan, LLM
  secret); `/setup/github/installed` (App JWT); audit `github_org.*`.
- **Org avatar**: an organization's avatar is served same-origin (fetched
  server-side and cached, or stored at installation), never loaded by the
  browser from github.com (privacy: the viewer's IP). The web's `OrgAvatar`
  (M1-04) takes that URL as `src` and shows the initials without one.
- **Tests**: healing, setup-URL idempotency, connect by a non-staff ⇒ 404.
- **Acceptance**: `invariant-reviewer` clean; routes 404 when no App.
- **Contracts** (M2-01): `GET /app/api/github/orgs` ⇒ `GithubOrg[]`;
  `GET /app/api/classrooms/:id/github` ⇒ `GithubClassroom`. This task
  writes the `PUT` body, `GithubConnectBody {orgId}` (strict), in
  `contracts/src/github.ts`. The avatar route is
  **`GET /app/api/github/orgs/:id/avatar`** (`:id` the row's uuid), the
  only value `GithubOrg.avatarUrl` accepts (`GITHUB_ORG_AVATAR_PATH`). Its
  source is derived from `github_org_id`
  (`avatars.githubusercontent.com/u/<id>`), or kept in a column this task
  adds if it chooses to store it.

### M2-03 — GitHub account linking
- **Depends on**: M2-01. ‖ M2-02.
- **Port from**: `C:auth/github-link.ts`, `currentLogin()` (#41).
- **Tests**: UNIQUE conflict ⇒ `?github=conflict`; unlink; refused under
  impersonation and delegated sessions (ADR-034, ADR-027); `github.renamed`;
  the token never stored nor logged.
- **Acceptance**: return to the `return` path, not `/`.
- **Contracts** (M2-01): the account's state is
  `GET /app/api/me/github` ⇒ `GithubAccountState {account, relevant}`
  (the route name the web mock serves, `?unlinked=1`). This task writes
  the callback's closed return, `GithubLinkOutcome` (`?github=linked |
  conflict | error`), in `contracts/src/github.ts`.
- **As delivered** (#403): `Q:auth/githubLink.ts`, registered in `app.ts`
  only while `githubApp(config)` is on (off ⇒ every route 404).
  - Routes: `GET /app/auth/github/link?return=`, `GET
    /app/auth/github/callback`, `GET` and `DELETE /app/api/me/github`
    (`DELETE` idempotent, 204). Link, callback and unlink take
    `ownSessionGuard` (`Q:modules/guards.ts`, the rule of Super Powers too,
    `ownPortalSession`): a delegated session or a Bearer token gets `403
    session_required`; a `seb`/`kiosk` one is nobody there (401, default
    deny).
  - `return`: `linkReturn` = `safeReturnTo`, and `/`, `/app/…` or anything
    refused ⇒ `/settings`. The callback appends `?github=` keeping the
    path's query and fragment; a bad, forged, foreign or expired state
    lands on `/settings?github=error` without calling GitHub. `return=` is
    masked in the request log like `next=`.
  - State: signed cookie `quiz_github_link` (Path `/app/auth/github`,
    HttpOnly, Lax, Max-Age 600) carrying `{nonce, userId, returnTo,
    expiresAt}`, the expiry checked on `app.clock`; cleared by every
    callback.
  - Through Octokit: `githubApp()` builds the App with its `oauth` client;
    `app.oauth.createToken`, a user Octokit for `GET /user`, then
    `app.oauth.deleteToken` sent without being awaited. The token is a
    local of `readAccount`; a failure is logged as `{name, status,
    message}` only (a `RequestError`'s request body holds the client
    secret, the code or the token). The callback's query is masked in the
    request log (`redact.ts`). Production refuses an App id without
    `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` (`config.ts`).
  - `linkedLogin(db, octokit, userId)` (an installation client): the
    login, or `GITHUB_ACCOUNT_STALE` (`@quiz/contracts`, `{error:
    "github_account_stale"}`, the 409 body) for a deleted account or no
    link; other failures throw. Nothing calls it yet (M3-03, M4-03).
  - `relevant` is staff of a classroom linked to an organization only;
    M3-01 adds "has or had a project" to `linkRelevant`.
  - Not ported: classroom's `inviteOnGithubLink()` (group repositories
    created before the link), which belongs to M3-03.
  - `github_accounts` belongs to `auth` (orchestrator's decision): written
    by `auth/githubLink.ts` only (link, unlink, rename), though its schema
    sits in `Q:db/github.ts`.


### M2-04 — Webhook intake, handler registry, delivery reconciliation
- **Depends on**: M2-02.
- **Port from**: `C:modules/webhooks.ts` (intake, installation and
  organization handlers), `reconcile.deliveries`, `purge.housekeeping`.
- **Create**: encapsulated raw-body plugin; HMAC; dedup; synchronous
  receipt hook (`onReceipt`) and event registry (`onEvent`) for the project
  and journal modules; queue `github.webhook`.
- **Tests**: port `webhooks.db.test` (401, duplicate ⇒ 200, installation
  deleted, org renamed/deleted); receipt written with `app.clock`.
- **Acceptance**: 200 in < 100 ms on a fixture; replay of an unprocessed
  delivery.
- **Schema** (M2-01): `webhook_deliveries` (insert `ON CONFLICT DO
  NOTHING` on `delivery_id`; `received_at` = `app.clock.now()`, no
  default; the purge nulls `payload`, never deletes the row) and
  `push_receipts` (keyed on `github_repo_id`, `ON CONFLICT DO NOTHING`
  keeps the first receipt).

### M2-05 — Periodic tasks (`scheduled_tasks`)
- **Depends on**: D10 (settled). ‖ M2-02…04. Landed before M1-02: the
  core carries Quiz's own housekeeping; the GitHub reconciliations join the
  catalog (`SCHEDULED_TASKS`, `SCHEDULED_TASK_KEYS`, en/fr names) with
  M3-06 and M2-04.
- **Port from**: `C:tasks.ts`, the `scheduled_tasks` table, its admin
  routes; onto `Q:ticker.ts` (claim + enqueue on `everyMs`).
- **Acceptance**: a task runs once across a restart; run-now; admin API
  under `requireAdmin`.

### M2-06 — Quiz's Apps (production, staging) and staging safety
- **Depends on**: M2-01, D23. ‖ M2-02…05.
- **Goal**: document the registration of Quiz's two GitHub Apps
  (`docs/development/github-app.md`: permissions of §3.4, events, URLs per
  environment) and create them (product owner's hands, both owned by the
  account that owns classroom's App; the staging App installed on a test
  organization only); secrets
  into the vault (ADR-010) and the two `.env`; `staging-refresh.sh` nulls
  `installation_id` (and archives projects); tasks no-op without an App (a
  test); ADR-028 note.
- **Schema** (M2-01): nulling `github_organizations.installation_id` is
  enough. It is the one column that says "installed" (`status` only says
  whether the organization exists on GitHub), and no CHECK ties it to
  another column, so the refresh touches nothing else.
- **Acceptance**: a staging refresh from a dump holding installations
  leaves no reachable production installation; the production App
  installed on one test organization answers the setup URL of
  `quiz.chevallier.io`.

### M2-07 — Web: the classroom's Settings tab, GitHub section, link card
- **Depends on**: M2-02, M2-03 (contracts), M1-04, M1-05, D24.
- **Goal**: the teacher classroom's **Settings** tab (rename, archive,
  delete and the drill switch move there from the header, D24); its GitHub section — "Connect this
  classroom to GitHub" sheet (org picker, install, live status) and the
  checks of §5.3; header badge; the user Settings GitHub card (shown only
  when relevant), return toast, palette entry. §5.3.
- **Checks** (M2-01): the installation line is derived from the
  organization (`installed`, `status: deleted`) and
  `checks.allRepositories`; the plan line from `org.plan` (`free` ⇒ the
  warning, null ⇒ unknown); the LLM secret line from `checks.llmSecret`.
  The API sends each fact once.
- **Scenes**: `classroom-settings`,
  `classroom-settings-github-connect|installed|checks-warn|org-missing`, `settings-github-linked|unlinked`.

## M3 — Projects

### M3-01 — `project` schema and contracts
- **Depends on**: M2-01, M1-01, D05.
- **Create**: `Q:db/project.ts` (§3.3 tables), one additive migration;
  `packages/contracts/src/project.ts`; `ActivitySummary` and `ResultCard`
  project variants; import-script steps for projects, milestones, repos,
  runs, bot commits, dispatches, reverts.
- **Acceptance**: migration on a dump copy; the partial uniques tested.

### M3-02 — Project lifecycle
- **Depends on**: M3-01, M2-02, D19.
- **Port from**: `C:modules/assignments/lifecycle.ts`, `actions.ts`,
  `github/squash.ts`, `github/studentize.ts`.
- **Create**: `Q:modules/project/{routes,service,lifecycle}.ts`; loaders
  `findAccessibleProject`; the `ActivityKind` implementation for projects;
  audit `project.*`.
- **Tests**: source missing, slug and squashed suffixes and cleanup, patch
  rules, publish, reopen, archive, 404 for non-staff; deletion leaves
  repositories.

### M3-03 — Acceptance and provisioning
- **Depends on**: M3-02, M2-03.
- **Port from**: `C:modules/student.ts` (accept), `github/provision.ts`,
  `github/collaborators.ts`, `C:repos.ts`.
- **Tests** (fake octokit): idempotent accept, `provision_in_progress`, an
  `ok` row survives a failure, teacher notified once, stale account ⇒ 409,
  renamed login followed, refused under impersonation.

### M3-04 — Ingestion and grading pipeline
- **Depends on**: M2-04, M3-03.
- **Port from**: the push / workflow_run / member / repository /
  pull_request handlers, `C:grading.ts`, reverts with cap.
- **Tests**: port `grading.db.test` and the rest of `webhooks.db.test`;
  bot commits ignored; GR-14.3.

### M3-05 — Deadline, freeze, dispatch, review checkpoints
- **Depends on**: M3-04, D13.
- **Port from**: `C:deadline.ts`, `C:dispatch.ts`, `github/lock.ts`,
  `github/commit.ts`, the ticker duties.
- **Create**: `PROJECT_TASKS` on `Q:ticker.ts` (claim + enqueue only).
- **Tests**: port `deadline.test`, `dispatch.test`, `dispatch.db.test`;
  TestClock: single claim, rescheduling between sweep and run, 404
  terminal, archive fallback, idempotent commit strategy, freeze at
  deadline + grace, ledger, **no HTTP inside a tick**.

### M3-06 — Reconciliation of grades and repositories
- **Depends on**: M3-04, M2-05. ‖ M3-05, M3-07.
- **Port from**: `reconcile.grades`, `reconcile.repos`.

### M3-07 — Sync of the source repository
- **Depends on**: M2-04, M3-02, D12. ‖ M3-05, M3-06.
- **Port from**: `C:sync.ts`, `github/sync.ts`.
- **Tests**: new (classroom has none): fake octokit + a local bare repo.

### M3-08 — Teacher views, grades, release
- **Depends on**: M3-04, M3-05.
- **Port from**: `C:modules/assignments/detail.ts`, grade history,
  override, validate ⇒ release; the live-state cache (#37/#40).
- **Tests**: port `grades.db.test`; a deleted repo never calls GitHub; a
  rate-limited detail returns stored state at once.

### M3-09 — Student side, SSE, notifications
- **Depends on**: M3-04, D18. ‖ M3-08.
- **Goal**: student project cards (home and classroom payload), the project
  student view (single exit), `course:` + `user:` topics, notification
  kinds with ADR-030 defaults and templates (en/fr), one Teams manifest bump.
- **Tests**: a student never receives another student's repo or grade hint;
  leak test of the project student view.

### M3-10 — Web: projects in Activities, "New ▾"
- **Depends on**: M3-01 contracts, M1-05. ‖ M3-11.
- **Goal**: the classroom's Activities tab and `/activities` list projects;
  "New ▾" (Evaluation, Poll, Project) with the GitHub gate (opens M2-07's
  sheet first).

### M3-11 — Web: new project form
- **Depends on**: M3-02 contracts, M2-07. ‖ M3-10, M3-12.
- **Goal**: redesign of `AssignmentForm` (sheet or stepped page, decided in
  the PR's challenge step), novice/expert split (spec 08).

### M3-12 — Web: project page
- **Depends on**: M3-08 contracts. ‖ M3-11.
- **Goal**: redesign of `AssignmentDetail` in sections; grade history and
  override inside. Scenes `project`, `-grades`, `-sync-banner`.

### M3-13 — Web: student `ProjectRow`
- **Depends on**: M3-09 contracts, M2-07.
- **Goal**: the four-state onboarding of §5.3 on the student home (and the
  classroom page once M5-02 lands).
- **Scenes**: `-unlinked`, `-accept`, `-invitation-pending`, `-ready`; the
  default `student-home` unchanged.

### M3-14 — Pilot and load test
- **Depends on**: M3-01…13, M2-06.
- **Goal**: on staging with the staging App: walk classroom's user stories
  end to end; 100 repositories at a deadline applied in < 5 min; tick
  duration measured with 100 due projects.
- **Output**: a short report in the PR; findings as tasks.

### M3-15 — Groups (API)
- **Depends on**: M3-03.
- **Port from**: `C:modules/assignments/groups.ts`, `C:group-repos.ts`,
  `inviteOnGithubLink`; the org pre-removal hook in
  `Q:modules/org/service.ts`.
- **Tests**: port `groups.db.test` (22) and `group-repos.db.test` (21).

### M3-16 — Groups (web)
- **Depends on**: M3-15, M3-12.
- **Goal**: `/projects/:id/groups` (port of `GroupsPage`).

## M4 — Journal

### M4-01 — Renderer package, journal schema and contracts
- **Depends on**: M1-01, D03, D14, D15. ‖ M2.
- **Create**: `packages/docrender` (`renderPage`, `journalTree`,
  `journalRepoName` on `@quiz/domain`'s `repoName` (I17), the code tokenizer — Quiz's `apps/web/src/markdown/highlight.ts`
  then imports it); `Q:db/journal.ts` in the shape of `04-journal.md`
  §4.2 (one row per classroom, D03); `packages/contracts/src/journal.ts`
  (warnings as codes). No import step (written by M8-01, `01-strategy.md`
  principle 3).
- **Tests**: port `render.test`; journal tree tests.

### M4-02 — Journal read side and ingestion
- **Depends on**: M4-01, M2-02, M2-04.
- **Port from**: `C:journal/ingest.ts`, `C:journal/repo.ts`, the read
  routes and asset route of `C:modules/journal.ts`.
- **Create**: the journal's routes on `readableClassroom` (created by
  M5-01: student payload for impersonation whatever it asks, and for the
  staff only on an explicit request that narrows, 05 §5.7), passing
  `studentView` from a `?view=student` query schema of the contracts; fixes
  J1–J4 of §4.3; webhook registration; queue `journal.ingest`.
- **Move**: the `hasJournal` read of the student's classroom page
  (`activity/service.ts`, M5-01) into `modules/journal/service.ts`.
- **From M4-01**: ingestion stores `cleanSource(md)` (no NUL) as
  `markdown`, and renders each page twice (`html_staff` with every page in
  `ctx.pages`, `html_student` with the student-visible ones only,
  `04-journal.md` §4.2); the asset route is registered on
  `JOURNAL_ASSETS_PATH(":id")` of the contracts. On top of N-SEC-13's CSP
  and `nosniff`, the asset route serves an SVG with
  `Content-Security-Policy: sandbox` (or `Content-Disposition: attachment`),
  so a committed SVG opened directly runs nothing.
- **Tests**: port `ingest.db.test`, `journal.db.test`; a student cannot
  fetch an asset referenced only by a draft page; two concurrent ingests
  converge; an SVG asset carries the sandbox (or attachment) header.

### M4-03 — Journal writes
- **Depends on**: M4-02, M2-03.
- **Goal**: create (no adoption, suggested name), use an existing
  repository of the classroom's organization (root path honoured), remove
  (the repository is kept), refresh, preview, save with `baseSha`, add,
  delete, upload (committed into the repository); invitations to course
  staff with a linked login.
- **Contracts**: M4-01 shipped only the read half of
  `packages/contracts/src/journal.ts`; the write bodies move here, to be
  shaped by their handlers (lean review of #371): the repository name, the
  branch, the root folder, `JournalCreate`, `JournalUse`, the name-taken
  409 with its suggestion, the error codes, the refresh result, the
  preview body and payload, `baseSha` (a blob sha), the save body and
  result, the add-a-page body, the created-file payload, the markdown size
  cap (500 000). Hardening already designed in #371, to write again:
  a branch refuses a leading `-`, `..` anywhere, an empty segment (`//`,
  a leading or trailing `/`), a segment starting with `.` (so `.` and
  `/./`) and a `.lock` ending; the root folder is trimmed of surrounding
  slashes, capped at `JOURNAL_PATH_MAX` and must pass `safeJournalPath`.

### M4-04 — Web: journal reader
- **Depends on**: M4-02 contracts, M1-04, M1-05. ‖ M4-05, M5-02.
- **Note**: students reach the reader only through the student classroom
  page (M5-02); a journal is live for students once both are merged.
- **Scenes**: `journal-student`, `-phone`, `-teacher-hidden`, `-empty`,
  `-not-found`.

### M4-05 — Web: the Journal section of Settings, the teacher journal tab
- **Depends on**: M4-03 contracts, M2-07, D24.
- **Goal**: the Journal section of the classroom's Settings (create, use a
  repository, sync state, Refresh, remove); the Journal tab, present only
  when the classroom has a journal.
- **Reader** (from M4-04): the reader ships with no staff action. This task
  adds **Refresh** (secondary) to the reader's header, in
  `ReaderHeader`'s `aside` beside the sync state, and invalidates
  `journalKey(id, view)` on success; it words the "no page yet" hint for
  the staff again once Refresh exists.
- **Scenes**: `classroom-settings-journal-none|create|use|set`,
  `journal-tab-pages`, `-sync-error`.

### M4-06 — Web: the journal's WYSIWYG editor
- **Depends on**: M4-05, D25.
- **Goal**: Quiz's markdown editor (`apps/web/src/markdown/`) on a
  journal page, source mode beside it; front matter as fields; image
  upload committed into the repository with a relative path; save with
  `baseSha`, conflict kept as a draft.
- **Reader** (from M4-04): this task adds **Edit** (the primary action,
  inside a page) to the reader's header, in `ReaderHeader`'s `aside`, and
  swaps the article for the editor.
- **Tests**: the five conditions of D25 — the round trip over the journals
  of classroom's production (fetched read-only with classroom's App, into a
  fixture kept outside this public repository, as the exam corpus is; the
  committed test runs on a synthetic journal and skips the real one when
  absent), front matter, images, relative links and KaTeX, no write of
  an unedited page.
- **Scenes**: `journal-edit`, `-source`, `-conflict`.

## M5 — Student classroom page and gradebook

### M5-01 — API: the student's classroom
- **Depends on**: M1-03 (projects and journal plug in when they land).
- **Goal**: `GET /app/api/student/classrooms` (the Courses list) and
  `GET /app/api/student/classrooms/:id` — header, activities by section
  through `ActivityKind.studentCards`, `hasJournal`, `hasProjects`; loaded
  by the student's own enrollment (404 otherwise).
- **Tests**: leak test (no draft, no other student's data); 404 matrix.
- **As delivered** (#377): payloads in `contracts/src/student.ts`;
  `readableClassroom(app, req, reply, params, { studentView })` in
  `modules/guards.ts`, its rule the pure `classroomPayload`.

### M5-02 — Web: student classroom page
- **Depends on**: M5-01, D07.
- **Goal**: §5.2 — the Courses route (sidebar and bottom bar, D07), the
  classroom page (Activities, Journal tab when present), pressable home
  cards; Grades stays an anchor of the home until M5-04.
- **Scenes**: `student-courses`, `student-classroom`, `-journal`,
  `-empty`, `-error`, phone and desktop.

### M5-03 — Gradebook module
- **Depends on**: M3-08, D06.
- **Create**: `Q:modules/gradebook/` owning `gradebook_columns` (nullable
  `evaluation_id` / `project_id` + CHECK exactly one, weight, position);
  `packages/domain/src/gradebook.ts` (weighted mean); teacher Grades API,
  CSV/xlsx (staff rows dropped, ADR-018 §5).
- **Tests**: equals per-evaluation results on the seeded world; only
  released grades; polls never.

### M5-04 — Web: Grades tabs
- **Depends on**: M5-03.
- **Goal**: teacher Grades tab (Export primary); the student Grades tab
  reads the gradebook when enabled.

## M6 — Online workspace and SEB (after the cutover if D09 says so)

### M6-01 — HS256 and codespace contracts
- **Depends on**: D09. ‖ M6-02, M6-05.
- **Goal**: `hs256` into `packages/domain`; codespace contracts (zod) into
  `packages/contracts`; both issuers accepted; optional `seb` claim.
- **Acceptance**: a token signed by classroom's current code verifies
  (fixture).

### M6-02 — `packages/seb`
- **Depends on**: D21. ‖ M6-01.
- **Goal**: §6.3 point 1; Quiz's `auth/seb.ts` moved onto it.
- **Acceptance**: Moodle vectors and the 201-key vector pass; the Quiz
  `.seb` bytes and Config Key identical before/after (snapshot);
  `seb.db.test` route sweep unchanged.

### M6-03 — Import `apps/codespace`
- **Depends on**: M6-01.
- **Goal**: `@quiz/codespace`, Node 24, nested `CLAUDE.md` and docs,
  `PLATFORM_URL` with alias; unit tests in CI; classroom ADR-013 already
  imported as ADR-047 (M0-03).
- **Acceptance**: package build/typecheck/test; the app image contains no
  codespace; `invariant-reviewer` does not flag the sanctioned divergences.

### M6-04 — Codespace CI/CD
- **Depends on**: M6-03.
- **Goal**: artifact per sha, engine-VM dispatcher shared with the runner,
  production deploy guarded by live sessions, `push.sh` for bootstrap only;
  the image supply-chain rule settled.

### M6-05 — Engine VM capacity, hygiene, seccomp
- **Depends on**: D09. ‖ M6-01…04.
- **Goal**: resize; cgroup slices; host nft `input` drop policy; mask
  `/launch?token` in Caddy's log; daily off-VM backup (volumes + SQLite);
  seccomp convergence (keep `ptrace`); `deployment.md` §3.
- **Acceptance**: grading stays within `RUNNER_TIMEOUT_MS` with N sessions
  live; one restore performed; gdb breaks and steps; `unshare -r` fails.

### M6-06 — Quiz `codespace` module
- **Depends on**: M6-03, M3-02.
- **Goal**: config and refusals, sync job, start route, resync, sessions
  summary, per-teacher grants and quota (admin), audit, en/fr, loaders.
- **Acceptance**: routes 404 when `CODESPACE_URL` is empty; neither token
  nor BEK in the audit nor any student payload; `pnpm smoke` start step
  against a stub portal.

### M6-07 — SEB for projects
- **Depends on**: M6-02, M6-06.
- **Goal**: §6.3 points 2–5.
- **Acceptance**: route sweep covers project routes; `/launch` refused in
  exam mode without a valid header; `simulated` impossible in production;
  **proof B recorded** before the first SEB project.

## M7 — Finishing

### M7-01 — Palette, help, tours
- **Depends on**: the screens they point to.

### M7-02 — User guide
- **Goal**: guide pages for projects, the journal, GitHub setup (teachers,
  students); screenshots in both themes.

## M8 — Migration and cutover

### M8-01 — Import script complete
- **Depends on**: every schema task (M2-01, M3-01, M4-01, M5-03, M6-06 if
  in scope), D11.
- **Goal**: the whole order of §2.5, the verification report, the legacy
  audit table, pre-flight checks.
- **Acceptance**: dry-run on the synthetic fixture and on a staging copy of
  a production dump: parity report clean.

### M8-02 — Legacy URL resolver
- **Depends on**: M8-01 (id map), M3-12, M4-04.
- **Goal**: `/legacy/classroom/*` for every row of §6.6.
- **Acceptance**: a table-driven test per row; targets load under
  `staffAccess`.

### M8-03 — Caddy fragments
- **Goal**: `infra/caddy/classroom-maintenance.caddy`,
  `classroom-redirect.caddy`, a curl matrix script. **M8-03b** only if the
  rehearsal exceeds 2 h: a read-only flag in classroom (the one change made
  in the classroom repository).
- **Acceptance**: `caddy validate`; the script asserts status and
  `Location` of every pattern.

### M8-04 — Codespace identity remap (if M6 is in scope)
- **Acceptance**: on a copy of the portal DB and volumes, one real session
  resumes with its files.

### M8-05 — Cutover runbook
- **Goal**: `docs/development/deployment.md` gains the cutover chapter
  (§6.5, §6.7): T0 checklist, commands, rollback table, App steps, secrets,
  go/no-go criteria.

### M8-06 — Rehearsal
- **Depends on**: M8-01…05, D22.
- **Goal**: on staging (`srvstg`) with the staging App and a fresh
  production dump of both databases: the whole of §6.5 C, timed.
- **Acceptance**: parity report clean; timings recorded in `PROGRESS.md`;
  go/no-go written.

### M8-07 — The cutover
- **Who**: the product owner, with an agent following the runbook.
- **Depends on**: M8-06 go, D20.

## M9 — Decommission

### M9-01 — Point of no return and decommission
- **Goal**: §6.5 E; redirects to 301; issue #143 closed.

## L — After the merge

- **L-01** Platform `llm` module (qt-rich, the `short` LLM matcher,
  projects).
- **L-02** Runner grading of a project (tarball at the frozen sha, size
  cap, toolchain images, network closed).
- **L-03** `packages/ui-kit` extraction (what ADR-029 wanted, as a
  workspace package).
- **L-04** WYSIWYG journal editor (RichText adapter: repository-path
  images, no markdown normalisation, round-trip tests).
- **L-05** Project templates at course level.
