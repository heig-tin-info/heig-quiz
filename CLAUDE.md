# quiz

A HEIG-VD teaching platform: question pools, live evaluations, grading,
practice, classroom journals and GitHub projects. One application monolith,
one PostgreSQL and a separate hardened question runner.

## Working rules and reading order

Read `AGENTS.md` first: each agent uses its own worktree, stages by path and
opens a PR. `main` receives merges only; a push deploys staging, production
requires approval (staging is `quiz.dev.chevallier.io`, ADR-028). Limit test
workers and stop servers you start.

Read [the specification index](docs/spec/README.md), then only the chapters
or sections relevant to the task. Check [unresolved questions](docs/spec/06-questions-ouvertes.md)
before deciding behavior. Use [the ADR topic index](docs/adr/README.md) for
rationale and scoped amendments. Historical snapshots are optional evidence,
not default context or current implementation instructions. Code and tests
establish what exists; a mismatch with an accepted requirement must be
reported, not silently turned into a new product decision.

For classroom migration work, read `docs/merge/README.md`, then the relevant
row of `PROGRESS.md` and task card. Those files own delivery progress; an
accepted ADR does not imply that its feature has shipped.

## Layout

The [repository map](docs/development/repository.md) owns the detailed layout.
For orientation: `apps/api` is Fastify; `apps/web` is the React SPA;
`apps/runner` executes question code; `apps/codespace` is the online workspace
portal (its own `CLAUDE.md`). `packages/contracts` owns HTTP schemas,
`packages/domain` pure rules, `packages/core` the question-type contracts,
`packages/registry` their static wiring, `packages/qt-*` the types,
`packages/diagram` the diagram engine and `packages/docrender` journal rendering.
`mockups/` holds the HTML origins of the circuit and diagram editors, the
categorize board and the grading table (ADR-044); `extensions/kiosk-attestation/` the kiosk stations' Chrome
extension (ADR-051); `infra/` the Keycloak development realm.

`core` never imports a `qt-*` package: register types through both registry
entry points (`./server`, `./client`). Generic web primitives go in
`apps/web/src/ui/`; `packages/ui` holds primitives shared by question types
and must not import a `qt-*` package or `apps/web`. The accepted `ui-kit`
extraction remains in ADR-035; do not create the superseded external npm
library of ADR-029. `ui-kit`, then `canonical`, then `cli` (in this order)
are planned, not present; consult the relevant spec/task
before implementing them.

For UI work, read `apps/web/DESIGN.md` and `.claude/skills/quiz-ui/SKILL.md`.
Screenshots are in `docs/assets/screenshots/`. Runner work also requires
`apps/runner/README.md` (hardening, images and integration checks).

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
   `pglite://` database and `KIOSK_ATTESTATION=mock` (ADR-051). The OIDC
   path (Keycloak in dev, Switch edu-ID in production) is the real one and
   stays intact.
4. **Content reaches a student only through the student view of its kind.**
   **Question content never reaches a student except through `toStudent`.**
   One point of exit, in the `studentView` service of the `live` module: it
   strips the internal name, the tags, the difficulty and the explanation,
   then applies the feedback policy. Every question type is tested with a
   full configuration passed through `toStudent`, by forbidden-key list AND
   by searching the serialized output for the answer-key values
   (`docs/spec/05-architecture.md`, 5.7).
   **The journal's one exit is the student view of the `journal` module**
   (M4-01/M4-02):
   no draft page, no page whose `visible_from` has not passed (the
   database's clock), no markdown, no blob sha, no warning, no count of what
   is hidden; an asset only when a page of that payload references it
   (N-SEC-12, N-SEC-13). Tested by a draft, a future page and an asset
   referenced by them only, searched for in every student response, for
   each student caller (05 §5.7).
5. **The server owns the clock.** A deadline is closed by the ticker, never
   by a client. The receipt time of a write is the server's, never the
   browser's. A write arriving after `deadline + 3 s` is refused with
   `410 attempt_closed`.
6. **Access is loaded, never checked afterwards.** One predicate,
   `staffAccess` in `apps/api/src/modules/guards.ts`: a user reaches a
   classroom if and only if they hold a seat on its course's staff, or an admin
   session has active Super Powers (`accessWhere`, ADR-054). An entity is loaded
   only if that holds; otherwise the answer is a 404 indistinguishable from a
   missing entity. What a member may DO on a course is a second step,
   `requireCourseRole` (owner or assistant, ADR-068), inside the loader: a
   403 `owner_required`, as for pools.
   **The student branch** is `readableClassroom`, in the same file (its
   rule is the pure `classroomPayload`), for the classroom routes a student
   reads: the course's staff (through `staffAccess`) get the staff payload,
   unless the request asks for the student payload (a teacher in the
   student view on their staff seat, ADR-018); that parameter can only
   narrow, never widen.
   An impersonation session (ADR-034) gets the student payload whatever it
   asks. A claimed enrollment reads its own classroom (student payload);
   anyone else gets the 404 of a missing classroom. The journal's routes
   serve portal sessions only, never a `seb` session (ADR-027).
   **A `kiosk` session** (ADR-051), like a `seb` one, is confined to one
   evaluation; it is worth nothing without its station's `quiz_kiosk`
   cookie beside it (`trustRefusal`, `auth/trust.ts`), and it ends with
   the attempt.
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
They bind `apps/runner`. The online workspace (`apps/codespace`, merge task
M6-03) is not held to 11 and 12: it has its own `CLAUDE.md` with its two
sanctioned divergences (a persistent work volume, a git channel on an
internal bridge).

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
    template and the student's editable regions — never taken as-is. A
    project's source is fetched by the server at the frozen sha, never
    uploaded by a client.

### GitHub invariant (ADR-035, N-SEC-16..18)

15. **Quiz's own GitHub App, and its secrets never at rest.** Every rule
    below is in force; the task named with each one delivered it (M1-02,
    M2-03, M2-04, M2-06). Quiz talks to
    GitHub only through its own App (D23), never heig-classroom's; staging
    has a separate App on a test organization and never holds the
    production one (N-SEC-18; M2-06). The App key, webhook secret and
    client secret stay out of the repository and the database (ADR-010);
    installation tokens live in memory only; no token is ever stored nor
    logged, and the redaction knows `x-access-token:` and `gh?_` (M1-02);
    a token is never in a URL, a file or git's argv: `gitRunner({ token })`
    hands it to git through the environment only; the user token of an account
    link reads the account once and is discarded (M2-03). Under
    `NODE_ENV=production`, `config.ts` refuses to start with an App id whose
    key file is unreadable, a webhook secret under 32 characters, no App
    slug, or no OAuth client id and secret (M2-03); with no `GITHUB_*` set the GitHub features are off and the rest
    starts (M1-02). `/webhooks/github` trusts nothing before its HMAC over the
    raw body is verified in constant time (M2-04).
    The online workspace portal (`apps/codespace`) never holds an App
    credential: it obtains from Quiz, through the HS256 service route of
    ADR-078, an installation token scoped to one repository (`contents`
    only), valid at most an hour, which it keeps in memory only and hands to
    git through the environment, never in a URL, argv or file; Quiz issues
    one only for a repository of an online project the student launched,
    before its effective deadline plus the grace, and audits each issuance
    without the token; an App push counts as the student's only when the
    portal declared its head beforehand — a rule that keeps Quiz's own
    commits from being misread, not a defence against a compromised portal,
    which holds the signing secret.

## Development

The [development guide](docs/development/index.md) owns setup, demo personas,
the smoke test and optional PostgreSQL/OIDC/Podman paths. Use Node as required
by `package.json` and the pinned pnpm version. Build packages before running
the apps: they import workspace `dist/` outputs.

No Docker, Podman or PostgreSQL is needed for this path.

```bash
corepack enable pnpm && pnpm install --frozen-lockfile
pnpm build
cp .env.example .env
pnpm seed
pnpm dev            # API :3000, Vite :5173 (open it, click Dev login)
```

Local PGlite is single-process: stop the API before seeding. The seed is
idempotent and uses ordinary services, never raw inserts. Production refuses
PGlite, development login and the LLM stub.

```bash
pnpm build && pnpm typecheck
VITEST_MAX_WORKERS=4 pnpm -r --workspace-concurrency=1 test
pnpm dev:mock       # UI only; stop it when finished
pnpm db:generate    # schema changes include the generated migration
```

While iterating, test only the affected files; run the full suite once at the
end with the memory guard of `AGENTS.md`. Use `pnpm smoke` against a seeded
API for an HTTP lifecycle check; `pnpm test:coverage` for the coverage gate.

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
- Start ADR research at [the topic index](docs/adr/README.md); read each
  record's Status and scoped amendments before applying its Decision.
- A non-trivial decision becomes an ADR in `docs/adr/`, using
  [the template](docs/adr/TEMPLATE.md) and the index's maintenance rules.
- Before declaring a screen finished, look at it: `pnpm dev:mock`, then the
  screenshots (`apps/web/scripts/screenshots.mjs`).
