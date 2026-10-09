# ADR-089 — Kiosk stations for the online workspace: the station stays on Quiz and frames the portal

## Status

Proposed (2026-10-09). Points 1, 7 and 9 below (scope, suspension,
sequencing) are the product owner's decisions of 2026-10-09; the other
points are assumed defaults the owner may amend at review. Nothing is
implemented, and implementation waits for proof B (§9).

Scope: how a student works in the online workspace of an `online_seb`
project from an attested kiosk station, across the two hosts of Quiz and
its portal; what each side checks, and how the sitting ends.

Relations: amends [ADR-051](ADR-051-postes-kiosque-attestes.md) §1 (a
`kiosk` session may be confined to a project), §7 (pairing for a project,
the end and the navigation of such a session), and its "evaluations only"
reading of D21; amends [ADR-047](ADR-047-espace-de-travail-en-ligne.md)'s
M6-07 amendment (a `kiosk` launch claim beside `seb`); answers
[ADR-075](ADR-075-question-espace-de-travail.md) §11's kiosk condition for
projects (the `workspace` question's own kiosk use stays with ADR-075).
Uses the HS256 messages of ADR-047 §6 and ADR-078 §2, and the confined
sessions of [ADR-027](ADR-027-tickets-de-lancement-et-sessions-typees.md)'s
M6-07 addendum. Settles point (c) of
[question 52](../spec/06-questions-ouvertes.md) as a proposal.

## Context

An `online_seb` project is worked in the portal (`code.chevallier.io`)
from a `seb` session confined to the project (ADR-047, M6-07). When the
student's laptop cannot run SEB, the exam fallback is a kiosk station
(ADR-051), but nothing of that path reaches the portal:

- **The station's cookie stays on Quiz.** `quiz_kiosk` is host-only with
  path `/app/api` (`apps/api/src/modules/kiosk/routes.ts`, the
  `setCookie` of `verify`); the start route `GET /app/codespace/start/:id`
  (`modules/codespace/routes.ts`) lies outside that path, so a `kiosk`
  session there fails `trustRefusal` with `kiosk_station`
  (`auth/trust.ts`). The portal must never see that cookie; widening it to
  `Domain=chevallier.io` would hand it to a host that serves
  student-controlled content.
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
  `projectId: null`, `watch.ts`'s `sittingOn`, `PROJECT_SEB`'s
  `sessions: ["portal", "seb"]` (`auth/session.ts`), and
  `workspaceStartRefusal`'s `fromSeb` (`@quiz/domain`, `workMode.ts`).
  `sessions.project_id` and its `sessions_one_activity` check already exist
  (M6-07).
- **A station is shared.** The portal's cookies stay in the station's
  browser profile after the student leaves, behind the same IP address,
  and nothing closes a portal session at the end of a sitting.
- **Scope.** `00` §0.6 and ADR-051 admit stations for exams only; ADR-075
  §11 makes the kiosk wait for proof B, which is a property of SEB, not of
  a station.

## Decision

1. **Scope: a fallback beside SEB** (owner). A project accepts a kiosk
   station only as an alternative to SEB, in `online_seb`: "SEB or
   kiosk", as for an exam whose two settings are on. Kiosk-only projects
   are deferred. No new work mode.
2. **The setting.** `kiosk: boolean`, a project setting meaningful only
   with `online_seb`, read through one reader beside `trustedClientsOf`
   (the project's trusted clients: `["seb"]` or `["seb", "kiosk"]`), and
   frozen at the first student launch with the mode
   (`codespace_projects.first_launch_at`, `409 work_mode_frozen`). Offered
   only while `KIOSK_ATTESTATION` is not `off`.
3. **The station stays on Quiz and frames the portal.** A kiosk session of
   a project is confined to one Quiz page of that project (the station
   page): a thin bar (the station's label, the server's deadline, **Leave
   this station**) above an `iframe` of the portal. Everything of ADR-051
   runs unchanged on that page: re-attestation, the 30 s retry, the event
   stream, supersession, the return to `/kiosk`. The iframe has
   `allow="clipboard-read; clipboard-write"` and a `sandbox` without
   `allow-top-navigation` or popups, so nothing the portal serves can take
   the station off the page.
4. **The launch.** The station page obtains the launch URL from
   `POST /app/api/projects/:id/workspace/launch`, declared
   `{ sessions: ["kiosk"], activities: ["project"], freshAttestation: true }`:
   under `/app/api`, so `quiz_kiosk` keeps its host-only cookie and its path;
   a write, so a suspended station is refused (`423`) and CSRF applies; and
   an attestation less than two minutes old, as for the submit (ADR-051 §6).
   It answers the portal's `/launch` URL with a token carrying a new claim
   `kiosk: { deviceId }` in `LaunchTokenClaims` (`@quiz/contracts`), and the
   station sets the iframe's `src`. The decision is `workspaceStartRefusal`,
   which learns `fromKiosk` beside `fromSeb`; the GET start route keeps
   serving portals and `seb` sessions. The portal's `/launch` in exam mode
   refuses a token with neither `seb` nor `kiosk`; with `kiosk` it skips the
   SEB header check and sets its `exam_session` as today. The station's
   cookie never crosses hosts, and the portal never calls Google.
5. **Pairing.** `kiosk_pairings` gains a nullable `project_id` with a
   one-activity check, as `sessions` has. `GET /app/api/pair/:code` also
   lists the open projects the student can start on a station (a claimed
   seat, `online_seb`, `kiosk` on, before the effective deadline of ADR-078
   §2); approval opens a `kiosk` session with `projectId`. Supervision in
   v1 is the phone only: projects have no live dashboard, hence no **Assign
   a station**. Alerts go to the audit and to the project's workspace list.
6. **The end.** A project kiosk session ends at the earliest of: **Leave
   this station**; the student's effective deadline, by the ticker-sweeper
   on the server's clock (ADR-006, invariant 5); the 6 h fixed lifetime.
   Each ends the Quiz session (`endConfinedSessions`, its event streams)
   AND orders the portal, through a new HS256 service message with its own
   audience, to close that user's portal session for the project: the
   portal refuses its `exam_session` cookies issued before the close and
   drops their sockets. The container and its volume are untouched.
   Leaving early hands nothing in: the project is graded from its
   repository at the deadline, as ever. The portal never decides the end.
7. **Suspension v1** (owner). A suspended station covers the iframe with
   ADR-051's suspension screen, and `kiosk.suspended` names the project.
   The work is not frozen on the portal: like SEB, the portal checks trust
   at launch only. A portal "suspend" message is a possible later step, not
   promised here.
8. **4 h against 6 h.** When the portal answers 403 because its
   `exam_session` expired, the station page relaunches (point 4).
   Resuming a workspace consumes no quota.
9. **Sequencing** (owner). This ADR is written now. Implementation waits
   until SEB projects are open to students (proof B recorded, M6-07).
   Offering the setting in production further requires **proof K** on
   staging, on a real station in a web kiosk with URL blocklist `*` and
   allowlist {Quiz, portal}: the iframe loads; code-server works (its
   websocket, its service worker, the clipboard, shortcuts not swallowed);
   the extension still answers the top page; the portal's cookies survive
   the 303 of `/launch` inside the iframe. Proof B is a property of SEB and
   gates nothing of the kiosk beyond the sequencing above.
10. **Framing.** The portal sends
    `Content-Security-Policy: frame-ancestors <that instance's Quiz origin>`
    in every mode, replacing `X-Frame-Options: SAMEORIGIN` (set today by
    `apps/codespace/deploy/Caddyfile`). Quiz adds `frame-src <CODESPACE_URL>`
    to its CSP (`apps/api/src/csp.ts`) on the station page only.
11. **Same site, required.** Quiz and its portal stay on the same
    registrable domain in each environment. A host move that breaks this
    reopens the decision: a cross-site frame loses its cookies.
12. **Capacity.** A kiosk project is not opened to a class larger than the
    quota that carries it (ADR-047 amendment "M6-06" (C)); the portal
    enforces it (its 429, shown on the station). Room-sized sittings wait
    for M6-05.
13. **Audit.** `codespace.launch_issued` gains `kiosk: true` for a station's
    launch; `kiosk.paired` and `kiosk.suspended` may name a project; the
    portal close is audited with the end's cause. No token or cookie is
    written.

## Consequences

- ADR-051's machinery is reused whole; the cost is on the edges: a
  migration (`kiosk_pairings.project_id`), the project route config and
  `fromKiosk`, the launch route, the pairing list, the end sweep, `watch`
  learning projects, one CSP source on one page, and on the portal the
  `kiosk` claim, `frame-ancestors` and the close message.
- The extension and its `externally_connectable` stay limited to Quiz's
  origins. The Admin console's URL allowlist gains the portal's origin;
  `docs/kiosk.md` changes when this ships, not before.
- Same-site exposure: code-server's `/proxy/<port>` serves student content
  on the portal's host, same-site with Quiz. This is already true on the
  SEB path; Quiz's double-submit CSRF and the confinement of the session to
  the project bound it, and the iframe's sandbox keeps that content from
  navigating the station.
- `00` §0.6 ("fallback stations for an exam") becomes "for an exam or a
  supervised project" when this ADR is accepted; the spec edit lands with
  acceptance. N-SEC-10's blocking exception applies at launch.
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
- **Widening `quiz_kiosk`'s path to cover the GET start route.** Viable,
  but a GET passes a suspended station and escapes CSRF; the POST of
  point 4 gets both from the existing guards.
