# Merge progress

The single source of truth for where the merge stands. Update it **in the
PR of the task** (claim in the first commit, close in the last), never in a
separate commit on `main`. Protocol: [`README.md`](README.md).

## Now

- **Phase**: the journal (M4) and the projects (M3) are merged, the
  pilot's follow-ups M3-14a…n included except M3-14f and M3-14g, which wait
  for the product owner; M4-10…13 are dropped. The gradebook (M5-03,
  M5-04), M6-01…06, M6-10, M7, M8-01…03 and the cutover runbook (M8-05,
  [`10-cutover-runbook.md`](10-cutover-runbook.md)) are merged; M8-04 is
  dropped. The breadcrumb app-wide is merged (#576). The import runs from
  the production image (#655, the runbook's O6). The projects and the
  import go live together (D26) at the cutover (D20).
- **Next actions**: the rehearsal on staging (M8-06, runbook §7), which is
  also the import's dry run on a production dump (M8-01), then the cutover
  (M8-07) once the runbook's open decisions O1–O5, the owner's, are
  settled. M6-07's code is merged and waits for proof B (a real SEB, the
  owner, on staging); M6-08 and M6-09 are to do. Quiz's production App
  exists (registered by hand); staging's, `heig-quiz-staging`, exists
  since 2026-10-06 (M2-06). Teachers create their Quiz classrooms; the
  merge then writes the correspondence table (D22).
- **Classroom sync point**: `a676c8c` (classroom `origin/main`,
  2026-10-06). A classroom commit after it touching a ported file must be
  forwarded (see strategy §1.2, principle 6). Check with
  `git -C ~/heig-classroom fetch && git -C ~/heig-classroom log --oneline a676c8c..origin/main`.
  Moved from `ab98cc0` with nothing to forward: `f572758` (#48/#50, delete
  an assignment nobody accepted) — Quiz already deletes a project's rows
  in any state and nothing on GitHub (D19, F-PROJ-16); `a676c8c` (#46/#51,
  notification audiences and the per-classroom "Notify me about students"
  preference) — Quiz has no per-student-activity staff notification
  (F-NOTIF-11/13; student-activity notices are client-side on the open
  page, F-PROJ-21) and its `course:` SSE topics go to staff only
  (`modules/realtime/routes.ts`).
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
| M0-01 | Settle blocking decisions | done | — | | | Every merge decision D01–D29 settled between 2026-09-28 and 2026-10-01 (D09 and D21 in #466), with spec 06 nos. 45–49. |
| M0-02 | Measure production (read-only) | done | PO go | `plan/merge-classroom` | #268 | `measures-2026-09-28.md` records production read-only: edu-ID subs differ pairwise, the workspace is unused by real classes, 3 classes merge into existing Quiz classrooms, 0 pending staff. |
| M0-03 | ADRs (035 accepted, imports, amendments) | done | M0-01 | `merge/M0-03-adrs` | #365 | ADR-035 accepted, the classroom ADRs imported as 011, 047, 048 and 049, and the affected Quiz ADRs amended. |
| M0-04 | Spec amendments | done | M0-01 | `merge/M0-04-spec-journal` (journal track), `merge/M0-04-spec-projects` | #367, #461 | The journal track (#367) and the projects track (#461) written into the specification. |
| M0-05 | `CLAUDE.md`, `AGENTS.md`, reviewer prompts | done | M0-03 | `merge/M0-05-claude-md` | #369 | `CLAUDE.md` invariants 4, 6, 11–12, 14 and 15 carry the merge's rules, and `invariant-reviewer` checks them. |

## M1 — Foundations

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M1-01 | Pure domain into `packages/domain` | done | M0-03 | `merge/M1-01-domain` | #370 | `@quiz/domain` gained the classroom's pure rules (`ciScore`, `finalScore`, `repoName`, `groupRepo`, `reviewDispatch`, `studentIgnore`, `zone`), imported rather than copied. |
| M1-02 | GitHub adapters, config, image | done | M0-03 | `merge/M1-02-github-adapters` | #372 | The GitHub App client lives in `apps/api/src/github/`, with token redaction, the `config.ts` refusals and tokens handed to git through the environment only. |
| M1-03 | `ActivityKind`, `ActivitySummary` union | done | M0-03 | `merge/M1-03-activity-kind` | #373 | `ActivitySummary` is a union on `kind`, and `ActivityKind` over `KINDS` (`modules/activity/`) is the point each activity kind fills (migration 0037). |
| M1-04 | Missing primitives, long-form styles | done | M0-05 | `merge/M1-04-primitives` | #374 | The primitives `GithubIcon`, `OrgAvatar`, `Progress` and `Initials` in `./ui`, and the long-form `md-doc` style (DESIGN.md › Long-form reading). |
| M1-05 | Web routes and mock skeleton | done | M1-03 | `merge/M1-05-web-routes` | #375 | The classroom routes and their mocks, placed behind `CLASSROOM_PAGES` until the task that ships each screen. |
| M1-06 | Import script skeleton, identity, login adoption | done | D04, D08 | `merge/M1-06-import-identity` | #464 | `apps/api/scripts/import-classroom.ts` imports people, accounts, GitHub links and rosters into existing Quiz classrooms (migration `0052`, login adoption ADR-061), and M8-01 extends it: card M1-06, "As delivered". |

## M2 — GitHub substrate

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M2-01 | `github` schema and contracts | done | M1-02, D02, M0-04, M0-05 | `merge/M2-01-github-schema` | #402 | The GitHub tables and contracts (migration `0048_github`): card M2-01, "As delivered". |
| M2-02 | Installations, org link, healing | done | M2-01 | `merge/M2-02-github-orgs` | #404 | `modules/github` connects a classroom to an organization (`/classrooms/:id/github`), `recordInstallation` its one writer: card M2-02, "As delivered". |
| M2-03 | GitHub account linking | done | M2-01 | `merge/M2-03-github-link` | #403 | The account link to GitHub (`auth/githubLink.ts`, `/app/api/me/github`): card M2-03, "As delivered". |
| M2-04 | Webhook intake, registry, deliveries | done | M2-02 | `merge/M2-04-webhooks` | #407 | `POST /webhooks/github` verifies the HMAC, records the delivery and dispatches through `onEvent`/`onReceipt`, with a scheduled reconciliation and purge: card M2-04, "As delivered". |
| M2-05 | Periodic tasks | done | D10 | `merge/M2-05-scheduled-tasks` | #392 | `scheduled_tasks` (module `system`, migration `0042`) and Admin › Scheduled tasks; a new periodic task adds its key to `SCHEDULED_TASK_KEYS` and the catalog. |
| M2-06 | Quiz's Apps (production, staging), staging safety | done | M2-01, D23 | `merge/M2-06-github-apps`, `merge/M2-06-close` | #566 | The App's settings in `github/manifest.ts`, `pnpm github:app`, the staging scrub and `new-server.md`; the staging App `heig-quiz-staging` exists since 2026-10-06 and is never installed where production holds real work: card M2-06, "As delivered". |
| M2-07 | Web: classroom Settings tab, GitHub section, link card | done | M2-02, M2-03, M1-04, M1-05, D24 | `merge/M2-07-classroom-settings` | #408 | The classroom Settings page and `apps/web/src/github/` (connection sheet, account card): card M2-07, "As delivered". |
| M2-08 | Student link from Settings, login on the roster | done | M2-03, M2-07 | `student-github-link` | #452 | A claimed student of a connected classroom may link GitHub, and the roster shows the login: card M2-08, "As delivered". |

## M3 — Projects

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M3-01 | `project` schema and contracts | done | M2-01, M1-01, D05 | `merge/M3-01-project-schema` | #468 | The project tables (migration `0054_project`), contracts and `projectGrade`: card M3-01, "As delivered". |
| M3-02 | Project lifecycle | done | M3-01, M2-02, D19 | `merge/M3-02-project-lifecycle` | #471 | `modules/project/` (lifecycle, views, sources, routes; migration `0056`, ADR-062): card M3-02, "As delivered". |
| M3-03 | Acceptance and provisioning | done | M3-02, M2-03 | `merge/M3-03-project-accept` | #472 | The student's Accept provisions an individual repository (`modules/project/accept.ts`): card M3-03, "As delivered". |
| M3-04 | Ingestion and grading pipeline | done | M2-04, M3-03 | `merge/M3-04-project-ingest` | #477 | The project webhooks, run ingestion, protection and restores (migration `0057_project_ingest`): card M3-04, "As delivered". |
| M3-05a | Deadline, freeze, reopen, per-repository deadlines | done | M3-04, D13 | `merge/M3-05a-project-deadline` | #481 | Project deadlines, freezes and locks (`deadline.ts`, `jobs.ts`, migration `0059`, ADR-064): card M3-05a, "As delivered". |
| M3-05b | Final review dispatch, review checkpoints | done | M3-05a | `merge/M3-05b-project-review` | #487 | The final review dispatch and the review checkpoints (`review.ts`, `checkpoints.ts`, migration `0060_project_review`): card M3-05b, "As delivered". |
| M3-06 | Reconciliation of grades and repos | done | M3-04, M2-05 | `merge/M3-06-reconciliation` | #515 | The scheduled reconciliation of grades and repositories (`reconcile.ts`, migration `0070`): card M3-06, "As delivered". |
| M3-06b | The three restored-heads edges of protected files | done | M3-04 | `merge/M3-06b-restored-heads` | #519 | The restored-heads edge cases (migration `0073`, ADR-062 addendum 6): card M3-06, "M3-06b — As delivered". |
| M3-07 | Sync of the source repository | done | M2-04, M3-02, D12 | `merge/M3-07-source-sync` | #517 | The sync of the source repository, one pull request per branch (`sync.ts`, migration `0072`, ADR-073), which needs the production App subscribed to `pull_request`: card M3-07, "As delivered". |
| M3-08a | Teacher views: project page, runs, live state | done | M3-04, M3-05a | `merge/M3-08a-project-views` | #485 | The staff project detail (`GET /app/api/projects/:id`, `ProjectDetail`) and run list: card M3-08a, "As delivered". |
| M3-08b | Teacher score, release, invitation resend, protection re-enable | done | M3-08a | `merge/M3-08b-project-release` | #494 | The staff writes on a project (score override, release, protection re-enabled, invitation resent; migration `0061`): card M3-08b, "As delivered". |
| M3-09a | Student side: the project's student view, the cards, the student's resend | done | M3-04, M3-08b, D18 | `merge/M3-09a-student-project-view` | #504 | The project's student view, through the one exit `modules/project/studentView.ts` (N-SEC-20), and the student activity cards: card M3-09a, "As delivered". |
| M3-09b | Notifications of projects | done | M3-09a, M3-05a, M3-05b, M3-08b | `merge/M3-09b-project-notifications` | #512 | The seven project notification kinds of F-NOTIF-13 (`modules/project/notify.ts`, migration `0068`): card M3-09b, "As delivered". |
| M3-09c | Real-time notices of projects (F-PROJ-21) | done | M3-09a, M3-12a | `merge/M3-09c-project-notices` | #516 | The client-side notices of the project pages (`useNoticeToasts`, F-PROJ-21): card M3-09c, "As delivered". |
| M3-10 | Web: projects in Activities, New ▾ | done | M3-01, M1-05 | `merge/M3-10-web-projects` | #470 | "New ▾" in the classroom (Evaluation, Project) and the projects listed under the evaluations: card M3-10, "As delivered". |
| M3-11 | Web: new project form | done | M3-02, M2-07 | `merge/M3-11-project-form` | #473 | The New project page (`project/NewProjectPage.tsx`): card M3-11, "As delivered". |
| M3-12a | Web: project page (reads, lifecycle, deadline, checkpoints) | done | M3-08a | `merge/M3-12a-project-page` | #495 | The staff project page (`project/ProjectPage.tsx`), which put projects live in production: card M3-12a, "As delivered". |
| M3-12b | Web: per-repository writes, review state | done | M3-12a, M3-08b | `merge/M3-12bc-project-writes` | #506 | The teacher's score form, Resend and Re-enable in a repository's sheet, and the final review's state: card M3-12b, "As delivered". |
| M3-12c | Web: the release | done | M3-12a, M3-08b | `merge/M3-12bc-project-writes` | #506 | Release scores as the project page's primary action: card M3-12c, "As delivered". |
| M3-13 | Web: student `ProjectRow` and the student's project page | done | M3-09a, M2-07 | `merge/M3-13-student-project-row` | #508 | The student's project row and project page (`student/ProjectRow.tsx`, `student/StudentProjectPage.tsx`): card M3-13, "As delivered". |
| M3-14 | Pilot and load test | done | M3-01…13, M2-06 | `merge/M3-14-pilot-findings` | | The product owner walks the pilot in production on the test organization `heig-quiz-classroom` (first walk 2026-10-06), its findings tracked as M3-14a…n, with no separate load test: card M3-14, "Findings as tasks". |
| M3-14a | Pilot: projects table — repository links, time left; a draft shows no provisional date | done | M3-14 | `merge/M3-14a-projects-table` | #561 | Findings 6 and 7, repository links and time left on the projects table: card M3-14. |
| M3-14b | Pilot: the App's install as a same-tab round trip; the Education link of the Free-plan check | done | M3-14 | `merge/M3-14b-github-connect-flow` | #560 | Findings 1 and 2, the App installed in a same-tab round trip, which needs the App's Setup URL `https://<host>/setup/github/installed` with "Redirect on update" ticked: card M3-14. |
| M3-14c | Pilot: a staff seat accepts a project (the teacher's test repository) | done | M3-14, ADR-077 | `merge/M3-14c-staff-test-repo` | #562 | Finding 8, a staff seat accepts an individual project as the teacher's test repository (ADR-077), with follow-ups M3-14g and the M8-01 count: card M3-14. |
| M3-14d | Pilot: the `project_published` notification asks a student without a GitHub link to link it | done | M3-14 | `merge/M3-14d-publish-notice` | #565 | Finding 4, the notification's text alone asks a student with no linked account to link it, no redirect nor banner: card M3-14. |
| M3-14e | Pilot: New project in a sheet like New evaluation's dialog | dropped | — | | | Finding 5, won't do (product owner, 2026-10-06): New project stays a page. DESIGN.md keeps a centered dialog to three fields and a scrolling dialog to reading; the project fixes its source, branches and strategy at Create and builds for seconds; M3-11 decided one page (2026-10-02): card M3-14 |
| M3-14f | Drop the `ANTHROPIC_API_KEY` organization-secret check | todo | the final review moved to Quiz's own LLM | | | Finding 3, NOT NOW (product owner, 2026-10-06): remove the check progressively once Quiz's LLM does the final review: card M3-14 |
| M3-14g | Leaving the course staff ends one's staff seats | todo | M3-14c | | | ADR-077 Q7 (product owner, 2026-10-06: keep as is for now, a follow-up): removing a member from a course's staff (ADR-068) leaves their staff seats in its classrooms, and with M3-14c their test repositories' grants. To decide: remove the seats (and revoke) with the staff seat, or keep them: card M3-14 |
| M3-14h | Pilot: a project's two repositories as links on its row, no menu | done | M3-14a | `merge/M3-14h-pilot-cards` | #567 | Finding 9, the source and distribution repository links on every list of projects: card M3-14. |
| M3-14i | Pilot: the student's project card says the state of their work | done | M3-14 | `merge/M3-14h-pilot-cards` | #567 | Finding 10, the student's card shows the short sha, date, commit count, CI status and indicative score (F-PROJ-04 amended, migration 0077): card M3-14. |
| M3-14j | Pilot: the staff page with only the teacher's test repository | done | M3-14c | `merge/M3-14h-pilot-cards` | #567 | Findings 11 and 12 were not bugs, and a regression test was added: card M3-14. |
| M3-14k | Pilot: the protection ruleset applied later (a plan moved from Free to Team) | done | M3-14 | `merge/M3-14k-protection-retry` | #571 | Finding 17, the daily `reconcile.repos` applies a missing protection ruleset before the effective deadline: card M3-14. |
| M3-14l | Pilot: the student's activity card and project page redesigned | done | M3-14i | `merge/M3-14l-student-card-page` | #573 | Findings 13 and 14, the student's card and project page redesigned with `MetaItem`, `MetaLine`, `IconTip` and `Breadcrumb` in `ui/`, the app-wide breadcrumb (finding 15) following in #576: card M3-14. |
| M3-14m | Pilot: the staff page counts the student's commits | done | M3-14i | `merge/M3-14m-staff-commit-count` | #570 | The staff row counts the student's commits through `project/commits.ts`, GitHub's total only in the tooltip. |
| M3-14n | Pilot: a negative CI score counts 0, flagged to the staff | done | M3-14 | `merge/M3-14n-negative-score` | #572 | Finding 18, a negative CI score counts 0 and is flagged to the staff (migration 0078, F-PROJ-10 amended): card M3-14. |
| M3-15a | Groups: sets and a project's copy (API, database only) | done | M3-02 | `merge/M3-15a-group-sets` | #507 | Classroom group sets replace groups per project (ADR-070, migration `0064_group_sets`, `modules/group/`): card M3-15a, "As delivered". |
| M3-15b-1 | Groups: group repositories at Accept, the invited accounts, synchronous revocations | done | M3-15a, M3-03 | `merge/M3-15b1-group-repos` | #510 | A group project's Accept provisions one repository per group and invites its members, with access revoked on roster changes (migration `0067`): card M3-15b-1, "As delivered". |
| M3-15b-2a | Groups: per-group stop, the `group.sync` job, `needs_confirmation`, *access to revoke* | done | M3-15b-1 | `merge/M3-15b2a-group-sync` | #513 | A group move that touches a repository is confirmed, then applied by the `group.sync` job (migration `0069_group_sync`): card M3-15b-2a, "As delivered". |
| M3-15b-2b | Groups: *Resync with the set* and the drift | done | M3-15b-2a | `merge/M3-15b2b-group-resync` | #521 | A project's groups resync (`POST /app/api/projects/:id/groups/resync`, migration `0074`): card M3-15b-2b, "As delivered". |
| M3-16a | Groups (web): the Groups tab, a set's page, the project's set | done | M3-15a, M3-12 | `merge/M3-16a-groups-web` | #511 | The staff Groups tab and group set page (`group/`): card M3-16a, "As delivered". |
| M3-16b | Groups (web): rows per group, drift, Resync, confirmations | done | M3-15b-2b, M3-16a, M3-17 | `merge/M3-16b-groups-web` | #524 | The consequences dialog of a group move and the project page's rows per group: card M3-16b, "As delivered". |
| M3-17 | Groups formed by the students (ADR-070 lot 2) | done | M3-15a, M3-16, M3-09 | `merge/M3-17-student-groups` | #518 | Students form their own groups while the staff keep a set open (F-PROJ-22): card M3-17, "As delivered". |

## M4 — Journal

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M4-01 | `packages/docrender`, schema, contracts | done | M1-01, D03, D14, D15 | `merge/M4-01-docrender` | #371 | `@quiz/docrender` (`renderPage`, navigation) and the journal tables and read contracts (migration `0038_journal`). |
| M4-02 | Read side and ingestion | done | M4-01, M2-02, M2-04 | `merge/M4-02-journal-read` | #414 | `modules/journal`: the read routes on `readableClassroom`, the student exit `studentView.ts` and the ingestion: card M4-02, "As delivered". |
| M4-03 | Writes | done | M4-02, M2-03 | `merge/M4-03-journal-writes` | #415 | The journal's writes (`modules/journal/writes.ts`) and their nine `journal.*` audits: card M4-03, "As delivered". |
| M4-04 | Web: reader | done | M4-02, M1-04, M1-05 | `merge/M4-04-journal-reader` | #378 | The journal reader (`apps/web/src/journal/`, `JournalReader`). |
| M4-05 | Web: Journal section of Settings, teacher tab | done | M4-03, M2-07, D24 | `merge/M4-05-journal-settings` | #416 | The journal section of the classroom Settings and the teacher's Journal tab: card M4-05, "As delivered". |
| M4-06 | Web: WYSIWYG editor | done | M4-05, D25 | `merge/M4-06-journal-editor` | #417 | The journal editor, opened by Edit in the reader: card M4-06, "As delivered". |
| M4-07 | API: journal modes, schema, GitHub mode read-only | done | M4-03, D29 | `journal-mode-schema` | #433 | The journal's two modes, in Quiz or in a GitHub repository (migration `0050_journal_modes`, ADR-057). |
| M4-08 | API: the Quiz-mode backend | done | M4-07 | `journal-quiz-backend` | #438 | The Quiz-mode journal backend: writes, revisions, restore and append-only assets (`modules/journal/quiz.ts`, `rendering.ts`). |
| M4-09 | Web: mode choice, standard editor, GitHub mode read-only | done | M4-08, M4-06 | `journal-modes-web` | #441 | The Quiz-mode journal on the web: the mode in Settings, the History and Deleted pages sheets, the standard editor. |
| M4-10 | Rename, reorder, nest (Quiz mode) | dropped | M4-09 | | | Not built (product owner, 2026-10-08): the journal as shipped by M4-07…09 is enough; implement on demand |
| M4-11 | Move to GitHub | dropped | M4-10, M2-03 | | | Not built (product owner, 2026-10-08): the journal as shipped by M4-07…09 is enough; implement on demand |
| M4-12 | Bring back into Quiz | dropped | M4-08 | | | Not built (product owner, 2026-10-08): the journal as shipped by M4-07…09 is enough; implement on demand |
| M4-13 | Copy a journal from another classroom (later) | dropped | M4-08 | | | Not built (product owner, 2026-10-08): the journal as shipped by M4-07…09 is enough; implement on demand |

## M5 — Student classroom page and gradebook

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M5-01 | API: the student's classroom | done | M1-03 | `merge/M5-01-student-classroom-api` | #377 | The student classroom API and `readableClassroom` in `guards.ts` (rule `classroomPayload`). |
| M5-02 | Web: student Courses route and classroom page | done | M5-01, D07 | `merge/M5-02-student-classroom-page` | #380 | The student's Courses route and classroom page (`student/StudentClassroom.tsx`, `student/StudentCourses.tsx`). |
| M5-03 | Gradebook module (split: M5-03a domain + API, M5-03b CSV export) | done | M3-08a, M3-08b, D06 | `merge/M5-03a-gradebook` (M5-03a), `merge/M5-04-grades-web` (M5-03b) | #531 (M5-03a), #537 (M5-03b) | The gradebook (migration `0075_gradebook`, ADR-074) and its CSV export: card M5-03, "As delivered". |
| M5-04 | Web: Grades tabs | done | M5-03 | `merge/M5-04-grades-web` | #537 | The classroom's Grades tab for both roles and the student's global `/grades` page: card M5-04, "As delivered". |

## M6 — Online workspace and SEB

In the critical path only if D09 finds online assignments in production.

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M6-01 | HS256, codespace contracts | done | D09 | `merge/M6-01-codespace-contracts` | #527 | HS256 signing in `packages/domain` and the codespace contracts: card M6-01, "As delivered". |
| M6-02 | `packages/seb` | done | D21 | `merge/M6-02-packages-seb` | #580 | `@quiz/seb` holds the SEB configuration rules, and Quiz's SEB launch moved onto it: card M6-02, "As delivered". |
| M6-03 | Import `apps/codespace` | done | M6-01 | `merge/M6-03-import-codespace` | #582 | `apps/codespace` imported as `@quiz/codespace` from classroom `a676c8c`: card M6-03, "As delivered". |
| M6-04 | Codespace CI/CD | done | M6-03 | `merge/M6-04-codespace-deploy` | #587 | The codespace CI/CD (an image per sha, `prod` and `staging` instances on the engine VM), the VM switch applied on 2026-10-07 with DNS code-dev, the staging key, Quiz's env and the first deploys then pending: card M6-04, "As delivered". |
| M6-05 | Engine VM capacity, hygiene, seccomp | done | D09 | `merge/M6-05-seccomp`, `merge/M6-05-slices-backup`, `merge/M6-05-host-nft` | #602 (part 1), #606 (part 2), #613 (part 3) | Seccomp (#602), slices and backup A (#606) and the host nftables (#613), rolled out and accepted on 2026-10-09: card M6-05. |
| M6-06 | Quiz `codespace` module | done | M6-03, M3-02 | `merge/M6-06-codespace-module` | #585 | `modules/codespace` (work mode, grants, sync, start route; migration `0079`): card M6-06, "As delivered". |
| M6-07 | SEB for projects, proof B | in progress | M6-02, M6-06 | `merge/M6-07-seb-projects` | #590 | Code merged; proof B (a real SEB, the owner, on staging) pending. Migrations `0080_seb_projects` (`sessions`/`launch_tickets.project_id`) and the portal's `0002_platform_seb`; Quiz builds every `.seb` (`GET /app/api/projects/:id/seb`, portal host + `SEB_EXTRA_ALLOWED_HOSTS`), a `seb` session confined to one activity (`activities` route config, `PROJECT_SEB`, sweep in `seb.db.test.ts`), launch token with `seb.configKey`, portal `/launch` checks it, BEKs optional on the portal, none sent by Quiz until proof B step 7, `online_seb` synced; portal `seb/` on `@quiz/seb`; **proof B pending** (06 §6.3, the owner): card M6-07, "As delivered" |
| M6-08 | Freeze and collect contract on the portal (ADR-075) | todo | M6-03, M6-05 | | | |
| M6-09 | `qt-workspace` type and Quiz side (ADR-075) | todo | M6-06, M6-08 | | | Kiosk use waits for proof B (M6-07) |
| M6-10 | Git relay through Quiz-issued scoped tokens (ADR-078) | done | M6-04, M6-06 | `merge/M6-10-git-relay` | #594 | The codespace git relay through installation tokens issued by Quiz (migration `0082`, invariant 15 amended), its staging checks pending: card M6-10, "As delivered". |

## M7 — Finishing

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M7-01 | Palette, help, tours | done | screens | `merge/M7-c-palette-tours` | #534 | Palette entries and tours for projects, nudges and group or journal tours deferred. |
| M7-02 | User guide | done | screens | `merge/M7-a-teacher-guide`, `merge/M7-b-student-guide` | #530, #528 | The teacher (#530) and student (#528) guides for GitHub, projects, groups and the journal. |

## M8 — Migration and cutover

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M8-01 | Import script complete | done | schema tasks, D11 | `merge/M8-01a-import-frame` (a of a, b, c, d); `merge/M8-01d-import-journals`; `merge/M8-01b-import-projects` | #535 (a), #538 (d), #539 (b), #550 (c) | The classroom import (frame, journals, projects, groups), whose dry run on a production dump is M8-06's rehearsal: card M8-01, "As delivered (a)" to "(d)". |
| M8-02 | Legacy URL resolver | done | M8-01, M3-12, M4-04 | `merge/M8-02-legacy-urls` | #547 | `GET /legacy/classroom/*` resolves the classroom's old URLs: card M8-02, "As delivered". |
| M8-03 | Caddy fragments | done | — | `merge/M8-03-caddy-fragments` | #598 | `infra/caddy/` maintenance and redirect fragments with their curl matrix: card M8-03, "As delivered". |
| M8-04 | Codespace identity remap | dropped | M6 in scope | | | Product owner, 2026-10-09: classroom's portal never served a real class, and it has been stopped and disabled since M6-04 (SQLite and volumes archived in `/root/classroom-codespace` on the engine VM); Quiz's portal started empty. Nothing to remap; runbook step C4 |
| M8-05 | Cutover runbook | done | M8-01…03 | `merge/M8-05-cutover-runbook` | #653 | [`10-cutover-runbook.md`](10-cutover-runbook.md) replaces 06 §6.5 B–E and §6.7, and its finding O6 (the production image could not run the import) was fixed by #655: card M8-05, "As delivered". |
| M8-06 | Rehearsal on staging | todo | M8-05, D22, #655 deployed | | | Runbook §7 |
| M8-07 | Cutover | todo | M8-06 go, D20, runbook O1–O5 | | | Runbook §2 |

## M9 — Decommission

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M9-01 | Point of no return, decommission, close #143 | todo | M8-07 + observation | | | |

## Rehearsal log

| Date | Dump date | Duration | Parity report | Go / no-go | Notes |
| --- | --- | --- | --- | --- | --- |
