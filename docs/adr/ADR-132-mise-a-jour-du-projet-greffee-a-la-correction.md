# ADR-132 — A project's update reaches the grading, never the student's branch: the graded commit, the machine's correction redone, the teacher's update in the workspace

## Status

Accepted (2026-11-17). The principles, the graft (A), the Regrade's
semantics and its use after the release, C and B are the **product
owner's** decisions; choices (a) to (j) are the **orchestrator's**, after
the spec challenge and the code. A is delivered first, then C, then B.

Scope: a project graded by criteria whose snapshot is schema version 3
(ADR-119): which commit its graded run reads, which distribution files that
commit carries, when the graded run is accepted, what the LLM pass reads,
what a Regrade replaces, and the text of a sync's pull request (A); the
staff's view of a sync before it is sent (C); the student's way to take the
update into the online workspace (B). A v2 snapshot keeps ADR-106 whole.

Relations: amends [ADR-119](ADR-119-criteres-v3-preuves-de-la-ci.md) §6
(the dispatched sha, the acceptance's choice (c), Regrade) and §7 (the
LLM's sources); [ADR-106](ADR-106-notation-des-projets-par-criteres.md) §3
(the tarball's sha, for a v3 snapshot) and §4 (Regrade, for a v3 snapshot);
[ADR-062](ADR-062-depot-de-distribution.md) addendum 1 (which distribution
commit a graded pass reads; the restore unchanged);
[ADR-073](ADR-073-synchronisation-de-la-source.md) §4 (the pull request's
body) and, with C, §3; F-PROJ-11, -12, -23, -25 (docs/spec/02). Builds on
[ADR-012](ADR-012-gel-note-deux-temps.md) and
[ADR-064](ADR-064-echeance-des-projets-baux.md) (the target commit and the
freezes, unchanged), [ADR-130](ADR-130-releve-de-l-espace-de-travail-a-l-echeance.md)
§3, §4 and §9 (the collection's tree rule and mechanism, reused; the lock
binds the App). Leaves open question 61 open. Proposes the wording of
`CLAUDE.md` invariant 14 (§9).

## Context

A teacher of a lab graded by criteria often finds, once students started or
after the deadline, that a criterion, a unit test or the README is wrong.
Fixing it today takes: the source updated, a Sync, the project reopened,
the fix pushed by hand into every student repository, then the deadline,
the 30-minute grace and the grading waited for again.

The cause is in the acceptance of the graded run (ADR-119 §6,
`tamperedPaths` in `apps/api/src/modules/project/ci.ts`): a run counts only
when `criteria.yml` and the protected files at the student's target commit
equal the distribution's **current** head — ADR-119's choice (c) said "one
sha the distribution handed out", the code compares with the live head.
The CI runs in the student's own copy, with no overlay (v2's, ADR-106 §3,
is gone for v3). So any Sync after the start makes every repository that
did not merge it `ci_tampered`, with zero-point rows. And a Sync cannot
reach a repository past its deadline: it skips it (`syncSkips`), and the
lock ruleset `hgc-deadline-lock` (`apps/api/src/github/lock.ts`, target
`branch`, no bypass, ADR-130 §9) refuses every branch push.

A spike on a real repository under that ruleset (user token, 2026-11-17)
showed: updating or creating a branch is refused (422); creating blobs,
trees, commits and a `refs/quiz/grade/t1` ref is accepted;
`actions/checkout` of that commit works, even without a ref; the ref fires
no workflow.

## Decision

### 1. The owner's principles (2026-11-17)

- **The distribution is the reference.** What the teacher put in the
  distribution — the criteria, the tests, the protected files — is what a
  repository is graded with.
- **The student's copy is never touched.** The platform writes no student
  branch to apply an update; an obsolete copy is fine.
- An update reaches the student's work only when the student takes it: the
  sync's pull request (ADR-073), or B's one click in the workspace.

### 2. The graded commit (A; owner, with choices (a) to (e))

At each v3 pass that is dispatched — final, milestone, Regrade — the
platform builds in the student repository a **graded commit**:

- **Its tree** is the target's (the pass's target commit, ADR-106 §3 and
  ADR-119 §6, chosen exactly as today) with every entry under the
  project's protected list and `criteria.yml` taken from the distribution
  commit below. A protected directory is replaced whole: a file the student
  added under it is gone, a file the distribution lacks there is gone, and
  a protected path the distribution lacks is absent. A student's file or
  symbolic link standing where a protected directory goes is dropped.
  Everything else — the student's files, links and gitlinks — is the
  target's, untouched. This is the collection's composition (ADR-130 §3,
  `composeCollectionTree` in `@quiz/domain`) without its removal of
  gitlinks: the target is a commit GitHub already holds, its gitlinks are
  the student's as pushed.
- **The distribution commit** is the one the criteria snapshot was read at
  (`project_criteria.source_sha`), never the live head (choice a): a
  refused `criteria.yml` keeps the old snapshot and its files together, and
  a Sync during a dispatch wave cannot split the class between two
  versions. The snapshot is read on the distribution's first handed-out
  branch, so every branch's target is grafted from it — the reference the
  acceptance already used (ADR-119 choice (c)). A snapshot taken from the
  source while no distribution existed (`criteria.ts`) holds a sha the
  distribution may lack: the pass then grafts from the distribution's head
  of that branch, and records it.
- **The workflows are grafted like any protected entry** (choice b):
  GitHub runs a `repository_dispatch` from the default branch's head, so a
  workflow in the graded commit is never executed; the App already holds
  the `workflows` permission (`github/manifest.ts`); excluding them would be
  one more special case for no effect.
- **No graft when nothing differs** (choice c): the target is dispatched as
  it is today.
- **Where**: its parent is the target; it is anchored on
  `refs/quiz/grade/<pass id>`, never a branch, which the lock does not
  cover (the spike); the student's branches never move. The ref is left in
  place: it is harmless, never merged, and lets the staff fetch exactly
  what was graded. Its content is what the sync's pull request would show
  the student anyway.
- **How** (choice d): with git on the API host, as the collection does on
  the portal (ADR-130 §4): a shallow fetch of the target from the student
  repository and of the distribution commit from the distribution, their
  `ls-tree`, the composition, a temporary index, `write-tree`,
  `commit-tree`, and a push of the commit to its ref. The token reaches git
  through the environment only (`gitRunner`, invariant 15); the work
  directory is removed. Its author, committer and dates are fixed (the
  App's identity, the pass's claim time) and its message is English (D12),
  so a retry builds the same sha. The Git Data API (`revert.ts`'s way) was
  rejected: one content-creating REST call per missing blob, tree, commit
  and ref and repository counts against GitHub's secondary limits (80 a
  minute, 500 an hour) for a class of 100 with a replaced test directory,
  and its tree creation leaves a file-to-directory replacement and nested
  paths without a base tree unverified; a push is one call and git
  composes any tree.
- **In the `project.ci` job**, before the claim: the target, then the
  graft, then the claim records `sha` (the target, so `passTarget`, the
  regrade logic and the commit graph keep it), `graded_sha` (null: nothing
  grafted), `distribution_sha` and `grafted_paths`; then
  `client_payload.sha` is the graded commit. A graft that fails (GitHub or
  git) throws before the claim: the job is retried, and the pass's 24 h
  settle it `no_result` otherwise. A repository archived as its lock is
  never grafted: it stays `ci_unavailable` (ADR-119 §6).
- **A push webhook for the ref**, if GitHub sends one, is never a student's
  push (choice e): the push handler reads branches only (`BRANCH_REF`), so
  neither the last commit nor `protectFiles` sees it; the receipt
  `writeReceipt` stores is a bot's (the App is its sender, and no portal
  ever declares a sha the server minted) and its branch is the ref, which
  no handed-out-branch reader and no `is_bot = false` reader takes. No
  `bot_commits` row: the commit never lands on a branch, and
  `grade_dispatches` records it.

Group repositories and the staff's test repositories (ADR-077) are grafted
like any other.

### 3. The acceptance of the graded run (amends ADR-119 §6, choice (c); choice f)

- **At the graded commit** (the target for a pass claimed before this
  record), `criteria.yml` and the protected list must equal the recorded
  distribution commit's (the live head for such an older pass): a sanity
  check of the graft.
- **At the run's `head_sha`**, `.github/workflows/grading.yml` must equal
  **a version the distribution's history holds** on the repository's
  default branch — any commit of it, read through GitHub's list of the
  commits that changed that path —, no longer only the live head: a
  student who never merged a sync runs the workflow they were handed. Under
  `squash` that history is the build and each sync; under `whole` it is the
  source's history, every version of it the teacher's own.
- `ci_tampered` therefore remains, in practice, for the workflow alone.
  Every other check of ADR-119 §6 is unchanged.

### 4. What the LLM pass reads (amends ADR-119 §7, ADR-106 §3; choice g)

The sources come from the tarball at the **graded commit** when the pass
built one, so the model reads the teacher's current files beside the
student's. A pass settled before any dispatch (archived, no installation)
reads the target as today. The tarball's `token=` redaction, cap and
top-level stripping are unchanged (invariant 15).

### 5. A Regrade redoes the machine's correction (owner; amends ADR-106 §4 and ADR-119 §6 for a v3 snapshot)

- A Regrade replaces the repository's **whole machine correction**: its
  `auto` and `llm` rows, validated ones included. A teacher's `manual` row
  and a milestone's locked row stay — the rows `supersedeProposals` already
  leaves on a reopen. No per-criterion difference is computed.
- **Only an accepted run replaces** (choice h): a Regrade's `auto` rows,
  validated included, are superseded when an accepted run of that
  Regrade's pass settles for the repository, never at the claim. An
  Actions outage, `no_result`, `ci_tampered` or the 24 h leave the previous
  rows as they were, the failure shown to the staff. That pass's review
  replaces the `llm` rows, validated included, with the model's reply only;
  a review that fails (`llm_budget`, `grader_error`, sources unavailable)
  leaves a validated row as it was.
- **After the release** (owner): Regrade stays allowed, behind an explicit
  confirmation; the API refuses it for a released project unless the
  request carries the acknowledgement (`409 regrade_released`). What a
  released grade does meanwhile (F-PROJ-14, F-PROJ-26): the student keeps
  reading the release's snapshot (`released_points`, `released_grade`) —
  their grade does not move; the replaced rows wait for the teacher's
  validation again, so the repository is no longer validated, its staff
  score falls back to its next source and shows "changed after release";
  a new release is refused (`409 not_validated`) until every repository is
  validated, and only that release changes what the student reads, with no
  new notification (`project_grade_final` goes out on the first release
  only). The confirmation says so.
- A Regrade's caps (3 a day per project, 3 per repository) are unchanged.

### 6. The staff's trace and the audit (choice i)

- The grading screen shows the staff, per repository, one line from its
  latest graded pass: the number of files the distribution's version
  replaced, and their paths. It does not tell a stale file from one the
  student changed: that needs every version the distribution ever handed
  out per file, which the truthful line "N files replaced by the
  distribution's version" does not. Nothing of it reaches a student.
- A graft is audited `project_repo.grade_grafted` (the closed union of
  `apps/api/src/audit.ts`): the project, the pass, the graded and
  distribution shas and the paths (capped, with their count), never a
  token.

### 7. The sync's pull request (amends ADR-073 §4; choice j)

Its body no longer says "your score never depends on this pull request
until you merge it", false now for the protected files and `criteria.yml`.
It says, in English: merging brings the update into the student's copy; the
protected files and `criteria.yml` are graded in the teacher's version
whether or not it is merged; every other file is graded as the student
pushed it. A pull request already open keeps its body.

### 8. What does not change

The target commit and its receipts (ADR-012, ADR-064, open question 61
untouched); the restore of protected files on a branch (F-PROJ-08, the
distribution's current version); Sync's skips; the lock; a v2 snapshot's
runner path; the push runs and the `GRADE` badge.

### 9. Invariant 14 (proposed wording, applied with A)

"The source sent to the runner is rebuilt server-side from the template and
the student's editable regions — never taken as-is. A project's source is
fetched by the server at a commit the server chose from its push receipts
(ADR-106 §3), or at the graded commit it built on it — that commit's tree
with the protected files and `criteria.yml` of the criteria snapshot's
distribution commit, on a `refs/quiz/grade/` ref, never a branch
(ADR-132 §2) — never uploaded by a client. The graded run of a v3 project
checks out the sha the server dispatches, bound by its nonce and the
protected workflow (ADR-119 §6)."

### 10. C — the sync, previewed and explained (owner; to be delivered)

- Before Sync, a **preview**: the paths the distribution would add, modify
  and delete, protected or not.
- An optional **teacher's message**, shown on the student's Quiz project
  page and in the pull request's body.
- After a sync, **Regrade** is offered (§5's semantics).

Open points: where the message is stored and how long it shows; whether the
preview reads the source through the hand-out transform or the updated
distribution, given that the request updates the distribution before the
job (ADR-073 §2); the message's length and its language (the pull request
is English, D12; the message is the teacher's own text).

### 11. B — "Teacher's update" in the online workspace (owner; to be delivered)

One click in the workspace's status bar takes the update: a local merge
commit the student then pushes as any work. `online` first, `online_seb`
after.

Open points:

- the portal seeds an exam's staging from the template, never from the
  student's repository (`apps/codespace/CLAUDE.md`, invariant 11): under
  `online_seb` the update is fetched from the distribution;
- an exam's staging is force-re-seeded at every resume, so the update must
  land on a non-branch ref there;
- Apply always makes a merge commit: a fast-forwarded sync sha is in
  `bot_commits(sync)` and would be read as the App's push;
- Apply refuses on a dirty tree or a conflict outside the protected files,
  and names the files;
- "update available" is derived from the staging's state;
- F-PROJ-12's "the platform never merges" holds: the student's click is
  the merge;
- no pull request is opened for `online_seb`.

## Consequences

- A teacher fixes a test, a criterion or a README in the source, syncs (or
  reloads the criteria), and regrades: every repository is graded with the
  fix, locked or not, merged or not, with no reopen and no hand push.
- The student's branches, history and receipts never move for it. The
  graded commit is visible to the repository's members on its ref.
- A student who never merges a sync is graded with the teacher's current
  protected files and their own other files; an obsolete copy of a
  protected file costs them nothing.
- `ci_tampered` becomes rare; a run where the graft did not hold is still
  shown, not graded.
- One git fetch-and-push per repository and pass on the API host, inside
  the 15-second pace per installation.
- A Regrade after validation or release costs the teacher a new validation
  and a new release; the student's grade moves only at that release.
- Push to a non-branch ref by the App, under the lock, and the push
  webhook such a ref may send are to be confirmed on staging (the spike
  used a user token and REST); the code is safe either way (§2).

## Alternatives considered

- **Push the update into each student branch, bypassing the lock**:
  rejected by the owner (the student's copy is never touched) and by
  ADR-130 §9 (no bypass of the lock).
- **The distribution's live head as the reference**: rejected (choice a) —
  a refused `criteria.yml` would grade new tests against old criteria, and
  a Sync during a dispatch wave would split the class.
- **Overlay at intake, as v2 did**: impossible for v3 — the CI runs in the
  student's repository, so the files must be in the commit it checks out.
- **The Git Data API for the commit**: rejected (§2, choice d).
- **A per-criterion Regrade, replacing only what changed**: rejected by the
  owner — the whole machine correction is redone.
- **Refuse a Regrade after the release**: rejected by the owner; an
  explicit acknowledgement instead.
- **A new `bot_commits` kind for the graded commit**: unnecessary — it is
  never on a branch, and its pass row records it.
