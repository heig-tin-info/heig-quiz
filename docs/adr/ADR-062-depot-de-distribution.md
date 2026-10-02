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
   to the next name. Then the repository is built.
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
5. **A draft without its repository** is listed and may be deleted, but not
   published (`409 distribution_missing`): it is being built, or its build
   was interrupted (the process stopped between the two writes).

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
