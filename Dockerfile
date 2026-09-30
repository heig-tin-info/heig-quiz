# quiz -- single image: API + built SPA.
# Build:   docker build -t quiz .
# ADR-009: one application container, with PostgreSQL and Caddy alongside.

FROM node:24-slim AS build
RUN corepack enable pnpm
WORKDIR /src
# The browser's WebAssembly runtimes (77 MB, ADR-015), in a layer of their own
# keyed on the script alone: its pinned digests ARE the cache key, so they are
# downloaded once, not on every commit. `--strict`: a failed download fails
# the image instead of shipping it without them. The web build below runs the
# script again, finds every file in place and downloads nothing.
COPY apps/web/scripts/fetch-runtimes.mjs apps/web/scripts/
RUN node apps/web/scripts/fetch-runtimes.mjs --strict
# Every dependency of the lockfile into the store, keyed on the lockfile only:
# no package.json is listed here, so a new workspace package needs no change
# to this file. The install below then links offline, for this image's
# projects only.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @quiz/api... --filter @quiz/web...
# The deployed commit, shown in the user menu (#179). The context has no .git.
ARG COMMIT_SHA
ARG COMMIT_DATE
RUN pnpm --filter @quiz/api... --filter @quiz/web... build
# Self-contained production tree for the API (pruned node_modules + workspaces)
RUN pnpm --filter @quiz/api deploy --prod --legacy /out \
  && cp -r apps/api/drizzle/. /out/drizzle \
  && cp -r apps/web/dist /out/web

FROM node:24-slim
# git: the GitHub adapters clone and push over HTTPS with an installation
# token (apps/api/src/github/git.ts, ADR-035); ca-certificates: the slim image
# has none, and git's TLS to github.com needs them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER node
ENV STATIC_DIR=/app/web MIGRATE_ON_START=1 PORT=3000
# The same commit for the API, which names it on the admin's system status
# (ADR-055). Last, so a new commit only rebuilds this metadata layer.
ARG COMMIT_SHA
ARG COMMIT_DATE
ENV COMMIT_SHA=${COMMIT_SHA} COMMIT_DATE=${COMMIT_DATE}
EXPOSE 3000
# Healthy on a 200 from /healthz (503 when the database is down), unhealthy on
# anything else or no answer. Bash's /dev/tcp rather than curl, so the image
# installs no package for it; and rather than `node -e fetch(...)`, whose
# ~60 MB process every 30 s would count against staging's 256 MB cap.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/${PORT:-3000} && printf 'GET /healthz HTTP/1.0\\r\\n\\r\\n' >&3 && head -n1 <&3 | grep -q ' 200 '"]
CMD ["node", "dist/server.js"]
