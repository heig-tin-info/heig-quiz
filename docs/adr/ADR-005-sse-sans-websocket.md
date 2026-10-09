# ADR-005 — SSE rather than WebSocket, without `Last-Event-ID` replay

## Status

Accepted (2026-07-03, phase 3). Amended 2026-09-22: decision 1's path is
`GET /app/api/events` in this repository, the whole SPA API living under
`/app/api`; the `/app/events` alias this record was written against was
mounted by WP5 and removed once no client opened it. Nothing else of the
decision changes. The inherited `/api/v1` separation in decision 1 was later
rejected by [ADR-022](ADR-022-jetons-api-et-serveur-mcp.md): tokens share
`/app/api`, this stream included: it is guarded by `requireSession`, which a
personal API token satisfies (its connection has no session id); an OAuth
token is confined to the MCP route and cannot open it.
[ADR-065](ADR-065-reconnection-overlay.md) adds connection recovery and graceful
restart signaling without reloading student work.

Amended 2026-10-09: decision 4's fallback is a 60 s refetch while watching, and a reopen after 30 s without a `clock` frame, as the client does; it said a 30 s refetch.

## Context

The portal pushes CI statuses, grades and notifications in real time (GR-10, NT-01). The
stream is strictly one-way, server to browser: the upstream channel already exists (REST).
No functional requirement depends on real time — it is a display comfort.

## Decision

1. **Server-Sent Events** on `GET /app/api/events` (formerly `/app/events`; see Status).
   It needs an authenticated caller: a session cookie, or a personal API token (ADR-022).
2. Authorization filtering on the server side: a student only receives the events of their
   own repositories (AU-26).
3. **No `Last-Event-ID` replay** and no ring buffer: on (re)connection the front end replays
   its TanStack Query requests — there is no resume state to maintain on the server.
4. A `:ping` heartbeat every 25 s; `flush_interval -1` on the route in Caddy.
   Degradation: a client that watches a live subject refetches its query every
   60 s whatever the stream says (`SAFETY_REFETCH_MS`), and closes and reopens
   a stream that sent no `clock` frame for 30 s (`SILENCE_MS`,
   `apps/web/src/realtime/useEventStream.ts`).

## Consequences

- Plain HTTP: cookies reused as-is, native `EventSource` reconnection, testable with `curl`,
  no dedicated client or server library.
- Losing an SSE event is never losing data: the truth is in the database and the refetch
  brings it back.
- About 200 simultaneous connections at most: trivial for a single Node process. Should a
  `WORKER_MODE` split happen (ADR-001), the internal relay goes through Postgres
  `LISTEN/NOTIFY`.

## Rejected alternatives

1. **WebSocket**: it would only bring useless bidirectionality, a server library, ping-pong
   handling and dedicated authentication — operational code for nothing.
2. **SSE with `Last-Event-ID` replay and a ring buffer** (productivity and robustness
   proposals): finer, but it introduces server state and a resynchronization path that can
   diverge from the refetch; the review kept the stateless variant, whose natural degradation
   is plain polling.
3. **Pure polling**: functional, but it degrades perceived responsiveness (NFR-12 targets
   under 2 min between the end of a run and a visible grade) and multiplies useless requests.
