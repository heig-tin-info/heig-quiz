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
  qt-mcq/     question type: multiple choice
  qt-short/   question type: short answer
  qt-cloze/   question type: fill in the blanks
  qt-code/    question type: code, graded by the runner
docs/
  spec/       the product specification
  adr/        the architecture decision records
  development/  these pages
infra/
  keycloak/   the development realm imported by docker-compose.dev.yml
mockups/      HTML mockups of the target screens, with mockups/BRIEF.md
scripts/      smoke.sh, the end-to-end HTTP walk
```

At the root: `Dockerfile` (the application image), `apps/runner/Dockerfile`
(the runner image), `compose.prod.yml`, `Caddyfile`, `deploy.sh` and
`deploy.md` for production; `docker-compose.dev.yml` for the optional
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
[deployment page](deployment.md#health-and-metrics).

### `apps/web`

The React single-page application ([ADR-008](../adr/ADR-008-frontend-spa-react.md)),
built with Vite. `src/router.ts` is the route union, `src/api.ts` the typed
client over the contracts, `src/i18n/` the dictionaries, `src/mock/` the
in-browser API used by `pnpm dev:mock`. Feature directories (`pool`,
`evaluation`, `live`, `grading`, `results`, `student`, `poll`, `question`,
`realtime`, `runner`, `markdown`) hold the screens and their tests. The
design rules are in `apps/web/DESIGN.md`, and `.claude/skills/quiz-ui/SKILL.md`
is the checklist a screen goes through before it is declared finished.

### `apps/runner`

The code execution service: Fastify on :3200, `POST /run` and
`GET /health`, one hardened container per request driven over the Podman
socket. It depends on `@quiz/core` only. `apps/runner/README.md` documents
the flags of every container, the request lifecycle, the images under
`images/*/Containerfile` and the configuration knobs. Its own image
(`apps/runner/Dockerfile`) ships no engine, only the `podman-remote` client.

## Packages

| Package | Entry points | What it holds |
| --- | --- | --- |
| `@quiz/core` | `./server`, `./client`, `./rng` | the `QuestionTypeServer` and `QuestionTypeClient` contracts, the `GradeResult` union, the seeded RNG, the `Runner` interface and its request/outcome types |
| `@quiz/registry` | `./server`, `./client` | the two static maps from a question-type id to its implementation |
| `@quiz/contracts` | `.` | one zod schema per route and per SSE event, and the payload types both sides import |
| `@quiz/domain` | `.`, `./<file>` | pure functions with unit tests: the Swiss grade scale, deadlines and time bonus, the MCQ scoring policies, the cloze parser, the roster import, output comparison, stats, pseudonyms |
| `@quiz/qt-mcq`, `qt-short`, `qt-cloze`, `qt-code` | `./server`, `./client` | one question type each: config schema, canonical form, grading on the server; Editor, Player, Review (and Stats) components on the client |

### Server and client halves

`@quiz/core/server` contains no React anywhere and is what the API imports.
`@quiz/core/client` describes the browser half of the contract; React
appears there as type-only imports, which `verbatimModuleSyntax` erases, so
the client entry adds no runtime dependency either. Every `qt-*` package
follows the same split: `server.ts` exports the grading and the `toStudent`
projection, `client.tsx` exports the lazy components.

### The registries

`packages/registry` is the one place the API and the web app learn which
question types exist. `src/server.ts` maps `mcq`, `short`, `cloze` and
`code` to their `*Server` objects; `src/client.ts` does the same for the
components. Registering a type is an import and an entry in each map. The
registry depends on `core` and on the `qt-*` packages; nothing inside `core`
may depend on the registry, or the package graph would cycle (decision D1
in the [MVP plan](../PLAN-MVP.md)).

## API conventions

### Modules

A module is a directory `apps/api/src/modules/<name>/` with at most four
files:

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

Two things that are not modules: `src/modules/guards.ts`, the access
predicates every route loads an entity through, and `src/modules/runner/`,
the API-side client of the runner (`http.ts`) and the stub that stands in
for it (`unavailable.ts`).

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

`CLAUDE.md` at the root is the normative text; this is the short form. A
change that needs one of these relaxed is a change to discuss first, not a
`// temporarily` comment.

1. **English everywhere except UI strings**, and every UI string has an
   `en` and a `fr` entry through `t()`.
2. **One primary action per screen.** If the single thing a screen is for
   cannot be named, the flow is wrong, not the styling.
3. **The development login never exists in production.** `config.ts`
   refuses to start with `AUTH_DEV_LOGIN=1` or a `pglite://` database under
   `NODE_ENV=production`; the OIDC path stays intact in every environment.
4. **Question content reaches a student only through `toStudent`.** One
   exit point, the `studentView` service of the `live` module: it strips the
   internal name, the tags, the difficulty and the explanation, then applies
   the feedback policy. Every question type is tested with a full
   configuration passed through it, by forbidden-key list and by searching
   the serialized output for the answer-key values.
5. **The server owns the clock.** A deadline is closed by the ticker, never
   by a client; the receipt time of a write is the server's; a write after
   `deadline + 3 s` is refused with `410 attempt_closed`.
6. **Access is loaded, never checked afterwards.** One predicate,
   `staffAccess` in `apps/api/src/modules/guards.ts`: an entity is loaded
   only if the user holds a seat on its course's staff (or is an admin), and
   otherwise the answer is a 404 indistinguishable from a missing entity.
7. **Every HTTP input is validated by a schema from `packages/contracts`**,
   and the client uses the same schema, so a route change breaks both sides
   at compile time.
8. **Pure rules live in `packages/domain`**, with no database access and
   unit tests.
9. **The audit log is a closed TypeScript union** (`apps/api/src/audit.ts`);
   a typo at a trigger site is a compile error.

### Runner invariants

These are proven in the sibling project the runner was lifted from, and
`apps/runner` implements them as they stand.

10. **No secret inside a container.** The environment passed at
    `podman run` is a closed list of two variables, asserted by a test.
11. **The network is closed by construction**, `--network none`. There is
    no channel to open and nothing to punch through.
12. **Hardening from the first run**: `--userns=auto --cap-drop=ALL
    --security-opt no-new-privileges --security-opt seccomp=<profile>
    --read-only --pids-limit --memory --cpus`, a tmpfs work directory and
    a wall-clock timeout enforced by the service. The list is
    `containerArgs` in `apps/runner/src/engine.ts`, asserted flag for flag
    by `src/engine.test.ts`. Nothing from the host is mounted: sources
    travel in on `podman exec`'s stdin, and a file name from a request is
    sanitized to a name, never a path.
13. **Podman in `--remote`**, always `podman --remote --url unix://<socket>`.
    Without it the binary silently falls back to local rootless mode and
    every isolation test measures something else. Production uses the
    rootful socket; a workstation uses the user one, where `--userns=auto`
    is probed once at startup.
14. **The source sent to the runner is rebuilt server-side** from the
    template and the student's editable regions, never taken as-is.

## Related reading

- [5. Architecture](../spec/05-architecture.md): the layout, the database
  schema, real-time, the runner, grading.
- [7. Reuse of heig-classroom](../spec/07-reutilisation-heig-classroom.md):
  what was kept, adapted or dropped from the sibling project this
  repository started from.
- [The MVP plan](../PLAN-MVP.md): the work packages and the decisions
  numbered D1, D3, D14 that the code comments refer to.
