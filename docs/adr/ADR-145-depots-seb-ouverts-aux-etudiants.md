# ADR-145 — An `online_seb` project's repositories opened to their students, read-only, by the course owner

## Status

Proposed (2026-11-24). The nine decisions below are the product owner's
(2026-11-24); the frozen-repository reading of decisions 1 and 8, the
data, the job and the exposure rule are the orchestrator's, within them.

Scope: who reads an `online_seb` project's repositories on GitHub once the
lab test is over, and how that access is given and taken back.

Relations: amends [ADR-047](ADR-047-espace-de-travail-en-ligne.md) §2
(`online_seb` → no invitation at all, "no access before grading");
amends [F-PROJ-13](../spec/02-exigences-fonctionnelles.md),
F-PROJ-15, F-PROJ-19 and
[N-SEC-20](../spec/03-exigences-non-fonctionnelles.md); reads the
invitation ledger of [ADR-070](ADR-070-repartitions-de-groupes.md) §4–§5,
the leases of [ADR-064](ADR-064-echeance-des-projets-baux.md), the
collection of [ADR-130](ADR-130-releve-de-l-espace-de-travail-a-l-echeance.md)
§6 and the graded commits of
[ADR-132](ADR-132-mise-a-jour-du-projet-greffee-a-la-correction.md) §2.

## Context

A lab test sat in the online workspace under Safe Exam Browser or at a
kiosk (`online_seb`) invites nobody on GitHub: during the exam the student
has no credential and no access to the repository, the portal alone writes
to it (ADR-047 §2). Nothing existed for after the exam: the students never
saw their own copy, the tests that graded it nor its CI runs, while an
`online` project's students read theirs all along. Teachers asked to hand
the work back once the lab is over.

What a GitHub collaborator with `pull` reads is not ours to filter: the
whole repository, its branches and refs, its Actions tab. Opening a
repository is therefore a disclosure, and a clone made then cannot be taken
back. The access must be an explicit act, after the grading, and closable
for whatever GitHub still lets close.

## Decision

The product owner's decisions (2026-11-24):

1. **An explicit act of the course owner**, possible once the scores are
   released. A project that is not graded (grading mode `none`, never
   released) may be opened once every live repository is frozen for good.
2. **No new step** in the project page's timeline.
3. **The primary action.** Once possible, *Open repositories* is the staff
   project page's primary action (the server's `primaryAction`,
   `open_repos`), shown only then. Rank: Grade and Release (the release
   again after a score moved included) first, then the opening, then Sync.
   Once opened, the rule of before applies again.
4. **Read-only**: a `pull` invitation, never more.
5. **Confirmed, one-way in practice**: the confirmation says that a cloned
   copy cannot be taken back, and that the CI runs and their logs become
   readable too.
6. **Closing** the access again is a secondary action of the Repositories
   tab, confirmed: it revokes the GitHub access and says it cannot take
   back a clone.
7. **Only a repository holding its student's work is opened**: at least one
   commit counted by the student's own rule (the card's and the staff
   page's, F-PROJ-04, F-PROJ-13), a workspace collection (ADR-130 §6)
   counting as the student's work. A student who accepted and never worked
   (absent, a make-up to come) gets nothing — the repository holds the
   statement and the tests — and the staff read it as "nothing to open".
8. **A deadline move that would reopen a repository** of an opened project
   is refused, `409 repos_open`, "close the access to the repositories
   first": the project's deadline, a repository's own, anything that clears
   the frozen and deadline-applied facts (all go through
   `effectiveDeadlineMoved`, `deadline.ts`). No GitHub call is added to
   those paths.
9. The labels are ours to write, in the four languages.

The orchestrator's reading of decisions 1 and 8, by symmetry: a graded
project, released, is opened only once every live repository is frozen
for good too (`409 repos_not_frozen` otherwise, and no primary action). A
make-up whose repository was given a later deadline of its own after the
release still runs: its classmates would otherwise receive the statement
during it.

The design:

- **The fact** is one column, `projects.repos_opened_at`, the server's
  clock, null while closed; the owner's open and close write it, audited
  `project.repos_opened` and `project.repos_closed`, and answer 204. Each
  change bumps a revision of the fact (`repos_access_rev`) in the same
  transaction. A write that changes nothing writes nothing and sends no
  job: a close never touches a project that is not open, of any mode.
  Neither calls GitHub.
- **The permission** of every invitation — an Accept, a resend, the
  reconciliation, the job below — is one rule, `collaboratorPermission`
  (`@quiz/domain`): `free` → `push` and `online` → `pull`, unchanged;
  `online_seb` → `pull` only while the repositories are open, neither the
  project nor its classroom archived, on a repository the opening opens
  (`openingOf`: individual, live, frozen for good, holding the student's
  work), otherwise none. An invitation recording its grant reads the
  opening again under the project's row lock, so a close either finds that
  grant or makes the invitation record none.
- **The job** `project.repos_access` is the project's one runner on
  GitHub, under its own lease (`repos_access_job_at`, ADR-064's claim and
  expiry). While open, the seat of every repository the opening opens and
  nobody is let into is invited with `pull`; while closed, every recorded
  live grant of the project's repositories is revoked, one at a time, a
  pending invitation cancelled first, and the repository's invitation state
  goes back to `none` — never through `revokeEnrollmentAccess`, which would
  cut the student's repositories of every other project. The owner's
  change sets the fact, its revision and, when no live job holds it, the
  lease, in ONE transaction; the job is sent after the commit. Each pass
  lists from the database; the job gives the lease back only in a write
  that finds the revision its pass read, and otherwise runs another pass
  on the project as it stands (`runLeased`'s `releaseWhile`). A close, a
  re-open and a close again while a pass worked are a new revision, never
  the closed fact it started from; a grant an Accept or a resend records in
  an open window is listed by the next pass. Whatever the interleaving,
  the last pass therefore leaves GitHub and the invitation states as the
  fact says. A failure backdates the lease and a crash leaves it: the
  ticker claims each. A take-back of a raced invitation that GitHub
  refuses bumps the revision too, so a job holding the lease runs another
  pass instead of giving it back, and arms an expired lease when none is
  held. A project of another mode is never touched. A
  repository archived as its lock, a seat without a linked or with a stale
  account, a seat gone from the roster: skipped, never fatal for the
  others.
- **The student** reads the outcome through the project's student view
  alone (N-SEC-20): once opened and invited, their card and page carry their
  invitation and lead to GitHub as an `online` project's do; before the
  opening and after a close, no invitation. The student view anticipates
  the revocation on purpose: a closed `online_seb` project shows no
  invitation even while the job is still revoking a stale `pending`.
- **Archives.** Archiving a project or its classroom stops new invitations
  and never touches the GitHub grants already given, as in every other
  mode; closing the access stays possible on an archived project.
- **A staff unlock** of a frozen repository of an opened project is
  reachable and harmless, so it has no guard: it lifts the lock and clears
  no freeze (only `effectiveDeadlineMoved` clears `frozen_at`, and it
  refuses `repos_open`); under `online_seb` the workspace stays closed at
  the effective deadline plus the grace whatever the lock
  (`workspaceClosesAt`, `gitTokenRefusal`); the student's permission stays
  `pull`.

**What a `pull` collaborator reads**, stated for `online_seb` as it already
holds for `online`: the repository's files at every commit and branch; the
Actions tab with every run — the final pass's and a Regrade's included —,
their logs and their `results` artifact while GitHub keeps them; the graded
commits under `refs/quiz-grade-*` with the distribution's protected files
(ADR-132 §2); the sync pull requests. Nothing platform-side: the
rationales, the evidence, the AI's rows stay on Quiz and reach the student
only through the student view. A teacher whose `grading.yml` prints hidden
tests in its logs exposes them by opening.

Limits stated, not solved in v1:

- The reconciliation never re-invites on a frozen repository
  (`reconcile.repos`): an invitation that expires is re-sent by the
  student's own resend or the staff's.
- No Quiz notification: GitHub's invitation e-mail and the card are the
  signal.
- A roster removal of a student who holds a grant can now fail with
  `502 revoke_failed` in a SEB classroom too (F-PROJ-17), as in any other.

## Consequences

- The confirmation names the course's other projects on the same source
  that are not locked yet: a sitting still to come would receive the
  subject through a student's clone.
- An opened project's deadline is held: a make-up sat later on the same
  project needs the access closed first, which takes nothing back that was
  cloned.
- One more lease and job per project, idle outside an open or a close.

## Alternatives considered

- **Opening automatically at the release.** Rejected by the product owner:
  the release and the disclosure are separate decisions, and a make-up may
  be due.
- **Revoking through `revokeEnrollmentAccess`.** Rejected: it takes the
  student out of every repository of the classroom's projects.
- **Hiding the CI logs.** Not possible with a GitHub collaborator: the
  Actions tab follows the repository's read permission.
