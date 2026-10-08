# Installing the platform on a new Ubuntu server

This guide takes a fresh Ubuntu LTS server to a running Quiz instance:
Caddy in front (TLS), the application and PostgreSQL in Docker Compose,
and, optionally, the code runner and the GitHub App. It follows the files
of this repository; the [deployment runbook](deployment.md) describes how
this project's own instance runs them, and is a useful companion.

Throughout, `<your-host>` is your instance's public host name (for
example `quiz.example.org`).

## 1. What you need

- A server with Ubuntu LTS, a public address, and SSH access as a user
  with sudo. 2 GB of memory is enough for a small instance.
- A DNS record (A/AAAA, or a CNAME) pointing `<your-host>` at the server.
- An **OpenID Connect provider** for sign-in, with a client registered for
  the redirect URI `https://<your-host>/app/auth/callback`. Any standard
  provider works: an institutional one (Switch edu-ID, for example),
  Keycloak, Microsoft Entra ID, Google… The client authenticates either
  with a client secret or with a private key (`private_key_jwt`).
- A container image of the application (step 4).

## 2. Packages

Install git, curl, jq, Caddy and Docker Engine with the Compose plugin.
Caddy and Docker publish their own apt repositories: follow Caddy's
"Debian, Ubuntu, Raspbian" install instructions and Docker's "Install
Docker Engine on Ubuntu", then:

```bash
sudo apt-get update && sudo apt-get install -y git curl jq
sudo apt-get install -y caddy
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
```

Rootful Docker, as installed above, is the simplest. Running the stack in
a dedicated account's rootless Docker, as this project does, is described
in [deployment §2](deployment.md#the-srv-account); the commands below are
the same, except for file ownership.

## 3. The checkout and the environment file

Run the stack from a checkout of the repository, by a dedicated user (here
`quiz`, in the `docker` group):

```bash
sudo useradd --create-home --shell /bin/bash --groups docker quiz
sudo -iu quiz sh -c 'git clone https://github.com/heig-tin-info/heig-quiz.git quiz && cd quiz \
  && mkdir -p secrets backups assets backup-status && chmod 755 backup-status \
  && cp .env.prod.example .env.prod && chmod 600 .env.prod'
```

Put the files the application reads (the OIDC private key, if any) in
`~quiz/quiz/secrets/`, then hand `secrets/`, `assets/` and `backups/` to the
container's user, `node` (uid 1000 inside the image, the same uid on the
host with rootful Docker):

```bash
sudo chown -R 1000:1000 ~quiz/quiz/secrets ~quiz/quiz/assets ~quiz/quiz/backups
sudo chmod 600 ~quiz/quiz/secrets/*
```

Fill `.env.prod` (every variable is explained in the file and in
[the configuration reference](deployment.md#10-configuration-reference)):

- `POSTGRES_PASSWORD` and `COOKIE_SECRET`: `openssl rand -base64 32` each.
- `SUPER_ADMIN_EMAIL`: your address. The super administrator adds the
  teachers from *Administration*.
- **OIDC**: `OIDC_ISSUER` (your provider's issuer URL) and
  `OIDC_CLIENT_ID`; then either `OIDC_CLIENT_SECRET`, or, for
  `private_key_jwt`, the key in `secrets/` with `OIDC_PRIVATE_KEY_PATH`
  (`secrets/<file>.pem`) and `OIDC_PRIVATE_KEY_KID` (the `kid` of the key
  registered with the provider). Delete the example's edu-ID lines that do
  not apply.
- **The runner** (step 6): `RUNNER_MODE=stub` to start without it.
- **E-mail** (optional): the platform sends e-mail through Scaleway
  Transactional Email, configured by `SCW_SECRET_KEY`,
  `SCW_DEFAULT_PROJECT_ID`, `MAIL_FROM`, `MAIL_FROM_NAME` and
  `MAIL_REGION`. Left empty, every e-mail is written to the log instead of
  being sent. It is the only mail transport the platform implements.
- Microsoft Teams, the LLM gateway and the kiosk stations stay off while
  their variables are empty ([Microsoft Teams setup](teams.md)).

`config.ts` refuses to start under `NODE_ENV=production` on a development
login, an embedded (PGlite) database, the stub LLM or a placeholder
secret: if the application does not start, its log says which variable.

PostgreSQL is not installed on the host: it is the `postgres` service of
`compose.prod.yml` (PostgreSQL 17, a named volume), with a `backup` service
that dumps it daily into `backups/`.

## 4. Your host name and your image

Three values of the committed files are this project's; set yours:

| File | Line | Change |
| --- | --- | --- |
| `Caddyfile` | 8, `quiz.chevallier.io {` | `<your-host> {` |
| `compose.prod.yml` | 24, `PUBLIC_URL: https://quiz.chevallier.io` | `PUBLIC_URL: https://<your-host>` |
| `compose.prod.yml` | 19, `image: ghcr.io/heig-tin-info/quiz:${IMAGE_TAG:-latest}` | your image |

The application listens on `127.0.0.1:3002` (`compose.prod.yml` line 34,
`Caddyfile` lines 23 and 30); change all three together if the port is
taken.

**The image** is built from the repository's `Dockerfile` (the API and the
built web app in one image, migrations applied at start). Build it on a
machine with a few GB of memory, or in CI, and push it to a registry your
server can pull from:

```bash
docker build -t <registry>/<name>/quiz:<tag> .
docker push <registry>/<name>/quiz:<tag>
```

Building on a small server works but is slow and may run it out of memory.
This project builds in GitHub Actions and pushes to GitHub's registry
([deployment §4](deployment.md#4-continuous-deployment)); a fork can reuse
that workflow with its own registry. If the registry is private, log in
once on the server (`docker login <registry>`).

## 5. Caddy and TLS

Caddy obtains and renews the certificate for `<your-host>` on its own once
the DNS record resolves and ports 80 and 443 reach the server.

```bash
# The default Caddyfile becomes one import line; each site is a fragment.
echo 'import /etc/caddy/conf.d/*.caddy' | sudo tee /etc/caddy/Caddyfile
sudo mkdir -p /etc/caddy/conf.d && sudo cp ~quiz/quiz/Caddyfile /etc/caddy/conf.d/quiz.caddy
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```

On a server that already serves other sites, add the `import` line to the
existing Caddyfile instead of replacing it. The fragment proxies to the
application, streams `/app/api/events` unbuffered (the real-time channel)
and sets the transport headers; the application sends its own
Content-Security-Policy.

## 6. The code runner (optional)

Code questions run in a separate, hardened service, best on its own
machine with rootful Podman ([deployment §3](deployment.md#3-the-runner-vm-optquiz-runner)
and [`apps/runner/README.md`](https://github.com/heig-tin-info/heig-quiz/blob/main/apps/runner/README.md)).
In `apps/runner/deploy/Caddyfile`, set your runner's host name (the site
address) and your application server's addresses (`remote_ip`). Then, in
`.env.prod`: `RUNNER_MODE=http`, `RUNNER_URL=https://<runner-host>:8443`
and the same `RUNNER_TOKEN` (`openssl rand -hex 32`) as the runner's
`/etc/quiz-runner/env`.

Without it, `RUNNER_MODE=stub`: code questions stay authorable and
playable, their grading is proposed for a manual review, and `/healthz`
reports the runner as `disabled`
([without the runner](deployment.md#without-the-runner)).

## 7. First start

As `quiz` (`sudo -iu quiz`), in `~/quiz`:

```bash
C="docker compose -f compose.prod.yml --env-file .env.prod"
$C pull app        # or skip it for an image built on this server
$C up -d
$C logs --tail 50 app
```

The application applies the database migrations at start, then serves the
web app. `IMAGE_TAG=<tag>` in the environment (or in a second env file, as
`deploy.sh` does) selects a tag other than `latest`. `deploy.sh` and the
CI deploy jobs are this project's own pipeline (forced-command SSH keys,
promotion by commit sha), adaptable to yours
([deployment §4 and §5](deployment.md#4-continuous-deployment)).

**Do not seed** a real instance: `pnpm seed` writes the development demo
world. Sign in with the super administrator's account and add teachers
from *Administration*.

## 8. Check it

```bash
curl -s https://<your-host>/healthz | jq .   # 200: "database": "up", "jobs": "up"
cat backup-status/last.json                  # after the first dump: "ok": true
```

Then sign in and open *Administration → System status*. (`pnpm smoke`
needs the development login, which production refuses: it is not for a
real instance.) Point an uptime monitor at `/healthz`
([deployment §7](deployment.md#7-monitoring)), and copy `backups/` off the
server regularly ([deployment §6](deployment.md#6-backups-rpo-24-h-rto-4-h)).

## 9. The GitHub App (optional)

For projects and GitHub-backed journals, create the instance's own GitHub
App with `pnpm github:app` from a workstation, copy its key and its six
`GITHUB_*` lines to the server, restart, and install the App on the
organizations it serves: [Quiz's GitHub App](github-app.md). Without it,
the GitHub features are off and the rest of the platform runs.

## 10. A staging environment (optional)

A second stack beside the first, restored from production's data, is how
this project tests a change before it reaches students:
[deployment §8](deployment.md#8-staging-quizdevchevallierio-adr-028)
(`compose.staging.yml`, `scripts/staging-refresh.sh`). It needs its own
GitHub App, under [the staging rule](github-app.md#the-staging-rule).
