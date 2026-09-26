# ADR-030 — Notification channels: the bell, e-mail and Microsoft Teams

## Status

Accepted (2026-09-26, issue #144, with `apps/api/src/modules/notifications/`
(`service.ts`, `outbox.ts`, `jobs.ts`, `mailer.ts`, `teams.ts`,
`templates.ts`), the tables `notification_preferences` and `teams_links`, the
column `notifications.evaluation_id` (migration `0017_notification_channels`)
and the notification kind `results_released`). The e-mail half reuses the
mailer of heig-classroom (docs/spec/07, "Mailer").

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

### 4. Teams: link once by an OpenID sign-in, send as a bot

**Linking.** "Connect Microsoft Teams" in the settings runs an OAuth 2.0
authorization-code flow with PKCE (S256), `state` and `nonce` — the shape of
our edu-ID login — against `login.microsoftonline.com/organizations`, scopes
`openid profile`. It exists to learn two claims of the ID token: the tenant
(`tid`) and the user's object id (`oid`). The start is a `POST` (so the CSRF
check applies) that answers with the Microsoft URL; the verifier, state,
nonce and the account id travel in a signed ten-minute cookie scoped to the
callback. The callback requires the same session, the same account and the
same state. The ID token comes straight from Microsoft's token endpoint over
TLS in exchange for our client secret, which OpenID Connect Core §3.1.3.7
accepts in place of a signature check; the client still checks `aud`,
`nonce`, and that `iss` is the issuer of the tenant the token names. The row
in `teams_links` is `(user_id, tenant_id, object_id, chat_id, linked_at)`.
**No Microsoft token is stored** — none is needed: sending uses the
application's own credentials. Linking and unlinking are audit events
(`teams.link`, `teams.unlink`).

**Sending** (Bot Framework proactive message). In the job:

1. an app-only Graph token for the user's tenant (client credentials);
2. `POST /users/{oid}/teamwork/installedApps` binding the Teams app
   (`TEAMS_APP_ID`); `409` means it is already installed;
3. the installation's id (`GET …/installedApps?$filter=teamsApp/id eq …`)
   and its one-to-one chat (`GET …/installedApps/{id}/chat`);
4. a Bot Connector token (`https://api.botframework.com/.default`, issued by
   `TEAMS_BOT_TENANT`) and `POST {serviceUrl}/v3/conversations/{chatId}/activities`.

The chat id is cached on the link, so steps 1–3 run once per user. A post
that answers 403/404 on a cached chat resolves it again once before failing.
All of it lives in `teams.ts`, behind an injected `fetch`, and is unit-tested
against scripted Microsoft answers.

**Configuration.** One multi-tenant Entra application is at once the
sign-in client, the Graph client (application permission
`TeamsAppInstallation.ReadWriteSelfForUser.All`, admin consent per tenant)
and the bot. The channel exists only when `TEAMS_CLIENT_ID`,
`TEAMS_CLIENT_SECRET` and `TEAMS_APP_ID` are set; otherwise the settings say
Teams is not available, `POST …/teams/connect` and `DELETE …/teams` answer
`503 teams_unavailable`, the callback `404`, and `notify` enqueues no Teams
job. The setup an administrator must do is `docs/development/teams.md`.

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
- The Teams channel cannot be tested end to end until the Entra
  application, the Azure Bot and the Teams app exist. The code is covered by
  unit tests against recorded shapes of Microsoft's answers, not by a live
  tenant.
- Each tenant's administrator must consent to the application before any
  user of that tenant can receive a message; a user of a tenant that has not
  consented can link, and their deliveries fail (logged, retried, dropped).
- A multi-tenant bot registration is being retired by Microsoft for new Azure
  Bot resources; `TEAMS_BOT_TENANT` lets the same code run a single-tenant bot
  (the home tenant id), which still reaches users of other tenants once the
  app is installed there.

### Rollback

Unset the `SCW_*` variables (e-mails go back to the log) or the `TEAMS_*`
ones (the channel disappears from the settings); no data has to move. The
migration only adds tables and a nullable column.

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
- **A jsonb column of preferences on `users`** (heig-classroom's
  `email_prefs`): written by the `notifications` module into `auth`'s table,
  and one channel only. Rejected.
