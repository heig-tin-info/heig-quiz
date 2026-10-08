# ADR-027 — Launch tickets and typed sessions (Safe Exam Browser first)

## Status

Accepted (2026-09-26, issue #139, with `apps/api/src/auth/launch.ts`,
`auth/seb.ts`, `sessions.kind` and the `sits` rule of `modules/guards.ts`).
Brings Safe Exam Browser back into scope (00 §0.6).

**Addendum (2026-09-30, ADR-035, the classroom merge):** what is settled,
and what waits for D21 (unified SEB design, settled 2026-10-01 for M6).

- **Settled — the exception for the online workspace.** §1 rejected a
  self-contained signed token. The portal of the online workspace
  (ADR-047) is on another VM and has its own database, so the platform
  reaches it with two HS256-signed messages (a 2-minute service token for
  the sync, a 5-minute launch token), as classroom does. This is a
  recorded exception, not a reversal: the portal enforces single use
  itself (it consumes the token's `jti` by insert before anything else),
  the launch token grants no role, and nothing else in Quiz uses a signed
  token for a session.
- **D21, settled 2026-10-01, implemented in M6 — a `seb` session per activity.** The direction of
  ADR-035 is that a `seb` session is confined to an **activity**
  (evaluation or project) rather than to an evaluation: a project's
  session would reach the project page and "Open workspace", nothing
  else, and the platform would build every `.seb` from a shared
  `packages/seb`. Until M6 implements it, `sessions.evaluation_id`, `sits`
  and the routes of §3–4 are unchanged, and no project can require SEB.
  Whether Browser Exam Keys become optional per activity (§2 rejected a
  list) is part of D21 too.

**Addendum (2026-09-30, ADR-051, attested kiosk stations):** a second
confined kind, `kiosk`, sits beside `seb`, and an exam accepts either or
both. For `seb`, §2 changes: the Config Key is stored on the session and
checked on EVERY request, audit-only until proof B. §3 changes: a confined
session's cookie is `SameSite=Strict`, and a new confined session
supersedes the previous one of the same student and exam. There is still
no Browser Exam Key.

**Addendum (2026-10-07, M6-02, D21 point 1):** the plist, the Config Key
and the hashes left `auth/seb.ts` for the pure `packages/seb` (`@quiz/seb`),
the full port of classroom's (every Moodle rule: `originatorVersion`
stripped, empty dictionaries pruned, `<data>`, `<real>`, `<date>`), checked
against all of Moodle's vectors, the 201-key one included. The file Quiz
serves is unchanged byte for byte, and so is its Config Key
(`auth/seb.snapshot.test.ts`). One change: the absolute URL a request's
header is checked against drops a `#fragment` (the SEB specification
hashes the URL "without Fragment part"; a browser never sends one); `auth/seb.ts` keeps the routes and the
evaluation's configuration (Quiz's host only).

**Addendum (2026-10-07, M6-07, D21 points 2–5): a `seb` session per
activity.** The ticket and the session carry `project_id` instead of
`evaluation_id` for an `online_seb` project (never both, a check
constraint); `SessionAuth.projectId`. §3's default deny gains a second
axis: a route declares the **activities** a confined session it serves may
be confined to (`activities`, absent: an evaluation), so an evaluation's
session is anonymous on a project's routes and the reverse; a project's
session reaches `GET /me`, its project's student page and *Open workspace*
(`PROJECT_SEB`), each loaded for that project only. The platform builds
every `.seb` (`sendLaunchFile`): a project's file allows the workspace
portal's host too, and both add `SEB_EXTRA_ALLOWED_HOSTS` (empty by
default: the evaluation's file is unchanged). §2's start route reads the
ticket's activity without consuming it, then checks the header against
that activity's file, then consumes: a refused header never burns the
ticket. One session per (user, activity) (ADR-051 §4). Still no Browser
Exam Key in Quiz (ADR-047 amendment "M6-07").

**Addendum (2026-10-08): the quit link.** The file hides SEB's task bar,
and with it SEB's Quit button: a student who had handed in found no way
out. Every `.seb` Quiz builds now carries, after `allowQuit`, a `quitURL`
(`<PUBLIC_URL>/seb/quit`, `SEB_QUIT_PATH`, on the start URL's host, which
the filter already allows) and `quitURLConfirm` false: SEB quits, without
confirmation, when it is about to navigate there — the key Moodle's
`quizaccess_seb` sets as its "link to quit SEB". The screens a `seb`
session shows when it is done (the end of the attempt, *You have left the
exam*, the refused launch seen in SEB) and a project's page in SEB carry
that link as *Quit Safe Exam Browser*, with SEB's shortcut (Ctrl+Q, ⌘Q),
which may ask to confirm, beside it.
Outside SEB the address is an SPA page saying the window may be closed.
This changes the bytes of every file, hence every Config Key
(`auth/seb.snapshot.test.ts` updated deliberately): an open session keeps
the key it was launched with, and a file downloaded before the deploy and
opened after is refused at its start route without burning its ticket —
the student downloads it again.

## Context

An exam sat in Safe Exam Browser (SEB) is a separate browser: the portal's
session does not follow the student into it. Signing in again inside SEB
means edu-ID, and edu-ID means a second factor on a phone the student may
not touch during the exam. The student is already signed in on the portal;
what is missing is a way to carry that identity into SEB, for ONE exam, and
nothing more.

Two things must hold at once. A session opened this way must not be a portal
session: it reaches the exam and nothing else, even from a hand-written HTTP
client. And an exam that requires SEB must not be reachable from the portal,
or the file is a detour anyone can skip.

## Decision

### 1. A one-time launch ticket, not a JWT and not OIDC

The student's card downloads a `.seb` (`GET /app/api/evaluations/:id/seb`, a
portal session holding a seat). The file's start URL carries a random 256-bit
secret: `/app/auth/seb/<secret>`. The database keeps `launch_tickets`, with
the secret's SHA-256 only, the user, the evaluation, the kind of session it
opens, who asked for it, five minutes of validity, `consumed_at` and
`revoked_at`. Downloading again revokes the previous unused ticket. The
secret is consumed by ONE conditional `UPDATE … RETURNING`: of two
concurrent requests, exactly one gets it.

A self-contained signed token was rejected: it cannot be consumed once, nor
revoked, without the database row it was meant to avoid. The download is a
GET, like the CSV export, so the card is a plain link; another site forcing
it only revokes an unused file.

### 2. The start route checks SEB, then the ticket, then the seat

`GET /app/auth/seb/<secret>` checks SEB's `X-SafeExamBrowser-ConfigKeyHash`
header first (`sha256(URL + Config Key)`), so a copied file opened in an
ordinary browser is refused WITHOUT consuming the ticket. Then it consumes the
ticket, checks again that the seat is held and that the exam still requires
SEB (`sebSeat`, the same check as the download; the ticket is minutes old),
opens a `seb`
session through `openSession` — still the one place session cookies are
minted — and lands on `/take/<evaluation>`. Every refusal looks the same to
the client (`/?seb=invalid`); the audit log keeps the reason
(`auth.seb_refused`: `config_key`, `ticket`, `seat`).

The Config Key is computed, not stored: the file is a function of its start
URL, so the start route rebuilds it from the URL it was reached on. The port
of the Config Key (from `heig-classroom`, itself from Moodle's
`quizaccess_seb`) is cut down to the plist subset the file uses and is checked
against Moodle's own 201-key SEB-JSON vector. There is no Browser Exam Key
list: it needs one key per SEB version and platform, which one person cannot
maintain.

What the header proves is limited, and said so: a student who reads the file
can compute it. It stops the accidental and the lazy — opening the file's
URL in Chrome — not the determined. The server-side confinement below is the
security boundary; SEB's own restrictions are not.

### 3. Typed sessions and default deny

`sessions` gains `kind` (`portal` by default, so every existing row is what
it was), `actor_user_id` and `evaluation_id`. The request carries
`req.auth = { kind, actorUserId, evaluationId }`; modules read that, never the
columns. A route declares the kinds it serves (`config: { sessions: [...] }`,
`SITTING` for the student routes of `live`, `GET /me` and the SSE stream); a
route that declares nothing serves `portal` only. On any other route a `seb`
session is simply not there: the request is anonymous, so a 401 wherever a
session is required, and the static files and public routes are unaffected.
A new route is therefore closed to `seb` until it opts in.

The lifetime of each kind is one table in `auth/session.ts`: a `portal`
session slides on `SESSION_TTL_HOURS`; a `seb` one never slides, and lives
6 h from the launch. It is not deleted on submit: after it, every write is a `410` and the
session reads its own closed attempt, which is what the screen shows.

### 4. One rule for who sits what: `sits`

`sits` in `modules/guards.ts`: a `seb` session sits its own evaluation and
nothing else; any other session sits every evaluation that does not require
SEB. It is applied after the loaders of the sitting routes (enter, retake,
every `/attempts/:id/…`) and once for every SSE watch, and answered with their
404. A staff member watching somebody else (dashboard, inspector) is not
sitting and is not affected; a teacher REHEARSING the exam through their own
seat (ADR-018) is sitting, and does it with the `.seb` like a student.

`settings.safeExamBrowser` switches the requirement on. It is an exam's switch
(`sebRequired`): shown on exams only, and inert on any other mode, the way
negative marking is on a poll — so no path of an exercise (retakes included)
can be a way around it.

### 5. Shaped for delegation, not building it

`actor_user_id` (who acts, null when the user acts for themself) is distinct
from `user_id` (as whom), with the same meaning on the ticket and on the
session, and `tracer` writes the actor. That is what a teacher
acting as a student would need; nothing else of it exists, and its policy is
an open question (06, row 24).

*Built by ADR-034 (2026-09-28, #201):* an admin, never a teacher in v1,
opens an `impersonation` session of a student from a one-time link pasted
into a private window — one hour, fixed; read-only in production by one rule
in the session hook, full write in development; never present in the room;
`impersonation.started`/`ended` in the audit. Tickets are now consumed by
kind, and revoked by `(user, actor, kind, evaluation)` with `IS NULL` for a
null column.

## Consequences

- A `seb` session reaches: `GET /me`, entering its evaluation, the routes of
  its own attempt, and the SSE stream of its evaluation. Everything else is
  anonymous to it: `auth/seb.db.test.ts` asks every route of Fastify's tree
  with the session and without, and fails on any route outside the declared
  list that answers differently.
- The SPA, on a `seb` session, renders the attempt page of its evaluation and
  otherwise one screen ("You have left the exam"), with no frame at all.
- The request log masks the secret (`redactLaunchUrl`). The Caddyfile keeps no
  access log; if one is ever added, the same path must be masked there.
- The `.seb` settings are those of the sibling project and have not been
  confronted with a pinned SEB binary either (`TODO(verify)` of its README).

## Alternatives considered

- **edu-ID inside SEB.** The second factor is the problem this solves.
- **A signed token instead of a ticket row.** No single use, no revocation.
- **A 403 for a `seb` session on an undeclared route.** Needs a list of public
  paths (static files, `/config`) to exempt; anonymous needs none.
- **Deleting the `seb` session on submit.** The SPA would then fall to the
  sign-in page inside SEB instead of the closed attempt.
