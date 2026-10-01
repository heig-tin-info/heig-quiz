# Deployment

This page is the operator's runbook: the shape of the deployment, the exact
commands for the two machines, and what to do on a bad day. The root
`deploy.md` only points here. Its section numbers (§1 to §8) are kept on
purpose, because comments in the scripts and compose files cite them.

Production is `https://quiz.chevallier.io` and staging is
`https://quiz.dev.chevallier.io` (§8). They run on two virtual machines and
come from one repository
([ADR-016](../adr/ADR-016-runner-sur-vm-separee.md),
[ADR-028](../adr/ADR-028-recette-sur-la-meme-vm.md)). The application stack
runs on the VM that already hosts heig-classroom, behind that VM's native
Caddy. The code runner runs on the codespace VM, `code.chevallier.io`, behind
that VM's native Caddy, and the API reaches it over HTTPS with a shared
token. Both images are built on GitHub Actions and pulled from GHCR. Nothing
of ours is ever built on either VM.

The specification's [5.9 Deployment](../spec/05-architecture.md#59-deployment)
describes the earlier single-VM layout and carries an amendment pointing at
ADR-016.

## The two machines

| | `portal.heig.chevallier.io` (application VM) | `code.chevallier.io` (runner VM) |
| --- | --- | --- |
| Size | Hetzner CPX12, 1 vCPU, 2 GB + 2 GB swap, `128.140.71.35` | Hetzner, 2 CPU, 4 GB |
| Already runs | heig-classroom on `:3000`, evaluation-tb on `:3001`, a native Caddy | heig-codespace, rootful Podman 5.7, a native Caddy |
| Gets | `/srv/quiz`: the compose stack `app`, `postgres`, `backup`, on the `srv` account's rootless Docker; and staging, `/home/srvstg/quiz-staging` on the `srvstg` account's own rootless Docker (§8) | `/opt/quiz-runner`: the runner as a Podman quadlet |
| Listens on | `app` on `127.0.0.1:3002` (staging `127.0.0.1:3003`) | the runner on `127.0.0.1:3200` |
| Vhost | `/etc/caddy/conf.d/quiz.caddy` → `quiz.chevallier.io` | `/etc/caddy/conf.d/quiz-runner.caddy` → `code.chevallier.io:8443` |
| Deploys through | `/srv/quiz/deploy.sh production` (user `srv`) and `/home/srvstg/quiz-staging/deploy.sh staging` (user `srvstg`), forced commands | `/opt/quiz-runner/apps/runner/deploy/deploy.sh`, forced command |

Until 2026-09-25 the application VM was a DigitalOcean droplet
(`165.245.246.213`, root, rootful Docker, everything under `/opt`); the three
services moved to the Hetzner VM together, and the directory basenames (hence
the compose project and volume names) did not change.

Why two: the application VM has no Podman and no room for student
compilations next to two PostgreSQL servers and three Node processes, while
the codespace VM already runs the rootful Podman the runner was written
against. The neighbours are not touched. The application VM's Caddy imports
one fragment per service from `/etc/caddy/conf.d/`; the code VM's
`/etc/caddy/Caddyfile`, owned by heig-codespace, gained that one
`import /etc/caddy/conf.d/*.caddy` line and nothing else.

## 1. DNS

`quiz.chevallier.io` is a CNAME to `portal.heig.chevallier.io` (A
`128.140.71.35`, AAAA `2a01:4f8:1c19:1164::1`), at Gandi, TTL 300, like
`classroom.chevallier.io` and `tb.chevallier.io`. Caddy obtains the
certificate on its own once it resolves (`dig +short quiz.chevallier.io`).

The runner is reached through the code VM's existing name,
`code.chevallier.io`, on port **8443**: the same certificate, a port of its
own so that the codespace's `:443` site block is not touched. No record and no
certificate are added. That port must be open in the Hetzner firewall for the
application VM's address only.

## 2. The application VM (`/srv/quiz`)

| Piece | Where | Defined by |
| --- | --- | --- |
| Caddy | native package on the host, ports 80 and 443, shared with the neighbours | `Caddyfile`, copied to `/etc/caddy/conf.d/quiz.caddy` |
| `app` | container, published on `127.0.0.1:3002` only | `Dockerfile`, image `ghcr.io/heig-tin-info/quiz` |
| `postgres` | container, PostgreSQL 17, volume `pgdata` | `compose.prod.yml` |
| `backup` | container running a daily `pg_dump -Fc` into `./backups/`, and its report into `./backup-status/last.json` | `compose.prod.yml` |

`compose.prod.yml` starts these three containers and only those. The runner
is not in the file. Keycloak is a development identity provider and is not
deployed; production authenticates against Switch edu-ID with the same
private key and `kid` as heig-classroom, since the edu-ID client shares the
classroom's public JWK.

The `postgres` service carries the same low-memory tuning as the classroom's
(`shared_buffers=32MB`, `max_connections=40`, no parallel query): the VM has
one vCPU and 2 GB, shared by three services and two PostgreSQL instances.

The Caddy fragment does two things beyond proxying to `localhost:3002`: it
sets the transport headers (HSTS, `nosniff`, referrer policy) and it proxies
`/app/api/events` with `flush_interval -1`, so the server-sent event stream
([ADR-005](../adr/ADR-005-sse-sans-websocket.md)) is never buffered.
The Content-Security-Policy and `X-Frame-Options` are NOT Caddy's: the
application sends them (`apps/api/src/csp.ts`), the Teams tab's exception
included, so staging and production carry the same policy.

### The `srv` account

Production runs as the service account `srv`, which owns `/srv` and runs
**rootless Docker** in its systemd user session (socket
`/run/user/1000/docker.sock`, lingering enabled so the containers restart at
boot; there is no root Docker daemon). A human reaches it with
`sudo machinectl shell srv@`. Its sudo covers exactly two commands,
`caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` and
`systemctl reload caddy`; `/etc/caddy/conf.d/` is group-writable by `srv`.

In rootless Docker, uid 1000 inside a container (`node` in the image) is host
uid 100999, so a host-side `chown 1000:1000` is wrong: ownership the
container must see is set through a container, and a file it owns is read
the same way.

Staging does NOT run as `srv`: it has an account of its own, `srvstg`, with
its own rootless Docker (§8). `srv`'s directories that hold production data
(`/srv/quiz`, `/srv/heig-classroom`, `/srv/evaluation-tb`) are
`chmod o-rwx`, so `srvstg` reads none of them, the dumps in
`/srv/quiz/backups` included. Keep them that way when adding a service.

### Setting up the application VM

```bash
cd /srv && git clone https://github.com/heig-tin-info/heig-quiz.git quiz && cd quiz
mkdir -p secrets backups assets backup-status
# edu-ID: the client shares the classroom's public JWK, so the same key and kid.
# The classroom's copy belongs to its container's `node`: read it through a container.
docker run --rm -v /srv/heig-classroom/secrets:/s:ro alpine cat /s/eduid-private-key.pem > secrets/eduid-private-key.pem
docker run --rm -v "$PWD":/w alpine sh -c 'chown -R 1000:1000 /w/secrets /w/backups /w/assets && chmod 600 /w/secrets/*.pem'
# backup-status stays srv's (container root, which is who writes it), mode 755:
# `app` reads the report read-only as `node`. Never chown it to 1000.
cp .env.prod.example .env.prod && chmod 600 .env.prod
nano .env.prod    # POSTGRES_PASSWORD, COOKIE_SECRET: openssl rand -base64 32
                  # OIDC_CLIENT_ID: from the SWITCH Resource Registry
                  # RUNNER_TOKEN: openssl rand -hex 32 — the SAME value goes to the code VM
cp Caddyfile /etc/caddy/conf.d/quiz.caddy && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```

The edu-ID client is registered with the redirect URI
`https://quiz.chevallier.io/app/auth/callback` and authenticates with
`private_key_jwt` (`OIDC_PRIVATE_KEY_PATH`, `OIDC_PRIVATE_KEY_KID`).
`AUTH_DEV_LOGIN`, a `pglite://` database and the stub LLM provider
(`LLM_PROVIDER=stub`) are all refused by `config.ts` under
`NODE_ENV=production`: setting any of them in `.env.prod` stops the
container from starting, on purpose. The super administrator is
`SUPER_ADMIN_EMAIL`; teachers are managed from the Admin screen.

Notifications ([ADR-030](../adr/ADR-030-canaux-de-notification.md)):
e-mails go out through Scaleway TEM once `SCW_SECRET_KEY` and
`SCW_DEFAULT_PROJECT_ID` are set in `.env.prod` (the classroom's project and
sender domain; without them every e-mail is only logged). The Microsoft Teams
channel stays off until its multi-tenant Entra application exists and
`TEAMS_CLIENT_ID` and `TEAMS_CLIENT_SECRET` (plus `TEAMS_ALLOWED_TENANTS`,
HEIG-VD's tenant) are set:
the whole setup, the secret's rotation included, is
[Microsoft Teams setup](teams.md). Staging sets neither.

An encrypted copy of `.env.prod` and `secrets/` in the vault (`age`) is a
precondition of the 4 h RTO ([ADR-010](../adr/ADR-010-stockage-secrets.md)).

## 3. The runner VM (`/opt/quiz-runner`)

| Piece | Where | Defined by |
| --- | --- | --- |
| Caddy | native package on the host, owned by heig-codespace; our site block on `:8443` | `apps/runner/deploy/Caddyfile`, installed as `/etc/caddy/conf.d/quiz-runner.caddy` |
| `quiz-runner` | Podman quadlet, `systemd` service `quiz-runner.service` | `apps/runner/deploy/quiz-runner.container`, installed in `/etc/containers/systemd/` |
| the runner image | `ghcr.io/heig-tin-info/quiz-runner`, pulled by the deploy | `apps/runner/Dockerfile` |
| the seccomp profile | `/etc/quiz-runner/seccomp.json` on the host | `apps/runner/infra/seccomp/runner.json`, installed by the deploy |
| the runner's environment | `/etc/quiz-runner/env`, `chmod 600` | `apps/runner/deploy/env.example` |
| the language images | built on the VM through the rootful socket | `apps/runner/images/build.sh` |

`quiz-runner.container` is a Podman quadlet: `systemd` generates
`quiz-runner.service` from it at `daemon-reload`, and `deploy.sh` installs it
at every deploy. The unit runs the CI image with host networking,
`HOST=127.0.0.1` and `PORT=3200`, so the service is reachable from the host's
loopback only and Caddy is the single way in. Two things come from the host:
the rootful socket `/run/podman/podman.sock` (mounted as is, since the
service must write to it) and the seccomp profile (read-only). The service itself has a read-only root, a tmpfs on `/tmp`, no
capability, `NoNewPrivileges` and a 512 MB memory cap. `Pull=never`: the
image is pulled by the deploy script with the CI's token, never at boot.

The seccomp profile is installed on the host on purpose. The runner drives
Podman as a `--remote` client, so `--security-opt seccomp=<path>` names a
file the Podman *server* opens. The deploy copies the repository's profile to
`/etc/quiz-runner/seccomp.json`; the quadlet mounts that same path read-only
into the service and sets `RUNNER_SECCOMP` to it, so the service's startup
check sees the file the server will use.

The Caddy site block `https://code.chevallier.io:8443` reuses the certificate
Caddy already holds for that name, sets HSTS and `nosniff`, and proxies to
`127.0.0.1:3200` for one source address, the application VM's
(`@quiz remote_ip 128.140.71.35` in `apps/runner/deploy/Caddyfile`); every
other address gets a 403. The runner then requires
`Authorization: Bearer <RUNNER_TOKEN>` on `POST /run` and on `GET /health`,
compared in constant time, and answers 401 otherwise. Two gates, either one
enough on its own. `/health` is guarded on purpose: a token the API got wrong
shows up as a runner `down` in `/healthz`, not as one that says `up` and
refuses every run. If the application VM moves again, add its new address to
that line (in the repository and in `/etc/caddy/conf.d/quiz-runner.caddy` on
the code VM) before the switch, as the 2026-09-25 migration did.

The runner holds one secret, that token, and nothing else: it reaches no
database and passes none of its environment into the sandbox containers. The
hardening of the sandbox containers themselves (the flag list, the closed
environment, nothing mounted) is documented once, in
[`apps/runner/README.md`](https://github.com/heig-tin-info/heig-quiz/blob/main/apps/runner/README.md).
`--userns=auto` is always available on a rootful engine, hence
`RUNNER_USERNS_AUTO=true` in the environment file.

### Setting up the runner VM

```bash
cd /opt && git clone https://github.com/heig-tin-info/heig-quiz.git quiz-runner && cd quiz-runner
install -d -m 0700 /etc/quiz-runner
cp apps/runner/deploy/env.example /etc/quiz-runner/env && chmod 600 /etc/quiz-runner/env
nano /etc/quiz-runner/env      # RUNNER_TOKEN: the value in /srv/quiz/.env.prod on the application VM
# The host Caddyfile belongs to heig-codespace: add ONE line to it, once.
grep -q 'conf.d/\*.caddy' /etc/caddy/Caddyfile || sed -i '1i import /etc/caddy/conf.d/*.caddy\n' /etc/caddy/Caddyfile
mkdir -p /etc/caddy/conf.d && cp apps/runner/deploy/Caddyfile /etc/caddy/conf.d/quiz-runner.caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
# The language images: the runner's only supply chain, built HERE, never pulled.
# All six by default: c, cpp, python, js, spice (ngspice, for `circuit`,
# ADR-019) and rust. A missing one is not listed by `GET /health`, and every
# question in that language degrades to a PROPOSED grade. rust is the large
# one (~820 MB): check the disk first and keep 2 GB free for the build.
df -h /var/lib/containers
PODMAN_REMOTE_URL=unix:///run/podman/podman.sock apps/runner/images/build.sh
podman image prune -f
podman images | grep quiz-runner
```

On a VM built before #234, which has the five others only, build rust alone
the same way (`… images/build.sh rust`); `GET /health` notices it within five
seconds, no restart needed. The sizes and build times are in
[`apps/runner/README.md`](https://github.com/heig-tin-info/heig-quiz/blob/main/apps/runner/README.md#the-images).

After an upgrade that adds or changes an image (a new language, a new
ngspice), rebuild it on the VM; nothing else does: `deploy.sh` ships the
runner's own image, never the sandbox ones. The CI workflow **Runner
integration** builds the same six images every week and runs the integration
suite on them under a rootful socket, so a change that breaks a language
under the seccomp profile turns red there first.

### Checking the runner end to end

After an image rebuild, or whenever a code question misbehaves, run the
smoke test from the application VM (the only address the code VM's Caddy
admits); what it prints and checks is in
[`apps/runner/README.md`](https://github.com/heig-tin-info/heig-quiz/blob/main/apps/runner/README.md#the-smoke-test-against-a-live-runner):

```bash
# application VM, as srv
cd /srv/quiz
RUNNER_TOKEN="$(sed -n 's/^RUNNER_TOKEN=//p' .env.prod)" \
  apps/runner/scripts/smoke.py https://code.chevallier.io:8443
```

## 4. Continuous deployment

`.github/workflows/ci.yml` has four stages:

1. **checks**, on every push and pull request: parallel jobs run
   `pnpm build` with `pnpm typecheck` (`build-typecheck`), the API's and the
   SPA's tests in three shards each (`test-app`), and every other package's,
   the runner's unit suite and the kiosk extension's included (`test-rest`).
   The `checks` job aggregates them: it is the one required status. A pull
   request that changes only prose (`docs/`, `mockups/`, Markdown outside a
   `src/`) skips the jobs and passes `checks`; a push to `main` always runs
   them all.
2. **image**, on a push to `main` only: both images are built side by side
   with `docker/build-push-action`, each with a buildx layer cache of its own
   (`type=gha`, one `scope` per image), and pushed to GHCR twice each, as
   `:latest` and as `:<commit sha>`.
3. **deploy-staging**: one SSH call to the application VM with the
   `STAGING_DEPLOY_SSH_KEY` key (a secret of the `staging` environment), as
   `vars.STAGING_DEPLOY_USER` (`srvstg`), then a wait of up to 150 s for
   `https://quiz.dev.chevallier.io/healthz` to answer 200. A staging that
   does not come up healthy (a migration that fails on production-shaped
   data, a crash at boot) stops the promotion.
4. **deploy-production**, in the `production` environment: it waits for a
   required reviewer's approval (Actions → the run → *Review deployments*),
   then deploys the SAME sha with the `DEPLOY_SSH_KEY` key (a secret of the
   `production` environment), one SSH call per VM.

Each deploy job has its own concurrency group. Production's cancels in
progress: the newest promotion replaces an older one still waiting for
approval, which would otherwise hold the group and leave the newer one
"pending" with no *Review deployments* button. Each key is an
ENVIRONMENT secret, not a repository one: a job only ever sees the key of
its own environment. The workflow's default token is read-only, and `main`
is protected by a ruleset (a pull request and the `checks` job required). Without its key a job prints
a notice and does nothing, so the pipeline stays green until the keys are
provisioned; without `DEPLOY_RUNNER_HOST` only the application is deployed.

### Forced commands

Each VM's `authorized_keys` pins a CI key to a script, with a forced command
and `restrict`:

```text
# /home/srv/.ssh/authorized_keys on the application VM
command="/srv/quiz/deploy.sh production",restrict ssh-ed25519 AAAA… ci-deploy@quiz
# /home/srvstg/.ssh/authorized_keys on the application VM
command="/home/srvstg/quiz-staging/deploy.sh staging",restrict ssh-ed25519 AAAA… ci-deploy-staging@quiz
# /root/.ssh/authorized_keys on the runner VM
command="/opt/quiz-runner/apps/runner/deploy/deploy.sh",restrict ssh-ed25519 AAAA… ci-deploy@quiz
```

Whatever command the client asks for, the server runs the pinned script
instead, so a key can only deploy and never open a shell, even if it leaks,
and the staging key, landing on another account, can never touch
production. The workflow connects to the application VM as
`vars.STAGING_DEPLOY_USER` (`srvstg`) for staging and `vars.DEPLOY_USER`
(`srv`) for production, with no fallback (an unset variable fails the job
rather than pick an account), and as `root` to the runner VM.

The CI sends `<commit sha> <ephemeral GHCR token>` as the SSH command; it
arrives in `$SSH_ORIGINAL_COMMAND`, is matched strictly and never evaluated.
The token is piped straight to `docker login` or `podman login` with
`--password-stdin` and expires with the workflow run; no registry credential
is stored on either VM. On the application VM the login goes to a throwaway
`DOCKER_CONFIG`, removed on exit, because heig-classroom deploys on the same
`srv` account and two concurrent logins in the shared
`~/.docker/config.json` overwrote each other ("denied", 2026-09-25). On the
runner VM, root's Podman auth file lives under `/run`, so nothing survives a
reboot.

### What the two scripts do

Both move their checkout to the deployed sha with
`git checkout --detach <sha>` (a token alone, a manual deploy, deploys the
head of `origin/main`, still by its sha). That rewrites the script while bash
is still reading the old copy, so a deploy that changes the deploy steps
would run the previous ones: each script compares `HEAD` before and after
and, when it moved, hands over to the new copy exactly once (`exec "$0"` with
`QUIZ_DEPLOY_REEXEC=1` set and the token cleared, the login being already
done). Then they diverge:

- **application VM** (`deploy.sh`): serialise with any other deploy of the
  same account through a `flock` (per account since staging moved to
  `srvstg`: staging and production no longer share a daemon), write
  the sha to `.env.image` as `IMAGE_TAG`, `docker compose pull app` (only our
  image; `--ignore-pull-failures` is deliberately not used, a missing image
  must stop the deploy rather than half-restart the stack), `up -d`, remove
  the older sha-tagged images, print the deployed commit. When not root it
  defaults `DOCKER_HOST` to the rootless socket. In production, before the
  pull, it refuses to restart under a live evaluation (§5, *The
  live-evaluation guard*).
- **runner VM** (`apps/runner/deploy/deploy.sh`): `podman pull` of the
  sha-tagged runner image and retag it `:latest` (the tag the quadlet runs),
  install the seccomp profile, the quadlet and the Caddy fragment from the
  checkout, `caddy validate`, `systemctl daemon-reload`, restart
  `quiz-runner.service`, reload Caddy, remove the older images, print the
  deployed commit.

`.github/workflows/image-artifact.yml` is a keyless fallback for the
application image only: run by hand, it builds the image and publishes it as
a workflow artifact to `gh run download` and `docker load` on the VM.

### Setting up the CI keys

```bash
ssh-keygen -t ed25519 -f ci_deploy -N "" -C ci-deploy@quiz
gh secret set DEPLOY_SSH_KEY --env production --repo heig-tin-info/heig-quiz < ci_deploy   # PRIVATE key, an environment secret
gh variable set DEPLOY_HOST --repo heig-tin-info/heig-quiz --body classroom.chevallier.io   # a CNAME to the application VM
gh variable set DEPLOY_USER --repo heig-tin-info/heig-quiz --body srv
gh variable set DEPLOY_HOST_KEY --repo heig-tin-info/heig-quiz --body "$(ssh-keyscan -t ed25519 classroom.chevallier.io | awk '{print $2" "$3}')"
gh variable set DEPLOY_RUNNER_HOST --repo heig-tin-info/heig-quiz --body code.chevallier.io
gh variable set DEPLOY_RUNNER_HOST_KEY --repo heig-tin-info/heig-quiz --body "$(ssh-keyscan -t ed25519 code.chevallier.io | awk '{print $2" "$3}')"
# on the application VM, as srv
printf 'command="/srv/quiz/deploy.sh production",restrict %s\n' "$(cat ci_deploy.pub)" >> /home/srv/.ssh/authorized_keys
# on the runner VM
printf 'command="/opt/quiz-runner/apps/runner/deploy/deploy.sh",restrict %s\n' "$(cat ci_deploy.pub)" >> /root/.ssh/authorized_keys
shred -u ci_deploy
```

The staging key and `STAGING_DEPLOY_USER` are set up in §8. The application VM carries the previous
VM's SSH host keys, copied over, so `DEPLOY_HOST_KEY` did not change with the
2026-09-25 move.

## 5. Deploying, and rolling back

Push to `main`: checks, two images, the staging deploy and its health check,
then the `production` environment waits for an approval before the two SSH
calls. Then:

```bash
curl -s https://quiz.chevallier.io/healthz | jq .              # database, jobs, runner: "up"
ssh srv@portal.heig.chevallier.io 'cd /srv/quiz && docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image logs --tail 50 app'
ssh root@code.chevallier.io 'journalctl -u quiz-runner -n 30'   # "podman engine ready", "quiz-runner started"
```

`/healthz` reports the runner `down` when it is unreachable or refuses the
token, and `disabled` when `RUNNER_MODE` is left at `stub`; neither degrades
the platform (see *Without the runner* in §10).

### The live-evaluation guard

Production is never restarted under students' feet. Before it pulls
anything, `deploy.sh production` runs `scripts/live-evaluations.sql` in the
running database (`docker compose exec -T postgres psql`: no endpoint, no
secret) and REFUSES the deploy while it returns a row: it prints each live
evaluation (title, state, mode, opening and closing time), moves the checkout
back to the deployed commit and exits 3. Nothing is pulled or restarted, the
`deploy-production` job fails, and the runner VM is not touched either (its
step comes after).

Live means:

- `lobby`, `running` or `paused`: students connected, or waiting to start;
- `scheduled` and opening within the next 15 minutes, or opened less than
  12 hours ago (while the app is down the ticker opens nothing);

except a take-home exercise (an `exercise` whose waiting room is `skip`: it
may stay open for days, and a restart costs its students a few seconds of
reconnection) and a session untouched for 12 hours (left
open by mistake: it must not freeze every deploy). The guard fails closed: a
query that cannot run refuses the deploy like a live row. It is skipped, by
design, when `.env.image` is missing (a first deploy: nothing is running yet)
and when PostgreSQL is not running (no database, no evaluation in progress).
On a refusal it moves the checkout back only when `.env.image` names a full
sha; otherwise it warns and leaves the checkout where it is.
`apps/api/src/deployGuard.db.test.ts` runs the same file against the real
migrations on every CI run.

**When it refuses**: wait for the evaluation to close (the message says
when), then Actions → the run → *Re-run failed jobs*. The approval is asked
again. A session left open by mistake is better closed from the app than
forced.

**Forcing it** (an urgent fix during an exam, a session that will not close):

```bash
gh variable set DEPLOY_FORCE_SHA --repo heig-tin-info/heig-quiz --body <the run's full sha>
# re-run the deploy-production job, then:
gh variable delete DEPLOY_FORCE_SHA --repo heig-tin-info/heig-quiz
```

(or Settings → Secrets and variables → Actions → Variables). The job sends
`force <sha> <token>` only when the variable equals the sha it deploys, and
prints a warning when it does: a forgotten value forces nothing but that one
sha. By hand, on the VM: `SSH_ORIGINAL_COMMAND="force <sha> <PAT>"
./deploy.sh production`.

Staging is not guarded. Nobody sits an exam there; its data is a copy of
production's, live rows included and frozen at the copy; and a refused
staging deploy would hold back every promotion. Its restart still takes the
shared vCPU: on an exam day, stop it (§8, *Exam days*).

### Manually (if CI is unavailable)

```bash
# application VM, as srv: deploy.sh does the checkout, the login, the pull and
# the restart. "<sha> <PAT>" deploys that commit; "<PAT>" alone, origin/main.
cd /srv/quiz && SSH_ORIGINAL_COMMAND="<sha> <PAT read:packages>" ./deploy.sh production
# runner VM
cd /opt/quiz-runner && SSH_ORIGINAL_COMMAND="<sha> <PAT read:packages>" ./apps/runner/deploy/deploy.sh
```

The checkouts are DETACHED at the deployed commit, and `.env.image` holds its
tag: a manual compose command passes both env files, so that it restarts the
deployed image and not `:latest` (main's head, not yet approved):

```bash
docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image <command>
```

### The CSP moves from Caddy to the application (#319, once)

The release that brings `apps/api/src/csp.ts` also removes the CSP,
`X-Frame-Options` and the `@teamsTab` block from `Caddyfile` and
`Caddyfile.staging`. The fragments are installed by hand, so this is one
manual step per environment, in this order:

1. **The image first.** Let the merge deploy staging, then check that the
   application sends the policy:
   `curl -sI https://quiz.dev.chevallier.io/ | grep -i content-security` shows
   `default-src 'self'`.
2. **Then staging's fragment**, as `srv`. Production's checkout is still at
   the previous release, so the new file comes from `origin/main`:

   ```bash
   cd /srv/quiz && git fetch -q origin && git show origin/main:Caddyfile.staging > /etc/caddy/conf.d/quiz-staging.caddy \
     && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
   ```

3. **Approve production**, check the header as in step 1 on
   `quiz.chevallier.io`, then install its fragment, as `srv` (the checkout is
   now at the release):

   ```bash
   cd /srv/quiz && cp Caddyfile /etc/caddy/conf.d/quiz.caddy \
     && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
   ```

Why this order: the new fragment in front of the OLD image leaves the site
with no CSP at all until the image arrives. The old fragment in front of the
new image is safe but not finished: every page carries both policies (the
browser enforces both, and the old one only adds `frame-ancestors`), while
on `/teams` the old `@teamsTab` block REPLACES the application's policy with
its framing-only one. Hence the reinstall right after each deploy. A
rollback to an image older than this release needs the previous fragments
back (`git show <old sha>:Caddyfile`), for the first reason.

### Rollback

Re-run the `deploy-production` job of the run of the healthy commit (Actions
→ that run → *Re-run jobs*): same sha, same image, both VMs. Without CI, the
manual deploy above with that sha. The sha tags stay on GHCR, so every past
commit remains deployable.

Most migrations are additive, so an older image runs against a newer
schema. Three are not: `0008_schema_audit.sql` (drops `enrollments.status` and
three unused tables), `0022_teams_uploaded_app.sql` (drops `teams_links`) and
`0041_drop_join_code.sql` (drops `classrooms.join_code` and
`join_code_enabled`, ADR-053). A rollback to an image older than any of them
needs that migration's pre-migration dump restored first (§6); when in doubt,
restore it anyway. A rollback holds until the next approved promotion.

!!! warning "Never build on the application VM"

    The application VM is small (1 vCPU, 2 GB). A local build makes the host
    swap and strangles PostgreSQL (the classroom learned it on 2026-07-10, on
    the previous VM) and fills the disk with builder cache. `deploy.sh` only
    pulls. The runner VM does build the Alpine language images (rust, ~820 MB, included), on
    purpose; the runner image itself still comes from CI, so that both VMs
    run the commit the checks passed on.

## 6. Backups (RPO 24 h, RTO 4 h)

- **A daily provider backup of the application VM**, off the machine:
  Hetzner Backups (the Backups tab of the server in the Hetzner console, 7
  daily slots), which replaces the previous host's daily snapshot. The whole
  VM comes back, secrets and volumes included, crash-consistent. It must be
  enabled in the console: check that it is.
- **A daily `pg_dump -Fc`** from the compose `backup` service into
  `/srv/quiz/backups/quiz-<date>.dump` (30-day retention): a logical dump,
  restorable table by table. It lives on the VM it protects.
- **The backup report** ([ADR-055](../adr/ADR-055-etat-du-systeme.md)).
  After each dump the `backup` service writes one line of JSON into
  `/srv/quiz/backup-status/last.json`: `finished_at`, `ok`, `exit_code`,
  `file` and `size_bytes`. That directory, and only that one, is mounted
  read-only into `app` (`BACKUP_STATUS_FILE=/app/backup-status/last.json`).
  The admin's System status and `/healthz` read it. The dumps themselves are
  never mounted into `app`: the internet-facing process must not hold data
  deleted up to 30 days ago (N-DATA-03). The directory belongs to `srv`
  (container root, the writer), mode 755, **not** to uid 1000. Compose
  creates it on first start if it is missing, but create it by hand
  (below) so that its owner and mode are the ones you chose.

```bash
# once, as srv, when upgrading to the release that brings ADR-055
cd /srv/quiz && mkdir -p backup-status && chmod 755 backup-status
C="docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image"
$C up -d backup app          # the backup restarts and dumps at once: the report appears
cat backup-status/last.json  # {"finished_at":"…","ok":true,"exit_code":0,…}
```

A restart of `backup` takes a dump at once (the loop starts with one), so
expect one extra dump in `backups/` on that day. Staging has no `backup`
service and no `BACKUP_STATUS_FILE`: its status says "not configured".

- `/srv/quiz/assets/` (question images, content-addressed by sha256) is part
  of what to copy: `rsync` is enough. `./secrets` goes through the vault,
  never through the backup directory.
- The runner VM holds nothing to back up: the language images rebuild in a
  few minutes from `apps/runner/images/`, and its environment file is one line,
  the token, which the vault copy of `.env.prod` also holds.
- **Before any migration**, take a fresh dump rather than trusting the daily
  one:

```bash
cd /srv/quiz && docker compose -f compose.prod.yml --env-file .env.prod \
  exec -T postgres pg_dump -Fc -U quiz quiz > "backups/pre-<migration>-$(date +%F-%H%M).dump"
```

- Restore a full dump into a freshly recreated database, the app stopped:
  `pg_restore --clean` into the existing one fails on pg-boss's partitioned
  tables (`cannot drop inherited constraint … job_common`), as the
  2026-09-25 migration found.

```bash
cd /srv/quiz && C="docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image"
$C stop app
$C exec -T postgres psql -U quiz -d postgres \
  -c 'DROP DATABASE quiz WITH (FORCE)' -c 'CREATE DATABASE quiz OWNER quiz'
$C exec -T postgres pg_restore -U quiz -d quiz --no-owner --role=quiz --exit-on-error < backups/quiz-<date>.dump
$C start app
```

- **Still to wire**: an off-VM copy of the logical dumps (for instance
  `rclone copy backups remote:quiz-backups` in cron; open question 10 of
  `docs/spec/06-questions-ouvertes.md`). VM lost: new VM → §2 → secrets from
  the vault → restore the dump → re-point the DNS. Timed restore test every
  semester; a staging refresh (§8) doubles as one.

In development the equivalent of the database is the directory
`apps/api/.data/pglite`, which is only ever copied to keep a state, never
deployed.

## 7. Monitoring

### `/healthz`, the public probe

`GET /healthz` answers `200 {"status":"ok"}` when the database answers
`SELECT 1`, and `503 {"status":"degraded"}` otherwise. **Only the database
decides the status code**: the container `HEALTHCHECK` and the deploy gate
(`up -d --wait`, the CI's wait on staging, ADR-028) read it, and a restart
or a refused deploy is the wrong answer to anything else. Its `checks`
object reports, in coarse words only
([ADR-055](../adr/ADR-055-etat-du-systeme.md)):

| Field | Values | Meaning |
| --- | --- | --- |
| `database` | `up`, `down` | `SELECT 1` answers |
| `jobs` | `up`, `down` | pg-boss started |
| `runner` | `up`, `down`, `disabled` | `down`: configured but unreachable, or refusing the token; `disabled`: `RUNNER_MODE=stub` |
| `ticker` | `up`, `stale`, `none` | the live clock completed a pass within 10 s; `none`: no ticker in this process (`WORKER_MODE=web`) |
| `disk` | `ok`, `low`, `unknown` | under 15 % free where the app writes (the question images, the backup report) is `low` |
| `backup` | `ok`, `stale`, `unknown` | the last dump's report: `stale` when older than 26 h or failed; `unknown` when not configured (staging, development) |

and one aggregate, `"attention": true` when the ticker is `stale`, the disk
`low`, the backup `stale` or the runner `down`. Nothing else: no path, no
size, no name — the route is public. The details are on the admin page.
These checks run side by side within 1 s, well inside the healthcheck's
5 s: a runner that does not answer in time reads as `down`.

### The external probe

The primary alarm is an external uptime service (the product owner's
choice), polling `https://quiz.chevallier.io/healthz` every 60 s (every
5 min is enough on staging, if it is watched at all). Configure **one HTTP
keyword monitor**:

- alert when the status code is not 200 (the database, the process, the VM,
  Caddy, DNS or the certificate);
- **and** alert when the body does **not** contain the keyword
  `"attention":false` (no space: the body is compact JSON). That covers a
  stale ticker, a low disk, a stale or failed backup and a runner down.
- a timeout of 10 s, and a confirmation of two consecutive failures before
  alerting, so that a deploy's restart (a few seconds) does not page anyone.

Staging has no backup report (`backup: "unknown"` does not raise
`attention`) and runs the runner in `stub` (`disabled` does not either), so
the same keyword works there.

### The e-mail, the secondary alarm

The application tells its administrators itself (ADR-055 §5): the
`health.checks` scheduled task runs the checks of the System status every
five minutes (Administration → Scheduled tasks, where its period can be
changed), keeps each check's state in `health_check_states`, and notifies
every account whose role is admin — in the bell, and by e-mail unless they
turned it off in their settings (kind "Platform health"; never Teams):

- once a check has **failed on two runs in a row** (about ten minutes),
  naming the checks concerned — the page gives their causes;
- a reminder if it is **still failing a day later**;
- once it is **OK again**, if an alert was sent.

A warning, or a check that cannot be measured here, sends nothing. The
e-mail goes through the ordinary delivery (ADR-030), so staging, whose
mailer runs dry, only logs it, and it needs the job queue: `jobs.down` on
the page means no e-mail at all. It is the SECONDARY alarm: the task runs on
the ticker's claim, so a VM down, a crash loop or a ticker dead in every
process silences it too. The external probe above stays the primary.

### The System status page

Administration → **System status** (`GET /app/api/admin/system`, admins
only) answers "can I run an exam now, and does anything need me?": every
check with its status (OK, to look at, failing, unknown), its value, when it
was checked and, when not OK, its cause; a failing check also says when
the `health.checks` task first saw it fail. Live exam readiness: the ticker's
lag, attempts and evaluations left open a minute past their end (the
symptom of a dead ticker, whatever process runs it), scheduled tasks,
background jobs per queue (waiting, failed in 24 h, oldest wait), the
runner, the live evaluations and the open real-time connections. Data and
storage: the database's response time, size and largest tables, the
connections in use against `max_connections`, the free disk, the last
backup. The live section also counts the server errors (5xx) of the last
24 hours, with the three route templates that answered most of them (a
warning from five, never a failure). External services (ADR-055 §6):
e-mail, sign-in (the OIDC callback), Teams, the LLM provider and the GitHub
App, each judged from this process's own calls since it started — the last
success, the last failure with its class (`http_502`, `timeout`,
`invalid_grant`), `unknown` when not configured (staging's mail runs dry)
or not used yet. A service fails once its calls have kept failing for half
an hour (mail: two failures; sign-in: three), and then the `health.checks`
mail reports it like any check. The e-mail row has **Send me a test
e-mail**: a short message to the signed-in admin through the mailer alone,
one per minute, audited as `system.test_mail`. Then what is deployed:
commit, last migration, start time, Node, worker mode, environment. No
chart and no log line, on purpose.

The status is cached 20 s by the server; the page polls every 30 s while
visible, and Refresh recomputes it.

### `/metrics`

`GET /metrics` is a Prometheus endpoint with the default collectors, a
`quiz_database_up` gauge and `quiz_sse_connections` (the open real-time
streams of the process, N-OPS-02), and the HTTP series of N-OPS-02:

| Series | Labels | What |
| --- | --- | --- |
| `quiz_http_requests_total` (counter) | `method`, `route`, `status` | requests answered; `route` is the ROUTE TEMPLATE (`/app/api/classrooms/:id`), `unmatched` when no route matched, never a URL; `status` is the class, `2xx`…`5xx` |
| `quiz_http_request_duration_seconds` (histogram) | `method`, `route` | time to answer, buckets 25 ms, 100 ms, 250 ms, 1 s, 2.5 s, 10 s (an SSE stream lands in `+Inf`) |

No user, IP or query string in any label. It is never public: a request with
`Authorization: Bearer $METRICS_TOKEN` passes when the token is set, and any
other request must carry an admin session.

Logs are `docker compose logs -f app` on one VM and
`journalctl -u quiz-runner -f` on the other (credentials masked).

## 8. Staging (`quiz.dev.chevallier.io`, ADR-028)

Staging runs on the application VM, next to production, but NOT as `srv`:
it has its own account, `srvstg`, with its own rootless Docker (lingering
enabled), checkout (`/home/srvstg/quiz-staging`), compose project
(`quiz-staging`), PostgreSQL, port (`127.0.0.1:3003`) and secrets, every
container capped (`compose.staging.yml`). Staging executes every commit of
`main` before anyone approves it, so it must not share the account that owns
production's secrets, volumes and backups: `srvstg` can read nothing under
`/srv/quiz`, `/srv/heig-classroom` or `/srv/evaluation-tb` (§2, *The `srv`
account*). Its Caddy fragment, `/etc/caddy/conf.d/quiz-staging.caddy`, is
installed by `srv` (or an administrator), never by staging.

It is production configured: `NODE_ENV=production`, the edu-ID login, no
development login. Only the addresses in `LOGIN_ALLOWLIST` (and the super
administrator) may sign in, because its data is a copy of production's, not
anonymized (ADR-028, §3).

Until 2026-09-28 staging ran as `srv` in `/srv/quiz-staging`, on production's
Docker daemon.

### Setting up staging (once)

```bash
# DNS at Gandi: quiz.dev.chevallier.io CNAME portal.heig.chevallier.io, TTL 300.
# SWITCH Resource Registry: add the redirect URI
#   https://quiz.dev.chevallier.io/app/auth/callback

# On the application VM, as an administrator (sudo).
sudo useradd --create-home --shell /bin/bash srvstg     # also allocates its /etc/subuid and /etc/subgid ranges
grep -E '^(srv|srvstg):' /etc/subuid /etc/subgid        # two ranges, not overlapping
sudo loginctl enable-linger srvstg                      # its containers restart at boot
sudo chmod o-rwx /srv/quiz /srv/heig-classroom /srv/evaluation-tb
sudo install -d -o srv -g srvstg -m 2750 /srv/staging-inbox   # production writes, staging reads (below)

# As srvstg (sudo machinectl shell srvstg@): its own rootless Docker.
dockerd-rootless-setuptool.sh install                   # socket /run/user/$(id -u)/docker.sock
ls /srv/quiz                                            # must fail: Permission denied
ls /home/srv                                            # must fail too (0750, srvstg not in group srv)
# Rootless Docker applies `cpus`/`cpu_shares` only when systemd delegates the
# cpu controller: this must list `cpu`.
cat /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers
#   Without it (as root): mkdir -p /etc/systemd/system/user@.service.d && printf \
#     '[Service]\nDelegate=cpu cpuset io memory pids\n' > /etc/systemd/system/user@.service.d/delegate.conf \
#     && systemctl daemon-reload,
#   then restart the srvstg user session (or reboot).
cd ~ && git clone https://github.com/heig-tin-info/heig-quiz.git quiz-staging && cd quiz-staging
mkdir -p secrets assets
cp .env.staging.example .env.staging && chmod 600 .env.staging
nano .env.staging   # POSTGRES_PASSWORD, COOKIE_SECRET (new values), OIDC_CLIENT_ID, LOGIN_ALLOWLIST

# As root: the edu-ID key, copied once (srvstg cannot read production's copy).
sudo install -o srvstg -g srvstg -m 600 /srv/quiz/secrets/eduid-private-key.pem /home/srvstg/quiz-staging/secrets/
# Back as srvstg: hand secrets/ and assets/ to the container's `node` (a sub-uid of srvstg).
docker run --rm -v "$PWD":/w alpine sh -c 'chown -R 1000:1000 /w/secrets /w/assets && chmod 600 /w/secrets/*.pem'

# As srv (the fragment directory is srv's, not staging's).
cp /srv/quiz/Caddyfile.staging /etc/caddy/conf.d/quiz-staging.caddy && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy

# A second CI key, pinned to staging's account: the production key never reaches it.
ssh-keygen -t ed25519 -f ci_staging -N "" -C ci-deploy-staging@quiz
gh secret set STAGING_DEPLOY_SSH_KEY --env staging --repo heig-tin-info/heig-quiz < ci_staging
gh variable set STAGING_DEPLOY_USER --repo heig-tin-info/heig-quiz --body srvstg
# on the application VM, as srvstg
install -d -m 700 ~/.ssh
printf 'command="/home/srvstg/quiz-staging/deploy.sh staging",restrict %s\n' "$(cat ci_staging.pub)" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
shred -u ci_staging

# The approval: Settings → Environments → production → Required reviewers.
# Until it is set, production deploys right after staging, unattended.
```

The first staging deploy starts an empty database; fill it with
production's data (below).

Follow-up: staging still signs its edu-ID requests with production's key and
client. Register a separate edu-ID client for staging, with a key of its own,
and replace `secrets/eduid-private-key.pem`, `OIDC_CLIENT_ID` and
`OIDC_PRIVATE_KEY_KID` in `.env.staging`; `srvstg` then holds nothing of
production's.

### Cutover from the old `srv` staging (2026-09-28, once)

Staging ran as `srv` in `/srv/quiz-staging` until the commit that introduced
`srvstg`. The move, in this order:

1. **Before merging**: the whole *Setting up staging (once)* above: the
   `srvstg` account, its rootless Docker, `chmod o-rwx`, the inbox, the
   checkout, the secrets, `.env.staging`, the key in
   `/home/srvstg/.ssh/authorized_keys`, then
   `gh secret set STAGING_DEPLOY_SSH_KEY --env staging` and
   `gh variable set STAGING_DEPLOY_USER --body srvstg`.
2. **Just before the merge**, as `srv`, free `127.0.0.1:3003` (the new stack
   binds it from another daemon):
   `cd /srv/quiz-staging && docker compose -f compose.staging.yml --env-file .env.staging --env-file .env.image down -v`
3. **Merge**: the first staging deploy lands on `srvstg`, database empty.
4. **Fill the data** (below). `/srv/quiz/scripts/staging-export.sh` exists
   only once production has been promoted to that commit; until then, run
   `main`'s copy against the production checkout without switching it:

   ```bash
   # as srv
   cd /srv/quiz && git fetch -q origin && git show origin/main:scripts/staging-export.sh > /tmp/staging-export.sh
   QUIZ_PROD_DIR=/srv/quiz bash /tmp/staging-export.sh && rm /tmp/staging-export.sh
   ```

5. **Clean up** what `srv` still holds of staging: delete the
   `command="/srv/quiz-staging/deploy.sh staging"` line from
   `/home/srv/.ssh/authorized_keys`, `rm -rf /srv/quiz-staging` (it holds
   production data and the edu-ID key), and remove the repository-level
   leftover: `gh secret delete STAGING_DEPLOY_SSH_KEY --repo heig-tin-info/heig-quiz`.

### Refreshing the data

The copy travels one way, from production into `/srv/staging-inbox`, which
`srvstg` can read and not write:

```bash
# 1. As srv: a dump taken now and the question images, into the inbox.
/srv/quiz/scripts/staging-export.sh
# 2. As srvstg: restore them.
~/quiz-staging/scripts/staging-refresh.sh              # the inbox's copy
~/quiz-staging/scripts/staging-refresh.sh <file>       # that dump, images unchanged
```

Never on deploy: a refresh wipes whatever a test had prepared. It restores
the dump into a recreated database, empties sessions, launch tickets, API
tokens and OAuth grants (nothing production issued works here), unpacks the
question images, and starts the app, which migrates the copy forward: the
very migration production will run next. It doubles as the restore test of
§6. The inbox keeps only the latest copy; each export overwrites it.

### Exam days

Staging shares the vCPU. Stop it for the duration of an exam, as `srvstg`
(`sudo machinectl shell srvstg@`):

```bash
cd ~/quiz-staging && docker compose -f compose.staging.yml --env-file .env.staging --env-file .env.image stop
```

A deploy restarts it (`up -d`); so does `start`.

## 9. The two images

`Dockerfile` builds one image for the API and the built SPA together: a
`node:24-slim` build stage installs the workspace with a frozen lockfile,
builds every package sequentially (`--workspace-concurrency=1`), then
`pnpm deploy`s a pruned production tree of `@quiz/api` with the migrations
and `apps/web/dist` alongside. The runtime stage runs as the `node` user
with `STATIC_DIR=/app/web`, `MIGRATE_ON_START=1` and a `HEALTHCHECK` on
`/healthz`. The API applies the migrations at startup, then serves the SPA
from `/app/web`.

The runner image (`apps/runner/Dockerfile`) is smaller and different in one
respect: it contains no container engine, only the static `podman-remote`
client of a pinned version (5.7.0), verified by checksum, and it runs as
root on purpose because the socket it drives is root-owned. The pinned
version must match the engine of the code VM; upgrading the VM's Podman
means bumping the pin.

## 10. Configuration reference

### The application side

The `app` container reads `.env.prod` (from `.env.prod.example`,
`chmod 600`), plus a few values `compose.prod.yml` sets itself:
`NODE_ENV=production`, `DATABASE_URL` built from `POSTGRES_PASSWORD`,
`PUBLIC_URL` and `ASSETS_DIR`. Every variable is validated at startup by
`apps/api/src/config.ts`, which refuses to start on an invalid or dangerous
configuration.

| Variable | Production value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://quiz:<password>@postgres:5432/quiz`, set by compose | a `pglite://` URL is refused under `NODE_ENV=production` |
| `POSTGRES_PASSWORD` | `openssl rand -base64 32` | used by the `postgres`, `backup` and `app` services |
| `COOKIE_SECRET` | `openssl rand -base64 32` | signs the login state cookies; the `change-me` placeholder is refused |
| `AUTH_DEV_LOGIN` | unset | `1` is refused: the process does not start |
| `PUBLIC_URL` | `https://quiz.chevallier.io`, set by compose | base of the OIDC redirect URI; `WEB_URL` is left empty because the monolith serves the SPA itself |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | `https://login.eduid.ch/` and the client id from the SWITCH Resource Registry | the dev defaults point at the local Keycloak |
| `OIDC_PRIVATE_KEY_PATH`, `OIDC_PRIVATE_KEY_KID` | `secrets/eduid-private-key.pem`, `hgc-eduid-2026` | `private_key_jwt` client authentication: the classroom's key and `kid`, since the client shares its public JWK; `./secrets` is mounted read-only into the container |
| `OIDC_CLIENT_SECRET` | unset | with a private key configured the secret is never sent and is not checked; without one, `client_secret` authentication applies and the `not-for-production` placeholder is refused |
| `SUPER_ADMIN_EMAIL` | one address | the only account managed through the environment; teachers are managed from the admin screen |
| `LOGIN_ALLOWLIST` | unset (staging: the testers' addresses) | when set, only these addresses and the super administrator may sign in |
| `SEB_CONFIG_KEY_ENFORCE` | unset (`0`) until proof B, then `1` | the Config Key header on every request of a Safe Exam Browser session ([ADR-051](../adr/ADR-051-postes-kiosque-attestes.md) §3): off, a mismatch is only audited (`auth.seb_config_key_mismatch`); on, the request is anonymous. The launch refuses a bad header either way |
| `KIOSK_ATTESTATION` | unset (`off`) until the stations are set up, then `google` | the attested kiosk stations ([ADR-051](../adr/ADR-051-postes-kiosque-attestes.md), [setup](../kiosk.md)): `off`, the kiosk routes answer 404 and exams are not offered the setting; `mock`, the development fixture, is refused: the process does not start |
| `KIOSK_VA_KEY_FILE` | `secrets/verified-access-key.json` | the Chrome Verified Access service account's JSON key, in the read-only `./secrets` mount; with `google`, an unreadable file is refused |
| `KIOSK_GOOGLE_CUSTOMER_ID`, `KIOSK_ENROLLMENT_DOMAIN`, `KIOSK_EXTENSION_ID` | the Workspace's customer id, the stations' enrollment domain, the companion extension's id | with `google`, each one missing is refused, all of them named in one error |
| `SESSION_TTL_HOURS` | `12` | idle timeout with sliding expiry, at most 720 |
| `TRUSTED_PROXIES` | default `loopback,172.16.0.0/12` | the addresses the API accepts `X-Forwarded-For` from: native Caddy on loopback and the Docker bridge; `req.ip` feeds the room restriction and the attempt journal, so never list a range a student machine can sit on |
| `OAUTH_CIMD_HOSTS` | default `claude.ai,claude.com,chatgpt.com` | the only hosts whose OAuth Client ID Metadata Documents the server fetches ([ADR-023](../adr/ADR-023-serveur-oauth-pour-mcp.md)); `PUBLIC_URL` is the OAuth issuer, so it must be the exact public origin |
| `METRICS_TOKEN` | a bearer token for Prometheus | empty leaves `/metrics` to an admin session; the endpoint is never public |
| `SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID` | the classroom's Scaleway project | empty: e-mails are logged, never sent |
| `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_ALLOWED_TENANTS` | see [Microsoft Teams setup](teams.md) | empty: the Teams channel is off |
| `RUNNER_MODE`, `RUNNER_URL` | `http`, `https://code.chevallier.io:8443` | `http` without a URL is refused; `stub` disables the runner, see below |
| `RUNNER_TOKEN` | `openssl rand -hex 32`, the same value as `/etc/quiz-runner/env` on the runner VM | sent as `Authorization: Bearer` on every call; required when `RUNNER_MODE=http`, the process does not start without it |
| `RUNNER_TIMEOUT_MS` | default `30000` | wall-clock budget of one runner call |
| `LLM_PROVIDER` | unset (`none`) | essays are graded by hand; `stub`, the development fake, makes the process refuse to start |
| `LLM_KEY_SECRET` | `openssl rand -hex 32`, copied into the age vault | the master key that encrypts the Anthropic key entered in Administration › AI ([ADR-058](../adr/ADR-058-passerelle-llm.md)); empty turns the AI gateway off; under 32 characters, or containing `change-me`, the process does not start; a new value only means pasting the key again |
| `LLM_DAILY_CAP_MAX_USD` | default `100` | the most the console may set as the AI daily spending cap |
| `BACKUP_STATUS_FILE` | `/app/backup-status/last.json`, set by compose | the `backup` service's report of its last dump (§6); empty: the System status says "not configured" |
| `COMMIT_SHA`, `COMMIT_DATE` | baked into the image by CI | the commit the System status shows; never set by hand |
| `LOG_LEVEL`, `WORKER_MODE` | `info`, `all` | `web`/`worker` would split the roles without a code change ([ADR-001](../adr/ADR-001-monolithe-modulaire.md)) |

The uploaded question images live in `./assets` on the host, mounted at
`/app/assets` (`ASSETS_DIR`); the store is content-addressed by sha256, so a
backup of it is a plain copy.

Secrets travel through the environment or a mounted file and are never in
git ([ADR-010](../adr/ADR-010-stockage-secrets.md)).

### The runner side

The service reads `/etc/quiz-runner/env` (from
`apps/runner/deploy/env.example`, root only, `chmod 600`) through the
quadlet's `EnvironmentFile`, plus what the quadlet sets. Everything is
validated at startup by `apps/runner/src/config.ts`.

| Variable | Production value | Notes |
| --- | --- | --- |
| `RUNNER_TOKEN` | the value in `/srv/quiz/.env.prod` on the application VM | required under `NODE_ENV=production`: the service refuses to start without it; the only secret the runner holds, never passed into a sandbox container |
| `NODE_ENV`, `HOST`, `PORT` | `production`, `127.0.0.1`, `3200`, set by the quadlet | host networking, loopback only |
| `RUNNER_SECCOMP` | `/etc/quiz-runner/seccomp.json`, set by the quadlet | the host path the Podman server opens; a missing file stops the service |
| `PODMAN_SOCKET` | `/run/podman/podman.sock` | the rootful socket, mounted into the service |
| `RUNNER_USERNS_AUTO` | `true` | a rootful engine always supports `--userns=auto`, so no probe |
| `RUNNER_CONCURRENCY`, `RUNNER_QUEUE_MAX` | `2`, `32` | the VM has 2 CPUs and each container is 1 CPU |
| `LOG_LEVEL` | `info` | |

The image itself sets `PODMAN_BIN=podman-remote`.

### Without the runner

Set `RUNNER_MODE=stub` and drop `RUNNER_URL` and `RUNNER_TOKEN`, and the
whole platform still runs: a code question stays authorable, playable and
releasable, `POST /attempts/:id/run` answers `503 runner_unavailable`, and
its grading is proposed for a manual review (PLAN-MVP decision D14).
`/healthz` then reports the runner as `disabled`, a configuration and not a
failure.
