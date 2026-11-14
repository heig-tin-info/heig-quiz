# ADR-129 — The staff's review session: a course's staff open a project repository in the online workspace, read-only

## Status

Accepted (2026-11-14: the product owner's four decisions, §1–§4 below; the
technical rules settled by the orchestrator the same day after a spec
challenge). Issue [#1088](https://github.com/heig-tin-info/heig-quiz/issues/1088),
spun off option C of [#922](https://github.com/heig-tin-info/heig-quiz/issues/922).
Delivery progress lives in `changes/`.

Scope: a course staff member's **review session** — the online workspace
portal (`apps/codespace`) opened by the staff on one repository of a
project, whatever its work mode: who may launch it, on which repository and
when, the read-only token Quiz grants the portal for it, the portal's
session, volume and quota rules for it, its audit. Not a write path for the
staff (§10), not GitHub access for the staff (#922), not the student's own
workspace (ADR-047, ADR-078, unchanged for it).

Relations: amends [ADR-078](ADR-078-codespace-git-relay-tokens.md) §2
(a third kind of grant, check 2's launch record), §6 (the launch records)
and §9 (the blast radius), by its amendment of 2026-11-14; amends
[ADR-047](ADR-047-espace-de-travail-en-ligne.md)'s amendment of 2026-10-11
(audit L24: its premise "another browser never loads the page"), M6-06 (C)
(a review counts against the quota holder) and M6-03 (b) (an account born
from a launch is not only a student's); reads
[ADR-077](ADR-077-depots-de-test-du-personnel.md) (a staff test repository
may be reviewed). Applies invariants 2, 5, 6, 7, 9 and 15, ADR-054 (Super
Powers), ADR-068 (both staff roles) and ADR-034 (an impersonation reads
only).

## Context

The project page (F-PROJ-13) lists every student's or group's repository
and links it on GitHub, where a staff member who holds no role in the
organization gets a 404 (#922). #922's product owner direction of
2026-11-14 prefers a GitHub team of the course's staff for clone-and-read
access, still blocked on push attribution and notifications, and splits off
option C as a complement: the staff open the repository **in the browser**,
in the online workspace the students already use, without any GitHub right
of their own — read the code, build and run it, browse its history through
the workspace's git, as the student does.

What exists bears on it:

1. **The portal knows only synced projects.** Quiz sends a project to the
   portal (`codespace.sync`, `CodespaceAssignmentSync`) only in an online
   mode; a `free` project has no row there, and `/launch` refuses a token
   whose `assignmentId` it does not know (`findAssignment`). Group
   projects are always `free` (ADR-047 M6-06 (A)).
2. **One session and one persistent volume per (user, project)**
   (`sessions/manager.ts`, `git/staging.ts`:
   `<VOLUMES_ROOT>/<login>/<assignment>/`), kept after close (sanctioned
   divergence 1 of `apps/codespace/CLAUDE.md`). A staff member reviewing
   two students of one project would land in one volume.
3. **The staging repository always accepts a push** (`http.receivepack
   true`, `serviceAllowed` in `git/httpBackend.ts`): the student must be
   able to submit while GitHub is down. A push writes a `PushEvent` and the
   relay pushes it to GitHub with a write token.
4. **The token route grants a user's own repository only** (ADR-078 §2,
   checks 2–3: a launch of that user on that project in
   `codespace_launches`, and the user's own live individual repository, or
   the distribution of an `online_seb` project). A staff member has no
   launch on a student's repository and is never its holder.
5. **Every session shares one web origin** (`/s/<session>/`). ADR-047's
   amendment of 2026-10-11 (audit L24) closed the port proxy and filtered
   code-server's answers, and accepted two known gaps — a markdown preview
   whose security the user turned off, a process taking port 8080 between
   code-server's `SIGUSR1` and the container's exit — on the premise that
   "another browser never loads the page without the session's cookie".
   A review breaks that premise: the staff member's browser loads a
   workspace whose content and running programs a student wrote, and the
   same browser may hold other portal sessions.
6. **The quota** is per quota holder across all projects, counted by the
   portal on `sessions.teacherId` (portal invariant 8; ADR-047 M6-06 (C),
   `quotaHolder` of `packages/domain/src/workMode.ts`).

## Decision

### 1. A review session executes; one live review session per staff member

*Product owner, 2026-11-14.* A review session builds and runs the
repository's code in the hardened container, like a student's workspace.
**At most one live review session per staff member**: launching a review
of another repository closes the staff member's previous review session
first (§5). The residual risk this leaves is accepted in writing (§9). A
subdomain per session, which removes it, is a named follow-up, not a
prerequisite ([06](../spec/06-questions-ouvertes.md), question 70).

### 2. When

*Product owner, 2026-11-14.* A review may be launched **at any time** on a
`free` or `online` project, whatever its deadline strategy (`lock` or
`commit`): before the deadline, after it, after the release of the
scores. On an `online_seb` project, **only once the repository's deadline
has been applied** (`project_repos.deadline_applied_at` is set), never
during the exam. In an **archived classroom**: refused. The portal's
`closesAt` gate of a synced project does not apply to a review (§5).

### 3. Quota

*Product owner, 2026-11-14.* A review session counts against the quota of
the project's **quota holder** (`quotaHolder`: its creator while they own
the course, otherwise its oldest owner seat), exactly as a student's
session does, and at most **two review sessions** of one holder are live at
once (`REVIEW_SESSIONS_PER_HOLDER = 2`, `@quiz/contracts`), so that reviews
cannot starve students. The action does not exist when the quota holder
holds no enabled workspace grant (`grantOf`; an administrator always holds
one, ADR-047's amendment of 2026-10-08).

### 4. Who, and what the student is told

*Product owner, 2026-11-14.* **Any staff seat of the course**, owner or
assistant (ADR-068), and an **administrator with active Super Powers**
(ADR-054), through the one predicate of invariant 6 (`staffAccess` under
`accessWhere`), from their **own portal session only** — never an
impersonation (ADR-034), a `seb` or `kiosk` session, nor a personal or
OAuth API token (ADR-022). Every launch is audited (§8). **The student is
not notified** in v1: a privacy choice made knowingly — a staff member
reading a repository through the review session reads what the staff could
already read on the project page and in the runs' evidence; the audit log,
not a notice, is the record. Revisiting it is not an open question of this
record; a later decision would amend §4.

### 5. The launch route and its refusals

`POST /app/api/projects/:id/repos/:rid/workspace/review` — a session
write (double-submit CSRF), registered with the `codespace` module (so a
404 when `CODESPACE_URL` is empty or the GitHub App is not configured),
the repository addressed by `project_repos.id` in the path, never by a
name from the client. No body. It answers `{ url }`, the portal's
`/review?token=…`, `Cache-Control: no-store`, which the page navigates to.

The project is loaded by `accessibleProject` (`admit: "portal"`,
`staffScoped`), the repository by `project_repos.id` **within that
project**; the decision is one pure rule of `@quiz/domain`,
`staffReviewRefusal`, read in one transaction. In this order:

| # | Condition | Answer |
|---|---|---|
| 1 | No session | `401` |
| 2 | An impersonation session | `403 impersonation_read_only` (the auth plugin, ADR-034; the 404 in development) |
| 3 | A Bearer token, a `seb` or `kiosk` session, a caller without `staffAccess` on the course (Super Powers inactive), an unknown project, or a `:rid` that is not a repository of that project | `404 not_found`, indistinguishable from a missing project |
| 4 | The quota holder holds no enabled workspace grant | `409 review_not_granted` |
| 5 | The classroom is archived | `409 review_archived` |
| 6 | The repository is not live: not provisioned (`provision_status` not `ok`, no `full_name` or no `github_repo_id`) or deleted (`deleted_at` set) — individual, group or staff test repository alike | `409 review_repo_unavailable` |
| 7 | An `online_seb` project whose repository's deadline is not applied (`deadline_applied_at` null) | `409 review_exam_open` |
| — | Otherwise | `200 { url }` |

The route never refuses on the deadline, the staff lock, the freeze, the
release or the deadline strategy (§2), and not on the portal's capacity:
the quota and the cap are the portal's to enforce (ADR-047 M6-06 (C):
Quiz does not count live workspaces); the portal answers its own `429`
page.

On success, in the transaction: the review launch is **recorded**
(§6), a **review launch token** is minted (§7) and the launch is
**audited** (§8). A review launch **never** calls `markLaunched` (it
freezes no work mode), never writes `codespace_launches` (the student
launch record ADR-078's check 2 reads), never requests a
`codespace.sync`, and opens nothing to the students of a `free` project.

### 6. The review launch record

A table of the `codespace` module, `codespace_reviews`: primary key
(`user_id`, `project_repo_id`), `project_id`, `reach` (`seat` |
`super_powers`), `first_launch_at`, `last_launch_at`, `grant_until`.
Each launch upserts its row: `last_launch_at` and `grant_until` move to
the launch, the first is kept. `grant_until` is the launch time plus
**12 hours** (`REVIEW_GRANT_HOURS`), and for a launch made under Super
Powers no later than the session's `super_powers_until`. Nothing in it is a
secret. The row is the token route's only proof that this staff member
launched a review of this repository.

### 7. The review launch token and the token grant

**The launch token.** `ReviewLaunchTokenClaims` (`@quiz/contracts`):
HS256 over `CODESPACE_LAUNCH_SECRET`, `iss` `heig-quiz`, a distinct
audience **`heig-codespace-review`**, five minutes at most, a random `jti`
the portal consumes once (portal invariant 7), and: `sub` (the staff
member's Quiz id), `email`, `displayName`, `githubLogin`, `projectId`,
`projectRepoId`, `repo` (`fullName`, `defaultBranch`), `holder`
(`{ id, email }`, the quota holder), `maxActiveSessions` (the holder's
grant). The portal verifies it on its own route, `GET /review?token=…`,
never on `/launch`: the distinct audience means a portal that does not know
reviews refuses the token, and no review token is ever read as a student's
launch, nor the reverse.

**The token request.** The portal asks Quiz for a token on the reviewed
repository through ADR-078's `POST /app/codespace/git-token`, unchanged in
path, audience and signature, its claims (`GitTokenRequestClaims`) gaining
one optional claim, **`reviewRepoId`** (the `project_repos.id`). A request
that carries it is decided by `reviewTokenRefusal` (`@quiz/domain`) **and
only by it**; one without it by ADR-078's `gitTokenRefusal`, unchanged. In
order, after check 1 (the signature, the `jti`, single use):

1. A `codespace_reviews` row for (`userId`, `reviewRepoId`) whose
   `project_id` is the request's `projectId` and whose `grant_until` is
   ahead on the server's clock; otherwise `404 not_found`.
2. Its access still holds: for `reach = seat`, the user still holds a seat
   on the course's staff (the `staffAccess` predicate on the user id); for
   `super_powers`, `grant_until` (already bounded by the session's Super
   Powers) suffices. Otherwise `404 not_found`.
3. The repository row is live (§5, check 6) and its stored `full_name`
   matches the request's `repository` (case-insensitive); the token is
   minted on its stored `github_repo_id`. Otherwise `404 not_found`.
4. The classroom is not archived; for an `online_seb` project,
   `deadline_applied_at` is set. Otherwise `409 closed`.
5. GitHub: ADR-078's check 6 (`503 github_unavailable`).

The grant is always **`contents: read`**, `useUntil` = `expiresAt` (at
most an hour), minted by the one function of `apps/api/src/github/app.ts`.
No deadline, lock or work mode bounds it (§2).

**The relay declaration** (`POST /app/codespace/relay-heads`) carrying
`reviewRepoId` is refused `404 not_found` before any other read: no
declaration is ever tied to a review launch, so no push of the App is ever
read as a review's.

### 8. Audit

- A new member of the closed union of `apps/api/src/audit.ts`,
  **`codespace.review_launched`**: subject the project, payload
  `{ projectRepoId, repository, jti, reach }` — the repository's stored
  `full_name`, never the token.
- Each review token: `codespace.git_token_issued` as ADR-078 §2, with
  `permission: "read"` and `reviewRepoId` in its payload, never the token.
- A refusal of either route is logged at `info` with its code, not audited
  (ADR-078 §2).

### 9. The residual risk of decision 1, stated plainly

Code in a review session runs in the hardened container (portal invariants
1–3, 13), never in the browser. What reaches the staff member's browser is
what the student's repository and programs can make code-server serve on
the portal's origin, which every session shares. The audit L24 gaps remain:
a markdown preview whose security the staff member turns off runs the
repository's script, and a program of the student's run by the staff member
may take port 8080 for the moment between code-server's `SIGUSR1` and the
container's exit. Script that runs on that origin is same-origin with
**every portal session open in that browser**: it may set a `path=/` cookie
there, and read or drive another session's workspace whose cookie the
browser holds.

Decision 1 bounds this: one live review session per staff member, so a
student's repository can never reach another student's repository through a
second review open beside it. What it does not bound, and is accepted:

- the staff member's **own** workspace sessions open in the same browser —
  a staff seat's test workspace (ADR-077), or a student workspace of the
  same person — are not closed by a review; a student's script that runs
  in the review could read or act in them;
- a cookie set with `path=/` outlives the review in that browser until it
  expires or is cleared;
- Quiz itself is out of reach: it is another origin, and the portal's
  cookies are not Quiz's.

The full fix is a **subdomain per session** (each session its own origin,
a wildcard certificate), [06](../spec/06-questions-ouvertes.md),
question 70; when it lands, §1's limit to one review may be lifted by a
dated amendment.

### 10. The portal's review session

- **A review assignment, not a sync.** `GET /review` upserts, from the
  token, a portal assignment of kind `review`, id `review-<projectRepoId>`
  (a safe id, `isSafeId`), carrying `projectId`, `projectRepoId`, the
  default image, the holder as `teacherId` and its quota, no `opensAt`,
  no `closesAt`, no Browser Exam Key. No `codespace.sync` is involved, so a
  `free` project needs none.
- **Keyed on (staff member, repository).** The session pair is
  (`login`, `review-<projectRepoId>`), so the volume is
  `<VOLUMES_ROOT>/<staff>/review-<projectRepoId>/`: one per reviewed
  repository, never the staff member's own workspace of the project.
- **One live review per staff member.** Before anything else is started,
  `/review` closes every other live session of that login whose
  assignment is of kind `review` (a resumption of the same repository's
  review is not closed). The staff member's other sessions are untouched
  (§9).
- **Quota, then cap.** A new review session (not a resumption) is refused
  with the portal's `429` page when the holder's live sessions, all kinds,
  reach `maxActiveSessions` (portal invariant 8), or when the holder's live
  **review** sessions reach `REVIEW_SESSIONS_PER_HOLDER`.
- **Seeded from the reviewed repository**, like a lab session: a mirror of
  it into a fresh `staging.git` with the read token (§7), then cloned into
  `work/` through the git channel. Under `online_seb` too: portal
  invariant 11 binds an exam session, and a review is not one (§2 admits it
  only after the exam).
- **Read-only, enforced three times.** (a) The review session's staging
  repository refuses `git-receive-pack`, both by `http.receivepack false`
  and per request in `serviceAllowed` (the authority); no `PushEvent` is
  ever written for it. (b) The relay never runs for a review session: the
  `quiz` forge's cache entry carries the review flag and is never asked
  for a relay. (c) Quiz refuses any relay declaration tied to a review
  (§7). The staff member may commit in `work/`; nothing leaves it.
- **No persistent volume.** The review directory is removed when its
  session closes (explicit close, idle collection, the switch of §1),
  without following a link, with no `shadow.git` snapshot; a startup sweep
  removes every review directory without a live session. Each launch
  re-fetches the repository. Narrower than sanctioned divergence 1, so no
  new divergence, and no retention rule is needed for students' code in a
  staff member's volume.
- **Never a student row.** A review assignment's sessions are never listed
  by `GET /api/assignments/:id/sessions` for the project (their assignment
  id is not the project's), so Quiz's project workspace list never shows
  them. The portal account is the staff member's own, born from the token
  without a role (portal invariant 9).
- **The token stays out of the container**, argv, URLs, files, SQLite and
  logs, as ADR-078 §3 and portal invariant 10 require. The `quiz` forge's
  cache key includes the review flag, so a staff member who also works on
  their own test repository never shares a grant between the two.

### 11. The web

A secondary action on the repository sheet and row of the project page,
staff only, labelled by the glossary's words (§1.5: *Open in workspace*,
*Ouvrir dans l'espace de travail*). It is absent without `CODESPACE_URL`,
or when the quota holder is not granted (`ProjectWorkspace.review`), or
on a repository that is not live; on an `online_seb` repository whose
deadline is not applied it is disabled with its reason. A refusal of §5 is
shown by its code. The page's primary action is unchanged (invariant 2).

### 12. Out of scope

- **A write path for the staff** (commit and push from a review session,
  attributed to the staff member): deferred until #922's push-attribution
  rule exists, and then a separate ADR
  ([06](../spec/06-questions-ouvertes.md), question 71).
- GitHub access for the staff (#922's team).
- Notifying the student (§4).
- The subdomain per session (§9, question 70).

### 13. Delivery

Four pull requests after this one, in order; the API is deployed before the
portal (ADR-078 §10: both deploy from one commit, the application first),
and no review token is minted before the web's action exists:

1. **Contracts and domain**: `ReviewLaunchTokenClaims` and its audience,
   the optional `reviewRepoId` claim, `StaffReviewRefusal`,
   `REVIEW_GRANT_HOURS`, `REVIEW_SESSIONS_PER_HOLDER`, the route path,
   `ProjectWorkspace.review`; the pure `staffReviewRefusal` and
   `reviewTokenRefusal`, with unit tests.
2. **API**: migration (`codespace_reviews`), the launch route, the token
   route's review branch, the relay declaration's refusal, the audit
   member, `ProjectWorkspace.review`; database tests of the matrix of §5
   and of §7, and that a review neither freezes the mode nor syncs.
3. **Portal**: `GET /review`, review assignments, the session key, the
   switch, the cap, read-only staging, the wipe and its sweep, the forge's
   cache key; unit tests.
4. **Web**: the action, its refusals, both languages.

## Consequences

- A staff member reads, builds and runs any live repository of their
  course's projects in the browser, `free` projects included, without a
  GitHub role, a credential on their machine, or a push path.
- **Blast radius (ADR-078 §9).** A compromised portal, holding
  `CODESPACE_LAUNCH_SECRET`, may now also obtain **read** tokens on every
  repository a staff member launched a review of within the last twelve
  hours (`codespace_reviews.grant_until`), whatever its work mode — `free`
  repositories, closed and frozen ones, frozen `online_seb` ones included;
  contents only, no write, every token audited. It cannot mint one for a
  repository nobody reviewed, since it cannot forge a session write on
  Quiz.
- The portal's capacity is shared: reviews consume the holder's quota, at
  most two at once.
- One new table and one migration in the API, one audit action, a SQLite
  migration in the portal (assignment kind and its review columns); no new
  secret (ADR-010 unchanged).
- The record does not tell the student; the audit log does.

## Alternatives considered

- **Reuse `/launch` and the student's launch token, with a `review` claim.**
  Rejected: an older portal strips an unknown claim and would read the token
  as a student launch on the project; a distinct audience and route make
  the two kinds impossible to confuse.
- **Sync a `free` project to the portal for a review.** Rejected: the sync
  carries a student-facing state (deadline, mode) a review must ignore, and
  syncing `free` projects would widen what the portal holds for no student.
- **Keep the review volume** (the student's persistence rule). Rejected: it
  keeps a copy of students' code in staff volumes with no retention rule;
  a fetch per launch is cheap.
- **Read without executing** (a code viewer). Rejected by the product owner:
  building and running is the need.
- **Several reviews at once.** Rejected until a subdomain per session (§9).
- **GitHub access through a staff team** (#922 option B): a complement
  still blocked on attribution and notifications, not a replacement.
