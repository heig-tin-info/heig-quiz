# Quiz

A quiz platform for HEIG-VD teachers. Question pools, evaluations run live
with a server-side clock, automatic grading — multiple choice, short answer,
cloze, and code executed in a sandboxed container — and results.

Built from the same stack as its sibling project
[heig-classroom](https://github.com/heig-tin-info/heig-classroom): TypeScript
end to end, Fastify 5 and PostgreSQL on the server, React 19 and Vite in the
browser, Switch edu-ID for authentication, one VM and one database.

## Run it

```bash
corepack enable pnpm && pnpm install
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL + Keycloak
cp .env.example .env
pnpm --filter @quiz/api db:migrate
pnpm dev                                         # API on :3000
pnpm --filter @quiz/web dev                      # web on :5173

pnpm build && pnpm typecheck && pnpm test
pnpm dev:mock            # the interface alone, on fake data
```

## Where things are

| Path | What |
| --- | --- |
| `apps/api` | Fastify API, Drizzle schema and migrations |
| `apps/web` | React SPA |
| `apps/runner` | container-hardening material for the code runner (not wired up yet) |
| `packages/contracts`, `packages/domain` | shared schemas, pure business rules |
| `docs/spec` | the product specification |
| `docs/adr` | inherited architecture decisions |
| `mockups` | HTML mockups of the main screens |

`CLAUDE.md` holds the working conventions and the invariants.
`deploy.md` covers the production VM.

## Status

Bootstrap. Identity, courses, classrooms and rosters work; pools, evaluations,
grading and the runner are the work ahead. See `docs/spec/`.
