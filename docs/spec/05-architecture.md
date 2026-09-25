# 5. Architecture

Goal: a single VM, a single database, one repository, operable by one person. Every choice favours simplicity over generality.

**Starting point: the `~/heig-classroom` repository**, same author, same stack, in production. Its ADRs 001 to 010 apply here. What is reused, adapted or dropped is detailed in [07-reutilisation-heig-classroom.md](07-reutilisation-heig-classroom.md).

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

## 5.2 Code modularity

### Principle

Modular monolith, ADR-001 of heig-classroom: a single API process, a single deployment, but a strict split into modules that know each other only through their exported services. Question types are packages outside the core, with a single contract.

### Repository

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
    canonical/           YAML format, import / export, GIFT and Moodle XML converters
    ui/                  design system: tokens, primitives, quiz components
    qt-mcq/ qt-short/ qt-cloze/ qt-code/ qt-rich/ ...   one package per type
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
| `stats` | Item analysis per version, aggregates for the pool, phase 2 | `results` |
| `llm` | Providers, keys, prompt templates, call log, generation | `auth` |
| `runner` | HTTP client of the runner service, queue and priorities | |
| `drill` | Cards, FSRS, sessions, phase 2 | `pool`, `results` |
| `canonical` | Import / export, API and CLI | `pool` |
| `admin` | Users, health, settings, audit | all, read-only |
| `realtime` | Event bus, SSE streams, presence, topics | |

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
  src/grade.ts      grade(), defaultPoints(), toStudent(), randomize()
  src/server.ts     export const mcqServer: QuestionTypeServer
  src/Editor.tsx  src/Player.tsx  src/Review.tsx  src/Stats.tsx
  src/client.tsx    export const mcqClient: QuestionTypeClient
  src/canonical.ts  toCanonical(), fromCanonical()
  src/*.test.ts
```

`packages/core` defines the two interfaces and two registries, `serverRegistry` and `clientRegistry`, fed by static imports. Adding a type amounts to creating the package and registering it in both registries. The client registry loads the components on demand through `React.lazy`, so that the code player does not weigh on a multiple-choice quiz.

**Evolving a type's schema without an SQL migration.** Every JSONB configuration carries `configVersion`. The package exposes `migrate(config, fromVersion)`, which upgrades an old configuration to the current version. The API applies `migrate` on read, the draft is rewritten at the current version on the next save, published versions stay stored as they are and are migrated on the fly. No table moves when a type evolves.

### Extension interfaces for the expert

- **Public REST API** under `/api/v1`, authenticated by a personal token created in the settings, scope limited to the teacher's pools: list, read, create a draft, publish, export, import. Documented by OpenAPI generated from the zod schemas.
- **CLI** `quiz` in `packages/cli`: `quiz pull <pool> ./dir` writes the pool as YAML, `quiz push ./dir` creates drafts or publishes with `--publish`, `quiz diff` compares the folder and the server. Lets one version questions in git and edit them in one's own editor.
- **MCP server** in phase 3, exposing the same operations as the API to an LLM client.

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
| `sessions` | `sid_hash` pk, `user_id`, `expires_at` | |
| `api_tokens` | `user_id`, `token_hash`, `label`, `scopes` text[], `last_used_at`, `expires_at` | Expert, API and CLI |
| `courses` | `name`, `code` | |
| `course_staff` | `course_id`, `user_id` | composite pk |
| `course_pools` | `course_id`, `pool_id` | composite pk |
| `classrooms` | `course_id`, `name`, `period`, `join_code` unique nullable, `archived_at` | |
| `enrollments` | `classroom_id`, `user_id`, `time_bonus_percent` int default 0, `note` | unique (classroom, user) |
| `audit_log` | `actor_id`, `action`, `target_type`, `target_id`, `details` jsonb | Closed catalogue of actions |

**Pool**

| Table | Key columns | Notes |
|---|---|---|
| `pools` | `name`, `visibility` private / shared / public, `owner_id` | |
| `pool_members` | `pool_id`, `user_id`, `role` reader / contributor / owner | Phase 2 |
| `categories` | `pool_id`, `parent_id` nullable, `name`, `position` | Tree by parent |
| `questions` | `pool_id` nullable (an unsaved poll question, ADR-014 addendum), `category_id` nullable, `type` text, `internal_name`, `difficulty` smallint 1 to 5, `shuffleable` bool, `randomizable` bool, `origin_question_id` nullable, `deleted_at` | Stable metadata |
| `question_tags` | `question_id`, `tag` text | composite pk, index on `tag`. No `tags` table: tags are normalised strings, the distinct list comes from a query |
| `question_versions` | `question_id`, `number` int nullable, `config` jsonb, `config_version` int, `explanation` text, `search` generated tsvector, `published_at`, `published_by`, `change_note`, `deprecated_at`, `deprecation_note` | unique (question_id, number). `number` null = draft, a single one per question thanks to a partial unique index `WHERE number IS NULL` |
| `assets` | `owner_id`, `pool_id`, `sha256`, `mime`, `bytes`, `width`, `height`, `path` | Deduplicated by hash. Referenced in the markdown by `asset:<id>` |
| `question_version_assets` | `version_id`, `asset_id` | For export and cleanup |

**Evaluation**

| Table | Key columns | Notes |
|---|---|---|
| `evaluations` | `classroom_id`, `title`, `mode` exam / exercise / poll, `state`, `settings` jsonb, `grading_scale` jsonb, `feedback_policy` jsonb, `opens_at`, `closes_at`, `duration_s`, `access_code`, `ip_allowlist` text[], `released_at`, `released_grades` jsonb, `modified_after_release` bool | `settings` validated by a schema from `contracts`: navigation, presentation, shuffling, waiting room |
| `evaluation_items` | `evaluation_id`, `position`, `question_version_id`, `points` numeric, `milestone` bool | unique (evaluation, position). Frozen copy of `question_version_id` |
| `attempts` | `evaluation_id`, `user_id`, `attempt_number` int (1, then n + 1 per retake), `state`, `seed` int, `started_at`, `deadline_at`, `bonus_s` int, `submitted_at`, `closed_at`, `closed_by` server / student / teacher, `last_position` int | unique (evaluation, user, attempt_number); partial unique (evaluation, user) `WHERE state IN ('not_started', 'in_progress')`: one unfinished attempt per student (ADR-025). One attempt per student except on an `exercise` with retakes (F-EVAL-15). Partial index `(deadline_at) WHERE state = 'in_progress'` for the ticker |
| `answers` | `attempt_id`, `item_id`, `payload` jsonb, `revision` int, `marked_done` bool (validated: "Validate and continue", a crossed checkpoint), `skipped` bool ("I won't answer"), `flagged` bool (review flag), `first_seen_at`, `updated_at` | unique (attempt, item). The payload is validated by the type's `answerSchema`. An accepted answer that holds something clears `skipped` (issue #89) |
| `attempt_events` | `attempt_id`, `kind` visibility / focus / ip_change / reconnect / time_added / paused, `at`, `details` jsonb | Light anti-cheat and support log |
| `guest_participants` | `evaluation_id`, `pseudonym`, `token_hash` | `poll` mode without an account, phase 2. A guest has an `attempts` row with `user_id` null and `guest_id` |

**Grading and results**

| Table | Key columns | Notes |
|---|---|---|
| `gradings` | `answer_id`, `points` numeric, `max_points` numeric, `source` auto / llm / manual, `state` proposed / validated / superseded, `details` jsonb, `confidence` low / medium / high nullable, `comment` text, `graded_by` nullable, `graded_at`, `supersedes_id` nullable, `regrade_note` text | Partial unique index `(answer_id) WHERE state = 'validated'`. `details`: verdict per test case, points per criterion, matcher match |
| `answer_flags` | `answer_id`, `user_id`, `reason`, `resolved_at` | Student flag, phase 2 |
| `llm_calls` | `user_id`, `purpose` grade / generate / explain / variant, `provider`, `model`, `input_tokens`, `output_tokens`, `cost_estimate`, `duration_ms`, `ok`, `error` | Never the content of the prompts |

**Drill**, phase 2

| Table | Key columns | Notes |
|---|---|---|
| `drill_cards` | `user_id`, `question_id`, `stability`, `difficulty`, `due_at`, `reps`, `lapses`, `last_review_at`, `enabled` | unique (user, question) |
| `drill_reviews` | `card_id`, `rating` 1 to 4, `elapsed_ms`, `reviewed_at`, `answer_payload` jsonb | History for recomputing the parameters |

**Infrastructure**: the `pgboss` schema managed by pg-boss, a `settings` table with jsonb key / value pairs for the global settings, `providers` for the LLM providers with an encrypted key.

### Critical queries and indexes

| Need | Query | Index |
|---|---|---|
| Autosave | `UPDATE answers SET payload, revision WHERE attempt_id = ? AND item_id = ? AND revision < ?` | composite unique pk |
| Deadline ticker | `UPDATE attempts SET state = 'expired' WHERE state = 'in_progress' AND deadline_at + interval '3 s' <= now() RETURNING id` | partial on `deadline_at` |
| Dashboard grid | join `attempts` × `evaluation_items` left `answers` left validated `gradings`, one evaluation | `answers(attempt_id)`, `gradings(answer_id) WHERE validated` |
| Search in the pool | `tsvector` on `internal_name`, statement extracted from the config by the type, tags | GIN on `search`, index on `question_tags(tag)` |
| Latest published version | `SELECT ... WHERE question_id = ? AND number IS NOT NULL ORDER BY number DESC LIMIT 1` | `(question_id, number desc)` |
| Item statistics | aggregate on validated `gradings` joined to `evaluation_items` by `question_version_id` | `evaluation_items(question_version_id)` |

### Transactions

- Publishing a version: in one transaction, check the draft, compute `number = max + 1`, insert, reset the draft. The unique index protects against double publication.
- Starting an attempt: `INSERT ... ON CONFLICT DO NOTHING` then read, which makes a double click idempotent. `deadline_at` is computed at insertion from `duration_s`, the bonus and the mode.
- Releasing the results: one transaction computes every grade, writes `released_grades` and `released_at`, logs to the audit.

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

### Autosave

`PUT /attempts/:id/answers/:itemId` with `{ payload, revision, clientTs }`. The client increments `revision` locally at every change, groups over 300 ms, and never has more than one request in flight per item: the next one waits, with the latest payload. The server writes if `revision` exceeds the revision in the database; otherwise it returns the current revision and the payload from the database, which the client adopts. Response: `{ revision, serverNow }`. On a network failure, retry with exponential backoff capped at 5 s, "offline" indicator after 3 s without acknowledgement.

### Presence

The `realtime` module keeps `topic → connections` in memory. Opening and closing an SSE stream emit `dashboard.presence`. A connection that receives no `clock` for 30 s on the client side triggers a reconnection. The server closes inactive streams after 60 s when no write is possible. Should the API one day run in several processes, the bus would go through `LISTEN / NOTIFY`, ADR-005.

## 5.5 Runner

Internal HTTP service, not exposed, called by the API.

```
POST /run
{ language, files: [{ name, content }], compileArgs, cases: [{ stdin, timeMs }], limits, action }
→ { compile: { ok, stdout, stderr, ms }, cases: [{ exitCode, stdout, stderr, ms, timedOut, oom }] }
```

- One image per language, built from `apps/runner/images/`, derived from the codespace's `c-dev` without code-server. Rebuilt every week.
- **`spice` is a language of the runner**: an Alpine image with ngspice, for the `circuit` question type (ADR-019). It is one image, one run plan and the same hardened container as the others — no flag is relaxed for it, no environment variable is added. Nothing is built: a netlist is the program, so `compile` is the "nothing to do" answer and a malformed netlist is a FAILED CASE, not a compile error.
- **In `spice`, the case's `args` carry the file to simulate.** One request holds one schematic and its stimuli: one file per stimulus (`s0.cir`, `s1.cir`, …) and one case per stimulus, named after it, with `args: ["s0.cir"]`. The argv is therefore `timeout -s KILL <s> ngspice -b s0.cir`, and one container serves every stimulus of one answer. The other languages name their file in the run plan and use `args` for the program's own `argv[1..]`; this convention is what lets both share `execute.ts` unchanged.
- **`POST /attempts/:id/simulate`** is the student's own run for a type that builds its own request (`QuestionTypeServer.interactiveRequest`): the API forces `priority: "interactive"`, counts it against the question's budget in the attempt journal, and hands the `RunnerOutcome` back raw. It is generic — the live module knows nothing of netlists.
- Each request creates a container with the options of the codespace's `run-hardened.sh`: `--network none`, `--read-only`, `--tmpfs /work:size=32m`, `--memory`, `--cpus 1`, `--pids-limit 64`, `--userns=auto`, `--cap-drop ALL`, `--security-opt no-new-privileges`, seccomp profile `codespace.json`, and `--runtime runsc` if gVisor is installed. The wall-clock time is enforced by the service, which kills the container when it is exceeded.
- Compilation then execution of the cases in the same container, sequentially, each with its own limit.
- Two queues: `interactive` for student runs during an evaluation, `grading` for the final grading, lower priority. Configurable concurrency, 4 by default. Beyond a depth limit, 429 and the client retries.
- The source code is rebuilt on the API side from the template and the editable regions, never taken as-is.
- A `codeimage` question stores its target image IN ITS CONFIG (compact hex encoding, docs/04 §4.9): the teacher runs the reference solution from the editor ("Try the reference solution") and presses "Use as target". Nothing runs at publication; publication only checks that the target fits the image's size and palette (ADR-021).

Alternative evaluated: Piston, a free multi-language runner, isolation by Unix users and cgroups. Kept as a fallback if Podman causes trouble on the VM.

## 5.6 Grading

After closing, the `grading` module enqueues a `grading.evaluation` job, singleton per evaluation (on an `exercise` with retakes, each attempt is also graded alone as soon as it ends, and the results read the KEPT attempt of each student, best or last: ADR-025). The job walks the attempts and, for each answer, calls the type's `grade`. Immediate result: `auto` grading, validated. `pending: 'runner'`: a `grading.runner` job per answer, low-priority queue. `pending: 'llm'`: a `grading.llm` job per answer, `llm` grading proposed. The jobs are idempotent: they check the absence of a validated, non-superseded grading before writing. `grading.progress` informs the teacher. The evaluation's per-type settings reach `grade` through `GradeContext.defaults` (`gradeDefaults`): the MCQ policy an `inherit` question defers to, and negative marking (ADR-026). Every total of an attempt — grade table, CSV, release snapshot, feedback, cards, kept attempt of a retake — is `attemptTotal` of `@quiz/domain`: per-question points are kept signed, the total is floored at 0, and the grade is computed from it.

The `llm` module builds the prompt from a template per purpose, requires a JSON output validated by zod, retries once on invalid JSON, logs into `llm_calls` without the content. Providers: Anthropic SDK and an OpenAI-compatible client behind a common interface. Default model for grading: Claude Opus, for generation: Claude Sonnet, configurable.

## 5.7 Content security

A single point of exit of content towards a student: the type's `toStudent`, called in a `studentView` service of the `live` module, which also removes the internal name, the tags, the difficulty, the explanation, then applies the feedback policy. Tests: for each type, a full configuration passed through `toStudent` contains no forbidden field, tested by a blacklist of keys and by searching for the answer-key values in the serialised output.

## 5.8 Export, import, backup

- Export of a pool: zip archive generated on the fly, `pool.yaml`, category folders, `<internal_name>.yaml`, `assets/`. The same function feeds the API, the CLI and the button in the interface.
- Import: validation of each file by the type's schema, `migrate` if `configVersion` is old, error report per file, single transaction, drafts created by default, publication with `--publish`.
- Backup: the `backup` service of heig-classroom, compressed `pg_dump` plus the assets volume, sent every hour to a Hetzner object storage through `rclone`, 30-day retention. Restoration documented and tested on a blank VM.

## 5.9 Deployment

`compose.prod.yml` reused from heig-classroom: `caddy`, `app`, `postgres`, `backup`, plus `runner` with access to the host's Podman socket. *Amendment (ADR-016): in production the `runner` does not run in this compose file but on the VM `code.chevallier.io`, behind its own Caddy, and the API reaches it over HTTPS with a shared token (`RUNNER_TOKEN`); Caddy is native on the host, not a compose service.* Keycloak is removed from production. `deploy.sh` refuses an update if an evaluation is `running` or `lobby`, unless `--force`. Migrations are additive to allow a rollback to the previous image.

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
| Drawing | Embedded Excalidraw | Home-made canvas |
| Expert extension | Token REST API, CLI, MCP later | Outgoing webhooks: no identified consumer |
