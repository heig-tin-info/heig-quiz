# Git channel (P3)

The staging repository and the relay to the forge, as described in
[docs/analyse.md](../../../../docs/analyse.md) section 3.1 and in
[docs/milestone-0.md](../../../../docs/milestone-0.md) section P3.

```
container ──push──▶ portal 10.77.0.254:9418/git/<session>  (auth = source IP)
                       │  git http-backend  →  <VOLUMES_ROOT>/<s>/<a>/staging.git
                       │  PushEvent (ref, sha, timestamp, pending)
                       └─ relay ──push (token in an env variable)──▶ forge
```

## Modules

| file              | role |
| ----------------- | ---- |
| `httpBackend.ts`  | Fastify plugin, IP check, upload-pack policy, CGI to `git http-backend` |
| `cgi.ts`          | reading the CGI headers (`Status:` included) without buffering the body |
| `staging.ts`      | creation and seeding of the bare staging repository (lab, exam, empty modes) |
| `pushEvents.ts`   | `diffRefs`, `recordPush` (invariant 7), Drizzle store |
| `relay.ts`        | background job, retry on error, never forced, `rejected` refs, token out of argv and off the disk |
| `forge.ts`        | the `Forge` interface, the `forgejo` forge and the unconfigured `github` one |
| `quizForge.ts`    | the `quiz` forge: tokens Quiz grants per repository, cached in memory (ADR-078) |
| `fixtures.ts`     | shared test repositories (not a `*.test.ts`, therefore type-checked) |

The `push_events` table: [`src/db/schema.ts`](../db/schema.ts).

## Dependencies of the integration tests

`channel.integration.test.ts` needs **rootful** Podman and Forgejo. Without
them, or without `FORGE_TOKEN`, the file skips itself with a warning; the other
tests (including the whole Git channel over the loopback) run with nothing at
all.

### Podman in remote mode

Every command goes through the rootful socket. In zsh, a function, never a
variable:

```zsh
p() { /usr/bin/podman --remote --url unix:///run/podman/podman.sock "$@" }
p version
```

### The `codespace` network

Created by `infra/net/setup.sh` (task P2). Idempotently, with exactly the
options of invariant 2:

```zsh
p network exists codespace || \
  p network create --internal --disable-dns --subnet 10.77.0.0/24 --gateway 10.77.0.254 codespace
```

Never delete it: other sessions may be attached to it. P2 keeps a permanent
`codespace-anchor` container on it (`label heig-codespace.role=anchor`) so that
the `cs0` bridge and the 10.77.0.254 address exist at all times — do not delete
that one either.

`startGitServer` therefore binds to `CODESPACE_GATEWAY` (10.77.0.254 by
default) and only falls back to `0.0.0.0` when that address is not present
(`EADDRNOTAVAIL`, a bridge with no container attached). The source-IP check
applies in both cases: a listening address can be undone by an environment
variable (analyse.md 4.1).

### Forgejo

`podman-compose` calls `podman` without `--remote`; so it is given a `podman`
that adds it:

```zsh
mkdir -p /tmp/podman-remote
cat > /tmp/podman-remote/podman <<'EOF'
#!/bin/sh
exec /usr/bin/podman --remote --url unix:///run/podman/podman.sock "$@"
EOF
chmod +x /tmp/podman-remote/podman
PATH=/tmp/podman-remote:$PATH podman-compose -f infra/compose.dev.yml up -d forgejo
```

The container is called `infra_forgejo_1` (project name = the `infra`
directory). The equivalent without `podman-compose`:

```zsh
p volume create forgejo-data
p run -d --name infra_forgejo_1 -p 127.0.0.1:3300:3000 \
  -e USER_UID=1000 -e USER_GID=1000 \
  -e FORGEJO__server__ROOT_URL=http://localhost:3300/ \
  -e FORGEJO__server__HTTP_PORT=3000 \
  -e FORGEJO__security__INSTALL_LOCK=true \
  -e FORGEJO__database__DB_TYPE=sqlite3 \
  -v forgejo-data:/data codeberg.org/forgejo/forgejo:11
```

### Development user and token

`forgejo` refuses to run as root: the `exec` is done as `-u 1000`.

```zsh
p exec -u 1000 infra_forgejo_1 forgejo admin user create \
  --username codespace --password '<dev password>' \
  --email codespace@dev.local --admin --must-change-password=false

curl -s -X POST -u 'codespace:<dev password>' -H 'Content-Type: application/json' \
  -d '{"name":"p3-dev","scopes":["write:repository","write:user"]}' \
  http://127.0.0.1:3300/api/v1/users/codespace/tokens
```

The `sha1` that comes back goes into the **local** `.env` (git-ignored), never
into a tracked file, never into a report:

```
FORGE_URL=http://localhost:3300
FORGE_TOKEN=<returned sha1>
FORGE_USER=codespace
FORGE_CONTAINER=infra_forgejo_1
```

The test reads that `.env` itself (vitest does not load it).

### Image of the test container

`codespace/c-dev:4.137.0`, the P1 student image, since V1: it carries git and
it is the one sessions actually launch. (`CODESPACE_IMAGE` allows pointing at
another one.) An image without git would not do: the `codespace` network is
`--internal`, so an `apk add git` on the fly is impossible there.

## Running the tests

```bash
pnpm --filter @quiz/codespace test
pnpm typecheck
```

`tsconfig.json` excludes the `*.test.ts` files from the typecheck; to check
them:

```bash
cd apps/codespace && ./node_modules/.bin/tsc --noEmit \
  --target ES2022 --module NodeNext --moduleResolution NodeNext --strict \
  --noUncheckedIndexedAccess --exactOptionalPropertyTypes --esModuleInterop \
  --skipLibCheck --types node,vitest/globals src/git/*.test.ts
```

## Wiring done in V1

- `db.ts` is gone: the database is the portal's own
  ([`db/client.ts`](../db/client.ts)), with the drizzle-kit migrations of
  `drizzle/`. `openGitDb` survives there under the same name, for the tests of
  this module.
- `SessionLookup` is wired to the `sessions` table
  ([`sessions/manager.ts`](../sessions/manager.ts), field `lookup`): the
  container address comes from the session row.
- `stagingTargets` receives the target repository **of the session**, through
  `manager.repoOfEvent`: the repository the classroom launch token brought
  along (`sessions.targetRepo`) and, failing that, the convention of the
  assignment (`targetRepo` or `targetRepoPattern`) for the standalone YAML
  seed. The session is found by the identifier the event carries, not by the
  pair, because it outlives the destruction of the container — the relay has to
  stay correct during a long forge outage.
- `startGitServer` is bound to `CODESPACE_GATEWAY:9418` by `server.ts`; the
  other surfaces of the portal listen on `HOST:PORT`.
- The workspace of the session receives an `origin` remote pointed at
  `http://portal.internal:9418/git/<session>`
  ([`sessions/workspace.ts`](../sessions/workspace.ts)).

## The forge authorization, on both sides

`gitRunner.gitAuthEnv` is the **only** vehicle carrying a token to `git`:
`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0`, hence
`http.extraHeader` without a configuration file. Never in argv, never on disk,
and `redactSecrets` strips it from error messages.

It serves both directions of the channel:

| direction | caller | token |
| --- | --- | --- |
| `push` to the forge | `relay.ts` (`buildPushEnv`) | `Forge.authorization(repo, owner)` |
| seeding `fetch` | `staging.ts` (`ensureStagingRepo({ authorization })`) | the same |

The second one was missing until 2026-09-17: a student repository provisioned
by classroom is **private**, the anonymous `fetch` was refused, the failure
swallowed, and the session opened on an empty workspace. `sessions/manager.ts`
now refuses to start a session whose repository could not be retrieved.

heig-classroom's App-backed GitHub forge (`createGithubForge`, an
installation token per organisation) was not imported into Quiz: the portal
refuses any GitHub App credential.

## The `quiz` forge (ADR-078, M6-10)

`quizForge.ts`, `FORGE_KIND=quiz` (the default once `PLATFORM_URL` and
`CODESPACE_LAUNCH_SECRET` are set). GitHub is reached with installation
tokens **Quiz** mints with its own App on the app VM, one repository at a
time, `contents` only:

| call | when | answer |
| --- | --- | --- |
| `POST <PLATFORM_URL>/app/codespace/git-token` | per relay attempt and seeding fetch, unless cached | `GitTokenGrant`: `token`, `expiresAt`, `useUntil`, `permission` |
| `POST <PLATFORM_URL>/app/codespace/relay-heads` | before every relay push | `204`: the heads declared, so Quiz reads the App's push of them as the student's |

Each request **is** an HS256 token over `CODESPACE_LAUNCH_SECRET` (audience
`heig-quiz-git-token` or `heig-quiz-relay-heads`, a minute, a `jti`, the
project, the user and the repository in its claims); the body is empty.

- **Cache**: in memory, one entry per (project, user, repository); reused
  while `now < expiresAt - 10 min` and `now < useUntil`; one request in
  flight per entry. `useUntil` (the deadline plus the grace) is a hard
  stop: the entry is dropped and revoked, no request is made then; the next
  attempt asks again, which only an extended deadline answers. Dropped too
  when GitHub refuses it (401/403: `invalidate`) and when its session closes
  with nothing pending (`forget`, revoked). A token that lands after
  `forget` serves its one waiting attempt, is not kept, and is revoked when
  that attempt settles (`Forge.settle`, called by the relay and the seeding).
- **Refusals**: Quiz's `401`/`404`/`409` are `ForgeRefusedError` (a
  `ForgeUnconfiguredError`): the rows stay `pending` on the slow backoff.
  A `503` or a network failure is an outage (ordinary backoff, then
  `failed`). At seeding, any refusal refuses the session with a named cause.
- **The token**: `Authorization: basic base64(x-access-token:<token>)`
  through `gitAuthEnv(authorization, url)`, always scoped to the remote's
  origin (`http.https://github.com/.extraHeader`): never sent to another
  host, and not set at all for a non-HTTP remote. The forge itself fails
  closed on any origin but `https://github.com` (`ForgeOriginError`): it asks
  Quiz nothing and hands out nothing.
- **No force, no deletion** (`relay.ts`): `refspecFor` is `<sha>:<ref>`. On
  a non-fast-forward (`[rejected] (fetch first|non-fast-forward)` in the
  porcelain output) the forge's head of that branch is fetched into
  `staging.git` (the branch there moves to it), and the ref's rows take the
  terminal state `rejected` with git's reason; so does a ref GitHub refuses
  itself (`[remote rejected]`, a workflow file without `workflows`). The
  other refs of the atomic push are retried at once. A branch deletion is
  `rejected` (`DELETION_NOT_RELAYED`), never pushed.
- **Who sees a rejection**: the student, in the status bar
  (`GET /git/<session>/push-status`, `httpBackend.ts`, same source-address
  door as the Git services); the staff, in Quiz's workspace list
  (`CodespaceSessionSummary.rejectedPush`). Both read `lastRejectedPush`: a
  later push of the same branch replaces it.

## What is left to do after V1

- Nothing of the relay itself; the staging checks of ADR-078 §9 (forced
  push against `hgc-protect`) are the M6-10 card's manual acceptance.
