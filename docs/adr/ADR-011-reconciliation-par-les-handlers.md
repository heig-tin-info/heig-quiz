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
   e-mails).
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
pure rule is `reconciles` and `isQuiet` of `@quiz/domain`):

1. **The quota bound.** A repository is polled while it is live
   (provisioned, not deleted, its project not archived) and, once frozen
   for good, for **24 hours after its freeze** only — longer only while its
   final review was asked (a `deadline` row of the dispatch ledger) and no
   review run filled the slot. A reopen clears the freeze and brings the
   repository back. A finished project costs GitHub nothing after a day;
   the webhooks still reach it. `reconcile.grades` further reads only the
   repositories QUIET for 30 minutes — no push received, no run completed —
   since while the webhooks flow there is nothing to catch up. A staff
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
logged and the pass goes on. Up to a day of delay is accepted, and no staff
action nor migration is involved. The deadline's lock then uses its ruleset
instead of the archive (H8). The Decision and points 1 to 5 stand.
