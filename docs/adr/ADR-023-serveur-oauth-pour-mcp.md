# ADR-023 — The portal is its own OAuth 2.1 server, so claude.ai and ChatGPT can sign in

## Status

Accepted (2026-09-23, asked for by the product owner the same day as
ADR-022: "I want Claude to connect through claude.ai or chat.openai"). It
completes ADR-022, whose MCP endpoint only took a personal token pasted into
a header.

## Context

claude.ai (web, desktop, mobile) and ChatGPT connect to a remote MCP server
only through OAuth: the user pastes an address, the host discovers an
authorization server, the user signs in and consents, and the host holds a
token it refreshes by itself. A header with a static token is not offered to
an individual user on either platform.

What the two platforms require, from their documentation (2026-09):

- The 401 of the MCP endpoint carries
  `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728), which points
  at the protected resource metadata, whose `authorization_servers` points
  at the RFC 8414 metadata of the authorization server.
- Authorization code with PKCE, `S256` only, advertised in
  `code_challenge_methods_supported`. Public clients (`none`).
- The client identifies itself either by Dynamic Client Registration
  (RFC 7591), or by a Client ID Metadata Document (CIMD: the `client_id` is
  the https URL of a JSON document). ChatGPT prefers CIMD
  (`https://chatgpt.com/oauth/client.json`), and so does Claude Code
  (`https://claude.ai/oauth/claude-code-client-metadata`). Claude uses CIMD
  only when the metadata advertises both
  `client_id_metadata_document_supported` and `none`.
- `resource` (RFC 8707) on both requests; the server binds the token to it.
- RFC 9207 `iss` on the authorization response gives ChatGPT a stable
  redirect URI.
- `/token` accepts `application/x-www-form-urlencoded`; refresh tokens of a
  public client rotate; a dead refresh token answers `invalid_grant`.
- Redirects: `https://claude.ai/api/mcp/auth_callback`,
  `https://chatgpt.com/connector/oauth/{id}` or
  `https://chatgpt.com/connector_platform_oauth_redirect`, and loopback
  addresses on any port for Claude Code.

edu-ID cannot be this authorization server: it registers no client on the
fly and issues no token for our resource. It stays what it is — how a
teacher signs in to the portal.

## Decision

### A. The portal is the authorization server, issuer `PUBLIC_URL`

| Endpoint | Standard |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` and `…/app/api/mcp` | RFC 9728 |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 |
| `POST /app/oauth/register` | RFC 7591, public clients only, 30 per address per hour |
| `GET /app/oauth/authorize` | code + PKCE S256, `resource`, `iss` in the answer |
| `POST /app/oauth/token` | `authorization_code`, `refresh_token` |

Written by hand in `apps/api/src/auth/oauth/` (a few hundred lines, one flow,
one kind of client), not with `oidc-provider`: its OpenID Connect,
its JWT access tokens, its session and its Koa adapter would all be surface
this platform does not use.

### B. Everything is stored hashed, and access tokens are `api_tokens` rows

- `oauth_clients`: a registered client (`dcr`, id ours) or a CIMD client (id
  = the document URL, the document cached for a day).
- `oauth_requests`: a pending authorization, 10 minutes; once approved it
  holds the code (SHA-256, 60 seconds, one use, bound to the client, the
  exact redirect URI, the PKCE challenge and the resource).
- `oauth_grants`: what the teacher allowed — one client acting for them. It
  holds the refresh token (SHA-256), rotated on every use, and the previous
  one so a replay is recognised; 90 days from the last use.
- An access token is an `api_tokens` row with `grant_id` and `audience`
  (prefix `quiz_oat_`, one hour). The bearer path of ADR-022 resolves it like
  any token, so the owner's current role and seats apply.

### C. Audience binding

A token whose `audience` is set is accepted on `/app/api/mcp` only. The MCP
tools forward to the ordinary routes with `app.inject` (ADR-022); those
internal calls carry `x-quiz-internal-call` with a secret drawn at boot,
compared in constant time, and that is the only other way the token is
accepted. Called directly on `/app/api/courses`, an OAuth token is a 401.

### D. The consent page is the SPA

`/app/oauth/authorize` validates the client and the redirect URI, stores the
request and redirects to `/oauth/authorize/:id`, a full-screen SPA page, so
every word of it goes through `t()` (invariant 1). Signed out, it offers the
edu-ID sign-in with a `next` back to itself. It shows who asks, the account,
what the assistant can and cannot do, and the host the answer goes to, with a
warning when every redirect is a loopback address (the MCP specification
asks for both). Allow and deny go through `POST
/app/api/oauth/requests/:id/decision`, which takes a browser session: like
token management, consent is refused to a token-authenticated caller.

A request whose client or redirect URI cannot be trusted is never sent back
to that redirect URI: the browser lands on `/oauth/authorize/invalid?reason=`.
Every later error goes back to the client with `error`, `state` and `iss`.

### E. CIMD only from known hosts

A CIMD `client_id` makes the server fetch a URL. To keep that from being a
request forgery any visitor can trigger, documents are fetched only from the
hosts of `OAUTH_CIMD_HOSTS` (default `claude.ai,claude.com,chatgpt.com`),
over https on 443, without following redirects, within 5 seconds and 64 KB.
Any other client registers itself (DCR).

### F. Settings

"Connected assistants" lists the grants (client, redirect host, dates) above
the personal tokens, with the MCP address to copy and a Disconnect action
that revokes the grant and every access token it issued. Personal tokens
stay, for scripts and for clients that cannot do OAuth.

## Consequences

- In claude.ai: *Settings → Connectors → Add custom connector*, address
  `https://quiz.chevallier.io/app/api/mcp`, then sign in and allow. In
  ChatGPT: a connector in developer mode, same address. Claude Code:
  `claude mcp add --transport http quiz https://quiz.chevallier.io/app/api/mcp`
  and `/mcp` to sign in.
- The ticker purges spent requests, expired access tokens, grants dead for a
  month, and self-registered clients that never got a grant (Claude registers
  a client per fresh connection).
- CORS is not served: the hosts above call from their servers. A browser-based
  inspector would need it.
- No scopes beyond `quiz`: the consent is all or nothing, like the token.

## Rejected alternatives

- **edu-ID as the authorization server.** No dynamic client, no audience of
  ours; it would also make every token a federated identity token.
- **A hosted identity broker (Auth0, WorkOS, Stytch).** A third party in the
  login path of an institutional platform, for a flow of a few hundred lines.
- **A server-rendered consent page.** Out of the i18n dictionary, out of the
  design system, and a second rendering stack to keep.
- **Fetching any CIMD URL.** The server would fetch whatever a stranger names;
  the allowlist costs nothing to the two platforms that matter.
