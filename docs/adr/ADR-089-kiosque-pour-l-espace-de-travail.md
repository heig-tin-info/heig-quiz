# ADR-089 — Kiosk stations for the online workspace: the station stays on Quiz and frames the portal

## Status

Accepted (2026-11-15, product owner, after a spec challenge): built now behind `KIOSK_PROJECTS`, four
levels like an exam's, quota rules kept, three residual risks accepted — the
[amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag) overrides §1,
§2, §9 and §12 where it says so. Proposed 2026-10-09 (points 1, 7 and 9 the owner's then). Production
stays off until project proof B and proof K. Delivery: [merge progress](../merge/PROGRESS.md), M6-11a–d.

- 2026-10-11, audit L7: the student's start route is `POST /app/api/projects/:id/workspace/start` (ADR-047), formerly a GET.
- 2026-10-11, audit L24: the "Same-site exposure" consequence pointed to [ADR-047's amendment](ADR-047-espace-de-travail-en-ligne.md#amendment-2026-10-11-one-origin-for-every-session-audit-l24); its premise no longer holds here (amendment of 2026-11-15, point 4 (b)).

Scope: how a student works in the online workspace of an `online_seb`
project from an attested kiosk station, across the two hosts of Quiz and
its portal; what each side checks, and how the sitting ends; since
2026-11-15, which devices such a project accepts (four levels). Not the
`workspace` question of evaluations (ADR-075).

Relations: amends [ADR-051](ADR-051-postes-kiosque-attestes.md) §1 (a
`kiosk` session may be confined to a project), §4 (supersession for a
project), §7 (pairing for a project, the end and the navigation of such a
session), and its "evaluations only" reading of D21; amends
[ADR-047](ADR-047-espace-de-travail-en-ligne.md)'s M6-07 amendment (a
`kiosk` launch claim beside `seb`) and [M6-06](ADR-047-espace-de-travail-en-ligne.md#m6-06-2026-10-07-the-work-mode-in-quiz) (A)
(the station level freezes with the mode). Related to
[ADR-075](ADR-075-question-espace-de-travail.md) §11, which keeps governing
the kiosk for the `workspace` question of evaluations, and to
[question 52](../spec/06-questions-ouvertes.md) (c), which stays open for
that question. Uses the HS256 messages of ADR-047 §6 and ADR-078 §2, and
the confined sessions of
[ADR-027](ADR-027-tickets-de-lancement-et-sessions-typees.md)'s M6-07
addendum.

## Context

An `online_seb` project is worked in the portal (`code.chevallier.io`)
from a `seb` session confined to the project (ADR-047, M6-07). When the
student's laptop cannot run SEB, the exam fallback is a kiosk station
(ADR-051), but nothing of that path reaches the portal:

- **The start route does not serve a station.** `POST /app/api/projects/:id/workspace/start`
  (`WORKSPACE_START_ROUTE`, `apps/api/src/modules/codespace/routes.ts`; a
  GET until audit L7) declares `PROJECT_SEB`,
  `sessions: ["portal", "seb"]` (`apps/api/src/auth/session.ts`). The
  session hook (`auth/plugin.ts`) checks `serves` before any trust check, so
  a `kiosk` session is anonymous there and the station is sent to the
  sign-in. Adding `kiosk` to the route alone would not do: `quiz_kiosk` is
  host-only with path `/app/api` (`modules/kiosk/routes.ts`, the
  `setCookie` of `verify`), so the request would lack it and
  `trustRefusal` (`auth/trust.ts`) would answer `kiosk_station`. The portal
  must never see that cookie; widening it to `Domain=chevallier.io` would
  hand it to a host that serves student-controlled content.
- **Quiz and the portal are the same site** (`chevallier.io`; on staging
  `quiz.dev` and `code-dev`). A same-site frame carries `Strict` and `Lax`
  cookies and is neither blocked nor partitioned as third-party.
- **The station's machinery lives on a Quiz page.** Re-attestation every
  10 minutes (`apps/web/src/kiosk/useStationAttestation.ts`), the 30 s retry
  while suspended, the return to `/kiosk`, and the `423 kiosk_suspended` of
  writes all act on Quiz. A page that leaves Quiz for the portal stops them;
  the portal checks trust once, at `/launch`, then trusts its IP-bound
  `exam_session` cookie for 4 h (`EXAM_COOKIE_MAX_AGE_MS`), against a kiosk
  session's fixed 6 h.
- **A kiosk session is bound to an evaluation end to end**:
  `kiosk_pairings.evaluation_id`, the pairing's `openSession` with
  `projectId: null`, `watch.ts`'s `sittingOn`, `endKioskSessions` keyed by
  evaluation (`auth/session.ts`), and `workspaceStartRefusal`'s `fromSeb`
  (`@quiz/domain`, `workMode.ts`). `sessions.project_id` and its
  `sessions_one_activity` check already exist (M6-07), and `supersede`
  (`auth/session.ts`) already keys a project's confined sessions by (user,
  project) over both trusted kinds.
- **A station is shared.** The portal's cookies (`exam_session`, and the
  `/s/<id>` session cookie of `apps/codespace/src/web/routes.ts`) stay in
  the station's browser profile after the student leaves, behind the same
  IP address, and nothing closes a portal session at the end of a sitting.
- **Scope.** `00` §0.6 and ADR-051 admit stations for exams only; ADR-075
  §11 makes the kiosk wait for proof B, which is a property of SEB, not of
  a station.

## Decision

1. **Scope: a fallback beside SEB** (owner). A project accepts a kiosk
   station only as an alternative to SEB, in `online_seb`: "SEB or
   kiosk", as for an exam whose two settings are on. Kiosk-only projects
   are deferred. No new work mode.
   *Reversed 2026-11-15 (owner): four levels, Kiosk only included, still
   no new work mode — point 2 of the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
2. **The setting.** `kiosk: boolean`, a project setting meaningful only
   with `online_seb`, set by the mode route (`ProjectWorkModeBody` gains it,
   the same owner and grant checks) and audited by `codespace.work_mode`,
   whose payload carries it. It is read through one reader beside
   `trustedClientsOf` (the project's trusted clients: `["seb"]` or
   `["seb", "kiosk"]`) and frozen at the first student launch with the mode
   (`codespace_projects.first_launch_at`, `409 work_mode_frozen`). Offered
   only while `KIOSK_ATTESTATION` is not `off`.
   *Amended 2026-11-15: the boolean becomes a three-valued level, read by
   `projectTrustedClients`, and is offered only while `KIOSK_PROJECTS` is
   on too — points 1 and 2 of the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
3. **The station stays on Quiz and frames the portal.** A kiosk session of
   a project is confined to one Quiz page of that project (the station
   page): a thin bar (the station's label, the server's deadline, **Leave
   this station**) above an `iframe` of the portal. The station enters that
   page by a full navigation (`location.replace`, as
   `apps/web/src/kiosk/useKioskStation.ts` opens an exam today), so the
   page's own CSP (point 10) applies. Everything of ADR-051 runs unchanged
   on that page: re-attestation, the 30 s retry, the event stream, the
   return to `/kiosk`. The iframe has
   `allow="clipboard-read; clipboard-write"` and a `sandbox` without
   `allow-top-navigation` or popups, so nothing the portal serves can take
   the station off the page.
4. **The launch.** The station page obtains the launch URL from
   `POST /app/api/projects/:id/workspace/launch`, declared
   `{ sessions: ["kiosk"], activities: ["project"], freshAttestation: true }`:
   under `/app/api`, so `quiz_kiosk` keeps its host-only cookie and its path;
   a write, so a suspended station is refused (`423`) and CSRF applies; and
   an attestation less than two minutes old, as for the submit (ADR-051 §6).
   **Access is loaded first** (invariant 6), as the student's start route does:
   the session must be a non-delegated `kiosk` session confined to THIS
   `:id` (the kiosk counterpart of `sebProjectSession`,
   `modules/guards.ts`), and the project is loaded through the classroom's
   student branch with the caller's claimed seat (`findStudentProjectView`).
   Any mismatch, another project's kiosk session included, answers the 404
   of a missing project. Only then does `workspaceStartRefusal`, which
   learns `fromKiosk` beside `fromSeb`, decide the refusals a student can
   read. The answer carries the portal's `/launch` URL, whose token has a
   new claim `kiosk: { deviceId }` in `LaunchTokenClaims`
   (`@quiz/contracts`); it is sent with `Cache-Control: no-store`, and the
   token is never logged, stored or audited (its `jti` is audited, as on
   the start route). The station sets the iframe's `src` to it. The
   student's start route (`POST …/workspace/start`) keeps serving portals
   and `seb` sessions. The portal's `/launch`
   in exam mode refuses a token with neither `seb` nor `kiosk`; with
   `kiosk` it skips the SEB header check and sets its `exam_session` as
   today. The station's cookie never crosses hosts, and the portal never
   calls Google.
5. **Pairing and supersession.** `kiosk_pairings` gains a nullable
   `project_id` with a one-activity check, as `sessions` has.
   `GET /app/api/pair/:code` also lists the open projects the student can
   start on a station (a claimed seat, `online_seb`, a level that accepts
   `kiosk` — "SEB or kiosk" or "Kiosk only" since 2026-11-15 —, before the
   effective deadline of ADR-078 §2); approval opens a `kiosk` session with
   `projectId`. One confined session per (user, project), the newer
   superseding the older whichever its kind: a station's session supersedes
   the student's `seb` session of that project and the reverse, as
   `supersede` already does. Supervision in v1 is the phone only: projects
   have no live dashboard, hence no **Assign a station**. Alerts go to the
   audit and to the project's workspace list.
6. **The end, and the shared station.** A project kiosk session ends at the
   earliest of: **Leave this station**; supersession; the student's
   effective deadline, by the ticker-sweeper on the server's clock
   (ADR-006, invariant 5); the 6 h fixed lifetime. Each ends the Quiz
   session and its event streams, through a project variant of
   `endKioskSessions` (new work: today's is keyed by evaluation), and
   enqueues a **portal close**: a pg-boss job, retried, idempotent, that
   sends a new HS256 service message (its own audience) naming the user and
   the project. The portal then invalidates both the user's `exam_session`
   cookies issued before the close and the `/s/<id>` session of that
   workspace, and drops their sockets; the container and its volume are
   untouched. **While a close for a station is pending, that station
   cannot be paired** (`/kiosk` shows "call the supervisor"); a close whose
   retries are exhausted is audited and keeps the station unpairable until
   an admin retires and reactivates it. So a workspace is never left open
   to the next student. *Kept 2026-11-15: the hold fails closed when the
   portal is down; what the supervisor does is point 5 of the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).* Leaving early hands nothing in: the project is
   graded from its repository at the deadline, as ever. The portal never
   decides the end.
7. **Suspension v1** (owner). A suspended station covers the iframe with
   ADR-051's suspension screen, and `kiosk.suspended` names the project.
   The work is not frozen on the portal: like SEB, the portal checks trust
   at launch only. **For the owner: N-SEC-10's suspension is weaker on this
   path** — a screen over the iframe, while writes to the portal continue,
   where an exam's suspension is the server's `423`. A portal "suspend"
   message is a possible later step, not promised here.
   *Accepted as a residual risk, 2026-11-15 (owner): point 4 (a) of the
   [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
8. **The deadline.** **For the owner: the station's session ends at the
   effective deadline, not at deadline plus the grace** that ADR-078 §7
   grants the git relay; a push in flight at the deadline still lands
   within the grace, but the student cannot keep working on the station.
   When the portal answers 403 because its 4 h `exam_session` expired
   before that, the station page relaunches (point 4); resuming a workspace
   consumes no quota. *Accepted as a residual risk, 2026-11-15 (owner):
   point 4 (c) of the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
9. **Sequencing** (owner). This ADR is written now. Implementation waits
   until SEB projects are open to students (proof B recorded, M6-07).
   Offering the setting in production further requires **proof K** on
   staging, on a real station in a web kiosk with URL blocklist `*` and
   allowlist {Quiz, portal}: the iframe loads; code-server works (its
   websocket, its service worker, its webviews, the clipboard, shortcuts
   not swallowed); the extension still answers the top page; the portal's
   cookies survive the 303 of `/launch` inside the iframe. Proof B is a
   property of SEB and gates nothing of the kiosk beyond the sequencing
   above.
   *Amended 2026-11-15 (owner): implementation no longer waits; production
   waits for both proofs — point 1 of the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
10. **Framing.** Each portal instance sends
    `Content-Security-Policy: frame-ancestors 'self' <its Quiz origin>` in
    every mode — `'self'` because code-server frames its own webviews on
    the portal's origin; the production portal names production Quiz only,
    the staging portal staging Quiz only — replacing
    `X-Frame-Options: SAMEORIGIN` (set today by
    `apps/codespace/deploy/Caddyfile`). Quiz adds `frame-src <CODESPACE_URL>`
    to its CSP (`apps/api/src/csp.ts`) on the station page only.
    *Since 2026-11-14 the portal also serves ADR-129's review sessions: the
    header covers them too — point 5 of the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
11. **Same site, required.** Quiz and its portal stay on the same
    registrable domain in each environment. A host move that breaks this
    reopens the decision: a cross-site frame loses its cookies.
12. **Capacity.** A kiosk project is not opened to a class larger than the
    quota that carries it (ADR-047 amendment "M6-06" (C)); the portal
    enforces it (its 429, shown on the station). ~~Room-sized sittings wait
    for M6-05.~~ *Amended 2026-11-15 (owner): M6-05 is done and changed no
    quota; the setting warns, and an administrator raises the holder's
    quota before a sitting — point 3 of the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
13. **Audit.** `codespace.launch_issued` gains `kiosk: true` for a station's
    launch; `kiosk.paired` and `kiosk.suspended` may name a project; the
    union gains `codespace.session_closed` (the cause: `left`,
    `superseded`, `deadline`, `expired`) and `codespace.session_close_failed`
    for the portal close of point 6; the setting is audited as point 2
    says. No token or cookie is written.

## Consequences

- ADR-051's machinery is reused whole; the cost is on the edges: a
  migration (`kiosk_pairings.project_id`), the launch route and
  `fromKiosk`, the pairing list, the end sweep and the project variant of
  `endKioskSessions`, the close job and the pairing hold, `watch` learning
  projects, one CSP source on one page, and on the portal the `kiosk`
  claim, `frame-ancestors` and the close message.
- The extension and its `externally_connectable` stay limited to Quiz's
  origins. The Admin console's URL allowlist gains the portal's origin;
  `docs/development/kiosk.md` changes when this ships (the flag turned on
  in production), not before.
- Same-site exposure: the portal's host is same-site with Quiz; what a
  session may serve there is [ADR-047's amendment of
  2026-10-11](ADR-047-espace-de-travail-en-ligne.md#amendment-2026-10-11-one-origin-for-every-session-audit-l24).
  Quiz's double-submit CSRF and the confinement of the session to the
  project bound it, and the iframe's sandbox keeps that content from
  navigating the station. *Amended 2026-11-15: this can no longer lean on
  that amendment's premise ("another browser never loads the page") —
  ADR-129's review session and a shared station both break it; the
  accepted residual risk is point 4 (b) of the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
- `00` §0.6 ("fallback stations for an exam") becomes "for an exam or a
  supervised project" when this ADR is accepted; the spec edit lands with
  acceptance (*done 2026-11-15, with `CLAUDE.md` invariant 6*). N-SEC-10's blocking exception applies at launch.
- A future split of Quiz and its portal onto two sites breaks this design
  (point 11).

## Alternatives considered

- **The extension or the portal relays the attestation**
  (`externally_connectable` gains the portal's origin). Rejected: that
  origin serves student-controlled content, so the station would become an
  attestation oracle for a laptop; and calling Google from the portal would
  put a Verified Access key on the VM that runs student containers, against
  the spirit of ADR-010.
- **A top-level 303 to the portal, as SEB does.** Rejected: it loses the
  re-attestation and the forced return to `/kiosk` at the deadline (the
  portal would have to decide the end, against invariant 5), and it leaves
  a live workspace to the next student on the station.
- **Widening `quiz_kiosk` to `Domain=chevallier.io`.** Rejected: the
  station's credential would reach the portal's host.
- **Widening `quiz_kiosk`'s path and adding `kiosk` to the GET start
  route.** Viable, but a GET passes a suspended station and escapes CSRF;
  the POST of point 4 gets both from the existing guards.

## Amendment 2026-11-15: accepted, four levels, built behind a flag

Scope: §1 (reversed), §2 (the setting's shape), §9 (the sequencing), §12
(a stale dependency); the residual risks of §6, §7 and §8; the
consequence "Same-site exposure"; §10 after ADR-129. The product owner
asked on 2026-11-15 that a project's **Where students work** offer the same
Chromebook choice as an exam's **Allowed devices**, and settled points 1
to 4 below after a spec challenge (marked *owner*). Where a point says
*proposal*, it is the shape this record gives the owner's decision, for the
implementer's PR to confirm or amend; it is not the owner's.

1. **Order** (*owner*). Built now, behind the server flag
   **`KIOSK_PROJECTS`** (`flag()` of `apps/api/src/config.ts`, default
   off; off in production). The owner then runs two hardware proofs before
   production turns it on: **project proof B** (an `online_seb` project
   under a real Safe Exam Browser, on staging: PROGRESS M6-07; exams' proof
   B is done, ADR-051's amendment of 2026-10-10) and **proof K** (§9: a
   real station framing the portal — the websocket, the service worker,
   the webviews, the clipboard, the shortcuts, the portal's cookies across
   the 303 of `/launch`; the Admin console's URL allowlist gains the
   portal's host). Proof K stands on ADR-051's own station checks
   (`docs/development/kiosk.md` §7). This waives §9's "implementation
   waits", **not the proofs**: production stays gated on both.
   *Proposal:* with the flag off — or `KIOSK_ATTESTATION=off` — the routes
   of this record are not registered (404), the setting offers no station
   level and the mode route refuses one as an invalid body (400). A live
   project already holding a station level keeps it: a rule announced to
   students is never rewritten by a switch; the flag is turned off only
   when no live project holds one.
2. **Four levels** (*owner*), like an exam: **Any / SEB / SEB or kiosk /
   Kiosk only**. This reverses §1's deferral of kiosk-only projects.
   *Proposal* — the smallest model, with no fourth work mode:
   - `online_seb` stays THE supervised mode. What it implies is supervision,
     not SEB, and holds at every station level: nobody invited
     (`collaboratorPermission`), the workspace seeded from the distribution
     repository (ADR-078 §2's read grant), the deadline kept under `commit`
     (#958), the staff's review refused until the deadline is applied
     (ADR-129, `review_exam_open`), the portal's exam mode.
   - One project column, `projects.kiosk`: a closed list
     `KIOSK_LEVELS = ["off", "also", "only"]` in `@quiz/domain`
     (`workMode.ts`, `as const`, re-exported by `@quiz/contracts`), default
     `off`, meaningful under `online_seb` only; the mode route stores `off`
     with any other mode, so a row never holds a dead value.
     `ProjectWorkModeBody` gains `kiosk` (§2's boolean becomes this list).

     | Level shown | `work_mode` | `kiosk` | Trusted clients |
     | --- | --- | --- | --- |
     | Any | `free` or `online` | `off` | none: unsupervised, unchanged |
     | SEB | `online_seb` | `off` | `seb` |
     | SEB or kiosk | `online_seb` | `also` | `seb`, `kiosk` |
     | Kiosk only | `online_seb` | `only` | `kiosk` |

     Not two booleans as on an evaluation (`trustedClientsOf`): under
     `online_seb` both off would be a fifth state, supervised by nobody,
     which the three values cannot hold.
   - One reader, `projectTrustedClients(mode, kiosk): TrustedClient[]`,
     beside `trustedClientsOf` and in `TRUSTED_CLIENTS`' order; every rule
     that depends on the level asks it: the start route, the station launch
     (§4), the `.seb` and its ticket (`sebProjectSeat` serves none when
     `seb` is not accepted), `GET /pair/:code`'s list (§5), the student's
     project page.
   - `workspaceStartRefusal` takes the session's trusted kind
     (`via: TrustedClient | null`) instead of `fromSeb`/`fromKiosk`, and
     refuses unless the level accepts it: `seb_required` when `seb` is
     accepted (the page offers SEB, and names the stations at "SEB or
     kiosk"), a new `kiosk_required` at Kiosk only (the page sends the
     student to a station and offers no `.seb`).
   - **Frozen with the mode.** `workModeRefusal` compares (mode, level)
     pairs: changing either after the first student launch
     (`codespace_projects.first_launch_at`) is `409 work_mode_frozen`;
     before it, any pair may change. The grant and group rules stay the
     mode's. `codespace.work_mode`'s payload carries the level. A staff
     seat's launch still freezes nothing (ADR-077), and launches at its
     project's level like a student's.
   - The portal is told nothing new by the sync: its `/launch` decides from
     the token's `seb` or `kiosk` claim (§4).
   - *Proposal, not for this record:* `online_seb` misnames Kiosk only.
     Keep the stored value and the API name (a rename touches the column's
     enum, the contracts, the web, the mock and every test, for no
     behaviour) and change only the UI's label; a rename to, say,
     `online_supervised` is a refactoring of its own if wanted.
3. **Quota** (*owner*). §12's rule is kept: an administrator raises the
   quota holder's quota (ADR-047 M6-06 (B), (C)) before a sitting; the
   project's setting **warns** when the classroom's claimed seats exceed
   that quota, and the portal's 429 stays the only enforcement — §12's
   "not opened to a class larger than the quota" reads as that warning,
   never a refusal by Quiz. §12's
   "wait for M6-05" is stale: M6-05 is done (2026-10-09) and set no larger
   default. Every grant is 2 today (`DEFAULT_MAX_ACTIVE_SESSIONS`, and all
   seven production rows read on 2026-11-15), so **a room does not fit
   without that administrator step**.
4. **Accepted residual risks** (*owner*):
   - (a) **Suspension** (§7). A suspended station only covers the frame;
     the portal's writes continue. Weaker than an exam's `423
     kiosk_suspended` (N-SEC-10).
   - (b) **The shared station's shadow cookie.** Student content that gets
     script on the portal's origin — the two L24 gaps of
     [ADR-047](ADR-047-espace-de-travail-en-ligne.md#amendment-2026-10-11-one-origin-for-every-session-audit-l24)
     — can set a `quiz_kiosk` cookie with `Domain=` the parent domain;
     `quiz_kiosk` is deliberately not `__Host-` (host-only, `Path=/app/api`),
     so the station's browser then sends two, and the station refuses the
     next student. Denial of service only: no credential is forged, the
     real one being `HttpOnly`. Today the parser keeps the first cookie of
     a name (`@fastify/cookie` over `cookie` 1.x) and a longer `Path` is
     sent first, so the shadow wins silently. **The implementation must
     fail closed with a clear supervisor message** on a request carrying
     two `quiz_kiosk` cookies (read from the raw `Cookie` header), with a
     test. The owner's repair is an administrator's Retire then Reactivate.
     *Unverified:* that resets the station's row, not its browser, and the
     server cannot expire a cookie whose `Path` it does not know; proof K
     records whether the repair also needs the station's data cleared
     (question 74).
     **"Same-site exposure" can no longer lean on the L24 premise** as
     stated ("another browser never loads the page without the session's
     cookie"): ADR-047's
     [amendment of 2026-11-14](ADR-047-espace-de-travail-en-ligne.md#amendment-2026-11-14-the-staffs-review-session-adr-129)
     (ADR-129's review session) breaks it, and so does a shared station,
     whose next student uses the very browser where the previous one's
     content ran. What bounds it here: the portal's own cookies are signed
     (`exam_session`) or rotated (the `/s/<id>` session), the close of §6,
     the frame's sandbox, the fail-closed check above. The full fix stays
     a subdomain per session (question 70).
   - (c) **The deadline** (§8). The station's session ends at the
     student's effective deadline (a per-student extension follows the
     repository's own deadline, ADR-078 §2: `effectiveDeadline`), not at
     deadline plus the grace.
5. **Refreshed, not changed.**
   - **Proof B.** Done for exams (2026-10-10, `SEB_CONFIG_KEY_ENFORCE=1` in
     production and staging); the project flow's run is still owed.
   - **Framing (§10) and ADR-129.** The portal's header is per host, so
     `frame-ancestors 'self' <Quiz origin>` covers the review session's
     pages too (`GET /review`, `/s/<id>/`). It does not matter: only
     Quiz's own origin may frame them, Quiz serves no student script
     (`script-src 'self'`), and no Quiz page but the station page frames
     the portal; a Quiz page turned against a review would need an XSS on
     Quiz, which is worse already. A review session stays a top-level tab.
   - **The pairing hold (§6) is kept**: it fails closed. With the portal
     down, the close job retries and the station shows "call the
     supervisor"; the supervisor seats the student at another station, or
     in SEB at "SEB or kiosk". The station frees itself when a retry goes
     through; once the retries are exhausted, an administrator retires and
     reactivates it after the portal answers again and the workspace is
     shown closed in the project's workspace list.
6. **Delivery** — four PRs, tracked as M6-11a–d in
   [merge progress](../merge/PROGRESS.md) (card M6-11 of
   [the task cards](../merge/09-tasks.md)): the API behind the flag; the
   portal; the end of a session; the web.
