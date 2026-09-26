# Microsoft Teams notifications: the setup

The Teams channel of the notifications (ADR-030) needs one Microsoft Entra
application, registered once by someone with rights in a Microsoft tenant
(the HEIG-VD one, or any other). Until the three variables below are set in
`.env.prod`, the channel is off: the settings page says Teams is not
available and nothing is sent.

```bash
TEAMS_CLIENT_ID=      # the Entra application (client) id
TEAMS_CLIENT_SECRET=  # a client secret of that application
TEAMS_APP_ID=         # the Teams app's id in the tenants' catalogs
#TEAMS_BOT_TENANT=botframework.com   # or the home tenant id, for a single-tenant bot
#TEAMS_SERVICE_URL=https://smba.trafficmanager.net/teams
```

One application plays three roles: the **sign-in** of "Connect Microsoft
Teams" (to learn the user's tenant and object id), the **Graph client** that
installs the Teams app for a user and finds their chat with it, and the
**bot** that posts the message. The platform keeps no Microsoft token.

## 1. The Entra application

In the Entra admin center, *App registrations → New registration*:

- **Supported account types**: *Accounts in any organizational directory
  (multitenant)*.
- **Redirect URI** (platform *Web*):
  `https://quiz.chevallier.io/app/api/notifications/teams/callback`
  (and the staging host if staging ever gets Teams — it should not, see
  `.env.staging.example`).

Then:

- *Certificates & secrets → New client secret*: its value is
  `TEAMS_CLIENT_SECRET` (note the expiry: a lapsed secret fails every link and
  every delivery, visible in the logs as `notification delivery failed`).
- *API permissions*:
  - Microsoft Graph, **delegated**: `openid`, `profile` (the sign-in).
  - Microsoft Graph, **application**:
    `TeamsAppInstallation.ReadWriteSelfForUser.All` (install the app for a
    user and read the chat with it).
- *Grant admin consent* for the home tenant.

The application (client) id is `TEAMS_CLIENT_ID`.

## 2. The bot

In the Azure portal, *Create an Azure Bot*:

- **Microsoft App ID**: *Use existing app registration*, the application of
  step 1. For a new bot Azure may only offer *Single Tenant*; then set
  `TEAMS_BOT_TENANT` to the home tenant id. A single-tenant bot still writes
  to users of other tenants once the Teams app is installed there.
- **Messaging endpoint**: required by the form, never called by the platform
  (it does not converse). Any HTTPS URL of the platform will do, e.g.
  `https://quiz.chevallier.io/healthz`.
- *Channels*: add **Microsoft Teams**.

## 3. The Teams app

A Teams app package (a zip of `manifest.json` and two icons) declaring the
bot, built with the Teams Developer Portal (*Apps → New app*):

- **App features → Bot**: the bot of step 2, scope **Personal** only.
- **Name**: "HEIG Quiz"; **Short description**: the notifications of the quiz
  platform.
- `webApplicationInfo.id` = `TEAMS_CLIENT_ID`.

Publish it:

- to one tenant: *Teams admin center → Manage apps → Upload new app*. The id
  Graph knows it by in that tenant's catalog is shown in the app's details
  (it is NOT the manifest id for an app uploaded by an organization): that
  id is `TEAMS_APP_ID`;
- to every tenant: submit it to the Teams Store. A Store app keeps its
  manifest id as its catalog id everywhere, which is what a multi-tenant
  `TEAMS_APP_ID` needs.

## 4. Each tenant whose users link Teams

An administrator of that tenant must, once:

1. grant admin consent to the application (the consent URL is
   `https://login.microsoftonline.com/<tenant>/adminconsent?client_id=<TEAMS_CLIENT_ID>`);
2. allow the Teams app (*Teams admin center → Manage apps*, and the app
   permission policies if custom apps are restricted).

Without the consent, a user of that tenant can link, and every delivery to
them fails with a 401/403 from Microsoft: logged, retried five times, then
left failed in pg-boss.

## Checking it

1. Set the three variables, restart the container.
2. *Settings → Notifications → Connect Microsoft Teams*, sign in at
   Microsoft: the page comes back with "Microsoft Teams is connected".
3. Release the results of an evaluation you took as a student (or share a
   pool with the account): a message from the bot arrives in Teams within
   seconds. `docker compose logs -f app | grep -i teams` shows
   `teams notification sent`, or the Microsoft error.
