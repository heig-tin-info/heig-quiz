# ADR-047 — Online workspace: no student credential, therefore no write access

## Status

Quiz implementation status (verified 2026-10-07): `apps/codespace` is
present (imported by M6-03) and Quiz's `codespace` module talks to it
(M6-06: the work mode, the grants, the sync, the start route, the sessions
summary); M6-04 makes it deployable (two instances on the engine VM,
`prod` and `staging`, by the CI: ADR-016's M6-04 amendment, the switch from
heig-classroom's portal in `apps/codespace/deploy/RUNBOOK.md`), M6-05
sizes the VM, and from M6-07 it launches `online_seb` from a `seb`
session; no SEB project opens to students before proof B is recorded. See
[merge progress](../merge/PROGRESS.md).

**Amended (2026-10-08, product owner): an administrator always holds the
workspace grant.** Scope: amendment "M6-06" (B)'s last sentence, and (C)
for an administrator. An account whose role is `admin` (`users.role`, the
role rule's `SUPER_ADMIN_EMAIL`, whether or not a Super Powers session is
active) is granted with at least the default quota
(`DEFAULT_MAX_ACTIVE_SESSIONS`, 2), the most permissive of that and any
row its addresses hold. `grantOf` (`modules/codespace/service.ts`) is the
one place that says so, so the mode switch, the staff's view and the quota
sent to the portal (an administrator holding the quota as creator or
oldest owner) give one answer. The owner check is unchanged: an
administrator sets a mode on a course where they hold an owner seat, or
under Super Powers (ADR-054). The administration lists no grant row for
them and needs no switch.

**Amended (2026-10-07, M6-07, D21 points 2–5): Safe Exam Browser for a
project.** Scope: amendment "M6-06" (A)'s `online_seb` clauses and point 7.
Quiz builds the project's `.seb` (`GET /app/api/projects/:id/seb`, a
claimed seat of a published `online_seb` project); its start URL is Quiz's
one-time ticket (no second sign-in), its URL filter adds the portal's host
and `SEB_EXTRA_ALLOWED_HOSTS`. The ticket opens a `seb` session confined to
the project (ADR-027 addendum "M6-07"); from it, and from it only, the
start route mints the launch token with the `seb` claim, the session's
Config Key (`seb_required` otherwise). The portal's `/launch` in exam mode
refuses a token without the claim and checks SEB's header against it,
then the Browser Exam Keys when the project has some, then sets its
IP-bound `exam_session`. Point 7 as amended: the Browser Exam Keys are
**optional** on the portal (an empty list is the Config Key alone), and
Quiz sends none: **BEK list: after proof B step 7 (per-student `.seb`
likely gives per-student BEKs)** — SEB's BEK covers the configuration,
which is per student here (06 §6.3). `online_seb` is synced like
`online`. The portal builds no `.seb` any more (its `/exam/:id.seb`,
Config Key and salt are gone).

**Amended (2026-10-07, M6-03, product owner): the portal's GitHub relay and
its own login.** Scope: the portal side of points 2 and 6 below, nothing
on the platform side.
(a) *Relay off.* The relay and the development (Forgejo) forge are
imported, heig-classroom's App-backed GitHub forge is not, and the portal
runs with `FORGE_KIND=none` by default: a push lands in the session's
`staging.git` and its `PushEvent` is written (the proof of submission),
nothing is relayed to GitHub. The portal refuses to start, in every
environment, when `GITHUB_APP_ID` or `GITHUB_APP_PRIVATE_KEY_PATH` is set:
the only App it was ever configured with is heig-classroom's, which Quiz
never uses (root invariant 15, D23). Whether Quiz's own App key goes on the
engine VM, and so whether the relay is turned back on, is **open**: an ADR
at M6-04/M6-05 decides it. Until then the "only the portal relay writes"
of point 2 is read as "nothing writes from a workspace".
(b) *No login of its own.* The portal's OIDC login (`/auth/*`), its home
page with a Start button, its `/teacher/sessions` dashboard and its
standalone `/exam/:id/start` route are removed: a user exists only through
the platform's launch token, every portal account is a student, and an
exam opens through `/launch` only. A teacher sees an assignment's
workspaces in Quiz, which calls the portal's
`GET /api/assignments/:id/sessions` with a service token
(`CodespaceSessionSummary`, `@quiz/contracts`). The portal's `seb/`
directory is kept as is until M6-07 moves it onto `packages/seb`.

**Amended (2026-10-07, M6-06, product owner): the work mode in Quiz.**
Scope: points 1 to 6 on the platform side, as Quiz implements them; the
portal is unchanged.
(A) *The mode.* `projects.work_mode` (`free | online | online_seb`,
default `free`, migration `0079_codespace_module`). It is set by its own
route, `PUT /app/api/projects/:id/workspace/mode`, in any state of the
project, never by the create or the patch. Point 3's one-way door becomes:
the mode is **frozen once a workspace was launched** for the project — the
first launch token issued to a student seat, `codespace_projects.first_launch_at`
— and any change after that is `409 work_mode_frozen`; a staff seat's
launch (ADR-077, a teacher testing the project on their test repository)
never freezes it; before it, every mode may
change, `free` included. A group project stays `free` (F-PROJ-06): an
online mode on a group project, or group mode on an online project, is
`409 work_mode_group`. Point 2 applies from the next invitation: `push` in
`free`, `pull` in `online`, none in `online_seb` (the repository is
provisioned, nobody is invited; a second Accept answers it as it stands);
an invitation already sent keeps the permission it had. `online_seb` can
be set, but its start is refused outside Safe Exam Browser with a named
refusal (`seb_required`) until M6-07, and it is not synced: the portal
refuses an exam without Browser Exam Keys, which come with M6-07.
(B) *Who.* Only an **owner** of the course (ADR-068, `requireCourseRole`:
an assistant gets `403 owner_required`, in the loader, before the body)
whose `teacher_grants` row has `codespace_enabled = true` may set a
non-free mode (`403 codespace_not_granted` otherwise; going back to `free`
needs no grant). The grant is two columns on `teacher_grants`,
`codespace_enabled` (false) and `codespace_max_active_sessions` (2),
edited by an administrator (`PATCH /app/api/admin/teachers/:gid/codespace`).
An account's grant is read on its VERIFIED addresses only (its verified
ones, and its sign-in address when the identity provider verified it), the
most permissive row winning, as the role rule does; the administrator, whose address cannot hold a grant, is not
granted (an administrator acts as an owner under Super Powers, ADR-054,
never past the grant) — superseded 2026-10-08: an administrator is always
granted (amendment above).
(C) *Whose quota.* The quota an online project consumes is carried by its
**creator while they still hold an owner seat** on the course, otherwise by
the **oldest owner seat** (`quotaHolder`, `@quiz/domain`); it is sent to
the portal with each sync (`teacher` and `quota` of
`CodespaceAssignmentSync`), and the portal enforces it at launch (its
429). Quiz does not count the live workspaces itself.
(D) *Off.* With `CODESPACE_URL` empty the `codespace` module registers no
route (every one a 404, indistinguishable from a missing entity), the
administration lists no grant, and a project's student view says no
workspace.
The two messages of point 6 are Quiz's: the sync is the `codespace.sync`
job (no singleton key: Quiz's queues dedupe nothing, #273; the PUT is
idempotent), its last outcome on `codespace_projects` with the staff's
*Resync* (`POST …/workspace/sync`); the start route is
`GET /app/codespace/start/:projectId` (the portal's `classroomStartUrl`
already builds that path), loaded through the classroom's student branch
with a claimed seat and the caller's own portal session — an
impersonation, a request carrying a Bearer token: the 404; a `seb` or `kiosk` session is
anonymous there (ADR-027's default deny) until M6-07 —; the token's `jti`
is audited (`codespace.launch_issued`), the token never; the decision is the pure
`workspaceStartRefusal` (`@quiz/domain`). The staff read the project's
workspaces through `GET …/workspace/sessions`, named by Quiz for the
classroom's students and by nobody otherwise (the portal's address of an
unmatched account is not sent).
**Seeding, while the portal's forge is off** (M6-03 amendment (a)): the
workspace is seeded from the project's distribution repository, which the
portal clones anonymously. A PUBLIC distribution repository seeds it; a
private one (Quiz's default) syncs, but cannot seed a workspace, until the
decision on Quiz's App on the engine VM (M6-04/M6-05).

**Imported from heig-classroom** (2026-09-30, merge task M0-03, ADR-035),
where it is ADR-013 — Quiz's own ADR-013 is pool sharing, so it takes the
next free number, 047. The body below is classroom's, verbatim. Read it
with the renames of the merge: *assignment* ⇒ **project**
(`assignments.work_mode` ⇒ `projects.work_mode`; the portal's own
`/api/assignments/:id` route is the portal's business); *classroom*
(org-bound, owned) ⇒ a Quiz **course** plus **classroom**, and "the owner
of the class" ⇒ the course's staff (D04), except for the quota below:
whose `teacher_grants` quota an online project consumes once several
staff share a course is for M6 to decide; a codespace *session* ⇒
**workspace** in Quiz's vocabulary; `@hgc/codespace` ⇒ `@quiz/codespace`;
`CLASSROOM_URL` ⇒ `PLATFORM_URL`; `apps/server` ⇒ `apps/api`;
`classroom.chevallier.io` ⇒ Quiz. The portal (`apps/codespace`) and this
mode come with phase M6, after the cutover (D09, settled 2026-10-01: the
workspace is rebuilt and tried in Quiz before any migration of it). How SEB reaches a project — the
platform building every `.seb`, Browser Exam Keys optional per activity —
is D21, settled 2026-10-01 on the suggestion, for M6; point 7 below holds
until M6 implements it. Its two HS256
messages are the cross-VM exception recorded in ADR-027's status.
Classroom's requirement ids (GR-, GH-, NFR-, AU-) are those of
heig-classroom's specification; `docs/spec/02-exigences-fonctionnelles.md`
receives their Quiz form (M0-04), and until then they are read in
heig-classroom's `docs/`.

**Amended (2026-10-07, [ADR-078](ADR-078-codespace-git-relay-tokens.md), product owner)**: the open question of the M6-03 amendment (a) and of the seeding note above is settled — no App key on the engine VM; the portal seeds and relays with installation tokens Quiz issues for one repository (forge `quiz`, merge task M6-10).

**Amended (2026-10-09, [ADR-089](ADR-089-kiosque-pour-l-espace-de-travail.md), proposed)**: the M6-07 amendment's "`seb` claim only" — an `online_seb` project may also accept a kiosk station, whose launch token carries a `kiosk` claim instead.

**Extended (2026-10-05, ADR-075, proposed)**: supervised evaluations may open the workspace through the `workspace` question type, without a git channel; the project rules below are unchanged.

Status in heig-classroom: Accepted (2026-09-17, portal milestone 2).

## Context

The `apps/codespace` portal makes the student work inside a hardened container served by
code-server, possibly under Safe Exam Browser. Its founding invariant is that **no secret
enters the student container**: no GitHub token, no SSH key, no credential helper. It is the
container that pushes — through a relay authenticated by the source IP address on the
internal bridge — and not the student from their editor.

Now, in the historical classroom flow (the "free" mode), the student repository is
provisioned with `push` permission: the student clones and pushes with their own GitHub
account. Keeping that right in online mode would mean two write paths coexisting on the same
repository (the portal relay, and the student from any browser), which makes the content of
an exam indefensible: nothing distinguishes a commit produced in the supervised session from
a commit pushed from home.

We also have to decide who may turn the feature on. The container engine is a privileged
component on a dedicated VM with bounded capacity (a few dozen sessions); opening it to every
teacher of `classroom.chevallier.io` at once makes no sense while the pilot covers one or two
classes.

## Decision

1. **An assignment has a work mode** (`assignments.work_mode`, `WorkMode` of the shared
   contract): `free` (unchanged), `online`, `online_seb`. The default is `free`: every
   existing assignment keeps exactly its behaviour.
2. **No student credential, therefore no write access.** Provisioning
   (`github/provision.ts`) invites the student with the permission:
   - `free` → `push` (the historical flow, strictly unchanged);
   - `online` → `pull`: the student reads their repository and re-reads their commits, but
     only the portal relay writes to it — so there is no student credential to distribute,
     expire or revoke;
   - `online_seb` → **no invitation at all**: during an exam, the student has no access to
     the repository before grading.
   The anti force-push and anti-deletion ruleset (`hgc-protect`, GH-21..23) stays in place in
   all three modes: it also protects against the relay.
3. **A one-way door.** An assignment published in an `online*` mode cannot go back to `free`
   (409 `work_mode_frozen`). Its repositories were provisioned without write access; going
   back to `free` would leave every student in front of a repository they cannot push to, and
   granting `push` after the fact would contradict exactly the invariant this mode protects.
   A new assignment is created instead.
4. **Activation by the administrator, teacher by teacher**, with a quota of simultaneous
   sessions: two columns on `teacher_grants` (`codespace_enabled` at `false`,
   `codespace_max_active_sessions` at 2). A teacher without that grant does not see the
   "Work mode" section of the form (the front end reads `Me.codespace`) and the API refuses
   any non-`free` mode with a 403 — the server-side check is the only authoritative one.
5. **Global absence is possible.** An empty `CODESPACE_URL` means the feature does not exist:
   no administration column, no selector, and the `/app/codespace/*` routes answer 404. A
   `CODESPACE_URL` without a `CODESPACE_LAUNCH_SECRET` of at least 32 characters makes
   startup fail (ADR-010: secrets travel through the environment).
6. **Two HS256-signed messages, never a cross import** (the import rule of the root
   `CLAUDE.md`):
   - classroom → portal: `PUT ${CODESPACE_URL}/api/assignments/:id` with a
     `CodespaceAssignmentSync` body and a 2-minute `ServiceTokenClaims` in
     `Authorization: Bearer`. The call goes through **a pg-boss job** (`codespace.sync`,
     singleton key `codespace:<assignment>`, ADR-004/ADR-011): a portal that is restarting
     never makes saving an assignment fail, recovery is free, and the state of the last
     attempt (`codespace_synced_at`, `codespace_sync_error`) is shown to the teacher with a
     "Resync" button.
   - student → portal: `GET /app/codespace/start/:aid` checks enrollment, acceptance,
     publication and mode, issues a 5-minute `LaunchTokenClaims` with a random `jti` and
     redirects with a 303 to `${CODESPACE_URL}/launch?token=…`. It is a **navigable GET**
     because the portal also uses it as the `startURL` of Safe Exam Browser, which can only
     navigate. Issuance is logged (`codespace.launch_issued`) by its `jti`; the token itself
     never enters the log (AU-41).
7. **Browser Exam Keys are teacher-side secrets.** They are stored on the assignment
   (`browser_exam_keys`), sent to the portal in the synchronization message, and **never**
   included in a student payload.

## Consequences

- In online mode a student can no longer push from their own machine: that is the intended
  effect, but it means the portal becomes indispensable to submission. An outage of the
  portal during an online lab is therefore a submission incident, not merely a comfort one —
  the `free` mode stays the default for everything that does not need supervision.
- The grading CI is unchanged: it triggers on the relay's pushes exactly as on a student's,
  and the whole grading chain (GR-05..16) ignores the mode.
- The migration is purely additive (columns with defaults, no rewrite): the production
  service gets `work_mode = 'free'` everywhere and does not change behaviour.
- The quota is carried by the **owner of the class**, not by the staff member who saves the
  assignment: it is the person running the course who consumes the VM's capacity.
- The portal stays extractable: all it knows of classroom is those two signed messages.

## Rejected alternatives

1. **Keeping `push` in online mode** and relying on supervision: two write paths on the same
   repository, indefensible exam content, and the "no secret in the container" invariant
   would lose its point since the student would have a credential anyway.
2. **Distributing a short-lived token inside the container** so the student pushes
   themselves: that is exactly the secret the container hardening forbids, and it would be
   exfiltrable from any terminal in the editor.
3. **A synchronous HTTP call to the portal when the assignment is saved**: an unavailable
   portal VM would make an unrelated teacher action fail, and we would have to reinvent the
   recovery that pg-boss already provides.
4. **Global activation through an environment variable**: it would be impossible to run one
   class without exposing all the others, and there would be nowhere to put the per-teacher
   quota.
5. **A single global quota** rather than one per teacher: a teacher starting an exam would
   consume everyone else's capacity without any screen showing it.
