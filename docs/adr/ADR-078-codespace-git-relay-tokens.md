# ADR-078 — The workspace's git relay: Quiz issues a token scoped to one repository, the App key stays on the app VM

## Status

Accepted (2026-10-07, product owner: option B below). Implementation is
merge task M6-10 ([task cards](../merge/09-tasks.md),
[progress](../merge/PROGRESS.md)); until it ships the portal runs with its
relay off, as the M6-03 amendment of ADR-047 left it.

Scope: how the online workspace portal (`apps/codespace`, on the engine VM)
reaches a student's GitHub repository — seeding a workspace from it and
relaying the student's pushes from `staging.git` to it — and what Quiz
checks before it lets it. Not the portal's container hardening, the git
channel inside the engine VM, nor the freeze-and-collect exam mode of
ADR-075 (no git channel there).

Relations: settles the question ADR-047's M6-03 amendment (a) left open
("whether Quiz's own App key goes on the engine VM … an ADR at
M6-04/M6-05 decides it"), and with it the seeding note of its M6-06
amendment; ADR-047 carries a pointer. Applies root invariant 15 (ADR-035,
D23, N-SEC-16..18) and ADR-010 to the portal; adds no secret to ADR-010's
list. Reads F-PROJ-09 (the lock and the App's bypass) and F-PROJ-11 (the
receipt time) as they stand.

## Context

In the `online` work mode (ADR-047 as amended 2026-10-07) the student is
invited with `pull` only, and under `online_seb` not at all: the workspace
is the one write path to the repository. A student's `git push` from the
container lands in the session's bare `staging.git` on the engine VM, its
`PushEvent` row is written (the proof of submission, the portal's invariant
10), and a relay job pushes it on to GitHub (`src/git/relay.ts`). The
portal also needs to read the repository once, at the first start of a
session, to seed `staging.git` (`ensureStagingRepo`, lab mode: a mirror of
the student's repository; exam mode: the teacher's template, which is the
project's distribution repository). Quiz's repositories are private by
default, so both directions need a GitHub credential.

heig-classroom's portal held classroom's App private key on the engine VM
(`/etc/codespace/github-app.pem`) and minted installation tokens itself,
one per organization, with every permission of the App. M6-03 refused that
App and imported neither its key nor its forge: the portal runs with
`FORGE_KIND=none`, nothing is relayed, and a private distribution
repository cannot seed a workspace. The open question was whether Quiz's
own App key goes on the engine VM.

The engine VM is the platform's most exposed machine: it runs students'
code in containers (hardened, but a container escape is the threat model of
`apps/runner` and `apps/codespace` alike) and serves code-server to the
internet. Quiz's App is installed with "All repositories" on its
organizations (F-GH-03) and holds `administration`, `contents`,
`workflows` and `pull_requests` in write, and reads organization members,
plan and secrets ([its permissions](../development/github-app.md)). Its key is today on the app VM only
(`GITHUB_APP_PRIVATE_KEY_PATH`, ADR-010), and root invariant 15 says it
stays out of the repository and the database, with installation tokens in
memory only.

Two facts of the projects port bear on what Quiz must check:

1. **The App bypasses the deadline lock** (F-PROJ-09: the `lock` ruleset
   "blocks pushes on every branch, which the App and the organization's
   administrators bypass"). A relay push made with an App installation
   token is a push by the App: GitHub's lock never refuses it. The `commit`
   strategy leaves the repository open anyway, and the lock is applied
   within 60 s to 5 min of the deadline, not at it.
2. **Quiz classifies a push by its sender** (`pushedBy`,
   `modules/github/deliveries.ts`). A relayed push has Quiz's App as its
   sender, so today it would be read as the App's own push: not the
   student's last commit, no protected-file check, `push_receipts.is_bot`
   true, and every run on it ineligible for the score (`isEligible`). The
   online student's work would never be graded — contrary to ADR-047's
   consequence "the grading CI … triggers on the relay's pushes exactly as
   on a student's".

## Decision

### 1. The App key never leaves the app VM (option B)

The portal holds no GitHub App credential, in any environment: the refusal
of `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` at startup
(M6-03, `auth/config.ts`) stays, and gains no exception. When the portal
needs GitHub, it asks Quiz, over a signed service route, for an
**installation token scoped to one repository**; Quiz mints it with its
own App on the app VM and hands it over. The portal keeps it in memory and
uses it for that one repository until it expires.

### 2. The service route

`POST /app/codespace/git-token`, on Quiz, registered only when the GitHub
App is configured AND `CODESPACE_URL` is set (as every route of the
`codespace` module: otherwise a 404). Not under `/app/api/`: it is no user
API, and no session cookie or personal API token reaches it.

**The request is the signed token.** `Authorization: Bearer <JWT>`, HS256
over `CODESPACE_LAUNCH_SECRET` — the same secret and the same
`signHs256`/`verifyHs256` as the sync and the launch (ADR-047 §6, M6-01) —
with a body that is empty. Its claims (`GitTokenRequestClaims`, a zod
schema of `packages/contracts/src/codespace.ts`, used by both sides,
invariant 7):

| Claim | Value |
| --- | --- |
| `iss` | `heig-codespace` (the portal) |
| `aud` | `heig-quiz-git-token` — a distinct audience: a launch token (`heig-codespace`), a sync token (`heig-codespace-api`) or any other service token is refused here, and this one is refused everywhere else |
| `iat`, `exp` | `exp - iat` ≤ 60 s; the 30 s leeway of `verifyHs256` |
| `jti` | random, required (`requireJti`); logged by Quiz, not consumed |
| `projectId` | the project (the portal's `assignmentId`) |
| `userId` | the Quiz user the workspace belongs to (the launch token's `sub`) |
| `repository` | `owner/name`, as the portal knows it (the launch token's `repo.fullName`, or the sync's `sourceRepo.fullName`) |

Putting the request in the claims binds it to the signature: a token seen
in transit cannot be re-aimed at another repository, and it expires in a
minute.

**Quiz's checks**, in this order, in one read transaction; the decision is
one pure rule of `@quiz/domain`, `gitTokenRefusal`, built on
`workspaceStartRefusal` so that the start route and the token route cannot
disagree:

1. The token verifies (signature, `alg`, audience, issuer, lifetime, `jti`
   present); otherwise `401`.
2. The project exists, `userId` names a user, and **a launch token was
   issued to that user for that project** (Quiz's record of launches, §6);
   otherwise `404 not_found`.
3. `repository` is either **the user's own live repository of the
   project** (`isLiveIndividualRepo`: provisioned, not deleted; a staff
   seat's test repository of ADR-077 included) — the grant is then
   `contents: write` — or **the project's distribution repository** — the
   grant is then `contents: read`, for seeding an `online_seb` workspace
   from the teacher's template (the portal's invariant 11). Any other
   repository: `404 not_found`. The match is on Quiz's stored name; the
   token is minted on the stored GitHub repository **id**.
4. The project is in an online mode (`online` or `online_seb`; the mode is
   frozen once a workspace was launched, so this only guards a corrupted
   row); otherwise `409 not_online`.
5. **The repository is open**: its effective deadline (its own, else the
   project's, F-PROJ-09) is still ahead on the server's clock, the
   classroom is not archived, and the staff have not locked it by hand
   (`project_repos.staff_lock` is not true); otherwise `409 closed`. A
   staff *unlock* after the deadline does not reopen the workspace, as it
   does not reopen the start route: extending the repository's deadline
   does (point 8).
6. The organization's installation is known, not suspended, and GitHub
   answers; otherwise `503 github_unavailable`.

Then Quiz calls `POST /app/installations/{installation_id}/access_tokens`
with the App's JWT and the body
`{ repository_ids: [<id>], permissions: { contents: "write" | "read" } }`
— never `workflows`, `administration`, `pull_requests` nor any other
permission; `metadata: read` comes implicitly — through one function of `apps/api/src/github/app.ts`,
the only place this token is minted.

**The answer** (`GitTokenGrant`, same contracts file), with
`Cache-Control: no-store`:

```json
{
  "token": "ghs_…",
  "expiresAt": "2026-10-07T14:03:11Z",
  "useUntil": "2026-10-07T14:03:11Z",
  "repository": { "fullName": "heig-tin-info/prog-c-lab3-alice", "githubRepoId": 123456789 },
  "permission": "write"
}
```

`expiresAt` is GitHub's (one hour after minting, which GitHub does not let
shorten). `useUntil` is `min(expiresAt, the repository's effective
deadline)` for a write grant, `expiresAt` for a read grant: the portal
must not use the token past it (§3).

**Audit**: each issuance writes `codespace.git_token_issued` (the closed
union of `audit.ts`), subject the project, payload `{ userId, repository,
githubRepoId, permission, expiresAt, jti }` — never the token. A refusal is
logged at `info` with its code and the request's `jti`, not audited (a
portal waiting for a deadline extension retries for hours; §3).

### 3. The portal: a `quiz` forge, a per-repository cache

`FORGE_KIND` gains a fourth value, `quiz`: the `Forge` of `src/git/forge.ts`
whose `authorization(repo)` asks Quiz. Its default replaces M6-03's `none`
**once the platform integration is configured**: with `PLATFORM_URL` and
`CODESPACE_LAUNCH_SECRET` set, `FORGE_KIND` defaults to `quiz`; without
them it stays `none`. `none` remains settable explicitly (a portal whose
Quiz has no App). In production the portal refuses `forgejo` (a
development forge whose token would sit on the engine VM) and `github`
(the unconfigured forge, now useless); `quiz` without `PLATFORM_URL` over
`https` is refused there too.

- `pushUrl(repo)` is `https://github.com/<owner>/<name>.git`, credential
  free; `ensureRepo` does nothing (Quiz provisions, `analyse.md` D3).
- **Cache**: in memory only, one entry per (project, user, repository),
  holding the grant. `authorization(repo)` is still called **per relay
  attempt** and per seeding fetch, as the `Forge` contract says; it returns
  the cached token while `now < useUntil - 10 min` (a long push must not
  run out mid-pack), otherwise asks Quiz again. One request in flight per
  entry (single flight). An entry is dropped at its `useUntil`, when GitHub
  answers `401`/`403` on a push or fetch with it (the next attempt asks
  again, once), and when its session's container is destroyed and no
  `PushEvent` of it is pending. A restart empties the cache; nothing is
  ever written to SQLite, a file, a log or the container.
- **Revocation**: a write token dropped before its `expiresAt` — at its
  `useUntil` in particular — is revoked by the portal
  (`DELETE https://api.github.com/installation/token`, authenticated with
  the token itself), best effort: a failure is logged without the token.
- **Refusals**: `401`, `404` and `409` from Quiz are not outages. The relay
  treats them as it treats `ForgeUnconfiguredError` today: the `PushEvent`
  rows stay `pending` with the code in `last_error`, on the slow backoff
  (`UNCONFIGURED_BACKOFF`, up to one attempt an hour), with one `warn` per
  change of cause. `503` and network failures are outages: the ordinary
  backoff, then `failed` once the attempt budget is spent. At seeding, any
  refusal refuses the session with a named cause (`sessions/manager.ts`
  already refuses a session whose repository could not be fetched).
- **The token never reaches git's argv, a URL or a file**: it goes to git
  through `gitAuthEnv` only (`GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`, as
  Quiz's `gitRunner({ token })` does), as
  `Authorization: basic base64(x-access-token:<token>)`, and the `quiz`
  forge sets the URL-scoped key `http.https://github.com/.extraheader` (as
  Quiz's `credentialEnv`), so the header is never sent to another host.
  `redactSecrets` (it already knows `Authorization:` and `gh?_`) scrubs
  every error message before a log line or `push_events.last_error`; the
  HTTP client that calls Quiz logs neither the response body nor the
  `Authorization` header (`src/logging.ts`). The token never enters a
  student container: seeding and relay run in the portal's process on the
  host, and `CONTAINER_ENV_KEYS` does not change.

### 4. Quiz's side of the redaction

The token exists on the app VM only in the handler's memory, between
GitHub's answer and the reply. Quiz never stores, caches or logs it: the
reply body is not logged (Fastify's request log carries no body; the
`Authorization` header of the request is redacted, ADR-010 §4), the
redaction already knows `gh?_` and `x-access-token:` (M1-02), the audit
payload carries no token, and a GitHub error is reported by its status
only. The route's tests search the log and the audit rows for the minted
token.

### 5. The network path

Engine VM → Quiz over **public HTTPS**, to `PLATFORM_URL`
(`https://quiz.chevallier.io`), through the app VM's Caddy on :443. No new
port, no tunnel, no listener on the engine VM: the portal is the client.
As defence in depth, the Caddy fragment of Quiz answers this one path only
from the engine VM's address (the mirror of the runner's Caddy, which
accepts only the app VM); the signature stays the authority. The engine VM
already reaches `github.com` over HTTPS for the relay itself. A portal
talks to one Quiz: production's portal to production's Quiz, whose App
reaches production organizations only; staging keeps its own App on its
test organization and never the production one (N-SEC-18), and never one
`CODESPACE_LAUNCH_SECRET` for both platforms (M6-03's open point, M6-04).

### 6. What Quiz records, and how a relayed push is read

- **Launches**: the `codespace` module records, per (project, user), the
  first and last launch token issued (`codespace_launches`, its own table,
  written in the start route's transaction beside `markLaunched`); a staff
  seat's launch is recorded too (it still freezes nothing, ADR-077).
  Check 2 reads it. Nothing in it is a secret.
- **A relayed push is the student's.** `pushedBy` gains the case of the
  relay: a push whose sender is Quiz's App, on a repository of a project
  in an online mode, whose `after` is not a bot commit Quiz recorded
  (`bot_commits`: the App records its restore, deadline and sync commits
  before it moves the branch), is a **person's** push — `is_bot` false, the
  student's last commit, the protected-file check (the App restores a
  protected file the workspace changed, as in `free` mode), runs on it
  eligible for the score. Only Quiz's own bot commits stay the App's.
- **Receipt time** is unchanged: F-PROJ-11's time of the webhook's arrival.
  A relayed push is received a few seconds after the student pushed into
  `staging.git`; at the deadline that delay is the student's, as a home
  network's is in `free` mode. The `PushEvent` row stays the portal's proof
  for a dispute; Quiz does not read it.

### 7. Why Quiz checks the deadline itself

GitHub's lock is not a guard here: the token is the App's, and the App
bypasses the lock (fact 1 of the context); under `commit` nothing is
locked; the lock lands up to minutes after the deadline; and only Quiz
knows a repository's own, later deadline (the sync sends the project's).
So Quiz refuses a write token once the repository's effective deadline has
passed (check 5), and bounds an earlier token by `useUntil`.

What remains: a token minted before the deadline is valid at GitHub until
its `expiresAt`, up to an hour past the deadline, and only the portal's
discipline (`useUntil`, then revocation) stops its use. A push made with it
after the deadline is **received late** (F-PROJ-11): it never moves the
frozen score and the staff see it marked after the deadline. That is the
residual exposure accepted with option B.

### 8. Pushes still pending at the deadline

A push recorded in `staging.git` before the deadline but not yet relayed
(GitHub down, Quiz down) cannot be relayed after it: Quiz answers
`409 closed`. Its rows stay `pending` (point 3), its `PushEvent` is the
proof of submission, and the staff decide: extending the repository's own
deadline (F-PROJ-09 (1)) makes Quiz issue again, and the relay resumes by
itself within its backoff, received in time against the new deadline.

### 9. Blast radius

If the engine VM is compromised — a container escape, the portal's process
— the attacker holds `CODESPACE_LAUNCH_SECRET` and the tokens in memory.
With them they can push to and read **the repositories of projects that
are online, launched and before their effective deadline**, contents only,
until `CODESPACE_LAUNCH_SECRET` is rotated, and with the tokens already
minted for at most an hour after that; and read
the distribution repositories of those projects. They cannot touch any
other repository, change settings, rulesets, collaborators, secrets or
workflows (no `workflows` permission: a push that changes
`.github/workflows/` is refused by GitHub), nor reach another organization;
every token they obtain is audited by Quiz. Under classroom's design
(option A) the same compromise yields the App's private key: every
permission of the App on every repository of every organization that
installed it, until the key is rotated.

## Consequences

- The relay and private seeding work in production without a GitHub
  credential at rest on the engine VM; the M6-06 note "a private
  distribution repository cannot seed a workspace" is lifted by M6-10.
- **Root `CLAUDE.md`, invariant 15, gains** (to be applied by the M6-10
  PR, not by this record): "The online workspace portal (`apps/codespace`)
  never holds an App credential: it obtains from Quiz, through the HS256
  service route of ADR-078, an installation token scoped to one repository
  (`contents` only), valid at most an hour, which it keeps in memory only
  and hands to git through the environment, never in a URL, argv or file;
  Quiz issues one only for a repository of an online project the student
  launched, before its effective deadline, and audits each issuance without
  the token." `apps/codespace/CLAUDE.md` replaces its "Whether Quiz's own
  App key goes on the engine VM is **open**" with this ADR and names the
  `quiz` forge.
- Submission now depends on two services: Quiz must be up for a relay to
  proceed (a cached token covers up to 50 minutes of a Quiz outage). A Quiz
  outage at the deadline leaves pushes pending, recoverable by point 8.
  The workspace was already a submission dependency (ADR-047,
  Consequences).
- Without `workflows`, a student who edits a file under
  `.github/workflows/` in the workspace cannot have any later push relayed
  (GitHub refuses the whole atomic push) until they revert it. That is the
  intended protection of the grading workflow; M6-10 makes the relay's
  `failed` state visible to the staff in the project's workspace list.
- GitHub's limits: one token per repository and hour at most in steady
  state, minted with the App's JWT; negligible beside the 5 000 requests an
  hour per installation (N-PERF-07).
- No new secret (ADR-010 unchanged); one new audit action; one new table of
  the `codespace` module; contracts `GitTokenRequestClaims` and
  `GitTokenGrant`; one pure rule `gitTokenRefusal`; a change of `pushedBy`
  in the `github` module, with tests that a relayed push is graded and that
  the App's own bot commits are still not.

## Alternatives considered

- **A — The App key on the engine VM** (heig-classroom's design: the PEM at
  `/etc/codespace/github-app.pem`, organization-wide installation tokens
  minted by the portal). Rejected: a container escape on the most exposed
  VM compromises every organization that installed Quiz's App, with every
  permission, until rotation; it contradicts invariant 15's intent and
  N-SEC-16/N-SEC-18 (the key on one VM, staging and production apart), and
  two VMs holding the key double what ADR-010's rotation must cover.
- **A second App with contents permission only, its key on the engine VM.**
  Rejected: still a long-lived key on that VM reaching every repository of
  every organization that installs it, a second App to register, install
  and rotate (and its staging twin), and no deadline check at all.
- **C — Quiz as a git proxy**: the portal pushes and fetches through Quiz
  (smart HTTP), Quiz relays to GitHub with a token that never leaves the
  app VM. Zero GitHub credential on the engine VM, and Quiz sees every push
  as it happens (its receipt time could be the push's). Rejected **for
  now** for its cost: a git server or proxy inside the API, pack traffic
  and seeding clones through the 1-vCPU app VM that serves production and
  staging, on the event loop every live evaluation uses. It remains a
  possible later evolution: the portal's `Forge` interface is the seam (a
  forge whose `pushUrl` is Quiz's), and the checks of §2 would carry over
  unchanged.
- **Fine-grained personal access tokens** or a machine user. Rejected: a
  person's long-lived credential, organization-wide, outside the App's
  audit and installation model.
- **Relying on GitHub's lock instead of a deadline check.** Rejected: the
  App bypasses the lock (F-PROJ-09) and the token is the App's (§7).
