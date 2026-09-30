# 3. GitHub and projects

Classroom's GitHub side is about 6 000 lines with about 150 tests, in two
layers:

- **Adapters** — `C:github/*` (octokit and git): no database, portable
  almost verbatim.
- **Flows** — `C:modules/webhooks.ts`, `grading.ts`, `deadline.ts`,
  `dispatch.ts`, `sync.ts`, `tasks.ts`, `group-repos.ts`,
  `modules/assignments/*`, `modules/student.ts`: coupled to classroom's
  `organizations → classrooms(owner) → assignments → student_repos` chain,
  rewired onto Quiz's substrate.

## 3.1 Inventory (what must survive the port)

### App and client (`C:github/app.ts`, `C:config.ts`)
- One GitHub App, lazily initialised; absent ⇒ the feature is off, boot and
  `/healthz` unaffected.
- `installationClient()`: octokit + a token for git; tokens only in memory
  (1 h cache).
- `ThrottledOctokit`: background jobs wait out a rate limit once; HTTP reads
  pass `request.noRateLimitWait` and fail fast (fix of the 35-min hang,
  #37).
- `listInstalledOrgs`, `orgExistsOnGithub` (App JWT, anonymous fallback,
  `null` = indeterminate), `fetchOrgPlan` (free plan ⇒ no org secrets for
  private repos, no rulesets), `fetchOrgLlmSecret` (**needs org
  Secrets:read, not in the documented permission table — verify the live
  App**, M0-02), `resolveOrgInstallation`.
- Env: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_SLUG`
  (bot login `<slug>[bot]`), `GITHUB_WEBHOOK_SECRET`,
  `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`.
- Registration (`C:docs/deployment/github-app.md`): repo Actions R,
  Administration RW, Checks R, Contents RW, Metadata R, Pull requests RW,
  Workflows RW; org Members R, Plan R; events push, workflow_run,
  pull_request, member, repository, organization (+ installation).

### Org onboarding (`C:modules/classrooms.ts`)
- `GET /setup/github/installed` (App Setup URL, no session): verifies
  `installation_id` with the App JWT, stores installation/org/status/plan,
  audits `org.installation_resolved`, `state` = the classroom to return to.
- `GET /app/api/orgs`: installed orgs.
- **Lazy healing on every classroom open**: resolve a missing installation,
  re-check the org while uninstalled (`active|degraded`), refresh a null or
  free plan, resolve `githubOrgId` (install wizard `target_id`), probe the
  LLM secret, return `appSlug`.

### Account linking (`C:auth/github-link.ts`)
- The App's own user-to-server OAuth (no OAuth App, no scope): signed state
  cookie (10 min), code exchange, `GET /user`, **token discarded** (AU-09),
  `github_user_id` UNIQUE (AU-10; a clash ⇒ `?github=conflict`).
- `inviteOnGithubLink()`: invites to group repos created before the student
  had a login.
- Renamed accounts (#41): `currentLogin()` follows the immutable id
  (`GET /user/{account_id}`), audits `github.renamed`; a deleted account or
  refused invitation ⇒ `409 github_account_stale`.

### Assignment creation (`C:modules/assignments/lifecycle.ts`, `github/squash.ts`, `github/studentize.ts`)
- Source repository in the org (`source_not_found`); branches default to its
  default branch.
- Slug with `-2..-20` suffix on reuse (cbcc780).
- Distribution repo `<slug>-squashed`, synchronous: `whole` (history pushed)
  or `squash` (one commit per branch after `applyStudentHandout`: the
  `student/` overlay and `.studentignore`, safe against symlinks and path
  escapes, #33); collisions retry `-squashed-2..-5` (e26ba59); an EMPTY
  leftover is adopted; on the unique-slug race the new repo is deleted.
- Org repository browser with protected-file suggestions.
- Settings: publish manual/scheduled, duration, grace (30 min), source
  strategy, deadline strategy lock/commit, grading none/auto, branches,
  protected files, group mode and max size, work mode, milestones.

### Acceptance and provisioning (`C:modules/student.ts`, `github/provision.ts`, `github/collaborators.ts`, `group-repos.ts`)
- Preconditions: claimed enrollment (else an indistinguishable 404),
  published, GitHub linked, App installed, squashed repo ready; the login is
  followed if renamed.
- `claimProvisioning`: atomic claim (`provision_claimed_at`, taken over
  after 5 min), `409 provision_in_progress`; `markProvisionFailed` never
  overwrites an `ok` row.
- `provisionStudentRepo` checks state before every step (a full replay is
  safe): create (422 ⇒ adopt, `canAdopt` for groups) → push from squashed
  unless the default branch exists (never list refs of an empty repo;
  `pushWithRetry`) → align the default branch (2109972) → ruleset
  `hgc-protect` (the free-plan 403 "Upgrade to GitHub Pro" is tolerated,
  #15; any other 403 fails) → invite: push (free), pull (online), none
  (online_seb).
- `redactTokens` (a1e59e0). Teacher e-mail on provision error once per repo;
  invitation e-mail to every invited member.

### Groups (classroom ADR-014, now ADR-048, lots 1–2)
- Groups per assignment, membership by enrollment (UNIQUE(assignment,
  enrollment)); split, singles, copy; advisory max size; free work mode
  only; group mode toggled only in draft.
- Publish guard `409 unassigned_students`, also inside the ticker's
  scheduled-publish claim (`groupFormationComplete()`).
- Group repos `<assignment-slug>-<group-slug>` (≤ 100 chars, disambiguated
  by group id); a group never adopts another row's repo.
- Membership changes follow on GitHub (invite; revoke after cancelling
  pending invitations; `502 revoke_failed` leaves membership untouched);
  roster removal revokes before the cascade.
- Lot-1 leftovers: a live individual repo wins over the group repo
  (`isLiveIndividualRepo`, `pickStudentRepo`).

### Deadline (`C:deadline.ts`, `github/lock.ts`, `github/commit.ts`, `C:ticker.ts`)
- Every 20 s: published assignments due and not applied ⇒ `deadline.apply`
  (singleton, retry 5 — in heig-classroom; the port must pick a queue
  policy at creation, since a `singletonKey` dedupes nothing on a
  `standard` queue: see the note under J2 in `04-journal.md`, quiz #273).
- Handler: re-reads the condition (a rescheduled deadline is honoured);
  atomic claim (`deadline_applied_at`, `state=locked`, teacher e-mail once);
  provisional freeze (`frozen_grade_run_id = selectGradeRun`); per live repo:
  - **lock**: ruleset `hgc-deadline-lock` on `~ALL`, else archive (H8,
    `repo.deadline_archived`);
  - **commit**: an empty bot commit per branch, non-forced, in
    `bot_commits(deadline)`.
- 404 ⇒ `markRepoDeleted` (terminal, d7c8a72); other failures rethrow;
  notices only when something was applied (#10).
- **Reopen** when the deadline moves: unlock, reset markers, clear frozen
  and LLM slots, delete the ledger, requalify runs `after_deadline=false`,
  reselect.
- Manual lock/unlock per repo; definitive freeze at deadline + grace;
  scheduled publication; J-1 reminder.

### Webhooks (`C:modules/webhooks.ts`, `C:jobs.ts`)
- `POST /webhooks/github`: scoped raw-body parser → constant-time HMAC (401)
  → dedup on `X-GitHub-Delivery` → **synchronous `push_receipts` insert**
  for tracked repos (ADR-012; `is_bot`, `forced`) → enqueue → 200 in
  < 100 ms.
- Worker (retry 5, error stored on the delivery): push on a source repo
  (`source_ahead_sha`), on a journal repo (journal module), on a student repo
  (drop live cache; `github-actions[bot]` push = grader commit; metrics;
  toast; protected-file revert, ≤ 5/h/repo then `repo.revert_cap`);
  `workflow_run` (pending, or `ingestCompletedRun`); `pull_request` on
  `sync/*`; `member` added (invitation accepted); `repository`
  renamed/deleted; `organization` renamed (rewrite `<org>/` prefixes) or
  deleted (degraded, e-mail); `installation` deleted.

### Grading (`C:grading.ts`, domain `grade.ts`, `finalGrade.ts`, `C:dispatch.ts`)
- One ingestion path for webhook and reconciliation (ADR-011, imported
  from classroom under the same number).
- Eligible: selected branch, head not a bot commit; idempotent on (repo,
  run, attempt); GRADE and TESTS annotations only from
  `.github/workflows/grading.yml`'s check suite.
- `after_deadline` from `push_receipts`; an unknown receipt after the
  deadline counts as after (GR-14.3).
- LLM review runs (`repository_dispatch` of grading.yml) fill the LLM slot
  only if parsed, successful and frozen; `grade.final` e-mail to every
  member.
- `selectGradeRun` (GR-09), improvement during grace.
- Dispatch job after the freeze: one `grade-final` per repo with the frozen
  SHA, ledger row claimed before the call (at-least-once). Milestones:
  `grade-milestone` on the last non-bot receipt before `due_at` (trace only).
- Teacher: grade-now (`workflow_dispatch`), override (after freeze only),
  validate-grades (sign-off). Final = teacher ?? LLM ?? frozen CI ?? current.
- CI runs on classroom's self-hosted runner VM (ADR-007, a PAT outside the
  App) — keeps running, operated as today.

### Live state and SSE (`C:github/metrics.ts`, `C:events.ts`)
- `fetchRepoLiveState`: head, commit count via `Link`, check-runs.
- Cache (#37/#40): 60 s TTL, stale-while-revalidate to 15 min, one shared
  promise, per-installation backoff until reset, webhooks invalidate, views
  overlay stored state and flag `liveStale`.
- **Per-repo hints reach students only on their own `user:` topic (#38).**
  The client coalesces hints over 1 s and caps GitHub-backed refetches at
  one per 30 s.

### Sync and reconciliation
- Sync (`C:sync.ts`, `github/sync.ts`): update the squashed repo, force-push
  the bot-only `sync/<branch>` to every live unlocked repo
  (`bot_commits(sync)`), open or comment the single sync PR, never merge.
- `reconcile.grades` (15 min): repos quiet > 30 min, last 20 runs through
  `ingestCompletedRun`. `reconcile.repos` (24 h): pending invitations,
  head, CI. `reconcile.deliveries` (24 h): local unprocessed > 10 min
  re-enqueued; GitHub failures of the last 24 h redelivered (≤ 50).
  `purge.housekeeping`: payloads > 30 days.
- Admin-configurable period, enable flag, run-now, last status, atomic claim
  (`scheduled_tasks`).

## 3.2 Coupling and its Quiz replacement

| Classroom | Quiz |
| --- | --- |
| `organizations`, `classrooms.org_id NOT NULL` | `github_organizations` + `github_classroom_links` (optional link, made lazily); `projects.github_org_id` denormalised |
| `classrooms.teacher_id` owner, `classroom_staff`, `isOwner` | `course_staff`, no owner; "the teacher" = the course staff (`staffOfCourse`); `teacher:` audiences → `course:<id>` |
| `teacherGuard`, `accessibleAssignment/StudentRepo` | `Q:modules/guards.ts`: `staffAccess(me, classrooms.course_id)` + new `findAccessibleProject`, `accessibleProjectRepo`, student loaders by own enrollment/group (404 otherwise) |
| `enrollments.status='claimed'` | `user_id IS NOT NULL` |
| `users.github_*` | `github_accounts` (module `github`) |
| audit strings | the closed union `Q:audit.ts` (§3.6) |
| `events.ts` string messages, `PER_STUDENT_TYPES` | structured `AppNotice` variants rendered with `t()`; per-repo hints to `course:` + `user:` topics — **Quiz's `classroom:` topic reaches students without per-type filtering; publishing there reintroduces #38** |
| `mailer.ts queueEmail` | notifications (ADR-030): `notify/notifyMany`, outbox, new kinds |
| raw pg-boss queues | `Q:jobs.ts` `JobQueue` facade (dev in-process queue has no retries: tests call handlers directly) |
| 20-s ticker, `scheduled_tasks` | `Q:ticker.ts` `TickTask` with `everyMs` on the 1-s loop: **claim and enqueue only, never a GitHub call inside a tick** (invariant 5); `scheduled_tasks` ported for restart-safe periodic jobs (D10) |
| `Date.now()`, `sql now()` | `app.clock.now()` (TestClock in tests) |
| grade sheet `C:modules/grades.ts` | the `gradebook` module (M5-03) |
| roster removal cascade | a pre-removal hook registry in `Q:modules/org/service.ts removeEnrollment` (no org→project import) |
| — | ADR-034/027: link, unlink and accept refuse impersonation and delegated sessions |
| app-level JSON parser | webhook plugin encapsulated with its own buffer parser (not `fastify-plugin`) |
| git CLI in the image | `node:24-slim` needs `git` + `ca-certificates` (Dockerfile) |

## 3.3 Target design

### Layout and direction

- `Q:apps/api/src/github/` — the adapters, same shape as classroom so fixes
  can be forwarded during the transition. No `packages/github` (no second
  consumer).
- `modules/github` — installations, org↔classroom link, account linking,
  webhook intake, delivery reconciliation. Files: `routes.ts`, `service.ts`,
  `deliveries.ts`, `events.ts`, `jobs.ts`.
- `modules/project` — projects, repos, groups, ingestion and grading,
  deadline/freeze/dispatch, sync, reconciliation, views. Files: `routes.ts`,
  `service.ts`, `events.ts`, `jobs.ts`, `lifecycle.ts`, `accept.ts`,
  `groups.ts`, `groupRepos.ts`, `ingest.ts`, `grading.ts`, `deadline.ts`,
  `dispatch.ts`, `sync.ts`, `reconcile.ts`, `views.ts`, `repos.ts`.
- **Direction: project → github.** The github worker dispatches through a
  handler registry filled by the project plugin (`onEvent("push")`,
  `onReceipt` for the synchronous receipt). The journal registers the same
  way.
- Schema: `Q:db/github.ts`, `Q:db/project.ts`.

### Tables

- `github`: `github_organizations(id, github_org_id UNIQUE NULL, login
  UNIQUE, installation_id UNIQUE NULL, status, plan)`,
  `github_classroom_links(classroom_id PK → classrooms CASCADE, org_id,
  linked_by, linked_at)`, `github_accounts`, `webhook_deliveries`,
  `push_receipts`.
- `project`: `projects` (← assignments; + `classroom_id`, `github_org_id`,
  `created_by`, `grading_scale`; the four partial indexes kept),
  `project_milestones`, `project_groups`, `project_group_members` (FK to
  `enrollments`), `project_repos` (← student_repos, partial uniques kept),
  `project_grade_runs`, `bot_commits`, `grade_dispatches`, `reverts`.
- `system` (D10, M2-05, already there): `scheduled_tasks`; the admin
  routes live in `admin`.
- UNIQUE constraints remain the idempotency mechanism.

### Contracts (`packages/contracts`)

- `github.ts`: `OrgStatus` (installed, exists, plan, llmSecret, appSlug),
  `GithubAccount`, link body.
- `project.ts`: `ProjectCreate/Patch` (classroom's zod rules),
  `ProjectSummary`, `ProjectDetail` (`liveStale`), `GradeView`,
  `GradeRunList`, `GroupsPayload`, `Milestone`, `GradeOverride`,
  `StudentProjectCard`; error codes `github_not_linked`,
  `github_account_stale`, `provision_in_progress`, `no_group`,
  `unassigned_students`, `has_repo`, `revoke_failed`, `app_not_installed`,
  `not_frozen`, `strategy_frozen`, `publish_mode_frozen`,
  `source_not_found`, `squashed_failed`, `duplicate_slug`.
- `ActivitySummary` and `ResultCard` become discriminated unions.
- `AppNotice` variants: `project_commit_pushed`, `protected_reverted`,
  `sync_done`, `grade_captured`, `accepted`, `deadline_applied`,
  `review_dispatched`.
- Notification kinds — student: `project_published`,
  `project_deadline_reminder`, `project_repo_invited`,
  `project_grade_final`; staff: `project_deadline_applied`,
  `project_provision_failed`, `github_org_lost` (D18).

### Routes

- github: `/webhooks/github`, `/setup/github/installed`,
  `/app/auth/github/{link,callback,unlink}`, `GET /app/api/github/orgs`,
  `GET|PUT|DELETE /app/api/classrooms/:id/github`.
- project (teacher): `GET|POST /app/api/classrooms/:id/projects`,
  `PATCH|DELETE /app/api/projects/:pid`, `POST
  /app/api/projects/:pid/{publish,archive,unarchive,sync,release}`,
  `GET /app/api/projects/:pid` (detail),
  `GET …/repos/:rid/{grade-runs,activity}`,
  `POST …/repos/:rid/{lock,unlock,grade-now}`, `PATCH …/repos/:rid/grade`,
  milestones, groups, org repository browser.
- project (student): `POST /app/api/student/projects/:pid/accept`, cards in
  the student home and classroom payloads.

### Grades

Keep the four slots per repo (current CI, frozen CI, LLM, teacher) and
`resolveFinalGrade`. Classroom's `validate-grades` becomes Quiz's
**release** (`project.release`, kind `project_grade_final`). The Swiss
grade comes from `gradeFromPoints` with the project's `grading_scale` (D05
settles the "max 6 = a mark" convention). Quiz's `gradings` table is not
reused.

### Audit actions

- `github.link|unlink|renamed`;
  `github_org.link|unlink|installation_resolved|installation_deleted|renamed|deleted`.
- `project.create|update|delete|publish|auto_publish|archive|unarchive|deadline_applied|deadline_reopened|frozen|review_dispatched|milestone_dispatched|sync_requested|synced|release|accept|accept_failed`.
- `project_repo.lock|unlock|grade_now|grade_override|deleted|deadline_archived|protected_files_reverted|revert_cap`.
- `project_group.create|rename|delete|copy|split|singles|member_add|member_remove|repo_invite|repo_revoke`;
  `project_milestone.create|delete`; `task.configure|run_now`.

### Jobs and ticker

- Queues: `github.webhook` (retry 5), `project.deadline`, `project.sync`,
  `project.dispatch`, `task.run`.
- `PROJECT_TASKS` (`everyMs` 20 s, claim + enqueue only): scheduled publish
  with the group guard, due deadlines, J-1 reminder, freeze, review
  dispatch, milestones, scheduled-tasks claim.
- `grace_minutes` stays (CI completion); Quiz's 3-s exam grace does not
  apply to projects.
- No App configured ⇒ tasks skip, no retry loop, no `markRepoDeleted` from
  a foreign 404.

### Configuration

Six `GITHUB_*` variables, absent ⇒ off. Production refusals: an App id
without a readable PEM, a webhook secret shorter than 32 characters, a
missing slug. `Q:redact.ts` gains `x-access-token:` and `gh?_` patterns.

## 3.4 Quiz's own GitHub App (D23)

The first plan reused classroom's App at the cutover; D23 replaced it.

- **Three Apps.** Classroom's (unchanged, serves classroom until the
  cutover), Quiz's production App (webhook
  `https://quiz.chevallier.io/webhooks/github`, setup URL and callback on
  Quiz), and a staging App on a test organization. Each has its own id,
  key, webhook secret, client id and secret, slug.
- **Coexistence.** An organization may install classroom's App and Quiz's
  side by side; each receives its own deliveries. A repository used by
  both (a journal read by classroom and by Quiz) is harmless: both mirror
  it, neither writes unless a teacher saves.
- **Permissions** are those of classroom's App (§3.1), plus organization
  `Secrets: read` for the LLM secret probe (I50) — decided at registration,
  since changing a permission later makes every organization owner
  re-approve.
- **At the cutover** the organizations still used by classroom install
  Quiz's App ("All repositories"); the import resolves their installation
  ids. Account links survive (`github_user_id` is the person's).
  Collaborator seats, rulesets (`hgc-protect`, `hgc-deadline-lock`) and
  the repositories stay where they are; Quiz's App, with Administration
  RW, manages them. Bot detection knows both bot logins (classroom's for
  commits made before, Quiz's after).
- **Staging never holds the production App** (ADR-028 restores production
  dumps into staging: with the production key, staging's ticker would lock,
  commit, revert and dispatch on real student repositories). The staging
  refresh nulls `installation_id` (M2-06).
