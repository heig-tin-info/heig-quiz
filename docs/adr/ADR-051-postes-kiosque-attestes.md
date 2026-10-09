# ADR-051 — Attested kiosk stations, paired from the student's phone, beside Safe Exam Browser

## Status

Accepted (2026-09-30, settled with the product owner on the implementation plan). Amended 2026-10-09:
the session end is `endKioskSessions` (`auth/session.ts`), formerly named `endConfinedSessions` here;
§10's delivery plan is removed (delivery lives in `docs/merge/PROGRESS.md` and `changes/`), its step 0
stays as §10; §1 names the stale-submit refusal (`423 kiosk_attestation_stale`) the code already answers.

Scope: for **evaluations only**, the part of merge decision D21 (`docs/merge/08-decisions.md`) that
concerns how a SEB session is checked; the confinement of a session to an **activity** (a project) was
outside this decision. D21 was subsequently settled on 2026-10-01 for M6; see
[ADR-027](ADR-027-tickets-de-lancement-et-sessions-typees.md)'s Status for that scope and its
implementation boundary.

Relations: amends ADR-027 (§2 the Config Key, §3 the cookie and the lifetime of a confined session)
and the scope of `docs/spec/00-cadre-et-perimetre.md` §0.6. **Amended by
[ADR-089](ADR-089-kiosque-pour-l-espace-de-travail.md) (proposed, 2026-10-09)**: §1, §4 and §7 for a
`kiosk` session confined to an `online_seb` project, which frames the online workspace from a Quiz
page; the rules below for evaluations are unchanged.

## Context

An exam that requires Safe Exam Browser (ADR-027) is sat on the student's
own laptop. When that laptop fails — a flat battery, a SEB that refuses to
start, an unsupported OS — the student has nowhere to go. The school owns
Chromebooks managed by its Google Workspace. Locked in a web kiosk on
`/kiosk`, one of them is a fallback station that needs no SEB. It is also a
device whose integrity Google can attest in hardware (Chrome Verified
Access): the platform can know that the request comes from one of its own
Chromebooks, in verified boot mode, and not from a copy of the page in a
laptop's browser.

A kiosk is nobody's machine. It cannot sign in with edu-ID, and must not:
the second factor is on a phone. But the student's phone is already signed
in to the portal, and nothing is being sat yet. The device authorization
grant of RFC 8628 was made for this case: a device with no keyboard worth
typing a password on shows a short code, and the user approves it on a
device where they are signed in.

While this was planned, three things came out of ADR-027 that the request
had assumed otherwise:

- the `.seb` start URL carries a one-time **ticket**, not a signed token,
  and it is already exchanged for a session cookie (ADR-027 §1–2);
- no Browser Exam Key is checked (§2 rejected a BEK list);
- the Config Key is checked on the launch route only.

## Decision

### 1. A trusted client is a session kind

The two ways of sitting a locked exam are two confined session kinds:
`seb` (ADR-027) and a new `kiosk`. Both are confined to one evaluation by
`sessions.evaluation_id`. Both reach only the routes that declare them: the
`SITTING` config gains `kiosk`, and every other route stays anonymous to them
(ADR-027 §3, default deny). There is no provider class. The difference
between them is one function per kind, `trustRefusal(kind, …)`, called by the
session hook of `auth/plugin.ts` on every request of a confined session:

- a `seb` session: the Config Key header of this request (§3);
- a `kiosk` session: the request also carries the station's own cookie
  (`quiz_kiosk`, §5), whose hash is the credential of the session's
  `device_id`; the device is `active`; and its attestation is not refused
  or silent (§6). Without the station's cookie, the session cookie alone is
  worth nothing: it cannot be carried to another machine, the weakness §3
  closes for SEB.

A refusal makes the request anonymous (the same answer as a missing
session), except the suspension of §6. That answers `423 kiosk_suspended`
on unsafe methods only (writes). A GET and the event stream pass, so that the
page can still read the attempt, say why it is suspended, and hear the
resumption: `EventSource` stops for good on a non-200.

*Amended 2026-10-09 (documents existing behaviour, reported to the product
owner):* a second refusal is not anonymous either. A submit of a `kiosk`
session without an attestation check less than two minutes old (§6) answers
`423 kiosk_attestation_stale`, which the page meets by re-attesting and
retrying once (§6). The code already does so: `kioskAttestationRefusal` and
`trustRefused` (`auth/trust.ts`), answered by the session hook of
`auth/plugin.ts`.

### 2. Which trusted clients an exam accepts

`settings.kiosk: boolean` joins `settings.safeExamBrowser`. Both are read
through ONE reader, `trustedClientsOf(mode, settings)` in `@quiz/domain`,
which returns `("seb" | "kiosk")[]`. Like SEB, the kiosk is an exam's
setting, inert on every other mode. No stored row changes:

| `safeExamBrowser` | `kiosk` | The exam is sat |
|---|---|---|
| off | off | in the portal (today's default, unchanged) |
| on | off | in SEB only (today's SEB exam, unchanged) |
| off | on | on a kiosk station only |
| on | on | in SEB or on a kiosk station |

`sitRefusal` (`modules/guards.ts`) is THE rule:
- a confined session sits its own evaluation, and only while that evaluation
  still accepts its kind;
- a portal session sits an evaluation only when `trustedClientsOf` is empty;
- the IP allowlist applies to every kind, the kiosk included.

Both settings are frozen with the rest of `settings` once the evaluation
runs or has an attempt (`configLock`).

### 3. Safe Exam Browser, checked on every request

ADR-027 §2 checked the Config Key once, at launch. The confined session was
then trusted for 6 h, including from any HTTP client holding its cookie.

- **The Config Key is stored on the session** (`sessions.seb_config_key`),
  at launch. It cannot be recomputed later: it is a function of the start
  URL, whose ticket secret the server never keeps. On every request of a
  `seb` session, the hook checks
  `X-SafeExamBrowser-ConfigKeyHash = SHA-256(absolute URL + Config Key)`.
  The absolute URL is the origin of `PUBLIC_URL` followed by the
  request's path and query **as received** (`req.raw.url`, never re-encoded
  through `URL`), since SEB hashes the URL it requested. The existing vector tests (Moodle, 201 keys) are joined by
  per-request vectors, one of them with a percent-encoded query.
- **Audit-only until proof B.** Nobody has yet watched a real SEB send the
  header on `fetch` and `EventSource` requests (proof B of
  `docs/merge/06-codespace-seb-infra.md` §6.3). If one does not, enforcing
  would lock every SEB student out mid-exam. `SEB_CONFIG_KEY_ENFORCE`
  (default `0`) therefore only audits a mismatch
  (`auth.seb_config_key_mismatch`, once per session and route
  template, deduplicated in the process's memory: best effort, a restart
  may write one more) until proof B
  is recorded; after that it is set to `1` and the mismatch refuses. The
  launch route keeps refusing a bad header in both modes, as today.
- **Still no Browser Exam Key**, for the reason of ADR-027 §2. The
  header remains what ADR-027 says it is: it stops the accidental and the
  lazy. The security boundary is the confined session.

### 4. Confined sessions: one at a time, strict cookie

- **A new confined session supersedes the old one.** Opening a `seb` or
  `kiosk` session for a (user, evaluation) deletes every other confined
  session of the same pair, and, for a `kiosk` one, every session still
  holding that `device_id`, expired rows included. Both deletions come
  before the insert, in one transaction, which is what lets the partial
  unique index on `device_id` (§7) hold. It writes
  `auth.session_superseded` (the kinds, and the device label when there was
  one) and a staff event on the dashboard. The portal sessions of the user
  are never touched: the phone that approves a pairing is one of them, and
  so is a teacher's portal beside their SEB rehearsal (ADR-018).
- **A confined session's cookies are `SameSite=Strict`**: the session
  cookie and the CSRF cookie `openSession` mints with it. Nothing
  cross-site ever needs to carry a SEB or kiosk session. A navigation that
  SEB or the kiosk shell starts is not cross-site, and a cookie set on the
  launch response survives its 303. The portal keeps
  `Lax`, because the OIDC callback is a cross-site navigation (N-SEC-01,
  amended).
- ADR-027's rules on lifetime are otherwise unchanged. A `seb` session lives
  6 h and outlives the submit, so that SEB shows the closed attempt. A
  `kiosk` session is also fixed at 6 h, never sliding, but it does not
  outlive the attempt (§7).

### 5. The station registry and the attestation

**The registry.** `kiosk_devices`:
- `google_device_id`: unique; it is Verified Access's `devicePermanentId`;
- `label`: "Poste de secours n° 7";
- `status`: `unnamed | active | retired`;
- `attested_at`: the last attestation Google accepted;
- `checked_at` and `attestation`: `ok | unavailable | refused`, the last
  attempt (§6);
- `credential_hash`: the SHA-256 of the station's cookie;
- `watch`: `ok | unavailable | suspended`, what the supervisor was last
  told of the station (§6), so that each change is told once.

A device that attests successfully for the first time is created
`unnamed`. An admin names it (it becomes `active`) or retires it, from a
page of the admin panel. The registry is platform-wide and admin-only: a
station belongs to no course. **An `unnamed` or `retired` station cannot
be paired.** It shows "Station not recognised, call the supervisor". This
is also what keeps the registry from being a hole: the Workspace's customer
id admits every Chromebook the school manages, and only those an admin has
named are exam stations.

**The attestation** follows Google's current documentation (API v2; v1
is deprecated):
- `POST /app/api/kiosk/attest/challenge` calls
  `POST https://verifiedaccess.googleapis.com/v2/challenge:generate` (an
  empty body) and returns `{challenge}` in base64. A challenge is valid for
  one minute.
- The page passes it to the companion extension
  (`extensions/kiosk-attestation/`, Manifest V3, `enterprise.platformKeys`).
  The page reaches the extension with `chrome.runtime.sendMessage` to the
  configured extension id, allowed by the extension's
  `externally_connectable`. The extension calls
  `chrome.enterprise.platformKeys.challengeKey({scope: "MACHINE", challenge})`
  and returns the response in base64.
- `POST /app/api/kiosk/attest/verify` calls
  `POST …/v2/challenge:verify` with `{challengeResponse, expectedIdentity}`,
  where `expectedIdentity` is the enrollment domain. It then requires:
  - `customerId` equal to `KIOSK_GOOGLE_CUSTOMER_ID`;
  - `keyTrustLevel` equal to `CHROME_OS_VERIFIED_MODE`, never developer mode;
  - a `devicePermanentId`.

  On success it creates or updates the device and sets the `quiz_kiosk`
  cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, path `/app/api`, 12 h).
  When the request's cookie already names that device, its credential is
  KEPT and the same cookie re-set, which extends it by 12 h: a write of the
  sitting sent while a re-attestation is in flight carries the cookie of
  before, and must not turn anonymous. A new credential is drawn only when
  the request holds no valid cookie for the device (a first attestation, a
  lost or expired cookie, another device's); the previous one then stops
  naming it at once. That cookie is the station's identity, never a user's;
  §1 requires it beside a `kiosk` session.
  The trade-off is accepted: a copied `quiz_kiosk` cookie is not invalidated
  by the station's next re-attestation. It is `HttpOnly` on a locked kiosk,
  worth nothing without the session cookie of a live kiosk session (which
  ends with the sitting), and dies with the station's retirement or a new
  credential. Rotating on every attestation was dropped: it answered the
  in-flight writes 401 and could drop a station out of its attempt.
- The service account authenticates with the OAuth 2.0 JWT-bearer grant
  and the scope `https://www.googleapis.com/auth/verifiedaccess`. Its key is
  a file named by `KIOSK_VA_KEY_FILE`, outside the repository and the
  database (ADR-010). The access token lives in memory only.
- `KIOSK_ATTESTATION=google | mock | off` (default `off`: the routes answer
  404 and the setting of §2 is not offered). Under `NODE_ENV=production`,
  `config.ts` refuses to start with `mock`, and with `google` whose key file
  is unreadable or whose customer id, enrollment domain or extension id is
  missing — exactly like the development login. `mock` accepts a response of
  the form `mock:<device id>` and nothing else; `mock:refuse` and
  `mock:unavailable` are test fixtures that never attest (they answer a
  refusal and an unavailable Google).

What the attestation proves: a Chromebook of the school's Workspace, in
verified boot mode, holds the key. What it does not prove by itself: that
the station is in kiosk mode. That is the device policy of its
organizational unit (`docs/development/kiosk.md`), and the naming step of an admin.
Google's separate kiosk-mode check (a USER key, `expectedIdentity:
"KIOSK_MODE"`) is not used in v1: it does not return the device id, and it
would double every attestation.

**Staging** has its own configuration (`off` by default), and may use its
own service account key. The extension lists both origins in
`externally_connectable`: `https://quiz.chevallier.io/*` and
`https://quiz.dev.chevallier.io/*`.

### 6. Re-attestation and suspension

While a kiosk session sits, the page re-attests every 10 minutes, and when
the submit is refused as stale (below) it re-attests and retries it once. A
station waiting to be paired re-attests before each new code, so it is
never silent when it starts sitting. The server distinguishes what only it
can know, because it is the one calling Google:

- **Refused**: Google says no, or the extension fails. The page reports
  the extension's failure to `verify` in place of a response, and the server
  records it as refused at once. A page that reports nothing becomes silent
  (below). `attestation =
  refused`, and the session is **suspended**. Writes answer `423
  kiosk_suspended`; answers already saved are kept. A staff event
  `dashboard.alert` reaches the supervisor, and `kiosk.suspended` goes to the
  audit. The next accepted attestation lifts the suspension by itself
  (`kiosk.resumed`, and the alert is cleared).
- **Unavailable**: Google cannot be reached, times out or answers 5xx.
  `attestation = unavailable`. The session is NOT suspended, since
  suspending every station at once because of a Google outage is worse than
  the risk it covers. The supervisor sees an "attestation impossible" alert.
- **Silent**: no attempt has been made for 12 minutes (the page stopped
  attesting). The session is treated as suspended until the next attestation.

The submit route additionally requires a check (`ok` or `unavailable`) less
than two minutes old. This is the one exception to N-SEC-10's "never
blocking" rule, and it holds for kiosk sessions only.

### 7. Pairing: RFC 8628, adapted

`kiosk_pairings`:
- the SHA-256 of `device_code` and of `user_code`;
- the device;
- `state`: `pending → approved → consumed`, or `expired`;
- the student and the evaluation, set on approval, and who approved;
- `expires_at`.

The pure rules live in `@quiz/domain` (`kioskPairing.ts`): code generation
and normalization, and the state machine.

- **The station** (the `quiz_kiosk` cookie, an `active` device) calls
  `POST /app/api/kiosk/device_authorization`. It receives:
  - `device_code`: 256 bits;
  - `user_code`: 8 characters as `XXXX-XXXX`, on an alphabet with no
    vowels, no `0 O 1 I L`;
  - `verification_uri` and `verification_uri_complete` =
    `<PUBLIC_URL>/pair?code=XXXX-XXXX`;
  - `expires_in: 300` and `interval: 2`.

  Issuing a pairing expires the station's previous pending one. The page shows
  the station's label, the code and a QR code of the complete URI, and
  renews both on expiry.
- **The station polls** `POST /app/api/kiosk/token` with the RFC's
  `grant_type` and `device_code`. The answers are those of RFC 8628 §3.5:
  `authorization_pending`, `slow_down` (the interval grows by 5 s when the
  station polls too fast), `expired_token` and `access_denied`. Polling
  rather than SSE, because the event stream serves user sessions and
  presence (ADR-020), and a station is not a user; two seconds is well
  within what one person waits at a desk. On `approved`, one conditional
  `UPDATE … RETURNING` consumes the pairing. The station then gets a `kiosk`
  session (the student, the evaluation, `sessions.device_id`) and goes to
  `/take/<evaluation>`. A partial unique index on `sessions.device_id`
  makes "one session per station" a constraint, not a convention. A new
  session on a station deletes whatever it carried before.
- **The phone** (`/pair`, a portal session; signed out, it goes through the
  sign-in with `next`). It calls `GET /app/api/pair/:code`, which returns
  the station's label and the exams the student can start now: a claimed
  seat, the evaluation in `lobby`, `running` or `paused`, and `kiosk`
  accepted. A teacher's staff seat counts as a seat, so a teacher rehearses
  on a station as with SEB (ADR-018, ADR-027 §4). The student checks the label against the screen in front of
  them, picks the exam and confirms with `POST /app/api/pair`. That is a
  mutation, so it is under the double-submit CSRF check like every other; a
  delegated session (ADR-034) cannot approve.

  Wrong codes are limited to 10 failures per 10 minutes per user. Each
  failure is written to the audit as `kiosk.pair_refused`, and the limit
  counts those rows under an advisory lock. A GET of the page never
  approves anything.
- **The supervisor's fallback**: a student without a phone gives the code on
  the station's screen to the supervisor. From the evaluation's dashboard,
  the supervisor approves it for that student with
  `POST /app/api/evaluations/:id/kiosk-assign {userCode, userId}`, the same
  pairing. The teacher is recorded in `kiosk_pairings.approved_by` and in
  `kiosk.assigned`, **never** in `sessions.actor_user_id`: a non-null actor
  is an impersonation (`delegated`, ADR-034), read-only in production, and
  the student must be able to answer. There is no second mechanism.
- **The end.** The station's session is deleted by the auth module's
  `endKioskSessions`, which `live` calls wherever an attempt ends:
  - the student's submit;
  - the teacher's close;
  - the ticker's expiry;
  - the evaluation's close.

  `endKioskSessions` also closes the event streams of that one session
  (not of the user, whose phone keeps its portal); a stream is authorized
  only when it connects, so a deleted session would otherwise keep one open.
  ADR-027 kept the `seb` session after the submit so that the page could
  still read the closed attempt; the kiosk page instead draws its closed
  screen from what it already holds (the submit's response, or the
  `attempt.closed` event), shows it for a few seconds, then returns to
  `/kiosk`. A reload after the end lands on `/kiosk` directly.
- **The navigation** of a kiosk session is confined exactly like a SEB one:
  the attempt page of its evaluation, nothing else (`SebElsewhere`,
  generalized).

### 8. Audit and supervision

The audit union gains:

| Action | When |
|---|---|
| `kiosk.attested`, `kiosk.attest_failed` | an attestation succeeded or failed (reason `refused` or `unavailable`; the device id, never the challenge or the response) |
| `kiosk.device_registered`, `kiosk.device_labeled`, `kiosk.device_retired`, `kiosk.device_reactivated` | the registry changed (a retired station put back in service is its own entry) |
| `kiosk.paired`, `kiosk.pair_refused`, `kiosk.assigned` | a pairing was approved, refused, or approved by the supervisor |
| `kiosk.suspended`, `kiosk.resumed` | a kiosk session was suspended or resumed |
| `auth.session_superseded` | a new confined session replaced an older one |
| `auth.seb_config_key_mismatch` | a per-request Config Key did not match |

No `device_code`, `user_code`, cookie or Google token is ever written; a
pairing is named by its row id. The request log masks `/pair?code=` and the
`user_code` in `/app/api/pair/:code` (`redact.ts`), as it masks the SEB
secret. It masks it inside the sign-in's `next` parameter too
(`/app/auth/login?next=%2Fpair%3Fcode%3D…`), which is where a signed-out
phone carries it.

Each row of the dashboard carries `access`: `portal`, `seb`, or `kiosk`
with the station's label, plus an alert when a station is suspended or
cannot attest.

### 9. Personal data

The station's Google device id is data about a machine, not a person. What
links a person to a station is the `kiosk` session and the audit entries of
the pairing. N-DATA-02 lists "the kiosk station an attempt was sat on".

### 10. Hardware checks before the switches

Step 0, done by hand on real hardware, gates the SEB hardening (§3–4) and the registry and attestation
(§5) — not their code, their switches:
- in a web kiosk, `challengeKey` with the `MACHINE` scope works and the page
  reaches the extension;
- a real SEB sends the Config Key header on `fetch` and `EventSource`
  (proof B).

## Consequences

- The scope of `00` §0.6 changes. The school's own attested stations are in
  scope, while "device lockdown" of a student's device stays out. N-SEC-10
  gains its one blocking exception (§6).
- `sessions` gains `device_id` and `seb_config_key`. Two tables are added:
  `kiosk_devices` and `kiosk_pairings`.
- A dependency on Google exists for the kiosk path only. With
  `KIOSK_ATTESTATION=off`, nothing of it runs, and a Google outage never
  suspends a station (§6).
- A SEB session caught by the per-request check needs proof B first. Until
  then, the check only writes to the audit.
- D21's other part, a session confined to an activity (a project) and
  `packages/seb`, was settled on 2026-10-01 for M6. When M6 implements it, `trustRefusal` is where the
  project's SEB check goes.

## Alternatives considered

- **A signed token (JWT) in the `.seb` URL.** Rejected by ADR-027 §1: no
  single use, no revocation. The ticket already does what the request asked
  of the JWT.
- **A Browser Exam Key list.** Rejected by ADR-027 §2, still for the same
  reason.
- **A provider class hierarchy.** One function per session kind, called
  from the one session hook, does the same with less.
- **The kiosk on the event stream (SSE) for the approval.** The stream is
  built around user sessions and presence. Polling at 2 s is what the RFC
  describes and costs nothing at this scale.
- **Any Chromebook of the Workspace may pair.** The customer id alone admits
  staff machines; the naming step is the registry's whole point.
- **Suspend on any attestation failure, Google outages included.** One
  outage would stop every station in the room at once.
- **Revoking every other session of the user on a confined login.** It
  would sign out the very phone that approves the pairing.

## Correspondence of old references

§1–§9 keep their numbers and text.

<a id="10-delivery"></a>

| Old reference | Now |
| --- | --- |
| §10 Delivery, steps 1–8 (one pull request each): 1 this ADR and the spec; 2 the trusted-client setting and the generalized `sitRefusal` (no kiosk reachable yet); 3 SEB hardening (§3–4); 4 registry and attestation; 5 the extension; 6 pairing and the two pages; 7 re-attestation, suspension and the supervisor's view; 8 the end-to-end tests with the mock attestation, and `docs/development/kiosk.md` | removed: delivery lives in `docs/merge/PROGRESS.md` and `changes/` (`apps/api/src/db/kiosk.ts` cites steps 4 and 6) |
| §10, step 0 (hardware checks gating steps 3 and 4) | [§10](#10-hardware-checks-before-the-switches) |
