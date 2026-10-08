# apps/codespace — the online workspace portal

`@quiz/codespace`: VS Code in the browser (code-server) inside hardened
rootful Podman containers, one per (student, assignment), with an SEB exam
mode. A separate deployable on the engine VM, beside `apps/runner`: it
imports only `packages/*` (`@quiz/domain` for HS256, `@quiz/seb` for the SEB hashes, `@quiz/contracts` for
the codespace schemas) and talks to the platform through two HS256-signed
HTTP messages (ADR-047). Imported from heig-classroom's `apps/codespace` at
classroom `a676c8c` (merge task M6-03).

The root `CLAUDE.md` and `AGENTS.md` apply here. Of the root invariants,
only 11 and 12 are relaxed, on exactly the two points below; everything else
(1 included: every page in English and French) binds this app as it is. Read [ADR-047](../../docs/adr/ADR-047-espace-de-travail-en-ligne.md)
and its M6-03 amendment, then [docs/merge/06-codespace-seb-infra.md](../../docs/merge/06-codespace-seb-infra.md)
§6.2–§6.4.

## Where to read

| Kind | Documents |
| --- | --- |
| Reference | [docs/analyse.md](docs/analyse.md) (decisions D1–D8), [docs/integration-classroom.md](docs/integration-classroom.md) (the platform boundary, written for heig-classroom), [docs/setup-workstation.md](docs/setup-workstation.md), [images/c-dev/README.md](images/c-dev/README.md) (the student image), [src/git/README.md](src/git/README.md) (the Git channel), [src/seb/README.md](src/seb/README.md) (the SEB verification; its `.seb` and Config Key sections are history since M6-07), [infra/net/README.md](infra/net/README.md) (the closed network) |
| History, superseded in places | [project.md](project.md), [docs/milestone-0.md](docs/milestone-0.md), [docs/v1.md](docs/v1.md), [docs/leads.md](docs/leads.md), [docs/proof-b-manual.md](docs/proof-b-manual.md) |

These documents describe heig-classroom's portal: read *classroom* as the
platform, and ignore what they say about the portal's own OIDC login, its
Start button, its teacher dashboard and its YAML seed (all removed, below).

## What M6-03 changed, and what is inert

- **No login of its own.** No `/auth/*`, no home page with a Start button,
  no `/teacher/sessions`, no standalone `/exam/:id/start` (it answers 404):
  a user exists only through the platform's launch token (`/launch`), and
  a teacher sees sessions in Quiz, which calls
  `GET /api/assignments/:id/sessions` with a service token. Without
  `CODESPACE_LAUNCH_SECRET` the portal opens no session at all.
- **The GitHub relay goes through Quiz** ([ADR-078](../../docs/adr/ADR-078-codespace-git-relay-tokens.md),
  M6-10). The portal holds no GitHub App credential: `GITHUB_APP_ID` and
  `GITHUB_APP_PRIVATE_KEY_PATH` are refused at startup in every
  environment (root invariant 15), and classroom's App-backed GitHub forge
  was not imported. The `quiz` forge (`src/git/quizForge.ts`) — the
  default once `PLATFORM_URL` and `CODESPACE_LAUNCH_SECRET` are set —
  asks Quiz (`POST /app/codespace/git-token`) for an installation token
  scoped to one repository, `contents` only, kept in memory until 10
  minutes before it expires and never past its `useUntil` (the deadline
  plus the grace), handed to git through the environment only; it
  declares each head (`POST /app/codespace/relay-heads`) before a relay
  push that is never forced (`<sha>:<ref>`, no deletion relayed). A
  non-fast-forward is a terminal `rejected` `PushEvent`, shown in the
  status bar (`GET /git/<session>/push-status` on the git channel) and in
  Quiz's workspace list. `none` (also the default without the platform)
  relays nothing; `github` is the unconfigured forge (public clone URLs,
  no relay) and `forgejo` the development one, both refused in production.
- `PLATFORM_URL` replaces `CLASSROOM_URL` (still read as an alias); launch
  and service tokens are accepted from both issuers, `heig-classroom` and
  `heig-quiz`.
- `src/seb/` moved onto `packages/seb` at M6-07 (D21): the platform builds
  every `.seb`; the portal keeps the `/launch` check (`verify.ts`, the
  Config Key from the token's `seb` claim, Browser Exam Keys optional) and
  the proxy's cookie check (`check.ts`). No `/exam/:id.seb` any more.
- **Not imported**: heig-classroom's `deploy/` and `docs/deploy.md` (its VM
  recipe, which wrote a configuration this portal refuses and copied
  classroom's App key) and its end-to-end script (it drove the removed
  login and seed). Comments that cite "classroom's `deploy/`" or
  "classroom's `docs/deploy.md`" point to `~/heig-classroom/apps/codespace`.
- **Deployed since M6-04**: two instances, `prod` and `staging`, on the
  engine VM (ADR-016's M6-04 amendment, [deploy/RUNBOOK.md](deploy/RUNBOOK.md)).
  `CODESPACE_INSTANCE` names an instance; its session containers carry its
  name and label, and an engine lists only its own (`engine/instance.test.ts`).
  `images/` is built on the VM by hand (`images/build.sh`), never in CI.
- **Pages in English and French** (`src/web/i18n.ts`, the language from
  `Accept-Language`, French by default): `en` is the dictionary, `fr` is
  typed `Record<keyof typeof en, string>`, so a missing translation is a
  compile error. Every sentence a person reads goes through `t()`.
- **The request log** writes no header and masks `token=` in URLs
  (`src/logging.ts`): a launch token is a live credential.

## Sanctioned divergences from the root invariants

Root invariants 11 and 12 bind `apps/runner`. This portal diverges from
them on exactly two points, and on nothing else:

1. **A persistent work volume.** `-v <workDir>:/work:U`, one directory per
   (student, assignment) under `VOLUMES_ROOT`, kept across container
   restarts and after the session closes (with its `shadow.git`
   snapshots). The runner's `/work` is a tmpfs and nothing from the host is
   mounted; here the student's work must survive the container.
2. **A git channel on an internal bridge.** Containers run on the Podman
   network `codespace` (`--internal --disable-dns`, subnet `10.77.0.0/24`,
   gateway `10.77.0.254`), started with `--dns=none --add-host
   portal.internal:10.77.0.254`, instead of `--network none`. The only
   reachable surface is the portal's git channel on the gateway, port 9418,
   authenticated by the container's source address; the two fixed nftables
   rules of `infra/nft/codespace.nft` forbid inter-container traffic and
   every other host port.

Everything else of 10–13 holds: the closed environment list
(`CONTAINER_ENV_KEYS`, tested), the hardening flags from the first run
(with two additions, not relaxations: `apparmor=codespace` and a tmpfs in
`mode=1777`), the runner's seccomp profile with one rule added, `ptrace` for
gdb (`infra/seccomp/codespace.json`, held to it by `src/seccomp.test.ts`,
M6-05), `podman --remote` on the rootful socket. Exam mode seeds from the teacher's template, in the spirit
of 14. The freeze-and-collect exam mode of M6-08 (ADR-075) drops the git
channel divergence for its containers.

## The portal's own invariants

1. **No secret inside the student container.** No token, no key, no
   credential helper. The closed list of variables set at `podman run` is
   `CONTAINER_ENV_KEYS` (`src/sessions/manager.ts`): three `CODESPACE_*`
   for the status bar extension, four `GIT_{AUTHOR,COMMITTER}_{NAME,EMAIL}`
   for the student's git identity. None is a secret; a unit test and
   `images/c-dev/test.sh` § 9 assert there is no other one. Adding a key is
   done in that list, with its test.
2. **The network is closed by construction** (divergence 2 above): the
   `codespace-anchor` container (label `heig-codespace.role=anchor`) keeps
   the bridge alive; never delete it, never count it as a session. No
   per-session firewall rule.
3. **Hardening from the very first `podman run`**: the exact options are in
   `images/c-dev/run-hardened.sh` and `src/engine/` reuses them as they
   are. A test that needs an option relaxed says so in the docs, not in a
   comment. `CODESPACE_APPARMOR_PROFILE` empty drops the AppArmor flag (a
   host without AppArmor, the WSL2 workstation).
4. **`TRUSTED_PROXY_IPS` is required in production.** The exam cookie is
   bound to `request.ip`; behind a local reverse proxy, without the list,
   every student is 127.0.0.1 and the binding never fires. `loadConfig()` refuses to start;
   the boolean `TRUST_PROXY` is development only and refused in production.
5. **`SEB_VERIFIER=simulated` is refused in production**, by `loadConfig()`
   and again by `createSebVerifier`; a test asserts both.
6. **The proxy to code-server never reads a SEB header.** It knows only the
   session cookie (rotated on every opening, resumption and close) and the
   exam cookie bound to the client address. The SEB verification happens
   once, on `GET /launch`.
7. **A launch token is used only once.** Its `jti` is consumed by inserting
   a row into `launch_tokens_used` before any other check: the primary key
   is the guarantee. A token refused for any other reason is burnt.
8. **The quota is per teacher, across all assignments**, counted on
   `sessions.teacherId` in the live states. Resuming a live session does
   not consult it.
9. **A token grants no role.** Every portal account is born from a launch
   token as a student; nothing writes `users.role` any more.
10. **`PushEvent` before relay.** A push's `PushEvent` row is written before
    any relay attempt (none while the relay is off): it is the proof of
    submission. The relay never forces and never deletes a branch
    (ADR-078 §6); a GitHub token never reaches argv, a URL, a file, SQLite,
    a log line or a container.
11. **The exam staging repository is seeded from the teacher's template**,
    never from the student's repository.
12. **The platform owns the `.seb`** (D21, M6-07): it builds the file,
    whose `startURL` is the platform's one-time ticket and whose URL filter
    allows the platform, the portal and the platform's
    `SEB_EXTRA_ALLOWED_HOSTS`; the student's Config Key reaches `/launch`
    signed in the launch token (`seb` claim). An exam token without it is
    refused.

## Commands

```bash
pnpm --filter @quiz/codespace build
pnpm --filter @quiz/codespace typecheck
VITEST_MAX_WORKERS=4 pnpm --filter @quiz/codespace test   # unit: no Podman, no forge
pnpm --filter @quiz/codespace test:integration            # rootful Podman + Forgejo; never in CI
```

The unit suite needs `git` (the git channel and staging tests run real git
on temporary repositories) and nothing else. The integration suite needs
`sudo infra/net/setup.sh` (the `codespace` network and nftables), the
student image (`podman build -t codespace/c-dev:4.137.0 images/c-dev`, then
`images/c-dev/test.sh`), the rootful socket `/run/podman/podman.sock` (the
user in the `podman` group, docs/setup-workstation.md) and, for the relay,
the Forgejo of `infra/compose.dev.yml` with `FORGE_KIND=forgejo`. The portal
listens on :3100 (`pnpm --filter @quiz/codespace dev`, with
`apps/codespace/.env` from `.env.example`). This component is privileged;
the nftables rules are the only expected use of sudo.

## Conventions

- Any code-server, Podman or nftables option whose existence has not been
  verified in the pinned version is marked `TODO(verify)` with the version.
- Decisions go into the repository's `docs/adr/` (the portal has none of
  its own). Do not modify `project.md` (history).
- Schema changes: `pnpm --filter @quiz/codespace db:generate` writes the
  SQLite migration into `drizzle/`; `src/db/client.ts` applies them on open.
