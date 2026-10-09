# Deployment

This page is the operator's runbook: the shape of the deployment, the exact
commands for the two machines, and what to do on a bad day. Its section
numbers (§1 to §8) are kept on purpose, because comments in the scripts and
compose files cite them.

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
ADR-016. A new instance from a fresh Ubuntu server, step by step, is
[Installing the platform on a new Ubuntu server](new-server.md); each
environment's GitHub App is [Quiz's GitHub App](github-app.md).

## The two machines

| | `portal.heig.chevallier.io` (application VM) | `code.chevallier.io` (runner VM) |
| --- | --- | --- |
| Size | Hetzner CPX12, 1 vCPU, 2 GB + 2 GB swap, `128.140.71.35` | Hetzner, 2 CPU, 4 GB |
| Already runs | heig-classroom on `:3000`, evaluation-tb on `:3001`, a native Caddy | heig-codespace, rootful Podman 5.7, a native Caddy |
| Gets | `/srv/quiz`: the compose stack `app`, `postgres`, `backup`, on the `srv` account's rootless Docker; and staging, `/home/srvstg/quiz-staging` on the `srvstg` account's own rootless Docker (§8) | `/opt/quiz-runner`: the runner as a Podman quadlet |
| Listens on | `app` on `127.0.0.1:3002` (staging `127.0.0.1:3003`) | the runner on `127.0.0.1:3200` |
| Vhost | `/etc/caddy/conf.d/quiz.caddy` → `quiz.chevallier.io` | `/etc/caddy/conf.d/quiz-runner.caddy` → `code.chevallier.io:8443` |
| Deploys through | `/srv/quiz/deploy.sh production` (user `srv`) and `/home/srvstg/quiz-staging/deploy.sh staging` (user `srvstg`), forced commands | `/opt/quiz-runner/infra/engine/deploy.sh production` and `… staging` (root), forced commands of the dispatcher shared by the runner and the codespace portal (M6-04) |

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
`import /etc/caddy/conf.d/*.caddy` line and nothing else. Its global block also
turns HTTP/3 off (`servers { protocols h1 h2 }`, 2026-10-08): Caddy advertised
`h3` but no request ever arrived over UDP 443, and a browser that had read the
`Alt-Svc` header stalled on every request after the first one, so the
workspace never opened. A reinstall of the code VM keeps that block.

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

GitHub ([ADR-035](../adr/ADR-035-fusion-de-classroom.md)) stays off until
the six `GITHUB_*` variables of the environment's own App are set and its
key is in `secrets/`: [Quiz's GitHub App](github-app.md), which also
creates staging's App (never production's on staging, N-SEC-18).

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
| the slices | `quiz-runner.slice`, `codespace.slice` in `/etc/systemd/system/` | `infra/engine/*.slice`, installed by the deploys (below) |
| the host input policy | `table inet host`, `/etc/quiz-engine/host.nft` included by `/etc/nftables.conf` | `infra/engine/host.nft`, applied by hand with `infra/engine/nft-apply.sh` (below) |
| the codespace backup export | `/usr/local/lib/quiz-codespace/backup-export.sh`, root's forced command for the backup key | `apps/codespace/deploy/backup-export.sh` (below) |

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
`127.0.0.1:3200` for the application VM's addresses only
(`@quiz remote_ip` in `apps/runner/deploy/Caddyfile`: `128.140.71.35`, and
its IPv6 for the day `code.chevallier.io` gets an AAAA); every
other address gets a 403. The runner then requires
`Authorization: Bearer <RUNNER_TOKEN>` on `POST /run` and on `GET /health`,
compared in constant time, and answers 401 otherwise. Two gates, either one
enough on its own. `/health` is guarded on purpose: a token the API got wrong
shows up as a runner `down` in `/healthz`, not as one that says `up` and
refuses every run. If the application VM moves again, add its new address to
that line (in the repository and in `/etc/caddy/conf.d/quiz-runner.caddy` on
the code VM) and to the host firewall's sets (below, applied by hand) before
the switch, as the 2026-09-25 migration did.

The runner holds one secret, that token, and nothing else: it reaches no
database and passes none of its environment into the sandbox containers. The
hardening of the sandbox containers themselves (the flag list, the closed
environment, nothing mounted) is documented once, in
[`apps/runner/README.md`](https://github.com/heig-tin-info/heig-quiz/blob/main/apps/runner/README.md).
`--userns=auto` is always available on a rootful engine, hence
`RUNNER_USERNS_AUTO=true` in the environment file.

### The codespace portal on the same VM

Since M6-04 the VM also runs Quiz's online workspace portal
(`apps/codespace`, ADR-047), replacing heig-classroom's: two instances,
`prod` on `code.chevallier.io` (for `quiz.chevallier.io`) and `staging` on
`code-dev.chevallier.io` (for `quiz.dev.chevallier.io`), each a Podman
quadlet of the CI's `ghcr.io/heig-tin-info/quiz-codespace:<sha>` image with
its own environment, data directory, SQLite, Podman network and Caddy site.
The two never touch each other's session containers (an instance label).
The layout, the switch from classroom's portal, the live-session guard of
a prod deploy and the smoke checks are
[`apps/codespace/deploy/RUNBOOK.md`](https://github.com/heig-tin-info/heig-quiz/blob/main/apps/codespace/deploy/RUNBOOK.md);
the application side is two variables per environment, `CODESPACE_URL` and
`CODESPACE_LAUNCH_SECRET` (`.env.prod`, `.env.staging`).

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

### The slices: grading before sessions (M6-05)

The VM is not resized (owner, 2026-10-08). The runner and the workspace
portals share it in two systemd slices, so that an exam's sessions cannot
starve grading. Their weights and memory lines, and why those values, are
in the unit files themselves, the only place they are written:

| Slice | Holds | Values and sizing |
| --- | --- | --- |
| `quiz-runner.slice` | `quiz-runner.service` (`Slice=`) and every sandbox container (`RUNNER_CGROUP_PARENT`, `--cgroup-parent`) | [`infra/engine/quiz-runner.slice`](https://github.com/heig-tin-info/heig-quiz/blob/main/infra/engine/quiz-runner.slice) |
| `codespace.slice` | both portals (`Slice=`), their session containers (`CODESPACE_CGROUP_PARENT`), the shadow snapshots, the backup export | [`infra/engine/codespace.slice`](https://github.com/heig-tin-info/heig-quiz/blob/main/infra/engine/codespace.slice) |

Both variables are set by the quadlets, not by the env files; empty, no
flag is passed and a container lands in `machine.slice`, as before M6-05. A
slice a unit names before its file exists is created empty by systemd, so
the order of the deploys does not matter. The runner's deploy installs both
files (`install_slices`, `infra/engine/lib.sh`), as does a codespace
bootstrap or `prod` deploy; never a codespace staging deploy. The
per-container limits (`--memory`, `--cpus`, `--pids-limit`) stay what they
were: a slice adds a shared budget, it replaces none. A container keeps the
cgroup it was created in: a session started before the rollout stays in
`machine.slice` until it is created again.

```bash
systemctl show quiz-runner.slice codespace.slice -p CPUWeight,IOWeight,MemoryLow,MemoryHigh,MemoryMax
systemd-cgls --no-pager -u quiz-runner.slice; systemd-cgls --no-pager -u codespace.slice
systemd-cgtop -m -n 1 --depth=2 | grep -E 'slice|machine'
```

### The host firewall (M6-05)

The VM's `input` hook drops what
[`infra/engine/host.nft`](https://github.com/heig-tin-info/heig-quiz/blob/main/infra/engine/host.nft)
does not admit; that file is the list of the inbound flows, and the place a
new one is added. It owns one table, `inet host`, and never flushes the
others: `inet codespace` and `bridge codespace` stay the codespace network
unit's, `inet netavark` Podman's. Its sets `runner_clients_v4/v6` and the
Caddyfile's `remote_ip` name the same addresses and move together. ufw
stays inactive: never enable it beside this table.

No deploy changes it: a production deploy only warns when the checkout's
file differs from the applied copy, so a merged change takes effect only
once re-applied. **Applying it**, the first time and
after every change, as root on the VM, from the production checkout, in a
session kept open (`ss -tulpn` first: nothing listening may be left out):

```bash
cd /opt/quiz-runner && git log -1 --oneline
infra/engine/nft-apply.sh                       # nft -c, rollback armed for 180 s, table loaded
# within 180 s, from other terminals:
infra/engine/nft-check.sh outside               # workstation: SSH, code-dev /healthz, :8443 and 9418 time out
infra/engine/nft-check.sh app                   # application VM, as srv in /srv/quiz: SSH, :8443 answers 401
infra/engine/nft-check.sh vm                    # here, a second session: tables, policy, a probe on each codespace network
infra/engine/nft-apply.sh confirm               # all green; otherwise do nothing and the previous table returns
```

Until `confirm`, `/etc` is untouched and a reboot boots the last confirmed
table. `confirm` writes `/etc/quiz-engine/host.nft`, an
`/etc/nftables.conf` that only includes it, and a drop-in that makes
stopping `nftables.service` delete `inet host` alone (the packaged unit
flushes every table), enables the service and deletes the old empty
`inet filter`. The packaged file is kept as
`/etc/nftables.conf.before-quiz`, its `flush ruleset` commented out:
restored with it, it would wipe the codespace and netavark tables. To take
the firewall off: `systemctl stop nftables`.

### Backup and restore of the codespace data (M6-05)

The runner holds nothing to back up (its images rebuild from
`apps/runner/images/`, its environment file is the token the vault copy of
`.env.prod` also holds). The portals do: per instance
`/srv/quiz-codespace/<i>/var/codespace.sqlite` (sessions, push events,
assignments, users) and `/srv/quiz-codespace/<i>/volumes/<assignment>/<user>/`
(`work`, `staging.git`, `shadow.git`), owned by the uid ranges
`--userns=auto` drew.

**Destination A, a stopgap while the workspace is test-only** (ADR-016's
M6-05 amendment): the application VM pulls one archive a day over SSH.

- *Runner VM:* `apps/codespace/deploy/backup-export.sh`, installed in
  `/usr/local/lib/quiz-codespace/` by a bootstrap or a `prod` deploy,
  writes to stdout one `zstd` tar holding, per instance,
  `<i>/var-backup/codespace.sqlite` (an online SQLite `.backup`) and
  `<i>/volumes/`, with numeric owners and extended attributes. It runs in
  `codespace.slice`, nice 10, idle IO, and needs `sqlite3` and `zstd`.
- *No credential in it.* The env files (`/etc/quiz-codespace/<i>/env`, the
  launch and cookie secrets) stay out: they go through the vault (ADR-010).
  The copy's `sessions.cookie_token` (the `cs_session` bearer of each open
  session) is blanked, then the copy is vacuumed and integrity-checked: an
  empty token matches no cookie, so a restored session needs a new launch.
  The rest of the schema holds no credential: `launch_tokens_used` keeps
  spent `jti`s, `push_events.last_error` is redacted, `users` holds
  identities, and `assignments.beks` holds Browser Exam Keys, which the
  platform resends on every sync and which are empty until exams use the
  portal (M6-07). Tokens never reach the volumes (root invariant 15); what
  a student writes into `work/` is the student's.
- *Live read.* The volumes are read while sessions run: tar's "file changed
  as we read it" is accepted, so a repository written during the read can
  come back incomplete. The restore's `git fsck` says so, and `shadow.git`
  holds the work tree of at most three minutes earlier.
- *Application VM:* `srv`'s user timer `quiz-engine-backup.timer` (daily,
  03:00 plus up to 2 h, `Persistent`) runs
  `scripts/engine-backup/pull.sh`: the stream lands in a temporary file,
  `zstd -t` must read it to the end, then it becomes
  `/srv/quiz-engine-backups/codespace-<UTC date>.tar.zst` (mode 600) and the
  newest 14 are kept. The export's own messages travel back over SSH into
  the same journal.
- *Monitoring is by hand for now:* the System status and `/healthz` read
  the database dump's and the off-site copy's reports (ADR-055, §6), not the
  pull's; a failed pull fails the unit, nothing alerts. Check `systemctl --user list-units --failed` and
  `ls -lh /srv/quiz-engine-backups` as `srv`; the script prints the disk
  space left after each run (the VM's disk is small).

Setting it up, once:

```bash
# application VM, as srv: the key and the user units
ssh-keygen -t ed25519 -N '' -C quiz-engine-backup@portal -f ~/.ssh/engine-backup
ssh-keyscan -t ed25519 code.chevallier.io >> ~/.ssh/known_hosts      # compare with the VM's own key
install -d -m 0700 /srv/quiz-engine-backups
install -d ~/.config/systemd/user
cp /srv/quiz/scripts/engine-backup/quiz-engine-backup.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now quiz-engine-backup.timer
command -v zstd || echo "zstd missing: ask root to apt install zstd"

# runner VM, as root: the two tools, then ONE line in root's authorized_keys
apt install -y sqlite3 zstd
ls -l /usr/local/lib/quiz-codespace/backup-export.sh    # installed by the bootstrap or a prod deploy
```

```text
command="/usr/local/lib/quiz-codespace/backup-export.sh",restrict,from="128.140.71.35,2a01:4f8:1c19:1164::1" ssh-ed25519 AAAA… quiz-engine-backup@portal
```

The key can only run the export: `restrict` forbids a terminal and every
forwarding, `from=` admits the application VM's addresses only, and the
client's command is ignored. A first run by hand, then the timer's:

```bash
systemctl --user start quiz-engine-backup.service; journalctl --user -u quiz-engine-backup -n 20 --no-pager
ls -lh /srv/quiz-engine-backups; systemctl --user list-timers quiz-engine-backup.timer
```

**Restoring.** Check the archive first, then restore into **staging**, and
into `prod` only once staging has come back: a restore replaces an
instance's database and volumes as a whole. As root on the runner VM, with
the archive copied there through the operator's workstation (the backup
key cannot write):

```bash
f=/root/codespace-<date>.tar.zst; i=staging     # the instance to restore
pd() { podman --remote --url unix:///run/podman/podman.sock "$@"; }
r=/root/restore-$(date +%F) && install -d -m 0700 "$r"
zstd -dc "$f" | tar --numeric-owner --xattrs --xattrs-include='*' -xpf - -C "$r"

# 1. the database (and no session bearer in it)
sqlite3 "$r/$i/var-backup/codespace.sqlite" 'PRAGMA integrity_check'                       # ok
sqlite3 "$r/$i/var-backup/codespace.sqlite" "SELECT count(*) FROM sessions WHERE cookie_token <> ''"   # 0
# 2. every repository
for g in "$r/$i"/volumes/*/*/{staging,shadow}.git; do
  git -c safe.directory='*' --git-dir="$g" fsck --no-dangling --no-progress >/dev/null 2>&1 || echo "fsck FAILED: $g"
done
# 3. the ownership came back numerically (a mapped uid, not root, on work/)
stat -c '%u:%g %n' "$r/$i"/volumes/*/*/work | head
zstd -dc "$f" | tar --numeric-owner -tvf - "$i/volumes" | awk '{print $2}' | sort | uniq -c

# 4. the swap: the instance stopped, its containers gone, the current data kept aside
systemctl stop "quiz-codespace-shadow@$i.timer" "quiz-codespace-$i.service"
pd ps -a --filter "label=heig-codespace.instance=$i" --format '{{.Names}}' | xargs -r pd rm -f
d=/srv/quiz-codespace/$i && mv "$d/var" "$d/var.before-restore" && mv "$d/volumes" "$d/volumes.before-restore"
install -d -m 0750 "$d/var" && install -m 0640 "$r/$i/var-backup/codespace.sqlite" "$d/var/codespace.sqlite"
mv "$r/$i/volumes" "$d/volumes"
systemctl start "quiz-codespace-$i.service" "quiz-codespace-shadow@$i.timer"

# 5. the smoke checks (RUNBOOK.md §11), then a student's workspace opened from Quiz
node /opt/quiz-runner/apps/codespace/deploy/smoke.mjs staging --port 3120 --launch
```

A student reopens a workspace through a new launch from Quiz; its container
is recreated on the restored `work/` (`:U` rechowns it to the new range).
Once it is checked, delete `*.before-restore` and `$r`. The restore drill is
part of M6-05's acceptance; record its date in the card.

**Destination B, later:** `restic` to an S3 bucket from the runner VM
itself (encrypted, deduplicated, its own retention), which removes the
pull and the application VM's disk from the path; decided when the
workspace serves a real class.

## 4. Continuous deployment

`.github/workflows/ci.yml` has four stages:

1. **checks**, on every push and pull request: parallel jobs run
   `pnpm build` with `pnpm typecheck` (`build-typecheck`), the API's tests
   in four shards and the SPA's in three (`test-app`), and every other
   package's, the runner's unit suite and the kiosk extension's included
   (`test-rest`). The `checks` job aggregates them: it is the one required
   status; the separate `Coverage` workflow (`coverage.yml`) is informative
   and required by nothing. A pull
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
command="/opt/quiz-runner/infra/engine/deploy.sh production",restrict ssh-ed25519 AAAA… ci-deploy@quiz
command="/opt/quiz-engine-staging/infra/engine/deploy.sh staging",restrict ssh-ed25519 AAAA… ci-deploy-staging@quiz
```

On the runner VM one dispatcher, `infra/engine/deploy.sh`, deploys both of
its components since M6-04, each key from its own checkout, and the scope of
the line bounds what a key may deploy: the production key the runner and the
codespace portal's `prod` instance, the staging key the portal's `staging`
instance only. The staging key is still root on that VM (ADR-016, M6-04
amendment). The request forms are in the dispatcher's header; the switch
and the portal's operations are
[`apps/codespace/deploy/RUNBOOK.md`](https://github.com/heig-tin-info/heig-quiz/blob/main/apps/codespace/deploy/RUNBOOK.md).

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
`git checkout --detach <sha>` (on the application VM a token alone, a
manual deploy, deploys the head of `origin/main`, still by its sha). That rewrites the script while bash
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
- **runner VM** (`infra/engine/deploy.sh`, which serialises the VM's deploys
  through a `flock`, checks the key's scope, then runs the component's
  steps; the runner's are `apps/runner/deploy/install.sh`): `podman pull` of
  the sha-tagged runner image and retag it `:latest` (the tag the quadlet
  runs), install the seccomp profile, the quadlet and the Caddy fragment
  from the checkout, `caddy validate`, `systemctl daemon-reload`, restart
  `quiz-runner.service`, reload Caddy, untag the older sha-tagged runner
  images (no global prune: the portal's sessions share the engine), print
  the deployed commit.

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
printf 'command="/opt/quiz-runner/infra/engine/deploy.sh production",restrict %s\n' "$(cat ci_deploy.pub)" >> /root/.ssh/authorized_keys
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
# runner VM, as root: the runner, then the codespace portal's instances
SSH_ORIGINAL_COMMAND="runner prod <sha> <PAT read:packages>" /opt/quiz-runner/infra/engine/deploy.sh production
SSH_ORIGINAL_COMMAND="codespace prod <sha> <PAT read:packages>" /opt/quiz-runner/infra/engine/deploy.sh production
SSH_ORIGINAL_COMMAND="codespace staging <sha> <PAT read:packages>" /opt/quiz-engine-staging/infra/engine/deploy.sh staging
```

The checkouts are DETACHED at the deployed commit, and `.env.image` holds its
tag: a manual compose command passes both env files, so that it restarts the
deployed image and not `:latest` (main's head, not yet approved):

```bash
docker compose -f compose.prod.yml --env-file .env.prod --env-file .env.image <command>
```

### Rollback

Re-run the `deploy-production` job of the run of the healthy commit (Actions
→ that run → *Re-run jobs*): same sha, same image, both VMs. Without CI, the
manual deploy above with that sha. The sha tags stay on GHCR, so every past
commit remains deployable.

Most migrations are additive, so an older image runs against a newer
schema. Among those that are not (each drops or changes something an older
image reads):

- `0007_poll_guests.sql`: drops `guest_participants.display_name` and `token`;
- `0008_schema_audit.sql`: drops `enrollments.status` and three unused tables;
- `0015_exercise_retakes.sql`: drops the one-attempt index, so an older
  image's `ON CONFLICT (evaluation_id, user_id)` matches no index (ADR-025);
- `0019_evaluation_templates.sql`: an older image reads a course template as
  an owned poll (ADR-031);
- `0022_teams_uploaded_app.sql`: drops `teams_links`;
- `0023_teams_graph_activity.sql`: drops the Teams links' `conversation_id`
  and `service_url`;
- `0041_drop_join_code.sql`: drops `classrooms.join_code` and
  `join_code_enabled` (ADR-053);
- `0059_project_deadline.sql`: drops `projects.frozen_at` and two due indexes;
- `0060_project_review.sql`: drops `projects.review_dispatched_at`;
- `0064_group_sets.sql`: drops `projects.group_max_size`;
- `0072_project_sync.sql`: drops `project_repos.sync_pr_number` and
  `sync_pr_state`;
- `0089_gradebook_weight_percent.sql`: rescales `gradebook_columns.weight`
  to a whole percentage, which an older image reads as a coefficient.

A rollback to an image older than any of them, or than any other migration
that is not additive, needs that migration's pre-migration dump restored
first (§6); when in doubt, restore it anyway. A rollback holds until the next approved promotion.

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
  (§2, *Setting up the application VM*) so that its owner and mode are the
  ones you chose. Staging has no `backup` service and no
  `BACKUP_STATUS_FILE`: its status says "not configured".

- `/srv/quiz/assets/` (question images, content-addressed by sha256) is part
  of what the off-site copy holds (below). `./secrets` goes through the
  vault, never through the backup directory.
- The runner itself holds nothing to back up (its images rebuild, its
  token is in the vault copy of `.env.prod`), but the codespace portals on
  the same VM do: their SQLite and volumes are pulled daily onto this VM, 14 archives
  in `/srv/quiz-engine-backups` (§3, Backup and restore of the codespace
  data).
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

- **VM lost**: new VM → §2 → secrets from the vault → the dumps and the
  images from the off-site copy (below) → restore the dump → re-point the
  DNS. Timed restore test every semester; a staging refresh (§8) of a dump
  extracted from the off-site copy doubles as one.

In development the equivalent of the database is the directory
`apps/api/.data/pglite`, which is only ever copied to keep a state, never
deployed.

### The off-site copy (#235)

Every night `srv`'s user timer `quiz-offsite-backup.timer` (05:30 UTC, give
or take a quarter of an hour, `Persistent`) runs
`scripts/offsite-backup/push.sh`: one [borg](https://www.borgbackup.org/)
archive, `zstd,6`, of the backups of **every service of this VM**, into one
encrypted repository (`repokey-blake2`) on a Hetzner Storage Box (BX11,
Helsinki): another product, another machine and another site than the VM.
The box's account, host and repository name are not in this repository:
they are in the vault and in each machine's env file (below).

The VM writes through a key the box forces into `borg serve --append-only`,
and holds the passphrase; pruning runs only from the operator's workstation.
Why, and what that leaves exposed: [ADR-009](../adr/ADR-009-deploiement-vm-compose.md),
amendment of decision 3.

| | |
| --- | --- |
| Box | `u<id>@u<id>.your-storagebox.de`, SSH on port **23**, a restricted shell (no redirect, no pipe); borg 1.2 and 1.4 on the server side, the clients use `BORG_REMOTE_PATH=borg-1.4` |
| Repository | `ssh://u<id>@u<id>.your-storagebox.de:23/./<repo>`; archives `<hostname>-<YYYY-MM-DDTHH:MM>` (the VM's time) |
| Sources | `/srv/quiz/backups` (**required**: missing, the run fails); `/srv/quiz/assets`, `/srv/heig-classroom/backups`, `/srv/evaluation-tb/backups`, `/srv/evaluation-tb/assets`, `/srv/quiz-engine-backups` (skipped with a log line when missing). A file still being written (`*.tmp`, `.*.part`) is left out |
| Not in it | the PostgreSQL data directories (the dumps suffice; the Hetzner VM backup holds the physical copy), the images (pulled or rebuilt), the secrets (the vault, ADR-010) |
| On the VM | borgbackup 1.4 (apt); the key `~/.ssh/storagebox-borg`; the passphrase `~/.config/borg-offsite/passphrase` and the env file `~/.config/borg-offsite/env`, both mode 600 |
| In the vault | the box's account and **password** (password SSH cannot be relied on being off), its full-access key, the passphrase and the exported repository key (`borg key export`, and `--paper`), beside `.env.prod` and `secrets/` |
| The night (UTC) | heig-classroom dump ~19:54, quiz dump 21:01, evaluation-tb dump 03:17, engine pull 03:00–05:00, then the off-site copy |

Both scripts read the repository and the credentials from
`~/.config/borg-offsite/env` (mode 600, outside any checkout) and refuse to
run without it. On the VM; the workstation's has its own `BORG_RSH` (the
full-access key), or none if ssh's configuration selects it:

```bash
export BORG_REPO=ssh://u<id>@u<id>.your-storagebox.de:23/./<repo>
export BORG_REMOTE_PATH=borg-1.4
export BORG_PASSCOMMAND="cat $HOME/.config/borg-offsite/passphrase"
export BORG_RSH="ssh -i $HOME/.ssh/storagebox-borg -o IdentitiesOnly=yes -o BatchMode=yes -o ServerAliveInterval=30"
```

(`push.sh` falls back to that `BORG_RSH` when the file sets none.) The first
archive held 165 MB, 146 MB once deduplicated, in 3 s: each following night
adds only what changed.

**The report.** After each run, success or failure, `push.sh` writes one
line of JSON to the path its unit passes,
`/srv/quiz/backup-status/offsite.json`, beside the dump's `last.json` and in
the same shape, through a temporary file and a rename:
`{"finished_at":"…","ok":true,"exit_code":0,"file":"<archive>"}`. `ok` is
true for borg's exit 0 and 1 (a warning: a file that changed while read,
logged); exit 2 and above, a missing env file or a missing
`/srv/quiz/backups` give `ok: false` and fail the unit. The app reads it as
the **Off-site copy** check (ADR-055, `offsite`), with the dump's thresholds
(a warning past 26 h, a failure past 50 h or when the run failed), and the
coarse `backup` word of `/healthz` is the worse of the two copies (§7).

Setting it up, once (done on 2026-10-09; kept for a new VM or a new box):

```bash
# application VM, as srv: the key, the box's host key, the passphrase, the env file
ssh-keygen -t ed25519 -N '' -C borg-offsite@<vm> -f ~/.ssh/storagebox-borg
ssh-keyscan -p 23 u<id>.your-storagebox.de >> ~/.ssh/known_hosts    # compare with Hetzner's fingerprints
install -d -m 0700 ~/.config/borg-offsite
(umask 077; openssl rand -base64 32 > ~/.config/borg-offsite/passphrase)   # the same value goes to the vault
(umask 077; nano ~/.config/borg-offsite/env)                               # the four lines above
```

The box's shell takes no redirect: write its `.ssh/authorized_keys` on the
workstation and put it through sftp with the full-access account. It holds
the workstation's own key, unrestricted, and the VM's, forced:

```text
command="borg-1.4 serve --append-only --restrict-to-repository /home/<repo>",restrict ssh-ed25519 AAAA… borg-offsite@<vm>
```

```bash
# workstation: put the file, create the repository, export its key
sftp -P 23 u<id>@u<id>.your-storagebox.de
#   sftp> mkdir .ssh
#   sftp> put authorized_keys .ssh/authorized_keys
#   sftp> chmod 600 .ssh/authorized_keys
source ~/.config/borg-offsite/env       # the workstation's, with the VM's passphrase copied
borg init --encryption=repokey-blake2
borg key export :: repo.borg-key && borg key export --paper :: > repo.borg-key.txt   # both to the vault

# application VM, as srv: the user units, then a first run by hand
install -d ~/.config/systemd/user
cp /srv/quiz/scripts/offsite-backup/quiz-offsite-backup.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now quiz-offsite-backup.timer
systemctl --user start quiz-offsite-backup.service
```

The production deploy brings both these scripts (its checkout) and the
`offsite` check: until `offsite.json` exists the check warns and `/healthz`
raises `attention`. Pause the external probe's monitor, deploy, install the
units and start the service at once, then resume it.

Checking it, as `srv`:

```bash
systemctl --user list-timers quiz-offsite-backup.timer
journalctl --user -u quiz-offsite-backup -n 30 --no-pager      # borg's --stats and its rc
cat /srv/quiz/backup-status/offsite.json
source ~/.config/borg-offsite/env && borg list                 # the archives
```

**Restoring from the box.** Any machine with borg, the env file's values,
the passphrase and the repository key reads it (the vault's export, through
`borg key import`, if the repository's own copy is lost or cannot be
trusted). List, then extract what you need into an empty directory; the
paths come back without their leading `/`:

```bash
borg list
borg extract --list ::<archive> srv/quiz/backups/quiz-<date>.dump srv/quiz/assets
```

The dump then goes through the full restore above (a recreated database,
`pg_restore`) and the images back into `/srv/quiz/assets/`; the dumps of
heig-classroom and evaluation-tb follow their own runbooks, the codespace
archive the restore of §3. A timed restore test: `staging-refresh.sh <file>`
(§8) of the extracted dump.

**Recovering from a deletion through the append-only key.** A `delete` or
a `prune` sent with the VM's key is recorded, not applied: until a compact
runs with the full-access key, the transaction log can be rolled back
(borg's documented append-only recovery). From the workstation, with the
full-access account, and **before any prune or compact**:

1. read the repository's `transactions` file (over sftp) and find the last
   good transaction, the one before the unwanted ones;
2. delete the segment files written after it (`data/<n>/<segment>`, the
   higher numbers), then the `hints.*`, `index.*` and `integrity.*` files;
3. `borg check` rebuilds the index: the deleted archives are back
   (`borg list`).

Each client's cache is then newer than the repository and refuses with
"Cache … newer than repository": remove `~/.cache/borg/<repo id>` and
`~/.config/borg/security/<repo id>` on every machine that used it, the VM
included, before its next run.

**Pruning**, by hand from the workstation only (once a month is enough):
`scripts/offsite-backup/prune.sh` keeps 7 daily, 8 weekly and 12 monthly
archives, then compacts, and saves the list of archives it leaves
(`~/.config/borg-offsite/last-archives`). Before touching anything it
refuses, pruning and compacting nothing:

- when an archive of that saved list is gone: someone deleted it, and a
  compact would make the deletion permanent; recover it as above;
- when a calendar day after the newest saved archive, up to yesterday, has
  no archive: one made since may have been deleted. Once the gap is
  explained (the VM was down), `--accept-gaps` goes on;
- when there is no saved list (the first run, a new workstation): read the
  `transactions` file first, then `--first-run`.

It cannot see the deletion of an archive whose day still has another one
(a second run by hand), nor of today's.

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
| `backup` | `ok`, `stale`, `unknown` | the worse of the last dump's report and the off-site copy's (§6): `stale` when either is older than 26 h, failed or missing; `unknown` when not configured (staging, development) |

and one aggregate, `"attention": true` when the ticker is `stale`, the disk
`low`, the backup `stale` (the dump or its off-site copy) or the runner `down`. Nothing else: no path, no
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
  stale ticker, a low disk, a stale or failed backup or off-site copy, and
  a runner down: a night without an off-site archive is noticed the next
  morning (past 26 h).
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
backup and the last off-site copy. The live section also counts the server errors (5xx) of the last
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
tokens and OAuth grants (nothing production issued works here), forgets
every GitHub installation, archives every project and stops its group
moves, closes the copied webhook deliveries and drops production's queued
jobs (`scripts/staging-scrub.sql`: staging's own App never acts on a
production organization, N-SEC-18; a tester unarchives the project under
test), unpacks the
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
| `SEB_EXTRA_ALLOWED_HOSTS` | unset (empty) | hosts every `.seb` lets SEB reach beside Quiz (and, for a project, the workspace portal): comma-separated host names, `*` wildcards, no scheme (D21, M6-07). Empty keeps an evaluation's file as ADR-027 pinned it |
| `KIOSK_ATTESTATION` | unset (`off`) until the stations are set up, then `google` | the attested kiosk stations ([ADR-051](../adr/ADR-051-postes-kiosque-attestes.md), [setup](kiosk.md)): `off`, the kiosk routes answer 404 and exams are not offered the setting; `mock`, the development fixture, is refused: the process does not start |
| `KIOSK_VA_KEY_FILE` | `secrets/verified-access-key.json` | the Chrome Verified Access service account's JSON key, in the read-only `./secrets` mount; with `google`, an unreadable file is refused |
| `KIOSK_GOOGLE_CUSTOMER_ID`, `KIOSK_ENROLLMENT_DOMAIN`, `KIOSK_EXTENSION_ID` | the Workspace's customer id, the stations' enrollment domain, the companion extension's id | with `google`, each one missing is refused, all of them named in one error |
| `SESSION_TTL_HOURS` | `12` | idle timeout with sliding expiry, at most 720 |
| `TRUSTED_PROXIES` | default `loopback,172.16.0.0/12` | the addresses the API accepts `X-Forwarded-For` from: native Caddy on loopback and the Docker bridge; `req.ip` feeds the room restriction and the attempt journal, so never list a range a student machine can sit on |
| `OAUTH_CIMD_HOSTS` | default `claude.ai,claude.com,chatgpt.com` | the only hosts whose OAuth Client ID Metadata Documents the server fetches ([ADR-023](../adr/ADR-023-serveur-oauth-pour-mcp.md)); `PUBLIC_URL` is the OAuth issuer, so it must be the exact public origin |
| `METRICS_TOKEN` | a bearer token for Prometheus | empty leaves `/metrics` to an admin session; the endpoint is never public |
| `SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID` | the classroom's Scaleway project | empty: e-mails are logged, never sent |
| `TEAMS_CLIENT_ID`, `TEAMS_CLIENT_SECRET`, `TEAMS_ALLOWED_TENANTS` | see [Microsoft Teams setup](teams.md) | empty: the Teams channel is off |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | the production App's | empty: the GitHub features are off; with an App id, the refusals of [Quiz's GitHub App](github-app.md#the-environments-variables) apply |
| `RUNNER_MODE`, `RUNNER_URL` | `http`, `https://code.chevallier.io:8443` | `http` without a URL is refused; `stub` disables the runner, see below |
| `RUNNER_TOKEN` | `openssl rand -hex 32`, the same value as `/etc/quiz-runner/env` on the runner VM | sent as `Authorization: Bearer` on every call; required when `RUNNER_MODE=http`, the process does not start without it |
| `RUNNER_TIMEOUT_MS` | default `30000` | wall-clock budget of one runner call |
| `GRADING_RUNNER_CONCURRENCY` | default `1` | runner jobs of the background grading the API runs at once ([ADR-067](../adr/ADR-067-correction-a-la-remise-des-exercices.md)): exercises are graded at every hand-in, and the runner's queue (`RUNNER_CONCURRENCY`) also serves the students' Run clicks; raise it only with the runner's own concurrency |
| `LLM_PROVIDER` | unset (`none`) | AI grading proposals go through the gateway (`LLM_KEY_SECRET`, below) when it is on and holds a key, otherwise answers are graded by hand; `stub`, the development fake, makes the process refuse to start |
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
