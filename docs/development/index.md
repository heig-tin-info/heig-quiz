# Development

This page gets the platform running on a laptop and explains what you are
looking at once it runs. The [repository layout](repository.md) describes
the code, [deployment](deployment.md) the two production machines, and
[writing the documentation](documentation.md) this site.

## Prerequisites

Node 24 and pnpm, nothing else. pnpm comes through corepack, which ships
with Node:

```bash
corepack enable pnpm
```

No container engine, no local PostgreSQL and no identity provider are needed
for the ordinary development loop. The database is an embedded PostgreSQL
(PGlite) persisted on disk, and the sign-in screen offers a persona picker
instead of Switch edu-ID. Docker and Podman only matter for the two optional
paths described further down: the real OIDC login and the code runner.

## Install, build, seed, run

```bash
pnpm install
pnpm build               # the workspace packages: the apps import their dist/
cp .env.example .env     # pglite:// database, AUTH_DEV_LOGIN=1
pnpm seed                # the demo world, see below
pnpm dev                 # API on :3000, web on :5173
```

`pnpm build` is not optional the first time: the apps resolve
`@quiz/core`, `@quiz/domain`, `@quiz/contracts` and the question-type
packages through their `dist/` directories, so an unbuilt package is a
missing module. Rebuild a package after changing it.

`pnpm dev` runs three `dev` scripts in parallel:

| Process | Port | What it is |
| --- | --- | --- |
| `@quiz/api` | 3000 | Fastify, restarted by `tsx watch`; applies the Drizzle migrations at startup (`MIGRATE_ON_START=1`) |
| `@quiz/web` | 5173 | Vite with HMR; proxies `/app` and `/healthz` to :3000 |
| `@quiz/runner` | 3200 | the code execution service, started only when the machine has a Podman socket; otherwise it prints one line and exits |

Open <http://localhost:5173>, click **Dev login** and pick a persona.

The web `dev` and `build` scripts first run `scripts/fetch-runtimes.mjs`,
which downloads the WebAssembly language runtimes the browser needs to run a
student's trial (about 77 MB, pinned by SHA-256, kept out of git in
`apps/web/public/runtimes/`). A second run costs nothing. If the download
fails, for instance offline, the script warns and the app still works: the
browser runner refuses to load and the server-side runner takes over.

## The demo world

`pnpm seed` builds a complete, coherent dataset through the ordinary
services of the API, never by raw inserts: every row it writes is a row the
application would have written itself, invariants included. It is
idempotent, keyed on internal names and titles, so a second run changes
nothing.

The personas are the ones offered by the dev login:

| Persona | Role | What they see |
| --- | --- | --- |
| Prof Démo (`teacher@heig-vd.ch`) | teacher | the course PRG1, its two pools, its four evaluations |
| Admin Démo (`admin@heig-vd.ch`) | admin | the same, plus the administration screen; a contributor on the *Électronique* pool |
| Léa Rochat | student | a roster seat with a 25 % extra-time accommodation |
| Noah Bovet, Emma Favre, Louis Perrin, Chloé Monnier, Gabriel Dubois | student | ordinary roster seats |

What gets built:

- the course **PRG1** with the classroom **PRG1-2026**, a roster of six
  students already claimed, and Léa's time accommodation so the extra-time
  path is always exercised;
- the pool **Programmation C**, attached to PRG1, three categories, ten
  published questions covering the four types (multiple choice, short
  answer, cloze, code);
- the pool **Électronique**, stand-alone, four published questions, shared
  with the admin persona as a contributor so the demo shows a pool from the
  colleague's side too;
- four evaluations in PRG1-2026:

| Evaluation | Mode | State after the seed |
| --- | --- | --- |
| Test 1 — pointeurs | exam, 45 min | `draft` |
| Test 2 — chaînes | exam, 90 min window | `scheduled`, opens in two days |
| Quiz d'entraînement | exercise | `lobby`, waiting for students |
| Test 0 — bases du C | exam, 45 min | `closed`, graded, **not released** |

*Test 0* has already run: five of the six students answered it (Gabriel is
absent, Chloé never handed in, so closing the evaluation expired one
attempt), and the real grading pass produced a proposal for every answer.
The results are deliberately left unreleased so that the grading panel has
proposals to validate the moment you open it, which is the screen a teacher
spends the most time on.

The seed content lives in `apps/api/src/seed/content.ts`; the way it is
built through the services is `apps/api/src/seed/demo.ts`.

## The embedded database

With `DATABASE_URL=pglite://.data/pglite`, the API runs an embedded
PostgreSQL whose data is the directory `apps/api/.data/pglite` (gitignored).
The same Drizzle migrations that production applies run against it at
startup, so what you develop on is the real schema.

Two consequences:

- **It is single-process.** Stop the API before running `pnpm seed`; two
  processes cannot open the directory at once.
- **There is no pg-boss.** The job queue needs a real PostgreSQL, so on
  PGlite the API swaps in a minimal in-process runner behind the same
  `send`/`work` surface (`apps/api/src/jobs.ts`). It is not durable: a job
  that has not run yet dies with the process. Acceptable in development,
  and one of the reasons `config.ts` refuses a `pglite://` URL in
  production.

To start over, delete the directory:

```bash
rm -rf apps/api/.data/pglite && pnpm seed
```

## The development login

`AUTH_DEV_LOGIN=1` makes `GET /app/auth/dev` serve a persona picker that
opens a normal session without any identity provider, and adds the **Dev
login** button to the sign-in screen. The session it opens is a real one,
stored in the database like an OIDC session, which is why the seed and the
smoke test can use it.

It never exists in production. Under `NODE_ENV=production`, `config.ts`
throws on `AUTH_DEV_LOGIN=1` exactly as it throws on a `pglite://` database,
on the placeholder `COOKIE_SECRET` of `.env.example`, or on its placeholder
`OIDC_CLIENT_SECRET` when no private key is configured (with `private_key_jwt`
the secret is never sent, so it is not checked): the process refuses to
start rather than serve an open door.
The OIDC path (Keycloak in development, Switch edu-ID in production) is the
real one and stays intact whether or not the shortcut is on.

## The interface alone: `pnpm dev:mock`

```bash
pnpm dev:mock            # Vite on :5173, no backend at all
```

`VITE_MOCK=1` makes `main.tsx` import `apps/web/src/mock/index.ts`, an
in-browser mock of the whole API served from in-memory state. Mutations edit
that state so the flows feel real, and a reload starts over. The mock is a
design tool: it is how a screen is looked at in every one of its states
before it is declared finished (`apps/web/DESIGN.md`).

The persona comes from `?as=teacher|student|admin`, remembered in the
browser. Scene flags, remembered the same way, force the states that are
hard to reach with real data: `?empty=1` for every empty state, `?fail=1`
for the error states (every GET answers 500), `?slow=1` for the loading
states (2.5 s of latency), `?many=1` for long lists and the 120 × 10 live
grid, and `?scene=lobby|running|paused|closed|extend` for the student
player.

The mock is never part of a production build: Vite drops the branch when
the flag is unset.

## Optional services: PostgreSQL and Keycloak

To exercise the real paths, a true PostgreSQL (and therefore pg-boss) and a
true OIDC login, bring up the optional compose file:

```bash
docker compose -f docker-compose.dev.yml up -d
DATABASE_URL=postgres://quiz:quiz@localhost:5432/quiz AUTH_DEV_LOGIN=0 pnpm dev
```

`docker-compose.dev.yml` starts PostgreSQL 17 on `127.0.0.1:5432` and
Keycloak 26 on `127.0.0.1:8080`, importing the development realm from
`infra/keycloak/quiz-dev-realm.json`. The realm `quiz-dev` holds a client
`quiz` whose secret is the one in `.env.example`, and three users:
`teacher`, `student` and `student2`, each with a password equal to the
username. With `AUTH_DEV_LOGIN=0` the persona picker does not exist and the
sign-in screen only offers the OIDC button.

The same PostgreSQL URL is what `drizzle-kit migrate` and the smoke test
expect when you want them against a real server.

## The code runner

A code question is graded by running the student's program in a hardened
container. The API reaches that service in one of two modes, chosen by
`RUNNER_MODE` in `.env`:

| Mode | When | Behaviour |
| --- | --- | --- |
| `stub` (default) | no container engine on the machine | a code question stays authorable, playable and releasable; `POST /attempts/:id/run` answers `503 runner_unavailable`; grading writes a *proposed* grade with the comment `runner_unavailable` for the teacher to settle (decision D14); `/healthz` reports the runner as `disabled` |
| `http` | a Podman socket exists | `apps/runner` executes the code; `RUNNER_URL` is then required, and `config.ts` refuses `http` without it |

To run it locally you need Podman with its user socket
(`/run/user/<uid>/podman/podman.sock`; `systemctl --user enable --now
podman.socket` on most distributions). Then build the language images once
and point the API at the runner:

```bash
pnpm --filter @quiz/runner images        # apps/runner/images/build.sh: c cpp python js
# in .env
RUNNER_MODE=http
RUNNER_URL=http://localhost:3200
```

`RUNNER_TOKEN` stays empty on a workstation: the runner is on localhost and
checks no bearer when no token is configured. Production requires the same
token on both sides ([ADR-016](../adr/ADR-016-runner-sur-vm-separee.md)).

`pnpm dev` detects the socket and starts the runner on :3200 (`RUNNER_PORT`
moves it). On a rootless workstation `--userns=auto` is probed once at
startup and dropped with a log line when `/etc/subuid` gives the user no
range; in production the socket is the rootful one and the flag is always
on. The images are Alpine-based, one toolchain each, no network client;
`images/build.sh rust` builds the large one that is never built by default.

The hardening flags, the closed environment list and the request lifecycle
are in `apps/runner/README.md`; the invariants they implement are listed on
the [repository page](repository.md#runner-invariants).

```bash
pnpm --filter @quiz/runner test                # unit: a fake engine, no container
pnpm --filter @quiz/runner test:integration    # real containers; skips itself without Podman
```

## The smoke test

```bash
pnpm smoke                       # against http://localhost:3000
pnpm smoke http://localhost:4000 # any other base URL
```

`scripts/smoke.sh` needs a running API, a seeded database,
`AUTH_DEV_LOGIN=1`, `curl` and `jq`. It walks one whole life of an
evaluation over HTTP only, nothing mocked and nothing read from the
database, and exits non-zero on the first failed expectation:

1. `GET /healthz`, the database must be up;
2. a teacher session through the dev login;
3. a fresh question authored and published;
4. an evaluation built, opened, and a student attempt answered and handed
   in, including a second revision of an answer;
5. close, grade, release;
6. the CSV export;
7. the student's feedback, which must reflect the last revision.

When `/healthz` reports the runner as `up`, the walk also compiles and
runs the seeded C exercise once with the reference solution and once with
a wrong answer, through the real container. `disabled` and `down` are
reported and skipped, not failed.

## What CI runs

```bash
pnpm build && pnpm typecheck && pnpm test
```

`.github/workflows/ci.yml` runs exactly that on every push and pull
request, on Node 24 with a frozen lockfile, plus `pnpm --filter
@quiz/runner test` on its own so the runner's unit suite cannot silently
stop running. The runner's integration suite is deliberately not run on
CI. On a push to `main` the same workflow then builds the two production
images and deploys them; see [deployment](deployment.md).

The test layout, including the database tests that run on PGlite against
the real migrations, is described on the [repository page](repository.md#tests).

## Other commands

| Command | What it does |
| --- | --- |
| `pnpm db:generate` | `drizzle-kit generate` in `apps/api`: a new migration under `apps/api/drizzle/` after a schema change |
| `pnpm --filter @quiz/web screenshots` | screenshots of the mocked web app with Playwright, for the visual check of a screen; needs `pnpm dev:mock` in another terminal |
| `pnpm docs:serve`, `pnpm docs:build` | this site, see [writing the documentation](documentation.md) |
