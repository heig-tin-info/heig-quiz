# ADR-064 — A project's deadline: claims, leases and per-repository markers

## Status

Accepted (2026-10-02; the per-repository deadline, the best-effort commit,
the archive rule and the reopen's un-archiving settled by the product owner
in conversation, the claims and leases by the orchestrator of the merge).
Implemented by merge task M3-05a: `apps/api/src/modules/project/deadline.ts`
(the rules, the reopen, a repository's own deadline, the staff's lock) and
`modules/project/jobs.ts` (the ticker's claims, the `project.deadline`
job); migration `0059_project_deadline`. Tested by
`modules/project/deadline.db.test.ts`. Completes ADR-006 (as its merge
addendum carries it to projects), ADR-012 and D13 (amended the same day,
`docs/merge/08-decisions.md`).

## Context

heig-classroom applied a deadline with a `deadline.apply` job per due
assignment, sent by its ticker as a pg-boss **singleton**, which re-read
`locked_at` and `bot_commits` per repository. In Quiz a `singletonKey`
without `singletonSeconds` dedupes nothing on a `standard` queue, and the
in-process queue of development did not dedupe the same way (#273): a
dedupe that holds in one of the two is worse than none. Quiz's ticker
also runs every second for the live evaluations; nothing in a tick may wait
for GitHub (invariant 5).

Three more facts shape the port. A deadline is no longer the project's
alone: the staff may give one repository its own (D13 amended). A job may
crash, or exhaust its retries, halfway through a hundred repositories, and
must be resumable without doing anything twice (N-RES-08). And a deadline
may move while its job runs: a reopen, an extension, a staff's unlock must
win over a pass already under way.

## Decision

1. **Everything is per repository, on its effective deadline**
   (`coalesce(project_repos.deadline_at, projects.deadline_at)`, and
   `effectiveDeadline` of `@quiz/domain`): `deadline_applied_at` (the
   provisional freeze written, audited `project_repo.deadline_applied`),
   `frozen_at` (definitive at the effective deadline + the grace, audited
   `project_repo.frozen`), `deadline_committed_at` (strategy `commit`).
   The project keeps only its own `deadline_applied_at`, for its state
   (`locked` at its deadline); its `frozen_at` is dropped (migration
   `0059`), the freeze being a repository's. A repository takes deadline
   work when it is provisioned, not deleted, and its project is not
   archived (`LIVE` and its twin `isLive`; #476).
2. **The ticker claims, the job acts.** The task `project.deadlines` (every
   20 s) runs conditional writes on the server's clock: publish the
   scheduled drafts (through `publishProject`, whose refusals keep an
   incomplete group project a draft), lock the projects due, write each
   repository's provisional and definitive freeze — all database-only, so
   they happen in the tick itself — and, **with a queue only**, take the
   **lease** of each project with GitHub work left and send its job.
   Without a queue the tick claims nothing: a job never runs in the
   ticker's process; a staff action then runs it in its request.
3. **A lease, not a singleton.** `projects.deadline_job_at` is taken by one
   `UPDATE … WHERE deadline_job_at IS NULL OR deadline_job_at < now − 10 min
   … RETURNING`, and the job carries it: a job whose lease is no longer the
   row's does nothing. The job **renews** it after each repository it
   settles (`UPDATE … WHERE deadline_job_at = <held>`), so a slow job is
   never taken over while it works, and stops as soon as a renewal finds
   the row holding another lease. It gives the lease back when every
   repository is settled. A failure **backdates** it (still conditional on
   holding it) to `now − 10 min + 30 s`, so the next tick claims the work
   again some 30 s on — inside N-PERF-07's five minutes; a crash keeps it
   until it expires, ten minutes after its last renewal. The queue does
   not retry the job (a retry would carry a stale lease). A staff action (a reopen, an extension, a lock) asks for the
   same lease; when a job holds it, the next claim does the work.
4. **Desired state against recorded fact.** What GitHub should hold is the
   staff's hand (`staff_lock`, true or false) or else the deadline's lock
   (`deadline_applied_at` set, strategy `lock`) — `deadlineWantsLock` of
   `@quiz/domain`, `WANTS_LOCK` its SQL twin for the scans; what it holds
   is `locked_at` (and `archived_at`), written after each call as the fact
   it is, never conditioned on the desire. Work is any difference, or a
   deadline commit due. The job re-reads a repository's row before each
   step, so a reopen or an unlock landing while GitHub was locking is
   simply the next step: the lock just made is lifted.
5. **Recorded before the move.** A deadline commit is written to
   `bot_commits(deadline)` before its ref moves, like the restore's
   (ADR-062 addendum); a branch whose head already is the deadline's commit
   gets none again.
6. **A 404 is terminal** (`markRepoDeleted`, `via: deadline`). The archive
   stands for the lock only where rulesets cannot exist — a repository
   provisioned without its protection ruleset, or GitHub refusing one for
   the plan — never on a 5xx or a rate limit; it is audited once per
   repository (`project_repo.archived`) and counted as a lock in the
   job's `project.deadline_enforced`.
7. **Moving a deadline** requalifies the runs of the repositories it moves
   (`receivedLate`, the ingestion's rule) and reselects the score of those
   whose runs flipped or that reopened (`reopens` of `@quiz/domain`: applied
   and now ahead) — their markers, their frozen and review slots, their
   `deadline` dispatches and the staff's hand cleared — in the moving
   transaction; the locks are lifted by the next job, never a hundred
   GitHub calls inside the request. A run being ingested reads both
   deadlines under a share lock, so a deadline moving at the same time
   either comes first or requalifies it.

## Consequences

- No queue policy is relied upon: pg-boss and the in-process queue behave
  alike, and two jobs never settle one project at once.
- A crashed pass resumes on its own within ten minutes and repeats nothing.
- The staff's unlock after the deadline is never undone by a resumed pass,
  until the repository's deadline moves (F-PROJ-09).
- The tick stays database-only, with or without a queue; a test asserts
  that it makes no request.
- Without a queue (`JOBS_DISABLED=1`), GitHub follows a deadline only when
  a staff action asks for the work.

## Rejected alternatives

1. **One job per repository** (heig-classroom's ADR-006 point 2): a
   hundred jobs per deadline for one lease each, and no single place to
   bound the concurrency GitHub's secondary limits ask for.
2. **Conditional marks only** (record `locked_at` only if the lock is still
   wanted): a reopen between the call and the mark leaves GitHub locked and
   the row saying otherwise, which nothing would ever repair.
3. **The reopen unlocking inside the PATCH** (heig-classroom): a hundred
   calls in a request, and a failed unlock swallowed.
4. **A lease without renewal**: a job longer than the lease would be
   overlapped by a second one.

## Addendum (2026-10-02, merge task M3-05b): the review dispatches

The final review and the review checkpoints take the same shape, decided
by the product owner (points 2 to 5) and the orchestrator (points 1, 6 and
the review round's tightening of 2, 4 and 6):

1. **A lease of their own, one frame.** `projects.dispatch_job_at`
   (migration `0060`), taken, renewed, backdated and given back exactly as
   `deadline_job_at`; both jobs run in ONE frame, `runLeased` of
   `modules/project/lease.ts` (the lease compared, the installation's
   client, the repositories four at a time with a renewal after each, a
   lost lease → stop, a failure → backdated lease and throw, else
   released). The ticker claims the dispatch lease, WITH A QUEUE ONLY, for
   each project with a final review or a checkpoint due, and sends one
   `project.dispatch` job (`retryLimit: 0`); nothing in a tick calls
   GitHub, and without a queue no review is ever dispatched.
2. **At most once.** Each repository's dispatch is claimed in the
   `grade_dispatches` ledger (`ON CONFLICT DO NOTHING`, the sha it sends
   recorded) in a transaction that re-reads the repository under its row
   lock — a reopen landing meanwhile wins, and forgets the repository's
   `deadline` rows. A ledger row is NEVER sent again: one left without
   `dispatched_at` — a crash between the claim and the call, a request that
   got no response, or a **5xx**, which GitHub may have acted on — is "not
   confirmed" for the staff (M3-08). Only a **4xx** gives the claim back
   for the next pass (the lease backdated); a 404 marks the repository
   deleted. Octokit's retries are turned off for this one call.
   heig-classroom retried an unconfirmed row (at least once): a review
   costs the organization an LLM call and may overwrite the slot, so a
   duplicate is worse than a missing one, which the staff see.
3. **Per repository, at its definitive freeze**, at the frozen run's
   commit with the repository's EFFECTIVE deadline in the payload; never
   for a project graded `none`, a repository without a frozen run, one
   archived as its lock (H8; never un-archived for a review) nor one whose
   protection is suspended (F-PROJ-08; its teacher's score settles it) —
   both audited `project_repo.review_skipped` with their `reason`, by the
   ticker at the freeze or by the deadline job archiving a repository
   already frozen. `projects.review_dispatched_at` is dropped: the ledger
   says it.
4. **Only Quiz's final review counts**: the review slot takes a `review`
   run only when its `triggering_actor` is Quiz's App (none: a person's,
   failing closed), it is not `to_verify`, and it STARTED
   (`run_started_at`) at or after the repository's `frozen_at` and after
   its `deadline` ledger row was claimed — so neither a checkpoint's run
   nor one from before a reopen, delivered late, is taken for it. The
   `workflow_run` event does not carry the dispatch's `client_payload`:
   a checkpoint's run started after the final review was asked would
   still pass. (5) leaves that only to a GitHub delay longer than the
   gap from the checkpoint to the deadline, plus the grace, plus one
   tick — an Actions incident, not a student's doing. The slot also
   compares GitHub's clock (`run_started_at`) with ours (`frozen_at`, the
   ledger's `created_at`): a clock of ours running ahead of GitHub's by
   more than the dispatch's round trip would leave a real final review as
   a trace (negligible under NTP, visible as "no review" to the staff).
   The rules of this point and of the at-most-once 5xx case were decided
   by the orchestrator during the review of M3-05b (2026-10-02), within
   the product owner's choices: only Quiz's review counts, never twice,
   and a review on a tampered workflow (protection suspended) counts
   for nothing.
5. **Checkpoints** fire at their date while they lie before the project's
   deadline (else void: never, but deletable; `checkpointFires` and
   `checkpointRefusal` of `@quiz/domain`, their SQL twin only in the
   claim), to every live repository whose effective deadline has not
   come (`CHECKPOINT_TARGET`), on the last receipt before the date that no
   bot pushed; a checkpoint is marked dispatched once a pass met no
   refusal. A repository already at its deadline (even in its grace) gets
   none. Deleting one is refused once any ledger row names it; the
   deletion and the claim are ordered by the checkpoint's row lock.
