# 7. Incompatibilities and risks

Every known point where classroom and Quiz disagree, with its resolution and
the task that carries it. A task that finds a new one adds a row here in its
PR.

## 7.1 Model and rules

| # | Incompatibility | Resolution | Task |
| --- | --- | --- | --- |
| I01 | "classroom" = top unit bound to an org with an owner (classroom) vs a period instance of a course with course staff (Quiz) | a classroom-classroom becomes a Quiz classroom under a course chosen in the mapping file; the org becomes an optional link | M2-01, M1-06 |
| I02 | Staff per classroom, invited by e-mail before sign-in, teacher/assistant label vs `course_staff` requiring an account, no label | D04; the migration reports pending seats and labels | M0-01, M8-01 |
| I03 | Owner-only actions in classroom | become staff actions (no owner in Quiz) | M3-02 |
| I04 | `oidc_sub` may differ per edu-ID client; Keycloak-era subs in classroom | match on `swiss_edu_id`, then verified e-mail; login adoption if needed | M0-02, M1-06 |
| I05 | Role computation differs (staff affiliation scope, pending seats) | recompute after import, report differences | M8-01 |
| I06 | Grades: forgeable CI points/max (doubles) vs Swiss 1–6 frozen at release | ported tables keep doubles; the gradebook converts; a project score counts only after a teacher release | M3-08, M5-03, D05 |
| I07 | Freeze: clock-driven (deadline + grace, push receipts) vs teacher-driven (release) | ADR-012 addendum: same principle, literal for projects, analogical for evaluations | M0-03 |
| I08 | Deadlines: 20-s ticker, 30-min grace, late flagged vs 1-s ticker, 3-s grace, late refused (410) | projects keep their grace and late flag; project sweeps run on Quiz's ticker with `everyMs` | M3-05 |
| I09 | Accommodations (time bonus) exist only in Quiz | D13 (suggested: not applied to projects; manual unlock covers it) | M3-05 |
| I10 | `scheduled_tasks` (admin-configurable, restart-safe) vs in-memory `everyMs` | port the table (D10) | M2-05 |
| I11 | Classroom e-mail kinds and unsubscribe links vs ADR-030 notification kinds and channels | new kinds with per-kind defaults; unsubscribe ⇒ settings redirect | M3-09, M8-02 |
| I12 | Two closed audit unions; ~70 classroom actions; imported history | project/github actions added to Quiz's union; history into `legacy_classroom_audit_log` (D11) | M3-*, M8-01 |
| I13 | Poll = an evaluation mode, anonymous polls have no classroom | not an activity kind of its own; a poll is listed as `kind: "evaluation"`; the future classroom list (M1-03 "As delivered") never returns anonymous polls | M1-03 |
| I14 | Roster `status` column vs `user_id IS NULL` | derived | M1-06 |
| I15 | Classroom `domain/roster.ts` duplicates Quiz's | keep Quiz's (classroom's + time bonus), port classroom's tests if they add cases | M1-01 |
| I16 | GitHub wire names carry classroom's words: the `GRADE` annotation title, the `grade-final` / `grade-milestone` dispatch events and their `client_payload` keys (`assignment_id`, `milestone_id`, `milestone`), read by the `grading.yml` already in student repositories | kept verbatim on the wire; Quiz's identifiers use §7.4's words (`extractScore`, `planFinalReviewDispatch`, `planCheckpointReviewDispatch`, `checkpointDueAt`) — renaming the wire would break every live repository | M1-01, M3-04, M3-05 |
| I17 | Pure rules that live inside ported adapter files: `parseStudentIgnore` (`C:github/studentize.ts`), `zurichIso` (`C:github/commit.ts`), `repoName` (under the journal's `journalRepoName`) | in `@quiz/domain` since M1-01 (`studentIgnore.ts`, `zone.ts` as `zonedIso`, `repoName.ts`): `apps/api/src/github/` imports the first two instead of keeping copies; `packages/docrender` builds `journalRepoName` on `@quiz/domain`'s `repoName`. `rateLimitReset` (`C:github/metrics.ts`) reads HTTP headers: transport knowledge, it stays in `github/metrics.ts` | M1-01, M1-02, M4-01 |
| I58 | `activity_available` is kind-neutral since M1-03, but its sentences say "exercise" and its Teams template parameter is still `{evaluationTitle}`, declared by the app every user installed (found by M1-03) | kept as is; a project reusing the kind (rather than D18's `project_published`) needs kind-aware sentences, a renamed parameter and a `TEAMS_APP_VERSION` bump | M3-09, D18 |
| I59 | `activity_scheduled` folds per (user, classroom) and its sentences count "exercises"; `deadline_approaching`, `results_released` and `results_updated` stay evaluation-shaped (`evaluationId`, found by M1-03) | a project gets kinds of its own (D18's suggestion) — or, if it shares these, the fold key gains the activity kind (a migration of the partial unique index) and the payloads become kind-neutral like `activity_available` | M3-09, D18 |
| I65 | The journal's stored copy is not portable: classroom's `journal_pages.html` links assets at `/app/api/journals/<jid>/assets/…`, its `warnings` and `sync_error` are English sentences, and its renderer never decoded a percent-escaped relative link (`handout%201.pdf` resolved to nothing, where github.com finds the file) | the cutover never copies `html`, `toc`, `warnings` nor `sync_error`: every classroom row is re-rendered by `@quiz/docrender` (classroom-scoped asset URLs, warning codes, escapes decoded); heading ids are unchanged (same slug, same 60-character cap) except for headings holding HTML entities, now decoded before the slug, so deep links survive; `html` becomes `html_staff` and `html_student` (§4.2 of `04-journal.md`) | M4-01, M8-01 |

## 7.2 Invariants of `CLAUDE.md`

| # | Invariant | What the merge stresses | Resolution | Task |
| --- | --- | --- | --- | --- |
| I20 | 1. i18n | classroom teacher surfaces are literal English; server-built English toasts, e-mails, 409 messages, journal warnings | every port writes en + fr keys; structured `AppNotice` variants and codes; decide the language of text written into GitHub (D12) | all web and API tasks |
| I21 | 2. one primary action | `AssignmentDetail` (57 kB), `AssignmentForm` (41 kB) | redesign, not copy | M3-11, M3-12 |
| I22 | 3. no dev login in production | new secrets | production refusals for `GITHUB_*` and `CODESPACE_*` in `config.ts` | M1-02, M6-06 |
| I23 | 4. `toStudent` single exit | projects (statements, review text, CI logs), journal (drafts, `visible_from`), gradebook | generalise: "activity content reaches a student only through its kind's student view"; leak tests per kind | M0-05, M3-09, M4-02, M5-03 |
| I24 | 5. server clock | classroom uses `Date.now()` and SQL `now()` | `app.clock.now()` everywhere, TestClock tests; no GitHub call inside a tick | M3-05 |
| I25 | 6. `staffAccess` | staff keyed on classroom; webhooks have no user | loaders on the course; HMAC for webhooks, App JWT for setup; student loaders by own enrollment/group, 404 otherwise | M2-02, M3-02 |
| I26 | 7. contracts | classroom declares TS interfaces, inline zod | everything in `packages/contracts`; webhook fields read by the server validated with zod | all API tasks |
| I27 | 8. pure rules in domain | small, pure; a markdown renderer does not belong in `domain` | domain ports in M1-01; renderer in `packages/docrender` | M1-01, M4-01 |
| I28 | 9. audit union | see I12 | | |
| I29 | 10–14. runner | codespace mounts a volume and opens a git channel; invariant 14 is meaningless for a repository | scope 11–12 to `apps/runner`; codespace's own `CLAUDE.md`; add "a project's source is fetched by the server at the frozen sha, never uploaded by a client" | M0-05, M6-03 |
| I30 | A table belongs to one module | webhook handlers touch project rows; group repos | handler registry (project → github); receipts written by `github` synchronously; gradebook writes only its own table | M2-04, M3-04 |

## 7.3 Security and operations

| # | Risk | Resolution | Task |
| --- | --- | --- | --- |
| I40 | **Staging restores production dumps** (ADR-028): with the production App key, staging's ticker would act on real student repositories | a separate staging App on a test org; tasks no-op without an App; the refresh nulls `installation_id` | M2-06 |
| I41 | **SSE `classroom:` topic reaches students unfiltered** in Quiz: per-repo hints there reintroduce classroom #38 (DoS, grade leak) | per-repo hints to `course:` + `user:` topics only; a test that a student never receives another student's hint | M3-09 |
| I42 | Forged CI grades (classroom H5) | indicative until a teacher release; the gradebook shows the source | M3-08, M5-03 |
| I43 | Journal assets of hidden pages readable (J1) | visibility-aware asset route | M4-02 |
| I44 | Concurrent journal ingestions (J2); J3 dropped (D03) | queue or advisory lock per classroom journal row + transaction | M4-02 |
| I45 | One webhook URL per App: no parallel run | resolved by D23: Quiz has its own App, both run in parallel; organizations install Quiz's before the cutover | M2-06, M8-05 |
| I46 | Launch tokens logged by the codespace's Caddy | mask the query string | M6-05 |
| I47 | Engine VM: no backups, 2 sessions of capacity, runner and codespace compete | resize, cgroup slices, off-VM backups | M6-05 |
| I48 | Seccomp profiles diverged | port the runner's tightenings to codespace, keep `ptrace` | M6-05 |
| I49 | ADR-027 rejected self-contained signed tokens | cross-VM HS256 kept as a recorded exception (the portal enforces single use) | M0-03, M6-01 |
| I50 | App permission `Secrets:read` used but undocumented | granted to Quiz's App at registration (D23); the probe reports "unknown" on an installation that has not approved it | M2-06 |
| I51 | Rate limits: 5 000 req/h per installation; anonymous org checks share the VM's 60/h | keep `noRateLimitWait`, SWR cache, backoff, hint coalescing; Quiz's 1-s live streams never trigger a GitHub fetch | M3-08 |
| I52 | `node:24-slim` has no git | add `git` + `ca-certificates` | M1-02 |
| I53 | App VM memory (1 vCPU / 2 GB) grows before classroom goes away | watch it through M3–M8; net gain after cutover | M8-05 |
| I54 | Dev in-process queue has no retries; no webhooks in dev | tests call handlers directly; Refresh / mock paths | M2-04, M4-02 |
| I55 | The audit table is append-only in production | dry-run until clean | M8-06 |
| I56 | Classroom keeps changing until the cutover | sync point in `PROGRESS.md`; forward fixes | every phase |
| I57 | Rulesets `hgc-protect` and `hgc-deadline-lock` may name classroom's App as a bypass actor: Quiz's App (D23) could not then lock, revert nor dispatch | check on the M8-06 rehearsal; the import rewrites the bypass list to Quiz's App | M8-06 |
| I60 | The deploy of M1-03 changes a stored payload shape: delivery jobs already queued carry the old `activity_available`, and a rollback past migration 0037 meets rewritten rows | `deliver` parses the payload and drops a stale job with a warning; after a rollback the old reader drops the rewritten bells from the list (no failure) until the next deploy | M1-03 |
| I61 | Classroom's `verifySignature` compares the hex STRINGS' lengths, so a 64-character header with a non-hex character decodes short and `timingSafeEqual` throws (a 500 instead of a 401); an empty secret is not refused | fixed in the port (`github/signature.ts`: decoded lengths compared, empty secret accepts nothing, never throws); classroom should get the same fix | M1-02 |
| I62 | Newer octokit types declare GitHub ids `number \| bigint` | `Number()` at the five places the adapters keep an id (`provision` ×2, `squash` ×2, `collaborators`); ids stay below 2^53 | M1-02 |
| I63 | The git bot identity of classroom is `hgc <bot@hgc.local>` | Quiz's commits are `heig-quiz <bot@heig-quiz.local>`; harmless, bot pushes are recognised by the sender login `<slug>[bot]`, not the committer; the ruleset names keep `hgc-*` (I57) | M1-02 |
| I64 | Classroom clones with `https://x-access-token:<token>@github.com/…`: the installation token lands in the clone's `.git/config` under `/tmp` (outliving a crash) and in git's argv | fixed in the port: plain remotes, the token reaches git only through the environment (`GIT_CONFIG_*` → `http.https://github.com/.extraheader`), tested on a clone; classroom should get the same fix | M1-02 |
| I66 | Classroom's lazy healing re-points an organization row by LOGIN (`C:modules/classrooms.ts:270-280`, `resolveOrgInstallation(org.login)` then `installationId`/`githubOrgId` overwritten): a login freed by a deleted or renamed organization and taken by another one hands every classroom of the old row to the newcomer | fixed in the port: a row is matched by `github_org_id`, by login only while it has none (M8-01 imports); a row holding the login under another id is marked `deleted`, its installation cleared, its login moved aside (`<login>~<row id>`), its links kept (`recordInstallation`, tested through the healing and the setup return); forward the fix to classroom | M2-02 |
| I67 | Classroom builds the distribution repository before inserting the assignment, deletes it when the insert loses the slug race, deletes it with a draft, and builds it with `execFileSync`, which stops the whole process for seconds | Quiz inserts the draft first (the UNIQUE decides the slug), deletes only the row on a failed build, never a repository (an empty leftover adopted, a non-empty one stepped over up to `-squashed-20`), and runs git asynchronously (ADR-062) | M3-02 |
| I68 | Classroom lets a published assignment change its grace and grading mode, freezes only the deadline strategy (at publication) and the publication mode; its source, branches and source strategy are not editable at all | Quiz follows F-PROJ-03: the deadline strategy changes until the deadline; grace, grading mode and scale, start and groups freeze at publication (`not_draft`); the source, branches and source strategy are fixed at creation, as in classroom (`projectFieldRefusal`) | M3-02 |

## 7.4 Words

| Word | Quiz | Classroom | Resolution |
| --- | --- | --- | --- |
| classroom | period instance of a course | top-level, org-bound, owned | Quiz's meaning; classroom's maps to course + classroom |
| assignment | forbidden | the GitHub work item | **Project** everywhere; "assignment" only in migration code |
| activity | #190 section, `activity_*` kinds | commit-graph panel | Quiz's; classroom's panel becomes "repository history" |
| journal | the attempt event log (spec 05 §5.5, ADR-018) | course documentation | classroom's; Quiz's becomes **attempt log** (D16) |
| milestone | evaluation navigation checkpoint | intermediate LLM review date | classroom's becomes **review checkpoint** |
| runner | `apps/runner` | self-hosted Actions runner | ours; theirs are "CI runners" |
| template | evaluation template (ADR-031) | source/template repository | never call a source repository a template |
| grade | Swiss 1–6 | points/max | **score** (points/max) vs **grade** (1–6) |
| release | results published to students | validate grades | one verb: **release** |
| session | forbidden for evaluations | codespace session | **workspace** |
| staff | course seat | classroom seat with label | D04 |

## 7.5 Spec and ADR amendments (carried by M0-03 and M0-04)

- **00**: main use, comparison table (GitHub Classroom column), objectives,
  constraints (GitHub linking ≠ sign-in; 100 repos at a deadline in
  < 5 min), phases, out of scope (Monaco-only applies to question editors;
  import classroom's exclusions), risks, decision log.
- **01**: drop "no quiz, assignment, activity or session"; Activity,
  Project, Group, Student repository, Source repository, Grade run, Push
  receipt, Frozen score, Score vs Grade, Gradebook, Gradebook column,
  Journal, Online workspace, GitHub organization; ER diagram; Project
  lifecycle.
- **02**: F-PROJ (from classroom's US/GH/GR), F-JRN (JN-01…43), F-GBOOK
  (F-RES-05 promoted); F-NOTIF-04/05/06 widened; F-ORG-01 (pending
  invites?), F-ORG-09 (deletion leaves repositories).
- **03**: N-DATA-02 (GitHub identity, repositories), N-DATA-03 vs
  classroom H11 (never delete repositories), N-DATA-05 (commits carry
  names).
- **05**: ADR list; stack (Octokit, code-server); layout (`apps/codespace`,
  modules `github`, `project`, `journal`, `gradebook`); tables; runner at a
  frozen sha (phase L); grading; §5.7 generalised; deployment (public
  webhook route, GitHub secrets, codespace on the engine VM).
- **06**: the open decisions of `08-decisions.md` that are not settled.
- **07**: frozen as history, pointing to ADR-035 and `docs/merge/`.
- **08**: a novice path for projects.
- **ADRs**: 029 superseded; 006, 007, 010, 012, 016, 027, 030 amended;
  classroom's 011 imported as 011, 013/014/015 as 047/048/049 (M0-03).
