# ADR-030 — Notification channels and delivery rules

## Status

Accepted (2026-09-26), consolidated through the 2026-10-01 amendments.
This consolidation changes no decision. Extensions:
[ADR-053](ADR-053-retrait-des-codes-d-entree.md) removes classroom join codes;
[ADR-055](ADR-055-etat-du-systeme.md) adds admin system alerts;
[ADR-035](ADR-035-fusion-de-classroom.md) accepts project kinds for the merge.
Accepted project kinds and their defaults are a pending extension of this record,
not evidence they are delivered: the current contracts contain twelve kinds.

The [historical record](history/ADR-030-canaux-de-notification.md) preserves the
rejected Teams transports, migration sequence, implementation steps and original
section numbers. Load it for rationale or an old section reference; where this
record is silent on a detail (an exact log line, a migration step), the archive
still describes the implementation, and this record wins wherever both speak.

## Context

Users need to hear about work without keeping Quiz open. Slow or failing external
providers must not delay or undo the action that caused a notice. One system owns
the App inbox/toasts, e-mail and Teams, with preferences per account and kind.

## Decision

### One entry, after commit

Every module uses `notifyMany`; `notify` is its one-recipient case. Call after the
announced write commits, never from its transaction: pg-boss has its own connection,
so a queued job would survive a business rollback. Notification failures are
best-effort and must not turn a committed business action into an apparent failure.
This is not a transactional outbox or an exactly-once delivery guarantee.

The App channel (`bell` internally) writes a row and recipient refresh hint only
when enabled. Off means no row, badge increment or toast. Each selected external
channel gets a `notifications.deliver` job containing recipient, channel and payload,
not a bell-row reference: App may be off or its row deleted. Providers never run
inline. The outbox is handed its queue at boot; while closed (tests, jobs disabled,
queue startup failure) only App works, with no inline fallback. Enqueue failures
are logged. Jobs retry with exponential backoff and retry limit five; development's
in-process queue logs failures rather than promising production retries.

### Preferences, audiences and payloads

`notification_preferences` stores only changed toggles, keyed by user/kind/channel.
Missing values come from `DEFAULT_CHANNEL_ENABLED` in `@quiz/contracts`, a
`Record<NotificationKind, …>`: a kind without its defaults is a compile error. The
recipient's preferences are intersected with a delivery's allowed channels and
`KIND_CHANNELS`; preferences cannot widen either restriction. App is on by default.
Linking Teams is the account's opt-in before its enabled kinds can use that channel.

The catalogue, defaults and audience declarations live together in
`packages/contracts/src/notifications.ts`, not in a second settings-specific list.
Seat kinds target claimed non-staff enrollment seats, course kinds target course
staff seats (not a seatless admin), pool kinds target eligible teacher/admin pool
members, and admin kinds target the admin role. The settings list follows those
capabilities: students see seat kinds before enrollment; teachers/admins need a
student seat for those kinds, and an admin needs a course seat for course kinds.
Teachers can configure course kinds before receiving a seat.

Every kind has its sentence in `en` and `fr` twice: in the API's `templates.ts`
(e-mail, Teams), whose `fr` is typed `Record<keyof typeof en, string>`, and in the
web dictionary (bell, toast). A missing French sentence is a compile error.

Payloads carry identifiers, titles and counts, never grades, points, answers,
question content, student names or student e-mail. Teacher names in sharing and
ownership notices are deliberate exceptions. System alerts carry check keys only.
External messages are rendered when the job runs, in the recipient's current
locale (English if unset); user text is HTML-escaped and subjects flattened.
Links use `WEB_URL`, defaulting to `PUBLIC_URL`. Settings are the preference entry
point; there is no separate unsubscribe-token endpoint.

### App aggregation and live toasts

A folded kind maintains one UNREAD entry per user and target. One atomic upsert
adds the incoming count, replaces the latest descriptive payload and refreshes
`createdAt`; after the row is read the next event creates another. Partial unique
indexes are per kind and target, with the kind predicate written as a SQL literal.
`NOTIFICATION_FOLD_TARGETS` owns the mapping; schema, writer and migration tests
agree on it. Do not use a nullable multi-target unique index or read-then-write.
Only App folds: enabled external channels still send one message per event.

The notification stream carries a hint, not payload data. Clients refetch their own
inbox, then toast new unread `(id, createdAt)` pairs. The first read after connection,
reconnection or leaving a quiet page establishes a baseline and toasts nothing.
Attempts, projections, other full-screen pages and the live dashboard stay quiet.
A folded entry toasts at most once in five minutes. Several open tabs may each
toast; that duplication is accepted. Immediate feedback from the user's own action
(`useToast`) is separate and is never gated by notification preferences.

### Events and trigger boundaries

The external-default column means both e-mail and Teams unless stated otherwise.
App is on for all. The predicates below are part of the decision, not mere UI hints.

| Kind | Trigger, recipients and aggregation | External default |
| --- | --- | --- |
| `results_released` | First release only; students in frozen snapshot with an attempt; no notice on re-release | On |
| `activity_scheduled` | First scheduling of an exercise in a classroom; claimed student seats; folded per classroom | Off |
| `activity_available` | Winning move of an exercise to running; claimed student seats; in-class delivery restricted to App | On, take-home only |
| `deadline_approaching` | Due non-poll evaluation/student pairs under the reminder rule below | On |
| `results_updated` | Visible final grade changes after a grading write; folded per evaluation | Off |
| `student_joined` | Student's own login claims a seat, not reverse claim during teacher import/e-mail edit; course staff, actor excluded; folded per classroom | Off |
| `roster_conflict` | Roster conflict needing attention; course staff, actor excluded; folded per classroom | On |
| `grading_ready` | Complete grading grid with proposals; course staff including the teacher who closed; not folded | On |
| `pool_question_added` | Every publication, first or later version; pool owner and contributor/owner shares, not readers or author; folded per pool | Off |
| `pool_shared`, `pool_ownership` | Existing sharing/ownership events for the affected account | On |
| `system_alert` | Admin health failure, continued failure after a day, or recovery; not folded; ADR-055 | E-mail on; Teams forbidden |

`activity_scheduled` claims `scheduled_announced_at` before sending. The marker is
never cleared by rescheduling or returning to draft, and never copied to a new
instance. `activity_available` follows each winning move to running, not lobby
entry or the nominal `opensAt`; both events exclude exams and polls. `announceMove`
is invoked after commit by the winning transition/start, not inside the lower-level
state CAS. An in-class exercise cannot leave App even if the recipient opted in.
Its current payload is `{ activityKind, activityId, activityTitle }`; scheduling
folds `{ classroomId, classroomName, count }`, with no individual opening date.

`pool_question_added` is emitted by the shared publication service after commit,
so editor, MCP and API import paths share the same rule. Notification failure must
not fail publication. `student_joined` and `roster_conflict` carry classroom/count,
not student identity; the roster is where the teacher reads the names.

### Deadline reminders

A minute ticker claims a pair only when ALL hold:

- evaluation is running, is not a poll, and has `closesAt`;
- `closesAt - 24 h <= now < closesAt`;
- `startedAt <= closesAt - 24 h`, excluding windows shorter than a day;
- student has a claimed non-staff classroom seat and NO finished attempt
  (`submitted` or `expired`), even if a later retake is open;
- no `(evaluation_id, user_id)` marker exists in `deadline_reminders`.

The common end applies in every timing mode; individual extensions are ignored.
The claim is one `INSERT … SELECT … ON CONFLICT DO NOTHING RETURNING`, and only
returned pairs are told. Markers never clear when the end moves or evaluation
reopens. Late scans catch up only before the end. Failed fan-out is logged per
evaluation, other evaluations continue, and claimed failures are not retried.
The payload has no date needing a recipient time zone; it says less than 24 hours.

### Grading-ready and changed results

`grading_ready` reads the committed grid: every attempt/item cell must have a
standing validated or proposed grading, and proposals must remain. It excludes
polls, running and paused evaluations and rechecks the current row. A conditional
claim on `grading_ready_at` wins once before fan-out, regardless of whether a pass
or runner job completed the last cells. Regrade returns the claim; reopening to
draft clears it. The count includes placeholder proposals requiring attention.
The asynchronous audience includes the teacher who closed the evaluation.
A crash after claim can lose a notice: at most once, not exactly once. Historical
backfill deliberately suppressed notices for evaluations already closed/grading/
released at migration, including incomplete grids then in flight.

`results_updated` hooks the single `writeGradings` writer, once per write/batch,
not per cell or inside `flagReleasedEvaluationsOf`. It reads shown grades before
the write and announces after its final transaction commits. Compare the FINAL
rounded grade, not changed points: frozen snapshot while unmodified, live validated
gradings of the kept attempt after modification, through the same `gradeShown`
rule as the results page. No extra grade snapshot is stored for notification.
Only owners whose result is currently visible and changed are told; never a staff
test, invisible feedback policy, missing attempt or release withdrawn meanwhile.

Regrade comparisons use `pointsAcrossRegrade`, the superseded grading without a
successor, to avoid comparing against the temporarily missing item. Restoring the
same points then sends nothing. Residual limitation: a superseded row does not
retain whether it was validated. A pending proposal stood down after release, or
a validated row stood down before release whose replacement was pending at release,
can therefore supply the wrong comparison baseline and miss a notice. Preserve
this limitation rather than promising that every grade change is announced.
The [historical Step 8](history/ADR-030-canaux-de-notification.md#step-8-results-updated)
retains the detailed cases.

Changed-result payloads contain evaluation/attempt ids and count, never grade.
The count supports folding, not the displayed sentence. Withdrawing release deletes
both released/updated bells; e-mails already sent cannot be withdrawn. Read-before
and send-after failures are logged and never fail the grading write or release.

### External transports and identity

E-mail uses Scaleway Transactional Email with the shared mailer settings. Without
both credentials it logs recipient/subject only and sends nothing. This is the
development/test/staging dry-run. The destination is the account's current e-mail.

Teams uses Graph activity-feed notifications with user-granted RSC
`TeamsActivity.Send.User`, through an app the user uploads. No tenant administrator
consent, bot resource or chat delivery is part of this design. Tenant policy can
still prohibit custom apps or user consent; those users retain App/e-mail.
Installation and Entra configuration belong in the
[Teams runbook](../development/teams.md), not in application decision history.

The personal Teams tab cannot use Quiz SameSite cookies; it gets Teams SSO instead.
Its sessionless endpoint verifies RS256 signature, exact tenant-derived Entra v2
issuer, our audience, delegated `access_as_user`, a Teams client id, tenant allowlist,
expiry/not-before with five minutes of skew, object id, and `idtyp` not `app`.
Entra's keys come from the common key set, cached a day and re-read at most every
five minutes for an unknown key. Production refuses enabled Teams with an empty
tenant allowlist. The endpoint, `POST /app/api/notifications/teams/tab`, reads no
cookie (so no CSRF), answers `Cache-Control: no-store` and 404 while Teams is off;
a tenant outside the allowlist gets 403 `tenant_not_allowed`, any other refusal a
401 and a `teams tab refused` log line naming the reason, never the token. It returns only that identity's link state or a 15-minute,
random 32-byte, SHA-256-stored link token. Issuance is serialized per identity and
replaces outstanding tokens; there is no issuance cooldown. The `/teams/link` page
previews without consuming; a Quiz browser session and CSRF-protected confirmation
consume it, the token in a body and one conditional UPDATE deciding, checking the
tenant again. The confirmation names Microsoft
account and organization; its address need not equal edu-ID's. One Teams identity
links to one Quiz account and vice versa (UNIQUE `(tenant_id, aad_object_id)`).
Confirming a token of an identity already linked to another account MOVES the link
(audited `teams.unlink`, `{ via: "moved", to }`), and a new link replaces the
account's previous one.

A malicious same-tenant user could forward their genuine linking URL: confirmation
and the named identity mitigate that residual consent-phishing risk, they do not
cryptographically prove both accounts belong to one human. Payload minimization
bounds the exposure. Link URLs/return paths and authorization headers are redacted.

Graph credentials are obtained for the recipient's tenant and cached to just before
expiry. The manifest declares each Teams-supported activity type, excluding
`system_alert`; catalogue tests enforce completeness. That list alone may run
ahead of the catalogue, so one manifest bump can declare the types of kinds still
to be emitted. Bundle newly added kinds into
one manifest update, since users may need to reinstall. Teams renders its template
in Teams' language and the server preview in Quiz locale, capped at 150 characters.
Deep links are parsed into a known router route and rebuilt under the app's origin,
never followed as an arbitrary supplied URL.

Jobs re-read account, locale, link and allowed tenant. Missing/anonymized users,
invalid old payloads, removed links and no-longer-allowed tenants are dropped.
Admin payloads additionally require the current admin role. Graph 400/403/404 are
permanent failures and not retried; the link stays for a user to repair installation.
Token/configuration failures and other transport errors are retried. Disabling
Teams credentials hides its channel/routes without deleting links. Disabling mail
credentials restores dry-run. Returning to the historical bot requires a migration
and cannot reconstruct chats for links made by the current design.

### Accepted project extension, not a delivered catalogue

Merge decision D18 accepts student kinds `project_published`,
`project_deadline_reminder`, `project_repo_invited`, `project_grade_final`, and staff
kinds `project_deadline_applied`, `project_provision_failed`, `github_org_lost`.
E-mail/Teams default on for reminder, invitation, final grade, provisioning failure
and lost organization; off for the others. They must use the same notification
entry, locale and per-kind preferences, not port classroom e-mails independently.
Only `activity_available` has already adopted the neutral activity payload; remaining
migration boundaries are I58–I60 in `docs/merge/07-incompatibilities.md`.
Old classroom unsubscribe links are planned to lead to Quiz notification settings.
A kind enters settings with its emitter, never as a toggle that does nothing.

## Consequences and alternatives

External provider failures cost jobs/logs, not failed business transactions. Claim
markers favor avoiding duplicates over guaranteed delivery. Browser push, digests,
per-course muting and configurable reminder delays remain out of scope. Always
writing disabled bell rows, sending inline, per-user webhook secrets and stored
delegated Microsoft credentials were rejected. See the archive for the two prior
Teams designs and why their tenant/operational requirements failed.

## Implementation references

- `packages/contracts/src/notifications.ts`: payloads, kinds, audiences and defaults.
- `apps/api/src/modules/notifications/{service,outbox,jobs,deadline,templates}.ts`:
  fan-out, aggregation, delivery and reminder claims.
- `apps/api/src/db/notifications.ts`: folded targets and partial unique indexes.
- `apps/api/src/modules/{evaluation/announce,grading/ready,results/updated}.ts` and
  `grading/service.ts`: committed event hooks and grade comparison.
- `apps/api/src/modules/notifications/{ssoAuth,teamsLink,teams,teamsApp}.ts`: Teams
  identity, installation and transport; associated database/unit tests.
- `apps/web/src/notifications/toasts.ts`, `App.tsx`: live baseline and quiet pages.

## Historical section references

Original numbered decisions and addenda are historical. These compatibility
anchors lead to their full text; apply the consolidated decision above.

Where an old number cited in code or another record now lives:

| Old reference | Current section |
| --- | --- |
| §1 `notify` the one entry; §h best-effort after commit | [One entry, after commit](#one-entry-after-commit) |
| §2 rendering and locale; §5 preferences; §b defaults | [Preferences, audiences and payloads](#preferences-audiences-and-payloads) |
| §a bell and toast; §e aggregation; §h quiet pages and throttle; Step 4 | [App aggregation and live toasts](#app-aggregation-and-live-toasts) |
| §c the kinds; §6 `results_released`; Step 6 | [Events and trigger boundaries](#events-and-trigger-boundaries) |
| §d `deadline_approaching`; Step 7 | [Deadline reminders](#deadline-reminders) |
| Step 5 (`grading_ready`); Step 8 (`results_updated`) | [Grading-ready and changed results](#grading-ready-and-changed-results) |
| §3 e-mail; §4 Teams; §f fan-out and manifest | [External transports and identity](#external-transports-and-identity) |
| §g out of scope; Rollback; Alternatives considered | [Consequences and alternatives](#consequences-and-alternatives) |

<a id="adr-030-notification-channels-the-bell-e-mail-and-microsoft-teams"></a>
- [ADR-030 — Notification channels: the bell, e-mail and Microsoft Teams](history/ADR-030-canaux-de-notification.md#adr-030-notification-channels-the-bell-e-mail-and-microsoft-teams)
<a id="reading-map"></a>
- [Reading map](history/ADR-030-canaux-de-notification.md#reading-map)
<a id="1-notify-stays-the-one-entry-external-channels-are-jobs"></a>
- [1. `notify` stays the one entry; external channels are jobs](history/ADR-030-canaux-de-notification.md#1-notify-stays-the-one-entry-external-channels-are-jobs)
<a id="2-the-message-is-rendered-when-the-job-runs-in-the-recipients-language"></a>
- [2. The message is rendered when the job runs, in the recipient's language](history/ADR-030-canaux-de-notification.md#2-the-message-is-rendered-when-the-job-runs-in-the-recipients-language)
<a id="3-e-mail-heig-classrooms-mailer-unchanged-in-substance"></a>
- [3. E-mail: heig-classroom's mailer, unchanged in substance](history/ADR-030-canaux-de-notification.md#3-e-mail-heig-classrooms-mailer-unchanged-in-substance)
<a id="4-teams-activity-feed-notifications-through-microsoft-graph"></a>
- [4. Teams: activity-feed notifications through Microsoft Graph](history/ADR-030-canaux-de-notification.md#4-teams-activity-feed-notifications-through-microsoft-graph)
<a id="5-preferences-a-sparse-table-defaults-in-the-contracts"></a>
- [5. Preferences: a sparse table, defaults in the contracts](history/ADR-030-canaux-de-notification.md#5-preferences-a-sparse-table-defaults-in-the-contracts)
<a id="6-results_released"></a>
- [6. `results_released`](history/ADR-030-canaux-de-notification.md#6-results_released)
<a id="consequences"></a>
- [Consequences](history/ADR-030-canaux-de-notification.md#consequences)
<a id="rollback"></a>
- [Rollback](history/ADR-030-canaux-de-notification.md#rollback)
<a id="alternatives-considered"></a>
- [Alternatives considered](history/ADR-030-canaux-de-notification.md#alternatives-considered)
<a id="addendum-2026-09-28-one-system-per-kind-defaults-eight-new-kinds-198"></a>
- [Addendum (2026-09-28): one system, per-kind defaults, eight new kinds (#198)](history/ADR-030-canaux-de-notification.md#addendum-2026-09-28-one-system-per-kind-defaults-eight-new-kinds-198)
<a id="a-the-app-channel-is-the-bell-plus-the-toast"></a>
- [a. The App channel is the bell plus the toast](history/ADR-030-canaux-de-notification.md#a-the-app-channel-is-the-bell-plus-the-toast)
<a id="b-defaults-per-kind"></a>
- [b. Defaults per kind](history/ADR-030-canaux-de-notification.md#b-defaults-per-kind)
<a id="c-the-kinds"></a>
- [c. The kinds](history/ADR-030-canaux-de-notification.md#c-the-kinds)
<a id="d-deadline_approaching-keyed-on-closesat-alone"></a>
- [d. `deadline_approaching`: keyed on `closesAt` alone](history/ADR-030-canaux-de-notification.md#d-deadline_approaching-keyed-on-closesat-alone)
<a id="e-aggregation"></a>
- [e. Aggregation](history/ADR-030-canaux-de-notification.md#e-aggregation)
<a id="f-fan-out-teams-order-of-the-work"></a>
- [f. Fan-out, Teams, order of the work](history/ADR-030-canaux-de-notification.md#f-fan-out-teams-order-of-the-work)
<a id="g-out-of-scope"></a>
- [g. Out of scope](history/ADR-030-canaux-de-notification.md#g-out-of-scope)
<a id="h-decisions-of-2026-09-28-evening"></a>
- [h. Decisions of 2026-09-28 (evening)](history/ADR-030-canaux-de-notification.md#h-decisions-of-2026-09-28-evening)
<a id="step-4-fold-writes-and-teams-manifest"></a>
- [Step 4: Fold writes and Teams manifest](history/ADR-030-canaux-de-notification.md#step-4-fold-writes-and-teams-manifest)
<a id="step-5-grading-ready-and-pool-publication"></a>
- [Step 5: Grading ready and pool publication](history/ADR-030-canaux-de-notification.md#step-5-grading-ready-and-pool-publication)
<a id="step-6-scheduled-and-available-activities"></a>
- [Step 6: Scheduled and available activities](history/ADR-030-canaux-de-notification.md#step-6-scheduled-and-available-activities)
<a id="step-7-deadline-reminders"></a>
- [Step 7: Deadline reminders](history/ADR-030-canaux-de-notification.md#step-7-deadline-reminders)
<a id="step-8-results-updated"></a>
- [Step 8: Results updated](history/ADR-030-canaux-de-notification.md#step-8-results-updated)
