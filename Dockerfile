# quiz -- single image: API + built SPA.
# Build:   docker build -t quiz .
# ADR-009: one application container, with PostgreSQL and Caddy alongside.

FROM node:24-slim AS build
RUN corepack enable pnpm
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/domain/package.json packages/domain/
COPY packages/registry/package.json packages/registry/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ui/package.json packages/ui/
COPY packages/qt-code/package.json packages/qt-code/
COPY packages/qt-mcq/package.json packages/qt-mcq/
COPY packages/qt-short/package.json packages/qt-short/
COPY packages/qt-cloze/package.json packages/qt-cloze/
COPY packages/qt-circuit/package.json packages/qt-circuit/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web ./apps/web
# Small production VM: let Node spill into swap instead of aborting (exit 134),
# and keep the workspace build sequential.
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN pnpm --workspace-concurrency=1 build
# Self-contained production tree for the API (pruned node_modules + workspaces)
RUN pnpm --filter @quiz/api deploy --prod --legacy /out \
  && cp -r apps/api/drizzle /out/drizzle \
  && cp -r apps/web/dist /out/web

FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER node
ENV STATIC_DIR=/app/web MIGRATE_ON_START=1 PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -sf http://localhost:3000/healthz || exit 1
CMD ["node", "dist/server.js"]
