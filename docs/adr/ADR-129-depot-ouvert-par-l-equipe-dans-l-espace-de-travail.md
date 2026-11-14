# ADR-129 — The staff's review session: a course's staff open a project repository in the online workspace, read-only

## Status

Accepted (2026-11-14: the product owner's four decisions, §1–§4 below; the
technical rules settled by the orchestrator the same day after a spec
challenge and two reviews). Issue [#1088](https://github.com/heig-tin-info/heig-quiz/issues/1088),
spun off option C of [#922](https://github.com/heig-tin-info/heig-quiz/issues/922).
Delivery progress lives in `changes/`.

Scope: a course staff member's **review session** — the online workspace
portal (`apps/codespace`) opened by the staff on one repository of a
project, whatever its work mode: who may launch it, on which repository and
when, the read-only token Quiz grants the portal for it, the portal's
session, volume and quota rules for it, its audit. Not a write path for the
staff (§12), not GitHub access for the staff (#922), not the student's own
workspace (ADR-047, ADR-078, unchanged for it).

Relations: amends [ADR-078](ADR-078-codespace-git-relay-tokens.md) §2
(a read grant for a reviewed repository), §6 (the launch records) and §9
(the blast radius), by its amendment of 2026-11-14; amends
[ADR-047](ADR-047-espace-de-travail-en-ligne.md)'s amendment of 2026-10-11
(audit L24: its premise "another browser never loads the page"), M6-06 (C)
(a review counts against the quota holder) and M6-03 (b) (an account born
from a launch is not only a student's); reads
[ADR-077](ADR-077-depots-de-test-du-personnel.md) (a staff test repository
may be reviewed). Applies invariants 2, 5, 6, 7, 9 and 15, ADR-054 (Super
Powers), ADR-068 (both staff roles), ADR-034 (an impersonation reads only)
and N-SEC-22 (a token's scope).

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
   launch on a student's repository and is never its holder. The portal's
   request names the project by the session's assignment id
   (`quizForge.ts`, `projectId: owner.assignment`).
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
7. **Super Powers live on a Quiz session** (`sessions.super_powers_until`,
   ADR-054), read through the session in hand (`reachOf`); the token route
   is a server-to-server call with no session of the user's.

## Decision

### 1. A review session executes; one live review session per staff member

*Product owner, 2026-11-14.* A review session builds and runs the
repository's code in the hardened container, like a student's workspace.
**At most one live review session per staff member**: launching a review
of another repository closes the staff member's previous review session
(§10). The residual risk this leaves is accepted in writing (§9). A
subdomain per session, which removes most of it, is a named follow-up, not
a prerequisite ([06](../spec/06-questions-ouvertes.md), question 70).

### 2. When

*Product owner, 2026-11-14.* A review may be launched **at any time** on a
`free` or `online` project, whatever its deadline strategy (`lock` or
`commit`): before the deadline, after it, after the release of the
scores. On an `online_seb` project, **only once the repository's deadline
has been applied** (`project_repos.deadline_applied_at` is set), never
during the exam. In an **archived classroom**: refused. *Orchestrator's
default, open to the product owner:* an **archived project** is refused
like an archived classroom, as F-PROJ-19's start gate treats both together.

*Known and accepted:* if the staff reopen an `online_seb` repository (its
deadline moved later, `deadline_applied_at` cleared) while a review of it is
live, the review session is not closed; no further token is granted for
it (§7). It holds only the snapshot it fetched at its launch.

### 3. Quota

*Product owner, 2026-11-14.* A review session counts against the quota of
the project's **quota holder** (`quotaHolder`: its creator while they own
the course, otherwise its oldest owner seat), exactly as a student's
session does, and at most **two review sessions** of one holder are live at
once (`REVIEW_SESSIONS_PER_HOLDER = 2`, a constant of the portal, which
alone enforces it), so that reviews cannot starve students. The action does
not exist when the quota holder holds no enabled workspace grant
(`grantOf`; an administrator always holds one, ADR-047's amendment of
2026-10-08).

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
not a notice, is the record. Revisiting it would amend this section.

### 5. The launch route and its refusals

`POST /app/api/projects/:id/repos/:rid/workspace/review` — a session
write (double-submit CSRF), registered with the `codespace` module (so a
404 when `CODESPACE_URL` is empty or the GitHub App is not configured),
the repository addressed by `project_repos.id` in the path, never by a
name from the client. No body. It answers `{ url }`, the portal's
`/review?token=…`, `Cache-Control: no-store`, which the page navigates to.

Rows 1–3 belong to the auth plugin and the loader: the project is loaded
by `accessibleProject` (`admit: "portal"`, `staffScoped`), the repository
by `project_repos.id` **within that project**. Rows 4–7 are **one pure rule
of `@quiz/domain`, `staffReviewRefusal(facts)`**, read in one transaction,
the same rule the token route applies (§7) and the page reads (§11):

| # | Condition | Answer |
|---|---|---|
| 1 | No session | `401` |
| 2 | An impersonation session | `403 impersonation_read_only` (the auth plugin, ADR-034; the 404 in development) |
| 3a | A personal or OAuth token whose scope does not reach the route | `403` of N-SEC-22 (the auth plugin) |
| 3b | An `api`-scope token, a `seb` or `kiosk` session, a caller without `staffAccess` on the course (Super Powers inactive), an unknown project, or a `:rid` that is not a repository of that project | `404 not_found`, indistinguishable from a missing project |
| 4 | The quota holder holds no enabled workspace grant | `409 review_not_granted` |
| 5 | The classroom or the project is archived | `409 review_archived` |
| 6 | The repository is not live (`isLiveRepo`: `provision_status` `ok`, `full_name` and `github_repo_id` set, `deleted_at` null) — individual, group or staff test repository alike | `409 review_repo_unavailable` |
| 7 | An `online_seb` project whose repository's deadline is not applied (`deadline_applied_at` null) | `409 review_exam_open` |
| — | Otherwise | `200 { url }` |

`isLiveRepo` generalises `isLiveIndividualRepo` (`groupRepo.ts`), which
becomes `isLiveRepo` plus "no group": one definition of a live repository.

The route never refuses on the deadline, the staff lock, the freeze, the
release or the deadline strategy (§2), and not on the portal's capacity:
the quota and the cap are the portal's to enforce (ADR-047 M6-06 (C):
Quiz does not count live workspaces); the portal answers its own `429`
page.

On success, in the transaction: the review launch is **recorded** (§6), a
**review launch token** is minted (§7) and the launch is **audited** (§8).
A review launch **never** calls `markLaunched` (it freezes no work mode),
never writes `codespace_launches` (the student launch record ADR-078's
check 2 reads), never requests a `codespace.sync`, and opens nothing to the
students of a `free` project.

### 6. The review launch record

A table of the `codespace` module, `codespace_reviews`: primary key
(`user_id`, `project_repo_id`), both foreign keys `ON DELETE CASCADE`, and
`grant_until`. Each launch upserts its row with `grant_until` = the launch
time plus **15 minutes** (`REVIEW_GRANT_MINUTES = 15`, `@quiz/contracts`):
the portal asks for the read token only when it seeds the session, seconds
after the launch, and a resumption is a new launch. This is the one place
the figure is stated; every other document points here. Nothing in the row
is a secret; it is the token route's only proof that this staff member
launched a review of this repository.

### 7. The review launch token and the token grant

**The launch token.** `ReviewLaunchTokenClaims` (`@quiz/contracts`):
HS256 over `CODESPACE_LAUNCH_SECRET`, `iss` `heig-quiz`, a distinct
audience **`heig-codespace-review`**, five minutes at most, a random `jti`
the portal consumes once (portal invariant 7). The identity claims (`sub`,
`email`, `displayName`, `githubLogin`, `repo`) are defined once and
extended by both `LaunchTokenClaims` and `ReviewLaunchTokenClaims`; the
review token adds `projectId`, `projectRepoId`, `holder` (`{ id, email }`,
the quota holder) and `maxActiveSessions` (the holder's grant). The portal
verifies it on its own route, `GET /review?token=…`, never on `/launch`:
a portal that does not know reviews refuses the audience, and no review
token is ever read as a student's launch, nor the reverse.

**The token request.** The portal asks for a token on the reviewed
repository through ADR-078's `POST /app/codespace/git-token`, unchanged in
path, audience and signature. `GitTokenRequestClaims` — and it only — gains
one optional claim, **`reviewRepoId`** (the `project_repos.id`); its
`projectId` is the reviewed project. A request that carries it is decided
as follows, after check 1 (the signature, the `jti`, single use); one
without it by ADR-078's `gitTokenRefusal`, unchanged:

1. **The record is fresh**: a `codespace_reviews` row for (`userId`,
   `reviewRepoId`), joined to its `project_repos` row, whose project is the
   request's `projectId` and whose `grant_until` is after the database's
   `now()`. Otherwise `404 not_found`.
2. **The access holds now**, re-evaluated for the recorded user by one
   read: a seat on the staff of the project's course (`staffAccess` on the
   user id), **or** the `admin` role with a live session of their own
   (`kind = 'portal'`, not delegated, `expires_at > now()`) whose
   `super_powers_until > now()` — the database's clock, the conditions of
   `mayHoldSuperPowers` and `reachOf` read on the user's `sessions` rows,
   since no helper reads them by user without a session in hand. So a grant
   never outlives the seat or the Super Powers (invariant 6). Otherwise
   `404 not_found`.
3. **The repository is the one recorded**: its stored `full_name` equals
   the request's `repository` (case-insensitive); the token is minted on
   its stored `github_repo_id`. Otherwise `404 not_found`.
4. **`staffReviewRefusal`**, the launch's rule (§5, rows 4–7), on the
   facts read now: `review_not_granted` and `review_repo_unavailable` →
   `404 not_found`; `review_archived` and `review_exam_open` →
   `409 closed`.
5. GitHub: ADR-078's check 6 (`503 github_unavailable`).

The grant is always **`contents: read`**, `useUntil` = `expiresAt` (at
most an hour), minted by the one function of `apps/api/src/github/app.ts`.
No deadline, lock or work mode bounds it (§2).

`POST /app/codespace/relay-heads` is untouched: its claims gain nothing. A
portal that omitted `reviewRepoId` there would meet ADR-078's rule, which
already refuses a repository that is not the user's own.

### 8. Audit

- A new member of the closed union of `apps/api/src/audit.ts`,
  **`codespace.review_launched`**: subject the project, payload
  `{ projectRepoId, repository, jti, reach }` — the repository's stored
  `full_name`, the caller's reach (`seats` or `all`) at the launch, never
  the token.
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

**Opening the repository may be enough.** A review session turns automatic
tasks off (§10), but that is a mitigation, not a guarantee: a workspace
opened on a student's repository may run content the student controls —
an extension's behaviour triggered by a file, a preview — without the staff
member running anything. The accepted risk is worded for that case, not
only for programs the staff member chooses to run.

Decision 1 bounds this: one live review session per staff member, so a
student's repository can never reach another student's repository through a
second review open beside it. What it does not bound, and is accepted:

- the staff member's **own** workspace sessions open in the same browser —
  a staff seat's test workspace (ADR-077), or a student workspace of the
  same person — are not closed by a review; content of the reviewed
  repository that runs on the origin could read or act in them;
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
  token, a portal assignment with id `review-<projectRepoId>` (a safe id,
  `isSafeId`) and one nullable JSON column, **`reviewOf: { projectId,
  projectRepoId }`** (null on every synced assignment); the default image,
  the holder as `teacherId` and its quota, no `opensAt`, no `closesAt`, no
  Browser Exam Key. No `codespace.sync` is involved, so a `free` project
  needs none.
- **One tail for both routes.** `/review` and `/launch` differ in what
  they verify and which assignment they resolve; from upserting the user
  to the redirect (quota, start, cookie, log) they run one shared tail.
- **Keyed on (staff member, repository).** The session pair is
  (`login`, `review-<projectRepoId>`), so the volume is
  `<VOLUMES_ROOT>/<staff>/review-<projectRepoId>/`: one per reviewed
  repository, never the staff member's own workspace of the project.
- **Quota, then the switch.** For a new review session (not a resumption
  of the same repository's), the holder's live sessions of every kind,
  **excluding the staff member's review session it is about to replace**,
  must be under `maxActiveSessions` (portal invariant 8), and the holder's
  live review sessions, with the same exclusion, under
  `REVIEW_SESSIONS_PER_HOLDER`; otherwise the portal's `429` page and
  nothing is closed. Then the staff member's other live review sessions are
  closed (§1); their other sessions are untouched (§9).
- **Seeded from the reviewed repository**, like a lab session: a mirror of
  it into a fresh `staging.git` with the read token (§7), then cloned into
  `work/` through the git channel. Under `online_seb` too: portal
  invariant 11 binds an exam session, and a review is not one (§2 admits it
  only after the exam).
- **The portal's request.** `ForgeOwner` gains an optional
  `review: { projectId, projectRepoId }`; `signedRequest` sends
  `projectId: owner.review?.projectId ?? owner.assignment` and, for a
  review, `reviewRepoId`. The `quiz` forge's cache is keyed on the
  assignment, so a review's grant and the staff member's own never mix.
- **Read-only.** The review session's staging repository refuses
  `git-receive-pack`, by `http.receivepack false` and per request in
  `serviceAllowed` (the authority); and the GitHub token it holds is
  read-only (§7). No `PushEvent` can be written, so no relay exists. The
  staff member may commit in `work/`; nothing leaves it.
- **Automatic tasks off.** A review session's code-server runs with
  `"task.allowAutomaticTasks": "off"` in its machine settings, so a
  `runOn: folderOpen` task of the repository does not start by itself. The
  machine settings are the image's (`images/c-dev/settings.json`, copied
  by the entry point): the portal PR sets it either for every session or
  through a non-secret flag added to `CONTAINER_ENV_KEYS` with its test.
  A mitigation only (§9).
- **No persistent volume.** The review directory is removed when its
  session closes (explicit close, idle collection, the switch of §1),
  without following a link; review sessions are excluded from
  `snapshotAll` and take no closing snapshot. A startup sweep removes
  every review directory, and every `review-*` assignment row, without a
  live session. Each launch re-fetches the repository. Narrower than
  sanctioned divergence 1, so no new divergence, and no retention rule is
  needed for students' code in a staff member's volume.
- **Never a student row.** A review assignment's sessions are never listed
  by `GET /api/assignments/:id/sessions` for the project (their assignment
  id is not the project's), so Quiz's project workspace list never shows
  them. The portal account is the staff member's own, born from the token
  without a role (portal invariant 9).
- **The token stays out of the container**, argv, URLs, files, SQLite and
  logs, as ADR-078 §3 and portal invariant 10 require.

### 11. The web

A secondary action on the repository sheet and row of the project page,
staff only, labelled by the glossary's words (§1.5: *Open in workspace*,
*Ouvrir dans l'espace de travail*). It is absent without `CODESPACE_URL`
or when the quota holder is not granted (`ProjectWorkspace.review`). On a
row, its state comes from **`staffReviewRefusal` applied to the row the
page already holds** (its life, `deadlineAppliedAt`, the project's mode and
archive): absent on a repository that is not live, disabled with its reason
on an `online_seb` repository whose deadline is not applied — never a
second derivation of the rule. A refusal of §5 is shown by its code. The
page's primary action is unchanged (invariant 2).

### 12. Out of scope

- **A write path for the staff** (commit and push from a review session,
  attributed to the staff member): deferred until #922's push-attribution
  rule exists, and then a separate ADR
  ([06](../spec/06-questions-ouvertes.md), question 71).
- GitHub access for the staff (#922's team).
- Notifying the student (§4).
- The subdomain per session (§9, question 70).

### 13. Delivery

Three pull requests after this one, in order; the API is deployed before
the portal (ADR-078 §10: both deploy from one commit, the application
first), and no review token is minted before the web's action exists:

1. **API**, with its contracts and domain rule: `ReviewLaunchTokenClaims`
   and its audience, the shared identity claims, `reviewRepoId` on
   `GitTokenRequestClaims`, `StaffReviewRefusal`, `REVIEW_GRANT_MINUTES`,
   the route path, `ProjectWorkspace.review`; `isLiveRepo` and
   `staffReviewRefusal` with unit tests; the migration
   (`codespace_reviews`), the launch route, the token route's review
   branch, the audit member; database tests of §5's matrix and of §7, and
   that a review neither freezes the mode nor syncs.
2. **Portal**: `GET /review` and the shared tail, `reviewOf`, the session
   key, quota then switch, the cap, read-only staging, automatic tasks off,
   the wipe and its sweep, `ForgeOwner.review`; unit tests.
3. **Web**: the action, its state from the domain rule, its refusals, both
   languages.

## Consequences

- A staff member reads, builds and runs any live repository of their
  course's projects in the browser, `free` projects included, without a
  GitHub role, a credential on their machine, or a push path.
- **Blast radius (ADR-078 §9).** A compromised portal, holding
  `CODESPACE_LAUNCH_SECRET`, may now also obtain **read** tokens on a
  repository within the grant window of §6 after a staff member launched a
  review of it, and only while that staff member still holds the access of
  §7 — whatever the repository's work mode, `free` and frozen `online_seb`
  ones included; contents only, never a write, every token audited. It
  cannot mint one for a repository nobody reviewed, since it cannot forge a
  session write on Quiz.
- The portal's capacity is shared: reviews consume the holder's quota, at
  most two at once.
- One new table and one migration in the API, one audit action, a SQLite
  migration in the portal (`reviewOf`); no new secret (ADR-010 unchanged).
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
- **A long grant window** (hours), so that a session could re-fetch.
  Rejected: the token is needed only at seeding; a longer window only widens
  the blast radius.
- **Record the reach and cap the window by the Super Powers.** Rejected:
  re-reading the access at token time is one read and keeps invariant 6
  whole; the reach stays in the audit.
- **Read without executing** (a code viewer). Rejected by the product owner:
  building and running is the need.
- **Several reviews at once.** Rejected until a subdomain per session (§9).
- **GitHub access through a staff team** (#922 option B): a complement
  still blocked on attribution and notifications, not a replacement.
