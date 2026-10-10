# Microsoft Teams notifications: the setup

The Teams channel of the notifications (ADR-030, rules 26–31; §4 before the 2026-10-09 renumbering) posts to each user's
Teams **activity feed** through Microsoft Graph, as the app "HEIG Quiz". Each
user installs that app in their own Teams by uploading a small package the
platform serves; installing it grants the app the one permission it uses,
`TeamsActivity.Send.User`, for that user only (a resource-specific consent
permission). No administrator of the users' tenant is involved, no app sits
in any organization's catalog, and there is no bot: one Entra application,
in a tenant we control.

Until the first two variables below are set in `.env.prod`, the channel is
off: the settings page says Teams is not available, and the Teams routes
answer 404.

```bash
TEAMS_CLIENT_ID=      # the Entra application (client) id
TEAMS_CLIENT_SECRET=  # a client secret of that application
TEAMS_ALLOWED_TENANTS=a372f724-c0b2-4ea0-abfb-0eb8c6f84e40   # HEIG-VD only
```

`TEAMS_ALLOWED_TENANTS` lists the Microsoft 365 organizations (Entra tenant
ids, comma-separated) whose Teams accounts may be linked. Anyone can upload
the app into their own Teams; without the list, a stranger could send a HEIG
user a link to their own Teams account and receive that user's notifications
(ADR-030, rules 27 and 29; formerly "Consent phishing across tenants"). Leave it empty only for a test
app: under `NODE_ENV=production` an empty list with Teams on stops the process
at boot. A Teams account of another organization sees, in the tab, that HEIG Quiz
only links HEIG-VD accounts, and gets no link.

Where things live today:

| What | Where |
| --- | --- |
| Entra application | the owner's tenant `96412a41-a2a2-422e-8438-f29c95c02686` |
| Users | HEIG-VD tenant `a372f724-c0b2-4ea0-abfb-0eb8c6f84e40` |
| Tab (in Teams) | `https://quiz.chevallier.io/teams` |
| Tab's endpoint | `POST https://quiz.chevallier.io/app/api/notifications/teams/tab` |
| App package | `https://quiz.chevallier.io/app/api/notifications/teams/app.zip` |

Staging has no Teams: it holds a copy of production's accounts and must never
notify a real person (`.env.staging.example`).

## 1. The Entra application

In the Entra admin center of our tenant, *App registrations* (the existing
registration, whose client id is production's `TEAMS_CLIENT_ID`, or *New
registration*):

- **Supported account types**: *Accounts in any organizational directory
  (multitenant)*. Required: Graph is called with a token of the RECIPIENT's
  tenant, which a single-tenant application cannot get.
- No redirect URI.
- **API permissions**: none to add. `TeamsActivity.Send.User` is not granted
  here: the Teams app's manifest declares it, and each user grants it for
  themselves by installing the app.

*Expose an API*:

- **Application ID URI**: `api://quiz.chevallier.io/<clientId>` — exactly
  the manifest's `webApplicationInfo.resource`, which the platform writes
  from `PUBLIC_URL` and `TEAMS_CLIENT_ID`. The host must be the tab's.
- **Add a scope**: `access_as_user`, *Who can consent*: **Admins and users**,
  with a short consent text ("HEIG Quiz reads who you are in Teams to link
  your Quiz account").
- **Add a client application**, twice, both with the scope `access_as_user`:
  - `1fec8e78-bce4-4aaf-ab1b-5451cc387264` (Teams desktop and mobile);
  - `5e3ce6c0-2b1f-4285-8d4b-75ee78787346` (Teams web).

*Manifest* (the Entra application manifest editor, not the Teams one): set
`"requestedAccessTokenVersion": 2` under `"api"` (older editors: the root
field `accessTokenAcceptedVersion`). The tab's endpoint accepts v2 tokens
only — issuer `https://login.microsoftonline.com/<tid>/v2.0`, audience the
bare client id — and refuses v1 ones.

*Certificates & secrets → New client secret*, **24 months**. Its value is
`TEAMS_CLIENT_SECRET`; the application (client) id is `TEAMS_CLIENT_ID`.

**Rotation.** Put the expiry date in the calendar a month ahead. To rotate:
create a second secret, set it in `.env.prod`, restart the app container,
check that a notification still reaches Teams (below), then delete the old
secret. A lapsed secret fails every send with a 401 at
`login.microsoftonline.com`, visible in the logs as `notification delivery
failed`; the deliveries are retried five times, then left failed in pg-boss.
Nothing else breaks — the tab keeps working, its tokens need no secret.

**The Azure Bot of the previous design** (resource "HEIG Quiz", its Teams
channel and messaging endpoint) is no longer used: delete it in the Azure
portal. The Entra application stays; switch it to multitenant if it was
single-tenant.

## 2. The Teams app

Nothing to build by hand: `GET /app/api/notifications/teams/app.zip` (public)
generates the package from the configuration — `manifest.json` (schema 1.17,
`id` = `TEAMS_CLIENT_ID`, one personal static tab at `${PUBLIC_URL}/teams`,
`webApplicationInfo`, the RSC permission `TeamsActivity.Send.User`, one
activity type per kind of notification — including the kinds still to come
(`TEAMS_ACTIVITY_KINDS` runs ahead of the catalogue, ADR-030 §f) —
`validDomains` = the host of
`PUBLIC_URL`, no bot), its French translation `fr.json`, and the two icons,
compiled into the API as base64 constants
(`apps/api/src/modules/notifications/teamsIcons.ts`, generated by
`node apps/web/scripts/icons.mjs`). Its `version` is `TEAMS_APP_VERSION` in
`apps/api/src/modules/notifications/teamsApp.ts`, bumped by hand whenever
the package changes: 2.0.0 for this design, 2.1.0 since #198 step 4,
which declares at once the activity types of `student_joined`,
`roster_conflict`, `grading_ready`, `pool_question_added`,
`activity_scheduled`, `activity_available`, `deadline_approaching` and
`results_updated`, and **2.2.0** since merge task M3-09b, which declares the
seven project kinds of F-NOTIF-13, and **2.3.0** since the reports on a
question (issue #680), which declares `question_reported` and
`question_report_resolved`. **Every user who uploaded an older
version must re-upload the package** (Teams offers the update of an
uploaded app only when it is uploaded again): until they do, Graph refuses
an activity type their version does not declare, with a 400. Its words come
from `templates.ts`, English and French.

The package can be checked in the Teams Developer Portal (*Apps → Import
app*) before anyone uploads it. A hand-written manifest is not needed any
more: replace one uploaded earlier with the generated package.

## 3. What a user does

The settings page (*Settings → Notifications → Microsoft Teams*) shows the
same steps under **Download the Teams app**:

1. Download the app (`heig-quiz-teams.zip`).
2. In Teams: *Apps → Manage your apps → Upload an app → Upload a customised
   app*, and choose the file. Teams asks to add the app; adding it grants the
   permission to post to one's own activity feed. (HEIG-VD allows custom
   apps; a tenant whose policy forbids them cannot use the channel.)
3. Open HEIG Quiz in Teams. The tab asks Teams who the user is (SSO; the
   first time, Teams may ask to consent to "HEIG Quiz"), then shows **Link to
   my Quiz account**, which opens `/teams/link?token=…` in the browser. After
   signing in if needed, the page shows the Teams name, the Microsoft
   account, its Microsoft 365 organization and the Quiz account; **Link**
   does it. Back in Teams, **I linked it: check again** shows the Quiz
   account.

The link works once and for fifteen minutes; opening the tab again gives a
new one (and voids the previous). *Disconnect* in the settings unlinks the
account. Removing the app from Teams stops the notifications (Graph answers
403) but leaves the link, which works again once the app is reinstalled.

A notification in the activity feed opens the tab; when it leads to a page
(a result, a pool), the tab offers **Open in the browser**.

## Checking it

1. Set the variables, restart the container (`docker compose up -d app`).
2. `curl -sI https://quiz.chevallier.io/app/api/notifications/teams/app.zip`
   answers `200` with `content-type: application/zip`.
3. Upload the app in Teams, open it and link it: the tab then says "Linked to
   the Quiz account of *you*", and the settings show "Linked to *your Teams
   name* (*your Microsoft account*)".
4. Release the results of an evaluation you took as a student (or share a
   pool with the account): the notification arrives in the activity feed
   within a minute.

The logs:

```bash
docker compose logs -f app | grep -i teams
```

- `teams tab refused` (with a `reason`): the tab's SSO token failed a check —
  `tenant not allowed` (check `TEAMS_ALLOWED_TENANTS`), `unexpected "aud"
  claim value` (the Application ID URI or `TEAMS_CLIENT_ID`), `unexpected
  iss` (a v1 token: `requestedAccessTokenVersion` is not 2), `azp is not a
  Teams client`, `scope access_as_user missing`; normal for scanners;
- `teams notification sent`: a delivery went out;
- `teams notification refused for good, not retried` (with `status` and
  Graph's `code`): Graph answered 403 or 404;
- `teams notification skipped: tenant not allowed`: a link of an
  organization removed from the list;
- `notification delivery failed`: any other error, retried by pg-boss.

## Troubleshooting

- **The tab shows "Teams could not sign you in"** with a code such as
  `resourceRequiresConsent` or `consent_required`: the user could not consent
  to the application. Check the *Expose an API* step (scope, the two client
  applications) — then HEIG-VD's user-consent policy: if users may not
  consent to multitenant applications of other publishers, the channel needs
  that policy to allow this app (or an administrator's consent to
  `access_as_user` alone, which reveals nothing but the user's identity).
- **The tab asks to open HEIG Quiz in Teams** although it is in Teams: the
  Teams client did not answer the handshake in five seconds (a very old
  client), or the page was opened outside the app's tab.
- **`notification delivery failed` with `AADSTS700016` or `AADSTS7000229`**
  from `login.microsoftonline.com/<HEIG tenant>`: the application has no
  service principal in HEIG-VD's tenant yet — nobody there consented to it.
  It appears with the first user who opens the tab and consents; check that
  the application is multitenant.
- **`refused for good` with status 403** for a user: the app is not
  installed for them, they installed the bot's package (1.x) which grants no
  permission, or a Teams policy blocks it. They should install the current
  package (version 2.3.0) and open it once.
- **Status 400 from Graph**: the manifest and the code disagree (an activity
  type or a template parameter). The package served and the code come from
  the same build; the user's installed version may be older — reinstall.
