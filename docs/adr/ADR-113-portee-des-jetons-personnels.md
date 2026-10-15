# ADR-113 — Scopes of personal API tokens: MCP by default, the whole API only when asked for and always expiring

## Status

Accepted (2026-10-15, issue #871: the scope set, the default and the fate
of existing tokens decided by the product owner on 2026-10-15; the
enforcement point, the error and the tool declaration are the spec
challenge's defaults, adopted).

Scope: what a bearer token may reach on `/app/api/*` — the personal token
(`quiz_pat_`) chiefly; the OAuth access token (`quiz_oat_`) through the
same check, its reach unchanged.

Relations: amends [ADR-022 §A](ADR-022-jetons-api-et-serveur-mcp.md#a-personal-api-tokens)
("There is no scope"), the parenthesis of its L6 amendment and its
rejected alternative "Scoped tokens"; amends
[ADR-023 §C](ADR-023-serveur-oauth-pour-mcp.md#c-audience-binding) and its
consequence "No scopes beyond `quiz`"; leaves the help assistant's token of
[ADR-080 §8](ADR-080-assistant-enseignant.md#8-p2-read-tools) under its own
audience rule; adds N-SEC-22 to
[03 §3.3](../spec/03-exigences-non-fonctionnelles.md).

## Context

A personal token resolves to its owner and, once resolved in the bearer
branch of the authentication hook (`auth/plugin.ts`), is accepted on every
`/app/api/*` route with the owner's rights: the staff routes the MCP tools
never call included — grading, release of results, CSV exports, the
roster, students' answers, deletions. Few routes refuse it: credential
management (`session_required`), Super Powers, the project routes kept to
a portal session (ADR-022 addendum of 2026-10-13), and the administration
routes when it never expires (L6). A token pasted
into an MCP client to "write a quiz" can therefore be replayed with `curl`
to read every grade of every classroom its owner teaches.

The documents promise less than that. The guide's table
(`docs/guide/assistants.md`, "What an assistant can and cannot do") says an
assistant cannot grade, release, read students' answers or grades, or
delete; ADR-080 §8 (P2 item 1) says the personal tokens given to MCP
clients "never gain" the results reader. Both are true of the MCP tools,
not of the token that drives them.

The OAuth access token is already narrow: bound by its audience to the MCP
endpoint and to the in-process calls of its tools (ADR-023 §C), granted the
one scope `quiz`. The help assistant's token is narrower still: in-process
calls only (ADR-080 §8). The MCP tools re-enter the API through
`app.inject` with the caller's own `Authorization` header
(`modules/mcp/service.ts`, `injectedApi`), so a rule enforced where a token
is resolved holds inside every tool too.

The 31 tools of the catalogue (`modules/mcp/tools.ts`) split into 16
reading tools (`readOnlyHint: true`) and 15 writing ones. Issue #871 asked
for a small closed set of scopes chosen at creation and for the tools to
declare what they need.

## Decision

### 1. Three scopes, a closed set, in the OAuth vocabulary

| Scope | Reaches | Lifetime | Shown as |
| --- | --- | --- | --- |
| `quiz` (the default) | the MCP endpoint and every tool of its catalogue | 30, 90, 365 days, or never (a teacher's) | MCP, read and write |
| `quiz:read` | the MCP endpoint and its reading tools only | the same | MCP, read only |
| `api` | the whole `/app/api` with the owner's rights, the MCP endpoint included — for scripts and the planned `cli` | 30, 90 or 365 days, **never "never"** | Full API |

The scopes are ordered, `quiz:read` ⊂ `quiz` ⊂ `api`, and the set is closed:
one union in `@quiz/contracts` (`TOKEN_SCOPES`), one CHECK in the database.
A token's scope is chosen at its creation and never edited: to change it,
create another token and revoke the first. A secret already handed to a
client never gains reach without its holder minting a new one. An
administrator's token still always expires (ADR-022 L6 amendment), whatever
its scope.

A scope narrows the routes a token reaches, never the rights inside them:
within its reach a token acts as its owner, with the owner's current seats
(ADR-022 §A), through the routes' own loaders (invariant 6). There is no
scope per course, per pool or per route.

### 2. Enforced where the token is resolved, never in the tools

The rule lives in the bearer branch of the `preHandler` of `auth/plugin.ts`,
right after the audience check, and nowhere else:

- **`api`**: every `/app/api/*` route, as a personal token did before this
  record.
- **`quiz`**: `MCP_PATH`, and an in-process call carrying the boot-time
  internal secret (`INTERNAL_CALL_HEADER`) — the calls of its tools.
- **`quiz:read`**: `MCP_PATH`, whose `POST` is the JSON-RPC envelope, and an
  in-process call with a safe method only (`GET`, `HEAD`, `OPTIONS`, the
  list ADR-034's read-only gate uses).

Anything else is refused `403 insufficient_scope` (RFC 6750 §3.1), with
`WWW-Authenticate: Bearer error="insufficient_scope", scope="<the scope that
would do>"`, before the route's handler runs and so before anything is
loaded. The refusal depends on the credential, the path class and the
method, never on an entity: it says nothing about whether one exists, so
the 404 of invariant 6 is unaffected — like `impersonation_read_only`.

The order is fixed: the audience rule of ADR-023 §C first, then the scope.
So an **OAuth access token keeps its `401`** outside the MCP endpoint and
its tools' calls: there it is not a credential at all (the request is
anonymous), and the `401` with `resource_metadata` is what a host follows to
sign in again. A personal token is a credential everywhere on `/app/api`;
outside its scope it is a known caller asking for too much, hence `403`.

The help assistant's token (`quiz_ast_`) has no scope and keeps its own
audience rule unchanged (ADR-080 §8): in-process calls only, never the MCP
endpoint.

### 3. One effective scope per token

`findTokenUser` returns the token's effective scope, one value the hook
reads:

- a personal token: its row's `scope`;
- an OAuth access token: its grant's `scope` (`oauth_grants.scope`, read
  with the token), mapped to the narrowest token scope it names — `quiz` in
  this version, since the consent grants `quiz` (with `offline_access`)
  and nothing else. OAuth never yields `api`;
- the help assistant's token: none (its audience rule alone).

The OAuth flow is unchanged in this version: consent, `scopes_supported`
and the tools' `securitySchemes` still say `quiz`. Offering `quiz:read` at
consent is left for later; it would be one more value of the grant and no
new check.

### 4. Each tool declares its scope

`Tool` (`modules/mcp/tools.ts`) gains a required field
`scope: "quiz" | "quiz:read"`; a tool without it is a compile error,
the help assistant's own reader (`get_classroom_results`) included. A test
asserts, for every tool, `annotations.readOnlyHint === (scope === "quiz:read")`,
and that a `quiz:read` token runs every reading tool without one refusal —
the reading tools issue `GET`s only.

The declaration serves the client, not the security: `tools/list` lists only
the tools the caller's scope covers, and `tools/call` of a tool above it
answers a tool error naming `insufficient_scope` without running it. Were
either wrong, the hook of §2 would still refuse the tool's first write.

### 5. Storage, contracts and audit

- `api_tokens.scope`, `text`, nullable, no default. Two CHECKs: the value is
  one of the three; and `(audience IS NULL) = (scope IS NOT NULL)` — every
  personal token names its scope, no audience-bound token (OAuth, help
  assistant) carries one. No row can mean "full" by omission.
- `ApiTokenCreate` gains `scope`, defaulting to `quiz` in the contract (the
  product default; the database has none, so every insert names it).
  `ApiToken` gains `scope`. `POST /app/api/me/tokens` refuses an `api`
  token with no lifetime `422 token_expiry_required`, the code the
  administrator's rule already uses.
- The audit entry `api_token.create` records the scope in its payload. The
  union of actions is unchanged.

### 6. Existing personal tokens become `api`, explicitly

The migration that adds the column sets `scope = 'api'` on every row with
neither `audience` nor `grant_id` — personal tokens only; an OAuth or
help-assistant row is never touched — then adds the CHECKs. Such a token
keeps the reach it had until it expires or is revoked: there is no forced
sunset. One created with no lifetime stays endless; "always expires" binds
the creation of an `api` token, not the tokens issued before this record.
The settings list it as "Full API", like any `api` token.

### 7. The settings screen

`ApiTokensCard` (`apps/web/src/ApiTokensCard.tsx`):

- the creation dialog gains an **Access** choice of three rows, `quiz`
  preselected, each with one line saying what it reaches; with `api`
  chosen, "Never" is not offered and a line says why;
- the one-time reveal shows the MCP address and the Claude Code line for
  `quiz` and `quiz:read`, and a `curl` line with the header for `api`;
- the list shows each token's access;
- no control edits a token's scope.

## Consequences

- A token made with the default reaches what the MCP catalogue does and
  nothing else: the guide's "cannot" column and ADR-080 §8's promise become
  true of `quiz` and `quiz:read` tokens. They stay false of `api` tokens —
  every token issued before this record, and the new ones made for a
  script — and the documents must say so (`docs/guide/assistants.md`,
  `docs/guide/data-protection.md`, phase 2 of #871).
- A script using a token created after this record must ask for `api`, and
  renew it at least every year. Existing scripts keep working.
- **Rollback window.** An image older than this record ignores the column:
  during a rollback every `quiz` and `quiz:read` token reaches the whole API
  again, until the newer image is back. Accepted: a rollback is short, and
  the widening is to what every token had until now. The same old image
  cannot create a token (its insert names no scope and fails the CHECK) —
  closed, not open.
- A `403 insufficient_scope` tells its holder that the token is valid. Only
  the holder sees it, and the MCP endpoint already tells them as much.
- The tests that drive REST routes with a personal token create it with
  `scope: "api"`.
- **Stale claim, corrected.** ADR-022's L6 amendment keeps tokens on the
  administration routes because "the MCP tools depend on them". No tool
  calls an administration route on `main` (2026-10-15), nor did one in the
  history of `modules/mcp/tools.ts`; the rule it states (an endless token is
  refused there) stands on its own and is unchanged.

## Alternatives considered

- **Scopes by content** (read content, write content, read classrooms), as
  the issue first suggested. Each of several hundred routes would need a
  scope: a second access matrix beside the loaders, the duplication
  invariant 6 exists to prevent. The MCP catalogue is already a curated,
  tested boundary; scoping to it costs one rule.
- **Enforcement in the tools, or in the MCP route.** A token is not obliged
  to go through a tool: it can call the REST route directly. Only the place
  where a token becomes a user sees every request.
- **`null` meaning "full"** for the existing tokens. A row written without a
  scope — an old image, a forgotten insert — would silently get the widest
  reach. An explicit `api` costs one `UPDATE`.
- **An audience instead of a scope** (`audience = MCP resource` on a
  personal token). The audience is the RFC 8707 binding of an OAuth token
  and the marker of a personal token in the listing and revocation filters;
  `quiz:read` is not a resource, and `api` would need a second meaning of
  `null`.
- **A forced sunset of the existing tokens.** Rejected by the product
  owner: they expire or are revoked as before.
- **A `401` for a personal token outside its scope**, as for OAuth. A script
  author would read "bad token" and regenerate it; `insufficient_scope` says
  what to change.
