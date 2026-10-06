# Quiz's GitHub App

Quiz talks to GitHub through **its own GitHub App**
([ADR-035](../adr/ADR-035-fusion-de-classroom.md)). The App creates the
students' repositories, protects their files, reads their CI results, locks
them at the deadline and keeps the journals in step. It also carries the
user-to-server OAuth that links a person's GitHub account, so no separate
OAuth App and no scope are needed. Teachers never create an App: they
install it on their organization from a classroom's Settings, in one click.

Each environment has its own App, with its own id, key, webhook secret,
OAuth client and slug. A staging environment never holds the production
App's credentials (N-SEC-18).

Without any `GITHUB_*` variable the GitHub features are off and everything
else runs: classrooms, evaluations, journals in Quiz mode.

## Owner and installations

An App has one **owner** (an organization or a personal account), which
never changes, and any number of **installations**, one per organization it
may act on. The two are independent:

- *Where can this GitHub App be installed?* is **only on the owner's
  account** (a private App) or **on any account** (`--public` in the
  script). "Any account" means installable elsewhere; it does not list the
  App on the Marketplace. A Quiz App installed on other organizations (the
  teachers' course organizations, a test organization) must be set to any
  account.
- An installation on an organization Quiz does not know is inert: Quiz acts
  on an organization only once a staff member connects a classroom to it.
- Several Apps may be installed on the same organization: production's and
  staging's both on a test organization is fine.

For example, this project's two Apps are both owned by the organization
`heig-tin-info`: production's `heig-quiz`, installed on the course
organizations, and staging's `heig-quiz-staging`, installed on a test
organization.

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
| `organization_secrets` | organization | read | the presence of the `ANTHROPIC_API_KEY` organization secret (the review tier's probe) |

On GitHub's settings page the names read *Actions*, *Administration*,
*Checks*, *Contents*, *Metadata*, *Pull requests*, *Workflows* (repository)
and *Members*, *Plan*, *Secrets* (organization); *read* is "Read-only",
*write* is "Read and write".

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

Every App points at its own environment, `<host>` being the environment's
public host name (for example `quiz.dev.chevallier.io` for this project's
staging):

| Setting | Value |
| --- | --- |
| Homepage URL | `https://<host>` |
| Webhook URL | `https://<host>/webhooks/github`, active |
| Callback URL | `https://<host>/app/auth/github/callback` (the account link) |
| Request user authorization (OAuth) during installation | unticked: linking stays a separate act |
| Setup URL | `https://<host>/setup/github/installed` |
| Redirect on update | ticked: a re-configured installation also returns to Quiz |

## The environment's variables

`apps/api/src/config.ts` reads six variables. With `GITHUB_APP_ID` set and
`NODE_ENV=production`, the process **refuses to start** unless the key file
is readable, the slug, the client id and the client secret are set, and the
webhook secret has at least 32 characters (N-SEC-16).

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
  (--org <owner organization> | --personal) [--public] \
  --key-out <file> --env-out <file | ->
```

- `--org <login>` makes that organization the owner (you must be one of
  its owners); `--personal`, your own account.
- `--public` makes the App installable on any account (see
  [Owner and installations](#owner-and-installations)); without it, only on
  the owner's.
- `--key-out` and `--env-out` say where the private key and the six
  `GITHUB_*` lines go: new files, outside any git working tree (the script
  refuses a path inside one, and an existing file). `--env-out -` prints
  the lines on the terminal instead. Relative paths are taken from where
  you ran `pnpm`.
- `--port <n>` fixes the local port (the default is any free one), for a
  browser that reaches the workstation through a forwarded port.

What happens, step by step:

1. The script builds the App's manifest from `manifest.ts`: the name, the
   URLs of `--url`, the permissions and the events.
2. It opens a page on your own machine, `http://127.0.0.1:<port>/`, and
   prints its address. Open it in a browser signed in to GitHub as an owner
   of the owner account. The page sends the manifest to GitHub.
3. GitHub shows the App's name and settings. Click *Create GitHub App*.
4. GitHub sends the browser back to the local page with a one-time code.
5. The script exchanges that code with GitHub for the App's id, slug, OAuth
   client id and secret, webhook secret and private key.
6. It writes the key to `--key-out` and the six lines to `--env-out`, each
   readable by you only (mode 0600), and prints only what is public: the
   id, the slug, the App's page and its install link. It checks the length
   of the webhook secret GitHub generated, never printing it: under the 32
   characters `config.ts` asks for, it says so; then set a new one on the
   App (*Webhook secret*, `openssl rand -hex 32`) and in
   `GITHUB_WEBHOOK_SECRET`. The local page waits 15 minutes for GitHub.

What stays manual:

- **Copy the key and the lines to the server**
  ([next section](#installing-the-secrets-on-the-server)) and restart the
  application.
- **Install the App** on the organizations it serves:
  `https://github.com/apps/<slug>/installations/new`, *All repositories*,
  best from a classroom's Settings (*Connect GitHub*), so that GitHub's
  setup return lands on that classroom.

### Example: this project's staging App

```bash
pnpm github:app --url https://quiz.dev.chevallier.io --name heig-quiz-staging \
  --org heig-tin-info --public \
  --key-out ~/heig-quiz-staging.private-key.pem --env-out ~/heig-quiz-staging.env
```

Owned by `heig-tin-info` like the production App, so it must be public to
be installed on the test organization `heig-quiz-staging`. Then install it
there; the staging rule below says why nowhere else.

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
4. *Where can this GitHub App be installed?*: *Any account* when it will be
   installed on organizations other than its owner.
5. Create it, then: note the *App ID* and the *Client ID*; *Generate a new
   client secret*; *Generate a private key* (a `.pem` downloads). Write the
   six lines of [the variables](#the-environments-variables) yourself.

## Installing the secrets on the server

The key and the two secrets never enter a repository, an image or the
database ([ADR-010](../adr/ADR-010-stockage-secrets.md)); keep an encrypted
copy in your secret vault, beside the environment file.

On the server, in the checkout the application runs from:

1. Put the key in `secrets/<slug>.private-key.pem`, mode 0600, readable by
   the container's user (`node`, uid 1000 inside the image; with rootless
   Docker, set the owner through a container, as
   [deployment §2](deployment.md#setting-up-the-application-vm) does for
   the OIDC key).
2. Append the six `GITHUB_*` lines to the environment file (`.env.prod`, or
   the staging one), then delete the copy you transferred.
3. Restart the application (`docker compose … up -d app`) and check
   `https://<host>/healthz`: a 200 means the configuration was accepted.

Then, as an administrator: *Administration → System status*, the GitHub
App row (it turns OK after the first call to GitHub). The App's *Advanced*
tab on GitHub lists the webhook deliveries and their answers (200
expected; 401 means the webhook secrets differ).

This project's own environments follow
[deployment §2 and §8](deployment.md#8-staging-quizdevchevallierio-adr-028)
(the `srv` and `srvstg` accounts).

## The staging rule

A staging environment restored from production's data
([ADR-028](../adr/ADR-028-recette-sur-la-meme-vm.md),
`scripts/staging-refresh.sh`) holds production's organizations, classroom
links, projects and repositories, keyed by GitHub's organization id. When
staging's App is installed on an organization, Quiz records the
installation on the row with that organization's id
(`recordInstallation`), the copied row included.

**Never install the staging App on an organization where production holds
real work** (for example a course organization). Staging would re-attach to
that organization's copied rows and act on real students' repositories:
their webhooks would come to staging, and its tasks could lock them,
restore files or invite on them. Every refresh
(`scripts/staging-scrub.sql`) forgets production's installations, archives
every project and stops its group moves, closes the copied webhook
deliveries and drops the queued jobs; that reduces the risk, it does not
remove it.

A **dedicated test organization** is fine, even when the production App is
installed there too. And **never** the production App's key, webhook secret
or client secret in staging's environment (N-SEC-18).

To test projects on staging, the project's **source repository must be in
the test organization**: a project's sources are listed and read in the
classroom's own organization (`classroomClient`,
`apps/api/src/modules/project/sources.ts`). Connect a staging classroom to
the test organization, put the source repository there, and unarchive a
copied project only if it belongs to that organization.

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
