# ADR-089 — Kiosk stations for the online workspace: the station stays on Quiz and frames the portal

## Status

Accepted (2026-11-15): the product owner's four decisions and the model and rules settled at review
the same day, in the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag),
which overrides §1, §2, §4, §6, §9 and §12 where it says so. Proposed 2026-10-09 (points 1, 7 and 9 the
owner's then). Built behind `KIOSK_PROJECTS`; production waits for project proof B and proof K.
Delivery: [merge progress](../merge/PROGRESS.md), M6-11a–f.

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
  (`WORKSPACE_START_ROUTE`, `apps/api/src/modules/codespace/routes.ts`)
  declares `PROJECT_SEB`, `sessions: ["portal", "seb"]`
  (`apps/api/src/auth/session.ts`). The session hook (`auth/plugin.ts`)
  checks `serves` before any trust check, so a `kiosk` session is anonymous
  there and the station is sent to the sign-in. The portal must never see the
  station's cookie; widening it to `Domain=chevallier.io` would hand it to a
  host that serves student-controlled content.
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
   *Amended 2026-11-15: the boolean becomes the project's device level, in
   the evaluations' vocabulary, offered only while `kioskProjectsOn` —
   points 1 and 2 of the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
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
4. **The launch.** *Amended 2026-11-15 (review): one start route.* The
   station page asks the student's own start route,
   `POST /app/api/projects/:id/workspace/start`, for the launch URL and puts
   the returned `{ url }` in its frame. That route is a write under
   `/app/api`: the station's cookie is sent, a suspended station gets the
   `423`, CSRF applies. The declaration `PROJECT_SEB` becomes
   `PROJECT_CONFINED`, `{ sessions: ["portal", "seb", "kiosk"],
   activities: ["project"] }`; it declares the two routes `PROJECT_SEB`
   declares today, this one and `GET /app/api/student/projects/:id`
   (`modules/project/routes.ts`), and the test set `PROJECT_SEB_ROUTES`
   (`auth/testing.ts`) becomes `PROJECT_CONFINED_ROUTES`. Widening both is
   safe: each loads through the same guard below, which admits a confined
   session of THIS project only. The start route also gains
   `freshAttestation: true`, which `trust.ts` reads in its `kiosk` branch
   only (`kioskAttestationRefusal`): a station's launch needs an
   attestation less than two minutes old, as the submit does (ADR-051 §6).
   **Access is loaded first** (invariant 6): `sebProjectSession`
   (`modules/guards.ts`) becomes one `confinedProjectSession(auth,
   projectId)` over `isTrustedClient(auth.kind)` — a non-delegated
   confined session of THIS `:id` — which feeds `findStudentProjectView`
   (the classroom's student branch with the caller's claimed seat) and the
   session's trusted kind `via`. Any mismatch answers the 404 of a missing
   project. Then `workspaceStartRefusal` decides the refusals a student can
   read, the level among them (amendment, point 2). From a `kiosk` session
   the launch token carries a new claim `kiosk: { deviceId, sitting }` in
   `LaunchTokenClaims` (`@quiz/contracts`), `sitting` being the approving
   pairing's id (amendment, point 4); the answer stays `no-store`, the token
   unlogged, its `jti` audited. The portal's `/launch` in exam mode refuses
   a token with neither `seb` nor `kiosk`; with `kiosk` it skips the SEB
   header check and sets its `exam_session`, carrying the `sitting`. The
   portal never calls Google.
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
6. **The end, and the shared station.** A project kiosk session's end
   closes the portal session it opened, so a workspace is never left open
   to the next student; leaving early hands nothing in (the project is
   graded from its repository at the deadline, as ever), and the portal
   never decides the end. *Amended 2026-11-15: the ends, the close and the
   hold are point 4 of the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
7. **Suspension v1** (owner). A suspended station covers the iframe with
   ADR-051's suspension screen, and `kiosk.suspended` names the project.
   The work is not frozen on the portal: like SEB, the portal checks trust
   at launch only. **For the owner: N-SEC-10's suspension is weaker on this
   path** — a screen over the iframe, while writes to the portal continue,
   where an exam's suspension is the server's `423`. A portal "suspend"
   message is a possible later step, not promised here.
   *Accepted as a residual risk, 2026-11-15 (owner): point 5 (a) of the
   [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
8. **The deadline.** **For the owner: the station's session ends at the
   effective deadline, not at deadline plus the grace** that ADR-078 §7
   grants the git relay; a push in flight at the deadline still lands
   within the grace, but the student cannot keep working on the station.
   When the portal answers 403 because its 4 h `exam_session` expired
   before that, the station page relaunches (point 4); resuming a workspace
   consumes no quota. *Accepted as a residual risk, 2026-11-15 (owner):
   point 5 (b) of the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
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
    *Since 2026-11-14 the header also covers ADR-129's review sessions;
    harmless — point 6 of the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
11. **Same site, required.** Quiz and its portal stay on the same
    registrable domain in each environment. A host move that breaks this
    reopens the decision: a cross-site frame loses its cookies.
12. **Capacity.** A kiosk project is not opened to a class larger than the
    quota that carries it (ADR-047 amendment "M6-06" (C)); the portal
    enforces it (its 429, shown on the station). ~~Room-sized sittings wait
    for M6-05.~~ *Amended 2026-11-15 (owner): M6-05 is done and changed no
    quota; the setting warns, and an administrator raises the holder's
    quota before a sitting — point 7 of the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
13. **Audit.** `codespace.launch_issued` gains `kiosk: true` for a station's
    launch; `kiosk.paired` and `kiosk.suspended` may name a project; the
    union gains `codespace.session_closed` (the cause: `left`,
    `superseded`, `deadline`, `expired`; since 2026-11-15 also `retired` and `swept`, amendment point 4) and `codespace.session_close_failed`
    for the portal close of point 6; the setting is audited as point 2
    says. No token or cookie is written.

## Consequences

- ADR-051's machinery is reused whole; the cost is on the edges: a
  migration (`kiosk_pairings.project_id`, the project's device level), the
  start route widened to `kiosk` and its one confined-session guard, the
  pairing list, the end sweep and `endKioskSessions` keyed by activity, the
  close job and the pairing hold, `watch` learning projects, the station's
  cookie renamed `__Host-`, one CSP source on one page, and on the portal
  the `kiosk` claim, `frame-ancestors` and the close message.
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
  ADR-129's review session and a shared station both break it; point 3 of
  the [amendment of 2026-11-15](#amendment-2026-11-15-accepted-four-levels-built-behind-a-flag).*
- `00` §0.6 ("fallback stations for an exam") becomes "for an exam or a
  supervised project" when this ADR is accepted; the spec edit lands with
  acceptance (*done 2026-11-15; `CLAUDE.md` invariant 6 changes with the
  code, M6-11b and M6-11d*). N-SEC-10's blocking exception applies at launch.
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
- **A station launch route of its own** (`POST …/workspace/launch`, this
  record's first §4, which also kept the station's cookie on `/app/api` and
  taught the refusal a `fromKiosk` beside `fromSeb`). The start route was
  then `GET /app/codespace/start/:id`, outside that cookie's path, and a GET
  passes a suspended station and escapes CSRF. Dropped at review,
  2026-11-15: since audit L7 the start route is a POST under `/app/api`
  with CSRF and the `423`; a second route would duplicate its loader and
  its refusals.
- **Keeping the bare `quiz_kiosk` and accepting its shadowing.** The owner
  accepted that denial of service before the `__Host-` rename was on the
  table; rejected at review (amendment, point 3).

## Amendment 2026-11-15: accepted, four levels, built behind a flag

Scope: §1 (reversed), §2 (the setting), §4 (one start route), §6 (every
end closes), §9 (sequencing), §12 (quota); the residual risks of §7 and
§8; the station's cookie; the consequence "Same-site exposure". The
product owner asked on 2026-11-15 that a project's **Where students work**
offer the same Chromebook choice as an exam's **Allowed devices**, and
settled four points after a spec challenge, marked *owner*. Everything
else below was settled at review the same day (the orchestrator, as
reviewer in charge), marked *review*: it is not the owner's.

1. **Order** (*owner*). Built now, behind the server flag
   **`KIOSK_PROJECTS`** (`flag()` of `apps/api/src/config.ts`, default
   off). Production turns it on only after two hardware proofs on staging:
   **project proof B** (an `online_seb` project under a real Safe Exam
   Browser, PROGRESS M6-07) and **proof K** (§9; the Admin console's URL
   allowlist gains the portal's host; it stands on ADR-051's own station
   checks, `docs/development/kiosk.md` §7). This waives §9's
   "implementation waits", **not the proofs**.
   *The flag's rule* (*review*). One predicate,
   `kioskProjectsOn(config) = KIOSK_ATTESTATION !== "off" && KIOSK_PROJECTS`,
   read in exactly two places: the mode write refuses a change TO a station
   level with the existing `422 kiosk_unavailable` (as
   `modules/evaluation/writes.ts` does for an exam), and the work-mode
   payload exposes `kioskOffered`. A (mode, level) pair re-sent unchanged is
   never refused (`workModeRefusal`'s `from === to`), and leaving a station
   level always passes. **A live project that already holds a station
   level keeps it, and its stations keep working, flag off or on**: the flag
   gates new choices, it is not a kill switch. That is safe because no
   guarantee of the station path depends on the flag, and the kill switch
   stays `KIOSK_ATTESTATION=off`, which removes every kiosk route and stops
   every station, exams included, as today (its effect on project sittings:
   point 4). The other reading — refuse the stations of a live project —
   would strand a Kiosk only project, whose level is frozen once launched.
2. **Four levels** (*owner*), like an exam: **Any / SEB / SEB or kiosk /
   Kiosk only**. This reverses §1's deferral of kiosk-only projects.
   *The model* (*review*: proposed in this record and accepted at review,
   not the owner's):
   - **One vocabulary.** The four levels exist once today, as the web's
     `CHOICES` (`apps/web/src/evaluation/AllowedDevices.tsx`, ids `any`,
     `seb`, `either`, `kiosk`, strings `eval.devices.*`). That table moves
     to `@quiz/domain` as `DEVICE_LEVELS`, each level with its
     `TrustedClient[]` (`any` none, `seb` `seb`, `either` both, `kiosk`
     `kiosk`, in `TRUSTED_CLIENTS`' order); `AllowedDevices` reads it for
     evaluations (whose two booleans map to a level there), and a project
     reads it too.
   - **No fourth work mode.** `online_seb` means supervised; only its UI
     label changes, a rename is out of scope. What it implies holds at every
     station level: nobody invited, the workspace seeded from the
     distribution repository, the deadline kept under `commit`, the staff's
     review refused until the deadline is applied, the portal's exam mode.
   - **One column, one mapping.** `projects.devices` holds a level id,
     default `any`. `ProjectWorkModeBody` becomes a union discriminated by
     `mode`: `devices` (`seb`, `either` or `kiosk`) is present with
     `online_seb` only and absent otherwise, where the server writes `any`;
     the schema refuses a mismatched pair (invariant 7), and a check
     constraint on the column only backs it up. One pure mapping in
     `@quiz/domain` turns `(work_mode, devices)` into the level the screen
     shows and back. `codespace.work_mode`'s payload carries `devices`.
   - **One control.** The project's setting is a Segmented
     **Own tools | Online workspace**, and under Online the same
     `AllowedDevices` radio list, its props generalised to a level,
     `kioskOffered` and `onPick`: Any is `online`, the three others
     `online_seb` with their level.
   - **The refusal.** `workspaceStartRefusal` takes the session's trusted
     kind (`via: TrustedClient | null`, from `confinedProjectSession`, §4)
     instead of `fromSeb`, and refuses unless the project's level accepts
     it: `seb_required` when `seb` is accepted, a new `kiosk_required` at
     Kiosk only (the student's page offers no `.seb` and sends the student
     to a station; `sebProjectSeat` serves no `.seb` there).
   - **Frozen with the mode.** `workModeRefusal` compares (mode, devices)
     pairs: changing either after the first student launch
     (`codespace_projects.first_launch_at`) is `409 work_mode_frozen`. The
     grant and group rules stay the mode's. A staff seat's launch still
     freezes nothing (ADR-077) and launches at the project's level.
3. **The station's cookie becomes `__Host-quiz_kiosk`** (*review*,
   2026-11-15; the owner had accepted a shadowed station cookie as a denial
   of service before this was known). The bare `quiz_kiosk`
   (`Path=/app/api`) had one stated reason, this record's first §4 (audit
   L8 left it out of the prefix for it, `apps/api/src/auth/cookies.db.test.ts`);
   with one start route nothing needs it. Over https the station's cookie
   is `__Host-quiz_kiosk; Path=/; Secure; HttpOnly; SameSite=Strict`,
   named by `cookieName` like the session's. A sibling host can neither set
   nor shadow it, and the browser holds one per host and path, so two
   cannot arrive. Before, student script on the portal's origin (ADR-047's
   L24 gaps) could set `quiz_kiosk` for the parent domain; a longer `Path`
   is sent first (RFC 6265 §5.4) and the parser keeps the first cookie of a
   name (`@fastify/cookie` over `cookie` 1.x), so the station was refused.
   It could only deny: Quiz's session and CSRF cookies are already
   `__Host-` (audit L8).
   - **Its own PR, first, without a flag** (M6-11a): it touches the 19
     active production stations, which serve exams, and nothing of
     projects. One reader, `stationCredential(req)`, replaces every
     `req.cookies[KIOSK_COOKIE]` (`auth/trust.ts`,
     `modules/kiosk/routes.ts`): the prefixed cookie when present, else the
     bare one. The credential's value is unchanged: `verify` keeps the
     credential the request holds for that device, writes it under the new
     name and expires the bare one (`Path=/app/api`, `Max-Age=0`,
     host-only: the one Quiz set). A station re-attests within minutes —
     before each pairing code at rest, every 10 minutes in a sitting
     (ADR-051's amendment of 2026-11-10) — so it moves at its next
     attestation without losing its sitting.
   - **The fallback's removal** belongs to M6-11d — delivered as its own
     PR, M6-11f (split at delivery, 2026-11-15, so that the closes of
     M6-11d wait for no gate) — and is **merged only once
     M6-11a has run in production for 12 h**: a production approval ships
     whatever `main` holds, and a bare cookie, never issued after M6-11a,
     lived 12 h at most (`KIOSK_COOKIE_HOURS`). Until then no station frames
     the portal (`KIOSK_PROJECTS` is off), so no shadow can be planted.
   - **What remains on a shared station.** The L24 premise ("another
     browser never loads the page without the session's cookie") fails
     twice: ADR-129's review session ([ADR-047's amendment of
     2026-11-14](ADR-047-espace-de-travail-en-ligne.md#amendment-2026-11-14-the-staffs-review-session-adr-129))
     and a shared station, whose next student uses the browser where the
     previous one's content ran. What still bounds it: Quiz reads only
     `__Host-` cookies there; the portal's own are signed (`exam_session`)
     or rotated (the `/s/<id>` session); the close of point 4; the frame's
     sandbox. Left: cookies planted for the parent domain in volume can make
     the station's requests too large to serve — a denial of service, no
     identity, repaired by clearing the station's browser data (question
     73). The full fix stays a subdomain per session (question 70).
4. **Every end closes the portal** (*review*; owns the ends, the close and
   the hold of §6).
   - **The sitting is the pairing row.** The approving `kiosk_pairings`
     row is the durable record of a project sitting: it names the station
     (`device_id`), the student (`user_id`, set on approval) and the
     activity (`project_id`, added beside `evaluation_id` with a
     one-activity check), outlives the session (no code deletes a pairing;
     a consumed one stays `consumed`), and gains `close_completed_at`. Its
     id is the `sitting` of §4. A session row is never the record and its
     key never leaves Quiz: `sessions.sid_hash` is the hash of the bearer
     token (`apps/api/src/db/auth.ts`). The session points to its sitting
     by a new `sessions.kiosk_pairing_id`, set when the station consumes
     its approved pairing. `project_id` is `ON DELETE SET NULL`, so
     deleting a project leaves the sitting to be closed by its id alone.
   - **The ends.** Leave this station; replacement by a newer confined
     session of the pair (`supersede`); the student's effective deadline;
     the 6 h lifetime; the station's retirement (`endStationSessions`).
     The ticker's sweep (ADR-006) ends station sessions at the effective
     deadline and past their `expires_at` (expiry is otherwise lazy, at
     the next request). One `endKioskSessions`, keyed by activity
     (`{ evaluationId } | { projectId }`), serves them all.
   - **Every disappearance closes.** Session rows also vanish by lazy
     expiry, by `purgeExpiredSessions`, by the account module
     (`modules/account/service.ts`, through `quiz_pseudonymize_account`)
     and by cascades. Two rules cover them all: (1) `dropSessions`
     (`auth/session.ts`), the one place sessions are deleted, enqueues the
     close for every removed `kiosk` row with a `project_id`, whatever the
     reason, and the account module goes through it; (2) the sweep enqueues
     the close of every `consumed` project pairing with no live session and
     no `close_completed_at` — the safety net that makes a cascade or any
     forgotten path harmless.
   - **The close** is a pg-boss job, retried and idempotent, sending a new
     HS256 service message (its own audience) naming the `sitting` (and the
     project when it still exists). The portal tags each socket it upgrades
     with the `sitting` of the `exam_session` it was upgraded under; the
     close revokes the `exam_session` cookies of that sitting and drops
     every socket of that sitting, unconditionally. A `seb` launch's cookie
     carries no sitting, so the student's own SEB session is never cut.
     The portal session (`/s/<id>`, one per student and assignment) is
     rotated only when that sitting opened it last: if another browser
     resumed it since, its cookie was already rotated away from the
     station. The container and its volume are untouched. On success Quiz
     sets `close_completed_at`; retries exhausted are audited.
   - **The kill switch never stops a close.** The sweep and the close job
     run whatever `KIOSK_ATTESTATION` and `KIOSK_PROJECTS` say (today the
     kiosk ticker task returns early when `KIOSK_ATTESTATION` is off,
     `modules/kiosk/jobs.ts`); with `KIOSK_ATTESTATION=off` the sweep ends
     every project station session, which enqueues their closes by rule (1).
   - **The hold.** A station cannot be paired, for an exam too, while it
     has a project pairing without `close_completed_at` (`/kiosk` shows
     "call the supervisor"). With the portal down the job retries; the
     supervisor seats the student at another station, or in SEB at "SEB or
     kiosk". Retries exhausted: an administrator retires and reactivates
     the station once the portal answers and the workspace shows closed.
     *Delivery, 2026-11-15 (M6-11d review):* with the portal off
     (`CODESPACE_URL` empty) the close completes without a call and without
     an audit row, since no launch could be issued; a portal turned off
     after a launch therefore leaves that portal session unclosed. A close
     request is marked before it is enqueued, so a crash between the two
     leaves the station held until that Retire then Reactivate.
5. **Accepted residual risks** (*owner*):
   - (a) **Suspension** (§7): a suspended station only covers the frame;
     the portal's writes continue — weaker than an exam's `423` (N-SEC-10).
   - (b) **The deadline** (§8): the station's session ends at the
     student's effective deadline (`effectiveDeadline`: a per-student
     extension follows the repository's own, ADR-078 §2), not at deadline
     plus the grace.
6. **Refreshed.** Exams' proof B is done (ADR-051, amendment of
   2026-10-10); the project flow's is owed. §10's `frame-ancestors` is per
   host, so it also covers ADR-129's review pages; harmless, since only
   Quiz's own origin may frame them and only the station page does.
7. **Quota** (*owner*). §12 is kept: an administrator raises the quota
   holder's quota (ADR-047 M6-06 (B), (C)) before a sitting; the setting
   warns when the classroom's claimed seats exceed it; the portal's 429
   stays the only enforcement. M6-05 (done 2026-10-09) set no larger
   default: every grant is 2 (`DEFAULT_MAX_ACTIVE_SESSIONS`, and all seven
   production grants on 2026-11-15), so **a room does not fit without that
   step**. Revisit if sittings fail on it.
8. **Delivery**: six PRs, M6-11a–f in [merge progress](../merge/PROGRESS.md),
   card M6-11 of [the task cards](../merge/09-tasks.md).
9. **The station page** (*review*, 2026-11-15, M6-11e). §3's event stream does not run there:
   `/app/api/events` serves no project session and is not widened. The station page polls
   `/me` every 60 s and covers its frame when its own attestation is refused or silent; the
   ends are enforced by the portal close of point 4. Proof K (§9) also checks: focus the editor,
   trigger a refused attestation, then type — do keystrokes still reach the editor under `inert`?
