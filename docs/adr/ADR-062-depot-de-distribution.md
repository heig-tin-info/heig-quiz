# ADR-062 — Building a project's distribution repository, and never deleting on GitHub

## Status

Accepted (2026-10-02, settled by the product owner in conversation; the
asynchronous git runner by the orchestrator of the merge). Implemented by
merge task M3-02: `createProject` (`apps/api/src/modules/project/lifecycle.ts`),
the adapter `createSquashedRepo` (`apps/api/src/github/squash.ts`) and the
git runner (`apps/api/src/github/git.ts`). Tested by
`modules/project/lifecycle.db.test.ts` against local bare repositories.
Completes ADR-035 (the merge), D19 (`docs/merge/08-decisions.md`) and
F-PROJ-02, F-PROJ-16.

**Addendum (2026-10-02, product owner; merge task M3-04): the distribution
repository is also the reference of the protected files.** F-PROJ-08 is
amended to match:

1. A restore puts back the distribution repository's **current** version
   of each protected file on the pushed branch, as heig-classroom's
   `revert.ts` did — not "the last commit the App pushed there", which
   Quiz never recorded per file. A teacher who fixes `grading.yml` in the
   distribution (a sync, M3-07) has the fix restored from then on.
2. **Every push but Quiz's App's is checked**, a workflow's own commit
   included: a `github-actions[bot]` push is recorded as a `grader` bot
   commit (its runs never count, N-SEC-21) and its protected files are
   restored like a student's, so a student's workflow cannot rewrite
   `grading.yml` on their behalf. Only the App's pushes (restores, deadline
   commits, syncs) are exempt; the bot logins are these two only
   (heig-classroom's App stops acting on a repository once it is imported,
   M8).
3. **The cap suspends until the staff re-enable.** Past five restores in an
   hour on one repository (the server's clock), `project_repos.protection_suspended_at`
   is set, audited `project_repo.revert_cap`, and nothing is restored until
   the staff clear it (M3-08); every run ingested meanwhile is
   `project_grade_runs.to_verify`. A push is answered once, by its head
   (`reverts.head_sha`, unique per repository, migration `0057`), so a
   redelivery neither restores nor counts twice; a restore leaves out a file
   already the distribution's, so a retry after a crash commits nothing.
   The restore — its bot commit and its `reverts` row — is recorded before
   the branch moves onto it (N-RES-08), under the repository row's lock
   where the cap is counted, so two pushes cannot both pass it and a crash
   after the move loses neither; GitHub refusing the move (a 422 race)
   takes the row back.
4. Which files a push touched: the payload's lists, or GitHub's compare when
   they cannot tell (a forced push, or the 20 commits GitHub lists at most);
   a new branch counts every protected file as touched.
5. **A run on a restored head never counts** (orchestrator, review of
   M3-04): the commit the student pushed ran their own copy of the protected
   files — a tampered `grading.yml` reports what it likes. Its runs are kept
   in the history, `to_verify`, and `selectScoreRun` (`@quiz/domain`) skips
   every head the restore covered, whichever came first, the run or the
   restore (the restore re-flags the runs already stored and reselects):
   the tampering push's head (`reverts.head_sha`), the head the restore was
   built on (`reverts.covered_sha`), and every head received on that branch
   between the tampering push's receipt and the restore
   (`reverts.created_at`), read from `push_receipts` — S, S1, S2 pushed
   before S's delivery is handled all ran the altered workflow. No GitHub
   read. `covered_sha` stays beside the window because the covered head's
   own receipt may arrive after the restore. A push on top of the restore
   counts again.
   Defence in depth: a head received as a bot's push (`push_receipts.is_bot`)
   never counts either, even with no `bot_commits` row.

## Context

Creating a project builds its **distribution repository** in the
classroom's organization (F-PROJ-02): `<slug>-squashed`, one commit per
handed-out branch after the hand-out overlay (`squash`), or the branches
with their history (`whole`). Every student repository is later pushed from
it.

heig-classroom built the repository FIRST, then inserted the assignment's
row. When the insert lost the race on the unique slug, it deleted the
repository it had just built; deleting a draft deleted its distribution
repository too. A deletion on GitHub cannot be undone, and the App's right
to delete repositories is the one right a teacher's organization has the
most reason to refuse it: D19 settled that Quiz deletes rows, never a
repository, and the product owner extended it on 2026-10-02 to Quiz's own
leftovers.

The build takes seconds (a clone and a push per branch) and ran with
`execFileSync`, which stops the whole process: the live clock of an exam,
the SSE and every other request wait for it.

## Decision

1. **The row first, the claim before the push.** The draft is inserted
   before anything is built, with `distribution_*` null: the UNIQUE
   (classroom, slug) decides the slug (`-2` … `-20`, `409 duplicate_slug`
   beyond), so two creations racing never take the same one and nothing
   built has to be undone. The repository is then created or adopted, and
   the row CLAIMS it — writes its id under a partial UNIQUE on
   `projects.distribution_repo_id` (migration `0056`) — before anything is
   pushed to it: two creations racing for one empty leftover, in two
   classrooms of one organization, never both push into it; the loser steps
   to the next name. Then the repository is built, and only then does the
   row get the repository's name (`distribution_full_name`), the mark of a
   BUILT distribution.
2. **Never delete on GitHub.** Not a student's repository, not a
   distribution repository, not a repository the App created a second ago.
   A failed build deletes the ROW only and answers `502
   distribution_failed`; the teacher retries.
3. **An empty leftover is adopted.** A name GitHub refuses (422) is looked
   at: an EMPTY and PRIVATE repository no project holds is what a failed
   build leaves, and the next attempt builds into it. Anything else is
   someone's — another classroom's project of the same slug, a year
   earlier, in the same organization; a public repository, which a
   distribution never is (F-PROJ-02); one an interrupted build still
   claims — and the name steps to `-squashed-2` … `-squashed-20`.
   Conversely a distribution repository is never a source: one named
   `…-squashed[-N]` or held by a project is refused (`source_not_found`).
4. **Asynchronous git.** The git runner uses `execFile`; the request still
   waits for the build, the event loop does not. The token still reaches git
   through the environment of the one process only (invariant 15). The
   remotes have one seam (`setRemoteBaseForTests`), so the tests push to
   local bare repositories.
5. **A draft whose distribution is not built** — its name not written — is
   listed and may be deleted, but not published (`409 distribution_missing`),
   by hand or by the ticker: it is being built, or its build was
   interrupted. So a failed build only ever deletes an unpublished draft (the
   deletion says so in its condition), and nothing hands out a half-built
   repository.

## Consequences

- An organization may hold repositories nobody uses: a failed build's empty
  leftover until the next attempt adopts it, a deleted project's
  distribution repository, a deleted classroom's student repositories. They
  are the organization's to keep or delete (N-DATA-03); the deletion's
  confirmation says so (F-PROJ-16).
- A course run year after year in one organization takes the next suffix
  each time a project keeps its name: twenty names, against heig-classroom's
  five.
- The source, its branches and the source strategy are fixed at creation
  (F-PROJ-03 as amended): a different source is a new project, never a
  rebuild of a published one's repository.
- Deleting a project, its classroom or its course purges the push receipts
  of its repositories (`purgeProjectReceipts`, the `github` module's) in the
  deletion's transaction, and calls nothing on GitHub.

## Alternatives considered

- **Build first, insert second** (heig-classroom). The race on the slug is
  then lost after the build, and either the repository is deleted (refused
  here) or left behind non-empty under a name the next attempt cannot adopt.
- **A random suffix on a collision.** Every retry of a failed build would
  leave a new repository behind; a deterministic name is adopted instead.
- **Building in a job.** The teacher would get a draft that is not ready
  and a second state to follow; the build is seconds, and with an
  asynchronous runner the request can wait for it without stopping anyone.
- **Claiming after the build** (the first version of this decision). Two
  creations adopting one empty leftover both pushed into it before either
  wrote the row.
