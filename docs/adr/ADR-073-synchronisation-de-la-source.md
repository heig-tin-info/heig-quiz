# ADR-073 — Syncing a project's source: a lease, one pull request per branch, the handed-out sha

## Status

Accepted (2026-10-05; the per-branch pull request, "up to date" by the files
that differ, the repositories a sync skips and the deployment note settled
by the product owner in conversation; the lease, the clearing rule and the
handed-out sha by the orchestrator of the merge, validated by the spec
challenger). Implemented by merge task M3-07:
`apps/api/src/modules/project/sync.ts` (the request, the leased pass, the
two webhook handlers, the page's state) on the adapters
`apps/api/src/github/sync.ts`; migration `0070_project_sync`. Tested by
`modules/project/sync.db.test.ts` against local bare repositories.

Scope: F-PROJ-12 (amended the same day), the `project` module's sync and
its GitHub App's `pull_request` subscription.

Relations: depends on [ADR-064](ADR-064-echeance-des-projets-baux.md) (the
claims and leases of a project's GitHub work, reused as they are) and on
[ADR-062](ADR-062-depot-de-distribution.md) (the distribution repository,
which a sync updates and the restores read); completes D12
(`docs/merge/08-decisions.md`).

## Context

heig-classroom's `sync.ts` ran as one pg-boss job per assignment: it
updated the squashed repository, force-pushed `sync/<branch>` to every
live, unlocked student repository and opened or commented one pull request
per repository, keyed on `student_repos.sync_pr_number`. Its distribution
commit was titled with the SOURCE's short sha, which the students then read
in their pull request — the existence of the source is the staff's alone in
Quiz (N-SEC-20). A repository was "up to date" when GitHub's compare said
`ahead_by === 0`, which a teacher's revert-and-redo defeats. Two syncs
could run at once; a project with several handed-out branches kept one
pull request number for all of them; and "ahead" had no number, F-PROJ-12
asks for one.

## Decision

1. **The source ahead, per branch, from the sha handed out.** The build
   and each sync record the source's sha per branch
   (`projects.source_heads`, null on a project built before and on
   heig-classroom's imported rows, which then show "ahead" with no number).
   A push to a handed-out branch of a SOURCE repository marks every
   non-archived project of that source — drafts included, so Publish never
   hands out a stale distribution — with the push's sha and the server's
   receipt (`source_ahead_sha`, `source_pushed_at`) and the commits the
   branch holds past its handed-out sha (`source_ahead`, GitHub's compare,
   in the background; null when it cannot tell). A push whose head already
   is the handed-out sha marks nothing. The source repository needs no push
   receipt.
2. **The request updates the distribution; a leased job does the rest.**
   `POST /app/api/projects/:pid/sync` takes the project's `sync_job_at`
   lease (ADR-064 §3's claim, renewal, backdating and release, a third
   column beside the deadline's and the dispatches'; held: `409
   sync_in_progress`), updates the distribution repository in the request —
   seconds, on the asynchronous git runner, as the build does — so that a
   rewritten source under the `whole` strategy is refused there and then
   (`409 source_rewritten`, audited `project.sync_failed`, nothing changed,
   the lease given back), records the handed-out shas, audits
   `project.sync_requested` and sends ONE `project.sync` job (202). A draft
   syncs its distribution and nothing else; an archived project nothing
   (`409 project_archived`). Never refused for a source that is not ahead:
   a retry reaches the repositories that failed. The ticker never claims
   this lease: a sync is the staff's act.
3. **The pass**, in `runLeased`'s frame: every student repository, four at
   a time, re-read just before its push and **skipped** when it is not live,
   past its EFFECTIVE deadline — locked or not — or locked
   (`syncSkipReason`, `@quiz/domain`). The distribution's head is recorded
   in `bot_commits(sync)` BEFORE `sync/<branch>` is forced to it (the one
   ref the App ever forces; left where it is when already there, so a retry
   pushes nothing again). **Up to date** is GitHub's compare of
   `<branch>...sync/<branch>` listing **no file**, not `ahead_by === 0`: a
   repository up to date gets no pull request.
4. **One pull request per handed-out branch**, never two
   (`project_sync_prs(repo_id, branch, pr_number, state, updated_at)`,
   replacing `sync_pr_number`/`sync_pr_state`, which the migration copies
   into the default branch's row): the stored one is reused while GitHub
   says it is open, else the open one from `sync/<branch>` is found by its
   head, else one is opened; an open one is commented on when the update
   moved its head. The App's `pull_request` events keep each row's state
   (`open`, `merged`, `closed`), accepted only for a pull request the App
   authored from `sync/<branch>`; a replay about an older pull request than
   the row's changes nothing. The row's default branch is what the page
   shows.
5. **What the students receive never names the source** (N-SEC-20): the
   distribution's commit message carries no sha, and the pull request's
   title and comments carry the DISTRIBUTION's. Every text written into
   GitHub is English (D12).
6. **The outcome per repository is stored** (`project_repos.sync_outcome`,
   `sync_outcome_at`: opened, updated, up to date, failed, skipped) and the
   page shows the counts of the repositories' last outcomes; the pass is
   audited `project.synced` with the counts and the failed repositories'
   names. A failure is recorded, the pass goes on, and the frame backdates
   the lease (a retry some 30 s on). **`source_ahead_sha` is cleared only
   when no repository failed and it still is one of the shas the pass
   synced** — a push landing meanwhile keeps the source ahead.
7. **Protected files** need nothing more: a restore puts back the
   distribution's CURRENT version (ADR-062 addendum), so after a sync it
   restores the new one and leaves out a file already the distribution's;
   asserted by one test.

## Consequences

- The production App must subscribe to `pull_request` (M2-06 listed
  `workflow_run`, `member`, `repository`); without it the pull requests'
  state stays `open` until the next sync reads them.
- A project with several handed-out branches gets one pull request per
  branch per repository; the row shows the default branch's.
- A teacher who syncs twice without a new push spends one compare per
  repository and no push, comment or pull request.
- F-PROJ-20's import maps heig-classroom's `sync_pr_number` to the default
  branch's row and `source_heads` to null.

## Alternatives considered

- **The whole sync in the job** (heig-classroom): a rewritten source under
  `whole` would fail silently in the background; the request is the place
  to refuse it, and the distribution update takes the seconds a build does.
- **Clearing `source_ahead_sha` at the request**: a push during the pass,
  or a repository that failed, would then hide that the source is ahead.
- **One pull request per repository** for every branch (heig-classroom):
  a branch's update cannot be merged onto another branch.
- **`ahead_by === 0` as "up to date"**: a teacher's change and its revert
  would send an empty pull request to every student.
- **A second queue policy or a singleton**: ADR-064 rejected them already
  (#273); the lease is the one mechanism.
