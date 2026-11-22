# ADR-011 — Reconciliation reuses the idempotent webhook handlers

## Status

**Imported from heig-classroom** (2026-09-30, merge task M0-03, ADR-035),
where it is ADR-011; Quiz's 011 slot was free (only 001–010 and 012 had been
inherited), so it keeps its number. The body below is classroom's,
verbatim. Read it with the renames of the merge: *assignment* ⇒
**project**; *GradeRun* ⇒ **grade run**; classroom's ADR-003 is Quiz's
ADR-003 (the same record); the cron jobs are ported as Quiz periodic tasks
(`reconcile.grades`, `reconcile.repos`, `reconcile.deliveries`,
`docs/merge/03-github-projects.md`; they are stored as Quiz's
`scheduled_tasks`, D10 settled 2026-09-30, spec 05 §5.4, Clock) and
never call GitHub inside a ticker tick (invariant 5).
Classroom's requirement ids (GR-, GH-, NFR-, AU-) are those of
heig-classroom's specification; `docs/spec/02-exigences-fonctionnelles.md`
receives their Quiz form (M0-04), and until then they are read in
heig-classroom's `docs/`.

Status in heig-classroom: Accepted (2026-07-03, phase 3).

**Amended** (2026-10-05, merge task M3-06a, as `reconcile.grades` and
`reconcile.repos` are ported): the addendum below bounds what the two polls
read (24 hours after a repository's freeze unless a final review is pending,
the quiet rule), settles which 404 is terminal, when a reconciled head moves
the student's last commit, the daily re-invite, and the stop on a rate
limit. The Decision stands; the addendum narrows its point 3 for Quiz.

**Amended** 2026-11-19 by [ADR-070](ADR-070-repartitions-de-groupes.md)'s
second amendment of that day, scope: the addendum's point 4. The re-invite
is claimed per member on their grant (`project_repo_access.reinvited_at`),
for a group's members as for a student's own repository, and only for a
member a check found neither a collaborator nor invited; the check lists
the collaborators and the invitations once per repository.

**Amended** 2026-11-22 (product owner), scope: the Decision's point 3 (the
cadences) and the addendum of 2026-10-05's point 1 (the scope and the quiet
rule). See [the addendum of that day](#addendum-2026-11-22-the-cost-follows-activity):
`reconcile.deliveries` every 15 minutes, reading GitHub's log
incrementally, each delivery asked three times at most; `reconcile.grades`
daily, with no quiet rule, and `reconcile.ci` every 15 minutes for the CI
passes awaiting their run; an unanswered final review polled 7 days after
the freeze at most.

## Context

GitHub can lose or delay webhook deliveries; some events do not exist at all (invitation
expiry, GH-24). The specs require a catch-up: reconciliation of GradeRuns every 15 min
(GR-07), daily reconciliation of branches, invitations and missed deliveries (GH-62). After a
database restore (NFR-16), the state must resynchronize on its own. The classic risk is
writing two state-update code paths (one for webhooks, one for polling) that drift apart over
time.

## Decision

1. A structuring rule (borrowed from the robustness proposal): **every piece of state has two
   arrival paths — webhook (nominal) and reconciliation (fallback) — but a single update
   code path**. The reconciliation cron jobs build normalized events and invoke **the same
   idempotent handlers** as the webhook pipeline.
2. Handler idempotency rests on the UNIQUE constraints of the schema (ADR-003): replaying an
   event, whatever its source, never produces a duplicate.
3. The cron jobs retained: `reconcile.grades` (15 min, GR-07), `reconcile.repos` (24 h,
   branches and invitations, GH-24), `reconcile.deliveries` (24 h,
   `GET /app/hook/deliveries` with redelivery, GH-62), plus the maintenance tasks (purge,
   e-mails). *(Quiz, 2026-11-22: `reconcile.grades` daily, `reconcile.deliveries` every
   15 minutes; see that day's addendum.)*
4. A deliberate exception: the **receipt time** of a push reconciled after the fact is
   unknown — the conservative GR-14.3 rule applies (`after_deadline = true` if the deadline
   has passed), open to a teacher's arbitration.

## Consequences

- A single state code path to test and maintain; the fallback polling cannot diverge from the
  nominal path.
- **The idempotent design is also the recovery plan**: after an outage or a restore, the cron
  jobs absorb the lost window on their own, with no special procedure.
- Polling stays limited to catching up (NFR-10): in nominal operation, everything arrives
  through webhooks.

## Rejected alternatives

1. **A separate reconciliation code path**: a double implementation of the state rules, with
   guaranteed drift in the long run; that is exactly the defect this rule prevents.
2. **Generalized periodic polling** instead of webhooks: it would violate NFR-10 (rate
   limits, polling limited to catching up) and degrade the NFR-12 latency.

## Addendum (2026-10-05, merge task M3-06a): the scope and the stops of the two polls

Decided by the product owner (points 1, 3 and 4) and the orchestrator
(points 2 and 5) as `reconcile.grades` and `reconcile.repos` are ported
(`apps/api/src/modules/project/reconcile.ts`, scheduled tasks of D10; the
pure rule is `reconciles` of `@quiz/domain`; `isQuiet` until 2026-11-22):

1. **The quota bound.** A repository is polled while it is live
   (provisioned, not deleted, its project not archived) and, once frozen
   for good, for **24 hours after its freeze** only — longer only while its
   final review was asked (a `deadline` row of the dispatch ledger) and no
   review run filled the slot. A reopen clears the freeze and brings the
   repository back. A finished project costs GitHub nothing after a day;
   the webhooks still reach it. `reconcile.grades` further reads only the
   repositories QUIET for 30 minutes — no push received, no run completed —
   since while the webhooks flow there is nothing to catch up. *(2026-11-22:
   the pending review ends 7 days after the freeze, and the quiet rule is
   dropped; see that day's addendum.)* A staff
   unlock after the freeze, without a reopen, does not widen the window.
2. **The 404 rule.** Both tasks locate a repository by its immutable id
   first (`GET /repositories/{id}`); a 404 there, once the installation's
   token was obtained, is the repository gone — `markRepoDeleted(…, via:
   reconcile)`, terminal and audited once. A 404 anywhere else — a run
   listing, a branch head, an invitation — never marks one deleted: it is a
   failure of that step, logged, and the pass goes on. A name GitHub
   changed is followed through the `repository.renamed` webhook's own path
   (`followRepoRename`, point 1 of the Decision).
3. **No pusher means no head move.** The reconciliation knows no push
   sender. The default branch's head becomes the student's last commit
   only when it is a person's: not recorded in `bot_commits`, and its
   author and committer both named by GitHub and neither Quiz's App nor a
   workflow. A head GitHub attributes to nobody (the App's own commits
   carry no account), or only half (an author named, a committer not),
   never moves it. The product consequence: a student's commit whose
   author and committer e-mails are not linked to a GitHub account is
   never recovered by the reconciliation; only its push webhook (whose
   sender names the student), or a later attributed commit, moves the
   head. The reconciliation writes no push receipt (the intake's alone,
   ADR-012) and restores no protected file (the push webhook's).
4. **The daily re-invite** (F-PROJ-07) is claimed on the row
   (`project_repos.invitation_reinvited_at`, at most once a day) before
   GitHub is called, for a student's own repository whose invitation is
   pending and which is **not frozen**; the student is named by the login
   GitHub knows today for their linked account, as Accept and the staff's
   resend do. A repository not re-invited this pass has its collaborators
   looked at by the login recorded at the invitation, since GitHub sends
   no event for an invitation accepted late. A group's invitations wait
   for ADR-070's per-member follow-up.
5. **Stop on a rate limit.** Every request of a pass is made with Octokit's
   `noRateLimitWait` (`failFast`): a quota exhausted stops the pass at
   once, logged and audited (`project.reconciled`, `stoppedOnRateLimit`),
   and the next period resumes it — every step being idempotent, nothing
   is done twice. Waiting it out inside the task would outlive the 30
   minutes after which a scheduled run is taken for dead and claimed again
   (`RUNNING_STALE_MINUTES`), doubling the pass.

## Addendum (2026-10-06, merge task M3-14k): the daily pass applies a missing protection

Decided by the product owner (M3-14, finding 17) after a pilot organization
moved from GitHub Free to Team once its students had accepted: provisioning
had tolerated the plan's 403 and nothing ever applied the `hgc-protect`
ruleset afterwards. A sixth step of `reconcile.repos`, scoped to a repository
that is live, not archived (read-only), with `ruleset_id` null and its
effective deadline still ahead on the server's clock, calls the very function
provisioning uses (`protectStudentRepo`, idempotent: an existing ruleset of
that name is adopted). Success stores `ruleset_id` (a conditional write) and
audits `project_repo.protected`; a plan restriction leaves it null silently
for the next day; a rate limit stops the pass (point 5); any other failure is
logged, the repository's other steps go on, and so does the pass. Up to a day of delay is accepted, and no staff
action nor migration is involved. The deadline's lock then uses its ruleset
instead of the archive (H8). The Decision and points 1 to 5 stand.

## Addendum (2026-11-22): the cost follows activity

Decided by the product owner on a measurement of production (2026-11-22,
read-only); points 1b, 2 (the asks), 3 (the CI passes) and 6 settled with
the orchestrator's review of the change. `reconcile.grades`, every 15
minutes, read about 198 repositories quiet for 30 minutes — nearly every
repository nearly all the time — at two calls each (`GET
/repositories/{id}`, the run listing): about 38 000 calls a day, 156 s a
pass, almost always "0 runs ingested". 52 of them belonged to six projects
frozen in September and October whose final review was asked and never
came (21 never had a review run, 25 only failed ones, 6 a successful one
never taken as final): point 1's exception had no end. Meanwhile
`reconcile.deliveries`, the one detector of a lost webhook, ran daily and
read one page of GitHub's log (the latest 100 attempts), so a failure older
than that page was never seen. The cost was the number of repositories
times time; at the target scale (300 teachers, 10 labs, 30 students: some
14 000 live repositories, one organization per course) it would have grown
with that product. The cost now follows events.

1. **`reconcile.deliveries` every 15 minutes, reading GitHub's log
   incrementally** (`GET /app/hook/deliveries`, newest first, 100 a page,
   GitHub's own `cursor`). A pass reads down to the point the previous
   passes covered, less 5 minutes of overlap (GitHub's clock against the
   server's, an attempt listed after it was made), and never below the
   24-hour redelivery window; at most 20 pages and 50 redeliveries a pass,
   as before for the redeliveries. Where it stops is kept
   (`webhook_delivery_scan`, one row): having read down to that floor and
   asked all it found, the pass covered everything up to its start — or up
   to the oldest delivery whose redelivery request GitHub failed (a 5xx, a
   timeout), so the next pass asks it again. Its pages spent first, the
   next pass goes on from the page it reached, down to the same floor,
   before it reads the newer top. Its asks cut short (the cap, a rate
   limit), the next pass reads the same stretch again. A resume cursor
   GitHub no longer knows (a 4xx), or one whose stretch has left the
   window, is dropped and the top read instead, so the scan cannot stick.
   The `status=failure` filter of the endpoint is not used: it selects
   the codes 400 to 599 and so would miss an attempt with no HTTP answer
   (the intake unreachable), the very loss this task exists for. The log
   is read with the App's JWT, which spends no installation's quota;
   GitHub documents no figure for it, so every call of the pass answers a
   rate limit at once and the pass stops, keeping its place (point 5 of
   the addendum of 2026-10-05, now applied to this task too). A pass costs
   one page per 100 deliveries made since the previous one.

   1b. **What is asked, and how often** (`attemptVerdict`, `mayAskAgain`
   of `@quiz/domain`; `webhook_redelivery_asks`). Each delivery's NEWEST
   attempt in the stretch read decides. Delivered, or stored by Quiz
   meanwhile: nothing to do. No answer, a 429 or a 5xx: asked again — a
   redelivery that failed in turn included (until now a redelivery was
   never asked again; with an advancing cursor its original lies below the
   covered point by then) — at most three times, within a day of the first
   ask. Any other answer, a 4xx, is a refusal: the same bytes would be
   refused again, so the delivery is never asked for, logged once. The
   asks of one pass go OLDEST FIRST, the deliveries closest to leaving the
   window, so a delivery the intake keeps failing costs three asks and
   cannot starve a real failure behind it. The asks are purged three days
   after the first, with the payloads (`deliveries.purge`). The intake's
   body limit is GitHub's own cap on a payload, 25 MB, on that route only:
   at Fastify's 1 MB default a push over 1 MB was refused 413, its receipt
   lost for good.
2. **`reconcile.grades` daily**, a last resort: the webhooks carry the runs,
   and the 15-minute `reconcile.deliveries` asks again for those GitHub
   failed to hand over. The QUIET rule (no push nor run for 30 minutes) is
   dropped: it saved calls at a 15-minute pass, and at a daily one it would
   only skip, for another day, the few repositories active at the pass's
   minute. The pass reads the last 100 completed runs of a repository
   (GitHub's largest page, one call as before) instead of 20, a day of an
   active repository's runs.
3. **`reconcile.ci` every 15 minutes, for the CI passes only.** A schema-3
   project's CI pass (ADR-119 §6) settles `no_result` 24 hours after its
   dispatch; a lost `workflow_run` left to the daily pass would race that
   end and cost the student every automatic criterion. This task reads,
   through the same `ingestRuns`, the repositories whose pass is open and
   whose dispatch GitHub accepted more than 30 minutes ago: nothing outside
   a grading, a lost run caught within about 45 minutes. The 24-hour sweep
   itself makes no GitHub call (it runs in the ticker's tick, invariant 5),
   so it does not read the runs once more before it settles.
4. **The exception of an `auto` project's final review asked and
   unanswered ends 7 days after the freeze** (`RECONCILE_REVIEW_WAIT_MS`,
   `reconciles` of `@quiz/domain`). A schema-3 CI pass open keeps its
   repository in scope whatever the freeze's age — a Regrade opens one on a
   repository frozen long before (ADR-132), and the pass ends itself within
   a day. The rest of point 1 stands: live repositories not yet frozen, and
   24 hours after the definitive freeze. `reconcile.repos` stays daily and
   reads the same scope, so the bound applies to it as well.
5. **Existing periods.** A new default moves no `scheduled_tasks` row: the
   migration `0155_reconcile_follows_activity` moves each row only where it
   still holds its old default (`reconcile.deliveries` 1440 → 15,
   `reconcile.grades` 15 → 1440); a period an administrator set by hand
   stays. `reconcile.ci` is new: its row is inserted at boot with 15.
6. **A redelivered push's receipt carries the redelivery's arrival time**,
   not the original attempt's: the receipt is the server's receipt time
   (ADR-012), and a push the intake missed is received when GitHub delivers
   it again. Receipts are the legal reference of a deadline, so a push lost
   just before a deadline and redelivered after it reads as late. This
   change shortens that gap from up to a day to about 15 minutes; it does
   not change the rule, which is the product owner's to settle (the
   teacher's arbitration of GR-14.3 stays the remedy).

A consequence for [ADR-062](ADR-062-depot-de-distribution.md): a run's
stored `to_verify` that a late receipt left lagging is re-flagged by the
next reselection, of which `reconcile.grades` is now the daily one (a
restore or a run's webhook still reselect at once); the score never waited
for the flag. Known limits: a pass of either daily task walks its
repositories one after the other, about 0.8 s each in production; past
some 2 000 repositories in scope a pass outlives the 30 minutes after which
a running task is taken for dead (`RUNNING_STALE_MINUTES`) and claimed
again. 50 redeliveries a pass (200 an hour) recover an outage of the
intake only as fast; what they cannot reach in the 24-hour window, the
daily passes catch up through the repositories' state. A delivery waiting
out a rate limit may get a second job from the replay of stuck deliveries
(no `singletonKey`: it dedupes nothing on our `standard` queues, #273,
`jobs.ts`); the second finds the delivery processed and does nothing.

Expected calls, per day: today (about 200 repositories in scope, a few
hundred deliveries a day), `reconcile.grades` some 400 instead of 38 000,
`reconcile.deliveries` about 96 log pages plus its redeliveries,
`reconcile.ci` a few calls per graded run. At the target scale,
`reconcile.grades` and `reconcile.repos` two to five calls per repository in
scope a day, some 28 000 and up to 70 000 spread over about 300
organizations (each its own quota of 5 000 an hour); `reconcile.deliveries`
about 60 000 deliveries a day, so some 7 to 9 pages a pass, under 900 calls
a day on the App's JWT, at most 1 920 when catching up.
