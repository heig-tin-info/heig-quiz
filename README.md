# Quiz

A quiz platform for HEIG-VD teachers. Question pools, evaluations run live
with a server-side clock, automatic grading — multiple choice, short answer,
cloze, and code executed in a sandboxed container — and results.

Built from the same stack as its sibling project
[heig-classroom](https://github.com/heig-tin-info/heig-classroom): TypeScript
end to end, Fastify 5 and PostgreSQL on the server, React 19 and Vite in the
browser, Switch edu-ID for authentication, one VM and one database.

## Try it locally without Docker

Nothing to install beyond Node 24 and pnpm — no container engine, no local
PostgreSQL, no identity provider. The database is an embedded PostgreSQL
(PGlite) persisted in `apps/api/.data/pglite`, and the sign-in screen offers a
persona picker instead of Switch edu-ID.

```bash
corepack enable pnpm && pnpm install
cp .env.example .env     # embedded database, development login on
pnpm seed                # the demo world — see below
pnpm dev                 # API on :3000, web on :5173
```

Open <http://localhost:5173>, click **Dev login** and pick a persona:

| Persona | Role | What they see |
| --- | --- | --- |
| Prof Démo | teacher | the course PRG1, its two pools, its four evaluations |
| Admin Démo | admin | the same, plus the administration screen |
| Léa Rochat | student | a roster seat with a 25 % time accommodation |
| Noah, Emma, Louis, Chloé, Gabriel | students | ordinary roster seats |

`pnpm seed` is idempotent — run it as often as you like. It builds a course
`PRG1`, the classroom `PRG1-2026`, six students, a pool *Programmation C*
(three categories, ten published questions: multiple choice, short answer,
cloze and code) and a second pool *Électronique*, then four evaluations in the
classroom: one `draft`, one `scheduled` two days out, one exercise waiting in
its `lobby`, and one that has already run — **Test 0 — bases du C** is closed,
its five students are graded and its results are deliberately **not released**,
so the grading panel has proposals to validate.

The embedded database is a directory; delete `apps/api/.data/pglite` to start
over. It is single-process, so stop the API before running `pnpm seed`.

```bash
pnpm smoke               # end-to-end HTTP walk through a whole evaluation
pnpm build && pnpm typecheck && pnpm test
pnpm dev:mock            # the interface alone, on fake data
```

`pnpm smoke` needs the API running (`pnpm dev`) and a seeded database. It
signs a teacher in, authors and publishes a question, builds an evaluation,
opens it, answers it as a student, then closes, grades, releases and exports
it — over HTTP only, exiting non-zero on the first failed expectation. Point
it elsewhere with `pnpm smoke http://localhost:4000`.

### With Docker: the real identity provider

To exercise the production paths — a true PostgreSQL, and therefore pg-boss,
and a true OIDC login against the dev Keycloak realm of `infra/keycloak/`:

```bash
docker compose -f docker-compose.dev.yml up -d
DATABASE_URL=postgres://quiz:quiz@localhost:5432/quiz AUTH_DEV_LOGIN=0 pnpm dev
```

The development login then does not exist at all, and the sign-in screen only
offers **OIDC sign-in**. Production always uses a real PostgreSQL: `config.ts`
refuses a `pglite://` URL there, and refuses `AUTH_DEV_LOGIN=1` outright.

## Where things are

| Path | What |
| --- | --- |
| `apps/api` | Fastify API, Drizzle schema and migrations |
| `apps/web` | React SPA |
| `apps/runner` | the code execution service: hardened Podman containers, `POST /run` |
| `packages/contracts`, `packages/domain` | shared schemas, pure business rules |
| `docs/spec` | the product specification |
| `docs/adr` | inherited architecture decisions |
| `mockups` | HTML mockups of the main screens |

`CLAUDE.md` holds the working conventions and the invariants.
`deploy.md` covers the production VM.

## Status

Bootstrap. Identity, courses, classrooms and rosters work; pools, evaluations,
grading and the runner are the work ahead. See `docs/spec/`.
