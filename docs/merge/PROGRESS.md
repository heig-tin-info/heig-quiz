# Merge progress

The single source of truth for where the merge stands. Update it **in the
PR of the task** (claim in the first commit, close in the last), never in a
separate commit on `main`. Protocol: [`README.md`](README.md).

## Now

- **Phase**: the journal track (`01-strategy.md` §1.3, "The journal first").
- **Next actions**: the paper (M0-03…05), the foundations (M1-01…05), the
  renderer and reader (M4-01, M4-04), the student classroom page (M5-01,
  M5-02) and the scheduled tasks (M2-05, D10) are merged. **Next: M2-01**,
  then M2-02 and M2-03 in parallel, M2-04, M2-07, then M4-02, M4-03, M4-05,
  M4-06; the Journal route and tab leave `CLASSROOM_PAGES` when M4-02 and
  M4-05 are in. M2-06 needs the product owner to register Quiz's two
  GitHub Apps before anything is tried on staging. Open for the product
  owner: the student sidebar's Courses entry (F-ORG-14, M5-02 handoff), D09
  (not on this track).
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
| PLAN | Merge plan: ADR-035 (proposed), `docs/merge/` | review | `plan/merge-classroom` | #268 | Five read-only analyses (data, GitHub, journal+web, codespace+infra, spec fit) condensed into these files |

## M0 — Decisions and paper

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M0-01 | Settle blocking decisions | in progress | — | | | D01, D02, D04, D08, D16 settled 2026-09-28; D03, D07, D14, D15, D23–D25, D27 settled 2026-09-30; D09 awaits confirmation |
| M0-02 | Measure production (read-only) | done | PO go | `plan/merge-classroom` | #268 | `measures-2026-09-28.md`: pairwise edu-ID subs (login adoption needed), workspace unused by real classes, 3 classes to merge into existing Quiz classrooms, 0 pending staff; App permissions not checked |
| M0-03 | ADRs (035 accepted, imports, amendments) | done | M0-01 | `merge/M0-03-adrs` | #365 | ADR-035 Accepted; classroom ADR-011 ⇒ 011, 013 ⇒ 047, 014 ⇒ 048, 015 ⇒ 049 (journal, addendum for D03 and J1–J7); 029 superseded; 006/007/010/012/016/027/030 amended, the D05/D06/D18/D21 parts left open; M0-05 must drop "ADR-007 not applicable" from `CLAUDE.md` |
| M0-04 | Spec amendments | in progress | M0-01 | `merge/M0-04-spec-journal` (journal track) | #367 | Journal track done in #367: F-ORG-13..15, F-GH-01..05, F-JRN-01..12, N-RES-07, N-SEC-12..18, 05 §5.3/§5.7/§5.11, 06 nos. 30–33, 07 frozen, D16 in spec prose; D28 opened then settled (a) 2026-09-30. **Remains**: projects (F-PROJ, D01 onwards), gradebook (F-GBOOK), workspace, unified SEB, the other §7.4 words, 00 GitHub Classroom column, 08 novice path for projects, N-DATA for project repos (D19); the ADR prose of D16 was aligned by M0-05 (#369) |
| M0-05 | `CLAUDE.md`, `AGENTS.md`, reviewer prompts | done | M0-03 | `merge/M0-05-claude-md` | #369 | `CLAUDE.md` invariants 4 (journal student view), 6 (`readableClassroom`, created by M4-02), 11–12 scoped to `apps/runner`, 14 (project source at the frozen sha), new 15 (GitHub App and secrets); `invariant-reviewer` checks them; `AGENTS.md` unchanged; D16 in ADR prose done, the `en`/`fr` strings `eval.resetAttempt.message` and `eval.logVisibility.desc` still say "journal" (a code task) |

## M1 — Foundations

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M1-01 | Pure domain into `packages/domain` | done | M0-03 | `merge/M1-01-domain` | #370 | `@quiz/domain` gains `ciScore`, `finalScore`, `repoName` (+`slugify`), `groupRepo`, `reviewDispatch`, `studentIgnore`, `zone` (`SCHOOL_TIME_ZONE`, `zonedIso`); §7.4 names, wire names kept (I16); M1-02 and M4-01 import these, no copies (I17) |
| M1-02 | GitHub adapters, config, image | done | M0-03 | `merge/M1-02-github-adapters` | #372 | Every file of the card ported to `apps/api/src/github/` (none uses classroom's database), `verifySignature` as `signature.ts`; six `GITHUB_*` (no App id = off; production refuses an unreadable key, no slug, a webhook secret < 32); `redactTokens` in `redact.ts`; git + ca-certificates in the image; `githubApp(config) !== null` is the one "GitHub is on" test; `parseStudentIgnore` comes from `@quiz/domain`; the token never goes in a URL, file or argv: `gitRunner({ token })` hands it to git through the env (`GIT_CONFIG_*` extraheader), remotes are `repoUrl(org, repo)`; nothing left for M3 |
| M1-03 | `ActivityKind`, `ActivitySummary` union | done | M0-03 | `merge/M1-03-activity-kind` | #373 | `ActivitySummary` is a union on `kind` (`"evaluation"`, `mode` kept): M1-05 relies on it. `ActivityKind<K>` = `kind` + `listForTeacher` over `KINDS` (`modules/activity/`); M5-01 adds `studentCards`, M5-03 `gradebookEntries`, M3-05 `deadlines`, each through `KINDS`, a classroom id only after the route loaded the classroom (card, "As delivered"). `activity_available` = `{activityKind, activityId, activityTitle}` (migration 0037; I58–I60) |
| M1-04 | Missing primitives, long-form styles | done | M0-05 | `merge/M1-04-primitives` | #374 | From `./ui`: `GithubIcon({className})` (an `IconType`); `OrgAvatar({login, src?, size?: "xs"\|"sm"\|"md", className?})` (`src` a same-origin URL from the API, M2-02; none ⇒ initials; never github.com); `Progress({label, className?})` (indeterminate only; a known count is a `SegmentedBar`); `Initials` takes `text` and `shape`. Journal HTML wears `md-body md-doc` (`MarkdownView className="md-doc"` client-side); DESIGN.md › Long-form reading |
| M1-05 | Web routes and mock skeleton | done | M1-03 | `merge/M1-05-web-routes` | #375 | Routes `studentCourses` (`/courses`), `classroomSettings`, `classroomJournal` (`/classrooms/:id/journal/<path>`: `path` decoded, then `safeJournalPath`, anything refused or an encoded slash lands on the journal home; written with `encodeJournalPath` of `@quiz/contracts`), `classroomGrades`, `project`, `projectGroups`; `classroom` role-dispatched. All render `ComingSoon` and sit behind `CLASSROOM_PAGES` (`router.ts`: on under `VITE_MOCK` or `VITE_CLASSROOM_PAGES=1`, off in production, where they do not parse): the task that ships a screen drops its route's `preview: true` and its `PAGES` placeholder; M5-02 also makes `classroom.studentSafe` true. Bottom bar's Courses slot still the home anchor. Mock: `mock/journal.ts` (`?journal=1`, r1) typed by `@quiz/contracts`, navigation by `@quiz/docrender/journalTree`, CHECKED in `contract.test.ts`; `mock/github.ts` serves `/github/orgs` and `/classrooms/:id/github` on local shapes, TODO(M2-01), `?unlinked=1` declared for the account route M2-01 places; no `mock/project.ts` (M3) |
| M1-06 | Import script skeleton, identity, login adoption | todo | D04, D08 | | | |

## M2 — GitHub substrate

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M2-01 | `github` schema and contracts | review | M1-02, D02, M0-04, M0-05 | `merge/M2-01-github-schema` | #402 | Tables `github_organizations`, `github_classroom_links`, `github_accounts`, `webhook_deliveries`, `push_receipts` (migration `0048_github`); contracts `GithubOrg`, `GithubClassroom`, `GithubAccountState` (`GET /app/api/me/github`). What M2-02, M2-03, M2-04, M2-06, M2-07 and M8-01 inherit: card M2-01, "As delivered", and the notes on their own cards |
| M2-02 | Installations, org link, healing | review | M2-01 | `merge/M2-02-github-orgs` | #404 | `modules/github` (routes only when an App is configured); GET/PUT/DELETE `/classrooms/:id/github` (409 `journal_attached` D28, `app_not_installed`), setup return, same-origin avatar (derived, cached); `recordInstallation` is the one writer M2-04 calls (by id, never a takeover by login, I66); fake GitHub in `github/testing.ts`; card M2-02 "As delivered" |
| M2-03 | GitHub account linking | review | M2-01 | `merge/M2-03-github-link` | #403 | `Q:auth/githubLink.ts` (link, callback, `GET`/`DELETE /app/api/me/github`, `linkedLogin` → `GITHUB_ACCOUNT_STALE`; `github_accounts` is `auth`'s), `GithubLinkOutcome`; what M2-07, M3-01 and M3-03 inherit: card M2-03, "As delivered" |
| M2-04 | Webhook intake, registry, deliveries | review | M2-02 | `merge/M2-04-webhooks` | #407 | `POST /webhooks/github` (HMAC 401 → headers/body 400 → delivery + push receipt in one transaction → `github.webhook` → 200); `onEvent(event, handler)` / `onReceipt(tracks)` from `modules/github/service.ts` (M4-02 registers `push`, M3 its receipts); scheduled `reconcile.deliveries`, `deliveries.purge`; card M2-04, "As delivered" |
| M2-05 | Periodic tasks | done | D10 | `merge/M2-05-scheduled-tasks` | #392 | Landed before M1-02 (core only). `scheduled_tasks` (module `system`, migration `0042_scheduled_tasks`); `ScheduledTask {key, defaultIntervalMinutes, run → summary}` in `ticker.ts`, catalog `SCHEDULED_TASKS` in `modules/system/catalog.ts` (keys: the closed `SCHEDULED_TASK_KEYS` of `@quiz/contracts`; a new task adds its key there and its `admin.task.<key>` names en/fr); rows seeded once at boot, the ticker claims every 15 s, the `system.task` queue runs (a finished run publishes `admin`); the ticker starts even if a job registration fails; `live.*` stay `TickTask`s. Admin: `GET/PATCH /app/api/admin/tasks[/:key]`, `POST …/:key/run` (200 inline, 202 queued, 409 `task_running`), audit `task.configure`/`task.run_now`; web: Admin › Scheduled tasks tab. M3-06/M2-04: add `reconcile.*` to the catalog, never a GitHub call in the tick |
| M2-06 | Quiz's Apps (production, staging), staging safety | todo | M2-01, D23 | | | |
| M2-07 | Web: classroom Settings tab, GitHub section, link card | review | M2-02, M2-03, M1-04, M1-05, D24 | `merge/M2-07-classroom-settings` | #408 | `classroomSettings` parses in every build (`ClassroomView routeTab`, `ROUTE_TABS`); rename/archive/delete/drill switch live in `ClassroomSettings.tsx`, the Journal slot (M4-05) is the comment between GitHub and "Archive and delete"; `apps/web/src/github/` (hooks, checks, sheet opened by `?connect=1`, account card, `useGithubLinkReturn`); card M2-07, "As delivered" |

## M3 — Projects

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M3-01 | `project` schema and contracts | todo | M2-01, M1-01, D05 | | | |
| M3-02 | Project lifecycle | todo | M3-01, M2-02, D19 | | | |
| M3-03 | Acceptance and provisioning | todo | M3-02, M2-03 | | | |
| M3-04 | Ingestion and grading pipeline | todo | M2-04, M3-03 | | | |
| M3-05 | Deadline, freeze, dispatch, checkpoints | todo | M3-04, D13 | | | |
| M3-06 | Reconciliation of grades and repos | todo | M3-04, M2-05 | | | |
| M3-07 | Sync of the source repository | todo | M2-04, M3-02, D12 | | | |
| M3-08 | Teacher views, grades, release | todo | M3-04, M3-05 | | | |
| M3-09 | Student side, SSE, notifications | todo | M3-04, D18 | | | |
| M3-10 | Web: projects in Activities, New ▾ | todo | M3-01, M1-05 | | | |
| M3-11 | Web: new project form | todo | M3-02, M2-07 | | | |
| M3-12 | Web: project page | todo | M3-08 | | | |
| M3-13 | Web: student `ProjectRow` | todo | M3-09, M2-07 | | | |
| M3-14 | Pilot and load test on staging | todo | M3-01…13, M2-06 | | | |
| M3-15 | Groups (API) | todo | M3-03 | | | |
| M3-16 | Groups (web) | todo | M3-15, M3-12 | | | |

## M4 — Journal

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M4-01 | `packages/docrender`, schema, contracts | done | M1-01, D03, D14, D15 | `merge/M4-01-docrender` | #371 | `@quiz/docrender`: `renderPage(md, {classroomId, pagePath, fallbackTitle, pages, assets, oversized?})` → `{title (plain text or null), frontMatter, html, toc, draft, visibleFrom, warnings, assets}` — call it TWICE per page (`pages` = all ⇒ `html_staff`, = student-visible ⇒ `html_student`), store `cleanSource(md)`; `placePage`/`buildNav`/`homePage`/`relativeHref`/`resolveRelative`, `journalRepoName`, `journalAssetUrl`, `assetContentType`, `@quiz/docrender/highlight`. Contracts (read half; the write bodies moved to M4-03, see its card): `Journal{Student,Staff}`, `JournalPage{Student,Staff}`, `JournalViewQuery`, `JournalPageParams`/`JournalAssetParams`, `JOURNAL_ASSETS_PATH`, `safeJournalPath`, `isJournalPagePath`, `hasControlChar`/`CONTROL_CHAR`, `JournalWarning`, `JournalSyncStatus`, `JournalSyncError`, `JournalRepository`. Tables `classroom_journals`, `journal_pages` (`html_staff`, `html_student`, `asset_paths` for J1), `journal_assets`; migration `0038_journal` |
| M4-02 | Read side and ingestion | review | M4-01, M2-02, M2-04 | `merge/M4-02-journal-read` | #414 | `modules/journal` (only with an App): `GET /classrooms/:id/journal`, `pages/*`, `JOURNAL_ASSETS_PATH/*` on `readableClassroom`, student exit `studentView.ts`; ingestion under a per-classroom advisory lock (J2), `requestIngest` for M4-03's Refresh and saves; push/repository handlers; J4 TickTask `journal.visible_from` (`student_rendered_at`, migration 0049); SSE hint `journal`; no audit action; card M4-02, "As delivered" |
| M4-03 | Writes | review | M4-02, M2-03 | `merge/M4-03-journal-writes` | #415 | `modules/journal/writes.ts` + `registerWrites` (create, use, remove, refresh, preview, save, add, delete, upload; staff via `accessibleClassroom`); refusals `JournalErrorCode`; saves GitHub-first on `baseSha`, `version + 1`, re-read awaited; push-only invitations; nine `journal.*` audits; card M4-03, "As delivered" |
| M4-04 | Web: reader | done | M4-02, M1-04, M1-05 | `merge/M4-04-journal-reader` | #378 | `apps/web/src/journal/`: `JournalReader({classroomId, path?, navigate, studentView})` (the page; student UI ⇒ `?view=student`; keys `journalKey(id, view)` ⊃ `journalPageKey(id, view, path)`), `JournalNav`, `JournalToc`, `JournalArticle` (+ `journalLinkTarget`), `words.ts` (`warningText`, `SYNC_ERRORS`, keyed by the contract unions). No staff action yet (sync state only, in `ReaderHeader`'s `aside`): M4-05 adds Refresh there (invalidate `journalKey`), M4-06 adds Edit (primary) and the editor (both cards say so). `isPlainClick` lives in `./ui` (controls, beside `LinkButton`). Route still `preview: true` (no API until M4-02); M5-02 mounts the reader under the student classroom header. SSE `journal` hint ⇒ invalidate `["journal", id]` (M4-02) |
| M4-05 | Web: Journal section of Settings, teacher tab | todo | M4-03, M2-07, D24 | | | |
| M4-06 | Web: WYSIWYG editor | todo | M4-05, D25 | | | |

## M5 — Student classroom page and gradebook

| ID | Task | Status | Depends | Branch | PR | Handoff |
| --- | --- | --- | --- | --- | --- | --- |
| M5-01 | API: the student's classroom | done | M1-03 | `merge/M5-01-student-classroom-api` | #377 | `GET /app/api/student/classrooms` (`StudentClassroom[]`, archived left out) and `GET /app/api/student/classrooms/:id` (`StudentClassroomPage`, always the student payload through the caller's own seat): shapes in `contracts/src/student.ts`. `readableClassroom(app, req, reply, params, { studentView })` in `guards.ts` (rule: `classroomPayload`) |
| M5-02 | Web: student Courses route and classroom page | done | M5-01, D07 | `merge/M5-02-student-classroom-page` | #380 | `studentCourses` (`/courses`, no longer `preview`, no sidebar section) and `classroom` (`studentSafe` in every build) ship; `classroomJournal` stays `preview` until M4-02, and the classroom page's Journal tab shows only under `CLASSROOM_PAGES && hasJournal` (production: Activities alone). `student/StudentClassroom.tsx` (tab = `activities` / `journal`, the reader mounted with `JournalReader`'s new `header` prop), `student/StudentCourses.tsx`, `student/cards.tsx` (the rows, captions, `useCardActions`, `ClassroomList`, shared with the home; its join card was removed by ADR-053). The one accent: `mostUrgent`. Key `studentClassroomKey(id)` under `studentClassroomsKey`. M5-04: add the Grades tab to the same `Tabs`, move the bottom bar's Grades slot off the home anchor; M3-10: a `ProjectRow` in `Activities` and a rank in `mostUrgent`. **Open point (product owner)**: F-ORG-14 names a Courses entry in the student SIDEBAR too; there is none (on a desktop, `/courses` is reached only from a classroom page's parent link or the address), not added pending the decision, since it changes the `student-home` desktop scenes |
| M5-03 | Gradebook module | todo | M3-08, D06 | | | |
| M5-04 | Web: Grades tabs | todo | M5-03 | | | |

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
