# ADR-132 — A project's update reaches the grading, never the student's branch: the graded commit, the machine's correction redone, the teacher's update in the workspace

## Status

Accepted (2026-11-17). The principles, the graft (A), the Regrade's
semantics and its use after the release, C and B are the **product
owner's** decisions; choices (a) to (j) are the **orchestrator's**, after
the spec challenge and the code. Delivered in this order, tracked in
`changes/`: A1 (§2–§4, §7), A2 (§5, §6), C, B. A1 and A2 are delivered
(`changes/project-update-graded-commit.md`, `changes/project-regrade-machine.md`);
C and B are not.

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
`CLAUDE.md` invariant 14 (§9, applied).

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
no workflow. A second spike (user token, 2026-11-17) showed: a `git push
<sha>:refs/quiz/grade/t2` to a repository under the lock is accepted; a git
push of the same commit to a new branch is refused ("Cannot create ref due
to creations being restricted"); neither ref fired a workflow, though the
repository had an unfiltered `on: push` workflow. A third (2026-11-17):
a single-component ref `refs/quiz-grade-<uuid>` is accepted under the lock;
a member with push access who creates `refs/quiz/grade` (or `refs/quiz`)
makes every later `refs/quiz/grade/<pass>` push fail on the name conflict,
after the deadline too; once a ref is deleted, its commit is still fetched
by sha (`git fetch --depth=1 <url> <sha>`) and GitHub's tarball of a
commit no ref names works. On real GitHub too (user token, a repository
under the lock, 2026-11-17): `git fetch --depth=1 <url> <sha>` of a target
that is not the branch's tip works; the shallow, negotiated push of the
graded commit to `refs/quiz-grade-<uuid>/graded` is accepted; the commit
holds the teacher's file and the student's tree at the target, not the
later push. Still owed on staging, with the App's installation token: the
Consequences' "Before production" list.

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

At each v3 pass — final, milestone, Regrade — the platform builds in the
student repository a **graded commit**. It does not depend on a dispatch:
a pass whose scope holds no automatic criterion (ADR-119 §6, amendment of
2026-11-02) is never dispatched, but still gets its graded commit, which
its LLM review reads (§4). Only a repository that cannot be written — gone,
archived as its lock, or without an installation — or whose graft failed
or is above the size ceiling gets none, and its review reads the target
as before.

- **Its tree** is the target's (the pass's target commit, ADR-106 §3 and
  ADR-119 §6, chosen exactly as today) with every entry under the
  project's protected list — which in this mode always holds
  `criteria.yml` and `.github/workflows` (ADR-119 §9) — taken from the
  distribution commit below. A protected directory is replaced whole: a file the student
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
  `refs/quiz-grade-<pass id>/graded`, never a branch, which the lock does
  not cover (the spikes); the student's branches never move. The first
  component holds the pass id, which nobody knows before the push, so no
  member of the repository can create a ref that blocks it (as
  `refs/quiz/grade` would block `refs/quiz/grade/<pass>`); the second
  component is there because stock git refuses a ref directly under
  `refs/` (GitHub accepts one, the third spike). The ref is a best-effort
  anchor only: the dispatch, the acceptance and the review read
  `grade_dispatches.graded_sha`, never the ref, and GitHub serves a commit
  no ref names (the third spike), so a member who moves or deletes it
  changes nothing of the grading. Its content is what the sync's pull
  request would show the student anyway.
- **How** (choice d): with git on the API host, as the collection does on
  the portal (ADR-130 §4), plumbing only, in a bare repository of its own
  under the system's temporary directory, removed on every exit and swept
  when the API's job worker starts (a crash or a deploy skips `finally`):
  the target fetched from the student repository and the distribution
  commit from the distribution, both at depth 1 (pushing from that shallow
  repository works for a target behind the branch's tip, tested), their
  `ls-tree`, the composition, a temporary index (`update-index
  --index-info`), `write-tree`, `commit-tree`, and a push of the commit to
  its ref (negotiated, so only what the repository lacks travels). Nothing
  is checked out; the bare repository has no hook (an empty template) and
  the push runs none; paths travel as bytes, so a path that is not UTF-8
  is kept as it is. The token reaches git through the environment only
  (`gitRunner`, invariant 15). One budget of 120 s bounds every git call of
  a graft, killed past it with its process group (git's helpers
  included). A repository above 200 MB (GitHub's `size`, read first) is
  not grafted. Its author, committer and dates are fixed (the App's
  throwaway identity, the pass row's `created_at` — its claim by the
  ticker or by the Regrade) and its message is English (D12), so a retry
  builds the same sha; the push forces the pass's own ref, so a retry that
  read a newer snapshot is not stuck. The Git Data API (`revert.ts`'s way)
  was rejected: one content-creating REST call per missing blob, tree,
  commit and ref and repository counts against GitHub's secondary limits
  (80 a minute, 500 an hour) for a class of 100 with a replaced test
  directory, and its tree creation leaves a file-to-directory replacement
  and nested paths without a base tree unverified; a push is one call and
  git composes any tree.
- **In the `project.ci` job**, before the claim: the target, then the
  graft, then the claim records `sha` (the target, so `passTarget`, the
  regrade logic and the commit graph keep it), `graded_sha` (null: nothing
  grafted) and `distribution_sha`; then `client_payload.sha` is the graded
  commit. The queue retries nothing (`retryLimit: 0`), so the job itself
  tries a graft that fails (GitHub, git, or a failure the student's tree
  causes) three times, a few seconds apart; then — or at once for a
  repository above the size ceiling — the pass is settled `ci_unavailable`
  and audited `project_repo.grade_graft_failed` with its cause, so the
  staff see why and can Regrade; never a 24 h silence. A repository GitHub
  no longer has is settled `repo_missing` at once, as a dispatch's 404. A
  repository archived as its lock is never grafted: it stays
  `ci_unavailable` (ADR-119 §6).
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
  record), the protected list (`criteria.yml` included) must equal the
  recorded distribution commit's (the live head for such an older pass): a
  sanity check of the graft.
- **At the run's `head_sha`**, `.github/workflows/grading.yml` must be one
  the distribution **handed out**, read on the snapshot's branch (the
  project's first). Under `squash` every commit of that branch was handed
  out (the build and each sync): any version its history holds is accepted
  — GitHub's list of the commits that changed that path, its latest 100 —,
  so a student who never merged a sync runs the workflow they were handed.
  Under `whole` the branch's history is the source's, drafts never handed
  out included, and nothing records the heads that were: only the live
  head's version is accepted (ADR-119's behaviour). A link in the file's
  place never is one.
- `ci_tampered` therefore remains, in practice, for the workflow alone.
  Every other check of ADR-119 §6 is unchanged.

### 4. What the LLM pass reads (amends ADR-119 §7, ADR-106 §3; choice g)

The sources come from the tarball at the **graded commit** when the pass
built one — a pass without an automatic criterion included —, so the
model reads the teacher's current files beside the student's. A pass
whose repository could not be written (archived, no installation) or whose
graft failed reads the target as today. The tarball's `token=` redaction,
cap and top-level stripping are unchanged (invariant 15).

### 5. A Regrade redoes the machine's correction (owner; amends ADR-106 §4 and ADR-119 §6 for a v3 snapshot)

- A Regrade replaces the repository's **whole machine correction**: its
  `auto` and `llm` rows, validated ones included. A teacher's `manual` row
  and a milestone's locked row stay — the rows `supersedeProposals` already
  leaves on a reopen. No per-criterion difference is computed.
- **Only an actual new result replaces** (choice h): a validated row is
  superseded by a new result for that criterion, never at the claim. An
  `auto` row by its criterion's entry in an accepted run of that Regrade's
  pass; a criterion the accepted run's `results.json` lacks or answers
  malformed (`no_result`) keeps its validated row, the failure shown to the
  staff. An Actions outage, `no_result`, `ci_tampered` or the 24 h leave
  the previous rows as they were, the failure shown. That pass's review
  replaces an `llm` row, validated included, with the model's reply only;
  a review that fails (`llm_budget`, `grader_error`, sources unavailable)
  leaves a validated row as it was.
- *Delivered (A2):* one rule, `holdsCriterion` (`@quiz/domain`), read by
  the single writer under the repository's lock: a teacher's row and a
  locked row hold their criterion against every machine proposal; a
  validated row holds it too, unless the proposal is a Regrade pass's
  (`grade_dispatches.trigger = regrade`) and carries no failure reason. The
  failures that left a row standing are recorded on the pass
  (`grade_dispatches.kept_failures`) and shown on the staff's line (§6).
  The final pass and a milestone pass keep ADR-106's rule. Only a
  schema-3 Regrade has this power; a schema-2 Regrade keeps ADR-106 §4.
- **After the release** (owner): Regrade stays allowed, behind an explicit
  confirmation; the API refuses it for a released project unless the
  request carries the acknowledgement (`409 regrade_released`;
  `ProjectRegradeRequest.releasedAcknowledged`, on the project's route and
  a repository's). What a released grade does meanwhile (F-PROJ-14,
  F-PROJ-26): the student keeps reading the release's snapshot
  (`released_points`, `released_grade`) — their grade does not move; the
  replaced rows wait for the teacher's validation again, so the repository
  is no longer validated, its staff score falls back to its next source and
  shows "changed after release" when that source differs from the
  snapshot; a new release is refused (`409 not_validated`) until every
  repository is validated, and only that release changes the grade the
  student reads, with no new notification (`project_grade_final` goes out
  on the first release only). The confirmation says so.
- *Corrected at delivery (A2), from the code:* the student's **criteria
  table** is not a snapshot of the release. It is rendered on read from
  the current rows (ADR-106 §9, `criteriaTable`): a replaced row, proposed
  again, shows to the student as an indicative point count, without its
  rationale, until it is validated and the project released again; a row
  the Regrade did not replace stays validated. This already held for a
  teacher's correction after the release. The confirmation says this too;
  freezing the student's table at the release would be a product decision
  of its own.
- A Regrade's caps (3 a day per project, 3 per repository) are unchanged.

### 6. The staff's trace and the audit (choice i)

- The grading screen shows the staff, per repository, one line from its
  latest graded pass: the number of files the distribution's version
  replaced, and their paths. It does not tell a stale file from one the
  student changed: that needs every version the distribution ever handed
  out per file, which the truthful line "N files replaced by the
  distribution's version" does not. Nothing of it reaches a student.
- *Delivered (A2):* the paths are stored on the pass
  (`grade_dispatches.grafted_paths`, migration 0141: the count and the
  paths, capped as the audit's, 100 and 8 KiB), written with the claim;
  the screen reads the repository's latest CI pass claimed or settled, not
  the audit log. The same line names the criteria a failure left standing
  (§5). The field (`ProjectGradingRepo.pass`) is the staff's payload only;
  the student view never reads `grade_dispatches`, and its test searches
  every student response for it.
- A graft is audited `project_repo.grade_grafted` (the closed union of
  `apps/api/src/audit.ts`): the project, the pass, the graded and
  distribution shas and the paths (at most 100 and 8 KiB of them, with
  their count), never a token; a graft that could not be built,
  `project_repo.grade_graft_failed` with its cause. A1 delivers the audit;
  the staff line is A2's, which adds what it needs to read.

### 7. The sync's pull request (amends ADR-073 §4; choice j)

In a project graded by a schema-3 snapshot, its body no longer says "your
score never depends on this pull request until you merge it", false there
now for the protected files and `criteria.yml`. It says, in English:
merging brings the update into the student's copy; the protected files and
`criteria.yml` are graded in the teacher's version whether or not it is
merged; every other file is graded as the student pushed it. Any other
project keeps the old sentence, still true there. A pull request already
open keeps its body.

### 8. What does not change

The target commit and its receipts (ADR-012, ADR-064, open question 61
untouched); the restore of protected files on a branch (F-PROJ-08, the
distribution's current version); Sync's skips; the lock; a v2 snapshot's
runner path; the push runs and the `GRADE` badge.

### 9. Invariant 14 (applied with A1)

`CLAUDE.md`'s invariant 14 gains one clause: "…at a commit the server
chose from its push receipts (ADR-106 §3), or at the graded commit the
server built on it (ADR-132 §2), never uploaded by a client." Its last
sentence binds the graded run by "its nonce and a workflow version the
distribution handed out (ADR-132 §3)". The detail is §2's and §3's.

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
  fix, locked or not, merged or not, with no reopen and no hand push (a
  validated row is redone, §5).
- The student's branches, history and receipts never move for it. The
  graded commit is visible to the repository's members on its ref.
- A student who never merges a sync is graded with the teacher's current
  protected files and their own other files; an obsolete copy of a
  protected file costs them nothing.
- `ci_tampered` becomes rare; a run where the graft did not hold is still
  shown, not graded.
- One shallow git fetch-and-push per repository and pass on the API host,
  inside the 15-second pace per installation, bounded in time and by the
  repository's size.
- A Regrade after validation or release costs the teacher a new validation
  and a new release; the student's grade moves only at that release.

**Known limits.**

- A repository whose protection is suspended (F-PROJ-08's cap,
  `protection_suspended_at`) is grafted and accepted like any other, as
  under ADR-119: the acceptance reads no suspension. A gap older than this
  record, left to its own decision.
- A pass whose graft failed, or whose repository could not be written,
  is reviewed by the LLM on the target's own files; without an automatic
  criterion such a pass has no row to carry `ci_unavailable`, and only the
  audit says why.
- GitHub recomputes a repository's `size` only periodically: a large push
  just before the deadline can pass the 200 MB ceiling, and the depth-1
  fetch is then bounded by the 120 s budget only. A blobless fetch
  (`--filter=blob:none`) would close it; it needs a check on real GitHub,
  not done.

**Before production** (on staging, with the App's installation token, on
a repository under `hgc-deadline-lock`): a pass whose push to
`refs/quiz-grade-<pass id>/graded` is accepted; its run checking out the
graded sha; its review reading the graded sha's tarball; and whether a
`push` webhook arrives for that ref (§2 is safe either way).

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
