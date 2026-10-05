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
- **Goal** (narrowed by the product owner, 2026-10-01, D08 addendum):
  `Q:apps/api/scripts/import-classroom.ts` per §2.5 — read-only source
  connection, mapping file schema (zod), `--dry-run` (default) / `--apply`,
  `import_classroom` schema (`id_map`, `runs`), a readable report; steps:
  users (the cascade of §2.4), addresses, claims, avatars, teacher grants,
  GitHub account links (spec 06 no. 45), course staff seats, enrollments
  merged into the mapped rosters, role recompute; mapping validation with
  the organization check. **No course and no classroom is created** (D22):
  each source classroom maps to an EXISTING Quiz classroom (course code +
  classroom name) or is dropped, and a mapped classroom must already be
  connected to the organization its source classroom used. Login adoption
  in `Q:auth/login.ts` + its ADR (D08: required).
- **Fixture**: `apps/api/scripts/fixtures/classroom-seed.sql`, synthetic,
  anonymised, on classroom's own schema (its migrations, concatenated).
- **Tests** (`*.db.test.ts`): import into PGlite; second run writes
  nothing; merge into an existing classroom; a duplicate identity is
  reported, not merged silently; an unconnected or wrong-org classroom
  refused; a dropped classroom's users not imported; GitHub link cases;
  login adoption (each key, ambiguity, concurrency, never a
  non-`classroom:` row).
- **Acceptance**: dry-run report readable; no write outside the target DB.
- **Stays with M8-01**: projects, journals, webhooks, the legacy audit,
  the parity report, the codespace, and the pre-flight checks on the
  source's state (stopped, queues empty, deadlines). M1-06 alone switches
  nothing (spec 06 no. 46: the complete import is the switch).
- **As delivered** (branch `merge/M1-06-import-identity`): ADR-061 (login
  adoption: `auth/adoption.ts`, audits `auth.account_adopted`,
  `auth.adoption_ambiguous`); migration `0053_import_classroom` (the
  schema; no index on `swiss_edu_id`, ADR-061 §7); `importAccountLink` in
  `auth/githubLink.ts`; the script under `apps/api/scripts/` (run with
  `pnpm --filter @quiz/api import:classroom`; `--actor <admin e-mail>`
  names the account recorded on the run and on grants whose creator is not
  imported). `--apply` refuses while the report holds a refusal (mapping
  incomplete or unresolved, a classroom not connected or connected
  elsewhere, an ambiguous identity, an inconsistent source) or while an
  open decision is not given: `--assistants staff|skip` (open item 4) and
  `--missing-students enroll|report` (open item 3). A matched account's
  avatar is Quiz's (profile), its claims the newer snapshot.
  - The identity rule is ONE pure function, `decideMatch` of `@quiz/domain`
    (`identityMatch.ts`), used by the import and by the adoption; a
    private address must have exactly one verified holder in the whole
    database; a placeholder carrying a `swiss_edu_id` is adopted through
    that key only; a login whose `sub` starts with `classroom:` is refused.
  - Left out: heig-classroom's `dev:` accounts (their placeholder would be
    adoptable by address); of an anonymized account, its addresses, claims
    and avatar (classroom's anonymization never cleared them).
  - Writes go through the owners' writers: `addAddresses` and
    `recordIdpClaims` (`auth/claims.ts`), `importAccountLink`,
    `createTeacherGrant` (`modules/admin/service.ts`), `addStaff`, and
    `claimLines` (`modules/org`, the roster's own claim pass). The steps are
    `scripts/import-classroom/steps.ts`.
  - Decided at review (ADR-061 §8): `--actor` is required and an admin;
    a grant is imported only on a verified address of an imported person.

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
- **As delivered** (#404): `Q:modules/github/{routes,service,events}.ts`,
  registered in `app.ts` only when `githubApp(config)` is non-null (as the
  kiosk plugin), so without an App no route exists. Choices the next tasks
  inherit:
  - Routes: `GET /app/api/github/orgs` and
    `GET /app/api/github/orgs/:id/avatar` (teacher role, 403 otherwise);
    `GET|PUT|DELETE /app/api/classrooms/:id/github` (session +
    `accessibleClassroom`: 404 off the staff; PUT answers the
    `GithubClassroom`, DELETE 204; 409 `journal_attached` (D28) or
    `app_not_installed`, `GITHUB_CONNECT_REFUSALS`, worded in `api.ts`);
    `GET /setup/github/installed` (`GithubSetupQuery`; 303 to
    `/classrooms/<state>/settings` when `state` is a uuid, `/` otherwise;
    20 per 10 min per address, then 429).
  - The healing is cached in memory `HEAL_TTL_MS` (60 s) per organization;
    the setup return drops it. The listing is not cached and is
    authoritative: an installation GitHub no longer lists is cleared.
  - `recordInstallation(db, installation, via)` (service) is the one writer
    of an installed organization: M2-04's `installation` handler calls it.
    It matches by `github_org_id`, by login only a row without one (an
    import), and never takes over a row holding the login under another
    id: that row is marked `deleted`, its login moved aside (I66).
    Adapters: `listInstalledOrgs`, `resolveOrgInstallation` and the new
    `fetchInstallation` return `AppInstallation`; an optional `ReadOptions`
    (`HTTP_READ` = `noRateLimitWait`) on the HTTP-read adapters.
  - Avatar derived, not stored: fetched from `avatars.githubusercontent.com`
    (`redirect: "error"`, 5 s, `AvatarMime` whose bytes match, 256 KB cap
    through `readCapped` of `cappedBody.ts`), cached in memory 24 h; a
    failure is not kept.
  - Test support for M2-04: `github/testing.ts` (the App key, the fake
    GitHub, `orgsRoute`); `auth/testing.ts` (the seb and impersonation
    sessions of the route walks, used by `seb.db.test.ts`,
    `impersonation.db.test.ts` and `modules/github/walks.db.test.ts`).
  - Audit: `github_org.link|unlink|installation_resolved|installation_deleted|renamed|deleted`.
  - SSE: the setup return hints `classrooms` on `course:<id>` (the linked
    classrooms' courses and `state`'s), never `classroom:`.

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
  - `relevant` is staff of a classroom linked to an organization only
    (M2-08 adds a claimed seat in one); M3-01 adds "has or had a project"
    to `linkRelevant`.
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
- **As delivered** (#407): `Q:modules/github/{deliveries,handlers,jobs}.ts`,
  the route in `routes.ts`.
  - `POST /webhooks/github`, in a child plugin of the module (no
    `fastify-plugin`) whose only body parser is a `*` buffer parser;
    `config: { sessions: [] }`, so a cookie sent along is ignored. In
    order: `verifySignature` over the raw bytes (401 `bad_signature`,
    nothing parsed nor stored); `GithubWebhookHeaders` of the contracts
    (`x-github-delivery` a `z.guid()`, `x-github-event` required; 400
    `bad_headers`); the body a JSON object (`GithubWebhookBody`; 400
    `bad_body`); one transaction inserting `webhook_deliveries` `ON
    CONFLICT DO NOTHING` (`received_at` = `app.clock.now()`) and, for a
    push on a tracked repository, `push_receipts` (the first kept); a
    duplicate answers 200 `{ ok, duplicate: true }` and runs nothing; then
    `github.webhook { deliveryId }` and 200. Without a queue the delivery
    runs beside the request, not awaited; a failed enqueue is logged and
    still answered 200 (the reconciliation replays it).
  - Registry (module-global sets, idempotent, reached through
    `modules/github/service.ts`): `onEvent(event, handler)` with
    `WebhookHandler = (app, config, delivery: WebhookDelivery) =>
    Promise<void>` (`delivery` = `{deliveryId, event, action, payload,
    receivedAt}`), and `onReceipt(tracks)` with `ReceiptTracker = (tx,
    githubRepoId) => Promise<boolean>`: the project module (M3) says which
    repositories it tracks; `github` writes the receipt (its table),
    `isBot` for `<slug>[bot]` and `github-actions[bot]`.
  - Worker `processDelivery`: every handler of the event in order, then
    `processed_at` (`app.clock`); a throw stores `redactTokens(error)` and
    throws a NEW error with that masked text only (no `cause`: pg-boss
    stores what a job throws); every log of a failure is masked too. Queue `github.webhook` (`jobs.ts`): `standard` policy, no
    dedupe (a processed delivery is a no-op), `retryLimit: 5`, backoff from
    30 s; registered in `app.ts` only with an App.
  - Handlers: `installation`, whatever the action, re-reads the
    installation from GitHub (`resyncInstallation`: `fetchInstallation`,
    then `recordInstallation(…, "webhook")`, or forgotten when gone or
    suspended), so a stale event replayed out of order cannot undo a later
    one; a suspended installation counts as not installed everywhere
    (`orgInstallation`); `installation_repositories`
    (drops the healing: `allRepositories` is not stored),
    `organization` (`renamed` → `renameOrg` by id, retiring a row holding
    the new login; `deleted` → `markOrgDeleted`). Each hints `classrooms`
    on the linked courses. No new audit action: the `github_org.*` ones
    carry `via: "webhook"`. Classroom's rewrite of `<org>/` names on a
    rename is the project module's own `organization` handler (M3).
  - Scheduled tasks (`GITHUB_TASKS`, catalog): `reconcile.deliveries`
    (daily, nothing without an App: local deliveries unprocessed for 30
    min, past the queue's ~15 min of retries, replayed one at a time
    without a queue, 200 at most;
    GitHub's failed attempts of 24 h redelivered, 50 at most, skipping a
    guid already stored) and `deliveries.purge` (daily: payload nulled 30
    days after receipt once processed; the row stays).

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
- **As delivered** (#408): `classroomSettings` left `CLASSROOM_PAGES` (it
  parses in every build) and renders `ClassroomView routeTab="settings"`:
  a tab that is a route is an entry of `ROUTE_TABS` (`ClassroomView.tsx`),
  the others stay `?tab=`; M4-05 adds the Journal there. What the next
  tasks inherit:
  - `Q:apps/web/src/ClassroomSettings.tsx`: sections Classroom (Rename in a
    one-field dialog, the drill switch — `ClassroomDrillSetting` is now a
    bare `SettingRow`), GitHub, **the Journal slot (M4-05) — a comment
    between GitHub and "Archive and delete"**, then Archive / Delete (both
    `secondary`; Delete confirms `danger`). The header lost its overflow
    menu and its rename-in-place; it keeps the name, the period (still a
    dialog) and, when connected, an org badge.
  - `Q:apps/web/src/github/`: `api.ts` (`useClassroomGithub`,
    `useGithubOrgs`, `useGithubAccount`, `githubAbsent` = the 404 of a
    platform without an App ⇒ no GitHub drawn, `githubLinkHref(returnTo)` —
    M3-13's "Link my GitHub account" uses it), `checks.ts` (the three lines,
    pure), `ClassroomGithub.tsx` (section + connect sheet; M3-11's "New
    project" on an unconnected classroom opens the same sheet by
    `?connect=1` on `/classrooms/:id/settings`), `AccountCard.tsx`,
    `linkReturn.ts` (`useGithubLinkReturn`, mounted once in `App.tsx`).
  - Keys `classroomGithubKey` (under `classroom`), `githubOrgsKey` (root
    `github`, added to the `classrooms` hint's roots), `meGithubKey` (under
    `me`). Palette: `classroom-github-connect` through `useScreenCommands`.
  - Mock: PUT/DELETE of the link, `?ghwarn=1`, `?ghmissing=1`; a disconnect
    of PRG1-2026 under `?journal=1` answers `409 journal_attached`.

### M2-08 — Student link from Settings, login on the roster
- **Depends on**: M2-03, M2-07. Product owner, 2026-10-01: students may
  link before any project, discreetly.
- **Goal**: the user Settings card is also relevant to a student with a
  claimed seat in a classroom connected to GitHub (F-GH-05); no banner,
  no nudge, no line telling the student the staff see the login. The
  teacher roster shows each linked student's login (GitHub icon + login)
  when the classroom is connected (05-web §5.1).
- **As delivered**: `linkRelevant` (`auth/githubLink.ts`) is staff of a
  connected classroom UNION a claimed seat in one (M3-01 still adds "has or
  had a project"); `RosterEntry.githubLogin` (`rosterView`, joined from
  `github_accounts` only when `github_classroom_links` holds the
  classroom: the stored login, followed on rename, never fetched per
  read); the web shows it under the e-mail (the table stays at seven
  columns). The classroom detail is a staff-only route, so no student
  payload carries it.

## M3 — Projects

### M3-01 — `project` schema and contracts
- **Depends on**: M2-01, M1-01, D05.
- **Create**: `Q:db/project.ts` (§3.3 tables), one additive migration;
  `packages/contracts/src/project.ts`; `ActivitySummary` and `GradeRow` (ex-`ResultCard`)
  project variants. The import-script steps for these tables moved to
  M8-01 (product owner and orchestrator, 2026-10-01): this task is schema
  and contracts only, and the schema accepts imported rows as they are.
- **Acceptance**: migration on a dump copy; the partial uniques tested.
- **As delivered** (branch `merge/M3-01-project-schema`): migration
  `0054_project` (nine `CREATE TABLE`). What M3-02…M3-16 inherit:
  - **Tables** (`Q:db/project.ts`): `projects`, `project_checkpoints`,
    `project_groups`, `project_group_members`, `project_repos`,
    `project_grade_runs`, `bot_commits`, `grade_dispatches`, `reverts`;
    classroom's columns under §7.4's words (`distribution_*`,
    `review_dispatched_at`, `released_at/by`, `review_grade_run_id`,
    `project_grade_runs.points/max/kind` `ci`|`review`,
    `grade_dispatches.trigger` `deadline`|`checkpoint` + `checkpoint_id`,
    children's FK `repo_id`; shas `text`). New: `projects.org_id` (copied
    from the classroom's link), `grading_scale` (no default),
    `created_by`; `project_repos.released_points/max` (the release's
    snapshot), `protection_suspended_at`. Codespace columns and
    `work_mode` dropped (D09). No default on `accepted_at`,
    `completed_at`, `reverts.created_at` (services write
    `app.clock.now()`); ids `randomUUID()` (Quiz has no UUID v7 helper).
    Cascades per D19; nothing in `github` is reached by a deletion.
  - **Contracts** (`packages/contracts/src/project.ts`): the closed `as
    const` lists the schema uses, `ProjectGradingScale` (`linear` |
    `score_is_grade`, the shared `Rounding`), `ProjectActivitySummary`,
    `StudentProjectCard`. `ActivityKindName`, `ActivitySummary`,
    `StudentActivityCard` carry the project member; `GradeRow` is a union
    of `EvaluationGradeRow` and `ProjectGradeRow` (`{kind, projectId,
    title, date = released_at, status: "released", score: {points,
    totalPoints, grade}}`, only after the release, never the source,
    comment or repository, N-SEC-20). Each route's bodies come with its
    task (cards M3-02, M3-03, M3-05, M3-08).
  - **`projectActivity`** (`Q:modules/activity/project.ts`) is in `KINDS`
    and lists nothing (M3-02 fills it). The web draws no project in the
    Activities section nor on the student's classroom page (M3-10,
    M3-13); the student's Grades draws a released project row.
  - **`projectGrade`** (`@quiz/domain`): score → grade by the project's
    scale, `fellBack` when `score_is_grade` meets a maximum other than 6.
  - `linkRelevant` (`auth/githubLink.ts`) counts a project repository of
    one's own or of one's group.

### M3-02 — Project lifecycle
- **Depends on**: M3-01, M2-02, D19.
- **Port from**: `C:modules/assignments/lifecycle.ts`, `actions.ts`,
  `github/squash.ts`, `github/studentize.ts`.
- **Create**: `Q:modules/project/{routes,service,lifecycle}.ts`; loaders
  `findAccessibleProject`; the `ActivityKind` implementation for projects;
  audit `project.*`.
- **Tests**: source missing, slug and squashed suffixes and the adoption of
  an empty leftover (no cleanup on GitHub, ADR-062), patch rules, publish,
  archive (the reopen moved to M3-05), 404 for non-staff; deletion leaves
  repositories.
- **From M3-01**: deleting a project (or its classroom) cascades every
  `project` row but never reaches `push_receipts`, which is `github`'s and
  keyed on GitHub's repository id: the deletion purges the receipts of its
  repositories through a `github` service function (N-DATA-03). Fill
  `projectActivity` (`Q:modules/activity/project.ts`) and write
  `grading_scale` (`defaultProjectGradingScale()` unless the body sets one).
  Write `ProjectCreate` and `ProjectPatch` (heig-classroom's zod rules, a
  strict body, no work mode) and the lifecycle's error codes
  (`unassigned_students`, `strategy_frozen`, `publish_mode_frozen`,
  `source_not_found`, `distribution_failed`, `duplicate_slug`) in
  `contracts/src/project.ts`. Define the column defaults (`grace_minutes`
  30, `squash`, `lock`, `auto`, `manual`) once, as named constants used by
  both the schema's `.default()` and the zod `.default()`.
- **Decided for it** (product owner and orchestrator, 2026-10-02): nothing
  is ever deleted on GitHub, the row is inserted before the build
  ([ADR-062](../adr/ADR-062-depot-de-distribution.md)); the source, branches
  and source strategy are fixed at creation (F-PROJ-03 amended); projects
  open to every teacher now (D26 addendum); the reopen moved to M3-05; the
  git runner asynchronous.
- **As delivered** (branch `merge/M3-02-project-lifecycle`). What M3-03…M3-11
  inherit:
  - **Routes** (`Q:modules/project/routes.ts`, registered only with an App
    configured, every body a strict schema of `contracts/src/project.ts`):
    `GET /app/api/classrooms/:id/projects[?archived=1]` →
    `ProjectActivitySummary[]` (drafts included; the archive instead when
    asked) — M3-10's contract; `POST` same path, `ProjectCreate` → `201
    ProjectSummary`; `GET …/projects/sources` → `ProjectSourceRepo[]` (the
    organization's repositories, `-squashed[-N]` and archived ones left
    out) and `GET …/projects/sources/:repo` → `ProjectSourceDetail`
    (branches, the default branch's tree capped at 800, `suggestedProtected`
    among `PROTECTED_FILE_SUGGESTIONS`) — M3-11's browser; `GET|PATCH|DELETE
    /app/api/projects/:id` (`ProjectPatch` → `ProjectSummary`; delete 204);
    `POST /app/api/projects/:id/{publish,archive,unarchive}` →
    `ProjectSummary`.
  - **Access** (`guards.ts`): `findAccessibleProject(db, caller, id)`
    (projects → classrooms → courses, `accessWhere(staffAccess)` in the
    WHERE) and `accessibleProject`, `projectsClassroom` — the caller's own
    portal session only (`ownPortalSession`): an impersonation, a Bearer
    token, a student, a teacher off the staff get the 404; a `seb` or
    `kiosk` session is nobody (401).
  - **Services** (`Q:modules/project/service.ts`): `createProject`,
    `patchProject`, `publishProject(db, id, now, actor)` — the ticker
    (M3-05) calls it with `SYSTEM_ACTOR` (`audit.ts`), audited
    `project.auto_publish` —, `setProjectArchived`, `deleteProject`,
    `unassignedStudents` (claimed non-staff seats in no group),
    `projectSummary`, `classroomProjects`, `teacherProjects`, `listSources`,
    `sourceDetail`, and `fetchSource` (`sources.ts`), the ONE reading of a
    source the creation and the browser share: in the classroom's
    organization by its immutable id, never a distribution repository (by
    name or held by a project). Refusals `ProjectError` (`errors.ts`, codes
    `PROJECT_REFUSALS`, statuses there); `unassigned_students` carries
    `students`, `source_not_found` may carry `branches` (no response schema
    yet: M3-11). The classroom's installation is the `github` module's
    `classroomInstallation(db, classroomId)` (follow-up: the journal's
    `targetOf` in `journal/writes.ts` could use it too).
  - **Distribution** (ADR-062): the row claims the repository (partial
    UNIQUE `projects_distribution_repo_uq`, migration `0056`) before
    anything is pushed, and gets its `distribution_full_name` only once it
    is built: that name is the mark `publishProject` requires
    (`distribution_missing`) — M3-05's auto-publish and M3-09's accept read
    the same mark. `createSquashedRepo` takes a `claim` callback and never
    adopts a public leftover. `repoWorld()` can refuse or stall pushes
    (`refusePushes`, `stallPushes` + `release`).
    `actorOf(req)` / `SYSTEM_ACTOR` in `audit.ts`, the tracer's actor rule
    for a service that audits itself.
  - **Patch rules** are `projectFieldRefusal` / `editableProjectFields`
    (`@quiz/domain`), `ProjectSummary.editable` the list for the form: a
    draft changes everything; once published, the name, the protected files,
    the deadline (while not applied; `422 deadline_past` at or before now)
    and the deadline strategy (until the deadline, `strategy_frozen`);
    publication mode and duration `publish_mode_frozen`; the start, grace,
    grading mode and scale, group mode and size `not_draft`. An unchanged
    value (`isDeepStrictEqual`) is never refused. `patchProject(db, id, …)`
    and `publishProject` both re-read the row FOR UPDATE in their
    transaction. The J−n checkpoints do not follow a moved deadline yet
    (M3-05).
  - **Purge**: `purgeProjectReceipts(tx, { projectId } | { classroomId } |
    { courseId })` in the `github` service, called in the deletion's
    transaction by `deleteProject`, `deleteClassroom` and `deleteCourse`
    (`org/service.ts`): the receipts of every repository the projects gone
    reference (student, group, distribution, source), except those a
    remaining project still references. Nothing on GitHub. For `org` to
    import the `github` service without pulling the notifications into its
    graph, `redact.ts` now reads the secret paths from `auth/paths.ts`.
  - **Git**: `gitRunner` is asynchronous (`execFile`), `commit.gpgsign=false`
    for the bot; `setRemoteBaseForTests` is the one seam of the remotes
    (it throws under `NODE_ENV=production`);
    `squash.ts`, `sync.ts`, `provision.ts` await it. Tests push to local
    bare repositories (`Q:modules/project/testing.ts`, `repoWorld()`), the
    fake GitHub answering from what is on disk — M3-03 and M3-07 reuse it.
  - `PROJECT_DEFAULTS` (contracts) feeds the columns' and the zod defaults;
    `projectActivity.listForTeacher` lists the staff's projects (drafts in,
    archived projects and classrooms out); `studentCards` stays empty
    (M3-09).
  - Not done here: notifications and SSE on publish (M3-09), the reopen
    (M3-05), a GitHub failure while reading the source is a 500 (not
    mapped to a refusal).

### M3-03 — Acceptance and provisioning
- **Depends on**: M3-02, M2-03.
- **Port from**: `C:modules/student.ts` (accept), `github/provision.ts`,
  `github/collaborators.ts`, `C:repos.ts`.
- **Contracts**: Accept's error codes (`github_not_linked`,
  `github_account_stale`, `app_not_installed`, `provision_in_progress`,
  `no_group`, `has_repo`, `revoke_failed`), and the zod enums of
  `PROVISION_STATUSES` / `INVITATION_STATUSES` with the first payload that
  carries them.
- **Tests** (fake octokit): idempotent accept, `provision_in_progress`, an
  `ok` row survives a failure, teacher notified once, stale account ⇒ 409,
  renamed login followed, refused under impersonation.
- **As delivered** (branch `merge/M3-03-project-accept`; product owner and
  orchestrator, 2026-10-02):
  - **Route**: `POST /app/api/student/projects/:id/accept` (`routes.ts`,
    `studentRoute`), answering `ProjectAcceptance` `{status, fullName,
    invitationStatus}` — the caller's own repository, nothing else
    (N-SEC-20; the test searches every student response for the source and
    the distribution). No student listing: `studentCards` stays empty
    (M3-09).
  - **Loader** `studentProject` / `findStudentProject` (`guards.ts`): a
    claimed STUDENT seat of the project's classroom (a staff seat is a 404),
    a project neither draft nor archived; by the caller's own portal session
    (`ownPortalSession`). An impersonation POST meets ADR-034's read-only
    `403 impersonation_read_only` first outside development, the loader's
    404 in it; a Bearer token 404, `seb` 401. A classroom that is archived
    takes no new work: Accept answers its 404 (product owner, 2026-10-02).
  - **Installation**: `projectInstallation(db, orgId)` in the `github`
    service, on `projects.org_id` (not the classroom's current link); the
    one rule "installed and active" (`installed`) is shared with
    `classroomInstallation`.
  - **Service** `acceptProject` (`Q:modules/project/accept.ts`): the row
    first — `ok` or `deleted_at` set (dead stays dead), it is the answer, no
    call to GitHub, even after the deadline. Then the project's refusals,
    `acceptRefusal(project, now)` of `@quiz/domain` (pure, unit-tested):
    `not_started`, `deadline_passed` (`now >= deadline`, no grace),
    `no_group`, `distribution_missing`; then `github_not_linked`,
    `app_not_installed`, `github_account_stale` (`linkedLogin`, given the
    link already read), `provision_in_progress`, `repo_name_taken`, all 409.
    GitHub failing is `502 provision_failed` — its login lookup included:
    the stored login is never used unconfirmed (renamed away, it may be
    somebody else's now). An invitation GitHub refuses
    (`isInvitationRefused`) is `409 github_account_stale`. Codes in
    `PROJECT_ACCEPT_REFUSALS` (contracts; `has_repo` and `revoke_failed` left
    to M3-15, which serves them), statuses in `errors.ts`.
  - **Provisioning** in the request: the row inserted (`accepted_at` the
    server's clock) under the partial UNIQUE, then claimed and returned in
    one `UPDATE … RETURNING` (`provision_claimed_at`, taken over after 5 min
    by `app.clock`); `repoName(slug, login)`. **Allow-list** (review round 1):
    `provisionStudentRepo`'s `claim(repoId, created)` runs before any push,
    change or invitation — a created repository's id is written on the row
    at once; an existing one (422) is adopted only when its id is the row's
    own (a replay), else `RepoNameTaken` → `409 repo_name_taken`, nothing
    touched on it (a login naming the distribution, a source, another row's
    repository). `full_name` is written on success.
    `markProvisionFailed(db, rowId, claimedAt, error)` never touches an `ok`
    row nor a row claimed since by another holder, and returns true for the
    row's FIRST failure (`provision_error` was null): audited
    `project.accept_failed` `{notify}`, false for a refused invitation.
  - `provision.ts` lost its work mode (D09): always `push`, never `none`.
    `repoWorld()` (`modules/project/testing.ts`) now answers matching refs,
    the default branch's `PATCH`, rulesets (`freePlan` for the 403),
    collaborators (`collaborators`, `uninvitable`).
  - Not done here: the staff's notification (M3-09), resend and re-invite
    (M3-06, M3-08, M3-09), groups and revocation (M3-15), the ruleset of a
    free plan surfaced to the staff (M3-05).

### M3-04 — Ingestion and grading pipeline
- **Depends on**: M2-04, M3-03.
- **Port from**: the push / workflow_run / member / repository /
  pull_request handlers, `C:grading.ts`, reverts with cap.
- **Tests**: port `grading.db.test` and the rest of `webhooks.db.test`;
  bot commits ignored; GR-14.3.
- **Decided for it** (product owner, 2026-10-02; points 5–8 by the
  orchestrator): a restore puts back the distribution's CURRENT version
  (F-PROJ-08 amended, ADR-062 addendum); a workflow's commit is checked
  too; the cap suspends until the staff re-enable; the current score's
  rule and the `fallback` rule (F-PROJ-10 amended); review runs stored, the
  review slot filled only once frozen (F-PROJ-11 amended); a long or forced
  push read through GitHub's compare; a rate limit waited out without a
  retry; the bots are Quiz's App and `github-actions[bot]` only.
- **As delivered** (branch `merge/M3-04-project-ingest`). What M3-05…M3-09
  and M8 inherit:
  - **Handlers** (`Q:modules/project/webhooks.ts`, registered by
    `projectPlugin`, so only with an App): `onReceipt(tracksRepo)` (a push
    on a `project_repos.github_repo_id` gets its receipt in the intake's
    transaction); `push` (a deleted branch ignored; `github-actions[bot]` ⇒
    `bot_commits(grader)`; a person's push ⇒ `last_commit_sha/at` —
    `head_commit.timestamp`, else the receipt time; the App's push moves
    nothing; every push but the App's through `protectFiles`);
    `workflow_run` (`requested`/`in_progress` of an eligible run on the
    student's last commit ⇒ `ci_status = pending`; `completed` ⇒
    `ingestCompletedRun`, which checks eligibility); `member` added ⇒
    `invitation_status = accepted`; `repository` renamed (a student's
    repository by id, and a project's source or distribution by its id,
    matched on the name part only — the owner may have changed first) /
    deleted (`markRepoDeleted`, terminal, audited `project_repo.deleted`
    once; a deleted repository's later events change nothing);
    `organization` renamed ⇒ the `<org>/` prefix of `source_full_name`,
    `distribution_full_name`, `project_repos.full_name` of the
    organization's projects, by its GitHub id (order-free beside
    `github`'s own handler). A rename applies only where
    the stored name is the one it left (`changes.repository.name.from`,
    `changes.login.from`), so a stale replay changes nothing. Each drops
    the live-state cache entry (`forgetRepoLiveState`) and hints.
  - **The last commit** is the last STUDENT commit: only a person's push
    moves `last_commit_sha/at`; it is the ONE commit whose CI state the
    repository shows (`isLastStudentCommit`, `grading.ts`): `pending` is set
    only for it, the aggregated state is computed only for it.
  - **Who pushed**: `pushedBy(config, login)` (`github` service): `app`
    (`<slug>[bot]`), `workflow` (`github-actions[bot]`), `person`; the
    intake's `is_bot` is `!== "person"`.
  - **Grading** (`Q:modules/project/grading.ts`), ONE path for M3-06:
    `ingestCompletedRun(app, octokit, ctx, run: CompletedRun)` → the new
    run's id or null (ineligible, or already there: no annotation read
    again). `ctx` is `repoContext(db, githubRepoId)` (`repos.ts`: `{repo,
    project, courseId}`). Eligibility `isEligible(db, ctx, run)` (handed-out
    branch; head neither in `bot_commits`, any kind, nor received as a bot's
    push, `push_receipts.is_bot` — the review skips both); annotations of
    the run's own check suite only, GRADE through `extractScore`, TESTS
    counters; another workflow ⇒ `fallback`; `parse_detail` the malformed
    message (≤ 500); `after_deadline` by `receivedLate(receipt, deadline,
    now)`; `to_verify` while `protection_suspended_at`, or on a restored
    head; the CI state of the student's last commit (`actions/runs` of that
    sha). The pure rules are `@quiz/domain`'s `projectRuns.ts`:
    `GRADING_WORKFLOW_PATH`, `runKind` (`review`, moved there from
    `reviewDispatch.ts`, which said `llm`), `receivedLate`,
    `selectScoreRun(runs, restoredHeads)`: latest `ci`, not late, `ok` — or
    `fallback` while the repository has no other run at all — by
    `completed_at`, never a run on a restored head. `refreshScoreSelection` writes
    `current_grade_run_id`, and `frozen_grade_run_id` too while
    `deadline_applied_at` is set and `frozen_at` is not (inert until M3-05).
    A `review` run: stored; `review_grade_run_id` only when `ok`,
    `success` and `frozen_at` set; never the current score.
  - **Protected files** (`Q:modules/project/protection.ts`,
    `Q:github/revert.ts`): `protectFiles` on a handed-out branch, a project
    with protected files and a distribution, a repository not suspended, a
    head not yet answered (`reverts.head_sha`); touched files from the
    payload, or `changedFiles` (GitHub's compare `before...after`) when
    forced or 20 commits listed, every protected file for a new branch;
    `revertProtectedFiles` (the distribution's blob at the branch, skipped
    when the head's tree — read once, recursive — already has it) hands the
    restore commit to `beforeMove` = `recordRestore`: in ONE transaction,
    the repository row `FOR UPDATE`, the cap `MAX_RESTORES_PER_HOUR` (5,
    `reverts.created_at` by `app.clock`) ⇒ `protection_suspended_at`, audit
    `project_repo.revert_cap` `{files, head}`, the move refused; else the
    `reverts` row and `bot_commits(revert)`. Then the non-forced move, audit
    `project_repo.restore` `{files, sha, head}`, the head's stored runs
    `to_verify` and the score reselected. A 422 race takes the `reverts`
    row back and throws: the delivery is retried.
  - **Hints**: kind `projects` (contracts, `events.ts`, web
    `HINT_ROOTS.projects = ["classroom"]`), to `course:<id>` and the
    repository's students' `user:` topics (`hintRepo`, `repos.ts`; a
    group's members by `project_group_members` → `enrollments`), never
    `classroom:` (tested: no topic of another student, no `classroom:`).
  - **Rate limit** (N-PERF-07): `processDelivery` meeting
    `rateLimitReset(err)` (`github/app.ts`, moved from `metrics.ts`) with a
    queue sends the delivery again with `startAfter` the reset and returns:
    no retry spent, the error kept on the row; `reconcile.deliveries` may
    replay it before the reset, accepted (it is sent again for the reset).
    `SendOptions.startAfter`;
    the in-process queue holds it in an unref'd timer.
  - **Migration `0057_project_ingest`**: `project_grade_runs.parse_detail`,
    `to_verify`; `reverts.head_sha` + partial UNIQUE `(repo_id, head_sha)`,
    `reverts.covered_sha` (the head the restore was built on, the parent
    `revertProtectedFiles` returns as `covered`). The restored heads
    (`restoredHeads`, `grading.ts`) are `head_sha`, `covered_sha` and every
    head with a push receipt on that branch from the tampering push's
    receipt to the restore's `created_at`: their runs `to_verify`, never the
    score; a push after the restore counts again.
    Audit `project_repo.restore`, `project_repo.revert_cap`,
    `project_repo.deleted`.
  - `isZeroSha` and `ownerRepo(fullName)` (`Q:github/app.ts`) replace the
    zero-sha regexes and the `split("/")` of the GitHub code.
  - `repoWorld()` (`Q:modules/project/testing.ts`) now answers the Git Data
    API (contents, blobs, trees, commits, ref read, ref moved fast-forward
    only), compare, and `commit(fullName, branch, files)` / `read(...)` for
    a push from outside the App.
  - Not done here: a push on a source repository and `pull_request` on
    `sync/*` (M3-07); the live cache's reads, the re-enable route, the
    `multiple` alert's view (M3-08); notices, mails, notifications, the
    `org_lost` path (M3-09); the deadline, freeze and dispatch (M3-05); the
    reconciliations (M3-06). The App must subscribe to `workflow_run`,
    `member` and `repository` (M2-06).

### M3-05 — split (orchestrator, 2026-10-02)
M3-05 (deadline, freeze, dispatch, review checkpoints) is split in two:
**M3-05a** the deadline (scheduled publication, the deadline and its
strategies, the freeze, the reopen, a repository's own deadline, the
staff's lock), **M3-05b** the review (the final review's dispatch, the
review checkpoints and their routes). The original card's notes are kept
under the half that serves them.

### M3-05a — Deadline, freeze, reopen, per-repository deadlines
- **Depends on**: M3-04, D13 (amended 2026-10-02).
- **Port from**: `C:deadline.ts`, `github/lock.ts`, `github/commit.ts`, the
  ticker duties, the reopen of `C:modules/assignments/lifecycle.ts`.
- **Tests**: port `deadline.test`; TestClock: single claim, rescheduling
  between sweep and run, resume after a crashed or exhausted job (lease),
  404 terminal, archive fallback only where rulesets cannot exist,
  idempotent commit strategy, freeze at the effective deadline + grace, a
  repository's own deadline, reopen in the middle of a job, a staff unlock
  never locked again, reopen un-archives, J−n across the DST change, **no
  HTTP inside a tick**.
- **From M3-02** (orchestrator, 2026-10-02): **the reopen** (F-PROJ-09)
  replaces M3-02's `409 deadline_applied`: the locks lifted,
  `deadline_applied_at`, `frozen_at`, `review_dispatched_at`,
  `reminder_sent_at` cleared, the frozen and review slots emptied, the
  `deadline` dispatches forgotten, the runs requalified and each current
  score reselected; teacher scores and a release kept; audited
  `project.deadline_reopened`. Scheduled publication calls
  `publishProject(db, id, now, SYSTEM_ACTOR)`, whose group guard the scan
  carries as SQL (heig-classroom's `groupFormationComplete`). A moved
  deadline (patch, publish) re-resolves the J−n checkpoints not dispatched.
- **From M3-03**: a repository provisioned on a plan without rulesets has
  `ruleset_id` null: the deadline's `lock` falls back to archiving it (H8),
  shown to the staff as degraded.
- **From M3-04**: the provisional freeze is the current score's run; verify
  the grace refresh of the frozen slot; a deadline commit does not move
  `last_commit_sha`; bot commits of a deadline go to
  `bot_commits(deadline)` BEFORE the ref moves; a 404 is
  `markRepoDeleted(…, via)` with `via` widened.
- **Decided for it** (product owner, 2026-10-02; points 5–8 by the
  orchestrator): (1) a repository's own deadline, an individual extension
  (D13 addendum), and everything deadline-shaped per repository on its
  effective deadline; (2) the `commit` strategy is best effort (N-PERF-07
  binds `lock`); (3) a reopen un-archives, and the archive is only for a
  repository without its protection ruleset or a plan refusing rulesets,
  never a 5xx or a rate limit; (4) J−n in calendar days in Europe/Zurich,
  one rule in `@quiz/domain`; (5) claims and leases instead of queue
  singletons (#273), a standard queue `project.deadline`, no GitHub call in
  a tick; (6) the reopen's unlocks on `project.deadline`, never in the
  PATCH, a failed unlock retried; (7) the staff's lock and unlock per
  repository, with an exemption a resumed pass never overrides; (8) the
  freeze provisional at the effective deadline, definitive at the effective
  deadline + grace. **The reminder (claim and send) moves to M3-09**: the
  students see nothing yet, and claiming without sending would lose it.
- **As delivered** (branch `merge/M3-05a-project-deadline`). What M3-05b,
  M3-06, M3-08 and M3-09 inherit:
  - **Migration `0059_project_deadline`**: `projects.deadline_job_at` (the
    lease); `projects.frozen_at` DROPPED with the indexes
    `projects_freeze_due_idx` and `projects_review_due_idx` (the freeze is a
    repository's; M8-01 maps heig-classroom's `assignments.frozen_at` onto
    the repositories); `project_repos.deadline_at` (its own deadline),
    `deadline_applied_at`, `frozen_at`, `deadline_committed_at`,
    `archived_at` (H8), `staff_lock` (the staff's hand: true, false, null
    = the deadline decides); partial index `project_repos_freeze_due_idx`.
    `ruleset_id` stays the protection ruleset made at provisioning; the lock
    ruleset (`hgc-deadline-lock`) is found by name.
  - **Rules**: pure in `@quiz/domain` (`projectRuns.ts`):
    `effectiveDeadline`, `deadlineWantsLock(repo, strategy)` (the staff's
    hand, else applied and strategy `lock`), `reopens(appliedAt, deadline,
    now)`. Their SQL twins, for the scans only, in
    `Q:modules/project/deadline.ts`: `EFFECTIVE_DEADLINE`, `WANTS_LOCK`;
    with `COMMIT_DUE`, `NEEDS_WORK` (wanted ≠ `locked_at`, or a commit
    due) and `LIVE` (provisioned, not deleted, project not archived — #476;
    `isLive` its TypeScript twin). `effectiveDeadlineMoved(tx, project,
    repoIds, now)` — the ONE path of a moved deadline: reopens a repository
    applied and now ahead (markers, frozen and review slots,
    `deadline_committed_at`, `staff_lock`, its `deadline` dispatches),
    drops a staff unlock, requalifies every run by `receivedLate` against
    the new effective deadline (receipt: the earliest `push_receipts` of
    the head), reselects the score of the repositories reopened or whose
    runs flipped. `projectDeadlineMoved` (the patch) adds the project's
    reopen (`published`, `deadline_applied_at`, `review_dispatched_at`
    cleared; audited `project.deadline_reopened` `{deadlineAt, previous,
    repos}`), re-arms `reminder_sent_at` on ANY move, and re-resolves the
    checkpoints (`rescheduleCheckpoints`, in TS by `checkpointDueAt`, now
    calendar days in Europe/Zurich through `addZonedDays`).
    `publishProject` re-resolves them when it counts a duration.
    `projectFieldRefusal` reads `state` alone (`locked` = applied).
  - **Ticker and job** (`Q:modules/project/jobs.ts`): `PROJECT_TASKS` (one
    tick task `project.deadlines`, 20 s, in `TICK_TASKS`; skips without an
    App): (1) scheduled drafts published by `publishProject` (its row lock
    and refusals are the claim; an incomplete group project meets
    `unassigned_students` and stays a draft; audit `project.auto_publish`);
    (2) `published` → `locked` at the project's deadline (audit
    `project.deadline_applied`); (3) each `LIVE` repository's provisional
    freeze at its effective deadline (`frozen_grade_run_id :=
    current_grade_run_id`, `deadline_applied_at`; audit
    `project_repo.deadline_applied`); (4) its definitive freeze at effective
    deadline + grace (`frozen_at`; audit `project_repo.frozen`); (5) WITH A
    QUEUE ONLY, the lease of each project with `NEEDS_WORK` (free or older
    than `DEADLINE_LEASE_MS`, 10 min) and one `project.deadline` job
    `{projectId, lease}` — without a queue the tick claims nothing, so a job
    never runs in the ticker's process. Hints `projects` to the courses'
    staff only. `runDeadlineJob`: nothing unless the lease is the row's;
    four repositories at a time, each re-read before each step (lock —
    archive where `ruleset_id` is null or the plan refuses —, unlock —
    un-archive first —, or the commit), `locked_at`/`archived_at` written
    after the call as facts; the lease RENEWED after each repository
    (`heldLease`; the job stops when another took it over); a 404 ⇒
    `markRepoDeleted(…, "deadline")`; a failure backdates the lease
    (`FAILED_RETRY_MS`, the work claimed again some 30 s on, N-PERF-07) and
    throws, the queue does not retry (`retryLimit: 0`); a crash leaves the
    lease to expire; success gives it back. Also noted in
    `docs/development/index.md`: without a queue, GitHub follows a deadline
    only on a staff action. Audit
    `project.deadline_enforced` `{strategy, locked (an archive counted),
    unlocked, committed, deleted, failed}` per pass that changed something
    (M3-09's `project_deadline_applied` is worded from it), and
    `project_repo.archived` (degraded). `requestDeadlineWork(app, config,
    projectId)` — the staff actions' claim; without a queue the job runs
    awaited in that request.
  - **Routes** (staff, `staffAccess`, own portal session, loader
    `accessibleProjectRepo` in `guards.ts`, params `ProjectRepoParams`;
    a Bearer token 404, an impersonation 403 `impersonation_read_only`, the
    loader's 404 behind it): `PUT /app/api/projects/:id/repos/:rid/deadline`
    (`ProjectRepoDeadline` `{deadlineAt | null}`; `422 deadline_past`;
    audited `project_repo.deadline_set` `{deadlineAt, previous,
    reopened}`), `POST …/repos/:rid/{lock,unlock}` (audited
    `project_repo.lock|unlock` `{staffLock}`), each answering
    `ProjectRepoDeadlineState` after asking for the deadline work; `409
    repo_unavailable` for a repository not provisioned, deleted, or of an
    archived project. `PATCH /app/api/projects/:id` with a `deadlineAt`
    asks for it too (the reopen's unlocks). `PROJECT_REFUSALS` lost
    `deadline_applied`, gained `repo_unavailable`.
  - **M3-04 updated**: `after_deadline` on the effective deadline, read
    with the project's and the repository's rows under a share lock in the
    insert's transaction (a deadline moving meanwhile comes first or
    requalifies the run); `refreshScoreSelection(db | tx, { repo })` writes
    the frozen slot by a SQL `CASE` on the row's own `deadline_applied_at`
    / `frozen_at` (a refresh racing the definitive freeze never moves it);
    the review slot reads the repository's `frozen_at`. `pushEmptyCommit`
    takes `isDone` and `beforeMove`; `lock.ts` gained `setRepoArchived`;
    `isPlanRestriction` is exported (`provision.ts`). `repoWorld()` deletes
    rulesets and archives (an archived repository refuses writes).
  - Not done here: the reminder (M3-09); the final review's dispatch and
    the checkpoints' routes (M3-05b); the views of a repository's deadline,
    lock and degraded state (M3-08); notices and mails (M3-09).

### M3-05b — Final review dispatch, review checkpoints
- **Depends on**: M3-05a.
- **Port from**: `C:dispatch.ts`, `C:milestones.ts`, the ticker duties.
- **Create**: the review dispatch and the checkpoints' sweeps in
  `Q:modules/project/jobs.ts`'s `projectTick` (claim + enqueue only); a
  `project.dispatch` queue (claims and leases, ADR-064, not singletons).
- **Contracts**: `ReviewCheckpoint` `{id, name, dueAt, offsetDays,
  dispatchedAt}` and `ReviewCheckpointCreate` (a `criteria.yml`-friendly
  name `^[a-z0-9][a-z0-9_-]{0,49}$`; a date or an offset of −365…−1 days,
  exactly one; heig-classroom's `milestones.ts`), and their routes.
- **Tests**: port `dispatch.test`, `dispatch.db.test`; the ledger
  (`grade_dispatches`, claimed `ON CONFLICT DO NOTHING` before GitHub is
  called), **no HTTP inside a tick**.
- **From M3-04** (2026-10-02): **the review slot** — F-PROJ-11 is amended:
  a dispatched run runs on the default branch's head, not on
  `client_payload.sha`, so M3-04 fills the slot for an `ok`, `success`
  `review` run received once the repository's `frozen_at` is set, never by
  comparing the head with the frozen commit; the dispatch must record the
  sha it sent (`grade_dispatches.sha`) as the only trace of what was asked.
- **From M3-05a** (2026-10-02): the final review is per repository — at
  ITS definitive freeze (`project_repos.frozen_at`, its effective deadline
  + grace), not the project's; a reopen already forgets the repository's
  `deadline` dispatches and empties its review slot
  (`effectiveDeadlineMoved`), and clears `projects.review_dispatched_at`.
  The J−n checkpoints are re-resolved by `rescheduleCheckpoints`
  (`deadline.ts`, calendar days) on every move of the project's deadline;
  a checkpoint's creation resolves its offset by the same
  `checkpointDueAt`. Reuse `LIVE`, the lease pattern (renewed as the job
  goes, `heldLease`) and the bounded concurrency of `jobs.ts`. There is no
  `projects.frozen_at` any more, nor a `projects_review_due_idx`: the
  review scan is over `project_repos` (frozen, no `deadline` dispatch);
  whether `projects.review_dispatched_at` still serves is this task's call.
- **Decided for it** (product owner, 2026-10-02; point 5 by the
  orchestrator): (1) at most once — the ledger row claimed before the
  call, an unconfirmed row never sent again (a manual re-dispatch is a
  later option); (2) only Quiz's review counts — the slot takes a review
  run only when the App triggered it; (3) a repository archived as its
  lock gets no review, without a ledger row, audited degraded, never
  un-archived for it; (4) checkpoints against the project's deadline,
  calendar days, to every live repository not yet frozen, on the last
  non-bot receipt before the date, `due_past` / `due_after_deadline`, void
  after an earlier deadline, delete refused once any ledger row exists;
  (5) per repository at its definitive freeze, `none` never, no frozen run
  no review, the effective deadline in the payload, the sha recorded, even
  without `ANTHROPIC_API_KEY`; a separate lease and queue, no HTTP in a
  tick; `review_dispatched_at` dropped.
- **As delivered** (branch `merge/M3-05b-project-review`). What M3-06,
  M3-08, M3-09 and M8-01 inherit:
  - **Migration `0060_project_review`**: `projects.review_dispatched_at`
    DROPPED (whether a repository's final review was asked is its
    `grade_dispatches` row), `projects.dispatch_job_at` (the dispatch
    lease).
  - **Leases** (`Q:modules/project/lease.ts`, shared with the deadline):
    `claimLeases(db, key, now, work, projectId?)`, `ProjectJob`,
    `LEASE_MS`, `FAILED_RETRY_MS`, and ONE frame for both jobs,
    `runLeased(app, config, key, job, label, body)`: the lease compared,
    the installation's client, `each(repos, settle)` (four at a time, a
    renewal after each, a throw counted failed and logged; returns the
    failed full names), then lost ⇒ return, failed ⇒ backdated lease and
    throw, else released. `runDeadlineJob` and `runReviewJob` are bodies
    in it. `hintStaff` moved to `repos.ts` as `hintProjectStaff`.
  - **The dispatch** (`Q:modules/project/review.ts`): the tick's step 6,
    `claimReviewWork` (queue only) → `project.dispatch`
    (`PROJECT_DISPATCH_QUEUE`, `retryLimit: 0`) → `runReviewJob`: first
    the final reviews (`FINAL_REVIEW_DUE`: `LIVE`, graded `auto`,
    `frozen_at` and `frozen_grade_run_id` set, `archived_at` and
    `protection_suspended_at` null, no `deadline` ledger row), then each
    checkpoint that fires (`checkpointFires` of `@quiz/domain`; its SQL
    twin `checkpointDue` only in the claim) to `CHECKPOINT_TARGET` (`LIVE`,
    `deadline_applied_at` null — "not yet frozen" read as not even
    provisionally). Each repository: one transaction (`lockedRepo`: the
    project `FOR SHARE` read once, the repository `FOR UPDATE` among its
    target; then the checkpoint `FOR SHARE`) re-reads it and claims the
    ledger row (`createdAt` = the clock, `sha` sent); then `POST
    /repos/{o}/{r}/dispatches` with Octokit's retries off. Outcomes:
    accepted ⇒ `dispatched_at`; a 4xx ⇒ the row deleted, the repository
    failed (lease backdated, job throws), a 404 ⇒
    `markRepoDeleted(…, "dispatch")`; no response or a 5xx ⇒ the row left
    unconfirmed, counted `unconfirmed`, not a failure. A checkpoint is
    marked `dispatched_at` after a pass with no failure for it. Audit
    `project.review_dispatched` and `project.checkpoint_dispatched`
    (`checkpointId`, `name`) `{dispatched, deleted, unconfirmed, failed}`
    per pass that changed something; `project_repo.review_skipped`
    `{projectId, reason: "archived" | "protection_suspended"}` written by
    `jobs.ts` only: the freeze step, or the deadline job archiving a
    repository already frozen.
  - **The review slot** (`grading.ts`): `CompletedRun.triggeredBy`
    (`pushedBy` of `workflow_run.triggering_actor` alone; none ⇒ `person`)
    and `startedAt` (`run_started_at`; null ⇒ never). The slot fills for a
    parsed, successful `review` run only when `app`, not `to_verify`, and
    started at or after the repository's `frozen_at` and after its
    `deadline` ledger row's `created_at` (a conditional UPDATE on the row
    as it stands). A student's own dispatch or re-run, a checkpoint's run,
    a pre-reopen run are `review` traces. The `workflow_run` event carries
    no `client_payload`: a checkpoint's run STARTED after the final review
    was asked would pass; `CHECKPOINT_TARGET` leaves that only to a
    GitHub delay longer than checkpoint-to-deadline + grace (ADR-064).
  - **Domain** (`@quiz/domain` `reviewDispatch.ts`): `isVoidCheckpoint`,
    `checkpointRefusal(dueAt, deadlineAt, now)`, `checkpointFires`.
  - **Checkpoints** (`Q:modules/project/checkpoints.ts`, staff,
    `accessibleProject`): `GET|POST /app/api/projects/:id/checkpoints`
    (`ReviewCheckpointCreate` → `ReviewCheckpoint`, 201; resolved under the
    project's row lock), `DELETE …/checkpoints/:cid`
    (`ProjectCheckpointParams`, 204, 404 for another project's). Refusals
    `PROJECT_CHECKPOINT_REFUSALS` (own contract block): `due_past`,
    `due_after_deadline` (422), `duplicate_checkpoint`,
    `checkpoint_dispatched` (409). Audit `project_checkpoint.create|delete`
    (subject the checkpoint, `{projectId, name, dueAt, offsetDays}`).
  - **Tests** `Q:modules/project/dispatch.db.test.ts`; the review-slot case
    in `ingest.db.test.ts`.
  - Not done here: notices and mails (M3-09); the staff's view of the
    ledger and of void checkpoints (M3-08); a manual re-dispatch (later).
    Without a queue (`JOBS_DISABLED=1`) no review is ever dispatched
    (`docs/development/index.md`). A repository archived as its lock and
    later un-archived by a staff unlock after its freeze gets its final
    review then (it is due again: frozen, no ledger row, not archived).

### M3-06 — Reconciliation of grades and repositories
- **Depends on**: M3-04, M2-05. ‖ M3-05, M3-07.
- **Port from**: `reconcile.grades`, `reconcile.repos`.
- **From M3-03** (orchestrator, 2026-10-02): the daily re-invite of
  F-PROJ-07 (a student still without access, at most once a day per
  repository) is this task's, through `inviteCollaborator` with `push`.
  Two leftovers of Accept to reconcile (reviewers of M3-03): a repository
  GitHub created whose id never reached the row (the process died between
  the create and the update) leaves that student on `repo_name_taken`
  until staff recover it; and a renamed account before success leaves a
  stray private repository, possibly with the student still invited.
- **From M3-04** (2026-10-02): `reconcile.grades` builds a `CompletedRun`
  from `GET /repos/{o}/{r}/actions/runs` (the last 20 completed, any
  workflow) and calls `ingestCompletedRun(app, octokit, repoContext(…),
  run)` — idempotent, a known run reads no annotation; `completedAt` is the
  run's `updated_at`. A reconciled run has no receipt: `isAfterDeadline`
  makes it late once the deadline passed (GR-14.3). `reconcile.repos`
  writes `invitation_status` like the `member` handler and the head like
  the push handler (without `protectFiles`: restoring is the webhook's).
  A rate limit inside a scheduled task is waited out by Octokit once; a
  task is not a delivery, so it is the next period that retries.
  Three narrow edges of M3-04's restored-heads window, left by its review
  (round 3): the window ends at `reverts.created_at`, taken before the ref
  read, so a head received in between (other than `covered_sha`) escapes —
  bound it by the receipt of `covered_sha` instead; a sha first received on
  another branch makes the join take that branch — store the restore's
  branch on `reverts`; after a 422 whose retry finds nothing to restore,
  S's runs stay unflagged. Close them here, where the reconciliation reads
  the same rows.
- **From M3-05b** (2026-10-02): `CompletedRun` gained `triggeredBy`
  (`pushedBy(config, run.triggering_actor?.login)` — the triggering actor
  alone, none is a person's) and `startedAt` (`run_started_at`, null when
  absent): the listing of `actions/runs` carries both, and a reconciled
  review run fills the review slot only under the same rule as the
  webhook's (App-triggered, not `to_verify`, started after the freeze and
  after the `deadline` ledger row). The reconciliation never re-sends a
  review dispatch: an unconfirmed ledger row stays as it is.
- **From M3-08b** (2026-10-04): the staff's resend of a pending invitation
  (`resendInvitation`, `modules/project/invitation.ts`) is INDEPENDENT of
  this task's daily re-invite: it claims `project_repos.invitation_resent_at`
  (once a minute) and the re-invite neither reads nor writes that column
  — the two never wait for each other. Both go through
  `inviteCollaborator(…, "push")` and both make `invitation_status` follow
  GitHub's answer (`accepted` on a 204). A repository re-enabled by its
  staff (`protection_reenabled_at`) is an ordinary repository again for
  `reconcile.repos`.
- **Split** (orchestrator, 2026-10-05): **M3-06a** (this PR) is the two
  scheduled tasks; **M3-06b** closes M3-04's three restored-heads edges
  (the window bounded by the receipt of `covered_sha`, the restore's
  branch stored on `reverts`, the runs of S after a 422 whose retry finds
  nothing) and the rule the product owner decided the same day: *a 422
  then nothing to restore ⇒ the run stays `to_verify`, with a `reverts`
  row and no restore commit*.
- **As delivered** (M3-06a, branch `merge/M3-06-reconciliation`):
  - **Tasks** `Q:modules/project/reconcile.ts`, `RECONCILE_TASKS` in the
    catalog (`reconcile.grades` 15 min, `reconcile.repos` daily; keys in
    `SCHEDULED_TASK_KEYS`, names `admin.task.reconcile.*` en/fr), run by
    the `system.task` worker; without the App they return at once. One
    `pass` for both: the live repositories in scope (`reconciles` and
    `isQuiet` of `@quiz/domain` `projectReconcile.ts`: 24 h after the
    freeze unless a `deadline` dispatch is unanswered; quiet 30 min for
    the grades, computed for that pass only), the installation clients of
    the candidates' organizations through `installationClients`
    (`access.ts`, now exported: the one rule of "the App is not on this
    organization"), each wrapped by `failFast` (`github/app.ts`:
    `noRateLimitWait` on every `request`; `paginate`, `rest.*` and
    `graphql` do not inherit it and no helper here uses them),
    each repository located by `GET /repositories/{id}` — a 404 there ⇒
    `markRepoDeleted(…, "reconcile")`; a new name ⇒ `followRepoRename`
    (`repos.ts`, extracted from the `repository.renamed` handler, which
    calls it) —, then settled; a rate limit stops the pass (logged, the
    summary says so), any other failure of a repository is logged and the
    pass goes on. Audit `project.reconciled` (subject the task key,
    `{repos, runsIngested, reinvited, accepted, heads, renamed, deleted,
    stoppedOnRateLimit}`) per pass that changed something or stopped.
  - **`reconcile.grades`**: `GET /repos/{o}/{r}/actions/runs?status=completed&per_page=20`
    under the current name, each run through `completedRun` (`grading.ts`,
    the ONE mapping, `RawWorkflowRun` its schema — the `workflow_run`
    handler uses both) then `ingestCompletedRun`; a 404 from the listing
    deletes nothing. "Activity" for the quiet rule is the latest of the
    push receipts and of the runs' `completed_at` (GitHub's clock, not
    `created_at`: the two clocks never mix).
  - **`reconcile.repos`**: a student's own pending invitation claimed
    (`invitation_reinvited_at`, UPDATE … RETURNING, once a day, never once
    frozen) then `inviteAccount(…, via: "reconcile")` with the login
    `linkedLogin` returns today (no link: skipped, the claim stands;
    `github_account_stale`: skipped and logged, the claim stands) and
    `followInvitation`; not claimed ⇒ the recorded live grants' logins
    looked for among the collaborators (`GET …/collaborators/{login}`,
    204 ⇒ `accepted`). Group repositories: head and runs like any row,
    invitations untouched (ADR-070, M3-15b). The default branch's head
    (`GET …/commits?sha=<default>&per_page=1`) moves `last_commit_sha` and
    `last_commit_at` (`moveLastCommit` of `repos.ts`, the push webhook's
    write too) only when not in `bot_commits` and its author AND committer
    are both named, both `User` and both persons (`pushedBy`); then
    `aggregateCiStatus` (exported from `grading.ts`). No receipt, no
    `protectFiles`.
  - **Migration** `0070_project_reconcile` (`invitation_reinvited_at`),
    regenerated after 0069 (`0069_group_sync`, M3-15b-2a) so its `when`
    and `prevId` chain after it. `markRepoDeleted`'s `via` and `InviteVia`
    gain `reconcile`. A grant with `revoking_at` set (M3-15b-2) is left
    alone: never re-invited, never read for acceptance.
  - **Tests** `Q:modules/project/reconcile.db.test.ts` (both tasks against
    the fake GitHub: ingestion once from either path, the quiet and scope
    rules, the 404 rules, the rate-limit stop, the re-invite claim across
    a day, acceptance found, frozen and unlinked, the head rules, the
    rename), `grading.test.ts` (the mapping), `@quiz/domain`
    `projectReconcile.test.ts` (the pure rules).
  - **Accept leftovers** (product owner, 2026-10-05): reported only. A
    row on `repo_name_taken` stays so — a repository is the row's only if
    the row made it (rule of 2026-10-02), so no adoption by name; a stray
    private repository left by an account renamed before success is not
    looked for (I69). Nothing here finds it.
  - **Interpretation taken** (to confirm in review): "no pusher means no
    head move" is read as fail closed — a head whose author and committer
    GitHub cannot name is nobody's and never becomes the student's last
    commit; a student committing with an unlinked e-mail is left to the
    push webhook, whose sender names them. A staff unlock after the
    freeze (no reopen) does not widen the 24-hour window.
- **M3-06b — As delivered** (branch `merge/M3-06b-restored-heads`; the
  three restored-heads edges of M3-04, settled 2026-10-05 by the spec
  challenge and the product owner, ADR-062 addendum 6):
  - **The window's upper bound** (`restoredHeads`, `Q:modules/project/grading.ts`)
    is `GREATEST(reverts.created_at, receipt(covered_sha))`, a `LEFT JOIN`
    on the covered head's receipt (`created_at` alone while it has none): a
    head received between the restore's `now` and the covered head's
    receipt no longer escapes. The stored `to_verify` may lag for a head
    received late; `refreshScoreSelection` now makes the column follow the
    set at every reselection (the restore's, each ingest's, and
    `reconcile.grades` (15 min), whose `ingestRuns` step calls it per
    candidate repository, DB-only: a lagging flag is caught up within the
    period with no new run), and the score was never wrong:
    `selectScoreRun` reads the set. `protection.ts` lost its own bulk
    update for it.
  - **The window's branch**: `reverts.branch text NULL` (migration
    `0073_project_reverts_edges`, no backfill), written by `recordRestore`;
    the join reads `between.branch = COALESCE(reverts.branch, tampering.branch)`,
    so the rows written before keep their behaviour. Known limit: receipts
    are one per sha, so a head first received on A then pushed on B escapes
    B's window (per-branch receipts out of scope); a run belongs to a sha,
    only the window is per branch.
  - **A 422 on the move** (product owner): `reverts.revert_sha` nullable;
    the 422 sets `revert_sha` null — `covered_sha` kept, the head the
    attempt read — instead of deleting the row, reselects (the runs
    flagged at once) and throws (the delivery is retried). The `answered`
    check skips a null row; `recordRestore` fills it in through
    `ON CONFLICT (repo_id, head_sha) DO UPDATE … WHERE revert_sha IS NULL`
    (its restore, covered head, branch and `created_at` are the retry's)
    and its cap count ignores null rows; a retry that finds nothing to
    restore leaves the null row and still reselects (`pending`). A null
    row's window: the heads from its receipt to `created_at` when
    `covered_sha` is set (the fix pushed after the read is outside), its
    head alone otherwise (a `CASE` upper bound in the window join).
  - **Nothing to restore** (review round 1, a gap of M3-04): the adapter
    answers `RevertOutcome {head, restored}` and exposes its one comparison
    `alteredFiles(octokit, {…, sha, paths})` (commit, tree, the reference
    blobs: the paths whose blob differs from the distribution's); a push
    that touched a protected file whose head a clean head had overtaken
    when its delivery was handled (`head !== push.after`) is read at
    `push.after` (the hit files only, on that path only): altered ⇒ a null
    row, head alone (`covered_sha` null, `files` the altered ones), its
    runs `to_verify`; identical ⇒ a fix delivered late, no row. A push
    whose own head is clean (`head === push.after`) writes no row; a
    refused `beforeMove` (the cap) writes none either. Limit: never-
    delivered tampered heads between S and the clean one count.
  - Tests (`ingest.db.test.ts`, "protected files"): a head on `dev` inside
    `main`'s window not flagged (S first received on `dev`); X received
    between `created_at` and S2's receipt flagged, a push on the restore
    not; a 422 then a retry finding the fix (null row with `covered_sha`
    = S, S `to_verify` at once, the fix the score, five restores still pass
    the cap, no restore audit); a 422 then a retry that restores (row
    filled, `created_at` the retry's, a redelivery answered, S1 flagged);
    S, S1, 422, the fix (S and S1 `to_verify`, the fix the score); S then
    the fix before S's delivery (null row, S `to_verify`, the fix's own
    delivery writes no row and counts, a redelivery answered); S, F1 (the
    fix), F2, every delivery handled with head F2 (S's null row only, F1
    and F2 count).
    `failedDelivery(payload)` beside `handled`. The student leak test
    (`studentView.db.test.ts`, `toVerify`/`to_verify`) stays green.

### M3-07 — Sync of the source repository
- **Depends on**: M2-04, M3-02, D12. ‖ M3-05, M3-06.
- **Port from**: `C:sync.ts`, `github/sync.ts`.
- **Tests**: new (classroom has none): fake octokit + a local bare repo.
- **From M3-04** (2026-10-02): the source push (`source_ahead_sha`) and
  `pull_request` on `sync/*` handlers register beside M3-04's in
  `Q:modules/project/webhooks.ts` (`registerProjectHandlers`). A sync
  updates the distribution repository, which is also the restore's
  reference (ADR-062 addendum): after a sync, a protected file is restored
  to the new version. The sync's own commits go to `bot_commits(sync)`
  before the ref moves. The `repository` handler already follows a renamed
  source or distribution by id; a deleted one is this task's to surface.
- **From M3-12a** (orchestrator, 2026-10-04): the project page says
  `primaryAction: "sync"` as a sentence in its header
  (`project.status.sync`, `projectStatus` in `project/projectPage.ts`) and
  draws no button for it. This task adds the **Sync** primary button in
  `project/ProjectPage.tsx` (the `actions` of its `PageHeader`, beside the
  `publish` branch) on its route, and the `-sync-banner` scene.
- **As delivered** (2026-10-05, `merge/M3-07-source-sync`; ADR-073, F-PROJ-12
  amended):
  - `Q:modules/project/sync.ts`: `requestSync` (`POST /app/api/projects/:id/sync`,
    202 `ProjectSyncAccepted`): the `sync_job_at` lease taken (`409
    sync_in_progress`), the distribution repository updated IN THE REQUEST
    (`github/sync.ts`'s `updateSquashedRepo`: the squash commit says
    `Project update`, never the source's sha; a `whole` push refused as
    non-fast-forward is `409 source_rewritten`, audited `project.sync_failed`,
    the lease given back; `502 sync_failed` otherwise), `projects.source_heads`
    written, audited `project.sync_requested`, one `project.sync` job sent
    (run in the request without a queue). `409 project_archived`,
    `distribution_missing`, `app_not_installed`; a draft syncs its
    distribution only; never refused for a source that is not ahead.
  - `runSyncJob` in `runLeased` (which now hands the body the installation
    `token`): every student repository, re-read before its push, skipped
    when not live, past its effective deadline or locked (`syncSkips`,
    `@quiz/domain`); the distribution's head recorded in `bot_commits(sync)`
    before `sync/<branch>` is forced (left alone when already there);
    GitHub's compare `branch...sync/branch` with no file → `up_to_date`;
    else ONE pull request per branch (`project_sync_prs`, PK (repo, branch);
    the stored one reused while open, else found by head, else opened;
    a comment only when the head moved), English texts naming the
    distribution's sha. Outcome per repository
    (`project_repos.sync_outcome`, `_at`: opened / updated / up_to_date /
    failed / skipped); a failed repository recorded, the pass goes on, the
    frame gives the lease back (`runLeased`'s `onFailure: "release"`:
    nothing re-claims a sync but the staff, at once); a push the
    repository refuses is probed:
    a 404 marks it deleted (`via: sync`). Then `synced_at`,
    `source_ahead_sha`/`source_pushed_at`/`source_ahead` cleared only when
    nothing failed and the sha is one of `source_heads`; audited
    `project.synced {opened, updated, upToDate, failed, skipped, failedRepos}`.
  - Handlers registered beside M3-04's (`webhooks.ts`, additive):
    `sourcePush` — a push on a SOURCE repository marks every non-archived
    project handing out that branch (drafts included) with
    `source_ahead_sha`, `source_pushed_at` (the delivery's receipt) and
    `source_ahead[branch]` (GitHub's compare from the handed-out sha, null
    when unknown); a push whose head is the handed-out sha marks nothing;
    `pullRequest` — the App's pull requests from `sync/*` only, state kept
    (`open`, `merged`, `closed`), a replay about an older number ignored
    (`setWhere`). The source repository gets no push receipt.
  - Contracts: `ProjectDetail.sync` (`ProjectSyncState`: `ahead {pushedAt,
    commits|null}`, `inProgress`, `syncedAt`, `last` counts),
    `ProjectRepoView.sync` (`ProjectRepoSync`: the default branch's `pr`
    and the last `outcome`/`at`), `SYNC_OUTCOMES`, `ProjectSyncAccepted`,
    refusals `project_archived`, `sync_in_progress`, `source_rewritten`,
    `sync_failed`. `createSquashedRepo` returns `sourceHeads`, written at
    the build. Migration `0072_project_sync` (regenerated after `0071_rpn_calculator`) (`sync_job_at`, `source_heads`,
    `source_ahead`, `sync_outcome(_at)`, `project_sync_prs`; the old
    `sync_pr_number/state` copied into the default branch's row, then
    dropped).
  - Web: the Sync button (primary when `primaryAction === "sync"`, a
    secondary beside Publish or Release while the source is ahead,
    `offersSync`), "Syncing…" while in progress (refetch every 3 s), the
    commits ahead in the counts, the last sync's counts under the header,
    the row's pull request / outcome tag (`syncTag`, `SyncBadge`) and a
    sheet fact; mock `?ahead=1`, scene `project-sync-banner`; en + fr.
  - Tests: `sync.db.test.ts` (nine cases over local bare repositories,
    the fake GitHub now answering pull requests and a compare by refs),
    the leak test extended with the source's sha and the sync's words,
    `syncSkips` unit test, the page's and the rules' web tests.
  - Not done here: the import's mapping of `sync_pr_number` (M8-01, the
    migration's copy stands for Quiz's own rows); a notification kind for a
    merged pull request (none, D18); the student's notice (M3-09c).
  - **Deployment:** the production App must subscribe to `pull_request`
    (M2-06 lists `workflow_run`, `member`, `repository`).

### M3-08 — split (orchestrator, 2026-10-02)
M3-08 (teacher views, grades, release) is split in two: **M3-08a** the
reads (the project page, a repository's runs, the live state), **M3-08b**
the writes (the teacher's score, the release, the invitation resend, the
protection's re-enable). The original card's notes are kept under the half
that serves them.

### M3-08a — Teacher views: the project page, the runs, the live state
- **Depends on**: M3-04, M3-05a.
- **Port from**: `C:modules/assignments/detail.ts` (the detail table, the
  grade-run history), the final-score rule of `C:modules/grades.ts`, the
  live-state cache (#37/#40).
- **Contracts**: the grade runs' views (`GradeRunView`, `GradeRunList`
  with the current, frozen and review run ids; zod enums of
  `GRADE_RUN_KINDS`, `GRADE_RUN_PARSE_STATUSES`, `CI_STATUSES`),
  `ProjectDetail`.
- **Tests**: port `grades.db.test` and the detail's; a deleted repo never
  calls GitHub; a rate-limited detail returns stored state at once.
- **From M3-03** (orchestrator, 2026-10-02): each repository's
  `invitation_status` and `provision_status` in the teacher's views.
- **From M3-04** (product owner, 2026-10-02): the views show a suspended
  repository as "protected files in conflict" and every run with
  `to_verify` as "to verify" (a suspended protection, or a head whose
  protected files were restored — a head in `reverts.head_sha`), a
  `multiple` run as an alert (it notifies nobody), a `malformed` run with
  its `parse_detail`. The live-state cache is already dropped by every
  project webhook (`forgetRepoLiveState`); the views' `projects` hint
  roots join `HINT_ROOTS.projects` (web, M3-12).
- **From M3-05a** (2026-10-02): each repository of the views shows its
  **own deadline** when it has one (`project_repos.deadline_at`) beside
  its effective deadline, its freeze (`deadline_applied_at`, `frozen_at`),
  its lock as GitHub holds it (`locked_at`) and the staff's hand
  (`staff_lock`: a lock or unlock asked may not have reached GitHub yet),
  and a lock that fell back to archiving (`archived_at`) as **degraded**
  (H8; also a repository provisioned without rulesets, `ruleset_id` null).
  `ProjectRepoDeadlineState` (`contracts/src/project.ts`,
  `repoDeadline` in `deadline.ts`) is the shape the three repository
  routes already answer; fold it into the repository rows.
- **As delivered** (branch `merge/M3-08a-project-views`). What M3-08b,
  M3-09, M3-12 and M5-03 inherit:
  - **`GET /app/api/projects/:id`** now answers `ProjectDetail`
    (`modules/project/detail.ts`), a superset of `ProjectSummary`: every
    client parsing the summary keeps working; PATCH, publish, archive
    still answer `ProjectSummary`. Staff only, through
    `accessibleProject` (invariant 6): a student, another teacher, an
    impersonation, a Bearer token get the 404 of a missing project
    (tested). **N-SEC-20**: never reused nor filtered for a student; the
    student's projection is M3-09's own. Added: `releasedAt`;
    `primaryAction` (`publish` | `sync` | `release` | `none`,
    `projectPrimaryAction` of `@quiz/domain`: an archived project none, a
    draft Publish, Release once `scoresFinal` — graded (`auto`), every
    LIVE repository definitively frozen, at least one; deleted,
    never-provisioned and archived-project repositories do not hold it
    back — and not yet released or a score changed since; then Sync when
    `projects.source_ahead_sha` is set, which M3-07 fills; Release comes
    before Sync, since once every repository is frozen a sync reaches
    nobody's score); `counts` `{students (the roster, staff seats
    excepted), accepted, live, frozen (live and frozen), toVerify,
    alerts}`; `liveStale`; `rows`, the roster by name
    (`ProjectDetailRow` `{student, repo | null}`, null being "not
    accepted"), then the repositories whose student left the roster
    (`enrollmentId` null). A repository of a user who now holds a STAFF
    seat of the classroom is left out of the rows, the counts and the
    release's readiness (a staff seat is never a student's, ADR-018).
    Individual repositories only: a group's rows (members by
    `project_group_members`) are M3-15's.
  - **A repository's row** (`ProjectRepoView`) extends
    `ProjectRepoDeadlineState`, which gained **`degraded`** (`archived_at`
    set, or provisioned with `ruleset_id` null; the three repository routes
    answer it too; `repoDeadlineState(repo, project)` in `deadline.ts` is
    the pure half of `repoDeadline`): `provisionStatus`, `provisionError`,
    `invitationStatus`, `acceptedAt`, `lastCommit` (the stored STUDENT
    commit, M3-04), `ciStatus`, `live`, `scores` `{current, frozen,
    review}` (`ProjectSlotScore`: run id, points, max, `grade`; a run's
    parse status and `to_verify` are the run list's), `teacher` `{points, comment, gradedAt}`, `final`
    (`ProjectFinalScore`: points, max, `source` teacher | review | ci —
    I42 —, grade); `released` (the snapshot `{points, max}` once the
    project is released, else null); `flags`: `protectionSuspended`,
    `toVerify` (the run of one of the THREE SLOTS is `to_verify`; a run on
    a restored head, never in a slot, shows in the history only),
    `multiple` (ANY run of the repository: an alert does not fade),
    `malformed` (the LATEST run's `parse_detail` when it is malformed,
    else null), `deleted` (stored, or the live read's 404),
    `changedAfterRelease`. A late run shows in the run list
    (`afterDeadline`), not as a row flag. `multiple` and `malformed` come
    from one `GROUP BY` over the repositories' runs. `alerts` counts `multiple` or
    `protectionSuspended`.
  - **Grades**: every score converts with its own maximum through
    `scoreGrade(points, max, scale)` (`@quiz/domain` `projectView.ts`,
    `projectGrade`; null without a maximum), `fellBack` carried.
    `resolveFinalScore` (`finalScore.ts`) is settled on `review`: input
    `reviewScore`, source `"review"`, `FINAL_SCORE_SOURCES`; no `llm` is
    left in the project code. `changedAfterRelease(released, final,
    snapshot)` compares points AND max, a score that appeared or vanished
    included.
  - **`GET /app/api/projects/:id/repos/:rid/runs`** → `GradeRunList`
    (loader `accessibleProjectRepo`): the newest `GRADE_RUN_LIST_LIMIT`
    (100) runs by `completed_at`, each a `GradeRunView` (kind, conclusion,
    branch, head sha, points/max, TESTS counters, parse status and detail,
    `afterDeadline`, `toVerify`, `completedAt`), and the three slot ids.
    Database only.
  - **The live state** (decided here): `readRepoLiveState` for every LIVE
    repository (never a deleted one, nor one of an archived project),
    `LIVE_CONCURRENCY` (8) at a time within `LIVE_BUDGET_MS` (1.5 s, the
    installation's token included). Past the budget the page answers with
    what it has and `liveStale: true`; the reads under way finish into the
    cache, none is started after it, and the next view (the client
    refetches shortly) finds them warm: a cold page of 100 repositories
    costs at most eight requests in flight and fills over a few
    refetches. A rate-limited installation answers `live: null` at once:
    `isRateLimited` (`github/metrics.ts`) is asked before the
    installation's token is even minted, until GitHub's reset. The live read only ADDS
    counters (`ProjectRepoLive`: commit count, check runs passed / total,
    `stale`) and is never written back: GitHub's head may be the App's (a
    restore, a deadline commit), the stored one is the student's —
    heig-classroom wrote the head back on a view. **`forEachLimit` is
    duplicated on purpose** (`detail.ts` and `jobs.ts`), so that M3-08a
    and M3-05b, built in parallel, never edit the same file: whichever of
    the two merges second imports it from `modules/project/lease.ts`
    (which M3-05b creates) and deletes its own copy.
  - Not done here: the writes (M3-08b), the web page (M3-12), the
    student's view (M3-09), a group's row (M3-15); heig-classroom's
    `/activity` route (the commit graph) is not ported, no card asks for
    it.

### M3-08b — Teacher score, release, invitation resend, protection re-enable
- **Depends on**: M3-08a.
- **Port from**: heig-classroom's override, validate ⇒ release,
  invitation resend.
- **Contracts**: `ScoreOverride` (`PATCH …/repos/:rid/score`, points
  0…1000 or null, a comment ≤ 2000), the refusals `not_frozen` and
  `grading_none`. The release calls `projectGrade` and writes
  `released_points/max`.
- **From M3-03** (orchestrator, 2026-10-02): the staff's resend of an
  invitation (F-PROJ-07).
- **From M3-04** (product owner, 2026-10-02): **the re-enable route** of
  the protected files (F-PROJ-08), which clears
  `project_repos.protection_suspended_at`, audited, staff only.
  Follow-up (here or later): store a repository's name without its owner
  (the organization is `projects.org_id`), so the `organization` rename
  handler of `webhooks.ts` can go.
- **From M3-05a** (2026-10-02): the `not_frozen` refusal of the release
  reads the repositories' `frozen_at` (a repository with a later deadline
  may not be frozen yet).
- **From M3-08a**: the page's `primaryAction` offers Release by
  `scoresFinal` (`@quiz/domain`), and the release's own guard is the same
  rule; `changedAfterRelease` and the snapshot's shape are there.
  `resolveFinalScore` still gives a teacher score on a repository without
  a scored run a null maximum: decision (1) replaces that.
- **Decided for it** (product owner, 2026-10-02):
  1. **A teacher score's maximum**: its own, given with it, when the
     repository has no scored run (pass / fail only, malformed,
     multiple); otherwise the CI score's maximum. Under `grading_mode:
     none`, no teacher score and no release (`409 grading_none`).
  2. **The release waits until every LIVE repository is frozen**
     (deleted, never-provisioned and archived-project repositories do not
     block); `409 not_frozen` otherwise; no partial release.
  3. **After the release** the student and the gradebook read the LIVE
     final score, flagged "changed after release" when it differs from
     the snapshot (`released_points/max`); a re-release rewrites the
     snapshot, audited, without a new notification; no withdrawal. A
     reopen after the release is accepted (the teacher's score waits for
     the new freeze).
  4. **Re-enabling the protection**: only the restores after the
     re-enable count toward the cap; the runs flagged during the
     suspension stay `to_verify`; nothing is restored at the re-enable.
  5. **Invitation resend**: staff only, a pending invitation only (409
     otherwise), at most once per repository per minute (429), audited,
     independent of M3-06's daily re-invite.
- **From M3-05b** (product owner, 2026-10-02): each repository shows its
  **final review** from its `grade_dispatches` row (`trigger = deadline`):
  none and frozen with no frozen run ⇒ "no review"; none and archived as
  its lock, or with its protection suspended ⇒ "no review" as degraded
  (audit `project_repo.review_skipped`, `reason`; a re-enabled protection
  makes the review due again); a 5xx is "not confirmed" too;
  a row with `dispatched_at` ⇒ asked at that time, of `sha`; a row without
  ⇒ **"not confirmed"** (claimed, GitHub's acceptance never recorded: a
  crash or no response — never sent again; a manual re-dispatch is a later
  option); then the review slot when the run came back. There is no
  `projects.review_dispatched_at` any more (migration `0060`): derive a
  project's "review dispatched" from the ledger. The checkpoints list
  (`GET …/checkpoints`, `ReviewCheckpoint`) shows a checkpoint not
  dispatched whose `dueAt` is at or after the project's deadline as
  **void** (it never fires; deletable), and a deletion refused with `409
  checkpoint_dispatched` once any ledger row names it.
- **As delivered** (branch `merge/M3-08b-project-release`). What M3-12,
  M3-09, M3-06 and M5-03 inherit:
  - **Routes**, all staff only through `accessibleProject` /
    `accessibleProjectRepo` (invariant 6: a student, another teacher, a
    token get the 404 of a missing entity; an impersonation the read-only
    403 of ADR-034 first, the loader's 404 where it may write; tested on
    every route). Refusal bodies are `ProjectRefusal` (`{ error, message,
    … }`); the codes joined `PROJECT_REFUSALS` (`ProjectErrorCode`), the
    statuses `modules/project/errors.ts`.
    - `PATCH /app/api/projects/:id/repos/:rid/score`, body
      `ScoreOverride` (strict) `{ points: number 0…1000 | null, max?:
      number > 0, comment?: string ≤ 2000 }` → `ProjectRepoScores` `{
      scores, released, changedAfterRelease }` — the row's `scores` and
      `released` as `ProjectRepoView` carries them, so the row is patched in
      place. `409 not_frozen` before the repository's `frozen_at`, `409
      grading_none`, `422 score_max_required` (no scored run and no `max`),
      `422 score_max_mismatch` (a `max` beside a scored run's that
      differs), `422 score_above_max`. `points: null` clears the score, its
      maximum and its comment. Audited `project_repo.grade_override`
      (`payload.before`, `after`: `{ points, max, comment } | null`).
    - `POST /app/api/projects/:id/release` → `ProjectReleaseResult` `{
      releasedAt, first, repos, scored }`. `409 grading_none`; `409
      not_frozen` with `live` and `frozen` counts in the body while a live
      repository is not frozen, or none is; `409 to_verify` with `repos`
      (ids) while a repository's final score rests on a run to verify
      (F-PROJ-14 amended 2026-10-04: the teacher's score settles it;
      `ProjectFinalScore.toVerify` says which, `scoresFinal` takes an
      `unverified` count so the page offers no Release meanwhile) — over
      the LIVE repositories only: a non-live one (deleted, archived
      project) never freezes, so its score to verify is released as NO
      score (`releasableScore`, `detail.ts`: the snapshot null, and the
      `changedAfterRelease` comparison reads the same, so it never
      re-offers Release). Audited
      `project.release` (`first`, `repos`, `scored`).
    - `POST /app/api/projects/:id/repos/:rid/protection` →
      `ProjectRepoProtection` `{ reenabledAt: iso | null }`; a no-op on a
      repository not suspended (its last re-enable, or null); `409
      repo_unavailable` (not provisioned, deleted, archived project).
      Audited `project_repo.protection_reenabled` (`payload.suspendedAt`).
    - `POST /app/api/projects/:id/repos/:rid/invite` →
      `ProjectInvitationResent` `{ invitationStatus, resentAt }`. `409
      invitation_not_pending`, `409 repo_unavailable` (not provisioned,
      deleted, archived project: `liveRepoForUpdate`), `429
      resend_too_soon` (less than a minute after the last resend), `409
      github_account_stale` (the student's account is gone or renamed:
      they relink), `502 invite_failed`. Audited `project_repo.invite_resent`
      (`payload.login`, `invitationStatus`).
    - `ProjectUnassigned` (`{ error: "unassigned_students", message,
      students: [{ enrollmentId, nom, prenom }] }`) is the `409` body of
      Publish, for M3-12.
  - **The teacher's score has its own maximum** (decision 1):
    `project_repos.teacher_max`, written WITH the points — the scored run's
    maximum when the repository has one (the run the final score would
    otherwise come from: the review slot, else the frozen, else the
    current; `resolveFinalScore` without the teacher), the teacher's own
    otherwise. The score is then self-contained: a later run with another
    maximum never re-reads it. `resolveFinalScore` takes `teacherMax`
    (`teacherMax ?? review.max ?? ci.max ?? null`); a null `teacher_max`
    (heig-classroom's imported rows) keeps reading the CI's, as before.
    `teacherScoreMax(points, given, runMax)` in `@quiz/domain/finalScore.ts`
    is the rule; a run to verify is no scored run (`runMax` null): the
    teacher gives their own maximum. `ProjectRepoView.scores.teacher`
    gained `max`; `resolveFinalScore` and `ProjectFinalScore` carry
    `toVerify` (the run behind the score is to verify; never for a
    teacher's).
  - **The release** (decisions 2 and 3): `releaseProject`
    (`modules/project/grades.ts`) reads the page's own set and counts —
    `studentRepos(db, project)` (`repos.ts`: every repository but those of
    a user who now holds a staff seat) and `releaseCounts(project, repos)`
    (`deadline.ts`: live, frozen) — and refuses `to_verify` while a final
    score rests on a run to verify (above). It writes `released_points /
    released_max` for EVERY repository of that set — a deleted repository with a score gets its
    snapshot too, so its grade is released and `changedAfterRelease` stays
    false. The grade is not stored: `scoreGrade(points, max, scale)` on
    read, everywhere (M5-03 reads the snapshot that way). The readers keep
    the live final score; `changedAfterRelease` is the flag, which a
    release again clears. **M3-09's hook**: `ProjectReleaseResult.first`
    (and the audit's `payload.first`) is true on the first release only;
    `project_grade_final` goes out then and never on a release again — the
    place is marked in `routes.ts`.
  - **The protection re-enabled** (decision 4): `reenableProtection`
    (`protection.ts`) clears `protection_suspended_at` and writes a new
    column `project_repos.protection_reenabled_at`; `recordRestore`'s cap
    counts `reverts.created_at > protection_reenabled_at` only, within the
    hour. Nothing restored at the re-enable, the runs flagged meanwhile
    kept `to_verify`. `FINAL_REVIEW_DUE` already required
    `protection_suspended_at IS NULL` and `review_skipped` writes no ledger
    row, so the final review is due again on its own (tested through
    `claimReviewWork` and the page).
  - **The resend** (decision 5): `resendInvitation` (`invitation.ts`),
    the minute claimed on a new column `project_repos.invitation_resent_at`
    before GitHub is called and given back when GitHub's part fails (not
    once GitHub accepted: the status and the audit then land in one
    transaction);
    `linkedLogin` names the student (today's login by the immutable id);
    `inviteCollaborator(…, "push")`. The row's `invitation_status` follows
    GitHub's answer (`accepted` on a 204). Apart from M3-06's daily
    re-invite, which neither reads nor writes `invitation_resent_at`.
  - **The final review on the row** (M3-12's challenge, 2026-10-04):
    `ProjectRepoView.review` = `ProjectRepoReview` `{ status: "pending" |
    "none" | "skipped" | "unconfirmed" | "asked" | "done", reason:
    "no_frozen_run" | "archived" | "protection_suspended" | null, askedAt:
    iso | null, sha: string | null, runId: uuid | null }`, derived by
    `reviewState` (`@quiz/domain/projectView.ts`) from the row and its
    `grade_dispatches` row (`trigger = deadline`), read in one query by
    `detail.ts`: the review slot filled ⇒ `done`; a ledger row ⇒ `asked`
    (`dispatched_at`) or `unconfirmed`; else `grading_mode: none` ⇒ `none`;
    not frozen ⇒ `pending`; no frozen run ⇒ `none/no_frozen_run`; archived
    ⇒ `skipped/archived`; suspended ⇒ `skipped/protection_suspended`; else
    `pending` (due, not yet asked). The ledger wins over the row's state.
    A test per status in `detail.db.test.ts`.
  - Migration `0061_project_staff_writes`: the three additive columns.
    `detail.ts` exports `repoScores(project, repo, runs)` (exactly
    `ProjectRepoScores`, the score route's answer) and `slotRuns(db,
    repos)`, the one computation behind the rows and the score's write;
    `deadline.ts` exports `repoForUpdate` (the project then the repository
    locked) and `liveRepoForUpdate` (the same, refused unless `isLive`),
    the one lock every repository write takes.
  - Not done here: the web page (M3-12); the notification (M3-09); the
    student's own resend (M3-09); storing a repository's name without its
    owner (the M3-04 follow-up, still open); a manual re-dispatch of an
    unconfirmed review.

### M3-09 — split (orchestrator, 2026-10-04)

Three tasks, from the spec: **M3-09a** the student's side as it reads
(the view, the cards, the home, the student's resend, the leak test);
**M3-09b** the notifications (the seven kinds, the Teams manifest bump, the
day-before reminder, the sends at the trigger sites); **M3-09c** the
real-time notices of F-PROJ-21, done client-side. The "From …" notes of the
former M3-09 card are kept below, under the task that inherits each.

### M3-09a — The student's project view, the cards, the student's resend
- **Depends on**: M3-04, M3-08b, D18. ‖ M3-12b.
- **Goal**: the project's student view (THE single exit, N-SEC-20), the
  student's project cards on the home and the classroom page through
  `KINDS`, the student's own resend of a pending invitation, the leak test.
- **Decisions** (orchestrator, 2026-10-04, from the spec; the product
  owner's D18/D26/F-PROJ-15 stand):
  1. **The home shows projects too** (F-ORG-14: Activities is the summary
     of every activity): `StudentHome.open/upcoming/past` become the
     `StudentActivityCard` union through `KINDS`; the web renders a project
     card minimally (title, status, deadline), the full `ProjectRow` being
     M3-13's; `StudentClassroomPage` lists projects in Activities and has
     **no Projects tab** (F-ORG-15): `hasProjects` dropped.
  2. **Card status words** stay the spec's (`to_accept | in_progress |
     locked`, plus `released`); the card gains `invitation`,
     `githubLinked`, `repoUrl` (own repository only) — the three facts of
     the row's four-state button, `docs/merge/05-web.md` §5.3: not linked,
     linked without a repository, invitation pending, ready — and
     `deadlineAt` is the student's **effective** deadline. (Review round 1:
     a `released: boolean` beside `status: "released"` was dropped.)
  3. **The view** `GET /app/api/student/projects/:id` is loaded through the
     classroom's student branch (the rule of `readableClassroom`, the
     student payload forced): a teacher in the student view sees no
     repository and no Accept; an impersonation gets the student payload
     and stays read-only. Between the provisional and the definitive
     freeze the score shows as frozen, marked indicative until the release.
  4. The student's resend reuses `resendInvitation` and its minute column,
     never the staff's route.
- **From M3-02** (product owner, D26 addendum 2026-10-02): teachers create
  projects before the cutover, so the students saw nothing until this
  task: `projectActivity.studentCards` stayed empty until the view landed
  with its N-SEC-20 leak test.
- **From M3-03** (orchestrator, 2026-10-02): the student's resend of an
  invitation (F-PROJ-07).
- **From M3-08b** (2026-10-04): the student's own resend of an invitation
  (F-PROJ-07) reuses the staff's rule and column (`resendInvitation`,
  `invitation.ts`; `project_repos.invitation_resent_at`: one minute per
  repository, shared by whoever asks) through the student view, never the
  staff's route.
- **As delivered** (branch `merge/M3-09a-student-project-view`). What
  M3-13, M3-09b, M3-09c and M5-03 inherit:
  - **Contracts** (`packages/contracts/src/project.ts`, `student.ts`):
    `StudentProjectCard` `{ kind: "project", id, title, classroomId,
    classroomName, courseCode, startAt, deadlineAt (EFFECTIVE), status:
    StudentProjectStatus (to_accept | in_progress | locked | released),
    invitation: "pending" | "accepted" | null, githubLinked, repoFullName,
    repoUrl }` — the repository named only when live (provisioned, not
    deleted). `StudentProject` = the card's facts without the three
    repository fields + `{ gradingMode, repo: StudentProjectRepo | null,
    release: StudentProjectRelease | null, serverNow }`;
    `StudentProjectRepo` `{ fullName, url, invitation: "pending" |
    "accepted", deleted, locked, lastCommit: { sha, at } | null, ciStatus,
    run: { sha, url, conclusion, completedAt } | null, score: { points,
    max, grade, frozen } | null }` — the score INDICATIVE until the release,
    null under grading `none`; **once the student's deadline is applied or
    passed, `lastCommit` and `ciStatus` are the SELECTED run's commit and
    conclusion (or null / `none`), never the row's head, which the webhooks
    keep moving on a repository left open (strategy `commit`)** (N-SEC-20,
    review round 1). `StudentProjectRelease` `{ at, points, max, grade,
    comment }`, the comment AS THE RELEASE WROTE IT: new column
    `project_repos.released_comment` (migration
    `0063_project_released_comment`, additive), written by
    `releaseProject` beside the points and the maximum — a comment written
    after the release waits for the next one, like the score it may
    describe. `StudentHome` moved from `live.ts` to `student.ts` as
    `StudentActivities.extend({ serverNow })`; `StudentClassroomPage` lost
    `hasProjects`.
  - **Pure rules** (`@quiz/domain/projectStudent.ts`, unit-tested):
    `studentProjectStatus` (released → locked at the effective deadline or
    while GitHub holds the repository locked → in progress once provisioned
    → to accept), `studentProjectGroup` (upcoming before the start, past
    once locked or released, open between), `studentScoreRun` (the frozen
    slot once the deadline is applied — never a run after it —, the current
    slot before; never the review's nor the teacher's).
  - **The view** (`Q:modules/project/studentView.ts`, the one exit):
    `studentProjectCards(db, userId, now, classroomId?)` (every classroom
    where the caller holds a claimed seat, or one; the repository joined
    through a STUDENT seat only, ADR-018; never a draft nor an archived
    project; the soonest project deadline first), `studentProject(db,
    scope, userId, now)`, `studentResendInvitation` (`409 repo_unavailable`
    before Accept, then `resendInvitation`'s refusals). Loader
    `studentProjectView` / `findStudentProjectView` (`guards.ts`): the
    project (neither draft nor archived) then `findReadableClassroom` with
    `studentView` forced — ONE rule with the classroom page — the course's
    staff, a claimed seat, an impersonation through the seat; a
    `seb`/`kiosk` session, a stranger get the 404; an API token reads (as
    it reads the classroom page) and never writes. `ReadableClassroom.seat`
    gained `staff`. The resend route takes `studentProject` (a claimed
    student seat, own portal session). A confined session's home
    (`/student/home`) carries no project card (`StudentScope.confined`,
    `activity/kind.ts`): its exam leads nowhere else.
  - **Routes** (`project/routes.ts`, with the App only): `GET
    /app/api/student/projects/:id` → `StudentProject`; `POST
    /app/api/student/projects/:id/invite` → `ProjectInvitationResent`,
    audited `project_repo.invite_resent` with the student as actor.
  - **The home** `GET /app/api/student/home` is the `activity` module's
    (`activity/routes.ts`, `studentHome` in `activity/service.ts`):
    `ActivityKind.studentCards(db, caller, now, { classroomId?, confined })`
    — one signature for the home and the classroom page; the groups are
    the domain's `StudentActivityGroup`. `live.studentHome` now answers an
    `EvaluationHome` (evaluation cards only), read by the evaluation
    adapter and the kiosk's `pairableEvaluations`. `htmlUrl(fullName)`
    (`github/git.ts`) is the one GitHub page URL.
  - **Web** (minimal, the full row is M3-13's): `student/cards.tsx` gains
    `ActivityCard` (one switch over the union for Open now, Upcoming and
    Past; a project draws `ActivityRow` with its title, the status word
    `sproj.status.*`, the deadline or the start, no button) and
    `UpcomingByDay` groups by `opensAt(card)` (a project's `startAt`);
    `mostUrgent` ranks a project by its deadline. Mock: `?projects=1`
    gives the student persona three cards (`STUDENT_PROJECT_OPEN`,
    `_SOON`, `_PAST` in `mock/student.ts`, grouped through
    `studentProjectGroup`), each served as a view derived from its card
    (one scored, one released) and checked by `contract.test.ts`; M3-13
    fleshes them out.
  - **Leak test** (`studentView.db.test.ts`, N-SEC-20): a second student's
    repository, login, id, head sha, score, review score, teacher score and
    comment, the source and distribution names, a draft's title, the
    staff's flags (`toVerify`, `multiple`, `malformed`,
    `protectionSuspended`), the first student's own push and run after the
    deadline (sha and points), their own unreleased review score, their own
    teacher score and comment before the release, a comment written after
    the release — searched for in every response of the first student
    (home, classroom page, view, Accept, resend), for each caller (student,
    teacher in the student view, impersonation, API token), before and
    after the release; the second student's hint never on a topic the first
    listens to; a confined session's home without a project card.
  - Not done here: the notifications (M3-09b), the F-PROJ-21 notices
    (M3-09c), the `ProjectRow` button and its indicative score (M3-13), a
    group's repository (M3-15).

### M3-09b — Notifications of projects
- **Depends on**: M3-09a, M3-04, M3-05a, M3-05b, M3-08b.
- **Goal**: the seven notification kinds of F-NOTIF-13 with ADR-030
  defaults and templates (en/fr), one Teams manifest bump, the day-before
  reminder, and the sends at the trigger sites.
- **The kinds and their defaults** (F-NOTIF-13): `project_published` (the
  students of the classroom, on publish — `publishProject` sends none
  today, scheduled publication included), `project_repo_invited` (the
  student, after a successful Accept), `project_provision_failed` (the
  course's staff, for a `project.accept_failed` whose `payload.notify` is
  true — the row's first failure, never a refused invitation; the text must
  cover a name collision, `repo_name_taken`, which only staff can resolve),
  `project_deadline_reminder` (the student, the day before THEIR effective
  deadline), `project_deadline_applied` (the staff, one entry per project
  with the count locked, worded from the audit `project.deadline_enforced`
  — `locked`, `archived`, `committed`), `project_grade_final` (the
  students, on the FIRST release only: `ProjectReleaseResult.first` and
  the audit's `payload.first`; the place is marked in the release route; a
  release again notifies nobody — product owner, decision 3 of M3-08b),
  `github_org_lost` (the staff, on GitHub's delete events only — an
  installation or an organization gone — never on a transient failure).
  The staff's notice of a review asked (heig-classroom's
  `llm_review_dispatched`, "(n/N repositories)") is worded from the audits
  `project.review_dispatched` and `project.checkpoint_dispatched`
  (`dispatched`, `deleted`, `unconfirmed`, `failed`; at most one per pass
  that changed something); `project_repo.review_skipped` is the staff's.
- **The reminder** mirrors F-NOTIF-06's: claimed by a conditional UPDATE
  and sent in the same task, never claimed without being sent, in the
  ticker's `projectTick` (`modules/project/jobs.ts`). M3-05a re-arms
  `projects.reminder_sent_at` on every move of the project's deadline; a
  student whose repository has its own deadline is reminded of THAT one,
  so the claim is **per repository** for them: a `project_repos`
  reminder column beside the project's.
- **Dropped**: heig-classroom's `grade.final` mail on the final review
  (sent when `review_grade_run_id` is filled). F-PROJ-15: the final score
  reaches a student only after the release; `project_grade_final` covers
  it. A student's own dispatch is never worth a notice.
- **From M3-04** (2026-10-02): the hints exist (kind `projects`, to the
  repository's students' `user:` and the course's `course:`, never
  `classroom:`; `Q:modules/project/events.ts`, tested).
- **From M3-13** (2026-10-04): a student's entry about a project links to
  `/projects/:id` — one address, which serves the student's project page to
  a student and the staff's page to the staff (`App.tsx`, F-ORG-15).
- **Tests**: each kind sent once at its trigger, to its audience and nobody
  else (a student never receives another student's notification); the
  reminder claimed and sent together, per repository where a repository has
  its own deadline; `project_grade_final` on the first release only.
- **Decisions** (orchestrator, 2026-10-04, within D18 and F-NOTIF-13):
  seven kinds and no eighth — the staff's "review dispatched" notice is
  NOT a notification (the project page shows the dispatch state);
  `project_published` and `project_deadline_applied` off by e-mail and
  Teams, the five others on; the reminder claimed per project and per
  repository with its own deadline, re-armed only by a move more than 24 h
  ahead; `project_deadline_applied` only when a pass locked or committed
  (`locked + committed > 0`), folded per project (a project fold target,
  F-NOTIF-12 amended); `project_provision_failed` with a `reason`;
  `github_org_lost` on the row's actual transition, one notice per
  organization per loss, per classroom; the project kinds hidden from the
  settings without the App.
- **As delivered** (branch `merge/M3-09b-project-notifications`):
  - **Contracts** (`packages/contracts/src/notifications.ts`): the seven
    kinds in `NOTIFICATION_KINDS` (the student kinds after
    `results_updated`, the staff kinds after `grading_ready`), their
    payloads (`{ projectId, projectTitle }`, plus `count` for the two
    folded staff kinds, `reason: PROVISION_FAILURE_REASONS =
    repo_name_taken | github_error` for the failure; `github_org_lost`
    `{ classroomId, classroomName, orgLogin }`), `DEFAULT_CHANNEL_ENABLED`,
    `NOTIFICATION_AUDIENCE` (`seat` / `course`), `GITHUB_KINDS` and
    `notificationKindsFor({ …, github })` — the settings route passes
    `githubApp(config) !== null`, so the grid (unchanged) lists them only
    where the App exists.
  - **Schema** (migration `0068_project_notifications`, additive):
    `notifications.project_id` (FK cascade, index) lifted from the payload
    by `notifyMany`; `NOTIFICATION_FOLD_TARGETS` gains
    `project_deadline_applied` and `project_provision_failed` →
    `projectId` (two partial unique indexes); `project_repos.reminder_sent_at`;
    `github_organizations.suspended_at` (review round 1).
  - **Pure rule** (`@quiz/domain/deadlineReminder.ts`, unit-tested):
    `DEADLINE_REMINDER_MS` (the evaluations' reminder reads it too) and
    `reminderClaimAfterMove` (re-armed only when the new deadline is more
    than a day away). The window rule is the scans' (`start_at`).
  - **Shared helpers** (review round 1): `notifyUsers(db, userIds, payload,
    log?)` in `notifications/service.ts` — one payload to an audience,
    deduped, best-effort — used by the project kinds, `orgLost` and the
    evaluations' `sendDeadlineReminders`; `classroomStaffIds(db,
    classroomId)` in `org/service.ts`, used by the project's staff kinds,
    `orgLost` and `grading/events.ts`'s `staffOf`; `repoUserIds(db, repos)`
    over many repositories in one query.
  - **Templates** (`notifications/templates.ts`, en/fr, Teams activity
    strings included; `reason.*` sentences); `notificationPath`:
    `/projects/:id`, `/classrooms/:id/settings` for `github_org_lost`;
    the Teams topic takes `projectTitle`. `teamsApp.ts`:
    `TEAMS_ACTIVITY_KINDS` + 7, `TEAMS_APP_VERSION` 2.1.0 → 2.2.0.
  - **Emitters** (`Q:modules/project/notify.ts`: `classroomStudentIds`,
    `announcePublished`, `tellProjectStaff`, `remindDeadlines`; best-effort,
    after commit): `publishProject` (by hand and the ticker) →
    `project_published`;
    `acceptProject` → `project_repo_invited` to whom THIS request invited
    and GitHub left pending — the accepting student of a repository just
    provisioned, the members a group's first Accept invites, a later
    member joining (`tellInvited`; rebased over M3-15b-1) —,
    `project_provision_failed`
    to the staff on the row's first failure (audit `project.accept_failed`
    gains `payload.reason`: `repo_name_taken` | `invitation_refused` |
    `github_error`); `releaseProject` → `project_grade_final` to the
    students of the repositories the release covered, `first` only;
    `runDeadlineJob` → `project_deadline_applied` with `locked +
    committed` when > 0; `projectTick` step 4b `remindDeadlines` (the
    project claim — group members of a repository with its own deadline
    left out too —, then the repository claim, `LIVE`, no staff lock, both
    under `start_at <= deadline − 24 h`); `projectDeadlineMoved` and
    `setRepoDeadline` apply the re-arm rule; `github/service.ts` `orgLost`
    from `forgetInstallation` and `markOrgDeleted` (when the row held an
    installation): the course staff of each non-archived linked
    classroom, one entry per classroom. **A suspended installation is
    kept** (`suspended_at`, audited `github_org.installation_suspended`)
    and acts as none (`installed()`: installed, not suspended, active —
    the listing, the connect sheet, the projects and the journal read the
    same rule); GitHub's state decides, never the webhook's action, and
    a deletion after a suspension is told once.
  - **Web**: `NotificationPanel` words the seven kinds (`notif.project*`,
    `notif.githubOrgLost`, `notif.provisionReason.*`) and opens
    `{ view: "project" }` / `{ view: "classroomSettings" }`;
    `settings.kind.<kind>[.desc]` ×7 in `en.ts` and `fr.ts`; the mock's
    settings pass `github: true`.
  - **Tests**: `project/notifications.db.test.ts` (each kind to its
    audience and nobody else, the fold, the reason, the reminder's two
    claims and its rules, first release only, deadline applied only when
    something locked); `github/webhooks.db.test.ts` and
    `github.db.test.ts` (org lost via webhook and healing, told once per
    classroom, never on a suspension); `templates.test.ts`,
    `teamsApp.test.ts` (seven kinds at 2.2.0), the contracts' and the
    domain's unit tests, the web panel and settings tests.
  - **Review round 1** (2026-10-04): the suspension model above; the
    settle-at-start claim dropped for the scans' `start_at` rule (an own
    deadline given within a day on a project open for longer IS reminded:
    the student's window is their time in the project); the shared
    helpers; `GITHUB_KINDS` a `const` array.
  - Not done here: the F-PROJ-21 notices (M3-09c); a notice when
    `retireLoginHolders` retires an installed row (a rename race is the
    likelier reading: documented, not sent).

### M3-09c — Real-time notices of projects (F-PROJ-21)
- **Depends on**: M3-09a, M3-12a.
- **Goal**: the worded notices of F-PROJ-21 on the project page and the
  student's project — a push received, protected files restored, a score
  captured, an acceptance, a deadline applied, a review dispatched, a sync
  done — **client-side**, by comparing the payload re-read on a `projects`
  hint with the one before it (no data-carrying SSE frame: the hints stay
  what ADR-005 makes them). Worded through `t()` from the structured
  difference, never a server sentence.
- **From M3-04** (2026-10-02): the facts the notices read are recorded —
  a push (the receipt and `lastCommit`), a restore (audit
  `project_repo.restore` `{files}`), a score captured (a
  `project_grade_runs` row `ok`), the suspension (audit
  `project_repo.revert_cap`), a repository deleted (audit
  `project_repo.deleted`).
- **From M3-09b** (2026-10-04): the notices are NOT the notifications —
  `project_deadline_applied` reaches the staff's bell once per job pass,
  and the student's reminder their bell; a notice worded from the re-read
  payload must not repeat them. The facts a notice may read now include
  `project_repos.reminder_sent_at` (not shown to the student: the
  reminder itself is).
- **Tests**: web, on the re-read payloads: each notice from its difference,
  nothing on an unchanged payload.
- **Decisions** (spec challenge and product owner, 2026-10-05): the notices
  are ephemeral toasts on TWO pages — the staff's project page and the
  student's project — computed in the browser from the page's data before
  and after each re-read (the 30 s refetch, the `projects` hint), worded
  through `t()` en/fr, shown through the existing toast primitive. No
  server work, no new field, no notification behind them, no per-kind
  preference in v1 (heig-classroom's `notifyPrefs` is not ported). Staff:
  **one notice per kind per re-read, with a count** ("3 pushes received"),
  never one per repository. **Dropped**: "protected files restored" (no
  datum on the page; the `protectionSuspended` flag and the bell cover the
  cap) and "sync done" (M3-07 shows its last-sync line and counts itself).
  No deadline notice for the staff and no release notice for the students:
  `project_deadline_applied` and `project_grade_final` already toast
  through the notification kinds (`notifications/toasts.ts`), never
  doubled. Nothing on the first read (the `ToastGate` rule), nothing on an
  unchanged read. F-PROJ-21 amended.
- **As delivered** (branch `merge/M3-09c-project-notices`): one hook,
  `useNoticeToasts(query, notices)` (`Q:apps/web/src/notifications/notices.ts`),
  generic over a page's data: the first read after mount is the baseline
  (cached data is not a read, nor is a failed refetch), a new key a new
  baseline, the existing toast primitive keyed per kind. Two pure
  functions it is given: `project/projectNotices.ts` (the four staff kinds,
  counted per kind) and `student/studentProjectNotices.ts` (the four student
  kinds over `StudentProject` alone; a push and a score only while the
  project is open on the payload's `serverNow`). Keys `project.notice.*`
  (`.one` for a single one) and `sproj.notice.*`; `?notices=1` mock scene.
  Decisions taken alone: an acceptance is a repository that appeared
  (heig-classroom's `assignment_accepted`), not an invitation accepted on
  GitHub; the student's "acceptance" is their invitation accepted only; the
  lock is the one `warning`-toned notice; the read after a staff write of
  the page echoes nothing, because no compared field is one such a write
  changes (said and tested in `projectNotices.ts`).

### M3-10 — Web: projects in Activities, "New ▾"
- **Depends on**: M3-01 contracts, M1-05. ‖ M3-11.
- **Goal**: the classroom's Activities tab and `/activities` list projects;
  "New ▾" (Evaluation, Poll, Project) with the GitHub gate (opens M2-07's
  sheet first).
- **As delivered** (branch `merge/M3-10-web-projects`; product owner
  2026-10-02): projects are open to every teacher, no gate but GitHub's —
  and no door to a page that does not parse: `project` and `projectNew`
  stay `preview` (`CLASSROOM_PAGES`) until M3-12 and M3-11, and a screen
  asks `routeEnabled(view)` (`router.ts`) before linking to one.
  - **New ▾** (`Q:apps/web/src/activities/NewActivity.tsx`, stateless:
    `ClassroomView` hands it its GitHub read) replaces the header's "New
    evaluation" on the Evaluations tab: Evaluation and Project. **No
    Poll**: the launcher takes no classroom (its audience is a remembered
    choice), so a Poll item could not land on this classroom. The plain
    "New evaluation" button stays until the GitHub read is a success
    (loading, failed, or the 404 of a platform without the App) and
    wherever `projectNew` does not parse — so production keeps the plain
    button until M3-11. Not connected ⇒ Project carries
    `project.notConnected` and calls `ClassroomView`'s `openConnect`
    (`/classrooms/:id/settings?connect=1`, M2-07's sheet; no return to a
    form, F-GH-02); connected ⇒ route `projectNew`
    (`/classrooms/:id/projects/new`, `ComingSoon`, no `section`).
  - **Projects group** (`Q:apps/web/src/project/ProjectGroup.tsx`) under
    `EvaluationList`, the tab unrenamed, the only one of the two with a
    heading (the tab names the evaluations): `GET /classrooms/:id/projects`
    (`ProjectActivitySummary[]`, key `classroomProjectsKey` under
    `classroom`); title + `StateBadge`, Start, Deadline. Drawn only with
    rows: nothing while loading, on `[]` or on a 404; `QueryError`
    otherwise. A row opens `project` only where it parses (not clickable
    in production until M3-12).
  - **`KIND`** (`activities/model.ts`): one entry per `ActivitySummary`
    kind, the client mirror of the server's `ActivityKind` — type, type
    label, anchor (a project's start), closes (its deadline), live (a
    project never), in the room, gantt span, home (`null` where the page
    does not parse), state label and tone; `kindOf(row)` is the one cast.
    Views, the gantt, the menu and the Projects group read it; no view
    branches on `kind` (but `ActivityMenu`'s narrowing to read `mode`). A
    published project is bucket `open` (amber badge and bar, the legend
    now "waiting room, paused, open project"), a locked one `ended`.
    `project/common.ts`: the state's tone and word, pure.
  - **/activities** lists the union and still creates nothing; a type chip
    is drawn only for a type that has rows (every chip, one rule); no row
    menu for a project.
  - `project` takes no tail: `/projects/:id/groups` is home in production.
  - Mock: `mock/project.ts`, `?projects=1` (three on PRG1-2026, one per
    state; r2 is the unconnected classroom), checked in `contract.test.ts`.
    Scenes `classroom-projects`, `classroom-new-menu[-unconnected]`,
    `activities-projects[-schedule]`. Students see no project (M3-13).

### M3-11 — Web: new project form
- **Depends on**: M3-02 contracts, M2-07. ‖ M3-10, M3-12.
- **Goal**: redesign of `AssignmentForm` (sheet or stepped page, decided in
  the PR's challenge step), novice/expert split (spec 08).
- **From M3-02**: the refusal bodies have no response schema yet: add
  `ProjectRefusal` (`{ error: ProjectErrorCode, message, branches? }`) and
  `ProjectUnassigned` (`students`) to `contracts/src/project.ts` with this
  form, their first consumer.
- **From M3-10**: "New ▾ › Project" on a connected classroom navigates to
  the route `projectNew` (`/classrooms/:id/projects/new`, `router.ts`),
  which renders `ComingSoon` (`App.tsx` `PAGES`) and is still `preview`:
  **dropping `preview` from `projectNew` turns "New ▾" on in production**
  (`NewActivity` asks `routeEnabled("projectNew")`). Replace that placeholder
  with the form — or, if the form is a sheet of the classroom page, drop
  the route and have `NewActivity`'s Project item open the sheet instead.
  On create, invalidate `classroomProjectsKey(id)` and `activitiesKey`.
- **Decided for it** (product owner and orchestrator, 2026-10-02): **one
  page** at the `projectNew` route, not a sheet nor steps, one primary
  action **Create** (no Publish: F-PROJ-13 gives it to the project page);
  `projectNew` stays `preview` until M3-12 (the form lands on the project
  page, still `ComingSoon`).
- **As delivered** (branch `merge/M3-11-project-form`):
  - `Q:apps/web/src/project/NewProjectPage.tsx` (page, queries, create),
    `ProjectAdvanced.tsx` ("Advanced options"), `newProject.ts` (pure: the
    draft, `projectBody` — parsed by `ProjectCreate` itself —, the missing
    fields and their ids, `refusalPlace`), `ProtectedFiles.tsx` (the
    suggestions as checkboxes and the `grading.yml` warning, for M3-12 too).
    A field's error is the shared `fieldErrorProps` / `<FieldError>` of
    `src/ui/` (the evaluation's timing step uses them too).
  - **Novice** (spec 08): name, source (`GET …/sources`, as sorted by the
    API; its default branch and last push under it), deadline
    (`datetime-local`, the browser's zone — `localTimeZone`, `ui/dates` —
    named when it is not `SCHOOL_TIME_ZONE`). Picking a source reads `GET …/sources/:repo`; its
    `suggestedProtected` are sent even while Advanced stays folded (a
    Create pressed while it is read waits for it).
  - **Advanced** (folded, not remembered): branches (chips in the order
    chosen, the first the students' default; default the source's default
    branch), history (`squash`/`whole`), publication (by hand / at the
    start), deadline as a date or a duration (by hand only; in days),
    at the deadline (`lock`/`commit`), grace, score (`auto`/`none`) and
    scale (linear / score is the grade, its fallback said as static text),
    protected files (the source's suggestions only; unchecking
    `grading.yml` warns), groups and their
    advisory maximum. A start only with a scheduled publication, a
    duration only with a manual one: the form never sends both.
  - **Refusals** (`ProjectRefusal` added to `contracts/src/project.ts`;
    `ProjectUnassigned` waits for Publish, M3-12): `source_not_found` under the source (with
    `branches`: names them and unfolds Advanced; the sources and detail are
    re-read), `deadline_past` under the deadline, `duplicate_slug` under
    the name, `not_connected`/`app_not_installed` (from the sources' read or
    the create) a page state whose action is the route
    `{ view: "classroomSettings", id, connect: true }` (new `connect` on
    that route, `?connect=1`), `distribution_failed` a danger alert above
    the form with Retry, values kept; anything else "Could not create the
    project". While the POST runs, the whole form is a disabled fieldset
    and Create reads "Building the students' repository…".
  - Success: invalidate `classroomProjectsKey(id)` and `activitiesKey`,
    toast, navigate to `project` (M3-12). Keys `projectSourcesKey`,
    `projectSourceKey` (beside the projects, not under them).
  - Mock `mock/projectNew.ts` (section 8b, after GitHub whose link it reads):
    sources and details under `?projects=1`, `?srcmissing=1`,
    `?distfail=1`, a 2.5 s build; the dispatcher now awaits a handler.
    Scenes `project-new`, `-advanced`, `-refusal`, `-unconnected`.
  - Not done: checkpoints (M3-05), the project page (M3-12).

### M3-12 — split (orchestrator, 2026-10-04)
M3-12 (the project page) is split in three PRs: **M3-12a** the page on what
`main` holds today (M3-08a's reads, M3-05a's repository routes, M3-05b's
checkpoints, M3-02's lifecycle), **M3-12b** the per-repository writes of
M3-08b (score, resend, re-enable) and the review field, **M3-12c** the
release. The original card's notes stay here; each part has its card below.

### M3-12a — Web: project page (reads, lifecycle, deadline, checkpoints)
- **Depends on**: M3-08a contracts (M3-08b for the writes). ‖ M3-11.
- **From M3-08a** (2026-10-02): the page reads `GET /app/api/projects/:id`
  (`ProjectDetail`: the summary, `counts`, `primaryAction` decided by the
  server — draw that one action, never derive it —, `rows` with `repo:
  null` as "not accepted", the flags, the scores with their `source` and
  `grade.fellBack` for the scale's warning) and, when a row opens, `GET
  …/repos/:rid/runs` (`GradeRunList`; the three slot ids mark the current,
  frozen and review runs). `liveStale` true: refetch once a few seconds
  on (the live state fills the cache meanwhile). Card M3-08a, "As
  delivered".
- **Goal**: redesign of `AssignmentDetail` in sections; grade history and
  override inside. Scenes `project`, `-grades`, `-sync-banner`.
- **From M3-10**: the route `project` renders `ComingSoon` and is still
  `preview`; **dropping `preview` from `project` makes the project rows
  clickable in production** (the Projects group and /activities, through
  `KIND.project.home` in `activities/model.ts`, which asks
  `routeEnabled("project")`).
- **From M3-11** (product owner, 2026-10-02): the new project form is
  shipped but `projectNew` stays `preview` so production never lands on a
  `ComingSoon` after a create. **Drop `preview` from `projectNew` and
  `project` together in this task**: that turns "New ▾" on in production
  (`NewActivity`), the form, and the page it navigates to after a create
  (`{ view: "project", id }`). Publish is this page's: its `409
  unassigned_students` body (`students`: enrollment id, nom, prenom) gets
  its response schema here, `ProjectUnassigned` beside M3-11's
  `ProjectRefusal`. The protected files' edit reuses
  `project/ProtectedFiles.tsx`.
- **Decided for it** (product owner and orchestrator, 2026-10-04): (1)
  projects go live in production with this PR — `preview` dropped from
  `project` AND `projectNew` (New ▾, the form and the page); `projectGroups`
  stays `preview`; (2) an action is drawn only when its route exists:
  Release and Sync are said in the header as text, never derived, until
  M3-12c and M3-07 turn them into the primary button; `none` ⇒ no accent;
  (3) group mode hidden in the new project form until M3-16, the 409
  `unassigned_students` still lists the names (no link); (4) a deadline
  moved later after it passed asks for confirmation, naming the reopen and
  the repositories it reaches; (5) refetch every 30 s while the tab is
  visible, once ~3 s after a `liveStale: true` response (SSE with M3-09);
  (6) the edits are the fields F-PROJ-03 allows once published (name,
  deadline, deadline strategy, protected files), the full draft edit a
  follow-up; (7) the final review state per repository waits for M3-08b's
  `review` field (M3-12b).
- **As delivered** (branch `merge/M3-12a-project-page`). What M3-12b,
  M3-12c, M3-07, M3-09, M3-13 and M3-16 inherit:
  - **Routes** (`router.ts`): `project` and `projectNew` are no longer
    `preview` — New ▾ › Project, the form and `/projects/:id` ship in every
    build; `projectGroups` alone stays behind `CLASSROOM_PAGES`. `App.tsx`
    renders `project/ProjectPage.tsx`; `soon.project` is gone.
  - **The page** (`project/ProjectPage.tsx`; keys `projectKey(id)`,
    `projectRunsKey(id, rid)`, `projectCheckpointsKey(id)` under a root
    `project` that `HINT_ROOTS.projects` now names): `GET /app/api/projects/
    :id` (`ProjectDetail`), refetched every 30 s while visible and once 3 s
    after `liveStale: true` (`projectRefetchInterval`, `projectPage.ts`).
    States: skeleton, a 404 as the classroom's (`QueryError` titled
    `project.notFound`), `PageError` with retry, the empty roster (`EmptyState` →
    the classroom's Roster tab). Header: name renamed in place
    (`EditableTitle`, `PATCH {name}`) when `editable` names it, the state
    badge (`project/common.ts`), the archived badge, ONE sentence
    (`projectStatus`, the key and the date it names: draft / scheduled /
    open until / locked since / locked not yet frozen / released on /
    **release** and **sync** as text) and
    the counts line; the primary button only for `primaryAction:
    "publish"` (`POST …/publish`, success → `projectKey`,
    `classroomProjectsKey`, `activitiesKey` invalidated); overflow menu
    Archive (confirmation) / Restore / Delete (`typeToConfirm` the name,
    the body says nothing is deleted on GitHub, F-PROJ-16; then the
    classroom). Publish's `409 unassigned_students` is parsed by a LOCAL
    zod schema `UnassignedBody` (`projectPage.ts`) and shown as a danger
    alert listing the names, no link — **M3-08b adds `ProjectUnassigned`
    to the contracts; M3-12b replaces the local schema by it.** Any
    grade with `fellBack` ⇒ one warning alert on the scale.
  - **Settings** (`project/ProjectSettings.tsx`, one `PATCH` per change,
    the detail invalidated — PATCH answers `ProjectSummary`, a subset):
    the deadline (`DateField` of `evaluation/TimingStep.tsx`, now exported
    and taking a `description`; written on blur; `422 deadline_past` under
    the field, the stored value back; a reopen — `isReopen`,
    `reopenedRepos`: the project's `deadlineAppliedAt`, or a live
    repository applied and following the project's deadline — asks first
    through `useConfirm`; a manual draft by duration sends
    `durationMinutes: null` with the date), the deadline strategy
    (`Segmented`), the protected files (`ProtectedFiles.tsx`, `suggested`
    widened to `readonly string[]`: the source's `suggestedProtected` read
    from `GET …/sources/:repo` ∪ the files protected today). Each disabled
    where `editable` does not name it, every control while the project is
    archived. The facts set at creation (source, distribution, branches,
    history, publication, grace, score, scale) as a read-only `dl`. The
    full draft edit (start, grace, grading, scale, publication mode) is a
    follow-up.
  - **Repositories** (`project/ProjectRepos.tsx`): one `tr` per `rows`
    entry, `repo: null` "not accepted" (a seat not claimed said), a row
    without `enrollmentId` tagged "left the roster"; columns Student,
    Repository (link, provisioning / invitation state), Last commit (sha,
    relative time, live commit count), CI, Score (final points/max,
    `Grade`, source), Deadline (effective, "own deadline" tag), State (the
    lock — by staff —, the freeze, the flags of `repoFlags`: deleted,
    several GRADE annotations (red), protected files in conflict, to
    verify, modified after publication (amber), malformed score, locked
    by archiving / no protection ruleset (zinc)). A phone keeps Student,
    Score and State, the flags folded into "n flags" (`@2xl` container
    query). A deleted repository is a muted row. `liveStale` ⇒ "Refreshing
    GitHub's state…" on the heading. A row with a repository opens the
    sheet; 100 rows are a plain table.
  - **The sheet** (`project/RepoSheet.tsx`, read from the page's own
    data): invitation, last commit, CI (+ live checks), the five scores,
    the deadline and lock — own deadline `PUT …/repos/:rid/deadline`
    (set, or "Follow the project's" = null; `422 deadline_past` under the
    field), `POST …/repos/:rid/{lock,unlock}` — each answer laid over the
    row (`setQueryData`) then the page invalidated; `actionable` (not
    provisioned, deleted, or archived project ⇒ disabled, said why; `409
    repo_unavailable` toasted); the runs (`GET …/repos/:rid/runs`): kind,
    branch@sha, conclusion, points, tests, parse status and detail, the
    slot marks current / frozen / review, after the deadline, to verify.
  - **Checkpoints** (`project/ProjectCheckpoints.tsx`, graded `auto`
    only): list with status sent (with its time) / scheduled / **void**
    (`checkpointStatus` on `isVoidCheckpoint`); add in a `FormDialog`
    (name, days before the deadline → `offsetDays: -n`, or a date); delete
    after a confirmation (none offered once dispatched; `409
    checkpoint_dispatched` toasted); `422 due_past` / `due_after_deadline`
    and `409 duplicate_checkpoint` worded in the dialog.
  - **Refusals** worded by `refusalMessage(error, t)` (`projectPage.ts`,
    on `refusalKey` and `api.ts`'s new `refusalCodeOf`, which
    `refusedWith` now reads too): `not_draft`, `distribution_missing`,
    `deadline_past`, `strategy_frozen`, `publish_mode_frozen`,
    `repo_unavailable`, the four checkpoint codes; the rest show the
    server's message, else `error.save`.
  - **Shared pieces**: `project/parts.tsx` (`RepoLink`, `Points`, `Score`,
    `CiBadge`, `SCORE_SOURCE_KEY`), `project/RunHistory.tsx` (the sheet's
    run table, GitHub's `conclusion` worded through
    `project.run.conclusion.*`, an unknown one shown raw), `Fact` in
    `ui/page.tsx` (a `<dt>`/`<dd>` pair). One key per word: `project.review`
    (a run's kind, its slot, a score's source), `project.col.ci`,
    `project.frozen`, `project.flag.toVerify`, `project.flag.multiple`,
    `project.deadline`, `results.col.student`, `question.publish`.
  - **Form** (`ProjectAdvanced.tsx`): group mode hidden (`GROUPS_OFFERED
    = false`) until M3-16.
  - **Mock** (`mock/project.ts`, `?projects=1`): the three seeded projects
    now carry a page — the published one's rows walk every state
    (pending provisioning, invitation pending, CI fail, to verify +
    conflict, multiple, malformed, deleted, own deadline, staff lock,
    degraded, a review run, a student off the roster), the locked one is
    frozen, released with one score changed since (Release said) and on
    `score_is_grade` over scores out of 100 (the scale warning); every
    write above, the checkpoints (one void on the locked project), the
    first read of a project `liveStale: true`; `?unassigned=1` refuses
    Publish with three names. `addMockProject` takes the created
    `ProjectSummary`, fully `editable`. Checked by `contract.test.ts`
    (`ProjectDetail`, `GradeRunList`, `ReviewCheckpoint`). Scenes
    `project`, `project-sheet`, `project-draft`, `project-unassigned`,
    `project-locked` (`--width=390` for the phone).
  - **Tests**: `project/projectPage.test.ts` (rules),
    `project/ProjectPage.test.tsx` (states, primary action, publish 409,
    archive / delete, edits and reopen, flags, sheet, checkpoints,
    refetch, French), fixtures `test/project-fixtures.ts`; router tests
    updated (`project` and `projectNew` parse everywhere).
  - Not done here: see M3-12b and M3-12c; the final review state per
    repository (`review` field, M3-08b); the "students cannot accept yet"
    line of the empty repositories hint (`project.repos.noneAccepted`)
    goes with M3-13.

### M3-12b — Web: per-repository writes and the review state
- **Depends on**: M3-12a, M3-08b.
- **Goal**: in the row's sheet (`project/RepoSheet.tsx`): the teacher's
  score with its comment (`PATCH …/repos/:rid/score`, `ScoreOverride`;
  `409 not_frozen` and `grading_none` worded), the resend of a pending
  invitation (409 otherwise, 429 once a minute), the re-enable of the
  protection (clears "protected files in conflict"); the **final review**
  state per repository from M3-08b's `review` field (asked at / of sha,
  **not confirmed**, no review — degraded when archived as its lock or
  protection suspended) in the table's State column and the sheet.
  Replace `UnassignedBody` (`project/projectPage.ts`) by the contracts'
  `ProjectUnassigned`. Scene `project-grades` (the sheet with a teacher
  score).
- **From M3-12a**: the sheet reads its row from `projectKey(id)` and lays
  each repository answer over it (`settle` in `RepoSheet.tsx`); the
  refusals go through `refusalMessage`; the mock's `MockRepo` carries
  `teacher` and `protectionSuspended` already.
- **As delivered** (branch `merge/M3-12bc-project-writes`, ONE PR with
  M3-12c). What M3-13, M3-16, M5-03 and M3-07 inherit:
  - **The sheet** (`project/RepoSheet.tsx`): `settle` now takes a patch of
    the row (`(repo) => repo`), so every answer — a deadline state, the
    scores, an invitation status, a cleared flag — is laid over the row the
    same way, then the page invalidated.
    - **The teacher's score** (`project/TeacherScoreForm.tsx`: `ScoreSection`
      — the five slots, the review's state and the form —, `PATCH
      …/repos/:rid/score`, `ScoreOverride`): points, a maximum field shown
      only when the server says the score is held to none —
      **`scores.scoreMax`** on every row (review round 1: the API's
      `teacherRunMax`, `detail.ts`, ONE rule for the write of `grades.ts`
      and the page; the scored run's maximum, null for pass / fail only,
      malformed, several annotations, or a run to verify; tested in
      `grades.db.test.ts` and `detail.db.test.ts`) —, otherwise "out of N"
      as text and no `max` sent; a comment (sent trimmed, always, so it can
      be emptied); Save (`common.save`), the sheet's ONE primary; Clear
      (`{ points: null }`) once a score exists. `scoreOverrideBody` builds
      the raw object and keeps what `ScoreOverride.safeParse` accepts
      (invariant 7); locally it only knows "no points" and "own maximum
      required". The answer (`ProjectRepoScores`) patches `scores`,
      `released` and `flags.changedAfterRelease`. The form exists only when
      `teacherScoreBlock` is null: on a `none` project the line says it is
      not graded, before the definitive freeze that the score waits for
      it — so `409 not_frozen` / `grading_none` are met only by a stale
      page, and worded under the form with the three 422s (`FormError`
      with `refusalMessage`). The Teacher fact of the five slots shows the
      points with their maximum (`scores.teacher.max`).
    - **Resend** (`POST …/repos/:rid/invite`): a `secondary` `sm` button
      beside the Invitation fact, only while `invitationStatus` is
      `pending` and the repository is `actionable`; `invitationStatus` of
      the answer laid over the row (an `accepted` answer removes the
      button and says the student already has access); `429
      resend_too_soon`, `409 invitation_not_pending`, `502 invite_failed`
      and `409 github_account_stale` worded (toast).
    - **Re-enable** (`POST …/repos/:rid/protection`): a `secondary` `sm`
      button under the flags, only while `flags.protectionSuspended`, with
      a 13 px line beside it saying the restores resume at the next push
      and the runs marked to verify stay so; no confirmation (nothing is
      lost, nothing restored at once). The answer clears
      `flags.protectionSuspended` on the row (the table's "protected files
      in conflict" tag goes, "to verify" stays), the run list is
      invalidated, the toast repeats that past runs stay to verify.
    - **The final review** (`row.review`, `ProjectRepoReview`): ONE table,
      `reviewView` (`projectPage.ts`) → `{ key, tone, detail }` per status,
      read by the row's tag and the sheet's detail line alike — "review
      pending" / "review asked" / "no review" zinc, "review done" green,
      the degraded "no review" (archived as its lock, protection
      suspended) amber, **"review not confirmed" red**; `detail` is the
      line that says why or what next (asked on {date} of commit {sha};
      not confirmed: never sent again, set the score by hand; no frozen
      run; archived; protection suspended: re-enable it; not frozen yet),
      null for done and a plain none. The sheet draws it as a "Final
      review" fact inside the scores grid. The table's State column draws
      `reviewTag`: the same tag, except that a repository not frozen
      (trivially pending) and a `none` without reason (a project graded
      `none`: no row has a review) get no tag — decided here, to keep a
      row of an open project free of a tag that says nothing.
  - `UnassignedBody` is gone: `unassignedStudents` parses the contracts'
    `ProjectUnassigned` (`message` required, `enrollmentId` a uuid — the
    mock's `?unassigned=1` refusal mints uuids by rank, since its roster
    ids are not).
  - **Refusals** (`REFUSAL_KEY`, widened to the resend's
    `github_account_stale` of `PROJECT_ACCEPT_REFUSALS`): `not_frozen`,
    `grading_none`, `score_max_required`, `score_max_mismatch`,
    `score_above_max`, `invitation_not_pending`, `resend_too_soon`,
    `invite_failed`, `github_account_stale`; the release's `to_verify` is
    worded by `releaseRefusal` alone (M3-12c), with the names.
  - **Contracts** (own block, review round 1): `ProjectRepoView.scores.scoreMax`
    (above) and `ProjectReleaseRefusal` (M3-12c); `contract.test.ts` has a
    describe calling the four write routes of the mock and checking
    `ProjectRepoScores`, `ProjectReleaseResult`, `ProjectReleaseRefusal`,
    `ProjectInvitationResent` (and the 429) and `ProjectRepoProtection`.
  - **Mock** (`mock/project.ts`), over #498's repair (which gave the mock
    `review`, `teacher.max` and `unverified`, and the fixtures
    `final.toVerify`): `MockRepo.dispatch` (the ledger row, so a review can
    be asked or not confirmed) and `resentAt`; one `review` derivation,
    `reviewOf`, feeding `reviewState` of `@quiz/domain` with that ledger.
    The locked project's rows now walk the review states (done; `i === 2`
    not confirmed; archived degraded; the gone student's done) and the
    to-verify repository (`i === 4`, rather than `i === 3`: a restored
    head, its review asked but never filling the slot) carries the
    teacher's score that settles it (72 out of the teacher's own 100,
    `scoreMax` null), so the server's `scoresFinal` holds and Release is
    offered; without it the release is refused `to_verify` naming that
    repository. Repository ids are uuids (`repoId`), as
    `ProjectReleaseRefusal.repos` wants them (review round 2). The four
    routes: `PATCH …/score` (`teacherScoreMax` applied, the 409s and
    422s), `POST …/release` (counts in `not_frozen`, ids in `to_verify`,
    the snapshots), `POST …/protection`, `POST …/invite` (once a minute,
    `429` on a second click). Scene `project-grades` (the sheet of the
    teacher-scored repository); `contract.test.ts` checks `ProjectDetail`
    with `review`.
  - **Tests**: `projectPage.test.ts` (review words and tones, the table's
    tag rule, `scoredRunMax`, `teacherScoreBlock`, `scoreOverrideBody`,
    the refusal keys, `releaseRefusal`, `ProjectUnassigned` strictness),
    `ProjectPage.test.tsx` (the score with and without a scored run, the
    422s and 409s worded, the answer laid over the row, Clear, no form on
    `none`; resend, 429, accepted; re-enable clearing the tag; the review
    per status in table and sheet; French).
  - Not done here: a manual re-dispatch of an unconfirmed review (M3-08b
    left it open); the student's own resend (M3-09).

### M3-12c — Web: the release
- **Depends on**: M3-12a, M3-08b.
- **Goal**: `primaryAction: "release"` becomes the header's primary button
  (`POST …/release`; `409 not_frozen` / `grading_none` worded; a
  re-release rewrites the snapshot, said as such), the sentence
  `project.status.release` kept as its description; the "modified after
  publication" flag then offers the re-release. Scenes `project-release`
  and `-released`.
- **From M3-12a**: `ProjectPage.tsx` draws the button for `publish` only
  (`actions` of its `PageHeader`); add the `release` branch there, and the
  status sentence stays (`projectStatus`).
- **As delivered** (branch `merge/M3-12bc-project-writes`, ONE PR with
  M3-12b):
  - **The button** (`ProjectPage.tsx`): `primaryAction: "release"` draws
    the header's one primary, "Release scores" (`Send`), or "Release
    again" once `releasedAt` is set (the server names `release` again only
    when a final score moved after the release, `changedAfterRelease`).
    `useConfirm` first: the first release says the final score of each of
    the {n} live repositories becomes the student's and the gradebook's,
    and that a student's score is indicative until then; the release again
    says the snapshot is rewritten with today's final scores, the
    "modified after publication" marks go, nobody is notified again. Then
    `POST …/release`; on `ProjectReleaseResult` the page, the classroom's
    lists and the Activities are invalidated and a toast says "{scored} of
    {repos} repositories have one". Sync stays a sentence (M3-07).
  - **The sentence** (`projectStatus`): `project.status.release` kept for
    the first release; a new `project.status.rerelease`, dated at the
    release, once released and offered again — the previous sentence said
    "ready to be released" of a project already released.
  - **Refusals** (`releaseRefusal`, `projectPage.ts`), as a danger `Alert`
    under the header titled "The scores were not released", kept until a
    release succeeds, parsed with the contracts' **`ProjectReleaseRefusal`**
    (review round 1: a discriminated union beside `ProjectUnassigned` —
    `not_frozen` with `live` / `frozen`, `to_verify` with `repos: uuid[]`,
    the two bodies `grades.ts` throws; the mock's release route builds its
    refusals through it): "{frozen} of {live} live repositories are frozen
    for good"; the students named from the page's rows by the `repos` ids
    (a generic "some repositories" when none is on the page); `409
    grading_none` and anything else through `refusalMessage`. An alert
    rather than a toast because the to-verify names must stay readable
    while the teacher opens each sheet.
  - **Mock**: `POST …/release` above; `?unreleased=1` makes the locked
    project not released yet (Release its one action). Scenes
    `project-release` (the confirmation open) and `project-released` (the
    header after it); `project-locked` unchanged shows the release again.
  - **Tests** (`ProjectPage.test.tsx`): the button, the confirmation
    declined then accepted, the POST, the toast and the refetch; the
    release again and its wording; nothing offered once released with no
    change; the three refusals worded; French. `projectPage.test.ts`:
    `releaseRefusal`, the `rerelease` sentence.

### M3-13 — Web: student `ProjectRow`
- **Depends on**: M3-09a contracts, M2-07.
- **Goal**: the four-state onboarding of §5.3 on the student home and the
  classroom page, and the student's project page.
- **From M3-09a** (2026-10-04): the cards arrive in the `StudentActivityCard`
  union on both pages already; `student/cards.tsx` draws a project through
  `ActivityCard` as a plain `ActivityRow` (title, `sproj.status.*`, the
  deadline or the start, NO button) — replace that branch by `ProjectRow`.
  The card carries what the four states need: `githubLinked` (false ⇒ "Link
  my GitHub account"), `repoUrl` null ⇒ "Create my repository" (`POST
  /app/api/student/projects/:id/accept`, its refusals `ProjectRefusal`),
  `invitation: "pending"` ⇒ the link to accept on GitHub and the resend
  (`POST /app/api/student/projects/:id/invite`, `429 resend_too_soon`
  worded), `"accepted"` ⇒ "Open repository"; `status` the badge word;
  `startAt` in the future ⇒ no Accept yet. The page reads `GET
  /app/api/student/projects/:id` (`StudentProject`): the indicative score
  (`repo.score`, say "indicative"; `frozen` ⇒ "frozen at the deadline"),
  the evaluated commit and its run (`repo.run`), the release block once
  `release` is set (the final score, its grade, the teacher's comment).
  Mock: `?projects=1`, ids `STUDENT_PROJECT_OPEN`, `_SOON`, `_PAST` of
  `mock/student.ts`.
- **From M3-09b** (2026-10-04): every student notification of a project
  (`project_published`, `project_deadline_reminder`, `project_repo_invited`,
  `project_grade_final`) opens `/projects/:id` — the bell's `{ view:
  "project", id }` and the e-mail's link alike — so the route MUST serve a
  student the student's view (`GET /app/api/student/projects/:id`), with
  the invitation link and the resend on it: a student landing there from
  "Your repository is ready" expects the button, not the staff's 404.
- **Scenes**: `-unlinked`, `-accept`, `-invitation-pending`, `-ready`,
  `-released`; the default `student-home` unchanged.
- **Decisions** (orchestrator, 2026-10-04, from the spec and the
  precedents): one address, `/projects/:id`, dispatched by role as
  `/classrooms/:id` is (F-ORG-15, ADR-018); ONE action per row by state;
  a teacher in the student view and an impersonation see no action, one
  muted line; the ready repository is a secondary external link, never
  the accent; `"student"` added to the `projects` hint roots; M3-12a's
  "students cannot accept yet" hint dropped.
- **As delivered** (branch `merge/M3-13-student-project-row`, web only).
  What M3-09b, M3-09c, M3-15 and M5-03 inherit:
  - **The row** (`student/ProjectRow.tsx`, rules in `student/projectRow.ts`,
    pure and unit-tested): `projectActionKind(facts, now)` names the one
    action of a project — `link` (no GitHub account, open or not yet
    started: "Link GitHub", the account link flow of `github/api.ts` with
    `return` = the current page), `accept` (linked, published, start passed,
    deadline not passed, no repository: "Accept"), `notStarted` (linked,
    before the start: nothing), `invitation` (repository with a pending
    invitation: "Open the invitation" → `<repoUrl>/invitations`, a new
    tab), `open` ("Open repository", a secondary link, locked or not),
    `notAccepted` (locked or released without a repository), `deleted` (a
    card in progress that names no repository is one GitHub lost,
    `factsOfCard`; the page reads `repo.deleted`; nothing is made again).
    `ProjectFacts.repo` is a variant: live (url, invitation), deleted, or
    null. ONE wording per state (`STATE_KEY`, `sproj.state.*` and
    `sproj.invitation.pending`), on the row's line after status · deadline
    and in the page's repository card alike; `github_not_linked` is worded
    with the same key. Upcoming keeps no button (DESIGN.md, "Coming up").
    `ACCENT_KINDS` = link, accept, invitation: `primary` lights those only;
    `mostUrgent` (`StudentClassroom.tsx`) ranks a project by its deadline
    only while `needsStudentAction`, so a ready repository never takes the
    classroom page's accent (decided here: the invitation counts as a step
    to take, so it may wear the accent). **The title is the door to the
    project's page** (`RowLink` on `ActivityRow`: a real `/projects/:id`
    href, `navigate` on a plain click; `ActivityCard` and `UpcomingByDay`
    take `navigate`). `ActivityRow` moved to `student/ActivityRow.tsx`
    (re-exported by `cards.tsx`) with the two countdown lines every row
    shares, `leftLine` and `startsLine` (`timeLeftLine` and `upcomingLine`
    of `cards.tsx` are written on them); `RowAction` gained `href` +
    `external` for the links.
  - **The clock is the server's** (invariant 5): the home, the classroom's
    Activities and the project page read `useServerNow(serverNow)`
    (`realtime/useServerClock.ts`: the payload's `serverNow` sampled into
    `useServerClock`, `useNow(30_000) + clock.offset`) — the offset is
    state, so a sample that moves it re-renders at once; every
    countdown, the start gate of Accept, the "Evaluated commit" label and
    `mostUrgent` judge on it, never on the browser's clock alone.
  - **Accept** (`useProjectAction`): `POST /app/api/student/projects/:id/accept`;
    the button says "Creating your repository… (up to a minute)" while it
    waits; success toasts what to do next (by `invitationStatus`);
    `provision_in_progress` and `invitation_not_pending` re-read instead
    of resending (`REREAD_REFUSALS`, a `progress` toast);
    `github_account_stale` turns the button into "Relink GitHub"; every
    other refusal is worded (`studentRefusalMessage`, `sproj.refusal.*`:
    `app_not_installed`, `distribution_missing`, `repo_name_taken` all say
    "ask your teacher"; `provision_failed` says try again). The wording
    mechanism is ONE, `wordedRefusal(error, table, t)` in `api.ts`: the
    project page (`refusalMessage`) and the student's row each keep only
    their table. Every write settles by invalidating the `student` root
    (`studentRootKey`), so the home, the classroom page and the project
    page re-read.
  - **Read-only readers** (`useStudentReadOnly`): a teacher in the student
    view (`useStudentView`) or a session of kind `impersonation`
    (`useMe`) get no button and no Resend, the line `sproj.readOnly`.
  - **The page** (`student/StudentProjectPage.tsx`, `studentProjectKey(id)`
    under the `student` root): header with the classroom as parent (named
    once), the status badge, the course code and the deadline ("Due …",
    plus "· … left" only while time remains; the start while it is ahead),
    the one action (primary while a step is to take, secondary for a ready
    repository, none read-only); "My repository" (the name as a GitHub
    link, the invitation state with the student's Resend — `429
    resend_too_soon` worded, `invitation_not_pending` re-read,
    `repo_unavailable`, `invite_failed` —, the lock, the last commit — the
    EVALUATED commit once the deadline is applied or passed — with
    `project/parts.tsx`'s `CiBadge`, translated: GitHub's raw conclusion is
    never printed); "Score" before the release: the current score as
    "Indicative score" or the frozen one as "Score at the deadline", both
    with an "indicative until your teacher publishes" hint, the grade
    (`results.col.grade`) with an `indicative` hint, the run line ("See
    the run on GitHub", its time; the sha is in the commit line already);
    nothing at all under grading `none`; "No score yet" without a graded
    run; "Result" once released: final score, grade, "Published on", the
    teacher's comment (`feedback.comment`) in an outlined `NotePanel`.
    States: skeleton, 404 ("does not exist, or no seat", back to the
    activities), error with retry (`activities.kind.project` as its
    title). Phone: the action full width under the title — `PageHeader`
    now gives its actions row the whole width under `sm` whenever that row
    is ONE control with no help and no menu (desktop unchanged). 49 `sproj.*`
    keys, en + fr.
  - **Routing**: `project` is `studentSafe` with `bottomSlot: "courses"`
    (its `section` stays the teacher's Activities); `App.tsx` gives the
    staff `ProjectPage` and everyone else `StudentProjectPage`.
    `realtime/hints.ts`: `projects` → `classroom`, `project`, `student`.
  - **Renamed**: M3-12a's `project.repos.noneAccepted` (en/fr, "… The
    students' side of projects is not open yet") is `project.repos.none`,
    "No repository yet: a row fills once its student accepts the project."
    (`project/ProjectRepos.tsx`, one line).
  - **Mock** (`mock/student.ts`, `?projects=1`): seven cards, one per state
    (`STUDENT_PROJECT_OPEN|SOON|PAST|ACCEPT|INVITED|LOCKED|DELETED`;
    `STUDENT_PROJECT_IDS` is what `contract.test.ts` parses the view for),
    the repository's name derived from the title's head (`studentRepoName`);
    `?unlinked=1` unlinks the persona; the accept route provisions the card
    for the page's life (`?provisioning=1`: twenty seconds; `?refused=1`:
    `409 repo_name_taken`; `?stale=1`: `409 github_account_stale`, plain
    flags of `mock/runtime.ts`); the invite route keeps the minute.
    `contract.test.ts` also POSTs Accept (`ProjectAcceptance`, a refusal
    of `PROJECT_ACCEPT_REFUSALS`, `?refused=1` through `flags`) and the
    Resend (`ProjectInvitationResent`, then 429). Scenes
    `student-home-projects[-unlinked]`, `student-classroom-projects`,
    `student-view-classroom-projects`,
    `student-project[-accept|-unlinked|-invited|-deleted|-released|-provisioning|-relink]`.
  - **Tests**: `student/projectRow.test.ts` (the kind per state, the card's
    deleted inference, every refusal worded), `student/ProjectRow.test.tsx`
    (the title link, the action per state, the accent, read-only readers,
    the Accept flow: wait, re-read, relink, each refusal),
    `student/StudentProjectPage.test.tsx` (states, facts, indicative and
    frozen wording, the server's clock over the browser's, no raw
    conclusion, release block, Resend and its refusals, read-only,
    French), `hints.test.ts`, `router.test.ts`,
    `bottomNavSlots.test.ts`, `StudentClassroom.test.tsx` (`mostUrgent` with
    projects, the rows), `StudentHome.test.tsx`; the Grades page's project
    row (M3-01) renders unchanged with the merged contracts.
  - Not done here: the notifications (M3-09b: an entry about a project
    links to `/projects/:id`, which now serves the student), the F-PROJ-21
    notices (M3-09c), a group's repository (M3-15), clone commands.

### M3-14 — Pilot and load test
- **Depends on**: M3-01…13, M2-06.
- **Goal**: on staging with the staging App: walk classroom's user stories
  end to end; 100 repositories at a deadline applied in < 5 min; tick
  duration measured with 100 due projects.
- **Output**: a short report in the PR; findings as tasks.

### M3-15 — Groups (API)
Redesigned by [ADR-070](../adr/ADR-070-repartitions-de-groupes.md)
(product owner, 2026-10-04): classroom group sets, a project's copy that
follows its set until the deadline. Split in two PRs.

#### M3-15a — Group sets and a project's copy (database only)
- **Depends on**: M3-02.
- **Create**: `Q:modules/group/{routes,service}.ts`, `Q:db/group.ts`
  (`group_sets`, `student_groups`, `student_group_members`), the migration
  (also `projects.group_set_id`, `project_groups.source_group_id`, drop of
  `projects.group_max_size`), `packages/contracts/src/group.ts`, the pure
  rules in `@quiz/domain` (`formRandomGroups`: balanced sizes, `smaller` |
  `larger`; `groupSyncPlan`: the diff of a set and a copy, with the follow
  predicate of ADR-070 §4), the `group_set.*` and `group.*` audit actions.
- **Routes** (staff, `staffAccess`): sets (list, create, rename, duplicate,
  delete with `409 set_in_use`), groups (create, rename, delete), a
  member's move or removal, the random formation; read-only on an archived
  classroom (`409 classroom_archived`). A project's `groupSetId` in the
  draft's PATCH (`not_draft` once published); `409 no_group_set` at
  publication; the copy made, replaced, and kept in step in the set's
  transaction where no repository is touched (none exists before M3-15b).
- **Port from**: `C:modules/assignments/groups.ts` (names, slugs,
  positions, moves), its `groups.db.test` where the rules survive.
- **Tests**: the follow predicate and the random formation in the domain;
  the routes, the copy's step with the set, a stopped copy, staff seats
  never placed, the 404 of a classroom not reached.
- **As delivered** (branch `merge/M3-15a-group-sets`): migration
  `0064_group_sets` (`Q:db/group.ts`; `projects.group_set_id` set null,
  `projects.groups_stopped_at`, `project_groups.source_group_id` set null,
  `projects.group_max_size` dropped); `@quiz/domain` `groupSets.ts`
  (`groupSizes`, `formRandomGroups` on an injected `randomInt`,
  `copyFollows`, `groupSyncPlan`, the default names in the creator's
  language); contracts `group.ts` (`GROUP_REFUSALS`: `classroom_archived`,
  `set_in_use`, `duplicate_name`, `nobody_to_place`, `size_out_of_range`)
  and, in `project.ts`, `groupSetId` on create, patch and summary,
  `no_group_set`, `unknown_group_set`; hint kind `groups` (course topics
  only). `Q:modules/group/{routes,service,errors,events}.ts`, registered
  without the App; loaders `accessibleGroupSet` and `projectsClassroom`
  (`guards.ts`); every write of a set goes through `writeSet` (classroom
  FOR SHARE, set FOR UPDATE, the following projects FOR UPDATE in id
  order, the write, the copies stepped, the audit). The copy is the
  project module's (`Q:modules/project/groupCopy.ts`: `followingCopies`,
  `stepCopies`, `replaceGroupCopy`); a project's patch locks the set it
  names FOR SHARE before its own row. **The stop is stored**
  (orchestrator D1): `groups_stopped_at` written with the deadline applied
  (ticker) or the archive, never cleared, so neither a reopen nor an
  unarchive makes a copy follow again; the per-repository stop is M3-15b's.
  Every route answers the set (`GroupSetDetail`) but the set's deletion
  (204). The plan applies the deletions first, then the renames through a
  temporary name (a swap of two names), the new groups, the moves.
  The web form lost `groupMaxSize` (and its i18n
  keys); `GROUPS_OFFERED` stays false until M3-16.

#### M3-15b — Group repositories and their membership on GitHub
Split in two PRs (orchestrator, 2026-10-05). The product owner's decisions
of 2026-10-05 (P1: what "nothing to revoke" means; P2: the first deadline
stops a group) are ADR-070's amendment and F-PROJ-06/F-PROJ-17's wording.
- **From M3-03** (orchestrator, 2026-10-02): Accept answers `409 no_group`
  for any group project: this task replaces it by the group's repository,
  and covers the revocation on leaving the roster (F-PROJ-17) for the
  INDIVIDUAL repositories M3-03 makes too. (`revoke_failed` is a roster
  refusal, `has_repo` a group one: Accept answers neither.)

#### M3-15b-1 — Group repositories at Accept, the invited accounts, synchronous revocations
- **Depends on**: M3-15a, M3-03.
- **Port from**: `C:group-repos.ts` (`claimGroupRepo`, the name and its
  disambiguation, `inviteMembers`, `revokeMember`), `inviteOnGithubLink`,
  `group-repos.db.test` where its rules survive.
- **Goal**: Accept of a group project (the copy's group, `no_group`
  without one; the first member provisions, every linked member invited, a
  later one joins); every invited account recorded; a student linking
  GitHub invited; whose repository through the copy only (N-SEC-20); the
  synchronous revocation before a roster removal, an unclaim, an e-mail
  change, a self-enroll; `409 has_repo` for a set's write that would reach
  a group with a repository until M3-15b-2.
- **As delivered** (branch `merge/M3-15b1-group-repos`): migration
  `0067_project_repo_access` (`Q:db/project.ts`: one row per (repository,
  roster line, GitHub account), the login invited, `revoked_at`; the rows
  go with their line). Its backfill records the
  individual repositories M3-03 provisioned from the student's link of
  TODAY and their student seat: a student who had unlinked before the
  migration gets no row, and their removal is audited `not_invited` (no
  fallback by the collaborators GitHub lists: documented, not built).
  `Q:modules/project/groupRepos.ts`: `seatRepos` (one batched reader,
  `pickStudentRepo` over a seat's own repository and its copy group's — a
  heig-classroom live individual repository keeps its student), `seatRepo`
  its single case, `repoMembers` (a repository's readers: its student's
  seat, or its copy group's members, never the creator for having created
  it), read by the student view and cards, the staff page, Accept, the
  hints, the resend and the invitation on link. `Q:modules/project/
  accept.ts`: a group project's Accept — the copy group or `409 no_group`,
  re-read under the project's row FOR SHARE when the group's row is
  inserted (a set's write steps the copy under FOR UPDATE: R3); a
  provisioned row is joined (the member invited, the answer THEIR
  invitation); otherwise the claim (two Accepts make one row,
  `provision_in_progress`), the name `<project slug>-<group slug>` (the
  group's id appended when another tracked row bears it), the allow-list
  of M3-03 unchanged (`repo_name_taken`), then every other member with a
  link invited, best effort, read after the provisioning; a student's own
  repository whose access a roster change revoked is joined again.
  `Q:modules/project/access.ts`: `recordGrant` (written BEFORE GitHub is
  asked, the line FOR SHARE and still claimed by the account's user as a
  student seat — otherwise nobody is invited), `releaseLine` (the other
  side of that lock: the line FOR UPDATE, `RevokeFailed` while an account
  recorded since the revocation is live),
  `inviteAccount` (the one invitation: today's login, the grant, the
  `push` invitation, the grant taken back on a refusal, and the invitation
  taken back when the grant was revoked while GitHub was asked; audited
  `project_group.repo_invite`), `inviteOnGithubLink` (after a link, best
  effort), `revokeEnrollmentAccess` (installation clients first — an
  installation GitHub no longer knows, 404/403 on its token, is
  `app_not_installed`; a first provisioning under way (its claim fresh) is
  `RevokeFailed`, retried once it is done; a failed one's, or one whose
  claim went stale, found by its id; each recorded account marked revoked
  BEFORE GitHub is asked (live again if GitHub refuses), so that an
  invitation's re-check either finds it live — its invitation landed
  before the revocation listed them, and is cancelled — or takes itself
  back; then each by its immutable id's login of today, its
  pending invitation (`pendingInvitees`) cancelled BEFORE its seat; a
  repository left with no live account has `invitation_status` `none`;
  the P1 skips `app_not_installed`, `repo_deleted`, `not_provisioned`,
  `account_gone`, then `not_invited` (the repositories the line reads by
  `seatRepos` with no account of it recorded) once every account is out,
  each audited `project_group.repo_revoke`). ONE guard for the four roster
  writes that take a line or its account away, `afterRevocation` in the
  `org` service: `removeEnrollment`, `unclaimEnrollment`,
  `updateEnrollment` (every e-mail change, after `duplicate_email` is
  ruled out: the line may have been claimed since it was loaded) and
  `selfEnroll` (a student line turned staff seat, after
  `already_enrolled` is ruled out) revoke first, then write in a
  transaction behind `releaseLine`; `RevokeFailed` is worded `502
  revoke_failed`, every refusal through `rosterRefusal`
  (`Q:modules/org/errors.ts`, `ROSTER_REFUSALS` in contracts `org.ts`).
  An invitation whose grant was revoked while GitHub was asked is taken
  back; if that fails, the grant is live again for the next revocation and
  an error is logged. The resend: an individual
  repository's student seat (none: `409 repo_unavailable`); a group's
  members still out (an invitation pending on GitHub, or no account
  recorded); a student's own, them alone; audited `{ logins,
  invitationStatus }`. `Q:modules/project/groupCopy.ts` with
  `planReachesRepoGroup` (`@quiz/domain`): a copy group with a repository
  row — from the first Accept's claim on, unless it failed before GitHub
  made the repository — has its slug fixed and a step
  that would delete it, or take a member out of it or bring one in, is
  refused for EVERY project concerned, `409 has_repo` with
  `GroupRefusalProjects` (also `set_in_use`'s details); a staff seat
  leaving it is no GitHub change. `acceptRefusal` (`@quiz/domain`) no
  longer says `no_group`; `revokeCollaborator` cancels invitations first.
  Web: `revoke_failed` and `already_enrolled` worded
  (`error.githubRevokeFailed`, `error.alreadyEnrolled`); `no_group` has no
  Accept screen yet (M3-13); `has_repo` is M3-16's to word.
  **For M3-16b**: a group repository no roster student reads any more is
  listed under its creator's account (`enrollmentId` null), and
  `counts.accepted` counts repositories, hence groups, in group mode.
  Known gaps: the reservation of a name while a provisioning is in flight
  (heig-classroom wrote it on the row) is not ported — two classrooms
  provisioning the same name at the same second answer the second
  `repo_name_taken` until the first is done; the M8-01 import must
  check heig-classroom's individual repositories inside group assignments
  (lot-1 leftovers) against `isLiveIndividualRepo`.
- **Tests**: `groupRepos.db.test.ts` (32): the first Accept and its
  invitations and grants, a later member, two at once, `no_group`, the
  name disambiguated, an invitation on link; the creator moved out (no
  row, no student view or card, no hint, no resend); the staff's resend
  of the members still out, a member's own; `has_repo` (out, in,
  deletion; nothing written) and a rename (slug fixed, kept from another
  group); a removal (the invitation cancelled before the seat),
  `502 revoke_failed` (roster, set, copy, unclaim and e-mail change
  unchanged), the P1 skips (a token refused too), a relinked account, an
  unclaim and an e-mail change, a self-enroll, an individual repository
  (its state cleared), a resend with no student (`repo_unavailable`); the
  races interleaved through the fake GitHub (a line removed before or
  while it is invited; an account recorded during a removal, an unclaim, a
  self-enroll; a removal and a set's move during the first provisioning, a
  stale one; an invitation landing between a revocation's listing and its
  seat's removal; a move out during an Accept), a classroom deleted with its grants, the backfill statement on an M3-03 row. Domain:
  `planReachesRepoGroup`.

#### M3-15b-2 — The follow on GitHub: `group.sync`, the per-group stop, confirmations
Split in two PRs (orchestrator, 2026-10-05); the product owner's PO1–PO2
are ADR-070's second amendment of 2026-10-05.

#### M3-15b-2a — Per-group stop, the `group.sync` job, `needs_confirmation`, *access to revoke*
- **Depends on**: M3-15b-1.
- **Goal**: the per-group stop (the first of the project's deadline and the
  repository's own); the `group.sync` job (one lease per project, the
  stops re-read in its transaction; a departure waits for GitHub, an
  arrival is invited) replacing M3-15b-1's `409 has_repo` for a member's
  move; `409 needs_confirmation` with the consequences and their digest;
  the *access to revoke* flag.
- **As delivered** (branch `merge/M3-15b2a-group-sync`): migration
  `0069_group_sync` (`projects.group_sync_due_at`, `group_sync_job_at`,
  `group_sync_failures`, a partial index on the due mark;
  `project_groups.stopped_at`, backfilled from the first of
  `groups_stopped_at`, the repository's `deadline_applied_at` and the
  audit log's first `project_repo.deadline_applied` (a reopened repository
  keeps its group stopped); `project_repo_access.revoking_at`;
  `project_group_members.departing_at`). `@quiz/domain`: `groupSyncPlan` per group (a
  stopped group is never deleted, renamed nor moved, its name and slug
  reserved; a move with one stopped end is held), `splitPlan` (what the
  set's transaction applies, what waits for the job, the consequences
  `lose`/`join`, the groups with a repository a plan would delete) and
  `consequenceDelta`; `planReachesRepoGroup` removed. **A grant is
  revoked only once GitHub confirmed it** (review, orchestrator):
  `revoking_at` is set before GitHub is asked, `revoked_at` after its
  answer (only while still marked), a refusal clears the mark; every
  revocation (the roster's and the job's) takes the grants not revoked,
  marked ones included (a crash's are asked again); `releaseLine` and
  `completeDeparture` share `assertNoLiveGrant` (`revoked_at` null), so a
  roster write during the job's GitHub call is `502 revoke_failed`; an
  invitation's re-check takes itself back when its grant is revoking or
  revoked, and a failed take-back on a group repository leaves the grant
  live and the project due. A *stray grant* (`STRAY_GRANT`, one SQL
  predicate: not revoked, on a group repository whose line is not a
  non-departing member of its group) is the job's work and the page's
  `accessToRevoke` (a pending departure, a refused revocation, a failed
  take-back alike). `Q:modules/project/
  groupCopy.ts`: `copiesBefore` (read under the set's lock before the
  write) and `stepCopies` (the delta of consequences, its SHA-256 digest
  over the sorted (project, group, line, kind), `ConfirmationNeeded`
  unless `confirm` is it; the rest applied, the departures marked
  `departing_at`, the project due), `stopProjects` (`groups_stopped_at`
  and every group: tick step 2, the archive), `stopGroups` (tick step 3
  for a group whose repository's deadline is applied — the projects
  concerned locked FOR UPDATE first, in id order, with those whose own
  deadline is due; a stop drops the group's pending departures), and
  the job's steps under its locks (set FOR SHARE, project FOR
  UPDATE, the member row FOR UPDATE): `syncSteps` (departures, arrivals,
  stray grants), `beginDeparture` (only while the student departs from a
  group not stopped, the grants marked in the same transaction; otherwise
  held, nothing touched), `completeDeparture` (refused while an account of
  the line there is not revoked; then decided from the plan, the group
  left counted as following: in step — kept and invited again; a place
  into a following group — moved; else left, e.g. the project stopped
  after the revocation), `completeArrival` (from the plan),
  `beginStrayRevocation`, `settleSync` (the due mark cleared, kept, or
  moved later: `FAILED_RETRY_MS` doubling up to an hour).
  `Q:modules/project/groupSync.ts`: `runGroupSyncJob` (its own frame on
  `heldLease`, since it must run without the App: P1), `requestGroupSync`
  (sent after a member's place commits), ticker step 7, queue `group.sync`
  (`jobs.ts`); without a queue nothing sends it and the moves wait.
  `access.ts`: `recordGrant` (given the `RepoRow`) also locks the line's
  member row FOR SHARE and answers `gone` for a non-member, `departing` for
  a departing one (Accept answers `409 provision_in_progress`, the link and
  the resends skip them); `revokeDeparture` (one repository, the grants the
  job marked, `via: "group.sync"`, `not_invited` when none was ever
  recorded, whatever the provisioning — the roster's `not_invited` too);
  `revocationClient`; a refusal is logged and retried with the backoff. `repoMembers` leaves out departing members.
  Contracts: `confirm?` on `GroupMemberPut`, `GroupConsequence(s)`,
  `needs_confirmation` in `GROUP_REFUSALS`, `accessToRevoke` on
  `ProjectRepoView`; the web words `needs_confirmation` with a placeholder until M3-16b's dialog.
  Audit: the set's writes name `payload.deferred`; `repo_revoke` and
  `repo_invite` take `via: "group.sync"`. `has_repo` stays for deleting a
  set group a following copy holds with a repository. Hints after a pass:
  the course's staff and the moved students' `user:` topics.
- **Tests**: `groupSync.db.test.ts` (20): the consequences and their
  digest, a wrong and a stale digest, writes that add none (unrelated, a
  move back); a move between two following groups (revocation before
  invitation, audits), an arrival, the P1 skips, a refused revocation
  (flag, backoff, retry), two projects on one set, a crashed lease taken
  over, a roster removal while a move waits; Accept, link and resends of a
  departing student refused; the stop between the revocation and the copy
  write, the student put back meanwhile, an account recorded since the
  revocation; a roster removal during the job's refused revocation (502),
  a crash after the mark asked again, a stray access flagged and retried;
  a repository's earlier deadline stopping its group for good, a
  departure whose group stopped before its revocation began (held,
  nothing revoked), the backfill (the audit log's first application). `groupRepos.db.test.ts`: `needs_confirmation` replaces
  `has_repo` for moves; a confirmed move during the first provisioning is
  never invited. Domain: the stopped group, `splitPlan`,
  `consequenceDelta`. The shared world is `Q:modules/project/
  groupTesting.ts`.
- **For M3-16b**: word `needs_confirmation` (its `GroupConsequences`) in
  the set's page and `accessToRevoke` on the project page's row (also
  true while a confirmed departure waits for the job: its access is not
  revoked yet); `GroupSetUse.follows` is the project's stop only — a group
  of a following copy may have stopped on its repository's deadline.

#### M3-15b-2b — *Resync with the set* and the drift
- **Depends on**: M3-15b-2a.
- **Goal**: the drift of a stopped copy (the project page), *Resync with
  the set* through the same confirmation (PO1: allowed after the deadline,
  naming every frozen repository it touches; `409 released` once the
  project is released), as a durable intent the job applies.
- **Tests**: a resync after the deadline, refused after the release, its
  confirmation naming the frozen repositories.

### M3-16 — Groups (web)
Split in two PRs (orchestrator, 2026-10-05): what the API of M3-15a
serves now (16a), and what waits for the group repositories (16b).

#### M3-16a — The Groups tab, a set's page, the project's set
- **Depends on**: M3-15a, M3-12.
- **Goal**: the classroom's *Groups* tab (fr *Groupes*) listing its sets;
  a set's page: the students in no group and the groups, drag and drop
  with a keyboard equivalent, *Undo* for a move (none reaches GitHub
  before M3-15b), the random formation (size, smaller / larger); the
  project form's group work with the classroom's sets
  and *Create new groups*; a draft's set chosen on its page, the set a
  group project follows shown there. Read `apps/web/DESIGN.md` and the
  `quiz-ui` skill first.
- **From M3-15a**: the form and the project page word the refusals
  `no_group_set` (publish) and `unknown_group_set` (create, PATCH) through
  `t()`, in `en.ts` and `fr.ts`, like the others of `PROJECT_REFUSALS`;
  the hint kind `groups` names its query roots in `realtime/hints.ts`.
- **Decided for it** (orchestrator, 2026-10-05): (1) the Groups tab and
  the set's page ship to production; the form's group mode was to wait
  for M3-15b-1 (Accept answered `409 no_group`), which merged first: it is
  offered in every build, a membership change reaching a group repository
  answering `409 has_repo` until M3-15b-2 (orchestrator, 2026-10-05); (2) the routes are `/classrooms/:id/groups` (a
  route tab) and `/classrooms/:id/groups/:setId`, staff only, and
  `/projects/:id/groups` goes; (3) one primary on the set's page, *Form at
  random*, none once everyone is placed; (4) `@dnd-kit` after the
  categorize board's pattern, copied, never imported; a "Move to…" menu per
  student; (5) Undo for moves only, the latest only, through the toast;
  (6) one write at a time per set, the cache from the latest answer.
- **As delivered** (branch `merge/M3-16a-groups-web`). What M3-16b and
  M3-17 inherit:
  - **Routes** (`router.ts`): `classroomGroups` and `groupSet` (its
    `fromProject`, in the query only; `groupSetPageOf` in
    `project/projectPage.ts` builds it), neither `preview` nor
    `studentSafe`; `projectGroups` and `soon.projectGroups` are gone.
    `ClassroomView`'s `ROUTE_TABS` has `groups` (after the Roster), whose
    header primary is *New group set* (straight to the new set's page).
  - **`apps/web/src/group/`**: `api.ts` (`useClassroomGroupSets`,
    `useGroupSet`, `useCreateGroupSet`, `setWrite` — each write's body
    built by its route's schema —, `useGroupSetWrites` — the queue: one
    request at a time per set, an optimistic step drawn at once, the cache
    set from the latest answer once the queue is empty, rolled back to the
    last answer and read again when it ends on an error); `groupRules.ts` (pure:
    `placeOf`, `withMove`, `sizesSummary` on `groupSizes`, the refusals'
    words — a 404 "no longer in the set", never the server's English —,
    `projectsRefusal`: `set_in_use` and `has_repo` with their projects
    (`GroupRefusalProjects`), said above the board as links, `stepZone`); `GroupSetList`,
    `GroupSetPage` (name renamed in place, *New group*, menu: maximum
    size, duplicate, delete), `GroupBoard` (pointer and keyboard drag,
    the keyboard walking the zones in reading order; click
    then click with "Move here" buttons; a "Move to…" menu; a group renamed
    in place, `duplicate_name` under its field), `RandomFormDialog`,
    `GroupSetPicker`, `parts.tsx`; `AppLink.tsx` (a route as a real link)
    beside the router. An archived classroom's set is drawn read-only.
  - **Primitives**: the toast takes one action and a `key` (Undo, the
    latest move only); `Menu`'s panel scrolls inside the viewport;
    `EditableTitle`'s button no longer wraps its pencil in a box sized to
    its content.
  - **Keys and hints**: `groupSetsKey` (`groupSetListsKey`,
    `classroomGroupSetsKey`, `groupSetKey`), named by the hints `groups`,
    `roster`, `projects` and `classrooms` (an archive turns an open set
    read-only).
  - **Projects**: the form's group mode in every build (no gate left); the
    draft's `groupSetId`, sent in group mode only; `unknown_group_set`
    under the picker, the choice cleared. `ProjectGroupSet` on the page:
    a draft's picker (`PATCH groupSetId`, its refusal under it), the set's
    link with `?fromProject=<id>`, *follows* / *stopped following* once published;
    `no_group_set` an alert pointing at the picker; `unassigned_students`
    links to the set.
  - **Mock** (`mock/groups.ts`, `?groups=1`): three sets on PRG1-2026
    (pairs, named by a draft group project; "Projet final" with a group
    above its maximum and eight students in no group; an empty one), one
    on the archived PRG1-2024; the draft project in group mode without a
    set. Checked by `contract.test.ts`; scenes `classroom-groups*`,
    `group-set*`, `project-new-groups`, `project-group*`.

#### M3-16b — Rows per group, drift, Resync, confirmations
- **Depends on**: M3-15b-2, M3-16a.
- **Goal**: the project page's one row per group (its repository, its
  members); the drift of a stopped copy and *Resync with the set*; the
  `409 needs_confirmation` dialog of a membership write that reaches
  GitHub (ADR-070 §6), naming the consequences and sending the digest
  back, through the set's write queue; the *access to revoke* flag on a
  repository's row; `409 has_repo` (M3-16a's alert) giving way to the
  confirmation.

### M3-17 — Groups formed by the students (ADR-070 lot 2)
- **Depends on**: M3-15a, M3-16, M3-09.
- **Goal**: F-PROJ-22: a set opened to the students until a date, with a
  binding maximum size; the student routes (create and name, join, leave,
  rename) on `readableClassroom`'s student branch, refused in
  impersonation, `seb` and `kiosk` sessions; the module's student view
  (N-SEC-20) and its tests; the student's screen.
- **Decided for it** (product owner, 2026-10-05, ADR-070's third
  amendment): S1 a student *Groups* tab at `/classrooms/:id/groups`, drawn
  while `hasGroups`; S2 the sets a student sees: open, or named by a
  published project that is not archived; S3 a row "Form your group until
  …" in Open now (classroom page and home), never the accent, no
  notification; S4 the students in no group, by name, while open.
- **As delivered** (branch `merge/M3-17-student-groups`). Contracts
  (`group.ts`): `GroupSetPatch.openUntil`; `openUntil` and `open` on
  `GroupSetSummary` and `GroupSetDetail.set`; `GroupMemberName`,
  `StudentGroupSet(s)`, `StudentGroupCreate`, `StudentGroupJoin`,
  `StudentGroupSetCard`; refusals `max_size_required` (422), `set_closed`,
  `set_frozen`, `group_full` (409); `student.ts`: `StudentActivities.groupSets`
  and `StudentClassroomPage.hasGroups`. No migration (`open_until` since
  0064). `guards.ts`: `openSet`, `studentVisibleSet` (S2, one SQL rule),
  `publishedProject` (also read by `findStudentProject` and
  `findStudentProjectView`; the other sites keep their own conditions),
  `selfFormingSeat` (the one rule of who forms groups: own portal session,
  claimed STUDENT seat), `findStudentGroupSet`/`studentGroupSet` (the
  writes' loader; anyone else the 404). `project/groupCopy.ts`: `setFrozen`
  (an `EXISTS` of the copy's `HAS_REPO` over every project naming the set,
  stopped and archived ones included). `modules/group/service.ts`: `patchGroupSet` opens/closes
  (`max_size_required` when open after the write), a duplicate born
  closed; `writeSet` hints `groups` to the claimed students' `user:` topics
  when the set reaches them before or after the write (never
  `classroom:`); one read, `setRows` (`readOnly`, `open` = `openSet`,
  `frozen` = `setFrozen`, as columns), behind the staff's list and detail,
  the student view and `anyVisibleSet`; the staff's and the students'
  writes share `insertGroup`, `renameIn`, `placeIn` (its `capacity` for
  the students); the students' writes through `studentWrite` — open (no
  grace) and not frozen, re-read through `setRows` under the set's lock
  before the write and any step, `group_full` at the maximum or above, one audit per write
  (`group.create|rename|member_move`, `self: true`, the line) — and the
  student view `studentGroupSets` (`{ serverNow, sets }`, fields picked by
  hand, three reads whatever the number of sets; closed: own group only,
  no `unplaced`), `studentGroupSetCards` (open and not frozen, a claimed
  STUDENT seat's only: a teacher in the student view gets no row),
  `hasStudentGroupSets` (read by `activity/service.ts`). Routes: `GET
  /app/api/classrooms/:id/group-sets/student` (`readableClassroom`, the
  student payload forced; `writable` only for the caller's own portal
  session on a student seat), `POST /app/api/group-sets/:id/student/groups`,
  `PUT|DELETE …/student/membership`, `PATCH …/student/groups/:gid`, each
  answering the classroom's list as the writer reads it.
  Web: `group/StudentGroups.tsx` (the tab: one primary "Create a group" for
  the first set the reader may write while in no group of it, Join on a
  group not full, Rename and Leave on their own, drawn first; closed: own
  group or "your teachers will place you"; re-read when `openUntil`
  passes, by `serverNow`), its hooks in `group/api.ts`
  (`studentGroupSetsKey` under the student's classroom), `GroupSetRow` in
  `student/cards.tsx` on the home and the classroom page, the tab in
  `StudentClassroom` (`classroomGroups` now `studentSafe`, slot Courses,
  role-dispatched in `App.tsx`); the staff's set page opens the set from
  its menu (`OpenDialog`: date, maximum, the risk said) and says until when
  with *Close to students*; the list badges an open set; hint `groups`
  also names the `student` root. Mock: "Projet final" open three days, the
  student persona in no group of it, the four writes, the row and the tab
  (`?groups=1`); scenes `student-groups*`, `student-home-groups`,
  `student-classroom-groups-row`, `student-view-groups`,
  `group-set-open-dialog`.
- **Tests**: `group/studentGroups.db.test.ts` (12, on a server with the
  development login, and one without for an impersonation's `403
  impersonation_read_only`): opening and closing (`max_size_required`, a past
  date, a duplicate closed, `classroom_archived`, audited); create (default
  name in the student's language), join, `group_full`, leave, rename (own
  only, `duplicate_name`), audited `self`; two joins racing for the last
  seat; a draft's copy stepped by a student's create; `set_closed` (no
  grace) and the 404 of an invisible closed set; `set_frozen` with a
  repository in a following and in a stopped, archived copy (and no
  Activities row then); an archived
  classroom; an impersonation (development), a teacher in the student
  view, a staff seat, a stranger, a token (404), `seb` and `kiosk` (401);
  the leak search over every student-side body (a second classroom's set, a
  closed unused set, another group's members after closing, e-mails, a
  GitHub login, roster line ids, `claimed`, `usedBy`) for the student, an
  impersonation and a teacher in the student view; hints to `user:` never
  `classroom:`; the Activities row and `hasGroups`, none to a confined
  home. `accessSweep` lists the student read. Web: `StudentGroups.test.tsx`
  (13), `StudentClassroom.test.tsx` (the tab and the row, never the
  accent), `GroupSetPage.test.tsx` (the opening dialog, the banner's
  close), the router and bottom-bar tests, the mock contract check.
- **Known gaps / for later**: the race for a group's last seat is tested on
  PGlite, a single connection that serialises transactions anyway; the
  set's FOR UPDATE is what holds it on PostgreSQL (review, 2026-10-05); a closed set used by a published project has
  no mock scene (the component test draws it); archiving a classroom does
  not clear `open_until` — an archived classroom's set is never open by
  rule (`openSet`), and stays closed if it is unarchived after its date.

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
- **From M2-04**: the journal's plugin registers
  `onEvent("push", handler)` (and `onEvent("repository", …)` for a rename or
  a deletion) from `modules/github/service.ts`; `github` never imports
  `journal`. The handler receives `(app, config, delivery)` with the stored
  payload, finds the journals of `repository.id` whose `after` is not
  `last_commit_sha`, and sends `journal.ingest` (the queue whose policy J2
  settles); it must be idempotent, since a delivery is retried and
  replayed. It registers no `onReceipt`: a journal needs no push receipt.
  The J4 `visible_from` sweep is not a scheduled task: spec 05 §5.11 and D10
  make it a clock-bound `TickTask` of the ticker (`everyMs` 60 s), since a
  page's visibility is a date and must not depend on an admin setting.
- **Tests**: port `ingest.db.test`, `journal.db.test`; a student cannot
  fetch an asset referenced only by a draft page; two concurrent ingests
  converge; an SVG asset carries the sandbox (or attachment) header.
- **As delivered** (#414): `Q:modules/journal/{routes,service,studentView,ingest,repo,events,jobs}.ts`
  (+ `testing.ts`, the fake repository), registered in `app.ts` only when
  `githubApp(config)` is non-null. What M4-03, M4-05 and M8-01 inherit:
  - Routes (`studentRoute`, `IdParam`/`JournalPageParams`/`JournalAssetParams`,
    `JournalViewQuery` validated first: `?view=staff` is a 400):
    `GET /app/api/classrooms/:id/journal` (`Journal`), `GET …/pages/*`
    (`JournalPage`), `GET` on `JOURNAL_ASSETS_PATH(":id") + "/*"`; all
    through `readableClassroom` with `studentView` from the query; portal
    sessions only (no `sessions` declared). The student payloads come from
    `studentView.ts` alone (`visibleToStudents()`, the one predicate, DB
    `now()`; each payload parsed by the strict contract schema); a
    classroom without a journal is a 404 for the student payload and a
    staff payload with `repository: null` and `proposedName`
    (`journalRepoName(room.name)`) for the staff.
  - Assets: ETag = `"<blob sha>"` (304 on `If-None-Match`), N-SEC-13's
    headers, an SVG's CSP gets `; sandbox`. J1: a student's asset needs a
    page `visibleToStudents()` whose `asset_paths` holds it.
  - Ingestion (`ingestJournal(app, config, classroomId)` → `{status: "ok",
    commitSha, pages, assets} | {status: "error", code} | {status:
    "superseded"} | null`), J2 without a lock during GitHub reads (04 §4.3,
    "As ported"): snapshot of `classroom_journals.version`, GitHub read and
    pages rendered outside any transaction (every call bounded: no retry,
    `noRateLimitWait`, 30 s, the token fetch raced against the same
    deadline), then one short transaction, `SELECT … FOR UPDATE` and a
    write only if `version` is unchanged (`+ 1`); a failure is its own
    compare-and-set, the pages kept. Lost twice: the job is re-sent
    (`superseded`). Every writer of the row bumps `version`. A page or an
    asset over 5 MB is not copied. The repository is resolved by id (`GET /repositories/{id}`, a
    missed rename is followed); 409 = empty repository (copy emptied, ok);
    404/422 on the branch = `ref_not_found`; no file under `root_path` =
    `root_not_found`; truncated tree = `too_large`; 403/401 or no active
    installation = `forbidden`; 5xx, network, rate limit =
    `github_unavailable` (the only code the worker retries). Pages are
    rendered from `cleanSource(md)`, `html_staff` first, then
    `html_student` of every page by `renderStudentPages` (the visible set
    read by `visibleToStudents()`), which stamps the new column
    `classroom_journals.student_rendered_at` (migration `0049`, which
    also adds `version`).
  - `requestIngest(app, config, classroomId)` (service) sends
    `journal.ingest` (`standard`, no dedupe, 3 retries), or ingests inline
    without a queue: **M4-03's Refresh and its re-ingestion after a save
    call it** (the Refresh route is M4-03's, per its card).
  - Webhooks (`jobs.ts`, `onEvent`): `push` on `refs/heads/<ref>` →
    `requestIngest` for every row of `github_repo_id` on that branch whose
    `last_commit_sha` differs from `after` (a deleted branch is ingested
    and ends `ref_not_found`); `repository` `renamed` → `full_name`,
    `deleted` → `error`/`repo_not_found`, one statement bumping `version`.
  - J4: `TickTask` `journal.visible_from` (60 s) → `sweepVisibleFrom`:
    the classrooms with a non-draft page whose `visible_from` is past and
    later than `student_rendered_at` get `html_student` re-rendered (no
    GitHub call) and the hint, under the row's `FOR UPDATE SKIP LOCKED` (a
    journal being written is skipped).
  - Assets: `INERT_IMAGE_HEADERS` of the pool plus the cache line, with
    N-SEC-13's CSP (not `sandbox` for every asset: a PDF viewer does not
    run in a sandboxed document); an SVG adds `; sandbox`.
  - `githubStatus(err)` (`github/app.ts`) is the one reader of a GitHub
    error's status.
  - SSE: hint kind `journal` (contracts `HintEvent`, `events.ts`, the web's
    `HINT_ROOTS` → `["journal"]`) on `classroom:<id>`.
  - `hasJournal(db, classroomId)` moved to `modules/journal/service.ts`;
    `activity` calls it. `github`'s D28 check still reads
    `classroom_journals` by join (`github` never imports `journal`).
  - Audit: none. The nine `journal.*` actions of §4.1 are all staff writes
    (M4-03); a synchronisation's outcome is the row's sync state.

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
- **From M4-02 (J2)**: every staff write — save, add, delete, upload,
  choose or remove a repository — bumps `classroom_journals.version`, as the
  ingestion does, so an ingestion that read GitHub before it never commits
  over it (`modules/journal/ingest.ts`).
- **As delivered** (#415): `Q:modules/journal/writes.ts` (the service),
  the routes in `routes.ts` (`registerWrites`), the GitHub writes in
  `repo.ts`, the fake's write routes in `testing.ts` (`writeRoute`,
  `fakeWorld`). What M4-05, M4-06 and M8-01 inherit:
  - Routes, base `/app/api/classrooms/:id/journal`, staff only through
    `accessibleClassroom` (404 otherwise; impersonation 403, `seb`/`kiosk`
    nobody): `POST base` (`JournalCreate`, 201 staff `Journal`), `POST
    base/use` (`JournalUse`, 201), `DELETE base` (204, idempotent), `POST
    base/refresh` (202, no body: the outcome is the row's `syncStatus`
    after the `journal` hint), `POST base/preview`
    (`JournalPreview` → `JournalPreviewResult`, `readOnly`), `PUT
    base/pages/*` (`JournalPageSave` → `JournalFileWritten`), `POST
    base/pages` (`JournalPageAdd`, 201 `JournalFileWritten`), `DELETE
    base/pages/*` (204), `POST base/assets/*` (raw body ≤ 5 MB in a child
    context of its own, Fastify's 413 over it; `JournalUploadHeaders` and
    `assetContentType`, now in `@quiz/contracts`; 201 `JournalFileWritten`
    with `page: null`).
  - Paths: `safeJournalPath` refuses every segment starting with `.` (so
    `.github/workflows`, `.gitignore`): no write touches repository
    furniture, and the ingestion copies none of it (pages included).
  - Refusals: `JournalErrorCode` (the sync codes plus `not_connected`,
    `journal_exists`, `no_journal`, `name_taken`, `conflict`,
    `page_exists`, `type_mismatch`, `empty_upload`), body
    `{error, message}` with `message` the code; 409 for the state of
    things, 415 `type_mismatch`, 400 `empty_upload`, 503
    `github_unavailable`. `name_taken` carries `suggestion`
    (`JournalNameTaken`): the name with the classroom id's first 8 hex
    characters, all 32 if that is taken too (checked once).
  - Which route needs what: create and use an organization with Quiz's App
    active (`not_connected`) and no journal; save, add, delete, upload the
    journal and the organization; refresh and preview the journal only;
    remove nothing, so a journal whose App was uninstalled can still be
    removed and the classroom then disconnected (D28, tested).
  - Saves: GitHub first (Contents API, `baseSha` the lock, 409/422 ⇒
    `conflict`, nothing merged), then `version + 1`, then `ingestJournal`
    awaited (not the queue: the response carries the page); `page` is null
    when the copy did not reach the committed blob. Create and use go
    through `requestIngest` (queued in production); a new row starts at a
    random `version`, so an ingestion that snapshotted a removed row never
    matches a fresh one. Every write calls `bumpVersion` (`ingest.ts`).
  - Author: `displayName` and a noreply address, never the user's email
    (N-DATA-02): linked ⇒ `<id>+<login>@users.noreply.github.com`
    (attributed by the immutable id); not linked ⇒
    `quiz-<user id>@users.noreply.<host of PUBLIC_URL>`. The committer stays the App (GitHub signs
    the commit). Text written into GitHub (seed README, description,
    default commit messages) is English, D12's suggestion; D12 stays open.
  - Invitations (D27): every course staff member with a `github_accounts`
    row, current login through `linkedLogin`, `permission: "push"`; one
    already at push or above (`GET …/collaborators/{u}/permission`) is
    left as is, `accepted` (an invitation would lower an admin); one
    `journal.invite` each (`outcome` `pending`, `accepted`, `stale`,
    `failed`); a failure is logged and never fails the step.
  - Every journal GitHub call, the ingestion's and the writes', goes
    through `boundedClient` (a request hook: no retry, `noRateLimitWait`,
    30 s), the shared adapters included; `once()` is gone.
  - Audit: `journal.create|use|remove|refresh|save|add|delete|upload|invite`,
    subject the classroom.

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
- **As delivered** (#416): what M4-06 and the later tasks inherit:
  - `Q:apps/web/src/journal/JournalSettings.tsx`, in `ClassroomSettings`
    between GitHub and "Archive and delete": one line ("connect first")
    until the classroom is connected; then "Create a journal" (`FormDialog`, the
    name prefilled with `proposedName`; a 409 `name_taken` offers
    "Create <suggestion>" in one click) and "Use a repository" (`FormDialog`;
    branch and folder behind a "Branch and folder" disclosure that opens by
    itself on `ref_not_found`/`root_not_found`); once set, the repository
    (a link to GitHub), branch and folder, the sync state with its check
    level (`LevelIcon` of `ui`: ok, unknown while pending or refreshing, blocker on
    error, with its reason), Refresh, "Remove the journal" (confirmed
    `danger`, says the repository is kept). Nothing accented. A 404 on the
    GitHub or the journal route draws nothing. A journal is still shown
    (and removable) on a classroom that lost its link.
  - `Q:apps/web/src/journal/api.ts`: `useStaffJournal` (key
    `journalKey(id, "staff")`, shared by the tab, the Settings and the
    reader), `journalRefusal`, `journalErrorText`, `nameTakenSuggestion`,
    `useJournalRefresh` — "Refreshing…" from the click until the row's
    `syncStatus` or `lastSyncedAt` moves (the write's own `mutation` hint
    refetches an unchanged row first, so "until the next fetch" would stop
    too early; the `journal` hint follows every ingestion), giving up
    after 60 s; no polling. `JOURNAL_ERRORS` (`words.ts`) words every
    `JournalErrorCode`; anything else is `error.server`, never the
    server's text (`FormError describe`).
  - The teacher's Journal tab is `ClassroomView routeTab="journal"`
    (`ROUTE_TABS.journal`), shown only while the staff payload has a
    repository; its address without a journal (or without an App) replaces
    itself with the classroom's, as the student page's does when
    `hasJournal` is false. The reader lost its breadcrumb (it is
    always a tab now); its staff bar (`StaffBar`) holds the sync state and
    Refresh (`secondary`, `sm`). **Edit (M4-06) goes in that bar.**
  - `classroomJournal` is no longer `preview`; the student page's Journal
    tab shows on `hasJournal` alone. `CLASSROOM_PAGES` now gates only the
    Grades tab and the project pages.
  - `api()` reads no body from a 202 (Refresh), as from a 204; every
    other success is parsed (M4-06 dropped the "declared empty" case).
  - Mock: create, use, remove and refresh change the journals for the
    page's life (`ORG_REPOS` are the taken names); `?journalerror=1`; the
    GitHub disconnect and the student page read `hasMockJournal`.
  - Scenes: `classroom-settings-journal-none|create|name-taken|use|set|sync-error|remove`,
    `classroom-journal-teacher`, `-refreshing`; `journal-empty` is gone (a
    teacher without a journal is sent to the classroom).

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
- **As delivered** (#417): D25 holds in full, WYSIWYG from the start (no
  fallback to the source editor). What later tasks inherit:
  - Edit is the `primary` of the reader's `StaffBar`, beside Refresh and
    two icon buttons (add, delete a page, `Actions`); all three writes are
    off while `repository.editable` is false. The editor replaces the page
    on the same route by local state (`editing` in `JournalReader`), is
    left when another page is on view, and snapshots the page it opened
    (text and `blobSha`) for its life; the conflict's reload remounts it.
  - `src/journal/editor/`: `JournalEditor` (bar + body, laid out by the
    reader through a render prop), `PageFieldsForm`, `AddPageDialog`;
    `frontMatter.ts` splits the `---` block off before the editor sees the
    body and writes the four fields (`title`, `date`, `draft`,
    `visible_from`) LINE BY LINE: an unchanged field keeps its line, a
    changed one rewrites its own, emptied ⇒ removed, new ⇒ appended,
    every other line verbatim, an empty block drops its fences.
  - The journal's schema: `richTextExtensions({ journal: true, imageUrl })`
    (`markdown/journalSchema.ts`): `_`/`*` and `__`/`**` kept, bullet
    markers (`-`, `*`, `+`), thematic breaks, backslash hard breaks and
    `<autolinks>` kept, raw HTML (block and inline) as literal atoms shown
    as text and written back verbatim; no cloze. `RichText` takes the
    web-only `RichTextHostProps` (`journal`, `imageUrl`, `reconcile`,
    `onSourceChange`); the source pane's text is emitted as typed.
  - `reconcile.ts`: the editor's output is cut into blocks (marked's
    lexer) and matched (LCS) against each source block as the editor
    would spell it unedited (`spellWith`, with the page's link
    definitions): matched ⇒ written as READ, blank lines between former
    neighbours kept, lead and trail kept; unmatched ⇒ the editor's
    spelling; a link definition stays after its source predecessor's
    output position, even when that block was edited or deleted.
  - Accepted normalisations, in an EDITED block only (every other block is
    byte for byte, `roundtrip.test.ts` asserts the list): a table is
    re-padded to its columns (its alignment row too); setext ⇒ ATX
    heading; `~~~` and indented code ⇒ backtick fence; `1)` ⇒ `1.`; an
    ordered list is renumbered; `$$x$$` on one line ⇒ three lines; a bare
    URL ⇒ `[url](url)`; a literal `*`/`_`/`` ` ``/`[`/`]`/`~`/`\` is
    escaped; a bare `&` or `<` in text ⇒ an entity; a reference link ⇒
    inline (its definition stays). The file's final newline is kept.
  - Pictures (`images.ts`): uploaded to `<page folder>/images/<slug>-<6
    hex>.<ext from the type>` through `uploadJournalAsset` (content type =
    `assetContentType(path)`), inserted as `images/<…>` relative to the
    page, never `asset:`; drawn from the browser's copy (object URL) until
    a saved page references it, any other relative image from
    `JOURNAL_ASSETS_PATH`. Over 5 MB or an unserved type ⇒ a toast, nothing
    sent. The size and rotate tools of the image stay `asset:`-only.
    Accepted: a picture is committed on drop, before Save, so a Cancel
    leaves the file in the repository unreferenced (the guide says so,
    `docs/guide/classrooms.md`). The object URLs are revoked with the
    editor.
  - External images (F-JRN-09): the resolver answers `REFUSED`
    (`markdown/imageUrl.ts`) for anything that is not a session copy or a
    relative path inside the journal (`https:`, `//`, `asset:`, `/abs`,
    `../` out of the tree): `ImageView` shows the alt text in a dashed
    frame and `renderHTML` writes no `src` (`data-asset` keeps the
    reference); the markdown is untouched.
  - Front matter is read through `@quiz/docrender/frontMatter` (its own
    module now: `FRONT_MATTER`, three groups, `splitFrontMatter`,
    `asBoolean`), so the fields show what the renderer does (`draft: 1` is
    a draft; `...` closes nothing). Asset URLs come from
    `@quiz/docrender/assets`. The web app never imports the package root.
  - Bundle: `JournalEditor` is `lazy` in the reader, a chunk of its own
    (Tiptap, marked, yaml); the reader's chunk, which students load, holds
    neither yaml nor marked (checked on a production build).
  - An autolink stays `<href>` only while its text is its address (a
    plugin drops the flag once the text is edited).
  - Save sends `composePage(...)` with the opened `baseSha` and the
    optional description; Save is off while that markdown equals the
    page's byte for byte (D25 condition 5). 409 `conflict` ⇒ the red
    block above the sheet, draft kept, Save off, "Copy my text"
    (clipboard), "Reload the page…" (confirmed). Source view ⇒ "Preview"
    on demand through `POST …/preview`.
  - Leaving: `useLeaveGuard(dirty, ask)` in `router.ts` holds `navigate`,
    undoes Back/Forward until the answer, and sets `beforeunload`; Cancel
    asks the same question when dirty.
  - The D25 test: `journal/editor/roundtrip.test.ts` over
    `synthetic-journal/` (four pages, every construct the card names) and
    over `JOURNAL_CORPUS_DIR` when set (skipped with its reason in the
    title otherwise). On classroom's production journals (5 pages, fetched
    outside this repository): byte-identical, before and after the review
    round.
  - Mock: save, add, delete, upload and preview, rendered with
    `@quiz/docrender`; `?journalconflict=1` makes every save a 409.
  - Scenes: `journal-edit`, `-source`, `-conflict`, `-frontmatter`,
    `-unsaved`.

### M4-07 — API: journal modes, schema, GitHub mode read-only
- **Depends on**: M4-03, D29 (ADR-057). First of the two-modes series
  (`04-journal.md` §4.5).
- **Goal**: `classroom_journals.mode`; the repository columns
  (`github_repo_id`, `full_name`, `ref`) nullable under a CHECK (set in
  `github`, null in `quiz`); existing rows migrate to `github`;
  `journal_pages` gains a `version` (the Quiz-mode order and parent are
  M4-10's); the `journal_page_revisions` table. A GitHub-mode journal becomes
  read-only: M4-03's save, add, delete and upload refuse it (a coded
  refusal, not a 404). The staff payload carries the mode and, in GitHub
  mode, each page's Edit on GitHub URL (the file on the journal's branch,
  under its root folder).
- **Files**: `Q:db/journal.ts`, one migration, `packages/contracts/src/journal.ts`,
  `Q:modules/journal/writes.ts`, `service.ts`, `studentView.ts` (unchanged
  output: assert it).
- **Tests**: the CHECK refuses a `quiz` row with a repository and a
  `github` row without one; migrated rows are `github`; every M4-03 page
  and asset write on a GitHub-mode journal is refused and writes nothing;
  the Edit on GitHub URL (root folder, branch, a path with spaces); the
  student payload carries neither the mode's URL nor anything new.

### M4-08 — API: the Quiz-mode backend
- **Depends on**: M4-07.
- **Goal**: create a Quiz-mode journal without GitHub (no App, no
  connection; the module's Quiz-mode routes register when the `GITHUB_*`
  variables are absent), with an empty home page; save (page `version`
  lock, `409 conflict`), add, delete, asset upload (relative path beside
  the page, sha256 as `blob_sha`), each in one transaction that
  re-renders, recomputes `asset_paths` and records a revision on save;
  revisions list and restore; assets kept until the journal goes (no
  collection: a restored revision needs its images, D29); remove and
  classroom deletion delete the only copy (the API requires the typed
  classroom name when pages exist, F-JRN-04). Audit: `journal.create`
  with the mode, the Quiz-mode page writes (the existing
  `journal.save|add|delete|upload`, or `page_*` names: decide and record
  it in the handoff), `journal.restore`. Writes frozen during a mode
  switch (a flag the switch tasks set). Settle, and record in D29, what
  deleting a page does to its revisions.
- **Files**: `Q:modules/journal/` (a `quiz.ts` beside `writes.ts`),
  `packages/contracts/src/journal.ts`, `apps/api/src/audit.ts`.
- **Tests**: `*.db.test.ts` — create with no App configured; a stale
  `version` is a 409 and writes nothing; a revision per save, restore is a
  new save and audited; an asset referenced only by a draft is a 404 to a
  student (J1), served once the page is published; the student exit
  extended (05 §5.7): a former revision's content searched for in every
  student response, for the three student callers; impersonation and
  `seb`/`kiosk` sessions never write.

### M4-09 — Web: mode choice, standard editor, GitHub mode read-only
- **Depends on**: M4-08, M4-06.
- **Goal**: the mode as a segmented control in the Journal section of
  Settings ("In Quiz" / "In a GitHub repository", fr "Dans Quiz" / "Dans
  un dépôt GitHub", a one-line explanation each; the GitHub option needs
  a connected classroom). In Quiz mode: Edit opens the platform's
  standard `RichText` (as question statements), the front matter as
  fields, relative-path image upload, conflict kept as a draft, revisions
  listed and restorable. In GitHub mode: Edit on GitHub is the primary
  action of the `StaffBar`, Refresh secondary, no add, delete nor upload.
  Remove: the confirmation of F-JRN-04 per mode. Delete
  `journal/editor/reconcile.ts`, `markdown/journalSchema.ts`, the
  `journal: true` mode of `richTextExtensions` and their tests. Whether
  F-ORG-13's "Connect to GitHub" accent stays the Settings' one accent
  when a Quiz-mode journal exists is a question for the product owner,
  asked before the scenes are taken.
- **Files**: `apps/web/src/journal/`, `apps/web/src/markdown/tiptap.ts`,
  i18n en + fr, the mock.
- **Scenes**: `journal-settings-mode`, `journal-edit` (standard editor),
  `journal-github-readonly`, `journal-revisions`, `journal-remove-quiz`.
- **As delivered**: the product owner kept "Connect to GitHub" as the
  Settings' one accent, whatever the journal (projects need it). The mode
  is a `Segmented` in a settings row, its description the chosen mode's
  line; on a platform without Quiz's App, In Quiz only (no control). The
  staff bar is drawn by `mode`, never by "has a repository": Quiz mode =
  the Pages menu (`Actions menu`: add, History, Deleted pages, delete) +
  Edit; GitHub mode = sync state, Refresh, Edit on GitHub (`LinkButton`
  to the page's `editUrl`, new tab). History and Deleted pages are sheets
  (`journal/JournalHistory.tsx`), a revision rendered through `POST
  …/preview` or shown as markdown. One typed-name confirmation:
  `useConfirm({ typeToConfirm })` (`confirm.tsx`), used by Remove the
  journal and by the classroom's deletion (`?confirm=`, both decided by
  `removalNeedsName`). The editor is the standard `RichText` with
  `longForm` (the `.md-doc` type only, no schema change); `reconcile.ts`,
  `journalSchema.ts`, `spellWith`, the round-trip test, the synthetic
  journal and `.rt-raw-html` are gone; `JournalRepository.editable` too
  (contracts and API). Mock: `?journal=1` is Quiz mode,
  `?journalgithub=1` GitHub mode, with revisions and a deleted page.

### M4-10 — Rename, reorder, nest (Quiz mode)
- **Depends on**: M4-09.
- **Goal**: rename a page (its title), move it among its siblings and
  under another parent; the path never changes (F-JRN-17). API and web.
  Audit `journal.reorder`. Adds the Quiz-mode explicit order and parent
  columns on `journal_pages` (deferred from M4-07); `parent_path` keeps
  its meaning, the directory of the file.
- **Tests**: links and the navigation after a move; a move to a
  descendant refused; the student navigation never names a hidden page.

### M4-11 — Move to GitHub
- **Depends on**: M4-10, M2-03.
- **Goal**: a Quiz-mode journal moves into a NEW repository, or an EMPTY
  one, of the classroom's organization (never one with content, ADR-049
  point 6): one initial commit with every page and asset, numeric
  prefixes from the order (steps of ten), relative links rewritten; the
  row becomes `github`, read-only; the staff invited as for a creation.
  Writes frozen while it runs. Audit `journal.export`.
- **Tests**: a non-empty repository refused; the committed tree renders,
  through ingestion, to the same student HTML as before the move; a save
  during the move refused.

### M4-12 — Bring back into Quiz
- **Depends on**: M4-08.
- **Goal**: a GitHub-mode journal becomes a Quiz-mode one from its copy;
  the repository is detached, never deleted nor changed. The confirmation
  lists what is left behind (files of the repository the copy does not
  hold) and says that the first save normalises the markdown. The order
  and parents come from the file names. Writes frozen while it runs.
  Audit `journal.import`.
- **Tests**: paths, order and assets preserved; no GitHub write; the
  disconnect `409` (F-GH-04) no longer applies afterwards.

### M4-13 — Copy a journal from another classroom (later)
- **Depends on**: M4-08. Not in the first version (D29).
- **Goal**: create a Quiz-mode journal as a copy of another classroom's
  journal of the same course (the next semester), both under
  `staffAccess`.

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
  cards; Grades stayed an anchor of the home until the global `/grades`
  page (2026-10-01, below).
- **Scenes**: `student-courses`, `student-classroom`, `-journal`,
  `-empty`, `-error`, phone and desktop.

### M5-03 — Gradebook module
- **Depends on**: M3-08a, M3-08b, D06.
- **Create**: `Q:modules/gradebook/` owning `gradebook_columns` (nullable
  `evaluation_id` / `project_id` + CHECK exactly one, weight, position);
  `packages/domain/src/gradebook.ts` (weighted mean); teacher Grades API,
  CSV/xlsx (staff rows dropped, ADR-018 §5).
- **Tests**: equals per-evaluation results on the seeded world; only
  released grades; polls never.
- **Note** (2026-10-01): the student's global Grades page (`/grades`,
  `GET /app/api/student/results` → `StudentGrades`) exists before this
  task; once D06 is settled the gradebook becomes its data source, under
  the same feedback-policy filter (F-RES-04).
- **Note** (product owner, 2026-10-01, from M3-01): the M3 tasks give no
  score to a student without a repository. The score a teacher sets for a
  student who never accepted a project (F-GBOOK-01, 06 no. 48) and the
  absence mark are this task's: where that score is stored is decided
  here (M3-01's `project_repos` has no row to hold it).
- **From M3-08b** (2026-10-04): a released project's grade is read, not
  stored: the gradebook reads the LIVE final score (`repoScores` of
  `modules/project/detail.ts`, or `resolveFinalScore` with `teacherMax`)
  passed through `releasableScore(project, repo, final)` (`detail.ts`: a
  non-live repository's to-verify final is no score), graded by
  `scoreGrade(points, max, projects.grading_scale)`, and marks
  the cell "changed after release" when `changedAfterRelease(true, final,
  { released_points, released_max })` says so — the same reading as the
  staff's page (decision 3). A repository with a null snapshot
  (`released_points IS NULL` after the release) had no score: an empty
  cell. The source of a cell (I42) is `final.source`: `teacher`, `review`
  or `ci`. A teacher's score carries its own maximum (`teacher_max`):
  never rescale it to the CI's.

### M5-04 — Web: Grades tabs
- **Depends on**: M5-03.
- **Goal**: teacher Grades tab (Export primary); the student Grades tab
  reads the gradebook when enabled.
- **Note** (2026-10-01): the student tab reuses the global `/grades`
  page's table (`StudentGrades`, §5.2), its rows narrowed to the classroom
  on the server (`studentEvaluationRows` takes a classroom id; a classroom
  route loaded through `readableClassroom`), plus project grades; not a
  second component, and no filtering in the browser.

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
  audit table, pre-flight checks — extending M1-06's script, which already
  imports the people, the rosters and the GitHub account links. The
  cutover waits for this task (D08 addendum): M1-06 alone switches nothing.
- **Acceptance**: dry-run on the synthetic fixture and on a staging copy of
  a production dump: parity report clean.
- **From M2-02's review**: an organization imported twice (a null-id row
  and an id row with the same login) must be merged by the import, not left
  to `retireLoginHolders`.
- **From M3-01** (the project steps moved here, 2026-10-01): ids kept,
  `ON CONFLICT DO NOTHING`, in FK order. `assignments` → `projects`
  (`classroom_id` mapped; `org_id` = the mapped classroom's
  `github_classroom_links.org_id`; `squashed_*` → `distribution_*`;
  `llm_dispatched_at` dropped (M3-05b: the column is gone, migration
  `0060`; see the note below); `grades_validated_at/by` →
  `released_at/by`; `created_by` = the remapped classroom owner;
  `grading_scale` = `{kind: "score_is_grade"}`, heig-classroom's own
  reading — a score out of 6 is the grade, any other maximum linear
  (product owner, 2026-10-02: released grades do not move at the import); the
  codespace columns and `work_mode` dropped, a non-`free` row refused);
  `assignment_milestones` → `project_checkpoints`; groups and members
  (`enrollment_id` remapped); `student_repos` → `project_repos` (`user_id`,
  `teacher_graded_by` remapped, `llm_grade_run_id` →
  `review_grade_run_id`, `accepted_at` copied — no default; for a
  released project, `released_points` / `released_max` = the final score
  at the import, so nothing reads "changed after release");
  `grade_runs` → `project_grade_runs` (`grade_points/max` → `points/max`,
  `kind` `llm` → `review`); `bot_commits`, `grade_dispatches` (`trigger`
  `milestone` → `checkpoint`, `milestone_id` → `checkpoint_id`),
  `reverts` (`student_repo_id` → `repo_id`).
- **From M3-04** (orchestrator, 2026-10-02): Quiz counts two bots only,
  its own App and `github-actions[bot]`: **heig-classroom's App must stop
  acting on a repository once it is imported** (no restore, deadline commit
  nor sync of its own), or its pushes would be a person's to Quiz — checked
  by the restores and counted as student commits. Imported `reverts` rows
  keep `head_sha` null (the column is new, migration `0057`), and imported
  `project_grade_runs` take `to_verify = false`, `parse_detail` null.
- **From M3-05b** (2026-10-02): Quiz derives "the final review was asked"
  from the `grade_dispatches` ledger alone (`projects.review_dispatched_at`
  is dropped), and its ticker dispatches a `grade-final` to EVERY live
  repository frozen with a frozen run and no `deadline` ledger row, of a
  project graded `auto`. So the import must leave no such repository it
  does not mean to review again: for an assignment whose
  `llm_dispatched_at` is set, a repository with a frozen run and no
  `deadline` row (a row lost, or older than the ledger) gets a confirmed
  synthetic row (`sha` = its frozen run's head, `dispatched_at` =
  `llm_dispatched_at`), counted in the report. heig-classroom's ledger rows
  left unconfirmed (`dispatched_at` null, which it would have retried) are
  imported as they are: Quiz never sends them again, its staff see them
  "not confirmed". Likewise a milestone already dispatched keeps its
  `dispatched_at` (`project_checkpoints`), or it fires again.
- **From M3-09b** (2026-10-04): the day-before reminder is claimed on
  `projects.reminder_sent_at` and `project_repos.reminder_sent_at` (own
  deadline), both null = owed; the scan skips a window under a day on
  `start_at`, nothing else. The import must set them to the import time
  for every imported project or repository whose effective deadline lies
  within 24 h of the import (and may for any deadline already past), or the
  first `projectTick` reminds every student of those projects at once; a
  deadline further ahead is legitimately reminded later and may stay null.
  heig-classroom's own marker, when one exists, is copied as it is. An
  imported organization keeps `suspended_at` null unless heig-classroom
  knew it suspended.

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
