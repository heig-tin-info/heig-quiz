# Repository layout

One pnpm workspace, TypeScript end to end. Three applications under `apps/`,
the shared code under `packages/`, and everything else at the root. The
schema, the module boundaries and the real-time design are settled in the
[architecture chapter](../spec/05-architecture.md) of the specification; this
page tells you where to find things and which rules a change must respect.

## The map

```
apps/
  api/        Fastify: modules, SSE, jobs, ticker, Drizzle schema + migrations
  web/        React SPA (Vite, Tailwind, TanStack Query)
  runner/     code execution in hardened Podman containers (@quiz/runner)
packages/
  core/       the QuestionType contract, the seeded RNG, the runner interface
  registry/   the two static question-type registries (./server, ./client)
  contracts/  zod schemas and payload types shared api <-> web
  domain/     pure business rules: grade scale, deadlines, policies, cloze, roster
  ui/         the shared primitives of the question-type surfaces (@quiz/ui)
  qt-mcq/     question type: multiple choice
  qt-short/   question type: short answer
  qt-cloze/   question type: fill in the blanks
  qt-code/    question types: code graded by the runner, and its variant
              codeimage graded pixel by pixel
  qt-circuit/ question type: two-port schematic, graded by ngspice simulation
docs/
  guide/      the user guide
  spec/       the product specification
  adr/        the architecture decision records
  development/  these pages
  assets/     the screenshots of the guide, light and dark
infra/
  keycloak/   the development realm imported by docker-compose.dev.yml
scripts/      smoke.sh, the end-to-end HTTP walk; staging-export.sh and
              staging-refresh.sh
```

`CLAUDE.md` keeps the authoritative version of this map, with a paragraph on
each package that needs one.

At the root: `Dockerfile` (the application image), `apps/runner/Dockerfile`
(the runner image), `compose.prod.yml`, `compose.staging.yml`, `Caddyfile`,
`Caddyfile.staging` and `deploy.sh` for production and staging (the runbook
is the [deployment page](deployment.md); the root `deploy.md` points to it); `docker-compose.dev.yml` for the optional
development services; `zensical.toml` for this site; `CLAUDE.md` for the
working conventions and the invariants.

## Applications

### `apps/api`

The Fastify monolith ([ADR-001](../adr/ADR-001-monolithe-modulaire.md),
[ADR-002](../adr/ADR-002-stack-backend-fastify.md)). `src/server.ts` loads
the configuration (`src/config.ts`, a zod schema validated at startup),
applies the migrations, builds the app (`src/app.ts`) and starts the ticker
and the jobs. The modules live under `src/modules/`, the schema under
`src/db/`, the migrations under `drizzle/`, the seed under `src/seed/`.

`src/app.ts` also serves `/healthz` and `/metrics`, described on the
[deployment page](deployment.md#7-monitoring).

### `apps/web`

The React single-page application ([ADR-008](../adr/ADR-008-frontend-spa-react.md)),
built with Vite. `src/router.ts` is the route union, `src/api.ts` the typed
client over the contracts, `src/i18n/` the dictionaries, `src/mock/` the
in-browser API used by `pnpm dev:mock`. Feature directories (`pool`,
`question`, `evaluation`, `live`, `attempt`, `grading`, `results`,
`student`, `poll`, `preview`, `notifications`, `oauth`, `coach`, `help`,
`realtime`, `runner`, `markdown`) hold the screens and their tests;
`src/ui/` holds the generic primitives. The
design rules are in `apps/web/DESIGN.md`, and `.claude/skills/quiz-ui/SKILL.md`
is the checklist a screen goes through before it is declared finished.

### `apps/runner`

The code execution service: Fastify on :3200, `POST /run` and
`GET /health`, one hardened container per request driven over the Podman
socket. It depends on `@quiz/core` only. `apps/runner/README.md` documents
the flags of every container, the request lifecycle, the images under
`images/` and the configuration knobs. Its own image
(`apps/runner/Dockerfile`) ships no engine, only the `podman-remote` client.

## Packages

| Package | Entry points | What it holds |
| --- | --- | --- |
| `@quiz/core` | `./server`, `./client`, `./rng` | the `QuestionTypeServer` and `QuestionTypeClient` contracts, the `GradeResult` union, the seeded RNG, the `Runner` interface and its request/outcome types |
| `@quiz/registry` | `./server`, `./client` | the two static maps from a question-type id to its implementation |
| `@quiz/contracts` | `.` | one zod schema per route and per SSE event, and the payload types both sides import |
| `@quiz/domain` | `.`, `./<file>` | pure functions with unit tests: the Swiss grade scale, deadlines and time bonus, the MCQ scoring policies, the cloze parser, the roster import, output comparison, stats, pseudonyms |
| `@quiz/ui` | `.` | the shared primitives of the question-type surfaces (React as a peer, `@quiz/core` its only dependency; it never imports a `qt-*` package nor `apps/web`) |
| `@quiz/qt-mcq`, `qt-short`, `qt-cloze` | `./server`, `./client` | one question type each: config schema, canonical form, grading on the server; Editor, Player and Review components on the client |
| `@quiz/qt-code` | `./server`, `./client` | two types sharing one program half: `code`, graded by the runner's test cases, and `codeimage`, judged by the picture its stdout draws ([ADR-021](../adr/ADR-021-codeimage-variante-de-code.md)) |
| `@quiz/qt-circuit` | `./server`, `./client`, `./canvas` | `circuit`, a two-port schematic graded by simulating it with ngspice through the runner's `spice` language ([ADR-019](../adr/ADR-019-simulation-de-circuit.md)); `./canvas` is the schematic editor |

### Server and client halves

`@quiz/core/server` contains no React anywhere and is what the API imports.
`@quiz/core/client` describes the browser half of the contract; React
appears there as type-only imports, which `verbatimModuleSyntax` erases, so
the client entry adds no runtime dependency either. Every `qt-*` package
follows the same split: `server.ts` exports the grading and the `toStudent`
projection, `client.tsx` exports the lazy components.

### The registries

`packages/registry` is the one place the API and the web app learn which
question types exist. `src/server.ts` maps `mcq`, `short`, `cloze`,
`code`, `circuit` and `codeimage` to their `*Server` objects; `src/client.ts` does the same for the
components. Registering a type is an import and an entry in each map. The
registry depends on `core` and on the `qt-*` packages; nothing inside `core`
may depend on the registry, or the package graph would cycle (decision D1
in the [MVP plan](../PLAN-MVP.md)).

## API conventions

### Modules

A module is a directory `apps/api/src/modules/<name>/` built around four
files (a module may split its service into cohesive files under its
directory; `service.ts` stays the entry other modules import):

| File | Role |
| --- | --- |
| `routes.ts` | the Fastify routes: parse the input with the contract schema, load the entity through a guard, call the service |
| `service.ts` | the operations, callable from another module, from the seed and from the tests |
| `events.ts` | the SSE events this module publishes |
| `jobs.ts` | the background jobs it registers on the queue |

A module never imports another module's `routes.ts`; it calls its
`service.ts`. The seed (`src/seed/demo.ts`) obeys the same rule: it builds
the demo world through the services, so every row it writes is one the
application would have written.

Beside the module directories sit a few shared files that are not modules:
`src/modules/guards.ts`, the access predicates every route loads an entity
through; `src/modules/http.ts`, the common replies and the guarded-route
wrappers `studentRoute`/`teacherRoute`; and two small plugins, `admin.ts`
and `avatar.ts`. `src/modules/runner/` is not a module either: it holds the
API-side client of the runner (`http.ts`) and the stub that stands in for it
(`unavailable.ts`).

### Schema and migrations

The Drizzle schema is split by module under `apps/api/src/db/` (`org.ts`,
`pool.ts`, `evaluation.ts`, `live.ts`, `grading.ts`, `auth.ts`,
`notifications.ts`) and re-exported by `db/schema.ts`. A table belongs to
one module; another module may read it in a join but never writes it.

Migrations are SQL files under `apps/api/drizzle/`, generated, never
hand-written:

```bash
pnpm db:generate         # drizzle-kit generate: a new NNNN_<name>.sql + meta/
```

They are applied at startup when `MIGRATE_ON_START=1`, which is the default
in development and in the container image, on PGlite and on PostgreSQL
alike. `pnpm --filter @quiz/api db:migrate` applies them by hand against a
real PostgreSQL; it REQUIRES `DATABASE_URL` in the environment and stops
without one, where `pnpm db:generate` only reads the schema and needs no
database at all. Keep migrations additive: production rolls
back by image tag, not by reverse migration (see
[deployment](deployment.md#rollback)).

### Tests

| Suffix | Where | Runs on |
| --- | --- | --- |
| `*.test.ts` | every package, `apps/runner`, `apps/api` | plain Vitest, no I/O |
| `*.db.test.ts` | `apps/api` | an in-memory PGlite created by `apps/api/src/test/db.ts`, migrated with the real files under `drizzle/`; `testApp()` returns a Fastify stub carrying that database and a `TestClock`, so a deadline is driven by moving the clock rather than by sleeping |
| `*.test.tsx` | `apps/web`, the `qt-*` clients | Vitest with jsdom; `apps/web` runs its `.test.ts` files in a plain `node` project and its `.test.tsx` files in a `dom` project |
| `*.leak.test.ts`, `toStudent.test.ts` | `apps/api/src/modules/live`, every `qt-*` | the content-safety tests of invariant 4 |
| `*.int.test.ts` | `apps/runner` | real containers, `pnpm --filter @quiz/runner test:integration`, skipped without Podman |

`pnpm test` runs all of them except the runner's integration suite.

### Internationalisation

Everything a user reads goes through `t()` from `apps/web/src/i18n/index.tsx`,
teacher screens included. The dictionary is flat: `en` is the source of
truth, and `fr` is declared as `Record<keyof Dict, string>`, so a key added
in English without its French twin fails `pnpm typecheck`. The `qt-*`
packages carry their own strings in `src/strings.ts`, which the host merges.

Everything else, code, identifiers, comments, commit messages, ADRs and
this documentation, is in English.

## The invariants

The invariants a change must respect (English everywhere but the UI, one
primary action per screen, no development login in production, `toStudent`
as the only exit of question content, the server's clock, access loaded
through `staffAccess`, contract schemas on every input, pure rules in
`@quiz/domain`, the closed audit union, and the five runner invariants) are
written once, in
[`CLAUDE.md`](https://github.com/heig-tin-info/heig-quiz/blob/main/CLAUDE.md#invariants)
at the root of the repository. A change that needs one of them relaxed is a
change to discuss first, not a `// temporarily` comment. The runner's
hardening flags are documented in
[`apps/runner/README.md`](https://github.com/heig-tin-info/heig-quiz/blob/main/apps/runner/README.md).

## Related reading

- [5. Architecture](../spec/05-architecture.md): the layout, the database
  schema, real-time, the runner, grading.
- [7. Reuse of heig-classroom](../spec/07-reutilisation-heig-classroom.md):
  what was kept, adapted or dropped from the sibling project this
  repository started from.
- [The MVP plan](../PLAN-MVP.md), archived: the phase-1 work packages and
  the decisions numbered D1 to D20 that the code comments refer to.
