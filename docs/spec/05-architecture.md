# 5. Architecture

Goal: a single VM, a single database, one repository, operable by one person. Every choice favours simplicity over generality.

The current implementation map is [the repository page](../development/repository.md).
The [ADR index](../adr/README.md) holds decision rationale. The classroom
merge is still in progress: [task cards and progress](../merge/README.md)
distinguish implemented components from accepted future work. The original
reuse plan is [historical](07-reutilisation-heig-classroom.md).

## 5.1 Technical stack

| Layer | Choice | Reason |
|---|---|---|
| Language | Strict TypeScript everywhere, pnpm workspaces | A single language, schemas shared client / server |
| Frontend | React 19, Vite, TanStack Query, Tailwind 4 with the tokens and primitives of heig-classroom | SPA, design system already written and proven |
| Markdown editor | Tiptap with markdown extension, KaTeX, image pasting, source toggle | WYSIWYG for the novice, markdown for the expert, a single source of truth: the markdown |
| Code editor | Monaco, loaded on demand | VS Code shortcuts expected |
| Backend | Node (version in root `package.json`), Fastify, Zod, schemas shared with the client through `packages/contracts` | Light, fast, typed |
| Database | PostgreSQL 17, Drizzle ORM, versioned SQL migrations, PGlite for tests | JSONB for configurations and answers, transactions; cross-process event relay remains planned |
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

Use [the repository map](../development/repository.md#the-map) for current
packages. `packages/canonical`, `packages/cli` and `packages/ui-kit` are
accepted future work, not existing packages. Deployment
files live at the repository root; there is no `deploy/` directory.

### API modules

Each module lives in `apps/api/src/modules/<name>/` with `routes.ts` the HTTP handlers, `service.ts` the logic and database access (a module may split its service into cohesive files under its directory, `service.ts` staying the entry other modules import — `live/` does, since 2026-09-23), `events.ts` the events it publishes, `jobs.ts` its pg-boss handlers. A module never imports another module's `routes.ts`. It calls the other modules' `service.ts`.

| Module | Responsibility | Depends on |
|---|---|---|
| `auth` | OIDC, sessions, claims, multi-address identity, global roles | |
| `org` | Courses, classrooms, staff, rosters, accommodations | `auth` |
| `pool` | Pools, categories, questions, versions, drafts, assets, search | `auth`, `core`, `concept` |
| `concept` | The instance-wide vocabulary of concepts (ADR-081): concepts, the resolution of a typed label, proposing and editing; the stop list of `concept_dropped` (`concept_tag_sortings`, the tags dropped in the retired sorting); the links to questions (`question_concepts`) and the resolution of a write naming concepts; aliases, relations and the links to courses come later | `auth` |
| `evaluation` | Configuration of an evaluation, items, lifecycle, settings | `org`, `pool` |
| `live` | Attempts, answers, autosave, presence, clock, live control, deadline ticker | `evaluation` |
| `preview` | The teacher's stateless preview of an evaluation: seed, student view, runs and grading, nothing stored (ADR-018) | `live`, `grading`, `runner` |
| `grading` | Automatic grading, runner, LLM, validation panel, regrading, release | `live`, `runner`, `llm` |
| `results` | Grades, grade scale, CSV exports, statistical views of an evaluation, student feedback | `grading` |
| `stats` | Item analysis per question (ADR-038), the time spent on it (ADR-039) and its discrimination index (ADR-042) and the distractors of a multiple-choice question (ADR-043), aggregates for the pool | `grading`, `evaluation`, `pool` |
| `llm` | Providers, keys, prompt templates, call log, generation | `auth` |
| `runner` | HTTP client of the runner service, queue and priorities | |
| `drill` | Cards, FSRS, sessions, reviews, the teacher's activity and mastery reads (ADR-041) | `org`, `pool`, `evaluation`, `live` (the student view), `results`; registers on `live`'s `onAttemptsEnded` (hand-in) and `results`' `onResultsReleased` (release), which never import it |
| `canonical` | Planned, not present: import / export, API and CLI | `pool` |
| `admin` | Users, health, settings, audit; the admin routes of the scheduled tasks | all, read-only; `system` |
| `system` | The scheduled tasks (D10): their table, the ticker's claim, the `system.task` worker, the instrumented run (5.4, Clock) | |
| `realtime` | Event bus, SSE streams, presence, topics | |
| `github` | Quiz's GitHub App: installations and organizations, the classroom ↔ organization link and its checks, GitHub account linking, the webhook intake and its handler registry, delivery reconciliation (5.11) | `auth`, `org` |
| `project` | Projects (F-PROJ): their lifecycle, the distribution repository, acceptance and provisioning, groups, the score pipeline, deadline, freeze and review dispatch, sync of the source, reconciliation, the staff and student views (5.11) | `org`, `github` (registers its handlers and push receipts on the webhook registry, which never imports it) |
| `gradebook` | A classroom's gradebook (F-GBOOK, ADR-074): its columns' settings, the staff's marks and the published mean (the only things it stores), read from the released results of `results` and `project` through the `ActivityKind` entries (`gradebookEntries`), never recomputed | `org`, `activity` (the registry: `results` and `project` answer through it) |
| `journal` | A classroom's journal in its two modes (ADR-057): in Quiz, the pages, assets and revisions it owns and their writes; in a GitHub repository, ingestion into the read model; rendering through `docrender`, the reader's access (5.11) | `org`, `github` (registers on its webhook registry, which never imports it) |
| `activity` | The activities of every kind where a page lists them together: `ActivityKind` over `KINDS` (evaluations, projects), the student home and classroom cards, the gradebook entries | |
| `poll` | Live polls (F-LIVE-13, F-LIVE-14, ADR-014): an evaluation of mode `poll` with one item, created and started in one call, on the `live` machinery; the brainstorm poll and its AI assistance (ADR-071, ADR-072) | |
| `notifications` | The bell and the channels that leave the platform, e-mail and Microsoft Teams (ADR-030): `notifyMany` the one entry, the recipient's preferences, deliveries as jobs | |
| `group` | A classroom's group sets, their groups and who is in which, formed by hand, at random or by the students (ADR-070) | |
| `codespace` | What Quiz says to the online workspace portal (ADR-047, ADR-078): the signed project sync, the launch token, the git token relay | |
| `kiosk` | The kiosk station registry (ADR-051): attestation, pairing, the station cookie | |
| `legacy` | The resolver of heig-classroom's legacy URLs (merge task M8-02) | |
| `assist` | The teacher assistant (ADR-080, F-LLM-07): a question answered by the gateway with read-only tools | |
| `mcp` | The MCP server's tool catalogue and the in-process client of `/app/api` its tools call through | |
| `changelog` | What's new on the platform (ADR-087): the entries shipped in the build and what each reader has acknowledged | |

**Measured divergences (madge, 2026-10-09).** The column above is the
intended architecture. The code's module graph differs from it; each edge
below is a mismatch to settle, either in the code or in this table by a
decision, not a description of what is accepted. Measured: the other modules
whose code a module's files import at run time (value imports; type-only
imports, tests, the shared `guards.ts` and `http.ts`, and the packages
aside); edges to `realtime`, through which every module publishes (rule 4),
are left out.

- Beyond the modules stated: `org` → `evaluation`, `github`, `journal`, `notifications`, `pool`, `project`; `pool` → `concept`, `live`, `llm`, `notifications`, `stats`; `concept` → `llm`; `evaluation` → `concept`, `live`, `notifications`; `live` → `auth`, `grading`, `pool`, `results`, `runner`; `preview` → `evaluation`, `pool`; `grading` → `evaluation`, `notifications`, `pool`, `results`; `results` → `evaluation`, `live`, `notifications`, `pool`; `stats` → `live`; `drill` → `concept`, `runner`; `github` → `notifications`, `pool`; `project` → `auth`, `codespace`, `notifications`; `journal` → `auth`, `pool`.
- Where no dependency is stated: `auth` → `codespace`, `kiosk`, `live`, `org`, `project`; `system` → `assist`, `auth`, `drill`, `github`, `live`, `llm`, `notifications`, `poll`, `pool`, `project`, `runner`; `realtime` → `auth`, `live`; `activity` → `auth`, `evaluation`, `group`, `journal`, `live`, `org`, `project`, `results`; `poll` → `evaluation`, `live`, `llm`, `pool`; `notifications` → `auth`; `group` → `project`; `codespace` → `auth`, `github`, `project`; `kiosk` → `auth`, `live`; `assist` → `auth`, `llm`, `mcp`; `mcp` → `auth`, `pool`.

The file-level cycles left are `grading`/`live`/`results` (audit 2026-10-03
A1e), the four files of `system` (its health checks read the scheduled-task
catalog that runs them) and the schema's lazy foreign keys. To regenerate
the module graph: `madge` over `apps/api/src` with `skipTypeImports` and
tests excluded (the madge API, `madge(path, { fileExtensions: ["ts"],
tsConfig: "apps/api/tsconfig.json", detectiveOptions: { ts: { skipTypeImports:
true } }, excludeRegExp: [/\.test\.ts$/] }).obj()`), each file mapped to its
`modules/<name>/` (or `auth/`) directory; the plain cycle count is `npx
madge --circular --extensions ts apps/api/src`.

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

`packages/core` defines the contracts; `packages/registry` owns `serverRegistry` and `clientRegistry`, fed by static imports. Core never imports a question-type package. Adding a type amounts to creating the package and registering it in both registries. The client registry loads the components on demand through `React.lazy`, so that the code player does not weigh on a multiple-choice quiz.

**Evolving a type's schema without an SQL migration.** Every JSONB configuration carries `configVersion`. The package exposes `migrate(config, fromVersion)`, which upgrades an old configuration to the current version. The API applies `migrate` on read, the draft is rewritten at the current version on the next save, published versions stay stored as they are and are migrated on the fly. No table moves when a type evolves.

### Extension interfaces for the expert

- **Token API** uses the same `/app/api` routes and contracts as the SPA.
  The separate `/api/v1` design was rejected (ADR-022).
- **MCP** is implemented at `/app/api/mcp`, with OAuth or a personal token
  (ADR-022/023). Its tools call those same routes as the caller.
- **Canonical import/export and CLI** remain planned (F-EXP, spec 04 §4.2):
  `quiz pull`, `push` and `diff` are intended interfaces, not installed tools.

## 5.3 Database

### Principles

- UUID v7 generated by the application, sortable, generatable client-side.
- Data specific to a question type is in JSONB, validated by the type's zod schema before every write. The core only knows `type`, `config`, `payload`, `details`.
- One table per domain concept, not per question type. Adding a type adds no table.
- Published content is immutable: `question_versions` and `evaluation_items` are never updated after publication, except the status columns.
- Grades are not stored as the source of truth; they are recomputed from `gradings` and frozen at release in `released_grades`.
- Cascading deletion from `classrooms`. Soft deletion of questions through `deleted_at`.

### Tables

The [data model reference](reference/data-model.md) holds detailed fields and
schema intent, including planned tables. Read only the relevant domain block,
but read it before touching its tables: its constraints, single-writer notes
("written only by") and staff-only columns are binding, not illustrative.
Exact implemented declarations are the exports of `apps/api/src/db/schema.ts`;
`apps/api/drizzle/` owns migration history. This chapter keeps cross-module
principles, critical queries and transaction boundaries below.

### Critical queries and indexes

| Need | Query | Index |
|---|---|---|
| Autosave | `UPDATE answers SET payload, revision WHERE attempt_id = ? AND item_id = ? AND revision < ?` | composite unique pk |
| Deadline ticker | `UPDATE attempts SET state = 'expired' WHERE state = 'in_progress' AND deadline_at + interval '3 s' <= now() RETURNING id` | partial on `deadline_at` |
| Dashboard grid | join `attempts` × `evaluation_items` left `answers` left validated `gradings`, one evaluation | `answers(attempt_id)`, `gradings(answer_id) WHERE validated` |
| Search in the pool | `tsvector` on `internal_name`, statement extracted from the config by the type; concepts by id, after a typed `#word` is resolved to every concept it may designate (ADR-081, third addendum §7) | GIN on `search`, `question_concepts` pk and index on `concept_id` |
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
- **Scheduled tasks** (`ScheduledTask`, catalog `SCHEDULED_TASKS` in `apps/api/src/modules/system/catalog.ts`): the minutes-scale housekeeping — `sessions.purge` (10 min), `oauth.purge` (60 min), `poll.end_idle` (1 min), `notifications.deadline_reminders` (1 min), `drill.purge` (6 h), `assist.purge` (24 h, ADR-080 §6), `llm.review` (60 min, working only between 01:00 and 06:00 in Zurich, ADR-060 §5), `llm.domain` (60 min, same night, the bilingual domain of the public pools, ADR-095), `health.checks` (5 min, ADR-055 §5); the GitHub reconciliations join with the tasks that port them (ADR-011). Each module contributes its list; the keys are a closed list of `@quiz/contracts` (`SCHEDULED_TASK_KEYS`). Every 15 s one clock-bound task claims the due ones in ONE conditional UPDATE on the database clock (`enabled`, in the catalog, `last_run_at` null or `last_run_at + interval_minutes <= now()`, and not `running` unless the run is 30 minutes old and taken for dead), setting `last_run_at = now()` and `last_status = 'running'`, and sends each claimed key to the `system.task` queue, whose worker runs it and records the status, the duration, an English summary or the error, and `last_ok_at`. Without a queue the claimed task runs inline, beside the tick and not awaited by it. The claim is the multi-process safety; a restart finds the condition still true and catches up.

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

After closing, the `grading` module enqueues a `grading.evaluation` job over the whole evaluation — one job per request, never deduplicated, since two requests may differ in scope (#273) (on an `exercise`, each attempt is also graded alone as soon as it ends while the exercise runs, whatever its feedback policy, and a reopen stands its automatic gradings down until the next hand-in (ADR-067); an `exam` is graded at its close only; with retakes the results read the KEPT attempt of each student, best or last: ADR-025). The job walks the attempts and, for each answer, calls the type's `grade`. Immediate result: `auto` grading, validated. `pending: 'runner'`: a `grading.runner` job per answer, low-priority queue, worked `GRADING_RUNNER_CONCURRENCY` jobs at a time, one by default (ADR-067). A pending LLM result becomes a `grading.llm` job per answer, worked two jobs at a time per process, producing an `llm` proposal. No model call occurs while the evaluation runs or is paused; a successful proposal is retained except on explicit regrading (ADR-063). The jobs are idempotent: they check the absence of a validated, non-superseded grading before writing. `grading.progress` informs the teacher. The evaluation's per-type settings reach `grade` through `GradeContext.defaults` (`gradeDefaults`): the MCQ policy and the categorize policy (`settings.categorizePolicy`, ADR-036) an `inherit` question defers to, and negative marking (ADR-026), which covers `mcq` and `categorize`. Every total of an attempt — grade table, CSV, release snapshot, feedback, cards, kept attempt of a retake — is `attemptTotal` of `@quiz/domain`: per-question points are kept signed, the total is floored at 0, and the grade is computed from it.

The `llm` gateway accepts a prompt and output schema, validates structured replies, retries once on invalid output, and logs call metadata without content; its `converse()` runs a multi-turn exchange with read-only tools, every provider request metered the same way (the teacher assistant, [ADR-080](../adr/ADR-080-assistant-enseignant.md)). [ADR-058](../adr/ADR-058-passerelle-llm.md) owns provider, encrypted institutional key, model selection and daily budget rules: Anthropic is the implemented provider, Sonnet the default for every purpose. Grading uses `GradingLlm` in the API over this gateway, or the development stub; `@quiz/core` carries only the request/outcome contracts and the availability flag. [ADR-063](../adr/ADR-063-correction-llm.md) owns the grading queue, name masking, attribution, retries and disclosure rules. The justification and `details.ai` stay teacher-only; validation does not copy them into the student comment, while an explicit teacher action may copy the justification. The earlier stub-only path is recorded in ADR-045.

## 5.7 Content security

A single point of exit of content towards a student: the type's `toStudent`, called in a `studentView` service of the `live` module, which also removes the internal name, the concepts, the difficulty, the explanation, then applies the feedback policy (`feedbackGate` of `@quiz/domain` decides WHEN: the policy, the release, and a correction published while an exercise runs, which counts as the release — ADR-050). The class debrief (`GET /evaluations/:id/results/by-question`) is staff-only and served once the evaluation is over or its correction published, over the finished attempts only while it runs (ADR-033, ADR-050). Tests: for each type, a full configuration passed through `toStudent` contains no forbidden field, tested by a blacklist of keys and by searching for the answer-key values in the serialised output. A parameterized question (ADR-056) reaches the student only as an instance (`pool/instance.ts`; `loadConfig` throws on a template): `live/parameters.db.test.ts` sends a full parameterized `mcq`, `short` and `cloze` through the attempt, its reload, the feedback and the preview, and searches the output for every `[[name`, every expression, the condition and the table, and for the student's own instantiated key where the key is not shown.

The key has one student exit too: once the feedback policy shows it (`showKey`), a student reads the type's `toSolution` passed through its optional `studentSolution` hook, in `studentSolutionView` beside `studentView`. The hook drops from the solution what stays the teacher's even under a shown key — the grading criteria of an essay, a short answer's `llm` rubric. Every student-facing reader of a key goes through it (the feedback page, a poll's reveal, the teacher's preview "as a student" and the "Show answers" of a question's preview, which asks for the key on the click only); the teacher's surfaces keep the whole `toSolution` (ADR-037).

**A project has its own exit**, the student view of the `project` module (N-SEC-20): a student reaches a project of a classroom where they hold a claimed seat (through `readableClassroom`'s student branch), and only their own repository or their group's; the payload carries what F-PROJ-15 lists and nothing of the source, the distribution repository, the other repositories, the runs after the deadline nor the staff's flags. A repository's live hints go to the student's `user:` topic and the course's staff topic, never to `classroom:`. Tests: a second student's repository, score and hint, and the source repository's name, searched for in every response and event of the first.

**The gradebook has its own exit** (ADR-074, F-GBOOK-05): the student's cells of a classroom, loaded through `readableClassroom` with the student payload forced, each cell through the student view of its kind — an evaluation's from the Grades page's rows under F-RES-04 (a released grade only where the feedback policy shows it; indicative points, never a grade, before the release), a project's from the release's snapshot of their own seat. It carries no unreleased grade, no source, no teacher comment, no mark of a column not released, nothing of another student; the mean only when the teacher publishes it, the key absent from the JSON otherwise. Tested by searching every student response (student, teacher in the student view, impersonation) for an unreleased grade, a mark's comment and another student's data.

**The journal has its own exit**, the student view of the `journal` module. It is Quiz's first classroom route a student reads, so access has a student branch: `readableClassroom` in `apps/api/src/modules/guards.ts` loads the classroom for the course's staff (`staffAccess`, the staff payload) or for a claimed seat of the caller (the student payload), and answers the 404 of a missing classroom to anyone else. A teacher in the student view (their staff seat, ADR-018) and an impersonation session (ADR-034) get the **student payload**, never the staff one. The student view of ADR-018 is a state of the client, which the server cannot see: the reader asks for the student payload explicitly, by a request parameter that can only narrow the payload to the student's, never widen it; an impersonation session gets the student payload whatever it asks. The student payload has no draft, no page before its `visible_from` (judged by the database's `now()`), no markdown, no blob sha, no warning and no hidden count; an asset is served to a student only when a page of that payload references it (N-SEC-12, N-SEC-13). Tests: a draft, a future page, an asset referenced by them only and the content of a former revision (ADR-057), searched for in every student response, for each of the three student callers.

## 5.8 Export, import, backup

- Export of a pool: zip archive generated on the fly, `pool.yaml`, category folders, `<internal_name>.yaml`, `assets/`. The same function feeds the API, the CLI and the button in the interface.
- Import: validation of each file by the type's schema, `migrate` if `configVersion` is old, error report per file, single transaction, drafts created by default, publication with `--publish`.
- Backup: the `backup` service of heig-classroom, compressed `pg_dump` plus the assets volume, sent every hour to a Hetzner object storage through `rclone`, 30-day retention. Restoration documented and tested on a blank VM. *Amendment (current state, deployment runbook §6): a daily provider backup of the whole VM (Hetzner Backups) and a daily `pg_dump -Fc` kept 30 days on the VM itself. Since 2026-10-09 (#235) the off-site copy is a borg repository on a Hetzner Storage Box, append-only from the VM (ADR-009, amendment of decision 3; runbook §6, The off-site copy).*

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

**Connecting a classroom** (F-GH-01 to F-GH-04). `GET /app/api/github/orgs` lists the organizations where the App is installed; `GET|PUT|DELETE /app/api/classrooms/:id/github` reads the link with its checks, connects and disconnects, staff only through `staffAccess`. Installing goes through GitHub's `installations/new?state=<classroomId>`; GitHub returns to `/setup/github/installed`, which verifies the installation with the App's JWT, stores the organization, and sends the teacher back to the classroom; an SSE hint turns the status green. *Amended 2026-10-06, M3-14 pilot finding 1: the install is a same-tab round trip; the setup return reopens the connect sheet (`/classrooms/<state>/settings?connect=1[&installed=<orgId>]`) with the new organization picked.* The setup return links nothing by itself: `state` only says where to return (`installed` only preselects an organization of the sheet's own list), and the classroom is connected by the `PUT`, under `staffAccess`. Opening the link heals it lazily: a missing installation resolved, an uninstalled organization re-checked, a null or `free` plan refreshed, the organization secret probed.

**Account linking** (F-GH-05). The App's user-to-server authorisation: a signed state cookie of ten minutes, the code exchanged, `GET /user` read, the token discarded. `/app/auth/github/{link,callback,unlink}`; a clash on `github_user_id` returns `?github=conflict`. A rename is followed through the immutable id and audited.

**Webhook intake.** `POST /webhooks/github`, with a raw-body parser scoped to that route: the HMAC over the raw body in constant time (401), deduplication on `X-GitHub-Delivery` (the `webhook_deliveries` primary key), the synchronous receipt hook for the repositories that need one (projects' push receipts), then one `github.webhook` job, and 200. The worker dispatches through a **handler registry**: the `github` module handles `installation`, `organization` and `repository` events itself, and the modules that care register their handlers (`onEvent`, `onReceipt`) — the journal registers a handler for `push` and `repository` on its repositories; `github` never imports them. A delivery whose handling failed keeps its error; the reconciliation re-enqueues local deliveries left unprocessed and asks GitHub to redeliver its recent failures.

**Ingestion.** `journal.ingest` for one classroom's journal: list the tree under the root folder, fetch the changed blobs, re-render every page (links depend on their neighbours), upsert and delete pages, download the changed referenced assets and drop the unreferenced ones, set `last_commit_sha` and `sync_status = ok`, then an SSE hint `journal` on the classroom's topic. A push whose `after` equals `last_commit_sha` is skipped. Every GitHub-mode ingestion — webhook, Refresh or initial repository creation — goes through the queue or under an advisory lock per journal row, and the copy is written in one transaction (fix J2); the queue's policy is chosen at its creation and mirrored by the in-process queue of development (a `singletonKey` alone dedupes nothing, #273). A renamed repository is followed; a deleted one sets `sync_status = error` and keeps the pages.

**Writes, in Quiz mode only** (ADR-057). A save carries the page `version` the editor opened: a stale one is a `409 conflict`, never a merge, and the teacher's draft stays in the browser. In one transaction it writes the markdown, re-renders the page (and its neighbours' student HTML when a link target changes), recomputes `asset_paths`, records a revision and bumps `version`. An asset is stored under a relative path beside its page, its sha256 as `blob_sha`. A GitHub-mode journal is never written from the browser: the page and asset write routes answer it with a refusal, and the staff payload carries each page's "Edit on GitHub" URL (`https://github.com/<full_name>/edit/<ref>/<root_path>/<path>`). The App writes into a journal repository only to create it (a seed `README.md`) and, once M4-11 is implemented, for Move to GitHub, into a new or empty repository: creation never adopts an existing one (ADR-049, point 6). Commits are authored as the teacher.

**Periodic work**, claim and enqueue only: the delivery reconciliation and the purge of delivery payloads older than 30 days are scheduled tasks (5.4, Clock; D10), visible to the administrator; the sweep every 60 s that emits the `journal` hint when a page's `visible_from` passes (fix J4) is a clock-bound task of the ticker, since a page's visibility is a date and must not depend on an admin setting.

**Routes** of the journal, base `/app/api/classrooms/:id/journal`, every body and payload a schema of `packages/contracts/src/journal.ts`, portal sessions only (ADR-027: never a `seb` session): `GET` (tree, home path, repository), `GET pages/*`, `GET assets/*` (both roles, `readableClassroom`); staff: `POST` (create), `POST use` (choose a repository of the organization, heig-classroom's `attach`), `DELETE` (remove), `POST refresh` (GitHub mode), `POST preview`, and in Quiz mode only `PUT pages/*` (save with `version`), `POST pages`, `DELETE pages/*`, `POST assets/*`; Quiz-mode history uses `GET revisions/*`, `GET revision/:revisionId`, `GET deleted` and `POST restore`. Reorder/nesting and mode switches are accepted but pending (ADR-057, task cards M4-10 to M4-12), not current routes. Every staff write is audited (`journal.*`); an impersonation session never writes.

**Projects** (F-PROJ). The `project` module drives GitHub through the adapters of `apps/api/src/github/` and registers on the `github` module's registry: a synchronous **receipt** hook for the pushes to its repositories (`push_receipts`, the deadline's reference, ADR-012), and handlers for `push` (a student's head, a protected-file restore, the source ahead), `workflow_run` (the score pipeline), `pull_request` on `sync/*`, `member` (an invitation accepted) and `repository`. One ingestion path, `ingestCompletedRun`, serves the webhook and the reconciliation (ADR-011). Queues `project.deadline`, `project.sync`, `project.dispatch`, each with its policy chosen at creation (#273). The ticker's project tasks run every 20 s on the 1-s loop and **claim and enqueue only, never call GitHub** (invariant 5): scheduled publication (with the group guard), deadlines due, the day-before reminder, the definitive freeze, the review dispatch, the checkpoints. *As built for the deadline (M3-05a, [ADR-064](../adr/ADR-064-echeance-des-projets-baux.md)):* everything is per repository, on its **effective deadline** (its own, set by the staff, else the project's; `coalesce(project_repos.deadline_at, projects.deadline_at)`); the task `project.deadlines` publishes the scheduled drafts through `publishProject`, locks the projects due, writes each repository's provisional freeze at its effective deadline and its definitive one at that deadline plus the grace, all as conditional writes on the server's clock, then takes the **lease** (`projects.deadline_job_at`, free or ten minutes old) of every project whose repositories need GitHub work — what GitHub should hold (the staff's hand `staff_lock`, else the deadline's lock) differs from what it holds (`locked_at`), or a deadline commit is due — and sends one `project.deadline` job, which settles them four at a time, re-reading each row before each step, renews the lease after each repository (stopping when another job took it over), and gives it back. A failed job backdates its lease so that the work is claimed again some 30 s on (N-PERF-07), a crashed one leaves it to expire, ten minutes after its last renewal; a job whose lease is no longer the row's does nothing. Without a queue the tick claims no GitHub work (a job never runs in the ticker's process); a staff action runs it in its request. A repository takes deadline work only when provisioned, not deleted, and its project not archived. `reconcile.grades` and `reconcile.repos` join the scheduled tasks (D10). Without an App the tasks skip, with no retry loop. Every write to a student repository is the App's (`<slug>[bot]`), with an installation token handed to git through the environment only (invariant 15); a push by the App is recognised by its sender, and heig-classroom's bot is recognised too for the commits it made before the cutover. *As built for the sync (M3-07, [ADR-073](../adr/ADR-073-synchronisation-de-la-source.md)):* the staff's `POST …/sync` takes a third lease (`projects.sync_job_at`, never the ticker's to claim), updates the distribution repository in the request (a rewritten source under `whole` is refused there, `409 source_rewritten`), records the source's shas handed out and sends one `project.sync` job, which pushes `sync/<branch>` to every live repository not locked nor past its effective deadline — the distribution's head recorded as a bot commit first — and opens or comments ONE pull request per branch where a file differs; the outcomes are stored per repository, the source is no longer "ahead" only when nothing failed and no push landed meanwhile. The `pull_request` handler keeps the App's pull requests' state; the source push handler marks every non-archived project of the source ahead, with the commits counted.

**Routes** of projects, every body a schema of `packages/contracts/src/project.ts`: staff `GET|POST /app/api/classrooms/:id/projects`, `GET|PATCH|DELETE /app/api/projects/:pid`, `POST /app/api/projects/:pid/{publish,archive,unarchive,sync,release}`, the repository actions `POST …/repos/:rid/{lock,unlock,grade-now}`, `PUT …/repos/:rid/deadline` (a repository's own deadline, M3-05a) and `PATCH …/repos/:rid/score`, the runs of a repository, the checkpoints, the groups and the organization's repository browser, all behind `staffAccess` on the classroom's course; student `POST /app/api/student/projects/:pid/accept`, the invitation resend, and the project rows of the student's classroom payloads. Every staff write is audited (`project.*`, `project_repo.*`, `project_group.*`, `project_checkpoint.*`); Accept is refused to an impersonation and a delegated session (ADR-034, ADR-027).
