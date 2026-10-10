# ADR-054 — Super Powers: an admin reaches everyone's content for one hour, on request

## Status

Accepted (2026-09-30, settled with the product owner; with
`sessions.super_powers_until` (migration `0044_super_powers`), `reachOf` and
`callerOf` in `apps/api/src/modules/guards.ts`, the routes of
`apps/api/src/auth/superPowers.ts`, the audit actions `superpowers.enabled`
and `superpowers.disabled`, the settings section and the red banner of
`apps/web/src/SuperPowers.tsx`, and F-ADMIN-05). Amends ADR-013 §3 (the
resolution order), ADR-032 (context), ADR-034 §2 (who issues the link) and
removes the `?scope=all` switch of the pool list (#63). §2 has one scoped
exception: the sorting of the existing tags into concepts is open to the
admin role without Super Powers ([ADR-081, second addendum §4](ADR-081-vocabulaire-de-notions.md#second-addendum-2026-10-08-sorting-the-existing-tags)); that exception lapsed with #599 step (d)
([ADR-081, fourth addendum](ADR-081-vocabulaire-de-notions.md#fourth-addendum-2026-10-10-the-tag-sorting-is-retired)),
the tag sorting being retired. The admin-only validate and delete routes of
concepts remain, on the admin role, as they do not read anyone's content.
A second scoped exception: the admin's concept queue shows, without Super
Powers, the instance-wide number of live questions using each concept, a
number and nothing else, because curating the vocabulary is a decision about
all of them; pool names and statements still need Super Powers ([ADR-081,
fifth addendum §1](ADR-081-vocabulaire-de-notions.md#fifth-addendum-2026-10-10-the-curation-of-the-vocabulary)).

## Context

The platform has one administrator, who also teaches, with the same account.
Until now the admin role reached every course, classroom, evaluation and pool
of the instance, and was an owner on every pool: `accessWhere` in
`guards.ts` dropped the staff predicate for `role === "admin"`. The course
list, the sidebar, the command palette and the pickers of the admin were the
whole platform's. Working on their own course, the admin could open, edit,
grade or delete a colleague's by one wrong click, with nothing on screen to
say the page was not theirs.

The pool list had already met the problem (#63): it filtered the admin's
shelf to their own pools and added a `?scope=all` switch. Every other list
and every loader had no such filter.

Two facts were fused in one field: "is an admin" (a role, which opens the
admin's own functions — the user and teacher lists, the metrics, the `admin`
realtime topic) and "may reach everyone's content" (a reach, which the admin
needs rarely: to help a colleague, to diagnose a support request).

## Decision

1. **Two facts, two fields.** `Caller` (`guards.ts`) gains a REQUIRED
   `reach: "all" | "seats"`, so a caller built by hand from `req.user` does
   not compile. Who may hold Super Powers at all is ONE pure predicate,
   `mayHoldSuperPowers(user, auth)`: the role is `admin` and the request
   rides on a `portal` session that is not delegated (no `actor_user_id`) —
   never a Bearer token, never a `seb` session. The reach is
   `reachOf(user, auth, now)`: `all` if and only if `mayHoldSuperPowers` and
   the session's `super_powers_until` is after `now` — the server's clock
   (invariant 5). Everything else is `seats`. The session hook computes the
   caller once per request (`req.caller`, one clock read); `callerOf(req)`
   reads it. The switch routes and `GET /me` (`superPowersAvailable`) ask the
   same `mayHoldSuperPowers`.

2. **The general rule.** `adminGuard` means an admin ROLE function and keeps
   reading `role`: `/admin/users`, `/admin/teachers*`, `/metrics`, the
   `admin` realtime topic, the super-admin rule of `roles.ts` stay open
   without Super Powers. `accessWhere`, and every "admin overrides" rule,
   means REACH and reads `reach`, never `role`: every loader, the course
   list, the pool list, the poll routes, the pool route context, the
   realtime topics, `managedEvaluationAccess`; `poolRoleOf` and
   the bulk resolution of the pool list (`effectivePoolRole`, whose fact
   `isAdmin` is renamed `reachesAll`); the `mayLink` of a question move. An
   admin without Super Powers is a teacher: their own seats, their pools by
   the ordinary pool role, the 404 of a missing entity on a colleague's
   content (invariant 6).

   **One exception, by role: `seesUser`, who may fetch a user's uploaded
   picture** (#318). Any admin passes it, with or without Super Powers
   (`if (user.id === subjectId || user.role === "admin") return undefined;`,
   no `accessWhere` around the predicate). The administration's account
   lists (#387) show every face, and they are a role function, like
   `/admin/users`; a picture is not a colleague's content. Settled with the
   product owner (2026-09-30), who authorised this widening explicitly.

3. **Storage: one nullable column on the session.**
   `sessions.super_powers_until timestamptz`. It lives and dies with the
   session: signing out deletes the row, and the flag with it. The sliding
   renewal of a portal session moves `expires_at` only. A new session is
   never born with it (`createSession` writes its columns one by one).

4. **Switching.** `POST /app/api/me/super-powers` sets `now + 1 hour`, fixed;
   `DELETE` clears it. Both answer `SuperPowersState` (`packages/contracts`,
   invariant 7; neither takes a body). Admin role only (`adminGuard`), then
   `mayHoldSuperPowers`: a Bearer token gets `403 session_required`, like the
   token routes. **No extension**: while
   they run, a second `POST` is refused (`409 super_powers_active`, worded
   in the reader's language by the SPA, like `super_powers_required`); the
   admin switches them off and on, which the audit shows as two grants.
   `DELETE` is idempotent and writes nothing when they are off.

5. **Audit** (invariant 9). `superpowers.enabled` (actor and subject the
   admin, `payload.until`) and `superpowers.disabled` with
   `payload.reason`: `manual` (the route), `logout` (the session signed out
   within the hour), `expired`. Expiry is written by whichever comes first:
   the next request of that session (`findSessionUser`), or the ticker's
   task `superpowers.expire`, every 60 s — a bare tick task (`TICK_TASKS`),
   not a scheduled task of D10, so that no admin can pause the expiry of
   their own Super Powers (whether it moves is 06 no. 37). Both call `expireSuperPowers`,
   whose conditional `UPDATE … WHERE super_powers_until <= now RETURNING`
   is the one comparison with the clock and keeps the two from writing it
   twice; `expired` is written by the system (no actor). A session dropped by its
   own expiry while the flag was set writes `expired` too.

6. **Realtime.** A stream computes its topics once, at connection. Every
   change of reach — on, off, expiry, logout — closes the admin's open
   streams (`accessRevoked`, the mechanism of #248), which reconnect with the
   topics of the new reach. It closes all of the user's streams, not only
   that session's: the user topic is the addressing the bus has, and a
   reconnection is cheap. A stream that makes no request is closed by the
   ticker's task: **an open stream outlives the Super Powers by 60 seconds
   at most**, not by however long the client keeps it open. The web
   invalidates its whole TanStack cache on a
   change, so the pages on screen refetch with the new reach.

7. **The web.** `Me.session.superPowersUntil` carries the server's end (ISO),
   null when off; the browser only counts down for display. The settings
   page of an admin has a **Super Powers** section: one sentence (every
   teacher's courses and pools, for one hour, audited) and the switch. While
   they run, a red mode banner (`ModeBanner`, tone `danger`) sits above
   everything: "Super Powers", the minutes left, and **Switch off**; in the
   last five minutes the minutes turn to a countdown by the second behind a
   warning sign. At zero the SPA asks the server again (then every five
   seconds while the server's clock has not reached the end). Mode banners
   now stack: each sticks below the ones above it. The pool list lost its
   `?scope=all` switch: with Super Powers on it simply lists every pool.

### Settled with the product owner (2026-09-30)

- **Impersonation needs Super Powers.** Creating a link to act as a student
  (ADR-034) requires them (`superPowersGuard`, `403 super_powers_required`
  otherwise; the roster
  offers the action only while they run). Only the CREATION: the consumption
  of the link and the session it opens keep reading the actor's ROLE — a
  private window holds no trace of the admin's session — and an open
  impersonation session lives out its fixed hour.
- **The `?scope=all` switch of #63 is removed**, parameter and contract
  included.
- **MCP and Bearer tokens never have Super Powers.** An assistant acting for
  the admin reaches what a teacher reaches.
- **One hour, fixed, a warning at five minutes, no extension.**

## Consequences

- A course whose staff is empty is reachable only with Super Powers.
- The MCP assistant of an admin sees only the admin's own courses and pools.
- Super Powers that expire mid-task — grading a colleague's evaluation, say —
  turn the next write into the 404 of a missing entity; the banner's
  countdown is the warning.
- An admin demoted mid-hour loses the reach at once (`reachOf` reads the
  role on every request); the column lingers until its hour and is audited
  `expired` then.
- A test that relied on an admin's unlimited reach signs in through
  `signInWithSuperPowers()` (`apps/api/src/test/http.ts`), which goes through
  the real route.

## Alternatives considered

- **Keep the admin's reach and add filters to each list** (the #63 switch,
  everywhere). Filters every screen but keeps every loader open: a stale link
  or a typed id still reaches a colleague's course, with nothing on screen to
  say so.
- **A second account for administration.** Clean, but the edu-ID identity is
  one per person and the role comes from it.
- **A flag on the user rather than the session.** Survives a sign-out and
  reaches every device and every token of the account, the MCP assistant
  included.
- **Extension on request.** Refused: an hour that can be extended from a
  banner is an hour nobody switches off.
