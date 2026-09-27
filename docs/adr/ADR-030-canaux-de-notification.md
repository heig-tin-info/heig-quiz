# ADR-030 — Notification channels: the bell, e-mail and Microsoft Teams

## Status

Accepted (2026-09-26, issue #144, with `apps/api/src/modules/notifications/`
(`service.ts`, `outbox.ts`, `jobs.ts`, `mailer.ts`, `teams.ts`,
`templates.ts`), the tables `notification_preferences` and `teams_links`, the
column `notifications.evaluation_id` (migration `0017_notification_channels`)
and the notification kind `results_released`). The e-mail half reuses the
mailer of heig-classroom (docs/spec/07, "Mailer").

Amended (2026-09-27): the Teams half of §4 is replaced by a bot the users
install themselves (`bot.ts`, `botAuth.ts`, `teamsLink.ts`, `teamsApp.ts`,
the table `teams_link_tokens`, migration `0022_teams_uploaded_app`). The
first design needed a tenant administrator's consent that HEIG-VD's IT will
not give; the paragraph "Why it was replaced" in §4 says what changed and
why.

## Context

The bell (F-POOL-05) tells an account what happened while it was away, but
only once the person opens the platform. F-GRADE-09 asks that the release of
the results *notifies* the students, and a student does not open the quiz
platform between two evaluations. Issue #144 asks that each user chooses,
per kind of notification, where it goes: the bell, their e-mail, Microsoft
Teams (which HEIG-VD uses daily).

Four constraints shape the answer. The platform already knows every
address (`users.email`, from edu-ID), so e-mail must need no setup. Teams
needs a Microsoft application that nobody has registered yet, so the channel
must exist in the code and stay off until someone does. A notification is
announced from a request — often inside a flow the teacher is waiting on —
and an external provider is slow and fails. And a notification that leaves
the platform must not carry content: invariant 4 guards question content,
and a grade is personal data.

## Decision

### 1. `notify` stays the one entry; external channels are jobs

`notify(db, userId, payload)` reads the recipient's preferences for the kind,
then:

- **bell**: writes the row and the refresh hint, as before — or writes
  NOTHING when the bell is off for that kind. A row the user asked not to see
  would still count in the badge, and the delivery jobs do not need it (see
  below), so "always write the row" buys nothing. `notify` now returns the
  row or `null`.
- **e-mail, Teams**: enqueues one job per channel on
  `notifications.deliver` (pg-boss in production, the in-process queue on
  PGlite; `retryLimit: 5`, exponential backoff). Nothing is ever sent inline.

`notify` is called with a database handle only — from routes, services and
jobs — so it cannot reach `app.boss`. The queue is handed over once at boot
through a small **outbox** (`outbox.ts`, opened by
`registerNotificationJobs`). While it is closed (the tests, `JOBS_DISABLED`,
a queue that failed to start) external deliveries are not made at all: the
bell stands alone and nothing falls back to sending in the request. An
enqueue that throws is logged and swallowed; the business action has
already happened.

A job carries `{ userId, channel, payload }` — the payload itself, ids and
titles only, the same object the bell stores. It does not point at the bell
row, because that row may not exist (bell off) or may have been read and
deleted. The consequence is written down: `notify` must be called after the
write it announces has committed, never inside a transaction, because a job
enqueued on pg-boss's own connection survives a rollback. Every call site
already does so.

### 2. The message is rendered when the job runs, in the recipient's language

`templates.ts` holds one typed dictionary for the server-side words, with
`fr: Record<keyof typeof en, string>` — the rule of the web app's `t()`, so a
missing French sentence is a compile error. The job reads `users.locale`
(English when unset), renders the subject, the text part, the HTML part and
the Teams message, and links to the page the bell opens (`WEB_URL`, which
defaults to `PUBLIC_URL`): `/attempts/<id>/feedback` for a result,
`/pools/<id>` for a pool. Every value that came from a user is HTML-escaped;
the subject is flattened to one line. The footer links to the settings page,
which is the one place to choose — there is no unsubscribe link and no
signed unsubscribe endpoint as in heig-classroom: these are transactional
messages about the user's own account, a handful per term.

### 3. E-mail: heig-classroom's mailer, unchanged in substance

Scaleway Transactional Email over HTTP, the provider heig-classroom already
has a verified sender domain on; the same variables (`SCW_SECRET_KEY`,
`SCW_DEFAULT_PROJECT_ID`, `MAIL_FROM`, `MAIL_FROM_NAME` = "HEIG Quiz",
`MAIL_REGION`) and the same **dry run**: without both credentials every
e-mail is logged (recipient and subject, never the body) and none is sent.
That is the state of development, of the tests and of staging, whose
accounts are a copy of production's (ADR-028) and must never be written to.
No user configuration: the address is `users.email`.

### 4. Teams: a bot the user installs, linked from its own chat

**Why it was replaced.** The first version linked an account by an OpenID
sign-in at Microsoft (to learn the tenant and object id), then, at the first
delivery, installed the Teams app for the user through Graph
(`TeamsAppInstallation.ReadWriteSelfForUser.All`, an APPLICATION permission)
and looked up the chat. That needs, in every users' tenant, an administrator
to consent to the permission and to publish the app in the organization's
catalog (`TEAMS_APP_ID`). HEIG-VD's IT will not do either. What a HEIG-VD user
CAN do is upload a custom app into their own Teams — verified by the product
owner. So the installation moves to the user, and with it the only moment the
bot learns about them: Teams tells the bot when its app is installed, from the
chat itself. The OAuth sign-in, the Graph calls, `TEAMS_APP_ID` and
`TEAMS_SERVICE_URL` are gone.

**The pieces.** One Entra application and one Azure Bot (F0) in a tenant we
control; the bot's messaging endpoint is
`POST /app/api/notifications/teams/messages`. The Teams app package is served
by the platform, generated from the configuration
(`GET /app/api/notifications/teams/app.zip`, public, deterministic: manifest
1.17, `id` = `botId` = `TEAMS_CLIENT_ID`, personal scope only, stored
entries with fixed dates through `fflate`). Its two icons are compiled into
the API as base64 constants (`teamsIcons.ts`, generated by
`apps/web/scripts/icons.mjs`): nothing is read from disk, so the `./assets`
volume mounted over `/app/assets` in production cannot hide them. The channel
exists when `TEAMS_CLIENT_ID` and `TEAMS_CLIENT_SECRET` are set;
`TEAMS_BOT_TENANT` names the tenant of a single-tenant bot and
`TEAMS_ALLOWED_TENANTS` the organizations whose accounts may be linked (below).
The setup is `docs/development/teams.md`.

**Linking.**

1. The user uploads the package in Teams (*Apps → Manage your apps → Upload
   an app → Upload a customised app*). Teams posts `installationUpdate`
   (`add`) and `conversationUpdate` (the bot among `membersAdded`) to the
   endpoint.
2. The bot answers in that personal chat with an Adaptive Card and ONE
   button, "Link to my Quiz account", opening
   `${WEB_URL}/teams/link?token=…`. The token is 32 random bytes; the table
   `teams_link_tokens` keeps its SHA-256 only (like `sessions.sid_hash`),
   with the chat's `conversation_id`, `service_url`, tenant, Entra object id
   and Teams display name, for fifteen minutes. A chat gets at most one new
   token a minute (serialized per chat by an advisory lock), so the two
   install events and a burst of messages cost one card and the bot never
   echoes. Expired tokens are pruned whenever a new one is made. A Teams
   account of a tenant outside `TEAMS_ALLOWED_TENANTS` gets no token, only a
   line saying the platform links HEIG-VD accounts only.
3. The page `/teams/link` (signed out: the ordinary login, `next=` back to the
   same URL) reads the pending link WITHOUT consuming it
   (`POST …/teams/link/preview {token}`) and asks one question: link the
   Teams account *X*, of the Microsoft 365 organization *T* (its tenant id),
   to the Quiz account *Y*? — with one line of warning, "only link a Teams
   account that is yours". **Link** is `POST …/teams/link {token}`, behind
   the session and its CSRF check, never a personal API token. It consumes
   the token with a conditional UPDATE — unspent, unexpired, of an allowed
   tenant: one predicate for the preview and the link — and writes the link
   in the same transaction, audits `teams.link`, and after the commit the bot
   confirms in the chat (best effort). The token travels to the API in a
   BODY, never in a path, and the page drops it from the address bar once
   spent. An unknown, expired or spent token is one state: "send any message
   to the bot for a new link".
4. Any later message in the chat: a new card if the chat is not linked, else
   one line saying which Quiz account it is linked to. `installationUpdate`
   `remove` deletes the link and audits `teams.unlink` with the linked
   account as actor, `{ via: "teams" }`. The bot's words are the server-side
   dictionary of §2, in the language of the Teams client (`fr*` → French).

`teams_links` is now `(user_id PK, tenant_id, aad_object_id, conversation_id
UNIQUE, service_url, teams_name, linked_at)`: one chat per account, one
account per chat. Linking a chat already linked elsewhere MOVES it (the old
link is deleted and audited `teams.unlink`, `{ via: "moved" }`); a new link
for an account replaces its previous chat. The migration drops and recreates
the table without moving data: production never had `TEAMS_APP_ID` set, so no
link was ever written.

**The public endpoint.** Microsoft authenticates each call with a JWT, and
the endpoint implements Microsoft's own checklist ("Authenticate requests
from the Bot Connector service to your bot"), with `jose`:

- in `onRequest`, BEFORE the body is read, the token — `Bearer`, RS256
  only, signed by a key of the JWKS named by
  `login.botframework.com/v1/.well-known/openidconfiguration` (jose's
  `createRemoteJWKSet`: keys cached a day, re-read at most every five minutes
  when a token names an unknown key — which is also what bounds the cost of a
  flood of forged tokens, so there is no separate rate limit), issuer
  `https://api.botframework.com`,
  audience `TEAMS_CLIENT_ID`, `exp`/`nbf` with Microsoft's five minutes of
  skew, and `msteams` among the key's `endorsements` when it has any (403).
  Any other failure is a 401; the token is never logged (`authorization` is
  redacted);
- then a body of at most 64 KB, parsed by `TeamsActivity` of
  `@quiz/contracts` — loose objects, since Microsoft adds fields — whose
  `serviceUrl` must equal the token's `serviceurl` claim (401) and be an
  allowed host (403);
- only `channelId` `msteams` and `conversationType` `personal` are acted
  upon; anything else is a 200 that does nothing, and so is a failure to
  answer in the chat (a retry by Microsoft would only answer twice).

**Which issuer.** Only `https://api.botframework.com`. The same Microsoft page
lists Entra issuers (`sts.windows.net/<tenant>/`,
`login.microsoftonline.com/<tenant>/v2.0`) for the Emulator path only; a
single-tenant bot changes the tenant of the tokens the bot REQUESTS from
Entra (`TEAMS_BOT_TENANT`), not the issuer of what Bot Connector sends it.
Accepting an Entra issuer would accept any token that tenant issues for our
audience, the Emulator's included, so it is refused.

**The serviceUrl allowlist.** The bot sends its Bot Connector token wherever
`serviceUrl` points, so that URL is checked at reception AND before every
send (`allowedServiceUrl`): `https`, default port, no credentials, query or
fragment, and the host `smba.trafficmanager.net` — the public-cloud Teams
service, whatever the regional path (`/amer/`, `/emea/`, `/apac/`, `/teams/`,
…). The government and sovereign clouds' hosts are left out on purpose.

**Consent phishing across tenants.** Anybody can upload the package into
their own Teams, in any tenant, and receive a genuine link card. Forwarded to
a HEIG-VD user who clicks it while signed in, it would link the STRANGER's chat
to the victim's Quiz account, and the victim's notifications (result
releases, pool names) would then flow to the stranger. Three defenses:
`TEAMS_ALLOWED_TENANTS` (production: HEIG-VD's tenant
`a372f724-c0b2-4ea0-abfb-0eb8c6f84e40`) — no token is minted for another
tenant, and the link is refused again at consumption, so a tenant removed
from the list cannot be linked with a token minted before; the confirmation
page names the Teams account AND its organization, and warns to link only
one's own; the notifications carry titles and ids, never a grade (§6). An
empty list admits every tenant: acceptable for a test bot, never in
production. Inside HEIG-VD a colleague could still bait a colleague; what
reaches the bait is the same as what an e-mail forwarding rule would leak,
and the victim sees the chat's name in their settings.

**Secrets in logs.** The request log masks every URL that carries one, from
ONE table (`redact.ts`): the SEB launch path, `/teams/link?token=…`, and a
`next=`/`returnTo=` pointing at either. `Authorization` headers are redacted
as before.

**Sending.** Unchanged in substance: a client-credentials token of the bot
for `https://api.botframework.com/.default` from `TEAMS_BOT_TENANT`, then
`POST {serviceUrl}/v3/conversations/{conversationId}/activities`, the stored
pair of the link (the `serviceUrl` is refreshed from each activity of a
linked chat). A 403 or 404 from Bot Connector means the bot was blocked or
the chat is gone: the delivery is logged and dropped, not retried, and the
link stays until the uninstall event or the user removes it. Any other
failure throws and pg-boss retries it as before.

### 5. Preferences: a sparse table, defaults in the contracts

`notification_preferences(user_id, kind, channel, enabled)`, primary key on
the three first columns, holding only the toggles a user actually moved. A
missing row is `DEFAULT_CHANNEL_ENABLED` of `@quiz/contracts`: bell on, e-mail
on, Teams on — which only takes effect once the account is linked, so
"linking Teams" is the whole opt-in. A table rather than a jsonb column on
`users`: the `notifications` module owns it (a module never writes another's
table, and `users` is `auth`'s), a toggle is an upsert of one row with no
read-modify-write race, and a kind added later reaches everyone without a
backfill. The grid is served resolved (`NotificationMatrix`, every kind ×
every channel); the settings show a student only the kinds a student
receives (`notificationKindsFor`).

### 6. `results_released`

On the FIRST release only (`released_at` was null), `releaseResults` calls
`notify` for every student of the frozen snapshot who has an attempt — an
absent student has no feedback page to open. A re-release keeps the original
date and tells nobody again. The payload is
`{ evaluationId, evaluationTitle, attemptId }`: no grade, no points. The row
also fills `notifications.evaluation_id`, a foreign key that cascades like
`pool_id` does, and withdrawing a release deletes those bells (their page
would show nothing); an e-mail already sent cannot be taken back, and is not
pretended to be.

## Consequences

- A released evaluation now reaches its students where they are, which
  F-GRADE-09 asked for since the first spec.
- A slow or failing provider costs a retried job and a log line, never a
  failed request. A job that fails five times is left in pg-boss's failed
  state, visible in the database.
- Deliveries depend on the job queue: under `JOBS_DISABLED=1` or with a
  queue that failed to start, only the bell works. That is deliberate.
- The Teams channel is tested against a stand-in Bot Framework (a local key
  served through the real metadata URLs) and a stubbed Bot Connector, not a
  live tenant; the first real check is the one of `docs/development/teams.md`.
- No tenant administrator is involved; a tenant whose policy forbids custom
  apps cannot use the channel, and its users keep the bell and e-mail.
- Every user installs the app once, and a new manifest version reaches them
  as an update Teams offers. The package holds no secret.
- The platform now exposes an endpoint without a session. Its whole
  defense is the token check above, the body limit, the host allowlist and
  the tenant allowlist; a bug there is the one way in, which is why each check is
  tested on its own.
- A multi-tenant bot registration is being retired by Microsoft for new Azure
  Bot resources; `TEAMS_BOT_TENANT` lets the same code run a single-tenant bot
  (the home tenant id), which still reaches users of other tenants once they
  have installed the app.

### Rollback

Unset the `SCW_*` variables (e-mails go back to the log) or the `TEAMS_*`
ones (the channel disappears from the settings, the bot's routes answer 404,
and Microsoft's calls fail until the Azure Bot's messaging endpoint is
cleared or the bot deleted); no data has to move. Migration `0017` only adds
tables and a nullable column. Migration `0022` drops and recreates
`teams_links` and adds `teams_link_tokens`: going back to the Graph design
would need its own migration, and would lose the links made since, which
users can remake from the bot's chat.

## Alternatives considered

- **Always writing the bell row** and letting the bell preference hide it:
  a row the user never sees still counts, still needs filtering on every
  read, and the jobs do not need it. Rejected.
- **Sending e-mail inline** from `notify`: a release to a class of eighty
  becomes eighty HTTP calls inside the teacher's request. Rejected.
- **An incoming webhook per user** (the user pastes a Teams channel webhook
  URL): no Entra app needed, but Microsoft is retiring Office 365 connectors,
  it asks every student to create a Power Automate flow, and the URL is a
  bearer secret we would have to store. Rejected.
- **Delegated Graph messages** (`Chat.ReadWrite` as the user, a stored
  refresh token): the message would come from the user to themselves, and we
  would keep a long-lived Microsoft credential per account. Rejected.
- **Keeping the OpenID sign-in, and asking each user to install the app
  themselves** (only Graph dropped): the sign-in proves the Entra identity,
  but not which chat is theirs — the bot learns the chat only from Teams'
  own events, and those already carry the tenant and object id. One flow
  instead of two. Rejected.
- **A link code typed in the chat** instead of a link to click: works without
  a browser round trip, but a code short enough to type is short enough to
  guess, and the page-with-a-session is the step that proves the Quiz
  account anyway. Rejected.
- **A jsonb column of preferences on `users`** (heig-classroom's
  `email_prefs`): written by the `notifications` module into `auth`'s table,
  and one channel only. Rejected.
