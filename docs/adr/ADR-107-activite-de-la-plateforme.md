# ADR-107 — Platform activity for the administrator: hours of activity per person, read in aggregate only, kept eight days

## Status

Accepted (2026-10-12, the product owner's request and decisions of that day; the
defaults marked as such below were set by the orchestrator's spec challenge).
Delivery progress lives in `changes/`.

Scope: what the platform records of when people use it, what the administrator
reads of it, and how long it is kept. Not the presence of a student in a live
evaluation (ADR-020), not the integrity journal (ADR-088).

Relations: adds F-ADMIN-09; amends N-DATA-02, N-DATA-03 and N-DATA-07; relies on
the session kinds of [ADR-027](ADR-027-tickets-de-lancement-et-sessions-typees.md)
and [ADR-051](ADR-051-postes-kiosque-attestes.md), the impersonation of
[ADR-034](ADR-034-agir-en-tant-qu-etudiant.md), the tokens of
[ADR-022](ADR-022-jetons-api-et-serveur-mcp.md) and
[ADR-023](ADR-023-serveur-oauth-pour-mcp.md), and the scheduled tasks (F-ADMIN-06).

## Context

The owner wants to see, from the administration, how many people use the platform,
when they last did, and at which hours and days of the last week — in particular
whether students work outside class hours, in the evening. Nothing recorded this:
`users.last_login_at` moves at sign-in only, and a session lives for days. The
platform must not turn that need into a per-person timeline (N-DATA-01, data
minimisation), and the data must be explainable on the privacy page (N-DATA-07).

## Decision

1. **What is recorded.** Two tables, owned and alone written by the `presence`
   module (`apps/api/src/modules/presence/`, `db/presence.ts`); `users` is not
   touched:
   - `presence_hours (user_id, hour)`: one row per person and hour of the server's
     clock (truncated to the hour) in which a request of that person's own session
     reached the server. Primary key `(user_id, hour)`, `ON CONFLICT DO NOTHING`.
   - `presence_last_seen (user_id, at)`: the time of that person's last such
     request, one row per person, upserted with `GREATEST`, so it only moves
     forward.

   An in-memory dedupe per process queues at most one hour row per person and
   hour, and one last-seen row per person every five minutes. The queue is
   written every few seconds as one multi-row insert per table, so the start of
   an exam costs two statements, not one per student. Nothing of it is on the
   request's path: queueing never throws into the request, and a failed batch
   is logged and its rows forgotten from the dedupe, so the person's next
   request queues them again. The server's clock dates them (invariant 5).
2. **What counts as activity.** A request of a `portal`, `seb` or `kiosk` session
   of the person's own. Never an `impersonation` session (the admin is not the
   student, ADR-034), a personal API token or an OAuth token (ADR-022, ADR-023),
   the online workspace's service route (ADR-078), or an anonymous guest. Never
   background traffic either: a route declares it (`config.background`, today the
   event stream `/app/api/events`), and the SPA marks with `x-quiz-idle` every
   request it makes while its page is hidden or nothing was pressed, clicked,
   touched or scrolled for ten minutes (`apps/web/src/idle.ts`) — the polls, the
   refetches the stream asks for, the safety refetch of a tab left open overnight.
   That header can only narrow what is counted.
3. **What the administrator reads** (`GET /app/api/admin/activity`, F-ADMIN-09):
   counts only, never a name. Active now (seen within 15 minutes), in the last 24
   hours and in the last 7 days, each split into students and staff; and a grid of
   the last seven calendar days of Europe/Zurich, today last, by local hour, each
   cell the distinct people active in it. The database converts to local time, so
   the two 02:00 of the night summer time ends (25 October 2026) fold into one
   cell and count a person once. Exact counts, no small-count masking (owner): the
   administrator sees aggregates only and no screen gives a person's hours.
   "Students" and "staff" are the stored role (`student`; `teacher` and `admin`).
4. **Class hours** (owner): Monday to Friday, 08:00 to 18:00 Europe/Zurich, fixed.
   Cells outside are hatched, and the screen gives the share of the students'
   person-hours of the grid that fall outside, with the window written beside it.
5. **Last activity per person**: the administrator's list of accounts
   (F-ADMIN-01) shows the last activity as a column, read by join (the last
   sign-in, in the cell's tooltip, stands in for an account seen before this
   record existed). It is never on a course roster, nor anywhere a teacher
   reads. An anonymized account is counted in no figure.
6. **Retention**: the hourly rows are deleted after eight days by the daily
   scheduled task `presence.purge` (seven days shown, one of margin). There is no
   backfill: the grid starts empty on deployment. The last activity lives with the
   account (deleted with it).
7. **The student's own data** (N-DATA-04): the platform has no data export yet;
   when it is built, it includes the student's `presence_hours` rows and their
   last activity while they exist.

## Consequences

- Two small tables; at most one hour row per person-hour and one last-seen row
  per person every five minutes, written in batches off the latency path.
- The privacy page, when it exists, must say that the platform keeps, for eight
  days, the hours in which each person used it, and their last activity, read by
  the administrator in aggregate (and the last activity per person).
- Several processes each keep their own dedupe: a person may cost one write per
  process per hour, which the primary key makes harmless.
- A page left open and untouched stops counting after ten minutes; a student
  reading one long question for more than ten minutes without touching the page
  may lose the hour if nothing else happened in it. Accepted: the unit is the hour.

## Alternatives considered

- **Derive activity from the sessions table or the access log.** Sessions last for
  days and say nothing of the hours; access logs are not kept and would be
  per-request personal data.
- **Store only aggregates (counts per hour).** Distinct people per hour and per
  day, and the split by role, need per-person rows at least until the hour is
  over; eight days of `(user, hour)` is the small price, and it is purged.
- **Mask small counts.** Rejected by the owner: the administrator sees no
  per-person view, and an evening of three students is the information sought.
- **Put the chart inside People.** Rejected by the owner: People stays account
  management; Activity is a tab of its own.
