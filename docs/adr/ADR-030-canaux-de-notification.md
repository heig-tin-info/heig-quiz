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

Amended (2026-09-28): the bot is replaced by notifications in the Teams
ACTIVITY FEED, sent through Microsoft Graph with the resource-specific
permission `TeamsActivity.Send.User`, which each user grants by installing
the app — still no tenant administrator (`teams.ts` rewritten, `ssoAuth.ts`
replaces `bot.ts` and `botAuth.ts`, the tab `/teams`, migration
`0023_teams_graph_activity`, `TEAMS_BOT_TENANT` removed). The bot did not
work for the product owner; §4 is rewritten for the new design and says why.

Amended (2026-09-28, issue #198): one notification system for everything a
user is told. The App channel is the bell AND the toast, defaults are per
kind, and eight kinds are added for students and teachers. The decisions
are the addendum at the end. `DEFAULT_CHANNEL_ENABLED` became per kind in
the same change; the rest lands in the steps the addendum lists. Step 4 made the App
channel the bell and the toast, and moved `student_joined` and
`roster_conflict` into the catalogue (the column `notifications.classroom_id`
and the fold indexes, migration `0027_notification_folds`; Teams app 2.1.0);
§h records the decisions taken after the review.

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
the preview line of the Teams activity (§4), and links to the page the bell opens (`WEB_URL`, which
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

### 4. Teams: activity-feed notifications through Microsoft Graph

**Why, twice.** The first version (2026-09-26) installed a Teams app for
each user through Graph with an APPLICATION permission and posted in their
chat; it needed, in every users' tenant, an administrator's consent and an
app in the organization's catalog, which HEIG-VD's IT will not give. The
second (2026-09-27) moved the installation to the user — a custom app they
upload themselves — and delivered through a bot (Azure Bot, Bot Connector,
a messaging endpoint the bot's chat fed). That one did not work for the
product owner once tried in HEIG-VD's Teams, and it asked, besides, for
an Azure resource, a public messaging endpoint
and a second token scheme for one line per notification.

What Teams offers natively for "something happened" is the **activity feed**
(the bell of Teams), and Graph can post to it
(`POST /users/{id}/teamwork/sendActivityNotification`) with the permission
`TeamsActivity.Send.User`. That permission exists as a RESOURCE-SPECIFIC
one (RSC): declared in the Teams app's manifest, it is granted by the user
for their own account when they install the app — a "basic" RSC permission
that needs no administrator. The installation stays the user's (an uploaded
custom app, which HEIG-VD allows), and nothing else is asked of the tenant.

**The pieces.**

- One **multi-tenant Entra application** in a tenant we control; its client
  id is `TEAMS_CLIENT_ID`, one client secret `TEAMS_CLIENT_SECRET`. It
  exposes an API (`api://<host>/<clientId>`, scope `access_as_user`,
  pre-authorized for the two Teams clients) for the tab's SSO, and issues
  v2 access tokens (`api.requestedAccessTokenVersion: 2`). No Azure Bot any
  more. The setup is `docs/development/teams.md`.
- The **Teams app package**, generated and served by the platform
  (`GET /app/api/notifications/teams/app.zip`, public, deterministic; manifest
  1.17, `version` 2.0.0, `id` = `TEAMS_CLIENT_ID`): one personal static tab
  (`entityId` `home`, `contentUrl` `${PUBLIC_URL}/teams`), `webApplicationInfo`
  (`id` = the client id, `resource` = `api://<host>/<clientId>`), the RSC
  permission `TeamsActivity.Send.User` (type `Application`), ONE activity type
  per notification kind (`resultsReleased`, `poolShared`, `poolOwnership` —
  a record keyed by `NotificationKind`, so a new kind cannot be forgotten)
  with a `templateText` of named parameters, and `validDomains` = the host of
  `PUBLIC_URL`. No `bots`. English in the manifest, French in a `fr.json`
  (`localizationInfo`); every one of those strings comes from the server
  dictionary of §2 (`templates.ts`), so a missing French string is a compile
  error. The icons are compiled into the API (`teamsIcons.ts`).
- The **tab** (`/teams`, `TeamsTabPage`), where a user links their account.
- The **tab's endpoint** `POST /app/api/notifications/teams/tab`, the only
  public route of the channel besides the package.
- The **Graph client** (`teams.ts`), which delivers.

**Why the tab has no session.** Teams frames the tab on its own origins; our
cookies are `SameSite=Lax`, so no Quiz session ever exists inside Teams, and
a sign-in attempted inside the frame fails (Switch edu-ID answers "Stale
request"). The route `/teams` is therefore drawn by `App` before the session
is even asked for, and never redirects to a login. Who the user is comes from
Teams: `authentication.getAuthToken()` gives the tab an SSO token of the
Teams account for our API. Everything that needs the Quiz session opens in
the system browser (`app.openLink`). `@microsoft/teams-js` is loaded lazily,
from that page only.

**The tab's endpoint** takes the SSO token as `Authorization: Bearer`, reads
no cookie (so there is no CSRF to check), answers `Cache-Control: no-store`
and 404 when Teams is off. `ssoAuth.ts` verifies it with `jose`:

- RS256 only, signed by a key of Entra's common key set
  (`login.microsoftonline.com/common/discovery/v2.0/keys`, jose's
  `createRemoteJWKSet`: cached a day, re-read at most every five minutes for
  an unknown key, which bounds what forged tokens cost);
- `iss` EXACTLY `https://login.microsoftonline.com/<tid>/v2.0`, the `tid`
  being the token's own;
- `aud` = `TEAMS_CLIENT_ID`;
- `tid` in `TEAMS_ALLOWED_TENANTS` (empty admits every tenant, for a test
  app only: under `NODE_ENV=production` the process refuses to start with
  Teams on and the list empty) — a 403 `tenant_not_allowed`, so the tab can
  say why;
- a delegated token: `scp` holds `access_as_user`, `idtyp` is not `app`;
- `azp` is a Teams client (`1fec8e78-bce4-4aaf-ab1b-5451cc387264`, desktop
  and mobile; `5e3ce6c0-2b1f-4285-8d4b-75ee78787346`, web);
- `exp`/`nbf` with five minutes of skew; `oid` present.

Anything else is a 401 and a log line `teams tab refused` with the reason;
the token itself is never logged (`authorization` is redacted). The answer
is `TeamsTabState` of `@quiz/contracts`: `{ state: "linked", accountName }`
when that `(tid, oid)` is linked, else a fresh single-use link
`{ state: "unlinked", linkUrl: "${WEB_URL}/teams/link?token=…" }`.

**Which issuer, again.** The bot's endpoint refused every Entra issuer: a
Bot Connector call proves Microsoft's identity, and an Entra token of any
tenant for our audience would have been a forgery vector. The tab's token is
of another nature: it proves only the CALLER's own Teams identity, and the
only thing it obtains is that identity's own link state and a link token for
that same identity, which the user must still confirm while signed in to the
platform. Accepting Entra v2 tokens is therefore right here, with the issuer
derived from, and pinned to, the token's own tenant, the audience pinned to
our API, the scope pinned to `access_as_user`, the client pinned to Teams
and the tenant to the allowlist. v1 tokens (`sts.windows.net`) are refused:
the application asks Entra for v2 tokens only.

**Linking.**

1. The user uploads the package in Teams (*Apps → Manage your apps → Upload
   an app → Upload a customised app*) and opens HEIG Quiz. Installing grants
   the RSC permission; the first SSO call may ask them to consent to the
   application (`access_as_user`), which the Teams clients are pre-authorized
   for.
2. The tab calls its endpoint. Unlinked: the endpoint mints a token — 32
   random bytes, SHA-256 in `teams_link_tokens` with the tenant, the object
   id, the Teams display name and the `preferred_username`, fifteen minutes
   — after deleting that identity's unspent tokens (the last link shown is
   the only one that works) and every expired token, serialized per identity
   by an advisory lock. There is no cooldown: each call costs one row and
   leaves one. The tab shows ONE primary button, "Link to my Quiz account",
   which opens `/teams/link?token=…` in the browser, and a "check again".
3. The page `/teams/link` is unchanged in substance (signed out: the
   ordinary login, `next=` back; preview without consuming; **Link** behind
   the session and its CSRF check; token in a body; one conditional UPDATE
   decides). The preview now also names the Microsoft account
   (`preferred_username`), next to the display name and the organization;
   it is shown, never compared with `users.email` (an edu-ID address and a
   Microsoft 365 one legitimately differ).
4. Back in Teams, "check again" shows "Linked to the Quiz account of *X*".
   Nothing is posted to confirm: there is no chat any more.

`teams_links` is `(user_id PK, tenant_id, aad_object_id, teams_name,
teams_username, linked_at)`, UNIQUE `(tenant_id, aad_object_id)`: one Teams
account per Quiz account and one Quiz account per Teams account. A token of
an identity already linked elsewhere MOVES the link (audited `teams.unlink`,
`{ via: "moved", to }`), and a new link replaces the account's previous one.
Migration `0023_teams_graph_activity` keeps the existing rows (ALTER: the
chat columns dropped, `teams_username` added, the unique pair created after
keeping the most recent of any duplicate) and empties the pending tokens.

**Sending.** `jobs.ts` reads the link and, still skipping a tenant no longer
allowed, calls the Graph client:

- a client-credentials token of the application IN THE RECIPIENT'S TENANT
  (`login.microsoftonline.com/<tid>/oauth2/v2.0/token`, scope
  `https://graph.microsoft.com/.default`), cached per tenant until a minute
  before expiry;
- `POST https://graph.microsoft.com/v1.0/users/<oid>/teamwork/sendActivityNotification`
  with `topic` (`source: text`, the evaluation's or the pool's name, and a
  `webUrl`), the kind's `activityType`, `previewText` and the
  `templateParameters` its `templateText` names.

In an application call Teams shows the app as the actor. The `webUrl` must
be a Teams URL: it is the deep link to the tab,
`https://teams.microsoft.com/l/entity/<appId>/home?context={"subEntityId":…}`,
whose `subEntityId` is the app path the bell and the e-mail already open
(`notificationPath`: `/attempts/<id>/feedback`, `/pools/<id>`). The tab
never follows it as given: it parses it into a route of the router
(`parsePath`, anything unknown being the home) and writes the path back from
that route (`routeToPath`), then opens it under its OWN origin
(`${location.origin}${path}`). A crafted deep link (`//evil.com`,
`https://evil.com`, `/\evil.com`, `javascript:…`) therefore lands on a page
of the platform, never elsewhere: no open redirect, and no second schema for
targets.

A 403 from Graph means the app is not installed for that user, its RSC
permission was not granted (an app uploaded before version 2.0.0), or a
policy blocks it; a 404, an unknown user. Neither can change on a retry: the
delivery is dropped with `teams notification refused for good, not retried`
(status and Graph's error code), and the link is KEPT — reinstalling the app
is the user's fix, and there is no longer an uninstall event that would tell
us to forget it. A token failure (a lapsed secret, AADSTS700016 when the
application is unknown to the tenant) is our configuration and is retried,
like any other failure.

**Language.** Two languages meet in one notification, on purpose. The
`templateText` (the line "Results available: *Test 0*") is rendered by
Teams, in the language of the recipient's Teams client, from the manifest
and `fr.json`; its parameters are therefore names and titles, never a
translated word. The `previewText` (the line under it) is rendered by the
server in `users.locale`, like the e-mail, and cut to 150 characters.

**Consent phishing across tenants.** Anyone can upload the package into
their own Teams, in any tenant, and receive a genuine link. Forwarded to a
HEIG-VD user who opens it while signed in, it would link the STRANGER's
Teams account to the victim's Quiz account. The defenses are those of the
bot's version: `TEAMS_ALLOWED_TENANTS` (production: HEIG-VD's tenant
`a372f724-c0b2-4ea0-abfb-0eb8c6f84e40`) — the tab mints no token for another
tenant, and the link is refused again at consumption; the confirmation page
names the Teams account, its Microsoft account AND its organization, and
warns to link only one's own; the notifications carry titles and ids, never
a grade (§6). Inside HEIG-VD a colleague could still bait a colleague; what
reaches the bait is what an e-mail forwarding rule would leak, and the victim
sees the Teams name and address in their settings.

**Secrets in logs.** Unchanged: `redact.ts` masks `/teams/link?token=…` and
a `next=`/`returnTo=` pointing at it; `Authorization` is redacted, which
covers the SSO token.

**Rolling it back.** Unset `TEAMS_CLIENT_ID`/`TEAMS_CLIENT_SECRET`: the
channel disappears from the settings and its routes answer 404; the links
stay in the table, unused. Going back to the bot would need the Azure Bot
again and a migration restoring the chat columns — the links made since
could not be carried over (they know no chat).

### 5. Preferences: a sparse table, defaults in the contracts

`notification_preferences(user_id, kind, channel, enabled)`, primary key on
the three first columns, holding only the toggles a user actually moved. A
missing row is the kind's row of `DEFAULT_CHANNEL_ENABLED` in
`@quiz/contracts` (per kind since the addendum of #198). For the three kinds
of this ADR it is bell on, e-mail on, Teams on. Teams only takes effect once
the account is linked, so
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
- The Teams channel is tested against a stand-in Entra (a local key served
  at the real JWKS URL, tokens with each claim broken in turn) and a stubbed
  Graph, not a live tenant; the first real check is the one of
  `docs/development/teams.md`.
- No tenant administrator is involved; a tenant whose policy forbids custom
  apps cannot use the channel, and its users keep the bell and e-mail.
- Every user installs the app once, and a new manifest version reaches them
  as an update Teams offers. The package holds no secret. Those who uploaded
  the bot's package (1.x) must install 2.0.0: the old one grants no RSC
  permission, and Graph answers 403 until they do.
- The platform exposes an endpoint without a session, the tab's. Its whole
  defense is the SSO token check above and the tenant allowlist, and what it
  gives away is the caller's own link state; a bug there is the one way in,
  which is why each check is tested on its own.
- The application must be multi-tenant: the client-credentials token is
  asked of the RECIPIENT's tenant, which knows the application once a user
  there consented to it (the tab's SSO). An administrator's policy that
  forbids user consent to applications, or custom apps, closes the channel
  for that tenant; its users keep the bell and e-mail.
- The uninstall of the app is no longer seen: a link outlives it, and its
  deliveries end in a logged 403 until the user reinstalls the app or
  disconnects in the settings.
- The activity feed shows a notification's text in the language of the Teams
  client, and its preview in the language of the Quiz account — the same
  language for nearly everyone, two for a few.

### Rollback

Unset the `SCW_*` variables (e-mails go back to the log) or the `TEAMS_*`
ones (the channel disappears from the settings and its routes answer 404);
no data has to move. Migration `0017` only adds tables and a nullable
column. Migration `0022` dropped and recreated `teams_links` and added
`teams_link_tokens` (the bot); `0023` alters both for the activity feed,
keeping the links: going back to the bot would need a migration restoring
the chat columns, and the links made since could not be carried back.

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
- **A bot the user uploads** (the design of 2026-09-27: an Azure Bot, its
  Bot Connector messaging endpoint, a link card in the bot's personal chat,
  messages posted into that chat). No administrator either, but it did not
  work for the product owner, it needs an Azure resource and a second token
  scheme, and a chat message is not where Teams tells a person that
  something happened — the activity feed is. Replaced.
- **Graph with an application permission granted by an administrator**
  (`TeamsActivity.Send`, tenant-wide): the same call without the RSC
  indirection, but HEIG-VD's IT will not consent. Rejected.
- **A link code typed in the chat** instead of a link to click: works without
  a browser round trip, but a code short enough to type is short enough to
  guess, and the page-with-a-session is the step that proves the Quiz
  account anyway. Rejected.
- **A jsonb column of preferences on `users`** (heig-classroom's
  `email_prefs`): written by the `notifications` module into `auth`'s table,
  and one channel only. Rejected.

## Addendum (2026-09-28): one system, per-kind defaults, eight new kinds (#198)

Settled with the product owner on issue #198: the proposals of the issue and
the seven answers of its review, all accepted. The settings page had two
sections for one idea: the notifications of this ADR (bell, e-mail, Teams,
per account on the server) and "Popup alerts" (SSE toasts, per browser in
`localStorage`). A user could not tell why "a student joined" was a popup and
"a pool was shared with you" a notification, every kind added later would
have been e-mailed to everyone, and a student was told of nothing but a
released result.

### a. The App channel is the bell plus the toast

- The `bell` channel is shown as **App**. It means an entry in the bell,
  plus a toast in every tab that is open. `NoticeKind`, the `localStorage`
  preferences and the "Popup alerts" card are removed. `student_joined` and
  `roster_conflict` become `NotificationKind`s and go through `notifyMany`
  like every other kind.
- The toast is the live rendering of a notification arriving. The stream
  still carries no data (ADR-005). On the `notifications` hint the client
  re-reads its inbox and toasts what it had not seen:
  - the FIRST read after a connect or a reconnect sets the baseline and
    toasts nothing, so a reload never replays the unread inbox;
  - after that, each new `(id, createdAt)` pair toasts once. A folded entry
    keeps its id and refreshes `createdAt` (§e), so it toasts again;
  - several open tabs each toast. The duplicate is accepted rather than
    coordinated across tabs;
  - nothing toasts while the student is in an attempt. The bell still
    counts it.
- App off for a kind means no row and no toast (§1: no row a user asked not
  to see). `useToast()`, the feedback of an action the user just took, is not
  a notification and is never gated.

### b. Defaults per kind

`DEFAULT_CHANNEL_ENABLED` is `Record<NotificationKind, Record<NotificationChannel,
boolean>>` in `@quiz/contracts`: a kind without its row is a compile error.
The table of §5 stays sparse, and a missing row means the kind's own
default. App is on for every kind. A kind a user must not miss is on by
e-mail and Teams too. A background-noise kind is **off by e-mail and Teams**,
and a user who turns it on gets one message per event (the fold of §e is
the bell's). `notificationKindsFor(role)` still decides which rows of the
grid a role sees. The three kinds of this ADR keep bell, e-mail and Teams on:
the change made no difference a user could see.

### c. The kinds

| Role | Kind | App | E-mail / Teams | Trigger |
|---|---|---|---|---|
| Student | `results_released` | on | on | unchanged (§6) |
| Student | `activity_scheduled` | on | off | an EXERCISE is scheduled for the student's classroom, folded per classroom (§h) |
| Student | `activity_available` | on | on for a take-home exercise, off in class (§h) | an EXERCISE moves to `running` |
| Student | `deadline_approaching` | on | on | 24 h before `closesAt` (§d) |
| Student | `results_updated` | on | off | the final grade differs from the released one, folded per evaluation (§h) |
| Teacher | `student_joined` | on | off | a student joined the classroom, folded per classroom |
| Teacher | `roster_conflict` | on | on | a roster entry needs the teacher's attention, folded per classroom |
| Teacher | `grading_ready` | on | on | automatic grading finished and proposals remain |
| Teacher | `pool_question_added` | on | off | a colleague published a question in a shared pool, folded per pool |
| Teacher | `pool_shared`, `pool_ownership` | on | on | unchanged |

- **`activity_scheduled`: exercises only, sent once.** For an exam the
  students are in the room, and e-mailing a whole class the moment an exam
  is scheduled would leave the teacher no way to keep it a surprise. It is
  sent the first time the evaluation is scheduled and never again when it is
  rescheduled. The payload carries `opensAt`.
- **`activity_available`: the move to `running`**, by the ticker or by hand,
  for exercises only. The lobby and `opensAt` are not "open". Polls are
  excluded: they happen live in the room.
- **`results_updated`: only when the grade actually differs** from the
  released one — the final grade on the evaluation's scale, compared before
  and after the validation (§h). The only hook, `flagReleasedEvaluationsOf`, runs inside the
  grading transaction once per validated cell, even when nothing changes.
  Re-validating twenty cells without changing a grade therefore tells
  nobody. A change folds into the student's unread entry for that
  evaluation. The payload carries no grade.
- **Teacher recipients** are the staff seats of the course (the rows
  `staffAccess` reads). Admins who hold no seat are not included, and the
  person who acted is never notified: `roster_conflict` is triggered by the
  teacher's own import.
- **`grading_ready`** is sent only when proposals remain to validate. A
  grading pass that settled everything has nothing to ask for.
- **`pool_question_added`** goes to the pool's owner and its `contributor`
  and `owner` shares, never to `reader`s, never to the author.
- **Payloads never carry a grade, a student's name, an e-mail or question
  content** (§6, invariant 4). The teacher who acted may be named, as
  `pool_shared` (`byName`) and `pool_ownership` (`fromName`) already do.
  `student_joined` and `roster_conflict` carry
  `{ classroomId, classroomName, count }` (question 6): once folded, the
  names are lost anyway, and the bell opens the roster, where they are. `pool_question_added`
  carries `{ poolId, poolName, count }`. Each kind has its sentence in `en`
  and `fr`, in `templates.ts` (e-mail, Teams) and in the web dictionary
  (bell, toast). This includes the hard-coded English sentence `roster.ts`
  sent before #198.

### d. `deadline_approaching`: keyed on `closesAt` alone

The reminder does not depend on the timing mode. `duration` and `manual`
evaluations can carry a `closesAt` too, and the ticker closes them on it.
A server-side scan (the server owns the clock, invariant 5) sends it to each
student of the classroom who has not submitted, when all of these hold:

- `now >= closesAt - 24 h`;
- the evaluation is `running`;
- `startedAt <= closesAt - 24 h`, so a window shorter than a day (a two-hour
  exam, a ten-minute exercise) gets no reminder. The window is measured from
  `startedAt`, the moment the evaluation actually started running, not from
  `opensAt`: an evaluation opened by hand has no `opensAt`, and one opened
  early or late did not open at `opensAt`;
- no sent marker exists for that (evaluation, student).

A late scan, after a restart or a missed tick, therefore catches up, and
each student gets at most one reminder per evaluation. A `closesAt` moved
after the reminder was sent does not send it again. Individual extensions
are ignored. The marker is a table of its own, with its migration. There is
no per-evaluation setting and no configurable delay.

### e. Aggregation

`student_joined`, `roster_conflict` and `activity_scheduled` fold per
classroom (§h), and `pool_question_added` per pool. The event bumps the recipient's UNREAD
entry of the same kind and the same classroom or pool, and refreshes its
`createdAt`, rather than writing a new row. Once that entry is read, the
next event starts a new one. `results_updated` folds the same way per
evaluation (§c).

- `notifications` gains a `classroom_id` column, a foreign key that cascades
  like `pool_id` and `evaluation_id` do.
- Two races are guarded: two events that both find no unread entry and each
  insert one, and a fold that bumps an entry the user is marking read at the
  same moment. The fold is therefore one atomic statement: an insert that
  conflicts on a unique index over (user, kind, target) limited to unread
  rows, and updates the count on conflict. It never reads and then writes.
- The target spans nullable columns (`classroom_id`, `pool_id`,
  `evaluation_id`), and a plain unique index treats two NULLs as distinct.
  The guard is therefore ONE PARTIAL UNIQUE INDEX PER FOLDED KIND, on
  `(user_id, <its target column>) WHERE kind = '<kind>' AND read_at IS NULL`
  (or one index declared `NULLS NOT DISTINCT`), never a single index across
  all three columns.

### f. Fan-out, Teams, order of the work

- Fan-out goes through `notifyMany`, which already exists: one query for the
  preferences, then the jobs of the outbox. It is called after the write it
  announces has committed, never inline in a delivery. An exercise opening
  for eighty students is eighty rows and their jobs.
- Every new Teams `activityType` goes into **one** manifest version bump.
  Each user has to re-upload the app for a new version, so this must not
  happen once per kind.
- A kind joins `NOTIFICATION_KINDS` (and so the settings grid) in the step
  that emits it, never earlier: a toggle for a kind that sends nothing is a
  lie. The manifest's `activityType` list alone may run ahead of the
  catalogue, so that the single bump of step 4 already declares the types of
  the kinds of steps 5 to 8. It is then no longer derived from
  `NOTIFICATION_KINDS` alone, and a test keeps every kind of the catalogue
  in it.
- The work is split into steps, in this order: the privacy leak of
  `student_joined` and its hard-coded English (#246); `roster_conflict`
  actually emitted from every conflict path; the per-kind defaults and this
  addendum; the App channel and the migration of the two SSE kinds, with the
  manifest bump; `grading_ready` and `pool_question_added`;
  `activity_scheduled` and `activity_available`; `deadline_approaching`, with
  its scan, marker table and migration; `results_updated`, last.

### g. Out of scope

E-mail digests, browser push notifications, muting per course, and
configurable reminder delays.

### h. Decisions of 2026-09-28 (evening)

Five more decisions, settled with the product owner on issue #198 after the
review above, and applied from step 4 on:

1. **`activity_scheduled` folds per classroom** ("16 exercises scheduled in
   PRG1-2026"), like `student_joined`, and is **off by e-mail and Teams by
   default**: a teacher who schedules a term of exercises in one sitting
   must not send a class sixteen e-mails. `activity_available` and
   `deadline_approaching` keep e-mail on.
2. **No toast on a full-screen page** — the poll projection, the live
   dashboard, the correction projection — as for a student in an attempt:
   what a teacher projects must not show a class a toast. The bell still
   counts it. In the web app the quiet pages are the full-screen views plus
   the live dashboard (`QUIET` in `App.tsx`), and leaving one sets a new
   baseline, so what arrived meanwhile is not toasted late. **One folded
   entry toasts at most once every 5 minutes**, however often it is bumped.
3. **`activity_available` by e-mail and Teams only for a take-home
   exercise** (`isTakeHome`). An in-class exercise opens with the students
   in the room: it stays in the app.
4. **`results_updated` compares the student's FINAL GRADE on the
   evaluation's scale** before and after the validation. Points that move
   without changing the rounded grade tell nobody. No snapshot of the
   released grade is stored: the comparison is made inside the validation,
   from what it is about to change.
5. **`results_updated` is off by e-mail by default** (as §c already said),
   its app entry folds per evaluation, and no delay is added before it is
   sent.

Step 4 also settled how the fold is written: the kind is read from the
payload, so each partial unique index is on `(user_id, classroom_id) WHERE
payload->>'kind' = '<kind>' AND read_at IS NULL`
(`notifications_<kind>_fold_uq`, migration `0027_notification_folds`), and
the fold's `INSERT … ON CONFLICT` names it by the same columns and predicate,
the kind written as a literal (Postgres cannot prove that a bind parameter
implies the index predicate). The count adds the incoming event's count, so
a claim pass that flags three lines at once adds three. `student_joined` is sent when a student takes a seat
themselves — by the join code, or by the claim at their own sign-in — and
NOT by the reverse claim that a teacher's roster import or e-mail edit runs
for accounts that already exist: the teacher who imported the list is
looking at it, and the list itself says who is claimed. `tellStaff` is
best-effort: a notification that fails is logged and never fails the
sign-in, the join or the import that raised it. A Graph 400 (an activity
type the user's installed manifest does not declare) is a permanent Teams
failure, like a 403 or a 404, and is not retried. The manifest was
bumped once, to 2.1.0, declaring the activity types of every kind of steps 4
to 8.

Step 5 (`grading_ready`, `pool_question_added`) settled:

- **`grading_ready` is sent when the grid is complete**: every (attempt ×
  item) cell holds a validated or proposed grading, so no runner job is still
  out. A pass that sends empty cells to the runner says nothing (its runner
  jobs are enqueued once its batch is written), and the runner job that fills
  the last empty cell does. The guard against duplicates: the pass announces only
  when it filled a cell that had no grading at all, or when it is the pass of
  the close (`announce` on the job — an exercise with retakes may have
  graded every attempt, alone, while it ran); a runner job only when its own
  cell had none. A pass run again with nothing new tells nobody; a re-grade
  empties its item's cells, so its pass tells again if proposals remain.
  Nothing is sent while the evaluation is `running` or `paused`, nor for a
  poll. The count is every proposal standing on the evaluation, placeholders
  included (they need the teacher too). Recipients are `staffOf`, the course's
  staff seats: the pass is asynchronous, so the teacher who closed the
  evaluation is told too. Not folded. Best-effort: a failure is logged and
  never fails the job.
- **`pool_question_added` counts every publication**, the first version of a
  question or a new one: "a colleague published a question" either way. It
  is sent from `publishQuestion` after its transaction commits, so every
  path — the editor, the MCP `create_question`, an importer over the API —
  goes through it, and fifty publications fold into one entry counting
  fifty. Best-effort, as `tellStaff`: a publication never fails because the
  notification did.
- **The folded kinds are ONE constant**, `NOTIFICATION_FOLD_TARGETS`
  (`db/notifications.ts`): the partial unique indexes are generated from it,
  the fold reads it, and a test holds the migrated database to it.
  `pool_question_added` folds on `(user_id, pool_id)`, migration
  `0028_notification_pool_fold`.
