# ADR-030 — Notification channels and delivery rules

## Status

Accepted (2026-09-26), consolidated through the 2026-10-01 amendments without
changing a decision. The project kinds (addendum of 2026-10-04, merge decision
D18, delivered by merge task M3-09b) are folded into rules 5, 7, 10, 12, 15, 19,
20 and 30 (2026-10-09); the contracts hold nineteen kinds.

Relations: extended by [ADR-053](ADR-053-retrait-des-codes-d-entree.md) (no
classroom join codes), [ADR-055](ADR-055-etat-du-systeme.md) (admin system
alerts) and [ADR-035](ADR-035-fusion-de-classroom.md) (project kinds for the
merge). The [historical record](history/ADR-030-canaux-de-notification.md) keeps
the rejected Teams transports, the migration sequence, the implementation steps
and the original section numbers; where this record is silent on a detail (an
exact log line, a migration step) the archive still describes the
implementation, and this record wins wherever both speak.

## Context

Users need to hear about work without keeping Quiz open. Slow or failing external
providers must not delay or undo the action that caused a notice. One system owns
the App inbox/toasts, e-mail and Teams, with preferences per account and kind.

## Decision

### One entry, after commit

**1.** Every module uses `notifyMany`; `notify` is its one-recipient case;
`notifyUsers` (`notifications/service.ts`) sends one payload to an audience,
best-effort, the way every module tells people of a committed fact, and
`classroomStaffIds` (`org/service.ts`) is the one staff audience of a classroom.
Call after the announced write commits, never from its transaction: pg-boss has
its own connection, so a queued job would survive a business rollback.
Notification failures are best-effort and must not turn a committed business
action into an apparent failure. This is not a transactional outbox or an
exactly-once delivery guarantee.

**2.** The App channel (`bell` internally) writes a row and recipient refresh
hint only when enabled. Off means no row, badge increment or toast.

**3.** Each selected external channel gets a `notifications.deliver` job
containing recipient, channel and payload, not a bell-row reference: App may be
off or its row deleted. Providers never run inline. The outbox is handed its
queue at boot; while closed (tests, jobs disabled, queue startup failure) only
App works, with no inline fallback. Enqueue failures are logged. Jobs retry with
exponential backoff and retry limit five; development's in-process queue logs
failures rather than promising production retries.

### Preferences, audiences and payloads

**4.** `notification_preferences` stores only changed toggles, keyed by
user/kind/channel. Missing values come from `DEFAULT_CHANNEL_ENABLED` in
`@quiz/contracts`, a `Record<NotificationKind, …>`: a kind without its defaults
is a compile error. The recipient's preferences are intersected with a
delivery's allowed channels and `KIND_CHANNELS`; preferences cannot widen either
restriction. App is on by default. Linking Teams is the account's opt-in before
its enabled kinds can use that channel.

**5.** The catalogue, defaults and audience declarations live together in
`packages/contracts/src/notifications.ts`, not in a second settings-specific
list. Seat kinds target claimed non-staff enrollment seats, course kinds target
course staff seats (not a seatless admin), pool kinds target eligible
teacher/admin pool members, and admin kinds target the admin role. The settings
list follows those capabilities: students see seat kinds before enrollment;
teachers/admins need a student seat for those kinds, and an admin needs a course
seat for course kinds. Teachers can configure course kinds before receiving a
seat. The project kinds enter the grid with their emitters: on a platform
without Quiz's GitHub App (`GITHUB_APP_ID` unset) they are never sent and not
listed (`GITHUB_KINDS`, `notificationKindsFor({ github })`) — a toggle that does
nothing is a lie.

**6.** Every kind has its sentence in `en` and `fr` twice: in the API's
`templates.ts` (e-mail, Teams), whose `fr` is typed
`Record<keyof typeof en, string>`, and in the web dictionary (bell, toast). A
missing French sentence is a compile error.

**7.** Payloads carry identifiers, titles and counts, never grades, points,
answers, question content, student names or student e-mail. Teacher names in
sharing and ownership notices are deliberate exceptions. System alerts carry
check keys only. Project payloads carry the project's id and name and counts,
never a score, a login or a student's name (N-SEC-20); the entry opens the
project (`/projects/:id`, the student's view of it for a student),
`github_org_lost` the classroom's Settings.

**8.** External messages are rendered when the job runs, in the recipient's
current locale (English if unset); user text is HTML-escaped and subjects
flattened. Links use `WEB_URL`, defaulting to `PUBLIC_URL`. Settings are the
preference entry point; there is no separate unsubscribe-token endpoint. Old
classroom unsubscribe links are planned to lead to Quiz notification settings.

### App aggregation and live toasts

**9.** A folded kind maintains one UNREAD entry per user and target. One atomic
upsert adds the incoming count, replaces the latest descriptive payload and
refreshes `createdAt`; after the row is read the next event creates another.
Partial unique indexes are per kind and target, with the kind predicate written
as a SQL literal. `NOTIFICATION_FOLD_TARGETS` owns the mapping; schema, writer
and migration tests agree on it. Do not use a nullable multi-target unique index
or read-then-write. Only App folds: enabled external channels still send one
message per event.

**10.** A project fold target (2026-10-04): `notifications.project_id` lifts the
payload's `projectId` (a foreign key: a deleted project takes its bells), and
`NOTIFICATION_FOLD_TARGETS` gains `project_deadline_applied` and
`project_provision_failed` on it — one unread entry per recipient and project,
the partial unique indexes generated as for the other targets (migration
`0068`). F-NOTIF-12's list is amended accordingly. The latest payload wins the
fold, so a `project_provision_failed` entry names the LAST failure's `reason`.

**11.** The notification stream carries a hint, not payload data. Clients
refetch their own inbox, then toast new unread `(id, createdAt)` pairs. The
first read after connection, reconnection or leaving a quiet page establishes a
baseline and toasts nothing. Attempts, projections, other full-screen pages and
the live dashboard stay quiet. A folded entry toasts at most once in five
minutes. Several open tabs may each toast; that duplication is accepted.
Immediate feedback from the user's own action (`useToast`) is separate and is
never gated by notification preferences.

### Events and trigger boundaries

**12.** The kinds below; the external-default column means both e-mail and Teams
unless stated otherwise. App is on for all. The predicates are part of the
decision, not mere UI hints. The project kinds (F-NOTIF-13, accepted by merge
decision D18, delivered by M3-09b) use the same notification entry, locale and
per-kind preferences as every other kind; nothing of heig-classroom's mails was
ported independently, and its `grade.final` mail on the final review is dropped
(F-PROJ-15: the score reaches a student with the release).

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
| `project_published` | `publishProject` committed, by hand or by the ticker (once: a draft publishes once); the classroom's claimed student seats; not folded | Off |
| `project_deadline_reminder` | 24 h before the student's EFFECTIVE deadline, claimed and sent in one tick (rule 19); claimed student seats | On |
| `project_repo_invited` | Accept provisioned the repository in THIS request and GitHub left the invitation pending; the student; never on an idempotent repeat nor a resend | On |
| `project_grade_final` | FIRST release only (`ProjectReleaseResult.first`); the students of the repositories the release covered, a staff seat's never; no score carried | On |
| `project_deadline_applied` | A `project.deadline` job pass that locked or committed on at least one repository; the course staff; folded per project with the count | Off |
| `project_provision_failed` | A row's FIRST provisioning failure, never an invitation GitHub refused; the course staff; folded per project, `reason` the latest (`repo_name_taken`, `github_error`) | On |
| `github_org_lost` | The installation an organization held forgotten — uninstalled, deleted with it, or a 404 the healing met —; the course staff of each non-archived linked classroom, one entry per classroom; not folded; a suspension tells nobody | On |

**13.** `activity_scheduled` claims `scheduled_announced_at` before sending. The
marker is never cleared by rescheduling or returning to draft, and never copied
to a new instance. `activity_available` follows each winning move to running,
not lobby entry or the nominal `opensAt`; both events exclude exams and polls.
`announceMove` is invoked after commit by the winning transition/start, not
inside the lower-level state CAS. An in-class exercise cannot leave App even if
the recipient opted in. Its current payload is
`{ activityKind, activityId, activityTitle }`; scheduling folds
`{ classroomId, classroomName, count }`, with no individual opening date.

**14.** `pool_question_added` is emitted by the shared publication service after
commit, so editor, MCP and API import paths share the same rule. Notification
failure must not fail publication. `student_joined` and `roster_conflict` carry
classroom/count, not student identity; the roster is where the teacher reads the
names.

**15.** A lost organization: the notice follows the ROW's transition and
GitHub's STATE, never a webhook's words. The installation an organization held
is forgotten by `forgetInstallation` when GitHub no longer has it (an
`installation` webhook of any action re-read against
`GET /app/installations/{id}`, the listing, the healing's 404), or by
`markOrgDeleted` when the organization goes with its installation; each tells
the staff once. A SUSPENDED installation is not lost: GitHub still has it and
lifts the suspension, so the row keeps its `installation_id` with
`github_organizations.suspended_at` set (audited `installation_suspended` on
each change) and the App acts on it as on none — `installed()` is the one rule,
installed AND not suspended AND active, the listing, the connect sheet, the
projects and the journal reading it alike — and a deletion after a suspension is
still the installation going away, told once. An organization whose App was
already gone tells nobody again when deleted; a row retired because another
organization took its login (`retireLoginHolders`) tells nobody, a rename race
being the likelier reading. GitHub's sender is no Quiz account, so F-NOTIF-11's
"own action" cannot apply.

**16.** Only `activity_available` has adopted the neutral activity payload; the
remaining boundaries are I58–I60 in `docs/merge/07-incompatibilities.md`.

### Deadline reminders

**17.** A minute ticker claims an evaluation/student pair only when ALL hold:

- evaluation is running, is not a poll, and has `closesAt`;
- `closesAt - 24 h <= now < closesAt`;
- `startedAt <= closesAt - 24 h`, excluding windows shorter than a day;
- student has a claimed non-staff classroom seat and NO finished attempt
  (`submitted` or `expired`), even if a later retake is open;
- no `(evaluation_id, user_id)` marker exists in `deadline_reminders`.

**18.** The common end applies in every timing mode; individual extensions are
ignored. The claim is one `INSERT … SELECT … ON CONFLICT DO NOTHING RETURNING`,
and only returned pairs are told. Markers never clear when the end moves or
evaluation reopens. Late scans catch up only before the end. Failed fan-out is
logged per evaluation, other evaluations continue, and claimed failures are not
retried. The payload has no date needing a recipient time zone; it says less
than 24 hours.

**19.** The project reminder mirrors rules 17–18 on the student's EFFECTIVE
deadline (their repository's own, else the project's), 24 hours before it — the
one `DEADLINE_REMINDER_MS` of `@quiz/domain`, the evaluations' too —, with two
claims in the project ticker (`projectTick`, every 20 s), each a conditional
UPDATE whose returned rows alone are told: `projects.reminder_sent_at` claims
the students under the project's deadline — every claimed student seat of the
classroom, repository or not, except the members (individual or group) of a
repository with its own deadline, a deleted one or one the staff locked by hand
—; `project_repos.reminder_sent_at` claims the members of a repository with its
own deadline.

- **Window rule**: as the evaluation scan reads `started_at`, both scans require
  the project's `start_at` to lie at least 24 hours before the deadline they
  read — a project published, or a repository handed its own deadline, within a
  day of it tells nobody; an own deadline given within a day on a project open
  for longer is reminded (the student's window is their time in the project).
- **Re-arm rule**: a deadline that moves (a project's patch, a repository's own
  deadline, a reopen) nulls the matching claim only when the new effective
  deadline is more than 24 hours away (`reminderClaimAfterMove`, the one domain
  rule); otherwise the claim stays — a reminder sent is never sent again, one
  still owed on a deadline brought nearer is still owed. A repository whose own
  deadline is taken back falls under the project's claim again: when that claim
  fired already, its members were reminded of their own deadline and are not
  reminded of the project's.
- The scan never reminds after the deadline, skips drafts, archived projects and
  archived classrooms, and a late pass catches up while the deadline lies ahead.

**20.** For the import (M8-01): `projects.reminder_sent_at` and
`project_repos.reminder_sent_at` are null = owed. The import must set them to
the import time for every imported project or repository whose effective
deadline lies within 24 hours of the import, or the first tick sends a burst; a
deadline further ahead is legitimately reminded later and may stay null;
heig-classroom's own marker, when one exists, is copied as it is.

### Grading-ready and changed results

**21.** `grading_ready` reads the committed grid: every attempt/item cell must
have a standing validated or proposed grading, and proposals must remain. It
excludes polls, running and paused evaluations and rechecks the current row. A
conditional claim on `grading_ready_at` wins once before fan-out, regardless of
whether a pass or runner job completed the last cells. Regrade returns the
claim; reopening to draft clears it. The count includes placeholder proposals
requiring attention. The asynchronous audience includes the teacher who closed
the evaluation. A crash after claim can lose a notice: at most once, not exactly
once. Historical backfill deliberately suppressed notices for evaluations
already closed/grading/released at migration, including incomplete grids then in
flight.

**22.** `results_updated` hooks the single `writeGradings` writer, once per
write/batch, not per cell or inside `flagReleasedEvaluationsOf`. It reads shown
grades before the write and announces after its final transaction commits.
Compare the FINAL rounded grade, not changed points: frozen snapshot while
unmodified, live validated gradings of the kept attempt after modification,
through the same `gradeShown` rule as the results page. No extra grade snapshot
is stored for notification. Only owners whose result is currently visible and
changed are told; never a staff test, invisible feedback policy, missing attempt
or release withdrawn meanwhile.

**23.** Regrade comparisons use `pointsAcrossRegrade`, the superseded grading
without a successor, to avoid comparing against the temporarily missing item.
Restoring the same points then sends nothing. Residual limitation: a superseded
row does not retain whether it was validated. A pending proposal stood down
after release, or a validated row stood down before release whose replacement
was pending at release, can therefore supply the wrong comparison baseline and
miss a notice. Preserve this limitation rather than promising that every grade
change is announced. The [historical Step
8](history/ADR-030-canaux-de-notification.md#step-8-results-updated) retains the
detailed cases.

**24.** Changed-result payloads contain evaluation/attempt ids and count, never
grade. The count supports folding, not the displayed sentence. Withdrawing
release deletes both released/updated bells; e-mails already sent cannot be
withdrawn. Read-before and send-after failures are logged and never fail the
grading write or release.

### External transports and identity

**25.** E-mail uses Scaleway Transactional Email with the shared mailer
settings. Without both credentials it logs recipient/subject only and sends
nothing. This is the development/test/staging dry-run. The destination is the
account's current e-mail.

**26.** Teams uses Graph activity-feed notifications with user-granted RSC
`TeamsActivity.Send.User`, through an app the user uploads. No tenant
administrator consent, bot resource or chat delivery is part of this design.
Tenant policy can still prohibit custom apps or user consent; those users retain
App/e-mail. Installation and Entra configuration belong in the [Teams
runbook](../development/teams.md), not in application decision history.

**27.** The personal Teams tab cannot use Quiz SameSite cookies; it gets Teams
SSO instead. Its sessionless endpoint verifies RS256 signature, exact
tenant-derived Entra v2 issuer, our audience, delegated `access_as_user`, a
Teams client id, tenant allowlist, expiry/not-before with five minutes of skew,
object id, and `idtyp` not `app`. Entra's keys come from the common key set,
cached a day and re-read at most every five minutes for an unknown key.
Production refuses enabled Teams with an empty tenant allowlist. The endpoint,
`POST /app/api/notifications/teams/tab`, reads no cookie (so no CSRF), answers
`Cache-Control: no-store` and 404 while Teams is off; a tenant outside the
allowlist gets 403 `tenant_not_allowed`, any other refusal a 401 and a
`teams tab refused` log line naming the reason, never the token. It returns only
that identity's link state or a 15-minute, random 32-byte, SHA-256-stored link
token.

**28.** Issuance is serialized per identity and replaces outstanding tokens;
there is no issuance cooldown. The `/teams/link` page previews without
consuming; a Quiz browser session and CSRF-protected confirmation consume it,
the token in a body and one conditional UPDATE deciding, checking the tenant
again. The confirmation names Microsoft account and organization; its address
need not equal edu-ID's. One Teams identity links to one Quiz account and vice
versa (UNIQUE `(tenant_id, aad_object_id)`). Confirming a token of an identity
already linked to another account MOVES the link (audited `teams.unlink`,
`{ via: "moved", to }`), and a new link replaces the account's previous one.

**29.** A malicious same-tenant user could forward their genuine linking URL:
confirmation and the named identity mitigate that residual consent-phishing
risk, they do not cryptographically prove both accounts belong to one human.
Payload minimization bounds the exposure. Link URLs/return paths and
authorization headers are redacted.

**30.** Graph credentials are obtained for the recipient's tenant and cached to
just before expiry. The manifest declares each Teams-supported activity type,
excluding `system_alert`; catalogue tests enforce completeness. That list alone
may run ahead of the catalogue, so one manifest bump can declare the types of
kinds still to be emitted. Bundle newly added kinds into one manifest update,
since users may need to reinstall (the seven project activity types were
declared in ONE bump, `TEAMS_APP_VERSION` 2.1.0 → 2.2.0). Teams renders its
template in Teams' language and the server preview in Quiz locale, capped at 150
characters. Deep links are parsed into a known router route and rebuilt under
the app's origin, never followed as an arbitrary supplied URL.

**31.** Jobs re-read account, locale, link and allowed tenant.
Missing/anonymized users, invalid old payloads, removed links and
no-longer-allowed tenants are dropped. Admin payloads additionally require the
current admin role. Graph 400/403/404 are permanent failures and not retried;
the link stays for a user to repair installation. Token/configuration failures
and other transport errors are retried. Disabling Teams credentials hides its
channel/routes without deleting links. Disabling mail credentials restores
dry-run. Returning to the historical bot requires a migration and cannot
reconstruct chats for links made by the current design.

## Consequences

External provider failures cost jobs/logs, not failed business transactions.
Claim markers favor avoiding duplicates over guaranteed delivery. Browser push,
digests, per-course muting and configurable reminder delays remain out of scope.

Where the rules live: `packages/contracts/src/notifications.ts` (payloads, kinds,
audiences, defaults); `apps/api/src/modules/notifications/{service,outbox,jobs,deadline,templates}.ts`
(fan-out, aggregation, delivery, reminder claims); `apps/api/src/db/notifications.ts`
(folded targets, partial unique indexes); `apps/api/src/modules/{evaluation/announce,grading/ready,results/updated}.ts`
and `grading/service.ts` (committed event hooks, grade comparison);
`apps/api/src/modules/project/notify.ts` (audiences, the reminder's claims, the
sends), the trigger sites in `project/{lifecycle,accept,grades,jobs,deadline}.ts`
and `github/service.ts` (`orgLost`), `@quiz/domain/deadlineReminder.ts`;
`apps/api/src/modules/notifications/{ssoAuth,teamsLink,teams,teamsApp}.ts` (Teams
identity, installation, transport) and their database/unit tests;
`apps/web/src/notifications/toasts.ts`, `App.tsx` (live baseline, quiet pages).

## Alternatives considered

Always writing disabled bell rows, sending inline, per-user webhook secrets and
stored delegated Microsoft credentials were rejected. See the archive for the two
prior Teams designs and why their tenant/operational requirements failed.

## Correspondence of old references

Original numbered decisions, the lettered points of the 2026-09-28 addendum, the
implementation steps and this record's former section headings are historical;
apply the rules above. The full text of the first three is the
[historical record](history/ADR-030-canaux-de-notification.md). A citation in
code or another record ("ADR-030 §h", "ADR-030, addendum §c; #198 step 5")
lives here now:

<a id="adr-030-notification-channels-the-bell-e-mail-and-microsoft-teams"></a><a id="reading-map"></a><a id="1-notify-stays-the-one-entry-external-channels-are-jobs"></a><a id="2-the-message-is-rendered-when-the-job-runs-in-the-recipients-language"></a><a id="3-e-mail-heig-classrooms-mailer-unchanged-in-substance"></a><a id="4-teams-activity-feed-notifications-through-microsoft-graph"></a><a id="5-preferences-a-sparse-table-defaults-in-the-contracts"></a><a id="6-results_released"></a><a id="rollback"></a><a id="addendum-2026-09-28-one-system-per-kind-defaults-eight-new-kinds-198"></a><a id="a-the-app-channel-is-the-bell-plus-the-toast"></a><a id="b-defaults-per-kind"></a><a id="c-the-kinds"></a><a id="d-deadline_approaching-keyed-on-closesat-alone"></a><a id="e-aggregation"></a><a id="f-fan-out-teams-order-of-the-work"></a><a id="g-out-of-scope"></a><a id="h-decisions-of-2026-09-28-evening"></a><a id="step-4-fold-writes-and-teams-manifest"></a><a id="step-5-grading-ready-and-pool-publication"></a><a id="step-6-scheduled-and-available-activities"></a><a id="step-7-deadline-reminders"></a><a id="step-8-results-updated"></a><a id="the-project-kinds-addendum-of-2026-10-04-merge-task-m3-09b"></a><a id="consequences-and-alternatives"></a><a id="implementation-references"></a><a id="historical-section-references"></a>

| Old reference | Rules now | Full text |
| --- | --- | --- |
| §1 `notify` the one entry; §f fan-out after commit; §h best-effort after commit | [1–3](#one-entry-after-commit) | [§f](history/ADR-030-canaux-de-notification.md#f-fan-out-teams-order-of-the-work), [§h](history/ADR-030-canaux-de-notification.md#h-decisions-of-2026-09-28-evening) |
| §2 rendering and locale; §5 preferences; §b defaults | [4–8](#preferences-audiences-and-payloads) | [§1–§6](history/ADR-030-canaux-de-notification.md#decision), [§b](history/ADR-030-canaux-de-notification.md#b-defaults-per-kind) |
| §a bell and toast; §e aggregation; §h.2 quiet pages and throttle; Step 4 | [9–11](#app-aggregation-and-live-toasts) | [§a](history/ADR-030-canaux-de-notification.md#a-the-app-channel-is-the-bell-plus-the-toast), [§e](history/ADR-030-canaux-de-notification.md#e-aggregation), [§h](history/ADR-030-canaux-de-notification.md#h-decisions-of-2026-09-28-evening), [Step 4](history/ADR-030-canaux-de-notification.md#step-4-fold-writes-and-teams-manifest) |
| §c the kinds; §6 `results_released`; §h.1 `activity_scheduled`; §h.3 take-home only; Step 6; the addenda of 2026-09-30 (project kinds, ADR-035; the admin kind, ADR-055) | [12–16](#events-and-trigger-boundaries), [Status](#status) | [§c](history/ADR-030-canaux-de-notification.md#c-the-kinds), [§h](history/ADR-030-canaux-de-notification.md#h-decisions-of-2026-09-28-evening), [Step 6](history/ADR-030-canaux-de-notification.md#step-6-scheduled-and-available-activities), [2026-09-30](history/ADR-030-canaux-de-notification.md#status) |
| §d `deadline_approaching`; Step 7 | [17–18](#deadline-reminders) | [§d](history/ADR-030-canaux-de-notification.md#d-deadline_approaching-keyed-on-closesat-alone), [Step 7](history/ADR-030-canaux-de-notification.md#step-7-deadline-reminders) |
| Step 5 (`grading_ready`); §h.4–5 and Step 8 (`results_updated`) | [21–24](#grading-ready-and-changed-results) | [Step 5](history/ADR-030-canaux-de-notification.md#step-5-grading-ready-and-pool-publication), [§h](history/ADR-030-canaux-de-notification.md#h-decisions-of-2026-09-28-evening), [Step 8](history/ADR-030-canaux-de-notification.md#step-8-results-updated) |
| §3 e-mail; §4 Teams; §f manifest | [25–31](#external-transports-and-identity) | [§4](history/ADR-030-canaux-de-notification.md#4-teams-activity-feed-notifications-through-microsoft-graph), [§f](history/ADR-030-canaux-de-notification.md#f-fan-out-teams-order-of-the-work), [Step 4](history/ADR-030-canaux-de-notification.md#step-4-fold-writes-and-teams-manifest) |
| The project kinds (addendum of 2026-10-04, M3-09b): kinds, Settings, project fold target, reminder, lost organization, import, manifest bump | kinds and payloads 7, 12; Settings 5; fold target 10; lost organization 15; reminder 19; import 20; manifest 30 | — |
| §g out of scope; Rollback; Alternatives considered; former "Consequences and alternatives" | [Consequences](#consequences), [Alternatives considered](#alternatives-considered) | [archive](history/ADR-030-canaux-de-notification.md) |
| Former "Implementation references" | [Consequences](#consequences) | — |

Amended 2026-10-09: the list of compatibility anchors into the historical record
was reduced to this table (the references that code and records cite) and bare
compatibility anchors, so old links still land here; the full text stays in
[history/ADR-030](history/ADR-030-canaux-de-notification.md). The same day the
record was condensed into numbered rules and the project-kinds addendum folded
into them (no decision changed).
