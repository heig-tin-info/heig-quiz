# quiz

A quiz platform for HEIG-VD teachers: question pools, live evaluations with a
server-side clock, automatic grading (including sandboxed code execution) and
results. One VM, one PostgreSQL, one repository, operable by one person.

This repository started as a **pruned copy of `~/heig-classroom`** (same
author, same stack, same identity provider, in production). Its ADRs 001–010
and 012 apply here as written and live in `docs/adr/`. What was reused,
adapted or dropped is spelled out in `docs/spec/07-reutilisation-heig-classroom.md`.

## Several agents at once

Other sessions work on this repository concurrently, and every push to
`main` deploys to staging (`quiz.dev.chevallier.io`), then to production on
approval (ADR-028). `AGENTS.md` has the rules: a worktree per agent, `main` by
merge only, staging by path, atomic lockfile commits. Read it first.

## The rule about the spec

**The specification lives in `docs/spec/`. Read the file that covers a feature
before implementing it.** It is nine documents; the relevant one is short.

| File | What it settles |
| --- | --- |
| `00-cadre-et-perimetre.md` | Scope, what is explicitly out |
| `01-glossaire-et-domaine.md` | The vocabulary and the domain objects |
| `02-exigences-fonctionnelles.md` | Numbered requirements (F-ORG-07, F-LIVE-11, …) |
| `03-exigences-non-fonctionnelles.md` | N-SEC-06, N-I18N-01, performance, operations |
| `04-types-de-questions.md` | Every question type and its behaviour |
| `05-architecture.md` | Layout, database schema, real-time, runner, grading |
| `06-questions-ouvertes.md` | What is still undecided — do not decide it silently |
| `07-reutilisation-heig-classroom.md` | What comes from the sibling project |
| `08-experience-deux-niveaux.md` | The novice / expert split |

`mockups/` holds the HTML mockups of the main screens, with `mockups/BRIEF.md`.

## Layout

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
  qt-mcq/     question type: multiple choice (./server, ./client)
  qt-short/   question type: short answer (./server, ./client)
  qt-cloze/   question type: fill in the blanks (./server, ./client)
  qt-code/    question types: code graded by the runner, and its variant
              codeimage graded pixel by pixel (./server, ./client)
  qt-circuit/ question type: two-port schematic, graded by ngspice simulation
              (./server, ./client, ./canvas)
docs/
  spec/       the product specification (above)
  adr/        the architecture decisions inherited from heig-classroom
mockups/      HTML mockups of the target screens
infra/        Keycloak development realm
```

`packages/qt-mcq`, `qt-short`, `qt-cloze`, `qt-code` and `qt-circuit` exist
and are registered in `packages/registry` in two places (`./server` and
`./client`). `qt-circuit` (ADR-019) grades a schematic by simulating it with
ngspice through the runner's `spice` language; its rules are in
`docs/spec/04-types-de-questions.md` §4.11. `qt-code` also carries a second
type, `codeimage` (ADR-021, §4.9): the same program half (`src/Program*.tsx`,
`programFields`), judged by the picture its stdout draws (`src/image/`),
exported as `codeimageServer` / `codeimageClient` and registered beside `code`.
`packages/ui` exists since the refactoring campaign of 2026-09-23 (PR #51): the
shared primitives of the question-type surfaces (`@quiz/ui`, React as a
peer, `@quiz/core` its only dependency; it never imports a `qt-*` package nor
`apps/web`). The generic primitives of `apps/web/src/ui/` are due to move
to `@heig-platform/ui`, a library shared with heig-classroom (ADR-029, not
extracted yet): a new generic primitive belongs there, not in this repo.
Packages still to create, in this order (`docs/spec/05-architecture.md`,
5.2 and `docs/PLAN-MVP.md` §8): `packages/canonical`,
`packages/cli`.

`packages/core` is split in two entry points: `@quiz/core/server` (no React,
anywhere) and `@quiz/core/client` (React as type-only imports). The static
wiring lives in `packages/registry` so that `core` never imports a `qt-*`
package — the cycle that decision D1 breaks.

`apps/runner` is the code execution service (WP11): Fastify on :3200,
`POST /run` + `GET /health`, one hardened container per request driven over
the Podman socket. It was built from the material lifted from the sibling
codespace project, which `apps/runner/README.md` credits and which the
package now replaces — the seccomp profile lives at
`apps/runner/infra/seccomp/runner.json`, the flag list is asserted by
`src/engine.test.ts`, and `images/*/Containerfile` holds one image per
language. Its unit tests need no container; `pnpm --filter @quiz/runner
test:integration` really starts them and skips itself without Podman.

## Invariants

Never work around these, not even "temporarily".

1. **English everywhere except UI strings.** Code, identifiers, comments,
   documentation, commit messages, ADRs: English. Only what a user reads is
   translated, and it goes through `t()` in `apps/web/src/i18n/` (`en.ts`, `fr.ts`,
   `index.tsx`) with both
   an `en` and a `fr` entry — teacher surfaces included (N-I18N-01). The `fr`
   dictionary is typed `Record<keyof Dict, string>`, so a missing French key
   is a compile error. Keep it that way.
2. **One primary action per screen.** If you cannot name the single thing a
   screen is for, the flow is wrong, not the styling. See
   `.claude/skills/quiz-ui/SKILL.md` and `apps/web/DESIGN.md`.
3. **The development login never exists in production.** `AUTH_DEV_LOGIN=1`
   under `NODE_ENV=production` makes `config.ts` throw and the process refuse
   to start, exactly like a dev secret. The same refusal covers a
   `pglite://` database. The OIDC path (Keycloak in dev, Switch edu-ID in
   production) is the real one and stays intact.
4. **Question content never reaches a student except through `toStudent`.**
   One point of exit, in the `studentView` service of the `live` module: it
   strips the internal name, the tags, the difficulty and the explanation,
   then applies the feedback policy. Every question type is tested with a
   full configuration passed through `toStudent`, by forbidden-key list AND
   by searching the serialized output for the answer-key values
   (`docs/spec/05-architecture.md`, 5.7).
5. **The server owns the clock.** A deadline is closed by the ticker, never
   by a client. The receipt time of a write is the server's, never the
   browser's. A write arriving after `deadline + 3 s` is refused with
   `410 attempt_closed`.
6. **Access is loaded, never checked afterwards.** One predicate,
   `staffAccess` in `apps/api/src/modules/guards.ts`: a user reaches a
   classroom if and only if they hold a seat on its course's staff (or are
   an admin). An entity is loaded only if that holds; otherwise the answer is
   a 404 indistinguishable from a missing entity.
7. **Every HTTP input is validated by a schema from `packages/contracts`,**
   and the client uses the same schema. A route change breaks both sides at
   compile time.
8. **Pure rules live in `packages/domain`** — scales, grading policies, cloze
   parsing, roster import, FSRS — with no database access and unit tests.
9. **The audit log is a closed TypeScript union** (`apps/api/src/audit.ts`).
   A typo at a trigger site is a compile error.

### Runner invariants (`apps/runner`, from the sibling codespace project)

These are already proven in the sibling project, and `apps/runner` implements
them. Do not re-derive them, and do not relax one to make a test simpler.

10. **No secret inside the container.** No token, no key, no credential
    helper. The set of environment variables passed at `podman run` is a
    CLOSED list, asserted by a test.
11. **The network is closed by construction**: `--network none`. The runner
    of a quiz has no git channel to open, so there is nothing to punch
    through — unlike the codespace it comes from.
12. **Hardening from the very first run**, never "added later":
    `--userns=auto --cap-drop=ALL --security-opt no-new-privileges
    --security-opt seccomp=<profile> --read-only --pids-limit --memory
    --cpus`, tmpfs work directory, wall-clock timeout enforced by the
    service. The exact list is `apps/runner/src/engine.ts`
    (`containerArgs`), asserted flag for flag by `src/engine.test.ts` and
    documented in `apps/runner/README.md` (N-SEC-06). A test that needs an
    option relaxed says so in the docs, not in a comment. **Nothing from the
    host is mounted**: the sources travel in on `podman exec`'s stdin and
    `/work` is a tmpfs. A file name from a request is sanitized to a name —
    never a path.
13. **Podman in `--remote`**, always
    `podman --remote --url unix://<socket> …`. Without `--remote` the binary
    silently falls back to local rootless mode and every isolation test
    measures something else. Production is the ROOTFUL socket
    (`/run/podman/podman.sock`, `--userns=auto` always available); a
    development workstation is the user one, where `--userns=auto` is probed
    once at startup and dropped with a log line when the engine cannot do it.
    gVisor (`--runtime runsc`) on top when the host has it.
14. **The source sent to the runner is rebuilt server-side** from the
    template and the student's editable regions — never taken as-is.

## Development

No Docker, no Podman and no PostgreSQL are needed to run this.

```bash
corepack enable pnpm && pnpm install
pnpm build                      # the packages: the apps resolve them through dist/
cp .env.example .env            # pglite:// database + AUTH_DEV_LOGIN=1
pnpm seed                       # the whole demo world (below)
pnpm dev                        # API :3000, Vite :5173 — and the runner on
                                # :3200 when the machine has a Podman socket
pnpm smoke                      # end-to-end HTTP walk, against a running API
```

Then open <http://localhost:5173>, click **Dev login** and pick a persona.
The embedded database is a directory (`apps/api/.data/pglite`, gitignored);
delete it to start over. It is single-process: stop the API before `pnpm seed`.

`pnpm seed` (`apps/api/src/seed.ts`, content in `apps/api/src/seed/`) is
idempotent and builds everything through the ORDINARY SERVICES, never by raw
inserts: course PRG1, classroom PRG1-2026, six students, two pools with
sixteen published questions of all six types, and four evaluations — one
`draft`, one `scheduled`, one exercise in `lobby`, and `Test 0 — bases du C`
closed, answered by five of the six students, graded by the real grading pass
and left UNRELEASED so the panel has proposals to validate. Keyed on internal
names and titles, so a second run writes nothing.

`pnpm smoke` (`scripts/smoke.sh`) needs a running API and a seeded database.
It walks one whole life of an evaluation over HTTP — login, author, publish,
build, open, answer, submit, close, grade, release, CSV, feedback — and exits
non-zero on the first failed expectation. A base URL may be passed as its only
argument.

```bash
pnpm build && pnpm typecheck && pnpm test    # what CI runs
pnpm dev:mock                                # the SPA alone, no backend at all
pnpm db:generate                             # a migration, after a schema change
```

To exercise the REAL paths — a true PostgreSQL (and therefore pg-boss) and a
true OIDC login — bring up the optional services:

```bash
docker compose -f docker-compose.dev.yml up -d
DATABASE_URL=postgres://quiz:quiz@localhost:5432/quiz AUTH_DEV_LOGIN=0 pnpm dev
```

Production always uses a real PostgreSQL: pg-boss needs one, and `config.ts`
refuses a `pglite://` URL there.

## Conventions

- Modules of the API live in `apps/api/src/modules/<name>/` with
  `routes.ts`, `service.ts`, `events.ts`, `jobs.ts`; a module may split its
  service into cohesive files under its directory; `service.ts` stays the
  entry other modules import. A module never imports another module's
  `routes.ts`; it calls its `service.ts`.
- The Drizzle schema is split by module under `apps/api/src/db/` and
  re-exported by `db/schema.ts`. A table belongs to one module. Another
  module may read it by join; it never writes it.
- Database tests are `*.db.test.ts` and run on PGlite through
  `apps/api/src/test/db.ts`, against the real migrations.
- A non-trivial decision becomes an ADR in `docs/adr/`, in the format of the
  inherited ones.
- Before declaring a screen finished, look at it: `pnpm dev:mock`, then the
  screenshots (`apps/web/scripts/screenshots.mjs`).
