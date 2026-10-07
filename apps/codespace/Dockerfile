# quiz-codespace -- the online workspace portal (ADR-047), one image per sha.
#
# Build from the REPOSITORY ROOT:
#   docker build -f apps/codespace/Dockerfile -t quiz-codespace .
#
# Built by the CI and pulled by the engine VM's deploy (infra/engine/deploy.sh,
# ADR-016 amendment of M6-04); the VM never builds it. It runs as the Podman
# quadlet apps/codespace/deploy/quiz-codespace.container, once per instance
# (prod, staging). Like the runner's image it carries no engine: it drives the
# HOST's rootful Podman through the mounted socket, always with `--remote`.
#
# The image holds no secret: the launch secret and the exam cookie secret are
# in the instance's /etc/quiz-codespace/<instance>/env, read by the quadlet.
# The STUDENT image (images/c-dev) is not built here: it is built on the VM
# (apps/codespace/images/build.sh), like the runner's language images.
FROM node:24-slim AS build
# better-sqlite3 is a native module: its install downloads the prebuilt
# binary for this Node and this glibc, and falls back to node-gyp when there
# is none, hence the toolchain, which stays in this stage.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm
WORKDIR /src
# Every dependency of the lockfile into the store, keyed on the lockfile only;
# the install then links offline, for the portal and its packages only.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @quiz/codespace...
# `pnpm deploy` follows the package's own .gitignore, which names dist/: it is
# copied back in. drizzle/ (the migrations openDb applies) travels with the
# package. infra/ is not needed at run time: the seccomp profile is a HOST
# path the Podman server opens (installed by the deploy).
RUN pnpm --filter @quiz/codespace... build \
  && pnpm --filter @quiz/codespace deploy --prod --legacy /out \
  && cp -r apps/codespace/dist /out/dist \
  && test -f /out/drizzle/meta/_journal.json \
  && test -d /out/node_modules/better-sqlite3 \
  && rm -rf /out/infra /out/images /out/docs /out/project.md /out/src \
  && node -e "require('/out/node_modules/better-sqlite3')(':memory:').close()"

FROM node:24-slim
# git: the git channel is `git http-backend`, and the staging repositories are
# seeded with git (anonymous HTTPS for a public repository, hence
# ca-certificates). curl: only to fetch the Podman client, then removed.
#
# The Podman CLIENT only, the same pinned static binary as apps/runner/Dockerfile
# (version AND checksum; bump both images together with the VM's engine). It
# is installed as `podman`, the name src/engine/index.ts executes.
ARG PODMAN_VERSION=5.7.0
ARG PODMAN_SHA256=0d1759e3fc42b0e3a4496176dabc7b65f0f334a0ab2b22eaed7c36afeece8b0c
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && curl -fsSL -o /tmp/podman-remote.tgz \
       "https://github.com/containers/podman/releases/download/v${PODMAN_VERSION}/podman-remote-static-linux_amd64.tar.gz" \
  && echo "${PODMAN_SHA256}  /tmp/podman-remote.tgz" | sha256sum -c - \
  && tar -xzf /tmp/podman-remote.tgz -C /tmp \
  && install -m 0755 /tmp/bin/podman-remote-static-linux_amd64 /usr/local/bin/podman \
  && rm -rf /tmp/podman-remote.tgz /tmp/bin \
  && apt-get purge -y curl && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* \
  && podman --version
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# Runs as root ON PURPOSE, as the runner does: the mounted socket is
# root-owned, and reaching a rootful Podman socket is root-equivalent anyway.
# The quadlet drops every capability, so this root cannot read a student's
# file it does not own (the shadow snapshots run as the host's root for that,
# quiz-codespace-shadow@.timer). The isolation lives in the student
# containers' hardening.
ENV PORT=3100
# Healthy on a 200 from /healthz. Bash's /dev/tcp: no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${PORT:-3100} && printf 'GET /healthz HTTP/1.0\\r\\n\\r\\n' >&3 && head -n1 <&3 | grep -q ' 200 '"]
CMD ["node", "dist/server.js"]
