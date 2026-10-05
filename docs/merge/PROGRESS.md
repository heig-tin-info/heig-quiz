# Merge progress

The single source of truth for where the merge stands. Update it **in the
PR of the task** (claim in the first commit, close in the last), never in a
separate commit on `main`. Protocol: [`README.md`](README.md).

## Now

- **Phase**: the journal track is merged (M4-01…09); next the projects
  (M3) and the import (M1-06, M8), which go live together (D26) at a
  cutover during the autumn semester, target the week of 2026-10-05
  (D20).
- **Next actions**: M3-01 (D05 settled) then the M3 chain; M1-06 (the
  import skeleton) in parallel; M4-10, M4-12 and M8-03 are free; M2-08
  (#452) merged. M2-06 needs the product owner to register Quiz's two
  GitHub Apps before anything is tried on staging. Teachers create their
  Quiz classrooms; the merge then writes the correspondence table
  (D22). Every M0 decision is settled. The import carries the
  GitHub account links (spec 06 no. 45): M1-06's identity step.
- **Classroom sync point**: `ab98cc0` (classroom `origin/main`,
  2026-09-28). A classroom commit after it touching a ported file must be
  forwarded (see strategy §1.2, principle 6). Check with
  `git -C ~/heig-classroom fetch && git -C ~/heig-classroom log --oneline ab98cc0..origin/main`.
- **Quiz base of the analysis**: `a7dfa26`.

Status values: `todo` · `in progress` · `review` (PR open, ready) ·
`done` · `blocked` (say on what) · `dropped`.

## Plan

| ID | Task | Status | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- |
| PLAN | Merge plan: ADR-035 (proposed), `docs/merge/` | done | `plan/merge-classroom` | #268 | Five read-only analyses (data, GitHub, journal+web, codespace+infra, spec fit) condensed into these files |

## M0 — Decisions and paper

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M0-01 | Settle blocking decisions | done | — | | | D01, D02, D04, D08, D16 settled 2026-09-28; D03, D07, D14, D15, D23–D25, D27 settled 2026-09-30; D05, D06, D11–D13, D17–D20, D22, D26, D29 settled 2026-10-01; D09 and D21 settled 2026-10-01 (#466); M0 closed; spec 06 nos. 45–49 settled the same day |
| M0-02 | Measure production (read-only) | done | PO go | `plan/merge-classroom` | #268 | `measures-2026-09-28.md`: pairwise edu-ID subs (login adoption needed), workspace unused by real classes, 3 classes to merge into existing Quiz classrooms, 0 pending staff; App permissions not checked |
| M0-03 | ADRs (035 accepted, imports, amendments) | done | M0-01 | `merge/M0-03-adrs` | #365 | ADR-035 Accepted; classroom ADR-011 ⇒ 011, 013 ⇒ 047, 014 ⇒ 048, 015 ⇒ 049 (journal, addendum for D03 and J1–J7); 029 superseded; 006/007/010/012/016/027/030 amended, the D05/D06/D18/D21 parts left open; M0-05 must drop "ADR-007 not applicable" from `CLAUDE.md` |
| M0-04 | Spec amendments | done | M0-01 | `merge/M0-04-spec-journal` (journal track), `merge/M0-04-spec-projects` | #367, #461 | Journal track done in #367: F-ORG-13..15, F-GH-01..05, F-JRN-01..12, N-RES-07, N-SEC-12..18, 05 §5.3/§5.7/§5.11, 06 nos. 30–33, 07 frozen, D16 in spec prose; D28 opened then settled (a) 2026-09-30. Projects track in #461: F-PROJ-01..21, F-GBOOK-01..06, F-NOTIF-13, F-ORG-09/14/15, F-RES-05 promoted; N-PERF-07, N-RES-08, N-SEC-20/21, N-DATA-02/03/05; 01 (§7.4 words, Project terms, ER, lifecycles, invariants 9–11), 00 (GitHub Classroom column, phases, risks), 05 (modules `project`, `gradebook`, tables, §5.7, §5.10, §5.11), 06 nos. 30 (settled), 44–49, 08 novice path, ADR-012 addendum. The online workspace and unified SEB are specified with M6 (D09, D21 settled) |
| M0-05 | `CLAUDE.md`, `AGENTS.md`, reviewer prompts | done | M0-03 | `merge/M0-05-claude-md` | #369 | `CLAUDE.md` invariants 4 (journal student view), 6 (`readableClassroom`, created by M4-02), 11–12 scoped to `apps/runner`, 14 (project source at the frozen sha), new 15 (GitHub App and secrets); `invariant-reviewer` checks them; `AGENTS.md` unchanged; D16 in ADR prose done, the `en`/`fr` strings `eval.resetAttempt.message` and `eval.logVisibility.desc` still say "journal" (a code task) |

## M1 — Foundations

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M1-01 | Pure domain into `packages/domain` | done | M0-03 | `merge/M1-01-domain` | #370 | `@quiz/domain` gains `ciScore`, `finalScore`, `repoName` (+`slugify`), `groupRepo`, `reviewDispatch`, `studentIgnore`, `zone` (`SCHOOL_TIME_ZONE`, `zonedIso`); §7.4 names, wire names kept (I16); M1-02 and M4-01 import these, no copies (I17) |
| M1-02 | GitHub adapters, config, image | done | M0-03 | `merge/M1-02-github-adapters` | #372 | Every file of the card ported to `apps/api/src/github/` (none uses classroom's database), `verifySignature` as `signature.ts`; six `GITHUB_*` (no App id = off; production refuses an unreadable key, no slug, a webhook secret < 32); `redactTokens` in `redact.ts`; git + ca-certificates in the image; `githubApp(config) !== null` is the one "GitHub is on" test; `parseStudentIgnore` comes from `@quiz/domain`; the token never goes in a URL, file or argv: `gitRunner({ token })` hands it to git through the env (`GIT_CONFIG_*` extraheader), remotes are `repoUrl(org, repo)`; nothing left for M3 |
| M1-03 | `ActivityKind`, `ActivitySummary` union | done | M0-03 | `merge/M1-03-activity-kind` | #373 | `ActivitySummary` is a union on `kind` (`"evaluation"`, `mode` kept): M1-05 relies on it. `ActivityKind<K>` = `kind` + `listForTeacher` over `KINDS` (`modules/activity/`); M5-01 adds `studentCards`, M5-03 `gradebookEntries`, M3-05 `deadlines`, each through `KINDS`, a classroom id only after the route loaded the classroom (card, "As delivered"). `activity_available` = `{activityKind, activityId, activityTitle}` (migration 0037; I58–I60) |
| M1-04 | Missing primitives, long-form styles | done | M0-05 | `merge/M1-04-primitives` | #374 | From `./ui`: `GithubIcon({className})` (an `IconType`); `OrgAvatar({login, src?, size?: "xs"\|"sm"\|"md", className?})` (`src` a same-origin URL from the API, M2-02; none ⇒ initials; never github.com); `Progress({label, className?})` (indeterminate only; a known count is a `SegmentedBar`); `Initials` takes `text` and `shape`. Journal HTML wears `md-body md-doc` (`MarkdownView className="md-doc"` client-side); DESIGN.md › Long-form reading |
| M1-05 | Web routes and mock skeleton | done | M1-03 | `merge/M1-05-web-routes` | #375 | Routes `studentCourses` (`/courses`), `classroomSettings`, `classroomJournal` (`/classrooms/:id/journal/<path>`: `path` decoded, then `safeJournalPath`, anything refused or an encoded slash lands on the journal home; written with `encodeJournalPath` of `@quiz/contracts`), `classroomGrades`, `project`, `projectGroups`; `classroom` role-dispatched. All render `ComingSoon` and sit behind `CLASSROOM_PAGES` (`router.ts`: on under `VITE_MOCK` or `VITE_CLASSROOM_PAGES=1`, off in production, where they do not parse): the task that ships a screen drops its route's `preview: true` and its `PAGES` placeholder; M5-02 also makes `classroom.studentSafe` true. Bottom bar's Courses slot still the home anchor. Mock: `mock/journal.ts` (`?journal=1`, r1) typed by `@quiz/contracts`, navigation by `@quiz/docrender/journalTree`, CHECKED in `contract.test.ts`; `mock/github.ts` serves `/github/orgs` and `/classrooms/:id/github` on local shapes, TODO(M2-01), `?unlinked=1` declared for the account route M2-01 places; no `mock/project.ts` (M3) |
| M1-06 | Import script skeleton, identity, login adoption | done | D04, D08 | `merge/M1-06-import-identity` | #464 | `apps/api/scripts/import-classroom.ts` (+ `import-classroom/`): people, addresses, claims, avatars, grants, GitHub links (`importAccountLink`), course seats, rosters merged into EXISTING connected Quiz classrooms (no course/classroom created, D22), roles; `import_classroom.id_map`/`runs` (migration `0052`); login adoption ADR-061 (`auth/adoption.ts`). `--apply` waits for open items 3 and 4 (`--missing-students`, `--assistants`); M8-01 extends the same script (card M1-06, "As delivered") |

## M2 — GitHub substrate

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M2-01 | `github` schema and contracts | done | M1-02, D02, M0-04, M0-05 | `merge/M2-01-github-schema` | #402 | Tables `github_organizations`, `github_classroom_links`, `github_accounts`, `webhook_deliveries`, `push_receipts` (migration `0048_github`); contracts `GithubOrg`, `GithubClassroom`, `GithubAccountState` (`GET /app/api/me/github`). What M2-02, M2-03, M2-04, M2-06, M2-07 and M8-01 inherit: card M2-01, "As delivered", and the notes on their own cards |
| M2-02 | Installations, org link, healing | done | M2-01 | `merge/M2-02-github-orgs` | #404 | `modules/github` (routes only when an App is configured); GET/PUT/DELETE `/classrooms/:id/github` (409 `journal_attached` D28, `app_not_installed`), setup return, same-origin avatar (derived, cached); `recordInstallation` is the one writer M2-04 calls (by id, never a takeover by login, I66); fake GitHub in `github/testing.ts`; card M2-02 "As delivered" |
| M2-03 | GitHub account linking | done | M2-01 | `merge/M2-03-github-link` | #403 | `Q:auth/githubLink.ts` (link, callback, `GET`/`DELETE /app/api/me/github`, `linkedLogin` → `GITHUB_ACCOUNT_STALE`; `github_accounts` is `auth`'s), `GithubLinkOutcome`; what M2-07, M3-01 and M3-03 inherit: card M2-03, "As delivered" |
| M2-04 | Webhook intake, registry, deliveries | done | M2-02 | `merge/M2-04-webhooks` | #407 | `POST /webhooks/github` (HMAC 401 → headers/body 400 → delivery + push receipt in one transaction → `github.webhook` → 200); `onEvent(event, handler)` / `onReceipt(tracks)` from `modules/github/service.ts` (M4-02 registers `push`, M3 its receipts); scheduled `reconcile.deliveries`, `deliveries.purge`; card M2-04, "As delivered" |
| M2-05 | Periodic tasks | done | D10 | `merge/M2-05-scheduled-tasks` | #392 | Landed before M1-02 (core only). `scheduled_tasks` (module `system`, migration `0042_scheduled_tasks`); `ScheduledTask {key, defaultIntervalMinutes, run → summary}` in `ticker.ts`, catalog `SCHEDULED_TASKS` in `modules/system/catalog.ts` (keys: the closed `SCHEDULED_TASK_KEYS` of `@quiz/contracts`; a new task adds its key there and its `admin.task.<key>` names en/fr); rows seeded once at boot, the ticker claims every 15 s, the `system.task` queue runs (a finished run publishes `admin`); the ticker starts even if a job registration fails; `live.*` stay `TickTask`s. Admin: `GET/PATCH /app/api/admin/tasks[/:key]`, `POST …/:key/run` (200 inline, 202 queued, 409 `task_running`), audit `task.configure`/`task.run_now`; web: Admin › Scheduled tasks tab. M3-06/M2-04: add `reconcile.*` to the catalog, never a GitHub call in the tick |
| M2-06 | Quiz's Apps (production, staging), staging safety | todo | M2-01, D23 | | | |
| M2-07 | Web: classroom Settings tab, GitHub section, link card | done | M2-02, M2-03, M1-04, M1-05, D24 | `merge/M2-07-classroom-settings` | #408 | `classroomSettings` parses in every build (`ClassroomView routeTab`, `ROUTE_TABS`); rename/archive/delete/drill switch live in `ClassroomSettings.tsx`, the Journal slot (M4-05) is the comment between GitHub and "Archive and delete"; `apps/web/src/github/` (hooks, checks, sheet opened by `?connect=1`, account card, `useGithubLinkReturn`); card M2-07, "As delivered" |
| M2-08 | Student link from Settings, login on the roster | done | M2-03, M2-07 | `student-github-link` | #452 | `linkRelevant` also counts a claimed seat in a connected classroom; `RosterEntry.githubLogin` (connected classrooms only), shown under the e-mail; F-GH-05, N-DATA-02, 05-web amended; card M2-08, "As delivered" |

## M3 — Projects

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M3-01 | `project` schema and contracts | done | M2-01, M1-01, D05 | `merge/M3-01-project-schema` | #468 | Tables in `Q:db/project.ts` (migration `0054_project`), contracts in `packages/contracts/src/project.ts`, `GradeRow` and the activity unions widened, an empty `projectActivity` in `KINDS`, `projectGrade` in `@quiz/domain`; what M3-02…M3-13 inherit: card M3-01, "As delivered". Import steps moved to M8-01 |
| M3-02 | Project lifecycle | done | M3-01, M2-02, D19 | `merge/M3-02-project-lifecycle` | #471 | `Q:modules/project/` (lifecycle, views, sources, routes), migration `0056` (one project per distribution repository), `findAccessibleProject`, `projectActivity.listForTeacher`, `purgeProjectReceipts` (`github`) also called by classroom and course deletion, async git runner, ADR-062; what M3-03…M3-11 inherit: card M3-02, "As delivered". Reopen moved to M3-05; student cards stay empty until M3-09 |
| M3-03 | Acceptance and provisioning | done | M3-02, M2-03 | `merge/M3-03-project-accept` | #472 | `POST /app/api/student/projects/:id/accept` (`Q:modules/project/accept.ts`, loader `studentProject`), provisioning in the request (claim, replay, allow-list of the repository it made — `409 repo_name_taken` —, push only, free-plan ruleset tolerated), `ProjectAcceptance` and `PROJECT_ACCEPT_REFUSALS`, audit `project.accept`/`accept_failed` (`notify` once); individual repositories only; notes moved to M3-05, M3-06, M3-08, M3-09, M3-15: card M3-03, "As delivered" |
| M3-04 | Ingestion and grading pipeline | done | M2-04, M3-03 | `merge/M3-04-project-ingest` | #477 | `Q:modules/project/{webhooks,grading,protection,repos,events}.ts`: receipts tracked, push / `workflow_run` / `member` / `repository` / `organization` handlers, ONE `ingestCompletedRun` for M3-06, restores to the distribution's current version with the cap that suspends (ADR-062 addendum, F-PROJ-08/-10/-11 amended), hint kind `projects` to `user:` + `course:` only, rate limit waited out without a retry; migration `0057_project_ingest`; notes in M3-05…M3-09 and M8-01: card M3-04, "As delivered" |
| M3-05a | Deadline, freeze, reopen, per-repository deadlines | done | M3-04, D13 | `merge/M3-05a-project-deadline` | #481 | M3-05 split (orchestrator, 2026-10-02). `Q:modules/project/{deadline,jobs}.ts`: tick task `project.deadlines` (scheduled publication through `publishProject`, lock, provisional and definitive freeze per repository on its effective deadline, lease claim — no GitHub call), `project.deadline` job (lock / archive H8 / unlock / commit, four at a time, leases, 404 terminal), the reopen and a repository's own deadline (`effectiveDeadlineMoved`), staff lock/unlock with exemption; routes `PUT …/repos/:rid/deadline`, `POST …/repos/:rid/{lock,unlock}`; migration `0059_project_deadline`; ADR-064, D13 addendum, F-PROJ-09/-11 amended; J−n in calendar days (`addZonedDays`); the reminder moved to M3-09: card M3-05a, "As delivered" |
| M3-05b | Final review dispatch, review checkpoints | done | M3-05a | `merge/M3-05b-project-review` | #487 | `Q:modules/project/{review,checkpoints,lease}.ts`: tick step 6 claims `projects.dispatch_job_at` (queue only, no HTTP) → `project.dispatch` job; the final review per repository at its definitive freeze (effective deadline, frozen sha in the ledger; none for `none`, no frozen run, or archived as its lock — audited `project_repo.review_skipped`); checkpoints to every repository not yet at its deadline on the last non-bot receipt, void after an earlier deadline; AT MOST ONCE (an unconfirmed or 5xx ledger row never re-sent, only a 4xx given back); the review slot only for an App-triggered run, not to verify, started after the freeze and the claim; no final review while the protection is suspended; both jobs in one leased frame (`runLeased`); routes `GET|POST|DELETE /app/api/projects/:id/checkpoints[/:cid]`; migration `0060_project_review` (`review_dispatched_at` dropped); ADR-064 addendum, F-PROJ-11 amended; notes in M3-06, M3-08, M3-09, M8-01: card M3-05b, "As delivered" |
| M3-06 | Reconciliation of grades and repos | review | M3-04, M2-05 | `merge/M3-06-reconciliation` | #515 | M3-06a (this PR): `Q:modules/project/reconcile.ts`, scheduled `reconcile.grades` (15 min) and `reconcile.repos` (daily) in the catalog, bounded to the live repositories until 24 h after their freeze unless a final review is pending (`reconciles`, `isQuiet` of `@quiz/domain`), fail-fast on a rate limit (`failFast`), a 404 by id terminal; `completedRun` the one run mapping, `followRepoRename` the one rename path; migration `0070_project_reconcile` (`invitation_reinvited_at`); ADR-011 addendum, I69; **M3-06b** (next PR): the three restored-heads edges and "422 then nothing to restore ⇒ `to_verify`, a `reverts` row, no restore commit": card M3-06, "As delivered" |
| M3-06b | The three restored-heads edges of protected files | in progress | M3-04 | `merge/M3-06b-restored-heads` | | M3-06 split (orchestrator, 2026-10-05). The restored-heads window bounded by the covered head's receipt and read on the restore's branch (`reverts.branch`); a 422 on the move keeps a `reverts` row without its restore (`revert_sha` null) — "422 then nothing to restore ⇒ the head's runs stay `to_verify`, no restore commit, no count" (product owner); `to_verify` follows the set at every reselection; migration `0069_project_reverts_edges` (number provisional); ADR-062 addendum 6: card M3-06, "M3-06b — As delivered" |
| M3-07 | Sync of the source repository | review | M2-04, M3-02, D12 | `merge/M3-07-source-sync` | #517 | `Q:modules/project/sync.ts` (ADR-073, F-PROJ-12 amended): `POST /app/api/projects/:id/sync` (202) takes the `sync_job_at` lease, updates the distribution repository in the request (`409 source_rewritten` for `whole`), records `source_heads` and sends one `project.sync` job — `sync/<branch>` forced to every live repository not locked nor past its effective deadline, the head a bot commit first, ONE pull request per branch (`project_sync_prs`) where a file differs, a comment when the head moved; outcomes per repository, `project.synced` audited, `source_ahead_sha` cleared only when nothing failed; `sourcePush` marks drafts too with the commits counted, `pullRequest` keeps the App's PR state; migration `0072_project_sync` (regenerated after 0071); web: the Sync button, the rows' PR tag, the last sync's counts. **Deployment: the production App must subscribe to `pull_request`.** M8-01: `source_heads` null on imported rows; the migration copies `sync_pr_number` into the default branch's row: card M3-07, "As delivered" |
| M3-08a | Teacher views: project page, runs, live state | done | M3-04, M3-05a | `merge/M3-08a-project-views` | #485 | M3-08 split (orchestrator, 2026-10-02). `GET /app/api/projects/:id` answers `ProjectDetail` (staff only, N-SEC-20: counts, server-derived `primaryAction`, one row per roster student — `repo: null` not accepted — with deadline state + `degraded`, scores current/frozen/review/teacher/final with source and grade by the project's scale, flags), `GET …/repos/:rid/runs` → `GradeRunList`; live state 8 at a time within 1.5 s, never for a deleted repository, never written back; `@quiz/domain` `projectView.ts` (`scoreGrade`, `changedAfterRelease`, `projectPrimaryAction`), `resolveFinalScore` on `review`: card M3-08a, "As delivered" |
| M3-08b | Teacher score, release, invitation resend, protection re-enable | done | M3-08a | `merge/M3-08b-project-release` | #494 | `PATCH …/repos/:rid/score` (`ScoreOverride` → `ProjectRepoScores`; the score written with its maximum, `teacher_max`: the scored run's or its own), `POST …/release` (`ProjectReleaseResult`, every live repository frozen, no final score to verify — `409 to_verify`, F-PROJ-14 amended —, a snapshot per repository, `first` for M3-09), `POST …/repos/:rid/protection` (`protection_reenabled_at`: the cap counts later restores only, the final review due again), `POST …/repos/:rid/invite` (`invitation_resent_at`, once a minute, push); `ProjectRepoView.review` (`ProjectRepoReview`, `reviewState` of `@quiz/domain`) and `scores.teacher.max`; `ProjectUnassigned`; migration `0061_project_staff_writes`; notes in M3-06, M3-09, M5-03: card M3-08b, "As delivered" |
| M3-09a | Student side: the project's student view, the cards, the student's resend | done | M3-04, M3-08b, D18 | `merge/M3-09a-student-project-view` | #504 | M3-09 split (orchestrator, 2026-10-04). `Q:modules/project/studentView.ts`, the ONE exit (N-SEC-20): `GET /app/api/student/projects/:id` (`StudentProject`; loader `studentProjectView`, the classroom's student branch), `POST …/invite` (the staff's `resendInvitation`, shared minute), `studentProjectCards` filling `projectActivity.studentCards`; `StudentProjectCard` widened (`status` + `released`, `invitation`, `githubLinked`, `repoUrl`, effective `deadlineAt`); after the deadline the view shows the SELECTED run's commit and CI state, never the row's head; `project_repos.released_comment` (migration `0063`) snapshots the comment with the score; `StudentHome` is the `StudentActivityCard` union, served by the `activity` module; `hasProjects` dropped; rules in `@quiz/domain/projectStudent.ts`; the web draws a project card minimally (`ActivityCard`, `cards.tsx`); leak test over every student response and bus message, three callers: card M3-09a, "As delivered" |
| M3-09b | Notifications of projects | review | M3-09a, M3-05a, M3-05b, M3-08b | `merge/M3-09b-project-notifications` | #512 | The seven kinds of F-NOTIF-13 (contracts, defaults, audiences, `GITHUB_KINDS` gate in the settings), templates en/fr, `TEAMS_APP_VERSION` 2.2.0, `notifications.project_id` + two project fold targets, `project_repos.reminder_sent_at` and `github_organizations.suspended_at` (migration `0068`), `@quiz/domain/deadlineReminder` (one 24 h constant, re-arm > 24 h; the window rule on `start_at`), `notifyUsers` / `classroomStaffIds` shared, `Q:modules/project/notify.ts` and the sends at publish / Accept / release / deadline job / `projectTick` step 4b / `github` `orgLost` (a suspended installation kept, never lost); heig-classroom's `grade.final` dropped; ADR-030 addendum, F-NOTIF-12 amended: card M3-09b, "As delivered" |
| M3-09c | Real-time notices of projects (F-PROJ-21) | review | M3-09a, M3-12a | `merge/M3-09c-project-notices` | #516 | Client-side, in the browser: `useNoticeToasts` (`Q:apps/web/src/notifications/notices.ts`, the first read after mount is the baseline, a new key a new one, the toast primitive reused and keyed per kind), `project/projectNotices.ts` (acceptances, pushes, scores captured, final reviews asked — one notice per kind with its count) and `student/studentProjectNotices.ts` (invitation accepted, deadline applied, a push, an indicative score — the last two only while the project is open, N-SEC-20); keys `project.notice.*` / `sproj.notice.*`; `?notices=1` mock scene; "files restored" and "sync done" dropped, the deadline and the release stay the bell's (PO, 2026-10-05): card M3-09c, "As delivered" |
| M3-10 | Web: projects in Activities, New ▾ | done | M3-01, M1-05 | `merge/M3-10-web-projects` | #470 | "New ▾" (`activities/NewActivity.tsx`: Evaluation, Project; no Poll — the launcher takes no classroom) with the GitHub gate (absent ⇒ plain "New evaluation", unconnected ⇒ `settings?connect=1`, connected ⇒ route `projectNew`); `projectNew` and `project` stay `preview` (`routeEnabled`): New ▾ turns on when M3-11 drops it, project rows open when M3-12 does; `project/ProjectGroup.tsx` under the evaluations (`GET /classrooms/:id/projects`, drawn only with rows); `/activities` lists the union through `KIND` (`activities/model.ts`, never live); mock `?projects=1`; card M3-10, "As delivered" |
| M3-11 | Web: new project form | done | M3-02, M2-07 | `merge/M3-11-project-form` | #473 | One page at `projectNew` (`project/NewProjectPage.tsx`, `ProjectAdvanced.tsx`, rules in `newProject.ts`), one primary Create, no Publish; novice name + source + deadline, the rest under "Advanced options", the source's suggested protected files sent while folded; refusals placed (field, page state → `settings?connect=1`, form-level retry for `distribution_failed`); contract `ProjectRefusal` (`ProjectUnassigned` moved to M3-12); shared `fieldErrorProps`/`FieldError` (`ui/`), `project/ProtectedFiles.tsx` for M3-12; route `classroomSettings` takes `connect`; `projectNew` stays `preview` until M3-12; mock `mock/projectNew.ts` (`?srcmissing=1`, `?distfail=1`, 2.5 s build); card M3-11, "As delivered" |
| M3-12a | Web: project page (reads, lifecycle, deadline, checkpoints) | done | M3-08a | `merge/M3-12a-project-page` | #495 | M3-12 split (orchestrator, 2026-10-04). `project/ProjectPage.tsx` + `ProjectSettings`, `ProjectRepos`, `RepoSheet`, `ProjectCheckpoints`, rules in `projectPage.ts`; `project` and `projectNew` no longer `preview` — **projects live in production** (New ▾, the form, the page); server-named primary action (Publish a button; Release and Sync said as text until M3-12c / M3-07); PATCH of name, deadline (reopen confirmed), strategy, protected files; archive / delete (typed name, GitHub keeps the repositories); rows with flags, a row's sheet (runs, own deadline, lock); checkpoints add / delete / void; refetch 30 s + 3 s on `liveStale`; `UnassignedBody` local until M3-08b's `ProjectUnassigned`; group mode hidden in the form until M3-16; mock pages, scenes `project*`: card M3-12a, "As delivered" |
| M3-12b | Web: per-repository writes, review state | done | M3-12a, M3-08b | `merge/M3-12bc-project-writes` | #506 | One PR with M3-12c. `project/TeacherScoreForm.tsx` in the sheet (`PATCH …/score`, the max field only without a scored run — `scoredRunMax` —, comment, Clear; refusals worded under the form), Resend (pending only, 429 worded), Re-enable (suspended only, clears the conflict tag, past runs stay to verify); `reviewView` / `reviewTag` (`projectPage.ts`): the final review per status in the table's State column and as a sheet fact with its detail (asked at / of sha, not confirmed red, degraded amber); `ProjectUnassigned` from the contracts; mock routes and a dispatch ledger over #498's `review`; scene `project-grades`: card M3-12b, "As delivered" |
| M3-12c | Web: the release | done | M3-12a, M3-08b | `merge/M3-12bc-project-writes` | #506 | One PR with M3-12b. `primaryAction: "release"` ⇒ the header's primary ("Release scores", or "Release again" once released), confirmed (what a release does; a re-release rewrites the snapshot), `POST …/release`; `project.status.rerelease` sentence; refusals as a danger alert (`releaseRefusal`: `not_frozen` with counts, `to_verify` naming the students, `grading_none`); mock `?unreleased=1`, scenes `project-release`, `project-released`: card M3-12c, "As delivered" |
| M3-13 | Web: student `ProjectRow` and the student's project page | done | M3-09a, M2-07 | `merge/M3-13-student-project-row` | #508 | `student/ProjectRow.tsx` + rules `student/projectRow.ts` (one action by state: Link GitHub, Accept, Open the invitation, Open repository; notes for not started / not accepted / deleted), `student/StudentProjectPage.tsx` (`/projects/:id` serves the student page to a student, a teacher in the student view, an impersonation — read-only readers get no button), the row's title opens the page; the server's clock (`serverNow` sampled) on the home, the classroom page and the project page; `ActivityRow` moved to `student/ActivityRow.tsx`; `wordedRefusal` in `api.ts` shared with the project page; `project` route `studentSafe` + `bottomSlot: "courses"`; `projects` hint → `student` root; `mostUrgent` skips a ready project; `project.repos.noneAccepted` → `project.repos.none`; mock: seven cards, accept/invite routes, `?provisioning=1`, `?refused=1`, `?stale=1`: card M3-13, "As delivered" |
| M3-14 | Pilot and load test on staging | todo | M3-01…13, M2-06 | | | |
| M3-15a | Groups: sets and a project's copy (API, database only) | done | M3-02 | `merge/M3-15a-group-sets` | #507 | ADR-070 (2026-10-04) replaces ADR-048's groups per project by classroom group sets. Migration `0064_group_sets`; `modules/group/` (sets, groups by hand, a student's place, the random formation; `409 classroom_archived` on an archived classroom); a draft's `groupSetId` (create, PATCH), `409 no_group_set` at publish; the copy (`project/groupCopy.ts`) stepped in the set's transaction; `projects.groups_stopped_at` at the deadline applied or the archive, never cleared; `group_max_size` dropped (form included): card M3-15a, "As delivered" |
| M3-15b-1 | Groups: group repositories at Accept, the invited accounts, synchronous revocations | review | M3-15a, M3-03 | `merge/M3-15b1-group-repos` | | M3-15b split (orchestrator, 2026-10-05); product owner P1/P2 in ADR-070's amendment. Migration `0067_project_repo_access` (the invited accounts, recorded before GitHub is asked; individual repositories backfilled); Accept of a group project (`no_group` from the copy, the first member provisions `<slug>-<group slug>`, every linked member invited, a later one joins); `groupRepos.ts` (whose repository, through the copy: rows, student view, hints, resend); invitation on a GitHub link; `revokeEnrollmentAccess` before a roster removal, an unclaim, an e-mail change, a self-enroll (`502 revoke_failed`; skipped and audited when there is nothing to take); `409 has_repo` for a set's write reaching a group with a repository, a rename following with its slug fixed; audit `project_group.repo_invite`/`repo_revoke`: card M3-15b-1, "As delivered" |
| M3-15b-2a | Groups: per-group stop, the `group.sync` job, `needs_confirmation`, *access to revoke* | review | M3-15b-1 | `merge/M3-15b2a-group-sync` | | M3-15b-2 split (orchestrator, 2026-10-05); PO1–PO2 in ADR-070's second amendment. Migration `0069_group_sync` (due mark, third lease, backoff; `project_groups.stopped_at` backfilled; `departing_at`, `revoking_at`); `splitPlan`, `consequenceDelta` (`@quiz/domain`); a move touching a group with a repository confirmed by digest (`409 needs_confirmation`) then applied by `group.sync` (departure after revocation, arrival then invitation, P1 skips, backoff to 1 h); `recordGrant` refuses a departing member; a grant revoked only once GitHub confirmed it (`revoking_at`; a roster write meanwhile `502`); stray grants retried; *access to revoke* on `ProjectRepoView`: card M3-15b-2a, "As delivered" |
| M3-15b-2b | Groups: *Resync with the set* and the drift | todo | M3-15b-2a | | | |
| M3-16a | Groups (web): the Groups tab, a set's page, the project's set | review | M3-15a, M3-12 | `merge/M3-16a-groups-web` | | M3-16 split (orchestrator, 2026-10-05). Routes `classroomGroups` (`/classrooms/:id/groups`, a route tab) and `groupSet` (`/classrooms/:id/groups/:setId`, `?fromProject=<id>`) in every build, staff only; `projectGroups` and `soon.projectGroups` gone. `group/` (`GroupSetList`, `GroupSetPage`, `GroupBoard` on `@dnd-kit` with click then click and a "Move to…" menu, `RandomFormDialog` previewing `groupSizes`, `GroupSetPicker`, one write queue per set); Undo through the toast's new action; keys `groupSetsKey` (hint `groups`, and `roster`/`projects`); the form's group work in every build (M3-15b-1 merged first); `has_repo` and `set_in_use` name their projects (`GroupRefusalProjects`); the project page's set (`ProjectGroupSet`), `no_group_set`, `unassigned_students` linked to the set; mock `groups.ts` (`?groups=1`): card M3-16a, "As delivered" |
| M3-16b | Groups (web): rows per group, drift, Resync, confirmations | todo | M3-15b-2a, M3-16a | | | |
| M3-17 | Groups formed by the students (ADR-070 lot 2) | review | M3-15a, M3-16, M3-09 | `merge/M3-17-student-groups` | | Product owner S1–S4 in ADR-070's third amendment, F-PROJ-22, F-ORG-15, N-SEC-20. No migration. Staff open a set until a date (`GroupSetPatch.openUntil`, `max_size_required`); students create/join/leave/rename through `writeSet` (`set_closed` no grace, `set_frozen` on any repository of a copy, `group_full` under the set's lock; audited `self`); the student view `GET /classrooms/:id/group-sets/student` (open: groups, members' names, unplaced; closed: own group); loader `studentGroupSet` (own portal session, claimed student seat); hints to claimed students' `user:` topics; web: the student Groups tab (`group/StudentGroups.tsx`), the "Form your group until …" row on the home and the classroom page, the staff's opening dialog and banner; mock `?groups=1`: card M3-17, "As delivered" |

## M4 — Journal

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M4-01 | `packages/docrender`, schema, contracts | done | M1-01, D03, D14, D15 | `merge/M4-01-docrender` | #371 | `@quiz/docrender`: `renderPage(md, {classroomId, pagePath, fallbackTitle, pages, assets, oversized?})` → `{title (plain text or null), frontMatter, html, toc, draft, visibleFrom, warnings, assets}` — call it TWICE per page (`pages` = all ⇒ `html_staff`, = student-visible ⇒ `html_student`), store `cleanSource(md)`; `placePage`/`buildNav`/`homePage`/`relativeHref`/`resolveRelative`, `journalRepoName`, `journalAssetUrl`, `assetContentType`, `@quiz/docrender/highlight`. Contracts (read half; the write bodies moved to M4-03, see its card): `Journal{Student,Staff}`, `JournalPage{Student,Staff}`, `JournalViewQuery`, `JournalPageParams`/`JournalAssetParams`, `JOURNAL_ASSETS_PATH`, `safeJournalPath`, `isJournalPagePath`, `hasControlChar`/`CONTROL_CHAR`, `JournalWarning`, `JournalSyncStatus`, `JournalSyncError`, `JournalRepository`. Tables `classroom_journals`, `journal_pages` (`html_staff`, `html_student`, `asset_paths` for J1), `journal_assets`; migration `0038_journal` |
| M4-02 | Read side and ingestion | done | M4-01, M2-02, M2-04 | `merge/M4-02-journal-read` | #414 | `modules/journal` (only with an App): `GET /classrooms/:id/journal`, `pages/*`, `JOURNAL_ASSETS_PATH/*` on `readableClassroom`, student exit `studentView.ts`; ingestion under a per-classroom advisory lock (J2), `requestIngest` for M4-03's Refresh and saves; push/repository handlers; J4 TickTask `journal.visible_from` (`student_rendered_at`, migration 0049); SSE hint `journal`; no audit action; card M4-02, "As delivered" |
| M4-03 | Writes | done | M4-02, M2-03 | `merge/M4-03-journal-writes` | #415 | `modules/journal/writes.ts` + `registerWrites` (create, use, remove, refresh, preview, save, add, delete, upload; staff via `accessibleClassroom`); refusals `JournalErrorCode`; saves GitHub-first on `baseSha`, `version + 1`, re-read awaited; push-only invitations; nine `journal.*` audits; card M4-03, "As delivered" |
| M4-04 | Web: reader | done | M4-02, M1-04, M1-05 | `merge/M4-04-journal-reader` | #378 | `apps/web/src/journal/`: `JournalReader({classroomId, path?, navigate, studentView})` (the page; student UI ⇒ `?view=student`; keys `journalKey(id, view)` ⊃ `journalPageKey(id, view, path)`), `JournalNav`, `JournalToc`, `JournalArticle` (+ `journalLinkTarget`), `words.ts` (`warningText`, `SYNC_ERRORS`, keyed by the contract unions). No staff action yet (sync state only, in `ReaderHeader`'s `aside`): M4-05 adds Refresh there (invalidate `journalKey`), M4-06 adds Edit (primary) and the editor (both cards say so). `isPlainClick` lives in `./ui` (controls, beside `LinkButton`). Route still `preview: true` (no API until M4-02); M5-02 mounts the reader under the student classroom header. SSE `journal` hint ⇒ invalidate `["journal", id]` (M4-02) |
| M4-05 | Web: Journal section of Settings, teacher tab | done | M4-03, M2-07, D24 | `merge/M4-05-journal-settings` | #416 | `journal/JournalSettings.tsx` (the section, in M2-07's slot), `journal/api.ts` (`useStaffJournal`, `useJournalRefresh`, the refusals worded through `JOURNAL_ERRORS`), teacher Journal tab = `ClassroomView routeTab="journal"` mounting `JournalReader`; the route and both tabs are out of `CLASSROOM_PAGES` (Grades and projects stay). **M4-06**: Edit goes in the reader's `StaffBar` (`JournalReader.tsx`), beside Refresh, as its primary; card M4-05, "As delivered" |
| M4-06 | Web: WYSIWYG editor | done | M4-05, D25 | `merge/M4-06-journal-editor` | #417 | Edit (primary of `StaffBar`) swaps the page for `journal/editor/JournalEditor` on the same route; D25 holds WYSIWYG-first: `richTextExtensions({ journal: true })` keeps the author's spelling, `reconcile.ts` writes every unedited block as read, front matter split and rewritten line by line, pictures in `images/` beside the page by relative path, 409 keeps the draft, `useLeaveGuard` in `router.ts`; the real-corpus run needs `JOURNAL_CORPUS_DIR`; card M4-06, "As delivered" |
| M4-07 | API: journal modes, schema, GitHub mode read-only | done | M4-03, D29 | `journal-mode-schema` | #433 | Migration `0050_journal_modes`: `classroom_journals.mode` (no default; existing rows → `github`), repository columns nullable under `classroom_journals_mode_ck`, `journal_pages.version`, `journal_page_revisions` (author_id, front_matter, no revision number: ordered by `created_at`). GitHub mode refuses save/add/delete/upload with 409 `read_only`; staff payload `mode`, staff page `editUrl` (`modules/journal/mode.ts`). **Handoff**: the 501 stubs (`quizWritesPending`, `writes.ts`) must not survive M4-08; `JournalRepository.editable` is now always false and redundant with `mode` — delete it in M4-09 once the web stops reading it; `bumpVersion` kept on purpose for M4-11/M4-12 (a mode switch must call it); `journal_page_revisions.author_id` delete behaviour (now `no action`) to settle in M4-08; Quiz-mode explicit order and parent columns deferred to M4-10 (`parent_path` keeps its meaning, the file's directory) |
| M4-08 | API: the Quiz-mode backend | done | M4-07 | `journal-quiz-backend` | #438 | `modules/journal/quiz.ts` (writes, revisions), `rendering.ts` (ONE rendering shared with the ingestion: `renderAt`, `renderSources`, `storePages`, `renderStudentPages`), `errors.ts` (`JournalError`); every Quiz write = one transaction, row `FOR UPDATE`, the whole journal re-rendered with the new source in place, version bumped, the answered page read in the transaction. Assets append-only and never collected (kept until the journal goes, D29). The journal plugin registers without the App; `use`, `refresh` and the webhooks only with it. Removal guard `journalRemovalRefused` (`service.ts`) shared by `DELETE …/journal` and `DELETE /classrooms/:id`. Audit: the existing `journal.save|add|delete|upload` with `mode: "quiz"`, plus `journal.restore`; `journal.create` carries the mode; `journal.remove` carries `pages`. Revisions survive a page's deletion (D29 point 3); `author_id` stays `no action`. **Handoff for M4-09** (base `/app/api/classrooms/:id/journal`): `POST` `JournalCreate` = `{mode:"quiz"}` \| `{mode:"github", name?}` → 201 `JournalStaff` (new `pageCount`); `DELETE ?confirm=<classroom name>` (`JournalRemoveQuery`, strict) required for a Quiz journal with pages (409 `confirm_required`); **`DELETE /app/api/classrooms/:id?confirm=` too** (`ClassroomDeleteQuery`, same refusal: the classroom deletion dialog must ask for the name when a Quiz journal has pages); `GET pages/*` staff page: `version` instead of `blobSha`; `PUT pages/*` `{markdown, baseVersion}` → `JournalFileWritten` `{path, page}` (`page.version` = the next `baseVersion`; no commit message: drop the editor's "Describe the change"); 409 `conflict` when stale or the page is gone; `POST pages` `{path, title?}` → 201 `JournalFileWritten` (409 `page_exists`); `DELETE pages/*` 204 / 404; `POST assets/*` raw bytes → 201 `{path, page: null}` (409 `asset_exists` for other bytes at a taken path; the same bytes again: a no-op); `GET revisions/*` → `JournalRevisionList` (newest first, metadata only: `{id, path, author, createdAt}`); `GET revision/:revisionId` → `JournalRevisionContent` (the same + `markdown`; 404 unknown); `GET deleted` → `JournalDeletedPage[]` (`{path, title, savedAt}`); `POST restore` `{revisionId}` → `JournalFileWritten` (404 unknown). New codes worded in `words.ts`: `asset_exists`, `confirm_required`; `conflict` reworded mode-neutral. Web touched only to compile (Settings sends `mode:"github"`, editor sends `baseVersion`, mock). Left: the writes freeze during a mode switch (no flag yet: M4-11/M4-12 add it with the switch that sets it) |
| M4-09 | Web: mode choice, standard editor, GitHub mode read-only | done | M4-08, M4-06 | `journal-modes-web` | #441 | Settings: the mode as a `Segmented` (In Quiz default; In a GitHub repository keeps Create/Use, or one "needs the GitHub connection" line), In Quiz only without the App; a Quiz journal shows its pages and is removed by the typed classroom name (`?confirm=`). Reader: `StaffBar` by `mode` (Quiz: Pages menu + Edit; GitHub: Refresh + Edit on GitHub, the page's `editUrl`); `journal/JournalHistory.tsx` = History sheet (revisions, rendered via `POST …/preview` or markdown, restore) and Deleted pages sheet (restore = newest revision). Editor: standard `RichText` + `longForm`, `{markdown, baseVersion}`, no change description. `useConfirm({ typeToConfirm })` is the one typed-name confirmation (journal removal, classroom deletion via `removalNeedsName`). Deleted: `reconcile.ts`, `journalSchema.ts`, `spellWith`, `journal`/`reconcile` options, round-trip test + synthetic journal, `JournalRepository.editable`. Mock: `?journal=1` Quiz mode, `?journalgithub=1` GitHub mode. **Handoff for M4-10**: Rename/reorder/nest go in the Pages menu (`StaffBar`, `JournalReader.tsx`); the history keys hang under `journalKey(id,"staff")`, so any write's invalidation refreshes them |
| M4-10 | Rename, reorder, nest (Quiz mode) | todo | M4-09 | | | |
| M4-11 | Move to GitHub | todo | M4-10, M2-03 | | | |
| M4-12 | Bring back into Quiz | todo | M4-08 | | | |
| M4-13 | Copy a journal from another classroom (later) | todo | M4-08 | | | |

## M5 — Student classroom page and gradebook

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M5-01 | API: the student's classroom | done | M1-03 | `merge/M5-01-student-classroom-api` | #377 | `GET /app/api/student/classrooms` (`StudentClassroom[]`, archived left out) and `GET /app/api/student/classrooms/:id` (`StudentClassroomPage`, always the student payload through the caller's own seat): shapes in `contracts/src/student.ts`. `readableClassroom(app, req, reply, params, { studentView })` in `guards.ts` (rule: `classroomPayload`) |
| M5-02 | Web: student Courses route and classroom page | done | M5-01, D07 | `merge/M5-02-student-classroom-page` | #380 | `studentCourses` (`/courses`, no longer `preview`, no sidebar section) and `classroom` (`studentSafe` in every build) ship; `classroomJournal` stays `preview` until M4-02, and the classroom page's Journal tab shows only under `CLASSROOM_PAGES && hasJournal` (production: Activities alone). `student/StudentClassroom.tsx` (tab = `activities` / `journal`, the reader mounted with `JournalReader`'s new `header` prop), `student/StudentCourses.tsx`, `student/cards.tsx` (the rows, captions, `useCardActions`, `ClassroomList`, shared with the home; its join card was removed by ADR-053). The one accent: `mostUrgent`. Key `studentClassroomKey(id)` under `studentClassroomsKey`. M5-04: add the Grades tab to the same `Tabs`, move the bottom bar's Grades slot off the home anchor; M3-10: a `ProjectRow` in `Activities` and a rank in `mostUrgent`. **Open point settled 2026-10-01 by the product owner** (D07 addendum): the student's desktop sidebar mirrors the bottom bar — Activities, Courses, Drill (conditional), Grades (`/#past`), Profile left to the account menu (`sidebarSlots`, lit by `activeSlot`); branch `student-sidebar-nav`, the `student-home` desktop scenes change. Superseded the same day: Grades is the `/grades` route (row M5-04) |
| M5-03 | Gradebook module | todo | M3-08a, M3-08b, D06 | | | |
| M5-04 | Web: Grades tabs | todo | M5-03 | | | Ahead of it (product owner, 2026-10-01; branch `student-grades`): the student's global Grades page `/grades` (`student/StudentGrades.tsx`; this tab narrows on the server), fed by the reshaped `GET /app/api/student/results` (`StudentGrades`, `live/grades.ts`: the home's Past rule, grades only where F-RES-04 lets them through). The Grades slot (bar and sidebar) leads there; the home's Past section and its `#past` anchor are gone |

## M6 — Online workspace and SEB

In the critical path only if D09 finds online assignments in production.

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M6-01 | HS256, codespace contracts | todo | D09 | | | |
| M6-02 | `packages/seb` | todo | D21 | | | |
| M6-03 | Import `apps/codespace` | todo | M6-01 | | | |
| M6-04 | Codespace CI/CD | todo | M6-03 | | | |
| M6-05 | Engine VM capacity, hygiene, seccomp | todo | D09 | | | |
| M6-06 | Quiz `codespace` module | todo | M6-03, M3-02 | | | |
| M6-07 | SEB for projects, proof B | todo | M6-02, M6-06 | | | |

## M7 — Finishing

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M7-01 | Palette, help, tours | todo | screens | | | |
| M7-02 | User guide | todo | screens | | | |

## M8 — Migration and cutover

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M8-01 | Import script complete | todo | schema tasks, D11 | | | |
| M8-02 | Legacy URL resolver | todo | M8-01, M3-12, M4-04 | | | |
| M8-03 | Caddy fragments | todo | — | | | |
| M8-04 | Codespace identity remap | todo | M6 in scope | | | |
| M8-05 | Cutover runbook | todo | M8-01…04 | | | |
| M8-06 | Rehearsal on staging | todo | M8-05, D22 | | | |
| M8-07 | Cutover | todo | M8-06 go, D20 | | | |

## M9 — Decommission

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M9-01 | Point of no return, decommission, close #143 | todo | M8-07 + observation | | | |

## Rehearsal log

| Date | Dump date | Duration | Parity report | Go / no-go | Notes |
| --- | --- | --- | --- | --- | --- |

## Session log

Newest first. One line per session that changed the state: date, who,
what moved, what the next session must know.

- 2026-10-05 — agent, M3-09c (branch `merge/M3-09c-project-notices`,
  not pushed): the F-PROJ-21 notices, client-side — `useNoticeToasts`
  compares a page's data before and after each re-read and toasts the
  pure diff of `projectNotices` (staff, counted per kind) and
  `studentProjectNotices` (student, `StudentProject` alone). Nothing on
  the first read, nothing unchanged; the deadline and the release are the
  bell's. A page that wants notices of its own data reuses the hook with
  a pure `notices(prev, next)`. Next: the PR, then M3-07's rebase is a
  one-line hook call in `ProjectPage.tsx`.

- 2026-10-04 — agent, M3-09a (branch `merge/M3-09a-student-project-view`,
  not pushed): M3-09 split into 09a/09b/09c (cards rewritten); the
  project's student view, the student cards on the home and the classroom
  page, the student's resend, the leak test. The home `GET
  /app/api/student/home` is the `activity` module's and lists the
  `StudentActivityCard` union: a web page or test that reads a home card
  narrows on `kind` first. `hasProjects` is gone from
  `StudentClassroomPage`. Next: M3-13 draws `ProjectRow` from the cards;
  M3-09b sends the notifications; M3-09c words the F-PROJ-21 notices.

- 2026-10-01 — product owner, conversation, then M0-04 (projects track):
  D05, D06, D11, D12, D13, D17, D18, D19 settled on the suggestion; D20
  (cutover during the semester, target the week of 2026-10-05, teachers
  connect their organizations by hand, students link their accounts),
  D22 (teachers create the classrooms, a validated correspondence table),
  D26 (projects open with the import). Rows of the PRs merged since
  2026-09-30 set to `done`. Spec of projects and gradebook written.

- 2026-10-01 — M2-08: product owner, conversation: a student of a
  connected classroom may link GitHub from Settings now (no nudge, no
  privacy line), and the roster of a connected classroom shows the login.
  F-GH-05 and N-DATA-02 amended.

- 2026-10-01 — M4-08 (#438): the Quiz-mode backend in review — a journal with
  no GitHub, page writes under a version lock, revisions and restore, assets
  sha256 and kept, one rendering shared with the ingestion. Next: M4-09
  (the web); see the row's handoff.

- 2026-10-01 — M4-07 (#433): journal modes in review — schema and
  migration, GitHub mode read-only (409 `read_only`), `mode` and `editUrl`
  in the staff payloads. Next: M4-08 (the Quiz-mode backend); see the
  row's handoff.

- 2026-10-01 — product owner, conversation: the journal in two modes
  (D29, ADR-057), D25 superseded. In Quiz (default, no GitHub, standard
  editor, revisions) or in a GitHub repository (read-only, Edit on
  GitHub). Cards M4-07…M4-13 written; next: M4-07 (schema, GitHub mode
  read-only).

- 2026-10-01 — M4-06 (#417): the journal's editor in review, which closes the
  journal track. The D25 round trip is the identity on the synthetic journal
  and on classroom's production journals (5 pages, `JOURNAL_CORPUS_DIR`,
  fetched outside the repository). Review round 1 applied (external images
  refused, front matter read through docrender).

- 2026-10-01 — M4-05 (#416): the Journal section of Settings, the teacher's
  Journal tab and Refresh in review; the journal UI left `CLASSROOM_PAGES`.
  Next: M4-06 (Edit in the reader's `StaffBar`).

- 2026-10-01 — M4-03 (#415): the journal's writes in review. Next: M4-05
  (Settings section, Refresh in the reader) once M2-07 is in.

- 2026-10-01 — M4-02 (#414): the journal's read side and ingestion in
  review. Next: M4-03 (writes, Refresh through `requestIngest`).

- 2026-09-30 22:20 — classroom-merge session: rows of the tasks merged
  today set to `done` (M0-05, M1-01…05, M2-05, M4-01, M4-04, M5-01, M5-02);
  "Now" rewritten. Next: M2-01.

- 2026-09-30 — M2-05: D10 settled by the product owner; `scheduled_tasks`
  ported ahead of M1-02 (the housekeeping moved onto it, the live tasks
  stay clock-bound). The GitHub reconciliations join its catalog.

- 2026-09-30 — M0-05 (#369): `CLAUDE.md` and `invariant-reviewer` carry
  the merge's rules (invariants 4, 6, 11–12, 14, 15); D16 in ADR prose.
  Next: M1-01…05 and M4-01 in parallel.

- 2026-09-30 — M0-03 (#365): ADR-035 accepted; classroom ADRs imported as
  011, 047, 048, 049; amendments on 006, 007, 010, 012, 016, 027, 029, 030.

- 2026-09-30 — product owner, conversation: the journal goes first and
  live before the cutover. D03 (one journal per classroom = one
  repository), D07 (Courses route to the classroom page), D14, D15 on the
  suggestion, D23 (Quiz's own GitHub App), D24 (classroom Settings tab),
  D25 (WYSIWYG editor, gated by a round trip on real journals), D27 (any
  repository of the organization). Plan
  amended in the same PR.

- 2026-09-28 — planning session, continued: product owner settled D01
  (Project), D02 (per classroom), D04 (widening accepted, risks noted), D16;
  M0-02 measured production read-only (D08 settled, D09 measured).

- 2026-09-28 — planning session: ADR-035 proposed, `docs/merge/` written on
  branch `plan/merge-classroom` from five read-only analyses of both
  repositories (classroom at `ab98cc0`, Quiz at `a7dfa26`). Next: product
  owner review of the plan and of D01, D02, D04, D16; go for M0-02.
