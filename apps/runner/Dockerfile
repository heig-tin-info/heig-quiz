# quiz-runner -- the code execution service.
#
# Build from the REPOSITORY ROOT:
#   docker build -f apps/runner/Dockerfile -t quiz-runner .
#
# This image contains no container engine of its own: it drives the HOST's
# rootful Podman through the socket the quadlet `deploy/quiz-runner.container`
# mounts, with `podman-remote --url unix:///run/podman/podman.sock`
# (invariant 13). The language images (`quiz-runner-c:latest` and friends)
# are built on the host with `apps/runner/images/build.sh` and live in the
# host's image store. Where it runs, and why on a VM of its own: ADR-016.
FROM node:24-slim AS build
RUN corepack enable pnpm
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/domain/package.json packages/domain/
COPY packages/registry/package.json packages/registry/
COPY packages/contracts/package.json packages/contracts/
COPY packages/qt-code/package.json packages/qt-code/
COPY packages/qt-mcq/package.json packages/qt-mcq/
COPY packages/qt-short/package.json packages/qt-short/
COPY packages/qt-cloze/package.json packages/qt-cloze/
COPY packages/qt-circuit/package.json packages/qt-circuit/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/runner/package.json apps/runner/
RUN pnpm install --frozen-lockfile --filter @quiz/runner...
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY apps/runner ./apps/runner
RUN pnpm --filter @quiz/core --filter @quiz/runner build \
  && pnpm --filter @quiz/runner deploy --prod --legacy /out \
  && cp -r apps/runner/infra /out/infra

FROM node:24-slim
# The Podman CLIENT only -- no conmon, no crun, no storage, no engine. It talks
# to the host's rootful service over the mounted socket. Debian ships no
# `podman-remote` package, so the static binary of the upstream release is
# pinned by version AND by checksum: this client is what drives the sandbox,
# and an unverified download of it would be the weakest link of the whole
# hardening.
#
# The version matches the engine of the runner VM (`podman --version` there:
# 5.7.0 on Ubuntu 26.04). Bump both together, or the client talks an API the
# service does not answer. The checksum is the `shasums` file of the release.
ARG PODMAN_VERSION=5.7.0
ARG PODMAN_SHA256=0d1759e3fc42b0e3a4496176dabc7b65f0f334a0ab2b22eaed7c36afeece8b0c
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL -o /tmp/podman-remote.tgz \
       "https://github.com/containers/podman/releases/download/v${PODMAN_VERSION}/podman-remote-static-linux_amd64.tar.gz" \
  && echo "${PODMAN_SHA256}  /tmp/podman-remote.tgz" | sha256sum -c - \
  && tar -xzf /tmp/podman-remote.tgz -C /tmp \
  && install -m 0755 /tmp/bin/podman-remote-static-linux_amd64 /usr/local/bin/podman-remote \
  && rm -rf /tmp/podman-remote.tgz /tmp/bin \
  && podman-remote --version
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# Runs as root ON PURPOSE: the mounted socket is root-owned, and reaching a
# rootful Podman socket is root-equivalent anyway -- a second user would add a
# permission dance, not a boundary. The containers it starts are the hardened
# ones, and that is where the isolation lives.
ENV PODMAN_BIN=podman-remote \
    PODMAN_SOCKET=/run/podman/podman.sock \
    RUNNER_USERNS_AUTO=true \
    PORT=3200
EXPOSE 3200
# The bearer is the one the routes check when RUNNER_TOKEN is set; without one
# the header is empty and ignored.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -sf -H "Authorization: Bearer ${RUNNER_TOKEN}" http://localhost:3200/health || exit 1
CMD ["node", "dist/server.js"]
