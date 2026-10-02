# 5. Architecture

Goal: a single VM, a single database, one repository, operable by one person. Every choice favours simplicity over generality.

**Starting point: the `~/heig-classroom` repository**, same author, same stack, in production. Its ADRs 001 to 010 apply here. What is reused, adapted or dropped is detailed in [07-reutilisation-heig-classroom.md](07-reutilisation-heig-classroom.md). *Amendment (ADR-035, 2026-09-28): heig-classroom now merges into Quiz — its GitHub integration, its projects and its journal come over. The working plan is [`docs/merge/`](../merge/README.md); this spec covers the GitHub substrate, the journal and projects (5.11) and the gradebook.*

## 5.1 Technical stack

| Layer | Choice | Reason |
|---|---|---|
| Language | Strict TypeScript everywhere, pnpm workspaces | A single language, schemas shared client / server |
| Frontend | React 19, Vite, TanStack Query, Tailwind 4 with the tokens and primitives of heig-classroom | SPA, design system already written and proven |
| Markdown editor | Tiptap with markdown extension, KaTeX, image pasting, source toggle | WYSIWYG for the novice, markdown for the expert, a single source of truth: the markdown |
| Code editor | Monaco, loaded on demand | VS Code shortcuts expected |
| Backend | Node 22, Fastify 5, zod 4, schemas shared with the client through `packages/contracts` | Light, fast, typed |
| Database | PostgreSQL 17, Drizzle ORM, versioned SQL migrations, PGlite for tests | JSONB for configurations and answers, transactions, LISTEN / NOTIFY |
| Background jobs | pg-boss | Durable queues in Postgres, retries, singletons, no Redis |
| Real time | SSE server to client, REST client to server, see 5.4 | |
| Auth | openid-client against edu-ID, opaque hashed sessions, Keycloak in dev, reused from heig-classroom | Already in production with edu-ID |
| Runner | Separate Node service, rootful Podman in `--remote`, one container per execution, hardening reused from `apps/codespace`, gVisor if available | Security options already proven |
| Files | Local disk of the VM under a volume, served by the proxy | No S3 for a single VM, backed up with the database |
| Proxy | Caddy, HTTP/2 mandatory | Automatic TLS, multiplexing needed for SSE, see 5.4 |
| Deployment | Docker Compose, GitHub Actions builds the images, update script on the VM | |
| i18n | Flat dictionary per locale reused from heig-classroom, `fr` and `en` | |
| Tests | Vitest, Testing Library, Playwright | |
| GitHub | Octokit behind Quiz's own GitHub App (D23), with throttling and retry; adapters in `apps/api/src/github/`, ported from heig-classroom | A GitHub App acts for an organization without a personal token, and links accounts without an OAuth App |
| Journal rendering | marked (GitHub-flavoured markdown), KaTeX, `yaml`, on the server, in `packages/docrender` | Rendered once per synchronisation; the student bundle carries no markdown library |

## 5.2 Code modularity

### Principle

Modular monolith, ADR-001 of heig-classroom: a single API process, a single deployment, but a strict split into modules that know each other only through their exported services. Question types are packages outside the core, with a single contract.

### Repository

*This tree is the TARGET layout of the specification, not the current one.
`canonical/` and `cli/` do not exist yet, `deploy/` was
never created (the deployment files are at the root), and `qt-circuit`, the
`codeimage` type of `qt-code`, `qt-rich`, `qt-categorize`, and `qt-diagram`
with its engine `diagram` came later (ADR-019, ADR-021, issue #192, ADR-036,
ADR-046). The current
layout is in `CLAUDE.md` and on the development site's repository page.*

```
quiz/
  apps/
    api/                 Fastify: business modules, SSE, jobs, ticker
    web/                 React SPA
    runner/              code execution in containers
  packages/
    core/                QuestionType contract, type registry, pure utilities
    contracts/           zod schemas of the HTTP routes and SSE events, shared api / web
    domain/              pure business rules: grade scale, MCQ policies, cloze, roster, FSRS
    docrender/           the journal's pure renderer: renderPage, journalTree, repository naming, the code tokenizer (ADR-035)
    canonical/           YAML format, import / export, GIFT and Moodle XML converters
    ui/                  design system: tokens, primitives, quiz components
    qt-mcq/ qt-short/ qt-cloze/ qt-code/ qt-rich/ qt-categorize/ ...   one package per type
    cli/                 `quiz` on the command line: pull / push of a pool, phase 2
  docs/
  deploy/
```

### API modules

Each module lives in `apps/api/src/modules/<name>/` with `routes.ts` the HTTP handlers, `service.ts` the logic and database access (a module may split its service into cohesive files under its directory, `service.ts` staying the entry other modules import — `live/` does, since 2026-09-23), `events.ts` the events it publishes, `jobs.ts` its pg-boss handlers. A module never imports another module's `routes.ts`. It calls the other modules' `service.ts`.

| Module | Responsibility | Depends on |
|---|---|---|
| `auth` | OIDC, sessions, claims, multi-address identity, global roles | |
| `org` | Courses, classrooms, staff, rosters, accommodations | `auth` |
| `pool` | Pools, categories, tags, questions, versions, drafts, assets, search | `auth`, `core` |
| `evaluation` | Configuration of an evaluation, items, lifecycle, settings | `org`, `pool` |
| `live` | Attempts, answers, autosave, presence, clock, live control, deadline ticker | `evaluation` |
| `preview` | The teacher's stateless preview of an evaluation: seed, student view, runs and grading, nothing stored (ADR-018) | `live`, `grading`, `runner` |
| `grading` | Automatic grading, runner, LLM, validation panel, regrading, release | `live`, `runner`, `llm` |
| `results` | Grades, grade scale, CSV exports, statistical views of an evaluation, student feedback | `grading` |
| `stats` | Item analysis per question (ADR-038), the time spent on it (ADR-039) and its discrimination index (ADR-042) and the distractors of a multiple-choice question (ADR-043), aggregates for the pool | `grading`, `evaluation`, `pool` |
| `llm` | Providers, keys, prompt templates, call log, generation | `auth` |
| `runner` | HTTP client of the runner service, queue and priorities | |
| `drill` | Cards, FSRS, sessions, reviews, the teacher's activity and mastery reads (ADR-041) | `org`, `pool`, `evaluation`, `live` (the student view), `results`; registers on `live`'s `onAttemptsEnded` (hand-in) and `results`' `onResultsReleased` (release), which never import it |
| `canonical` | Import / export, API and CLI | `pool` |
| `admin` | Users, health, settings, audit; the admin routes of the scheduled tasks | all, read-only; `system` |
| `system` | The scheduled tasks (D10): their table, the ticker's claim, the `system.task` worker, the instrumented run (5.4, Clock) | |
| `realtime` | Event bus, SSE streams, presence, topics | |
| `github` | Quiz's GitHub App: installations and organizations, the classroom ↔ organization link and its checks, GitHub account linking, the webhook intake and its handler registry, delivery reconciliation (5.11) | `auth`, `org` |
| `project` | Projects (F-PROJ): their lifecycle, the distribution repository, acceptance and provisioning, groups, the score pipeline, deadline, freeze and review dispatch, sync of the source, reconciliation, the staff and student views (5.11) | `org`, `github` (registers its handlers and push receipts on the webhook registry, which never imports it) |
| `gradebook` | A classroom's gradebook (F-GBOOK): its columns, weights and published mean, read from the released results of `results` and `project` | `org`, `results`, `project` |
| `journal` | A classroom's journal in its two modes (ADR-057): in Quiz, the pages, assets and revisions it owns and their writes; in a GitHub repository, ingestion into the read model; rendering through `docrender`, the reader's access (5.11) | `org`, `github` (registers on its webhook registry, which never imports it) |

Rules:

1. The Drizzle schema is split by module in `apps/api/src/db/<module>.ts` and re-exported by `db/schema.ts`. A table belongs to one module. Another module reads it by join if necessary, but never writes it.
2. Every HTTP input is validated by a schema from `packages/contracts`. The client uses the same schema to type its calls. A route change breaks the compilation on both sides.
3. The pure rules, grade scale, grading policies, cloze parsing, FSRS, live in `packages/domain`, with no database access, unit-tested at 100 %.
4. A module publishes its events through `realtime`, never directly.

### Question type packages

A `qt-<type>` package exposes two entry points so that the API never loads React:

```
qt-mcq/
  package.json      "exports": { "./server": ..., "./client": ... }
  src/schema.ts     configSchema, answerSchema, configVersion, migrate()
  src/grade.ts      grade(), defaultPoints(), toStudent()
  src/server.ts     export const mcqServer: QuestionTypeServer
  src/Editor.tsx  src/Player.tsx  src/Review.tsx
  src/client.tsx    export const mcqClient: QuestionTypeClient
  src/canonical.ts  toCanonical(), fromCanonical()
  src/*.test.ts
```

`packages/core` defines the two interfaces and two registries, `serverRegistry` and `clientRegistry`, fed by static imports. Adding a type amounts to creating the package and registering it in both registries. The client registry loads the components on demand through `React.lazy`, so that the code player does not weigh on a multiple-choice quiz.

**Evolving a type's schema without an SQL migration.** Every JSONB configuration carries `configVersion`. The package exposes `migrate(config, fromVersion)`, which upgrades an old configuration to the current version. The API applies `migrate` on read, the draft is rewritten at the current version on the next save, published versions stay stored as they are and are migrated on the fly. No table moves when a type evolves.

### Extension interfaces for the expert

- **Public REST API** under `/api/v1`, authenticated by a personal token created in the settings, scope limited to the teacher's pools: list, read, create a draft, publish, export, import. Documented by OpenAPI generated from the zod schemas.
- **CLI** `quiz` in `packages/cli`: `quiz pull <pool> ./dir` writes the pool as YAML, `quiz push ./dir` creates drafts or publishes with `--publish`, `quiz diff` compares the folder and the server. Lets one version questions in git and edit them in one's own editor.
- **MCP server** in phase 3, exposing the same operations as the API to an LLM client. *Amendment (ADR-022, ADR-023): shipped ahead of phase 3, with the personal API tokens. The MCP server lives in the `mcp` module at `/app/api/mcp`, and each tool calls the same `/app/api` routes as the web app with the caller's token; assistants connect through OAuth. The token API is served under `/app/api`, not a separate `/api/v1` (PLAN-MVP D18 was rejected).*

## 5.3 Database

### Principles

- UUID v7 generated by the application, sortable, generatable client-side.
- Data specific to a question type is in JSONB, validated by the type's zod schema before every write. The core only knows `type`, `config`, `payload`, `details`.
- One table per domain concept, not per question type. Adding a type adds no table.
- Published content is immutable: `question_versions` and `evaluation_items` are never updated after publication, except the status columns.
- Grades are not stored as the source of truth; they are recomputed from `gradings` and frozen at release in `released_grades`.
- Cascading deletion from `classrooms`. Soft deletion of questions through `deleted_at`.

### Tables

Common columns omitted: `id uuid pk`, `created_at`, `updated_at`.

**Identity and organisation**, reused from heig-classroom

| Table | Key columns | Notes |
|---|---|---|
| `users` | `role` enum student / teacher / admin, `display_name`, `locale`, `theme`, `date_format` | Global role |
| `user_emails` | `user_id`, `email` unique, `source` login / idp / roster | Identity = set of addresses |
| `user_idp_claims` | `user_id`, `claims` jsonb, `seen_at` | Never exposed |
| `sessions` | `sid_hash` pk, `user_id`, `expires_at`, `kind` portal / seb / impersonation / kiosk, `actor_user_id` nullable, `evaluation_id` nullable, `device_id` nullable (FK `kiosk_devices`), `seb_config_key` nullable | ADR-027, ADR-034, ADR-051. `evaluation_id` set on a confined session (`seb`, `kiosk`); partial unique index on `device_id`: one session per station |
| `kiosk_devices` | `google_device_id` unique, `label`, `status` unnamed / active / retired, `attested_at`, `checked_at`, `attestation` ok / unavailable / refused, `credential_hash`, `watch` ok / unavailable / suspended (what the supervisor was last told) | The station registry, admin-only (ADR-051 §5, §6) |
| `kiosk_pairings` | `device_id`, `device_code_hash`, `user_code_hash`, `state` pending / approved / consumed / expired, `user_id`, `evaluation_id`, `approved_by`, `expires_at` | RFC 8628 device authorization (ADR-051 §7) |
| `api_tokens` | `user_id`, `token_hash`, `label`, `scopes` text[], `last_used_at`, `expires_at` | Expert, API and CLI |
| `courses` | `name`, `code` | |
| `course_staff` | `course_id`, `user_id` | composite pk |
| `user_course_prefs` | `user_id`, `course_id`, `hidden_at` nullable | composite pk, both FKs cascade; one user's display state for one course (ADR-032), no `id` nor timestamps |
| `course_pools` | `course_id`, `pool_id` | composite pk |
| `classrooms` | `course_id`, `name`, `period`, `period_start` / `period_end` text `YYYY-MM` nullable, `archived_at` | `period` is a free label; the months are both or neither, end ≥ start (CHECK). Text, not `date`: a month has no day to pin nor time zone to shift, and `YYYY-MM` compares in calendar order |
| `enrollments` | `classroom_id`, `user_id`, `time_bonus_percent` int default 0, `note` | unique (classroom, user) |
| `audit_log` | `actor_id`, `action`, `target_type`, `target_id`, `details` jsonb | Closed catalogue of actions |

**Pool**

| Table | Key columns | Notes |
|---|---|---|
| `pools` | `name`, `visibility` private / shared / public, `owner_id` | |
| `pool_members` | `pool_id`, `user_id`, `role` reader / contributor / owner | Phase 2 |
| `categories` | `pool_id`, `parent_id` nullable, `name`, `position` | Tree by parent |
| `questions` | `pool_id` nullable (an unsaved poll question, ADR-014 addendum), `category_id` nullable, `type` text, `internal_name`, `difficulty` smallint 1 to 5, `shuffleable` bool, `randomizable` bool (derived: the latest published version declares variables, ADR-056 §1), `origin_question_id` nullable, `stats_since` nullable, `deleted_at` | Stable metadata. `stats_since`: written only by the statistics reset (ADR-038) |
| `question_stars` | `user_id`, `question_id`, `starred_at` | composite pk, both FKs cascade, index on `question_id`; one user's favourite (F-POOL-10, ADR-040). "Per pool" is a join on `questions.pool_id` |
| `question_tags` | `question_id`, `tag` text | composite pk, index on `tag`. No `tags` table: tags are normalised strings, the distinct list comes from a query |
| `question_versions` | `question_id`, `number` int nullable, `config` jsonb, `config_version` int, `explanation` text, `variables` jsonb nullable (the variables table of a parameterized question, ADR-056; null = static), `search` generated tsvector, `published_at`, `published_by`, `change_note`, `deprecated_at`, `deprecation_note` | unique (question_id, number). `number` null = draft, a single one per question thanks to a partial unique index `WHERE number IS NULL` |
| `assets` | `owner_id`, `pool_id`, `sha256`, `mime`, `bytes`, `width`, `height`, `path` | Deduplicated by hash. Referenced in the markdown by `asset:<id>` |
| `question_version_assets` | `version_id`, `asset_id` | For export and cleanup |

**Evaluation**

| Table | Key columns | Notes |
|---|---|---|
| `evaluations` | `classroom_id`, `course_id` (FK, cascade) — exactly one home, CHECK `evaluations_home_ck`: a classroom; a course, for an evaluation template (ADR-031); or neither, for an anonymous poll owned by `created_by` (ADR-014 addendum 2026-09-27). `revision` int (template), `origin_template_id` (self FK, set null) and `origin_revision` (instance), `title`, `mode` exam / exercise / poll, `state`, `settings` jsonb, `grading_scale` jsonb (`{ kind: "linear", rounding }`, ADR-052), `feedback_policy` jsonb, `opens_at`, `closes_at`, `closes_at_shift_s` int (how far the live controls — an extension to all, a resume — moved `closes_at` since the teacher last set the timing; `closes_at − opens_at − closes_at_shift_s` is the announced window, the base of the accommodation, decision D8, #253), `duration_s`, `access_code` (a poll's session code, ADR-014), `ip_allowlist` text[], `released_at`, `released_grades` jsonb, `modified_after_release` bool, `correction_published_at` (the instant the teacher published the correction of an exercise still open, from the server's clock; set once by a conditional UPDATE, cleared only by a return to `draft`, ADR-050) | `settings` validated by a schema from `contracts`: navigation, presentation, shuffling, waiting room. CHECK `evaluations_template_ck`: a row with `course_id` has no `opens_at`, `closes_at`, `access_code` nor IP, stays `draft`, is not a `poll`, has a `revision` and no origin. CHECK `evaluations_access_code_poll_ck`: `access_code is null or mode = 'poll'` — an exam or an exercise has no access code ([ADR-053](../adr/ADR-053-retrait-des-codes-d-entree.md), migration `0043_evaluation_access_code_poll`). The `revision` moves only through `bumpTemplateRevision` (`evaluation/templates.ts`), `+ 1` in SQL inside the transaction of the template write that changed the content (ADR-031 addendum d). "Owned poll" is ONE predicate (`classroom_id` and `course_id` null, `mode = 'poll'`), used by every site that used to read `classroom_id is null`; partial indexes `evaluations_owned_poll_idx` and `evaluations_template_idx (course_id)` |
| `evaluation_items` | `evaluation_id`, `position`, `question_version_id`, `points` numeric, `milestone` bool, `bonus` bool (ADR-052: left out of the total, floored at 0) | unique (evaluation, position). Frozen copy of `question_version_id` |
| `attempts` | `evaluation_id`, `user_id`, `attempt_number` int (1, then n + 1 per retake), `state`, `seed` int, `instances` jsonb default `{}` (the values of each parameterized item, `{ [itemId]: { versionId, values } }`, drawn at the attempt's creation, ADR-056 §5), `started_at`, `deadline_at`, `bonus_s` int, `submitted_at`, `closed_at`, `closed_by` server / student / teacher, `last_item_id` (the reload bookmark), `shown_item_id` and `shown_since` (the open interval of the dwell, both null or both set), `display_tracked` bool (false for the attempts older than ADR-039) | unique (evaluation, user, attempt_number); partial unique (evaluation, user) `WHERE state IN ('not_started', 'in_progress')`: one unfinished attempt per student (ADR-025). One attempt per student except on an `exercise` with retakes (F-EVAL-15). Partial index `(deadline_at) WHERE state = 'in_progress'` for the ticker |
| `answers` | `attempt_id`, `item_id`, `payload` jsonb, `revision` int, `marked_done` bool (validated: "Validate and continue", a crossed checkpoint), `skipped` bool ("Leave unanswered"), `flagged` bool (review flag), `first_seen_at`, `first_shown_at` (first on screen, ADR-039), `dwell_ms` int (time on screen, never sent to anyone), `updated_at` | unique (attempt, item). The payload is validated by the type's `answerSchema`. An accepted answer that holds something clears `skipped` (issue #89) |
| `attempt_events` | `attempt_id`, `kind`, `at`, `details` jsonb. Client kinds (`ClientEventKind`, the only ones `POST /attempts/:id/events` accepts): visibility `{state}`, focus `{focused}`, reconnect. Server kinds, never writable by a client: ip_change, time_added, paused, resumed, run | Light anti-cheat and support log. The client body is a strict schema under a 4 KB limit |
| `guest_participants` | `evaluation_id`, `pseudonym`, `token_hash` | `poll` mode without an account, phase 2. A guest has an `attempts` row with `user_id` null and `guest_id` |

**Grading and results**

| Table | Key columns | Notes |
|---|---|---|
| `gradings` | `answer_id`, `points` numeric, `max_points` numeric, `source` auto / llm / manual, `state` proposed / validated / superseded, `details` jsonb, `confidence` low / medium / high nullable, `comment` text, `graded_by` nullable, `graded_at`, `supersedes_id` nullable, `regrade_note` text | Partial unique index `(answer_id) WHERE state = 'validated'`. `details`: verdict per test case, points per criterion, matcher match |
| `answer_flags` | `answer_id`, `user_id`, `reason`, `resolved_at` | Student flag, phase 2 |
| `llm_calls` | `user_id`, `purpose` grade / generate / explain / variant, `provider`, `model`, `input_tokens`, `output_tokens`, `cost_estimate`, `duration_ms`, `ok`, `error` | Never the content of the prompts *Amended (ADR-058): purposes `test` / `grade` / `generate` / `review`, `user_id` nullable (a call no person made), `status` pending / ok / error instead of `ok`, `cost_usd`; the cost is an estimate stored at write time.* |

**Drill**, phase 2

| Table | Key columns | Notes |
|---|---|---|
| `drill_cards` | `user_id`, `question_id`, `classroom_id` and `evaluation_id` (where it was met first), `stability`, `difficulty`, `due_at`, `reps`, `lapses`, `last_review_at` null for a new card, `key_hash` (the answer key it was last reviewed on), and the review in progress: `serve_seed` (null when none), `serve_values` (a parameterized question's values, null without a `serve_seed`, ADR-056 §5), `shown_since` (the open interval on screen), `active_ms` | unique (user, question). Created at the release of an exam, at the hand-in of an exercise (ADR-041 §1). A different `key_hash` at a review resets the card (§7). Cascades from the classroom, the evaluation and the question (06, question 28 (a)). Kept five years after its last review (N-DATA-03), purged by the `drill.purge` ticker task |
| `drill_reviews` | `card_id`, `rating` 1 to 4, `correctness` right / partial / wrong, `elapsed_ms` the ACTIVE time summed by the server, `device_class` coarse / fine, `reviewed_at`, `answer_payload` jsonb, `values` jsonb (the values of a parameterized question it was answered on, ADR-056 §5) | History for the reference times (the `right` reviews of the same device class), the teacher's view, and recomputing the parameters. Kept five years (N-DATA-03) |

The drill's switches live on the rows they qualify, and belong to those rows' modules: `classrooms.drill_enabled_at` (the teacher enabled it, null otherwise) and `enrollments.drill_opted_out_at` (the student opted out of that classroom's drill), written by `org`'s `setClassroomDrill` and `setDrillOptOut`; `allowDrill` in the evaluation's `settings` (ADR-041 §2, §6), absent meaning on for an exercise and off for an exam, chosen at creation and then written only by `evaluation`'s `setAllowDrill`, until the release (the settings PATCH does not carry it). `drill_cards` and `drill_reviews` belong to the `drill` module (migration `0036_drill`).

**GitHub**, module `github` (`db/github.ts`, ADR-035)

| Table | Key columns | Notes |
|---|---|---|
| `github_organizations` | `github_org_id` unique nullable, `login` unique, `installation_id` unique nullable, `status` active / deleted, `plan` | One row per organization known to Quiz's App, never deleted; no timestamps. Installed or not is `installation_id` null or not, and nothing else: it is Quiz's App's (D23), null until the organization installs it, and nulled on staging by every refresh from production (N-SEC-18). `status` says only whether the organization still exists on GitHub. The avatar is served same-origin by `GET /app/api/github/orgs/:id/avatar`, from a source derived from `github_org_id` |
| `github_classroom_links` | `classroom_id` pk (FK, cascade), `org_id`, `linked_by`, `linked_at` | At most one organization per classroom (D02); no `id` nor timestamps |
| `github_accounts` | `user_id` pk (FK, cascade), `github_user_id` unique, `login`, `linked_at` | The GitHub account link. The id is the person's, not the App's; the login is followed when it changes. `users` stays with `auth` |
| `webhook_deliveries` | `delivery_id` uuid pk (GitHub's `X-GitHub-Delivery`), `event`, `action`, `payload` jsonb nullable, `received_at` (the intake's clock, no default), `processed_at`, `error` | The primary key is the deduplication, and the row outlives its payload. The payload is what the worker handles and what a replay of an unprocessed delivery re-reads (ADR-011); set to null 30 days after receipt once processed. Partial index `(received_at) WHERE processed_at IS NULL` for the reconciliation |
| `push_receipts` | `github_repo_id`, `branch`, `head_sha`, `received_at` (the intake's clock, no default), `is_bot`, `forced` | Written synchronously by the intake for the repositories a handler tracks, the repositories of projects (heig-classroom ADR-012: `received_at` is the server's receipt time, the legal reference of a deadline); unique (`github_repo_id`, `head_sha`), the first receipt kept. Keyed on GitHub's repository id, not on a project's row, so `github` holds no foreign key into `project` (the direction is project → github); projects join it through their repositories' `github_repo_id`. The journal writes none |

**Journal**, module `journal` (`db/journal.ts`, `docs/merge/04-journal.md` §4.2): one row per classroom, no shared mirror (D03), two modes (ADR-057). The columns marked *ADR-057* come with M4-07

| Table | Key columns | Notes |
|---|---|---|
| `classroom_journals` | `classroom_id` pk (FK, cascade), `mode` quiz / github (*ADR-057*), `github_repo_id`, `full_name`, `ref` (nullable, *ADR-057*), `root_path`, `last_commit_sha`, `sync_status` pending / ok / error, `sync_error`, `created_by`, `version` | CHECK: the three repository columns are set in `github` mode and null in `quiz` mode; rows created before ADR-057 are `github`. In GitHub mode a journal is a repository (D03): two classrooms on the same repository are two rows, each ingested on its own; a push fans out to every row holding that `github_repo_id`. `version` is bumped by every writer of the copy (J2) |
| `journal_pages` | `classroom_id`, `path`, `parent_path`, `sort_key`, `title`, `front_matter` jsonb, `blob_sha`, `markdown`, `html_staff`, `html_student`, `toc` jsonb, `draft` bool, `visible_from` nullable, `warnings` jsonb, `asset_paths`, `version` int and an explicit order among siblings (*ADR-057*) | unique (classroom, path). In GitHub mode the rendered read model, ordered by `sort_key` from the file names; in Quiz mode the content itself: the path never changes, `parent_path` is the parent page and the order field orders siblings, `version` is the save's optimistic lock. `markdown`, `blob_sha` and `warnings` never leave the staff payload (N-SEC-12) |
| `journal_assets` | `classroom_id`, `path`, `blob_sha`, `content_type`, `size`, `data` bytea | unique (classroom, path). ≤ 5 MB each (D14). GitHub mode: only the files a page references, a read model rebuilt from the repository. Quiz mode: the content, under a relative path beside its page, `blob_sha` the sha256 of the bytes (the ETag), append-only, collected when no page references it |
| `journal_page_revisions` (*ADR-057*) | `classroom_id`, `path`, `revision` int, `markdown` (front matter included), `created_by`, `created_at` | Quiz mode: one row per save, no limit, no asset. Staff only: no student route ever joins it (N-SEC-12) |

**Projects**, module `project` (`db/project.ts`, `docs/merge/03-github-projects.md` §3.3), ported from heig-classroom's tables under the merge's words (assignment ⇒ project, student repo ⇒ project repo, milestone ⇒ review checkpoint); the UNIQUE constraints remain the idempotency mechanism:

| Table | Key columns | Notes |
|---|---|---|
| `projects` | `classroom_id` (cascade), `org_id` (the organization, copied from the classroom's link at creation), `name`, `slug`, `state`, `start_at`, `deadline_at`, `grace_minutes`, source and distribution repository ids and names, `source_strategy`, `deadline_strategy`, `grading_mode`, `publish_mode`, `duration_minutes`, `group_mode`, `group_max_size`, `branches`, `protected_files`, `grading_scale`, the markers `deadline_applied_at`, `frozen_at`, `review_dispatched_at`, `reminder_sent_at`, `released_at`, `released_by`, `archived_at`, `created_by` | unique (classroom, slug). Four partial indexes feed the ticker's scans: deadline due and not applied, freeze due, review due, scheduled publication |
| `project_checkpoints` | `project_id`, `name`, `due_at`, `offset_days` (J±n, re-resolved when the deadline moves), `dispatched_at` | unique (project, name) |
| `project_groups`, `project_group_members` | the group's `name`, `slug`, `position`; a member is an `enrollment_id` | unique (project, enrollment) (ADR-048) |
| `project_repos` | `project_id`, `user_id`, `group_id` (set null), `github_repo_id` unique, `full_name`, `provision_status`, `provision_claimed_at`, `invitation_status`, `locked_at`, `ruleset_id`, `last_commit_*`, `ci_status`, `current_` / `frozen_` / `review_grade_run_id`, `teacher_points`, `teacher_comment`, `released_points` / `released_max` (the release's snapshot: a later difference is "changed after release"), `protection_suspended_at` (F-PROJ-08), `deleted_at` | partial uniques (project, user) for an individual repository and (project, group) for a group's: the idempotency of Accept |
| `project_grade_runs` | `repo_id`, `workflow_run_id`, `run_attempt`, `head_branch`, `head_sha`, `conclusion`, `points`, `max` (doubles, as reported), `parse_status`, `after_deadline`, `kind` (`ci`, or `review` for the final review) | unique (repo, run, attempt). Immutable |
| `bot_commits`, `grade_dispatches`, `reverts` | the App's own commits (restore, deadline, sync), the review dispatches (claimed before the call: at-least-once), the restore counter | What tells a bot push from a student's, and what keeps a retry from doubling a write |

**Gradebook**, module `gradebook` (`db/gradebook.ts`): `gradebook_columns` (`classroom_id`, the activity's kind and id, `counts`, `weight`) and the classroom's `mean_published_at`. It stores no grade: a cell is read from the released results of the activity, so a regrade after the release shows at once (F-GBOOK-03).

**Infrastructure**: the `pgboss` schema managed by pg-boss, a `settings` table with jsonb key / value pairs for the global settings, `providers` for the LLM providers with an encrypted key. *Amended (ADR-058): one singleton row, `llm_settings` (provider, encrypted key, model per purpose, daily cap), owned by the `llm` module; the jsonb `settings` table is not built.*

**Scheduled tasks**, module `system` (`db/system.ts`, D10):

| Table | Key columns | Notes |
|---|---|---|
| `scheduled_tasks` | `key` text pk, `enabled` bool, `interval_minutes`, `last_run_at`, `last_status` running / ok / error, `last_message`, `last_duration_ms`, `last_ok_at` | One row per task of the catalog, which is code: inserted with the defaults at boot, never deleted; a row whose key left the catalog is ignored. `last_run_at` is the claim (5.4, Clock) |
| `health_check_states` | `key` text pk (a `SYSTEM_CHECK_KEYS` key), `status` ok / warn / fail / unknown, `since`, `consecutive`, `notified_status` fail / ok, `notified_at`, `checked_at` | What the `health.checks` task keeps of each health check between two runs (ADR-055 §5): the streak the anti-flap rule (`nextCheckState`, `@quiz/domain`) reads, and the last notice sent. Written only by that task, one run at a time |

### Critical queries and indexes

| Need | Query | Index |
|---|---|---|
| Autosave | `UPDATE answers SET payload, revision WHERE attempt_id = ? AND item_id = ? AND revision < ?` | composite unique pk |
| Deadline ticker | `UPDATE attempts SET state = 'expired' WHERE state = 'in_progress' AND deadline_at + interval '3 s' <= now() RETURNING id` | partial on `deadline_at` |
| Dashboard grid | join `attempts` × `evaluation_items` left `answers` left validated `gradings`, one evaluation | `answers(attempt_id)`, `gradings(answer_id) WHERE validated` |
| Search in the pool | `tsvector` on `internal_name`, statement extracted from the config by the type, tags | GIN on `search`, index on `question_tags(tag)` |
| Latest published version | `SELECT ... WHERE question_id = ? AND number IS NOT NULL ORDER BY number DESC LIMIT 1` | `(question_id, number desc)` |
| Item statistics | validated `gradings` of exams (never an exercise, amended 2026-09-30) joined to `evaluation_items`, then to the question through `question_versions.question_id` (ADR-038) | `evaluation_items(question_version_id)`, `gradings(item_id) WHERE validated` |

### Transactions

- Publishing a version: in one transaction, check the draft, compute `number = max + 1`, insert, reset the draft. The unique index protects against double publication.
- Starting an attempt: `INSERT ... ON CONFLICT DO NOTHING` then read, which makes a double click idempotent. `deadline_at` is computed at insertion from `duration_s`, the bonus and the mode.
- Releasing the results: one transaction computes every grade, writes `released_grades` and `released_at`, logs to the audit.
- Publishing the correction of a running exercise (F-EVAL-27, ADR-050): once the route has refused an exam or a poll, one conditional UPDATE sets `correction_published_at` only while it is null and the evaluation is `running` or `paused`, so a concurrent close or second publication is seen; the finished attempts nothing has graded yet are then sent to one `grading.evaluation` job, and the action is audited (`evaluation.correction_publish`). A repeat answers the first instant and writes nothing.
- Pulling a template revision into an instance (F-EVAL-26): one transaction locks the TEMPLATE first (`FOR SHARE`, read only as a template of the instance's own course), then the instance (`FOR UPDATE`) — the order `deleteTemplate` takes through its foreign key, so neither deadlocks — re-reads the origin, the state and the attempt count under that lock, and only then replaces the items (`evaluation/templates.ts`, `pullTemplate`). New item ids cascade to answers and gradings, which is why the gate is read inside the lock and never before it.

## 5.4 Real time

### What the system must carry

| Flow | Direction | Frequency | Requirement |
|---|---|---|---|
| Answer autosave | client → server | up to 3 per second per student, 30 students | Durable acknowledgement, ordering, idempotence |
| Evaluation state: start, pause, time added, close | server → all | rare | Under one second, never lost |
| Clock | server → client | every 10 s | Estimated offset, no drift |
| Dashboard grid | server → teacher | up to 100 updates per second at peak | Coalescing acceptable, eventual consistency |
| Presence: connected, disconnected | server → teacher and waiting room | rare | Detection in under 30 s |
| Runner results, gradings, notifications | server → one client | rare | |
| Live poll | server → teacher and projection | moderate | Under one second |

### Options

**A. SSE plus REST.** Unidirectional HTTP stream, native `EventSource` with automatic reconnection, writes over REST. The heig-classroom model.

- For: no library, cookies and CSRF reused as they are, testable with `curl`, reconnection without code, every write is an HTTP request with a response, natural retry and idempotence, exactly what the critical path of the autosave needs. The proxy needs to know nothing more than a `flush_interval -1`.
- Against: on HTTP/1.1 the browser limits to six connections per domain, and one SSE tab per page consumes one. On HTTP/2 the limit disappears. The server receives nothing through the stream, writes go through separate requests, which costs one HTTP header per autosave, negligible on HTTP/2.

**B. WebSocket.** One bidirectional channel per client.

- For: minimal latency, a single channel, immediate presence on socket close, natural transport for a future co-editing feature.
- Against: a server library and a home-made protocol of messages, acknowledgements, resumption after a cut, replay of unacknowledged writes. Everything HTTP already does for writes must be reinvented. Authentication at the upgrade, heavier tests, less direct debugging. At 100 clients, no measurable gain.

**C. Hybrid, SSE today, WebSocket on a dedicated route if a high-frequency bidirectional need appears.** Nothing in the scope asks for it: no co-editing, no shared cursor, no audio.

### Decision: SSE plus REST, with three additions

Option A is retained. The critical path of an exam is writing the answers. On that path, HTTP offers for free what WebSocket would force us to rewrite: one response per request, resumption by simply resending, an explicit error code when time is up. The server-to-client flows are infrequent or tolerate coalescing. HTTP/2 is imposed by Caddy over TLS, which lifts the connection limit. The additions compared to heig-classroom:

1. **Data-carrying events for the `live` domain.** heig-classroom only sends refresh hints. For the dashboard, refetching the grid at every keystroke of 30 students would be absurd. The events of the `live` domain carry a typed payload from `contracts`, applied directly to the client state. The other domains keep hints and refetch.
2. **Server-side coalescing.** Cell updates are grouped by `(attempt, item)` over 250 ms before emission, one emission per cell and per window. The worst case drops to a few events per second per teacher.
3. **Snapshot on connection.** When the stream opens, the server sends `snapshot` with the complete state of what the client is watching: the evaluation and the attempt for a student, the grid for a teacher. No `Last-Event-ID`, no replay buffer, no resumption state. A lost event is repaired by the next reconnection or by a safety refetch every 60 s.

### Event grammar

One stream per tab, `GET /events?watch=evaluation:<id>` or `watch=attempt:<id>`. The server checks the authorisation on the requested topic and subscribes the client to the implicit topics: `user:<id>`, and `teacher:<id>` for a teacher.

| Event | Topic | Payload | Receiver |
|---|---|---|---|
| `snapshot` | all | complete state of the watched topic, `serverNow` | all, on connection |
| `clock` | all | `serverNow` | all, every 10 s, also serves as heartbeat |
| `evaluation.state` | `evaluation:<id>` | `state`, `pausedAt`, `closesAt` | students and teacher |
| `attempt.deadline` | `attempt:<id>` | `deadlineAt`, `bonusS`, `reason` | one student, when the teacher adds time |
| `attempt.closed` | `attempt:<id>` | `closedBy` | one student |
| `dashboard.cell` | `evaluation:<id>` | `attemptId`, `itemId`, `status`, `revision`, `points` nullable, `flagged` (the student's review flag, issue #89) | teacher, coalesced |
| `dashboard.presence` | `evaluation:<id>` | `userId`, `online`, `lastSeenAt` | teacher and waiting room |
| `lobby.count` | `evaluation:<id>` | `present`, `enrolled` | waiting room |
| `poll.tally` | `evaluation:<id>` | aggregated distribution | teacher and projection, coalesced 500 ms |
| `runner.result` | `user:<id>` | `requestId`, result | one student |
| `grading.progress` | `teacher:<id>` | `evaluationId`, `done`, `total` | teacher |
| `hint` | various | `type`, `topics` | TanStack Query refetch, like heig-classroom |

### Clock

Every `clock` and every autosave HTTP response carry `serverNow`. The client keeps the median of the last five offsets `serverNow − clientNow`, corrected by half the round-trip time measured on the requests. The countdown shows `deadlineAt − (Date.now() + offset)`. The server alone closes the attempt: the ticker runs every second and expires the attempts that are more than 3 seconds past their deadline. A write arriving after `deadline + 3 s` is refused with `410 attempt_closed`; the client shows that time is up and stops sending.

#### The ticker's two kinds of periodic work

One ticker (ADR-006), one loop of `TICK_MS` (one second), and two kinds of work on it (D10, settled 2026-09-30):

- **Clock-bound tasks** (`TickTask`, `TICK_TASKS` in `apps/api/src/ticker.ts`): the live half — `live.expire_attempts`, `live.open_scheduled`, `live.close_due`, `live.presence_sweep` (every 5 s). Run by the loop itself, every tick or every `everyMs`. Neither configurable nor disableable: invariant 5 never depends on an admin setting.
- **Scheduled tasks** (`ScheduledTask`, catalog `SCHEDULED_TASKS` in `apps/api/src/modules/system/catalog.ts`): the minutes-scale housekeeping — `sessions.purge` (10 min), `oauth.purge` (60 min), `poll.end_idle` (1 min), `notifications.deadline_reminders` (1 min), `drill.purge` (6 h), `health.checks` (5 min, ADR-055 §5); the GitHub reconciliations join with the tasks that port them (ADR-011). Each module contributes its list; the keys are a closed list of `@quiz/contracts` (`SCHEDULED_TASK_KEYS`). Every 15 s one clock-bound task claims the due ones in ONE conditional UPDATE on the database clock (`enabled`, in the catalog, `last_run_at` null or `last_run_at + interval_minutes <= now()`, and not `running` unless the run is 30 minutes old and taken for dead), setting `last_run_at = now()` and `last_status = 'running'`, and sends each claimed key to the `system.task` queue, whose worker runs it and records the status, the duration, an English summary or the error, and `last_ok_at`. Without a queue the claimed task runs inline, beside the tick and not awaited by it. The claim is the multi-process safety; a restart finds the condition still true and catches up.

The administrator sees the catalog joined to its rows (`GET /app/api/admin/tasks`), pauses a task or changes its period, 1 minute to 1 week (`PATCH /app/api/admin/tasks/:key`, audited `task.configure`), and runs one now (`POST /app/api/admin/tasks/:key/run`, audited `task.run_now`): the same claim for that key whatever its period, refused with 409 `task_running` while it runs; 200 with the outcome when it ran inline, 202 when enqueued. A finished run raises the `admin` hint (F-ADMIN-06).

### Autosave

`PUT /attempts/:id/answers/:itemId` with `{ payload, revision, clientTs }`. The client increments `revision` locally at every change, groups over 300 ms, and never has more than one request in flight per item: the next one waits, with the latest payload. The server writes if `revision` exceeds the revision in the database; otherwise it returns the current revision and the payload from the database, which the client adopts. Response: `{ revision, serverNow }`. On a network failure, retry with exponential backoff capped at 5 s, "offline" indicator after 3 s without acknowledgement.

### Dwell

ADR-039. The player reports what is on screen, `POST /attempts/:id/position { itemId }`: an item on every move and when the tab comes back, `null` when the tab hides or the player is left. The server keeps one open interval per attempt, timed on its own clock; a report ends it and opens the next, and every end of an attempt (submission, close, pause, expiry) ends it too, in the same transaction. The credit is capped ten minutes after the later of the display and the last write to the question, and clamped at the deadline. It accumulates in `answers.dwell_ms`; only the pool statistics read it, as aggregates.

### Presence

The `realtime` module keeps `topic → connections` in memory. Opening and closing an SSE stream emit `dashboard.presence`. A connection that receives no `clock` for 30 s on the client side triggers a reconnection. The server closes inactive streams after 60 s when no write is possible. Should the API one day run in several processes, the bus would go through `LISTEN / NOTIFY`, ADR-005.

## 5.5 Runner

Internal HTTP service, called by the API only. *Amendment (ADR-016): in production it runs on another VM and is reached over HTTPS, `https://code.chevallier.io:8443`, behind that VM's Caddy, which admits the application VM's address only; the service itself requires the shared `RUNNER_TOKEN` on every route.*

```
POST /run
{ language, files: [{ name, content }], compileArgs, cases: [{ stdin, timeMs }], limits, action }
→ { compile: { ok, stdout, stderr, ms }, cases: [{ exitCode, stdout, stderr, ms, timedOut, oom }] }
```

- One image per language, built from `apps/runner/images/`, derived from the codespace's `c-dev` without code-server. Rebuilt every week. *Current state: `c`, `cpp`, `python`, `js` and `spice` are built by default, `rust` on demand (`apps/runner/images/build.sh`).*
- **`spice` is a language of the runner**: an Alpine image with ngspice, for the `circuit` question type (ADR-019). It is one image, one run plan and the same hardened container as the others — no flag is relaxed for it, no environment variable is added. Nothing is built: a netlist is the program, so `compile` is the "nothing to do" answer and a malformed netlist is a FAILED CASE, not a compile error.
- **In `spice`, the case's `args` carry the file to simulate.** One request holds one schematic and its stimuli: one file per stimulus (`s0.cir`, `s1.cir`, …) and one case per stimulus, named after it, with `args: ["s0.cir"]`. The argv is therefore `timeout -s KILL <s> ngspice -b s0.cir`, and one container serves every stimulus of one answer. The other languages name their file in the run plan and use `args` for the program's own `argv[1..]`; this convention is what lets both share `execute.ts` unchanged.
- **`POST /attempts/:id/simulate`** is the student's own run for a type that builds its own request (`QuestionTypeServer.interactiveRequest`): the API forces `priority: "interactive"`, counts it against the question's budget in the attempt log (`attempt_events`, D16), and hands the `RunnerOutcome` back raw. It is generic — the live module knows nothing of netlists.
- Each request creates a container with the options of the codespace's `run-hardened.sh`: `--network none`, `--read-only`, `--tmpfs /work:size=32m`, `--memory`, `--cpus 1`, `--pids-limit 64`, `--userns=auto`, `--cap-drop ALL`, `--security-opt no-new-privileges`, seccomp profile `codespace.json`, and `--runtime runsc` if gVisor is installed. The wall-clock time is enforced by the service, which kills the container when it is exceeded. *Amendment: the profile now lives at `apps/runner/infra/seccomp/runner.json`, and the exact, tested flag list is `containerArgs` in `apps/runner/src/engine.ts`, documented in `apps/runner/README.md`, which is the reference.*
- Compilation then execution of the cases in the same container, sequentially, each with its own limit.
- Two queues: `interactive` for student runs during an evaluation, `grading` for the final grading, lower priority. Configurable concurrency, 4 by default. Beyond a depth limit, 429 and the client retries.
- The source code is rebuilt on the API side from the template and the editable regions, never taken as-is.
- A `codeimage` question stores its target image IN ITS CONFIG (compact hex encoding, docs/04 §4.9): the teacher runs the reference solution from the editor ("Try the reference solution") and presses "Use as target". Nothing runs at publication; publication only checks that the target fits the image's size and palette (ADR-021).

Alternative evaluated: Piston, a free multi-language runner, isolation by Unix users and cgroups. Kept as a fallback if Podman causes trouble on the VM.

## 5.6 Grading

After closing, the `grading` module enqueues a `grading.evaluation` job over the whole evaluation — one job per request, never deduplicated, since two requests may differ in scope (#273) (on an `exercise` with retakes, or one whose correction is published (ADR-050), each attempt is also graded alone as soon as it ends, and the results read the KEPT attempt of each student, best or last: ADR-025). The job walks the attempts and, for each answer, calls the type's `grade`. Immediate result: `auto` grading, validated. `pending: 'runner'`: a `grading.runner` job per answer, low-priority queue. `pending: 'llm'`: a `grading.llm` job per answer, `llm` grading proposed (*amendment, ADR-045: until a real provider exists, the pass calls the service inline, the development stub being the only one, and never while the evaluation runs*; *ADR-063: the `grading.llm` queue exists, worked two jobs at a time, and a successful `llm` proposal is not asked again except by a re-grade*). The jobs are idempotent: they check the absence of a validated, non-superseded grading before writing. `grading.progress` informs the teacher. The evaluation's per-type settings reach `grade` through `GradeContext.defaults` (`gradeDefaults`): the MCQ policy and the categorize policy (`settings.categorizePolicy`, ADR-036) an `inherit` question defers to, and negative marking (ADR-026), which covers `mcq` and `categorize`. Every total of an attempt — grade table, CSV, release snapshot, feedback, cards, kept attempt of a retake — is `attemptTotal` of `@quiz/domain`: per-question points are kept signed, the total is floored at 0, and the grade is computed from it.

The `llm` module builds the prompt from a template per purpose, requires a JSON output validated by zod, retries once on invalid JSON, logs into `llm_calls` without the content. Providers: Anthropic SDK and an OpenAI-compatible client behind a common interface. Default model for grading: Claude Opus, for generation: Claude Sonnet, configurable. *Amended (ADR-058): one model for every purpose, Claude Sonnet by default; the gateway `complete()` of the `llm` module, Anthropic only, an institutional key, a daily cap, and `llm_calls`. The grading pass is wired to it since ADR-063, purpose `grade`.* *Amendment (ADR-063): `@quiz/core` holds only what a type asks and what comes back (`LlmGradeRequest`, `LlmGradeOutcome`); the service is `GradingLlm`, in the API's `llm` module, the gateway's or the stub.* *Amendment (ADR-045): the common interface is `LlmService` (`@quiz/core`), chosen by `LLM_PROVIDER`; its one implementation is a deterministic development stub, refused in production. The prompt templates, the `llm_calls` log and the real providers come with the first of them; an LLM's justification stays in the grading's details, for the teacher only (open question 27).*

## 5.7 Content security

A single point of exit of content towards a student: the type's `toStudent`, called in a `studentView` service of the `live` module, which also removes the internal name, the tags, the difficulty, the explanation, then applies the feedback policy (`feedbackGate` of `@quiz/domain` decides WHEN: the policy, the release, and a correction published while an exercise runs, which counts as the release — ADR-050). The class debrief (`GET /evaluations/:id/results/by-question`) is staff-only and served once the evaluation is over or its correction published, over the finished attempts only while it runs (ADR-033, ADR-050). Tests: for each type, a full configuration passed through `toStudent` contains no forbidden field, tested by a blacklist of keys and by searching for the answer-key values in the serialised output. A parameterized question (ADR-056) reaches the student only as an instance (`pool/instance.ts`; `loadConfig` throws on a template): `live/parameters.db.test.ts` sends a full parameterized `mcq`, `short` and `cloze` through the attempt, its reload, the feedback and the preview, and searches the output for every `[[name`, every expression, the condition and the table, and for the student's own instantiated key where the key is not shown.

The key has one student exit too: once the feedback policy shows it (`showKey`), a student reads the type's `toSolution` passed through its optional `studentSolution` hook, in `studentSolutionView` beside `studentView`. The hook drops from the solution what stays the teacher's even under a shown key — the grading criteria of an essay, a short answer's `llm` rubric. Every student-facing reader of a key goes through it (the feedback page, a poll's reveal, the teacher's preview "as a student" and the "Show answers" of a question's preview, which asks for the key on the click only); the teacher's surfaces keep the whole `toSolution` (ADR-037).

**A project has its own exit**, the student view of the `project` module (N-SEC-20): a student reaches a project of a classroom where they hold a claimed seat (through `readableClassroom`'s student branch), and only their own repository or their group's; the payload carries what F-PROJ-15 lists and nothing of the source, the distribution repository, the other repositories, the runs after the deadline nor the staff's flags. A repository's live hints go to the student's `user:` topic and the course's staff topic, never to `classroom:`. Tests: a second student's repository, score and hint, and the source repository's name, searched for in every response and event of the first.

**The journal has its own exit**, the student view of the `journal` module. It is Quiz's first classroom route a student reads, so access has a student branch: `readableClassroom` in `apps/api/src/modules/guards.ts` loads the classroom for the course's staff (`staffAccess`, the staff payload) or for a claimed seat of the caller (the student payload), and answers the 404 of a missing classroom to anyone else. A teacher in the student view (their staff seat, ADR-018) and an impersonation session (ADR-034) get the **student payload**, never the staff one. The student view of ADR-018 is a state of the client, which the server cannot see: the reader asks for the student payload explicitly, by a request parameter that can only narrow the payload to the student's, never widen it; an impersonation session gets the student payload whatever it asks. The student payload has no draft, no page before its `visible_from` (judged by the database's `now()`), no markdown, no blob sha, no warning and no hidden count; an asset is served to a student only when a page of that payload references it (N-SEC-12, N-SEC-13). Tests: a draft, a future page, an asset referenced by them only and the content of a former revision (ADR-057), searched for in every student response, for each of the three student callers.

## 5.8 Export, import, backup

- Export of a pool: zip archive generated on the fly, `pool.yaml`, category folders, `<internal_name>.yaml`, `assets/`. The same function feeds the API, the CLI and the button in the interface.
- Import: validation of each file by the type's schema, `migrate` if `configVersion` is old, error report per file, single transaction, drafts created by default, publication with `--publish`.
- Backup: the `backup` service of heig-classroom, compressed `pg_dump` plus the assets volume, sent every hour to a Hetzner object storage through `rclone`, 30-day retention. Restoration documented and tested on a blank VM. *Amendment (current state, deployment runbook §6): a daily provider backup of the whole VM (Hetzner Backups) and a daily `pg_dump -Fc` kept 30 days on the VM itself. The off-site copy of the logical dumps (`rclone`) is not wired yet (06, question 10).*

## 5.9 Deployment

`compose.prod.yml` reused from heig-classroom: `caddy`, `app`, `postgres`, `backup`, plus `runner` with access to the host's Podman socket. *Amendment (ADR-016, ADR-028): `compose.prod.yml` holds `app`, `postgres` and `backup` only. Caddy is native on the host, not a compose service. The `runner` runs on the VM `code.chevallier.io`, behind its own Caddy, and the API reaches it over HTTPS with a shared token (`RUNNER_TOKEN`). A staging environment runs beside production on the same VM, and production is promoted by sha after approval. The current runbook is `docs/development/deployment.md`.* Keycloak is removed from production. `deploy.sh` refuses an update if an evaluation is `running` or `lobby`, unless `--force`. *Amendment (implemented 2026-09-28): in production only, the evaluations `lobby`, `running`, `paused`, or `scheduled` to open within 15 minutes (or opened less than 12 hours ago), a take-home exercise and a session untouched for 12 hours excepted (`scripts/live-evaluations.sql`); the override is the word `force` in the forced SSH command, sent by the CI when the variable `DEPLOY_FORCE_SHA` names the deployed sha. Runbook §5, *The live-evaluation guard*.* Migrations are additive to allow a rollback to the previous image. *Amendment (ADR-035): with GitHub, the proxy also routes two public, unauthenticated paths to the API, `/webhooks/github` (the webhook intake, 5.11) and `/setup/github/installed` (the App's setup return). The App's key, webhook secret and client secret join the secrets outside the repository and the database (ADR-010); the six `GITHUB_*` variables are absent on a machine without an App, which turns the GitHub features off. Staging has its own App on a test organization, and its refresh from a production dump clears every installation id (N-SEC-18, `docs/merge/03-github-projects.md` §3.4).*

## 5.10 Architecture decisions

| Subject | Decision | Alternative rejected |
|---|---|---|
| Real time | SSE plus REST, data-carrying events for `live`, coalescing, snapshot on connection | WebSocket: reinvents the acknowledgements HTTP gives, with no gain at 100 clients |
| Question type data | JSONB validated by zod, `configVersion` and `migrate` in the package | One table per type: rigid, SQL migrations at every evolution of a type |
| Identifiers | UUID v7 | ULID: same properties, less standard in Postgres |
| Background jobs | pg-boss | BullMQ and Redis: one more component |
| Sandbox | Hardened Podman from the codespace, gVisor if possible | nsjail, isolate: to be reassessed if container start-up gets in the way |
| Frontend | SPA | Server rendering: useless behind an authentication |
| Markdown editor | Tiptap, markdown as the source of truth, WYSIWYG / source toggle | Two separate editors: two sources of truth |
| Diagram | Home-made structured editor, `packages/diagram`, on the grid and router of `circuit` (ADR-046) | Embedded Excalidraw: free-form, no notion of an element or a link, its own style |
| Expert extension | Token REST API, CLI, MCP (shipped: ADR-022, ADR-023) | Outgoing webhooks: no identified consumer |
| Journal storage | Two modes (ADR-057). In Quiz: Postgres is the content, edited with the standard editor, with revisions. In a GitHub repository: the repository is the source of truth, Postgres a rendered read-only copy: no clone, the Trees, Blobs and Contents APIs, rendering once per synchronisation (ADR-035, ADR-049) | Reading GitHub at every page view: a GitHub outage or rate limit would take the course documentation down. Writing the browser's edits into the repository with a byte-exact round trip (D25, superseded): a reconciler and a second editor schema, and GitHub required of a novice |
| Journal HTML | Raw HTML escaped to text, on the server (D15) | The questions' sanitised allow-list: the journal needs none of it, and escaping is safe by construction |
| Project grading | The repository's own CI on the CI runners (ADR-007), the score read from one `GRADE` annotation, the final review dispatched to the same CI (D17) | A tarball at the frozen sha sent to `apps/runner`, and a platform LLM review: phase L, once the platform `llm` module exists |
| Project deadline | The server's receipt time of each push, written synchronously by the webhook intake, and a freeze in two steps (ADR-012, literal) | The commit's date: set by the client, trivially forged |

## 5.11 GitHub, the journal and projects

ADR-035; the plan is `docs/merge/03-github-projects.md` and `docs/merge/04-journal.md`. The substrate and the journal come first; projects close the section.

**Two modes** (ADR-057, D29). A journal **in Quiz** (`mode = 'quiz'`, the default) needs no App: its routes work on a platform without the `GITHUB_*` variables, the database holds its content, and the paragraphs below on the App, the webhook and ingestion do not concern it. A journal **in a GitHub repository** (`mode = 'github'`) is what this section describes, read-only in the platform. Changing mode is an action (Move to GitHub, Bring back into Quiz), never a toggle; writes are frozen while it runs.

**Quiz's GitHub App** (D23). One App per environment, Quiz's own, never heig-classroom's: production, and staging on a test organization. The adapters live in `apps/api/src/github/` (App client, installation tokens cached in memory, throttled Octokit whose background jobs wait out a rate limit once while HTTP reads fail fast). Without the six `GITHUB_*` variables the App is absent: the GitHub routes answer 404, the jobs skip, and boot and `/healthz` are unaffected.

**Connecting a classroom** (F-GH-01 to F-GH-04). `GET /app/api/github/orgs` lists the organizations where the App is installed; `GET|PUT|DELETE /app/api/classrooms/:id/github` reads the link with its checks, connects and disconnects, staff only through `staffAccess`. Installing goes through GitHub's `installations/new?state=<classroomId>`; GitHub returns to `/setup/github/installed`, which verifies the installation with the App's JWT, stores the organization, and sends the teacher back to the classroom; an SSE hint turns the status green. The setup return links nothing by itself: `state` only says where to return, and the classroom is connected by the `PUT`, under `staffAccess`. Opening the link heals it lazily: a missing installation resolved, an uninstalled organization re-checked, a null or `free` plan refreshed, the organization secret probed.

**Account linking** (F-GH-05). The App's user-to-server authorisation: a signed state cookie of ten minutes, the code exchanged, `GET /user` read, the token discarded. `/app/auth/github/{link,callback,unlink}`; a clash on `github_user_id` returns `?github=conflict`. A rename is followed through the immutable id and audited.

**Webhook intake.** `POST /webhooks/github`, with a raw-body parser scoped to that route: the HMAC over the raw body in constant time (401), deduplication on `X-GitHub-Delivery` (the `webhook_deliveries` primary key), the synchronous receipt hook for the repositories that need one (projects' push receipts), then one `github.webhook` job, and 200. The worker dispatches through a **handler registry**: the `github` module handles `installation`, `organization` and `repository` events itself, and the modules that care register their handlers (`onEvent`, `onReceipt`) — the journal registers a handler for `push` and `repository` on its repositories; `github` never imports them. A delivery whose handling failed keeps its error; the reconciliation re-enqueues local deliveries left unprocessed and asks GitHub to redeliver its recent failures.

**Ingestion.** `journal.ingest` for one classroom's journal: list the tree under the root folder, fetch the changed blobs, re-render every page (links depend on their neighbours), upsert and delete pages, download the changed referenced assets and drop the unreferenced ones, set `last_commit_sha` and `sync_status = ok`, then an SSE hint `journal` on the classroom's topic. A push whose `after` equals `last_commit_sha` is skipped. Every ingestion — webhook, Refresh, the one after a browser write — goes through the queue or under an advisory lock per journal row, and the copy is written in one transaction (fix J2); the queue's policy is chosen at its creation and mirrored by the in-process queue of development (a `singletonKey` alone dedupes nothing, #273). A renamed repository is followed; a deleted one sets `sync_status = error` and keeps the pages.

**Writes, in Quiz mode only** (ADR-057). A save carries the page `version` the editor opened: a stale one is a `409 conflict`, never a merge, and the teacher's draft stays in the browser. In one transaction it writes the markdown, re-renders the page (and its neighbours' student HTML when a link target changes), recomputes `asset_paths`, records a revision and bumps `version`. An asset is stored under a relative path beside its page, its sha256 as `blob_sha`. A GitHub-mode journal is never written from the browser: the page and asset write routes answer it with a refusal, and the staff payload carries each page's "Edit on GitHub" URL (`https://github.com/<full_name>/edit/<ref>/<root_path>/<path>`). The App writes into a journal repository only to create it (a seed `README.md`) and for Move to GitHub, into a new or empty repository: creation never adopts an existing one (ADR-049, point 6). Commits are authored as the teacher.

**Periodic work**, claim and enqueue only: the delivery reconciliation and the purge of delivery payloads older than 30 days are scheduled tasks (5.4, Clock; D10), visible to the administrator; the sweep every 60 s that emits the `journal` hint when a page's `visible_from` passes (fix J4) is a clock-bound task of the ticker, since a page's visibility is a date and must not depend on an admin setting.

**Routes** of the journal, base `/app/api/classrooms/:id/journal`, every body and payload a schema of `packages/contracts/src/journal.ts`, portal sessions only (ADR-027: never a `seb` session): `GET` (tree, home path, repository), `GET pages/*`, `GET assets/*` (both roles, `readableClassroom`); staff: `POST` (create), `POST use` (choose a repository of the organization, heig-classroom's `attach`), `DELETE` (remove), `POST refresh` (GitHub mode), `POST preview`, and in Quiz mode only `PUT pages/*` (save with `version`), `POST pages`, `DELETE pages/*`, `POST assets/*`; with ADR-057, the revisions of a page and their restore, reorder and move (Quiz mode), Move to GitHub and Bring back into Quiz (task cards M4-08 to M4-12). Every staff write is audited (`journal.*`); an impersonation session never writes.

**Projects** (F-PROJ). The `project` module drives GitHub through the adapters of `apps/api/src/github/` and registers on the `github` module's registry: a synchronous **receipt** hook for the pushes to its repositories (`push_receipts`, the deadline's reference, ADR-012), and handlers for `push` (a student's head, a protected-file restore, the source ahead), `workflow_run` (the score pipeline), `pull_request` on `sync/*`, `member` (an invitation accepted) and `repository`. One ingestion path, `ingestCompletedRun`, serves the webhook and the reconciliation (ADR-011). Queues `project.deadline`, `project.sync`, `project.dispatch`, each with its policy chosen at creation (#273). The ticker's project tasks run every 20 s on the 1-s loop and **claim and enqueue only, never call GitHub** (invariant 5): scheduled publication (with the group guard), deadlines due, the day-before reminder, the definitive freeze, the review dispatch, the checkpoints. `reconcile.grades` and `reconcile.repos` join the scheduled tasks (D10). Without an App the tasks skip, with no retry loop. Every write to a student repository is the App's (`<slug>[bot]`), with an installation token handed to git through the environment only (invariant 15); a push by the App is recognised by its sender, and heig-classroom's bot is recognised too for the commits it made before the cutover.

**Routes** of projects, every body a schema of `packages/contracts/src/project.ts`: staff `GET|POST /app/api/classrooms/:id/projects`, `GET|PATCH|DELETE /app/api/projects/:pid`, `POST /app/api/projects/:pid/{publish,archive,unarchive,sync,release}`, the repository actions `POST …/repos/:rid/{lock,unlock,grade-now}` and `PATCH …/repos/:rid/score`, the runs of a repository, the checkpoints, the groups and the organization's repository browser, all behind `staffAccess` on the classroom's course; student `POST /app/api/student/projects/:pid/accept`, the invitation resend, and the project rows of the student's classroom payloads. Every staff write is audited (`project.*`, `project_repo.*`, `project_group.*`, `project_checkpoint.*`); Accept is refused to an impersonation and a delegated session (ADR-034, ADR-027).
