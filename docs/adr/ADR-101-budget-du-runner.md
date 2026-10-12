# ADR-101 — The runner's capacity is budgeted: a budget per request, aged grading, a cap per evaluation

## Status

Accepted (2026-10-11), security audit finding M5. Settled by the orchestrator
of the security lots on the product owner's standing authorization; the
product owner still sets the cap's value and states the VM size (Consequences).

Scope: the API's runner client, the runner's queue and case deadline, the
`grading.runner` job, the student's Run and Simulate, the teacher's Try and
preview grading.

Relations: amends [ADR-067 §5](ADR-067-correction-a-la-remise-des-exercices.md)
(the ordering of the runner's two queues) and the N-SEC-07 row of
[03](../spec/03-exigences-non-fonctionnelles.md); relies on
[ADR-001](ADR-001-monolithe-modulaire.md) (one process), on the 2026-10-08
amendment (a) of [ADR-016](ADR-016-runner-sur-vm-separee.md) (the engine VM's
size) and on [ADR-096](ADR-096-fichiers-annexes-publics.md) (`finalizeState`
travels in the job).

**Amended 2026-10-12 by [ADR-106](ADR-106-notation-des-projets-par-criteres.md)
§3** (scope: the request ceilings, for the new `project` action only). The
`project` action has its own request ceiling, `RUNNER_PROJECT_TIMEOUT_MS`
(up to 600 s), and its own separate bounded tmpfs, `RUNNER_PROJECT_WORKDIR_MB`,
both runner configuration, never a per-request override; the API's wait
budget for it is that ceiling plus 60 s. Its jobs run on the grading
priority, paced so that a pass never fills the runner's queue.

## Context

Production runs the runner with two slots (`RUNNER_CONCURRENCY=2`). The API
gave every call 30 s, its wait in the runner's queue included, and a call
past it was stored for good as a zero-point `runner_unavailable` proposal,
with no retry. The queue served interactive requests first, absolutely. So a
few students' infinite loops (fifteen cases at 2 s each, about 32 s, every
time) held both slots, every Run of the class waited, and every grading run
of an exercise timed out: the teacher was left every copy to grade by hand.
`RunnerBusy` was retried by pg-boss, but its last try failed the job and left
the cell ungraded, and the in-process queue never retries at all. The
teacher's Try route had no limit, and N-SEC-07's limit "per evaluation" did
not exist.

The runner already ends a long request cleanly: past its request ceiling the
remaining cases come back timed out. The API's 30 s abort, not the runner,
was what turned a deterministic overrun into an outage, and a retry would
only have tripled the cost of the worst answers.

## Decision

1. **A budget per request, enforced by the runner.** One formula,
   `requestBudgetMs` in `@quiz/core` (`runner.ts`): the build, each case at
   its `timeMs` plus the grace, two seconds per upload round trip, capped by
   the request ceiling and by the request's optional `budgetMs`. Its four
   defaults (`RUNNER_BUDGET_DEFAULTS`) are the runner's configuration
   defaults, written once. The runner uses it for the container's ttl (budget
   plus `RUNNER_TTL_SLACK_MS`) and for its case deadline, counted from the
   request's start: a case starts only if it can end before it, a container
   is not rebuilt past it, and the remaining cases come back timed out. The
   API sends `budgetMs` on every request: the formula for a grading request,
   capped at `RUNNER_TIMEOUT_MS` (30 s, at least 26 s so a build fits) for an
   interactive one. An overrun is a result, never a retry.
2. **The API waits the budget plus a queue allowance**: 20 s for an
   interactive request, 60 s for a grading one, plus the same slack
   (`modules/runner/http.ts`). A call that outlasts that spent its time in
   the queue, so it is `RunnerBusy`, like a 429; nothing reachable is still
   `RunnerUnavailable`.
3. **Only the queue's share is retried, and no cell is left ungraded.**
   `JobQueue.work` hands each handler `{ lastTry }` beside the data (pg-boss:
   `retryCount >= retryLimit`, read with `includeMetadata`; the in-process
   queue: always). On `RunnerBusy` before the last try the runner job
   rethrows and pg-boss retries the same job, `finalizeState` included
   (`retryLimit` 2, backoff from 5 s, unchanged). On the last try it writes a
   zero-point proposal with reason `runner_busy`, now a pass reason: the grid
   completes, `grading_ready` goes out, the progress counts it as waiting for
   the runner, and "Run grading" sends it again.
4. **Aging instead of absolute priority** (amends ADR-067 §5): in the
   runner's queue a grading request that has waited 10 s goes before the
   interactive ones. Interactive still goes first otherwise. Only the
   background grading sends `grading` requests, at most
   `GRADING_RUNNER_CONCURRENCY` in flight (one by default); a teacher's Try
   and preview grading are interactive, under the interactive ceiling and
   rate-limited. So aged requests hold at most that many slots, and 10 s plus
   one running interactive request stays inside the grading allowance.
5. **A cap per evaluation** (N-SEC-07): at most `RUNNER_RUNS_PER_EVALUATION`
   interactive runs of one evaluation in the runner at once, default 4, held
   in the API's memory beside the per-attempt one-at-a-time (ADR-001). Over
   the cap the run answers `503 runner_unavailable`, reason `busy`; the
   player reads `busy` as "try again in a moment", never as "no runner", and
   no browser runner stands in. The refused run journals nothing, so it
   spends nothing of the student's per-minute budget. No per-user cap in
   runner-seconds: the per-attempt one-at-a-time, the per-minute budget and
   this cap bound a student.
6. **The teacher's budget**: `POST /questions/:id/try` spends 10 a minute per
   teacher, every try counted (`Budget`, keyed by user, as the preview's
   gradings are), then answers 429 `rate_limited`. The wand of ADR-059
   already had a budget of its own (`LLM_CALLS_PER_MINUTE`).
7. **Deploy skew and order**: `budgetMs` is optional on the wire, both ways.
   Deploy the runner first. An older runner drops the field and applies its
   own ceiling, so during the skew a Run whose program loops forever may
   outlast the API's wait and read "busy" instead of its timed-out cases; a
   newer runner sent no budget applies the formula alone.

## Consequences

- A class's infinite loops cost each of them at most 30 s of a slot, and at
  most four of one evaluation run at once; the grading gets a slot within
  about 10 s plus one run, and a grading run's own overrun is graded from its
  timed-out cases.
- A student may wait longer before a "busy" than the former 30 s: up to the
  allowance plus the run's budget, about 55 s at worst.
- A teacher's Try or preview grading of a slow program is cut at the
  interactive ceiling like a student's Run; the grading pass gives the same
  answer its full budget.
- `runner_busy` cells appear only when the runner stayed saturated across
  three tries; "Run grading" sends them again.
- The cap and the queue live in one process's memory: a `WORKER_MODE` split
  keeps them in the web process, which serves every Run.
- **For the product owner:** the cap's value (4 of 2 slots lets one
  evaluation queue two runs behind the two running) and a statement on the
  engine VM's size: ADR-016's 2026-10-08 amendment already says a real class
  needs a resize; two slots serve one class's Run clicks, not two classes at
  once.
- Staging runs `RUNNER_MODE=stub`: none of this is observable there. The
  check is `apps/runner/scripts/smoke.py` after the production deploy.

## Alternatives considered

- **Retry a timed-out call** (the audit's first suggestion). Rejected: a
  program that loops forever times out every time, so the retry triples the
  cost of the worst answers and still ends as `runner_unavailable`.
- **Reserve a slot for the grading.** Rejected: with two slots it halves the
  students' Run capacity during every exercise, graded or not.
- **A per-user cap in runner-seconds.** Rejected: a ledger of seconds is new
  state for what the per-attempt and per-evaluation caps already bound.
- **Keep the abort in the API, with a larger timeout.** Rejected: the API
  cannot tell a long queue from a long program; only the runner can stop the
  program and still return the cases it ran.
