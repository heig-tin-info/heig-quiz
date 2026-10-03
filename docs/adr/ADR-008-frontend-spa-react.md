# ADR-008 — React + Vite SPA front end, accessible headless components, no SSR

## Status

Accepted (2026-07-03, inherited from heig-classroom). React/Vite SPA remains
the choice; the [inherited record](history/ADR-008-frontend-spa-react.md)'s frontend library list was not carried into Quiz
as a package requirement. Current implementation is evidenced below.

## Context

An authenticated teaching application needs no SEO or server rendering.
Static frontend assets keep deployment simple; accessibility and translated
teacher/student surfaces remain requirements (spec 03, `apps/web/DESIGN.md`).

## Decision

1. A React SPA built by Vite, served with the API. Versions live in
   `apps/web/package.json` and `pnpm-lock.yaml`.
2. TanStack Query owns server-state caching and invalidation. Quiz's typed
   history router is `apps/web/src/router.ts`; table and accessible UI
   primitives are in `apps/web/src/ui/`. TanStack Router/Table and Radix
   from the inherited shortlist are not installed frontend foundations.
3. Typed flat dictionaries in `apps/web/src/i18n/` own English/French UI
   strings; date formatting lives in `ui/dates.tsx`. Quiz does not use the
   inherited i18next/Luxon proposal. The same contract schemas are shared
   through `packages/contracts`.
4. SSE invalidates reads or carries the authorized live events of spec 05
   §5.4. Reconnection uses snapshots/refetch; preserve mounted student work
   as [ADR-065](ADR-065-reconnection-overlay.md) requires.

## Consequences

No separate frontend server. Frontend/API deploy together, but already-open
exam tabs still require compatibility. Accessibility must be verified in
our primitives/tests; it is not guaranteed by an uninstalled headless library.

## Rejected alternatives

SSR/Next.js adds a server without an application need. An extra monorepo
orchestrator is unnecessary alongside pnpm workspaces. The inherited rejection
of custom components described a proposal; use Quiz's existing primitives
and accessibility rules instead of introducing a second UI system.
