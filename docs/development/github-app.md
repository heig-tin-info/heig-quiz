# Quiz's GitHub App

Quiz talks to GitHub through **its own GitHub App** (decision D23 of the
merge, [ADR-035](../adr/ADR-035-fusion-de-classroom.md)), never through
heig-classroom's. The App creates the students' repositories, protects their
files, reads their CI results, locks them at the deadline, keeps the
journals in step, and carries the user-to-server OAuth that links a
person's GitHub account (no separate OAuth App, no scope). Teachers never
create an App: they install it on their organization in one click from a
classroom's Settings.

Each environment has its own App, with its own id, key, webhook secret,
OAuth client and slug (03 §3.4, N-SEC-18):

| Environment | App | Installed on | Where it can be installed |
| --- | --- | --- | --- |
| production, `quiz.chevallier.io` | Quiz's production App, registered by hand by the product owner | the teachers' organizations | any account (public) |
| staging, `quiz.dev.chevallier.io` | `heig-quiz-staging`, created with the script below | ONE test organization, on which production's App is NOT installed | only the account that owns it (private) |
| development (optional) | a personal App | a test organization | only its owner |

Without any `GITHUB_*` variable the GitHub features are off and everything
else runs: classrooms, evaluations, journals in Quiz mode.

## Permissions and events

The App's settings live in one place,
[`apps/api/src/github/manifest.ts`](https://github.com/heig-tin-info/heig-quiz/blob/main/apps/api/src/github/manifest.ts):
the script builds its manifest from it and the API takes its routes' paths
from it. The reasons below live only here; the tables are kept in step with
that module **by hand**, and `manifest.test.ts` fails when they differ (a
row missing, a scope or an access changed, a row the module does not hold),
or when the events differ from the ones the API registers a handler for
(`onEvent` in `apps/api/src/`).

A permission added after the App is installed makes every organization
owner approve the installation again: decide it in the module first, then
on GitHub (*Settings → Permissions & events*), never the other way round.

| Permission | On | Access | Why |
| --- | --- | --- | --- |
| `actions` | repository | read | the grading workflow's runs (`GET …/actions/runs`): the pipeline, the reconciliation, the live state |
| `administration` | repository | write | the students' repositories created (`POST /orgs/{org}/repos`), the rulesets `hgc-protect` and `hgc-deadline-lock`, collaborators and invitations, the archive that stands for a lock |
| `checks` | repository | read | a run's check runs and their annotations: the score lines the grading parses |
| `contents` | repository | write | git clone and push (provisioning, the deadline commit, protected-file reverts, the sync branches), commits and refs, the reviews' `repository_dispatch`, the journal's reads and page writes |
| `metadata` | repository | read | GitHub's mandatory baseline: repositories by id, listings, a collaborator's permission |
| `pull_requests` | repository | write | the source sync's pull requests (opened, commented, their state read) |
| `workflows` | repository | write | pushing `.github/workflows/*` (the grading workflow) into the distribution, the students' repositories and the sync branches |
| `members` | organization | read | the `member` and `organization` events (an invitation accepted, an organization renamed or deleted) |
| `organization_plan` | organization | read | the Free-plan check (`plan` of `GET /orgs/{org}`): no organization secrets for private repositories, no rulesets |
| `organization_secrets` | organization | read | the presence of the `ANTHROPIC_API_KEY` organization secret (the review tier's probe; until M3-14f drops it) |

These are heig-classroom's App's permissions plus the organization's
*Secrets: read* (03 §3.4). On GitHub's settings page the names read
*Actions*, *Administration*, *Checks*, *Contents*, *Metadata*,
*Pull requests*, *Workflows* (repository) and *Members*, *Plan*, *Secrets*
(organization); *read* is "Read-only", *write* is "Read and write".

The App subscribes to these events:

| Event | Why |
| --- | --- |
| `push` | a student's repository (last commit, bot commits, protected files; the receipt is the intake's, ADR-012), a source repository ahead, a journal repository to ingest |
| `workflow_run` | a grading run pending or completed (`ingestCompletedRun`) |
| `pull_request` | the state of the sync's pull requests |
| `member` | a student accepted the repository invitation |
| `repository` | a repository renamed or deleted (projects, journals) |
| `organization` | an organization renamed or deleted |

and receives these without a subscription (GitHub delivers them to every
App and refuses them in a manifest):

| Event | Why |
| --- | --- |
| `installation` | an installation created, deleted, suspended or unsuspended: re-read from GitHub |
| `installation_repositories` | the repositories the App reaches changed: the organization's healing re-runs |

## URLs

Every App points at its own environment, `<host>` being
`quiz.chevallier.io` or `quiz.dev.chevallier.io`:

| Setting | Value |
| --- | --- |
| Homepage URL | `https://<host>` |
| Webhook URL | `https://<host>/webhooks/github`, active |
| Callback URL | `https://<host>/app/auth/github/callback` (the account link) |
| Request user authorization (OAuth) during installation | unticked: linking stays a separate act |
| Setup URL | `https://<host>/setup/github/installed` |
| Redirect on update | ticked: a re-configured installation also returns to Quiz (M3-14b) |

## The environment's variables

`apps/api/src/config.ts` reads six variables. With `GITHUB_APP_ID` set and
`NODE_ENV=production` (production and staging), the process **refuses to
start** unless the key file is readable, the slug, the client id and the
client secret are set, and the webhook secret has at least 32 characters
(N-SEC-16).

| Variable | Value | Secret |
| --- | --- | --- |
| `GITHUB_APP_ID` | the App's numeric id | no |
| `GITHUB_APP_PRIVATE_KEY_PATH` | `secrets/<slug>.private-key.pem`, the PEM in the checkout's `secrets/`, mounted read-only at `/app/secrets` | the file is |
| `GITHUB_APP_SLUG` | the App's URL name; the bot is `<slug>[bot]` | no |
| `GITHUB_WEBHOOK_SECRET` | the HMAC key of `/webhooks/github`, at least 32 characters | yes |
| `GITHUB_APP_CLIENT_ID` | the App's OAuth client id (`Iv…`) | no |
| `GITHUB_APP_CLIENT_SECRET` | the App's OAuth client secret | yes |

## Creating an App with the script

`pnpm github:app` registers an App through GitHub's
[App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
every setting above, in one confirmation on GitHub. Run it on a workstation
with a browser, from a checkout of this repository (built or not: it runs
with `tsx`).

```bash
pnpm github:app --url https://<host> --name <App name> \
  (--org <organization login> | --personal) [--public] \
  --key-out <file> --env-out <file | ->
```

1. **Choose the owner.** An App never changes owners. `--org <login>`
   creates it under that organization (you must be one of its owners);
   `--personal` under your own account. `--public` lets any account install
   it; without it, only the owner can.
2. **Choose where the secrets go**, both outside any git working tree (the
   script refuses a path inside one, and an existing file): `--key-out` the
   private key (mode 0600), `--env-out` the six `GITHUB_*` lines (mode 0600),
   or `--env-out -` to print the lines on the terminal instead. The key is
   never printed. Relative paths are taken from where you ran `pnpm`.
3. **Run it.** It prints `Open http://127.0.0.1:<port>/ …`. Open that page
   in a browser signed in to GitHub as the owner: it posts the manifest to
   GitHub, which shows the App's name (editable) and settings. Click
   *Create GitHub App*.
4. GitHub sends the browser back to `127.0.0.1` with a one-time code; the
   script exchanges it (`POST /app-manifests/{code}/conversions`), writes
   the key and the lines, and prints the App's id, slug and links. It
   checks the length of the webhook secret GitHub generated (never the
   secret): under the 32 characters `config.ts` asks for, it says so; then
   set a new one on the App (*Webhook secret*, `openssl rand -hex 32`) and
   in `GITHUB_WEBHOOK_SECRET`. The page waits 15 minutes.
5. **Install the secrets** on the server (next section), then **install the
   App** on the organization (`https://github.com/apps/<slug>/installations/new`,
   *All repositories*), from a classroom's Settings (*Connect GitHub*) so
   that the setup return lands on it.

`--port <n>` fixes the local port (the default is any free one), for a
browser that reaches the workstation through a forwarded port.

### Staging: `heig-quiz-staging`

The staging App is owned by **its test organization**, and private:
GitHub then lets nobody install it anywhere else, so N-SEC-18 holds by
construction, not by discipline. Two rules, both hard:

- **Production's App is not installed on that organization**, and
  staging's App on no organization production uses. Staging holds
  production's data: its healing finds an installation by the
  organization's login, so a staging App on an organization production
  drives (the pilot's `heig-quiz-classroom` included) would be re-attached
  to that organization's copied row and act on production's repositories.
  Use a test organization of its own.
- **Never public.** A public staging App could be installed by any
  teacher's organization, with the same effect. (The M2-06 card first
  planned both Apps under heig-classroom's owner, `heig-tin-info`; a
  private App there could only be installed on `heig-tin-info` itself.)

```bash
pnpm github:app --url https://quiz.dev.chevallier.io --name heig-quiz-staging \
  --org <test organization> \
  --key-out ~/heig-quiz-staging.private-key.pem --env-out ~/heig-quiz-staging.env
```

A private App can be installed only by its owner. If a tester's GitHub
account cannot link to it (the account link is the App's own OAuth), make
that account a member of the test organization; do not make the App
public.

### Production

Production's App exists (registered by hand by the product owner). A new
production App, for a new instance, is created the same way, public, under
the organization that will own it forever:

```bash
pnpm github:app --url https://<host> --name <App name> --org <owner organization> --public \
  --key-out ~/<App name>.private-key.pem --env-out ~/<App name>.env
```

## The same settings by hand

When the script cannot run (no browser on the workstation, GitHub's form
changed), create the App at
`https://github.com/organizations/<owner>/settings/apps/new` (or
`https://github.com/settings/apps/new` for a personal account):

1. *GitHub App name*, *Homepage URL*, *Callback URL*, *Setup URL* and
   *Webhook URL* as in [URLs](#urls); *Redirect on update* ticked; *Request
   user authorization (OAuth) during installation* unticked; *Expire user
   authorization tokens* as GitHub proposes (the link revokes its token at
   once anyway).
2. *Webhook secret*: `openssl rand -hex 32`.
3. *Permissions*: every row of [the table](#permissions-and-events), nothing
   more. *Subscribe to events*: the six of the second table.
4. *Where can this GitHub App be installed?*: *Any account* for production,
   *Only on this account* for staging.
5. Create it, then: note the *App ID* and the *Client ID*; *Generate a new
   client secret*; *Generate a private key* (a `.pem` downloads). Write the
   six lines of [the variables](#the-environments-variables) yourself.

## Installing the secrets on the server

The key and the two secrets never enter a repository, an image or the
database, and an age-encrypted copy of each goes into the institutional
vault ([ADR-010](../adr/ADR-010-stockage-secrets.md): HEIG Vaultwarden or
equivalent), as for `.env.prod` and `secrets/`.

**Staging** (`srvstg`, which an administrator reaches with
`sudo machinectl shell srvstg@`; see
[deployment §8](deployment.md#8-staging-quizdevchevallierio-adr-028)):

```bash
# From the workstation, to your account on the application VM.
scp ~/heig-quiz-staging.private-key.pem ~/heig-quiz-staging.env <you>@portal.heig.chevallier.io:
# On the VM, as root: hand both to srvstg (it cannot read your home).
sudo install -o srvstg -g srvstg -m 600 ~/heig-quiz-staging.private-key.pem /home/srvstg/quiz-staging/secrets/
sudo install -o srvstg -g srvstg -m 600 ~/heig-quiz-staging.env /home/srvstg/
shred -u ~/heig-quiz-staging.private-key.pem ~/heig-quiz-staging.env
# As srvstg: the key to the container's `node` (a sub-uid), the lines into .env.staging.
cd ~/quiz-staging
docker run --rm -v "$PWD/secrets":/s alpine sh -c 'chown 1000:1000 /s/heig-quiz-staging.private-key.pem && chmod 600 /s/heig-quiz-staging.private-key.pem'
cat ~/heig-quiz-staging.env >> .env.staging && shred -u ~/heig-quiz-staging.env
docker compose -f compose.staging.yml --env-file .env.staging --env-file .env.image up -d app
curl -s https://quiz.dev.chevallier.io/healthz | jq .   # 200: the configuration was accepted
```

**Production** is the same as `srv` in `/srv/quiz`, with `.env.prod` and
`compose.prod.yml`
([deployment §2](deployment.md#2-the-application-vm-srvquiz)).

Then check, as an administrator: *Administration → System status*, the
GitHub App row (it turns OK after the first call to GitHub); the App's
*Advanced* tab on GitHub lists the webhook deliveries and their answers
(200 expected; 401 means the webhook secret differs).

## Installing on the right organization only

- **Production**: on the teachers' organizations, from a classroom's
  Settings, *All repositories* (F-GH-03), and on the product owner's pilot
  organization (`heig-quiz-classroom`, M3-14).
- **Staging**: on its own test organization only, never one production's
  App is installed on (see [the staging App](#staging-heig-quiz-staging)).
  Staging restores production's data
  ([ADR-028](../adr/ADR-028-recette-sur-la-meme-vm.md)), so every refresh
  (`scripts/staging-scrub.sql`, run by `scripts/staging-refresh.sh`)
  forgets production's installations, archives every project and stops its
  group moves, closes the copied webhook deliveries and drops the queued
  jobs: staging's App re-attaches its test organization at the next setup
  return or classroom open, and a tester unarchives the project under
  test.
- **Never** the production App on staging, nor its key, its webhook secret
  or its client secret in `.env.staging` (N-SEC-18): with them, staging's
  ticker would lock, commit, revert and dispatch on real students'
  repositories.

## Rotating

- **Private key**: GitHub keeps two active keys. *Generate a private key*
  (the new `.pem` downloads), install it under a new file name beside the
  old one, point `GITHUB_APP_PRIVATE_KEY_PATH` at it, restart `app`, check
  the System status, then delete the old key on GitHub and on the server.
  Update the vault copy.
- **Webhook secret**: set the new value on GitHub (*Webhook secret*) and in
  the environment's file at the same time, then restart `app`. Deliveries
  in between answer 401; `reconcile.deliveries` asks GitHub for them again
  within a day.
- **Client secret**: *Generate a new client secret*, update
  `GITHUB_APP_CLIENT_SECRET`, restart, then delete the old one on GitHub.
  Only the account link uses it.

A secret that leaked is revoked on GitHub first (delete the key or the
secret), then rotated as above.
