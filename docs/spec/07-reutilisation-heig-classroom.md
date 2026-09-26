# 7. Reuse of heig-classroom

The `~/heig-classroom` repository is a project by the same author, in production, with the same stack, the same IdP and the same operating constraints. **The quiz portal starts as a pruned copy of that repository**, rather than from a blank one. The agents that will code the product must read this page before creating anything that already exists there.

## 7.1 What heig-classroom is

pnpm monorepo, two applications:

| Path | Role | State |
|---|---|---|
| `apps/server` + `apps/web` | GitHub Classroom portal: classrooms, assignments, student repositories, grading by CI | Production, `classroom.chevallier.io` |
| `apps/codespace` | Portal of supervised development environments: code-server, hardened rootful Podman, SEB exam mode | In testing |
| `packages/domain`, `packages/contracts` | Pure business rules and shared zod schemas | |

Stack: Node 22, strict TypeScript, Fastify 5, zod 4, Drizzle on PostgreSQL, pg-boss, openid-client, React 19, Vite, Tailwind 4, TanStack Query, vitest, Playwright for the screenshots. Everything is written in English: code, comments, documentation, commits. Only the user interface is translated. **These conventions apply as they are to the quiz portal.**

Thirteen ADRs in `docs/adr/` document the choices. ADRs 001, 002, 003, 004, 005, 006, 008, 009, 010 apply without modification to the quiz: modular monolith, Fastify, Postgres and Drizzle, pg-boss, SSE without WebSocket, single ticker for the deadlines, React SPA, VM and Compose, secrets outside the repository and outside the database.

## 7.2 To reuse as-is

| Element | Path in heig-classroom | Use in the quiz |
|---|---|---|
| edu-ID OIDC login | `apps/server/src/auth/oidc.ts`, `auth/plugin.ts` | Identical. Authorization Code + PKCE, `state` and `nonce`, `private_key_jwt` client authentication for edu-ID or `client_secret` for Keycloak in dev, lazy discovery with cache. The `https://eduid.ch/scope/userinfo.read` scope is already handled. |
| Claims capture | `auth/claims.ts`, table `user_idp_claims` | Identical. Keeps everything the IdP delivers for diagnosis, without ever exposing it. `affiliationsOf` extracts `eduPersonAffiliation`, which is the source of the teacher or student role, see F-AUTH-02. Note observed in production: `eduPersonPrimaryAffiliation` is not delivered. |
| Multi-address identity | `identity.ts`, table `user_emails` | Identical. edu-ID delivers the address chosen by the user, sometimes a private one, while the GAPS roster contains the `@heig-vd.ch` address. An identity is a set of addresses, roster matching is done on that set, collisions are reported to the teacher. This problem is already solved, do not rediscover it. |
| Opaque sessions | `auth/session.ts` | Identical. Random token, only the SHA-256 hash is stored, separate CSRF cookie. |
| Development Keycloak | `docker-compose.dev.yml`, `infra/keycloak/hgc-dev-realm.json` | Identical. A real OIDC even in dev, no "current user" through an environment variable. Add a `quiz` client to the realm. |
| Typed configuration | `apps/server/src/config.ts` | Same zod schema of the environment variables, with the refusal of dev values in production. |
| Roster import | `packages/domain/src/roster.ts`, `apps/web/src/RosterImport.tsx`, `RosterTable.tsx` | Identical. CSV paste or Excel file drop, permissive detection of the last name, first name and email columns, atomic import. Add the extra time column in percent, F-ORG-07. |
| Guards and access loaders | `apps/server/src/modules/guards.ts` | Same pattern: a single `staffAccess` predicate, entities are loaded if and only if the user has access to their classroom, otherwise a 404 indistinguishable from a missing entity. |
| Audit log | `audit.ts`, table `audit_log` | Identical, closed catalogue of actions as a TypeScript union. Covers F-ADMIN-04. |
| Event bus and SSE | `events.ts`, `modules/events.ts`, `apps/web/src/live.ts` | To reuse with an extension, see 7.3. Events are refresh hints by topic, never data. Native `EventSource` reconnection, TanStack Query refetch, no replay. |
| Job queue | `jobs.ts`, pg-boss | Identical. Replaces the home-made `jobs` table planned in 5.6. Queues `grading.auto`, `grading.runner`, `grading.llm`, `export.pool`. |
| Deadline ticker | `ticker.ts`, `deadline.ts` | Same mechanism: a periodic loop, Postgres advisory lock, SQL selection of the attempts whose `deadline_at + grace <= now()` and not closed, closing by conditional UPDATE. Period to bring down from 20 s to 1 s for the quiz, which stays trivial for 100 open attempts. The principle "rescheduling is free, catching up after an outage is free" is exactly what F-LIVE-07 and F-LIVE-11 ask for. |
| Two-step freeze | ADR-012 | Same logic for the grades: provisional grade at closing, final at release, F-GRADE-09. The server's receipt time is authoritative, never the client's time. |
| Design system | `apps/web/DESIGN.md`, `apps/web/src/style.css`, `apps/web/src/ui.tsx`, `theme.ts`, `.claude/skills/hgc-ui/SKILL.md` | To reuse in full, see 7.4. |
| i18n | `apps/web/src/i18n.tsx` | Same mechanism: flat dictionary per locale, `t(key, vars)`, choice persisted on the account with a localStorage mirror. Difference: in the quiz, the teacher surfaces are translated too, N-I18N-01. |
| Browser mock | `apps/web/src/mock/`, `dev:mock`, `?as=teacher` | Identical. Lets one develop and capture every screen without a backend. |
| Screenshots | `apps/web/scripts/screenshots.mjs` | Identical. Every touched screen is captured at 1440×900 and 390×844, light and dark. |
| Deployment | `Dockerfile`, `compose.prod.yml`, `Caddyfile`, `deploy.sh`, `deploy.md`, `backup` service | Identical, removing Keycloak from production. The Postgres backup service already exists. |
| Tests | `apps/server/src/test/db.ts` with PGlite, `*.db.test.ts` conventions | Identical. Database tests without an external Postgres. |
| Markdown rendering | `apps/web/src/markdown.tsx` | No. It is a minimal rendering for the help, trusted content. The quiz needs a real editor and a sanitised rendering with KaTeX, see 5.1. |
| GitHub integration | `apps/server/src/github/`, `octokit` | No. Remove. |
| Mailer | `mailer.ts`, `modules/email.ts` | Later. Useful to notify the release of the results, F-GRADE-09, but not in phase 1. |

## 7.3 To adapt

**SSE**. The heig-classroom bus only carries hints; the client refetches. For the quiz, this is enough for the teacher dashboard and the evaluation state. Two additions:

1. A heartbeat every second on the stream of an open attempt, carrying `serverNow` and `deadlineAt`, for the clock, see 5.4. The 25 s heartbeat of heig-classroom remains for the other pages.
2. An `attempt:<id>` topic and an `evaluation:<id>` topic in the topic grammar, in addition to `classroom:<id>`, `teacher:<id>`, `user:<id>`.

Writing answers stays in REST, as ADR-005 provides.

**Roles**. heig-classroom treats teacher and assistant as labels without a permission level. The quiz keeps that simplicity: every staff member of a course has the same rights. The global `teacher` role comes from the edu-ID affiliation or from promotion by the admin.

**Schema**. Reuse `users`, `user_emails`, `user_idp_claims`, `sessions`, `audit_log`, `avatars`, `classrooms`, `enrollments`. Remove `organizations`, `assignments`, `student_repos` and everything touching GitHub. Add the tables of [01-glossaire-et-domaine.md](01-glossaire-et-domaine.md). heig-classroom uses UUIDs, so does the quiz, the spec spoke of ULIDs: **UUID v7 is retained**, sortable and generatable client-side.

## 7.4 Visual identity

The quiz portal takes over the heig-classroom design system as it is. It is already the line requested in the README: sober, no frames, one primary action per screen, semantic tokens, light and dark by swapping variables without a `dark:` variant in the markup.

- **Tokens**: `canvas`, `surface`, `surface-2`, `surface-3`, `line`, `line-strong`, `fg`, `fg-muted`, `fg-faint`, `accent`, `accent-soft`, `on-fill`, `success`, `warning`, `danger` and their `soft` variants. Defined in `style.css`, documented in `DESIGN.md`, 230 lines to read first.
- **Typography**: variable Manrope for text, variable JetBrains Mono for code.
- **Primitives** in `ui.tsx`, 2000 lines: `Button`, `IconButton`, `Card`, `Badge`, `Alert`, `Field`, `Select`, `Textarea`, `Segmented`, `Switch`, `Tabs`, `Menu`, `Modal`, `Sheet`, `PageHeader`, `SectionHeading`, `Stat`, `EmptyState`, `Skeleton`, `Spinner`, `Progress`, `T` table styles with sorting, `useConfirm`, `useLayer`, `useEscape`, `useNow`.
- **Rules** of the `hgc-ui` skill: five states per asynchronous surface, long forms in a `Sheet`, confirmations through `useConfirm`, seven columns at most, full keyboard support, mandatory screenshot before declaring a screen finished.
- **Accent difference**: the HEIG-VD red accent of heig-classroom may be kept or replaced by a hue of the quiz's own. A single token to change.
- **To add** for the quiz: waiting-room progress ring, countdown, students × questions grid, question progress bar, correct / partial / wrong verdict cells with an icon. These components go into `ui.tsx` or into a `packages/ui` if they become numerous. (Superseded on 2026-09-23: they live in `apps/web/src/ui/live.tsx` since PR #36; `packages/ui`, PR #51, holds the primitives the question-type packages share.)

The `.claude/skills/hgc-ui/SKILL.md` skill is copied into the new repository under a name of the quiz's own, with the paths updated.

## 7.5 Runner principle

heig-classroom has no built-in code runner: grading is done by GitHub Actions on ephemeral self-hosted runners, ADR-007. That is not the quiz's model. On the other hand, `apps/codespace` contains exactly the container hardening the quiz's runner needs:

| Element | Path | Use in the quiz |
|---|---|---|
| Hardening options | `apps/codespace/images/c-dev/run-hardened.sh` | Reuse the list: `--userns=auto`, `--cap-drop=ALL`, `--security-opt no-new-privileges`, seccomp profile, `--read-only`, `--pids-limit`, working tmpfs, `--network none`. These are the options of N-SEC-06. |
| seccomp profile | `apps/codespace/infra/seccomp/codespace.json` | Reuse. Already tested with a C toolchain. |
| C image | `apps/codespace/images/c-dev/Containerfile` | Base for the `runner-c` image, removing code-server. One image per language, same structure. |
| Engine module | `apps/codespace/src/engine/` | Driving Podman in `--remote` through the socket, `--format json` output. Reuse as the base of `apps/runner`. |
| Invariants | `apps/codespace/CLAUDE.md` | "No secret inside the container", "network closed by construction", "hardening from the very first run". Copy into the quiz's `CLAUDE.md`. |
| Internal nftables network | `apps/codespace/infra/net/`, `infra/nft/` | Not needed. The quiz's runner is in `--network none`, it has no git channel to open. |
| SEB mode | `apps/codespace/src/seb/` | The Config Key and the `.seb` file, cut down to the plist subset the quiz writes, in `apps/api/src/auth/seb.ts` (ADR-027). The signed exam cookie and the BEK list are not reused: the quiz opens a typed session from a one-time ticket. |

Consequence on [05-architecture.md](05-architecture.md), section 5.5: the runner is driven by **rootful Podman in `--remote`** like the codespace, rather than by the Docker socket. gVisor remains the recommended option on top, if the Hetzner VM accepts it; otherwise the codespace's Podman hardening is the reference, it is already proven. The codespace maintains a long session per student, the quiz's runner launches one container per execution of a few seconds: the engine module is reused, the session management is not.

## 7.6 Steps to start the repository

1. Copy heig-classroom into a new repository, history not kept.
2. Remove `apps/codespace` after moving `images/c-dev`, `infra/seccomp`, `src/engine` to `apps/runner`.
3. In `apps/server`: remove `github/`, `modules/webhooks.ts`, `repos.ts`, `sync.ts`, `codespace.ts`, `mailer.ts` for now, and the associated tables. Keep auth, identity, sessions, guards, audit, events, jobs, ticker, config, test.
4. In `apps/web`: keep `ui.tsx`, `style.css`, `theme.ts`, `i18n.tsx`, `Shell.tsx`, `Header.tsx`, `notify.tsx`, `confirm.tsx`, `RosterImport.tsx`, `RosterTable.tsx`, `SettingsPage.tsx`, `AdminPanel.tsx`, `mock/`, `scripts/`. Remove the assignment screens.
5. Rename the `@hgc` package scope to a scope of the quiz's own, update `DESIGN.md` and the UI skill.
6. Create `packages/core` with the `QuestionType` contract and the registry, then `packages/qt-mcq` as the first type, before any evaluation screen.
7. Check that `pnpm build && pnpm typecheck && pnpm test` passes on the empty skeleton before adding a feature.
