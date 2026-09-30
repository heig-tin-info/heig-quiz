# ADR-034 — Acting as a student: a one-time link, an `impersonation` session, read-only in production

## Status

Accepted (2026-09-28, issue #201, settled with the product owner on the
issue's review; with `apps/api/src/auth/impersonation.ts`, the
`impersonation` session kind, the read-only rule of `auth/plugin.ts` and the
roster row's "Copy link as this student"). Closes open question 24
(`docs/spec/06-questions-ouvertes.md`) and builds what ADR-027 §5 shaped and
left unbuilt.

## Context

ADR-018's student view keeps the teacher as themself: it hides the teacher UI
and walks the teacher's own seat. It cannot answer the question a student
asks support — "what does MY screen show?" — and it does not let a
developer walk the seed as a given student without signing out and in again.

ADR-027 shaped the session for delegation: `sessions.actor_user_id` (who
acts) distinct from `user_id` (as whom), one-time `launch_tickets`, a kind
per session with a per-route policy, and `tracer` writing the actor. Nothing
of it was built, and the policy — see only, answer, submit; who; how it is
audited — was open (06, row 24).

The issue proposed opening the student's session in a NEW TAB, the
teacher's untouched in the original one. That cannot work: the session is
one cookie for the whole origin (`quiz_session`, `path: /`). A session opened
in a new tab replaces the teacher's in every tab: the original tab then acts
as the student, and "End" signs the teacher out.

## Decision

### 1. A link to paste into a private window, and nothing else

A roster row offers **Copy link as this student** (a secondary action of the
row menu; the screen's primary action is unchanged).
`POST /app/api/classrooms/:id/roster/:eid/impersonation` (a route of the
`org` module, on the roster entry's loader, calling
`issueImpersonationLink()` of `auth/impersonation.ts`) issues a launch
ticket of kind `impersonation` (`user_id` = the student, `actor_user_id` =
the caller, `evaluation_id` null) and returns its URL,
`/app/auth/as/<secret>`. The SPA shows it in a dialog with a copy button —
a clipboard write that follows the request's `await` is refused by Safari —
and opens no tab: only another browser profile — a private window, another
browser — keeps two identities apart on one origin. The dialog and the help
say to paste it ONLY there, never into a chat or an e-mail, whose link
preview would consume it. The ticket follows ADR-027 §1 unchanged: 256 bits, only
its SHA-256 stored, five minutes, consumed by ONE conditional `UPDATE`.

Consuming now names the kind it expects (`consumeLaunchTicket(db, kind, …)`):
a `.seb` secret opens no impersonation, and the reverse. And issuing a ticket
revokes the earlier unconsumed ones by `(user_id, actor_user_id, kind,
evaluation_id)`, a null column matched with `IS NULL` — the former
`eq(evaluation_id, NULL)` would have revoked nothing for a ticket with no
evaluation.

`GET /app/auth/as/<secret>` validates the secret's shape with a contracts
schema (`LaunchSecretParams`, invariant 7), consumes the ticket, checks AGAIN that the actor
is an admin and the target a student with a student seat (the ticket is
minutes old), opens the session through `openSession` — still the one place
cookies are minted — and lands on `/`. Every refusal looks the same
(`/?impersonation=invalid`, which the landing page states). The request log
masks the secret (`redact.ts`, the same table as the `.seb` path).

### 2. Who: an admin, acting as a student

- **The caller is an admin, in v1.** The impersonated session reads
  everything the student reads, other courses and released grades included,
  where a teacher may hold no seat. `staffAccess` would guard the issuing of
  the link, not what the session reads afterwards — that would break N-SEC-03
  and invariant 6. An admin already reaches every course. Opening this to
  teachers needs a "confined to the caller's classrooms" predicate in every
  student loader; it is a follow-up, not a flag.
- **The target is a user of role `student` holding a student seat**
  (`enrollments.user_id`, not `staff`). A staff seat, a teacher, an admin, an
  unclaimed row: 404, the same as a missing entry, and the same 404 for any
  non-admin caller (`adminGuard(app, { hidden: true })`).
- **The actor stays an admin, or the session ends.** `findSessionUser`
  reads the actor's role on every request of a delegated session (one
  primary-key lookup, on these sessions only); an admin demoted mid-hour
  loses it at once, audited as `revoked`.

### 3. A new session kind, `impersonation`

`SESSION_KINDS` gains `impersonation`. Its lifetime is FIXED: one hour from
the link, never slid (the table of `auth/session.ts`), where a `portal`
session with `actor_user_id` set would have inherited the sliding renewal
of `SESSION_TTL_HOURS`. `evaluation_id` is null. For route admission it is the student's
portal (`serves()` in `auth/session.ts`): it reaches exactly the routes a
`portal` session reaches. `sits` (ADR-027 §4) treats it like any unconfined
session.

"Delegated" has ONE predicate, `delegated(auth)` in `auth/session.ts`
(`actor_user_id` set): the read-only rule, the presence skips, the `.seb`
refusal and the audit all ask it, never the kind.

`GET /me` says what the session is: `session.kind` and `session.readOnly`. The SPA wraps every page — the full-screen attempt
included — in the mode banner of #242: "Acting as <name>" (", read only" in
production) and **End**, which signs this session out. The admin's own
session is untouched, in the other browser.

### 4. Read-only in production, full write in development

Outside development, an `impersonation` session reads and never writes. ONE
rule, in the hook that resolves the session (`auth/plugin.ts`), next to the
kind check: a method other than GET/HEAD/OPTIONS, on any route but sign-out,
answers `403 impersonation_read_only`. The SPA words that code itself, in
the reader's language (`apiErrorMessage`), rather than print the server's
English. It sits in the hook rather than in
`requireSession` so that a route which forgets `requireSession` and still
reads `req.user` is covered too; a new write route is covered by
construction. `auth/impersonation.db.test.ts` walks Fastify's route tree and
fails on any non-GET route that answers otherwise.

In development the session may answer and submit — the product owner's
choice, to simulate an exam as a given student and feel it from their side.
"Development" is the EXISTING test of invariant 3, computed once in
`plugin.ts` and shared with the persona picker and `/config`:
`AUTH_DEV_LOGIN && NODE_ENV !== "production"`. No new flag; `config.ts`
already refuses `AUTH_DEV_LOGIN` in production, and staging runs
`NODE_ENV=production`, so staging is read-only like production.

Some GETs write, and each is handled:

- **Presence.** The SSE watch joins the room (`presence.join`), and
  `GET /attempts/:id` — the attempt page, reloaded — stamps the attempt's
  `present_at` (`markPresent`), as does the attempt log's `reconnect` event. A
  session acting as the student is not the student in the room: it does
  none of the three, in development either. The live dashboard never shows
  the student present because somebody looked. (Entering an attempt, a
  write, still stamps it in development, where the admin really sits it.)
- **The `.seb` download** (`GET …/seb`) mints a ticket. A session with an
  actor gets its 404: nobody acting as a student obtains a `seb` session for
  them. Safe Exam Browser exams are therefore out of reach, as `sits`
  already requires a `seb` session to sit one.

A consequence in production: entering an attempt is a POST, so the attempt
screen of an evaluation the student has not entered yet cannot be shown.
What the student already sees — home, lobby of an entered attempt, results,
feedback — can.

### 5. The audit

`impersonation.started` (at the link's consumption) and
`impersonation.ended` join the closed union (invariant 9), subject the
student. ONE function deletes sessions and owns what the audit says of it
(`dropSessions`): signing out writes `auth.logout`, or for a delegated
session `impersonation.ended` with the admin as actor (`reason: logout`,
actor type `user`) — the student signed out of nothing. A delegated session
that expires (found on use or purged by the ticker) or loses its actor's
right ends by the system: actor type `system`, no actor, the admin named in
the payload (`reason: expired | revoked, actorUserId`). Any audited write made through the session
(development only) is attributed by `tracer` to the admin
(`req.auth.actorUserId`), as ADR-027 §5 intended.

### 6. Privacy

The student is not notified in v1. The platform says it once, in English and
in French: the student help ("My classrooms") states that an administrator
can open a read-only view of their account to help with a problem they
report, for an hour at most, recorded under the administrator's name. The
"Data and privacy" page of N-DATA-07 does not exist yet; the sentence moves
there when it does.

## Consequences

- ADR-027 §5 is built: the `actor_user_id` of a ticket and of a session now
  has a producer, and the `impersonation` kind is the first delegated one.
- Row 24 of `06-questions-ouvertes.md` is settled.
- An admin who opens the link in their own browser, not a private window,
  replaces their own session there; "End" then leaves them signed out. The
  roster's dialog and help page say to use a private window.
- A new write route needs nothing to stay closed to an impersonation in
  production; a new GET that writes must say, like presence and the `.seb`,
  what it does for a delegated session (`delegated(req.auth)`).

## Alternatives considered

- **A new tab.** Impossible on one origin with one cookie (Context).
- **A `portal` session with `actor_user_id` set.** Inherits the sliding
  lifetime and every write route.
- **Read-only everywhere.** Proposed in review and refused by the product
  owner: simulating an exam as a student is the development need.
- **A dedicated flag for the development write mode.** A second switch that
  could be left on in production; invariant 3 already has the test.
- **Teachers as callers, guarded by `staffAccess`.** Guards the link, not the
  reads that follow; deferred until the student loaders can be confined.
- **The read-only rule in `requireSession`.** Misses a route that reads the
  session without requiring it; the resolving hook sees every request.
