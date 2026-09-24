# ADR-022 — Personal API tokens, and an MCP server that is one more client of the API

## Status

Accepted (2026-09-23, asked for by the product owner: "connect Claude or
OpenAI to the portal and have it write a quiz"). It brings forward two items
the specification had placed later — the personal tokens of docs/08 §8.3
(phase 2) and the MCP server of F-LLM-06 (phase 3) — and settles how they are
built.

## Context

A teacher wants to ask an assistant — Claude Desktop, Claude Code, ChatGPT,
the OpenAI Responses API — something like *"make me a ten-question general
culture quiz in French, university level, vary the question types; create a
pool if there is none and an exercise for the class Français 2026"*, and find
the result in the portal.

The Model Context Protocol is how those clients call tools on a remote
server. Two things were missing: a credential a program can hold (the API
only knew browser sessions with double-submit CSRF), and the tools
themselves.

The specification already says what the tools must be: "an MCP server
exposing the same operations as the API" (docs/05 §5.2), and "everything the
UI does, the API does" (docs/08 §8.1, principle 4).

## Decision

### A. Personal API tokens

- Table `api_tokens` (auth module): `token_hash` (SHA-256), `prefix` (the
  first 15 characters, for the list), `name`, `expires_at` (30, 90, 365 days
  or never; 90 by default), `last_used_at` (refreshed at most once a minute),
  `revoked_at` (revocation stamps, it does not delete). The plaintext
  `quiz_pat_<43 base64url chars>` is returned once, by the creation.
- `Authorization: Bearer quiz_pat_…` is read on `/app/api/*` only. When the
  header is present it is the whole credential: an unknown, revoked or
  expired token is anonymous, and a session cookie riding along is ignored.
- A token resolves to its owner's `users` row on every request, so the role,
  the staff seats and the pool memberships it acts under are the owner's
  current ones. There is no scope: a token can do what its owner can do
  through the API.
- A token-authenticated request is exempt from the double-submit CSRF check:
  a browser never attaches a bearer header on its own, which is the attack
  CSRF defends against.
- `/app/api/me/tokens` (list, create, revoke) is teacher-only and refuses a
  token-authenticated caller (`403 session_required`): a leaked token cannot
  mint its own replacement or revoke the others. Managing tokens takes a
  browser session, therefore edu-ID.
- The audit log records a write made through a token with
  `actor_type = 'api_key'` — the value the inherited schema already reserved.
  `api_token.create` and `api_token.revoke` join the closed union.

### B. The MCP server is a client of `/app/api`, in process

`POST /app/api/mcp` speaks MCP over the Streamable HTTP transport, stateless,
answering in `application/json` (no SSE stream, no `Mcp-Session-Id`; `GET`
is `405`, which the transport allows). It accepts a bearer token only — a
browser session gets `401` — and a teacher or admin only.

Each tool is a few lines that call the existing routes through
`app.inject()`, carrying the caller's own `Authorization` header. So every
guarantee of those routes holds unchanged: the access loaders (invariant 6 —
another teacher's pool is a `404` through the tool too), the contract
validation (invariant 7), the audit entries, the SSE refresh hints that make
an open browser tab show the new question at once. Nothing in `modules/mcp`
touches the database.

The protocol layer is written by hand (`modules/mcp/protocol.ts`, four
methods: `initialize`, `ping`, `tools/list`, `tools/call`), not taken from
`@modelcontextprotocol/sdk`: the SDK's transport wants to own the HTTP
response, which Fastify already owns, and what is needed is a hundred lines of
JSON-RPC. Tool input schemas are zod, composed from `@quiz/contracts`, and
converted with `z.toJSONSchema`.

### C. What the tools are, and what they are not

Reading: `list_courses`, `get_course`, `list_pools`, `get_pool`,
`list_questions`, `get_question`, `list_evaluations`, `get_evaluation`,
`describe_question_types`.

Writing: `create_course`, `create_classroom`, `create_pool`,
`link_pool_to_course`, `create_category`, `create_question`,
`update_question`, `create_evaluation`, `add_questions_to_evaluation`,
`update_evaluation`, `create_poll`.

- `describe_question_types` hands the model the JSON Schema of the type's
  `configSchema` — generated, so it cannot drift from the publication gate —
  with authoring rules and a valid example (`modules/mcp/questionTypes.ts`).
  A test asserts that every example passes the gate.
- `create_question` validates the config with that same gate BEFORE creating
  anything, so a malformed config costs one round trip and leaves no
  half-written question. It then creates, saves the draft and publishes.
- `create_evaluation` creates a `draft` and adds its items. It never opens,
  schedules or starts anything.
- **No deletion, and no transition of a live evaluation** (start, pause,
  close, grade, release) is exposed. A model prepares work; a teacher runs it.
  The one exception is `create_poll`, which starts a poll because that is
  what creating a poll is (F-LIVE-13); its description tells the model to
  call it only when the teacher wants to poll now.
- Every write returns the web app's `url` of what it made, so the assistant
  can hand the teacher a link.

## Consequences

- Claude Code connects with
  `claude mcp add --transport http quiz https://<host>/app/api/mcp --header "Authorization: Bearer quiz_pat_…"`;
  the OpenAI Responses API with an `mcp` tool and the same header; Claude
  Desktop and any stdio-only client through `mcp-remote`. The settings screen
  shows the address and the Claude Code line next to the token, once.
- The claude.ai and ChatGPT **web** connectors require OAuth 2.1. This ADR
  does not provide it; ADR-023 does, as an authorization server in front of
  the same tokens — the tools did not change.
- The public `/api/v1` surface of D18 is still not there. Bearer tokens work
  on `/app/api/*`, which is the surface D18 said they would alias.
- An LLM author can create as much as its owner can. The audit log's
  `api_key` rows are how to tell afterwards what an assistant did.
- F-LLM-04 (anonymisation of what is sent to a provider) is not engaged: the
  platform sends nothing to a provider; the teacher's own client reads what
  its owner can read. The tools expose no student data beyond what
  `get_course` (staff names) and `get_evaluation` return.

## Rejected alternatives

- **A separate stdio MCP package (`packages/mcp`) calling the HTTP API.**
  Needs Node on the teacher's machine and a published package, and cannot be
  used by a remote client (the OpenAI API, claude.ai) at all. The in-process
  endpoint serves both, and stdio clients bridge with `mcp-remote`.
- **Tools calling the services directly.** Faster by a few milliseconds, and
  a second copy of every route's access check, audit line and refresh hint —
  the exact duplication invariant 6 exists to prevent.
- **Accepting the session cookie on `/app/api/mcp`.** Nothing in a browser
  should speak MCP, and a cookie is the credential a cross-site request
  carries without asking.
- **Scoped tokens (read-only, pools-only).** No consumer asked for it yet; a
  scope column can be added without breaking a token already issued.
