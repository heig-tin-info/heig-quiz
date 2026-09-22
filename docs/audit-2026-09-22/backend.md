# Backend audit — `apps/api/src/**` (excluding `db/`) + `scripts/smoke.sh`

Audited on 2026-09-22 against `CLAUDE.md` (invariants 1–9) and
`docs/spec/05-architecture.md`. Every finding below was read in the source,
not inferred from the metrics file.

> Note: another session was editing `modules/realtime/routes.ts` and
> `modules/live/routes.ts` while this audit ran (a new `lobby:` watch
> subject). Every finding was re-verified against the current files at the
> end; line numbers in those two files may be off by a few.

---

## 1. Overview, in numbers

| Measure | Value |
|---|---|
| Non-test source files in scope (`apps/api/src`, minus `db/`, `test/`) | 60 |
| Non-test source LOC in scope | 18 259 (of which `seed/` + `seed.ts` = 1 295) |
| Test files (`*.test.ts`, `*.db.test.ts`) | 29 |
| Test LOC | 8 953 (+ 742 LOC of helpers in `src/test/`) |
| HTTP route declarations (`app.get/post/put/patch/delete`) | **134** |
| Distinct route paths | 78 |
| Functions with CC > 10 (whole backend, per `cc.md`) | **21**; max CC 21 |
| Functions > 80 lines | 8 (excluding the plugin closures) |
| Direct `app.db.<select/insert/update/delete>` calls **inside `routes.ts`** | 70 (18 of them in `courses.ts`, which has no `service.ts` at all) |

### Module sizes

| Module | src LOC | test LOC | routes | Shape |
|---|---|---|---|---|
| `pool` | 3 513 | 2 154 | 33 | `routes.ts` 1 251, `service.ts` 1 912, + `config.ts`, `assets.ts`, `events.ts` |
| `live` | 2 968 | 2 362 | 17 | `service.ts` **2 104**, `routes.ts` 548, `studentView.ts`, `events.ts`, `jobs.ts` |
| `grading` | 1 521 | 692 | 10 | `service.ts` 625, `jobs.ts` 487, `routes.ts` 353, `events.ts` |
| `evaluation` | 1 390 | 300 | 13 | `service.ts` 988, `routes.ts` 373, `events.ts` |
| `poll` | 1 215 | 408 | 11 | `service.ts` 726, `routes.ts` 446, `events.ts` |
| `results` | 945 | 851 | 8 | `service.ts` 659, `routes.ts` 188, `csv.ts` |
| `realtime` | 888 | 474 | 2 | `routes.ts` 394, `bus.ts` 277, `presence.ts`, `coalesce.ts` |
| `org` | 284 | 231 | 4 | `routes.ts` + `service.ts` — but **most of `org` lives outside it** |
| `notifications` | 203 | 189 | 3 | clean |
| `runner` | 228 | 243 | 0 | clean |
| loose files in `modules/` | `courses.ts` 579, `guards.ts` 515, `roster.ts` 261, `admin.ts` 111, `avatar.ts` 95, `student.ts` 55 | | 23 | not module directories |

### CC > 10 in the backend (from `cc.md`, all verified by reading)

| CC | lines | function | location |
|---|---|---|---|
| 21 | 98 | `gradingQueue` | `modules/grading/service.ts:350` |
| 20 | 33 | `distributionOf` | `modules/results/service.ts:385` |
| 19 | 143 | `runEvaluationGrading` | `modules/grading/jobs.ts:110` |
| 19 | 35 | `(cases.map)` in `runVisibleCases` | `modules/live/service.ts:1263` |
| 18 | 36 | `patchEvaluation` | `modules/evaluation/service.ts:639` |
| 18 | 104 | `runRunnerGrading` | `modules/grading/jobs.ts:368` |
| 18 | 137 | `POST /questions/move` | `modules/pool/routes.ts:851` |
| 16 | 48 | `POST /pools/:id/assets` | `modules/pool/routes.ts:1058` |
| 15 | — | `loadConfig` env validation | `config.ts` |
| 15 | — | SSE `handler` | `modules/realtime/routes.ts` |
| 15 | — | `seedDemo` inner | `seed/demo.ts` |
| 14 | — | `sniffImage` | `modules/pool/assets.ts` |
| 12 | — | `GET /courses` | `modules/courses.ts` |
| … | | (the remaining 8 sit between 11 and 12 and are not worth touching) | |

Plus four plugin closures that are long but have CC 1–2 because they are just
a list of route registrations: `poolPlugin` (1 098 lines), `coursesPlugin`
(522), `livePlugin` (485), `pollPlugin` (379), `evaluationPlugin` (307),
`gradingPlugin` (292). Their length is boilerplate, not branching — which is
exactly what findings B-01…B-05 attack.

**Headline**: the backend is in good shape on correctness and on dead code
(only 3 exported symbols are referenced nowhere). Its debt is **repetition in
the HTTP layer** — ~600 LOC of mechanical route preamble, error mapping and
audit calls — plus a `live/service.ts` that has grown into three files' worth
of responsibilities and a missing `org` service layer.

---

## 2. Findings, ranked by (LOC saved × confidence) / risk

### B-01 — Twenty-one inline `audit()` blocks in `pool/routes.ts` and fifteen in `courses.ts`
**Principle**: DRY · **LOC delta**: **−190** · **Risk**: low

`live`, `grading`, `evaluation`, `results` and `poll` each define a `trace()`
closure that fills the constant fields of an audit entry:

```ts
// apps/api/src/modules/results/routes.ts:45
const trace = (req: FastifyRequest, action: AuditAction, id: string, payload?: unknown) =>
  audit(app.db, { actorUserId: req.user!.id, actorType: "user", action,
                  subjectType: "evaluation", subjectId: id,
                  ...(payload === undefined ? {} : { payload }) });
```

`pool/routes.ts` and `courses.ts` do not, and spell the whole record out at
every call site. Measured with `awk '/await audit\(app.db, \{/,/\}\);/'`:
**173 lines** in `pool/routes.ts` (21 blocks) and **119 lines** in
`courses.ts` (15 blocks), e.g.

```ts
// apps/api/src/modules/pool/routes.ts:541-548
await audit(app.db, {
  actorUserId: req.user!.id,
  actorType: "user",
  action: "question.create",
  subjectType: "question",
  subjectId: id,
  payload: { poolId: pool.id, type: body.data.type, internalName: body.data.internalName },
});
```
against, for the same thing, one line in `live/routes.ts:167`:
```ts
await trace(req, "attempt.staff_reset", "evaluation", scope.evaluation.id, { attemptId: result.attemptId });
```

**Refactoring**: export one factory from `audit.ts` —
`export const tracer = (app: FastifyInstance) => (req, action, subjectType, subjectId, payload?) => audit(app.db, {...})`
— and delete the five per-module copies as well. Pure call-site rewrite, the
rows written are byte-identical.

**Constraint**: invariant 9 — `AuditAction` must stay the closed union and
must stay the parameter type, so a typo is still a compile error. Do not make
`action` a `string`.

**Tests covering it**: `modules/pool/routes.db.test.ts`,
`modules/pool/move.db.test.ts`, `modules/roster.db.test.ts`,
`modules/org/org.db.test.ts`, `modules/live/routes.db.test.ts`.

---

### B-02 — The same nine-line route preamble, 60 times
**Principle**: DRY · **LOC delta**: **−180** (live −85, evaluation −50, grading −30, results −15) · **Risk**: medium

Every guarded handler repeats the identical sequence. `live/routes.ts` alone
has it 9 times for students and 5 times for staff:

```ts
// apps/api/src/modules/live/routes.ts:197-218 (PUT answer) — and 8 near-clones
const now = app.clock.now();
const params = AnswerParam.safeParse(req.params);
if (!params.success) return reply.code(404).send({ error: "not_found" });
const body = AutosaveRequest.safeParse(req.body);
if (!body.success) return invalid(reply, body.error);
const scope = await ownAttempt(app, req, reply, params.data.id);
if (!scope) return reply;
try { … } catch (error) { return failure(reply, error, now); }
```

Counts: `if (!scope) return reply;` appears **60** times across the six route
files (live 16, pool 14, evaluation 13, grading 9, results 7, org 1);
`if (!params.success) return reply.code(404)…` appears **33** times;
`if (!body.success) return invalid(reply, body.error)` appears **17** times in
`pool/routes.ts` alone.

**Refactoring**, behaviour-preserving, one wrapper per audience:

```ts
// modules/live/routes.ts
const student = <P extends z.ZodType, B extends z.ZodType>(
  method: "get"|"post"|"put", path: string, schemas: { params: P; body?: B },
  run: (ctx: { req; reply; now: Date; scope: AttemptScope; params; body }) => Promise<unknown>,
) => app[method](path, { preHandler: requireSession }, async (req, reply) => { … });
```

The wrapper does exactly what the nine lines do, in the same order (404 on a
bad param **before** touching the database, `invalid()` on a bad body, guard
loading, `failure(reply, error, now)` around the body). Nothing about the
status codes or their order changes.

**Constraints**: invariant 6 — the guard must stay a *loader* that returns
`null` and replies 404 itself; the wrapper must not turn a 404 into a 403.
Invariant 7 — the body schema must still come from `packages/contracts` and be
a parameter of the wrapper, so a route change still breaks compilation.
Invariant 5 — `now` must still come from `app.clock.now()` once per request,
taken by the wrapper and handed to the handler.

**Tests**: `modules/live/routes.db.test.ts` (475 LOC),
`modules/live/staffAttempt.db.test.ts`, `modules/pool/routes.db.test.ts`
(1 014 LOC), `modules/results/routes.db.test.ts`,
`modules/grading/grading.db.test.ts`. These cover the status codes route by
route, which is what makes the wrapper safe to land.

---

### B-03 — `invalid()`, `emptyBody()` and `notFound()` copy-pasted across six modules
**Principle**: DRY · **LOC delta**: **−50** · **Risk**: low

`function invalid(reply, error: z.ZodError)` is defined **six** times, with an
identical body in five of them:

- `modules/live/routes.ts:49-58`
- `modules/poll/routes.ts:52-61`
- `modules/grading/routes.ts:42-51`
- `modules/evaluation/routes.ts:47-56`
- `modules/results/routes.ts:29-38`
- `modules/pool/routes.ts:92-94` (the sixth reuses `issuesOf()` from
  `pool/config.ts` — which produces *the same shape*: `{path, code, message}`)

```ts
// five identical copies
return reply.code(400).send({
  error: "validation",
  details: error.issues.map((i) => ({ path: i.path.map(String), code: i.code, message: i.message })),
});
```

`const emptyBody = (body: unknown) => (body === undefined || body === null ? {} : body);`
is defined **six** times (live:47, grading:40, poll:50, pool:90,
evaluation:45, results:27). `notFound(reply)` exists twice
(`poll/routes.ts:63`, `guards.ts:181`).

Separately, four route files write `{ error: "validation", issues: … }`
(`courses.ts:126,160,286,327,496`, `org/routes.ts:79`) and two write bare
`{ error: "validation" }` (`realtime/routes.ts:256`,
`notifications/routes.ts:27`) — **three different 400 body shapes for the same
failure**, which the client has to tolerate.

**Refactoring**: one `modules/http.ts` (or extend `audit.ts`'s role into a
small `routeKit.ts`) exporting `invalid`, `emptyBody`, `notFound` built on
`issuesOf()` from `pool/config.ts` (move `issuesOf` to `packages/contracts`,
where `ZodIssueLite` already lives). Align `courses.ts`/`org` on the
`details` shape in the same commit — that one *is* a wire change, so it needs
a matching look at `apps/web` error rendering.

**Constraint**: invariant 7 — the schemas stay in `contracts`; only the error
*rendering* is shared.

**Tests**: `modules/pool/routes.db.test.ts` asserts 400 bodies;
`app.test.ts` asserts the generic 500 shape.

---

### B-04 — `attemptView` and `previewView` are the same function twice
**Principle**: DRY · **LOC delta**: **−40** · **Risk**: low

`modules/live/service.ts:587-625` and `:627-660`. The whole `evaluation:`
block is byte-identical in both (10 lines), and so is the
settings→items→`attemptItems` pipeline; the only differences are the seed
(attempt's vs `0`), the answers map (stored vs empty) and the `attempt:`
block.

```ts
// :603-618 and :645-657 — identical
evaluation: {
  id: evaluation.id, title: evaluation.title, mode: evaluation.mode,
  state: evaluation.state, settings, feedbackPolicy: feedbackOf(evaluation),
  pausedAt: isoOrNull(evaluation.pausedAt),
  totalPoints: Math.round(items.reduce((s, i) => s + i.item.points, 0) * 100) / 100,
},
```

**Refactoring**: one private `buildAttemptView(db, evaluation, { seed, answers, attemptHeader, now })`
that both call. `previewView` passes `seed: 0`, `answers: new Map()`, and the
`PREVIEW_ATTEMPT_ID` header.

**Constraint**: invariant 4 — both paths must keep going through
`attemptItems` → `studentView`, which the shared builder preserves by
construction (and makes *harder* to bypass).

**Tests**: `modules/live/live.db.test.ts`, `modules/live/routes.db.test.ts`,
`modules/live/studentView.leak.test.ts` (326 LOC — the invariant-4 net).

---

### B-05 — `assertWritable` / `assertOpen` / `isOpen`: one predicate written three times
**Principle**: DRY + a real drift risk on invariant 5 · **LOC delta**: **−25** · **Risk**: medium

`modules/live/service.ts:734-760`, `:767-775`, `:778-800`. All three encode
"may this attempt still be written to", with slightly different sets of
accepted evaluation states, and each repeats the same three `throw new
AttemptClosedError(...)` arms:

```ts
// assertWritable:735                       // assertOpen:779 — identical arm
if (attempt.state !== "in_progress") {
  throw new AttemptClosedError(attempt.state === "submitted" ? "submitted" : "deadline",
                               attempt.deadlineAt);
}
```
and `submitAttempt` (`:1049-1054`) writes the *same* arm a fourth time.

The only genuine difference is whether `paused` counts as closed
(`assertWritable`: yes, reason `"paused"`, decision D17; `assertOpen`: no).

**Refactoring**:
```ts
type ClosedReason = AttemptClosed["reason"] | null;
function closedReason(ev, at, now, pausedBlocks: boolean): ClosedReason { … }
export const isOpen  = (ev, at, now) => closedReason(ev, at, now, false) === null;
export const assertOpen     = (ev, at, now) => { const r = closedReason(ev, at, now, false); if (r) throw new AttemptClosedError(r, at.deadlineAt); };
export const assertWritable = (ev, at, now) => { const r = closedReason(ev, at, now, true);  if (r) throw new AttemptClosedError(r, at.deadlineAt); };
```

**Constraint**: invariant 5. The three must already agree on `GRACE_MS`
(`pastGrace`) and on `deadline + 3 s`; folding them into one is what
*guarantees* they cannot drift. Land it with no change to the reason strings.

**Tests**: `modules/live/live.db.test.ts`, `modules/live/routes.db.test.ts`
(the three 410 reasons), `ticker.test.ts` (the grace window).

---

### B-06 — Seven "failed proposal" literals in `grading/jobs.ts`
**Principle**: DRY · **LOC delta**: **−22** · **Risk**: low

The same six-line object appears at `jobs.ts:176`, `:265`, `:283`, `:331`,
`:400`, `:420`, `:468`:

```ts
{ points: 0, source: "auto", state: "proposed",
  details: { reason: "config_unreadable" }, comment: "config_unreadable" }
```
with `reason` ∈ `config_unreadable | answer_invalid | grader_error |
llm_not_configured | not_finalizable | runner_unavailable | runner_error |
finalize_error`. The `llm` one differs only by `source: "llm"`.

**Refactoring**: `const proposal = (reason: string, source: GradingSource = "auto") =>
({ points: 0, source, state: "proposed" as const, details: { reason }, comment: reason });`
The reason strings are read back by `reasonOf()` /
`progressOf()` (`grading/service.ts:258-262`) and by the web panel, so keep
them exactly as they are — a helper makes that set enumerable for the first
time (consider typing it as a union, which would mirror invariant 9's spirit).

**Tests**: `modules/grading/grading.db.test.ts`,
`modules/grading/regrade.db.test.ts`, `modules/runner/runner.test.ts`.

---

### B-07 — `reachable()` in `realtime/routes.ts` re-implements `reachableEvaluation` from `guards.ts`
**Principle**: DRY + ARCH (invariant 6 has two implementations) · **LOC delta**: **−25** · **Risk**: low

`modules/realtime/routes.ts:145-173` is a verbatim copy of
`modules/guards.ts:reachableEvaluation` (both do the staff query, then the
claimed-enrollment query, and return `{ evaluation, staff }`). The file even
says so:

> `/** The same predicate as `guards.ts#reachableEvaluation`, without the reply. */`

Invariant 6 says there is **one** predicate. Having it twice is precisely the
drift the invariant exists to prevent — e.g. the day `enrollments.status`
gains a third value, only one of the two will be updated.

**Refactoring**: split `guards.ts` into a reply-free core and a thin
reply-aware wrapper:
```ts
export async function findReachableEvaluation(db, user, id): Promise<{evaluation; staff} | null>
export async function reachableEvaluation(app, req, reply, id) {
  const row = await findReachableEvaluation(app.db, req.user!, id);
  return row ?? notFound(reply);
}
```
`realtime/routes.ts` then calls the core. Same applies to `accessWhere()`,
which `poll/routes.ts:86` and `evaluation/routes.ts:180` and
`realtime/routes.ts:152` each re-inline as
`req.user!.role === "admin" ? undefined : staffAccess(req.user!.id)`
(4 copies).

**Tests**: `modules/realtime/realtime.test.ts`,
`modules/live/staffAttempt.db.test.ts`, `modules/org/org.db.test.ts`.

---

### B-08 — "Total points of an evaluation" computed eight ways; two of them round differently
**Principle**: SSOT (touches invariant 8) · **LOC delta**: **−10** · **Risk**: low, but it is a *correctness* alignment

`packages/domain/src/round.ts` opens with:

> *"Every rounding in the platform therefore goes through this module."*

`results` and `grading` obey it (`round2` at `results/service.ts:101,149,205,474,518,648,656`
and `grading/service.ts:151,152,491,623`). `live` and `evaluation` do not:

| Location | Expression |
|---|---|
| `live/service.ts:617` | `Math.round(items.reduce((s, i) => s + i.item.points, 0) * 100) / 100` |
| `live/service.ts:655` | identical |
| `live/service.ts:1700` | identical (`maxPoints` of the dashboard) |
| `live/service.ts:1934` | identical (`studentHome` totals) |
| `live/service.ts:1776, 1797, 1818` | `Math.round(x * 100) / 100` on rates |
| `evaluation/service.ts:317` | `totalPointsOf()` — again `Math.round(…*100)/100` |
| `results/service.ts:101, 474, 648` | `round2(items.reduce(…))` |
| `results/csv.ts:45` | `Math.round(value * 100) / 100` |

`round2` adds a 1e-9 epsilon and rounds half **away from zero**; `Math.round`
rounds half toward **+∞**. For non-negative sums they agree except at exact
`.005` boundaries — but the dashboard's `maxPoints` and the results page's
`totalPoints` are *the same number shown on two screens*, computed by the two
different rules.

**Refactoring**: one exported helper in `evaluation/service.ts` (the module
that owns `evaluation_items`):
```ts
export const totalPointsOf = (rows: readonly { points: number }[]) => round2(rows.reduce((s, r) => s + r.points, 0));
```
and use it from all eight sites. For the *rates* (`successRateOf`,
`completion`) replace `Math.round(x*100)/100` with `round2(x)` in the same
pass. Note: this is a behaviour change for exact negative halves (MCQ
penalties can produce them) — which is the *intended* direction, since
`round.ts` documents penalised MCQ as the reason the module exists.

Note also: `apps/web/src/mock/index.ts:3268` defines a third `totalPointsOf`.

**Constraint**: invariant 8 — the rule belongs in `packages/domain`; only the
"sum the items" wrapper belongs in the API.

**Tests**: `modules/results/results.db.test.ts`,
`modules/results/feedback.db.test.ts`, `modules/live/live.db.test.ts`,
`packages/domain/src/round.test.ts`.

---

### B-09 — Six `/evaluations/:id/items*` handlers with the same eleven-line body
**Principle**: DRY · **LOC delta**: **−55** · **Risk**: low

`modules/evaluation/routes.ts`: `POST /items`, `PATCH /items/:itemId`,
`PUT /items/order`, `DELETE /items/:itemId`, `POST /items/update-versions`
(and `PATCH /evaluations/:id`) all run:

```ts
const attemptCount = await service.attemptCount(app.db, scope.evaluation.id);   // ×6
const items = await service.<op>(app.db, scope.evaluation, …, { attemptCount });
await trace(req, "evaluation.items_update", scope.evaluation.id, { … });
evaluationChanged(scope.evaluation.classroomId, scope.evaluation.id);           // ×10
return items;
} catch (error) {
  return evaluationFailure(reply, error) ?? reply.code(500).send({ error: "internal_error" }); // ×8
}
```

`evaluationFailure(reply, error) ?? reply.code(500)…` appears 8 times,
`coreFailure(reply, error) ?? reply.code(500)…` 6 times in
`pool/routes.ts`, and both are the "no handler matched" arm that
`live/routes.ts#failure` already folds into one function (`routes.ts:69-95`).

**Refactoring**: (a) give `evaluation`, `pool` and `results` the same
exhaustive `failure(app, reply, error)` that `live` and `grading` have — it
ends in `app.log.error` + 500, so the `?? reply.code(500)` tail disappears;
(b) an `itemsOp(path, method, Schema, op, payload)` helper for the six item
routes.

**Tests**: `modules/evaluation/evaluation.db.test.ts`.

---

### B-10 — `POST /answers/:answerId/gradings` and `POST /gradings/:id/override` are one handler twice
**Principle**: DRY · **LOC delta**: **−25** · **Risk**: low

`modules/grading/routes.ts:140-170` and `:178-207`. Both parse
`ManualGradingBody`, both call `service.manualOverride` with the same
`{ points, comment, ...details }`, both call `afterCorrection(…,
"grading.override")`, both map failures through `failure(app, reply, error)`.
The only difference is how the cell is found (`cellOfAnswer(answerId)` vs the
fields already on `scope.grading`). The comment at `:172` explains *why* two
entry points exist (deviation W6-3) — that justifies two *routes*, not two
bodies.

**Refactoring**: one private
`applyOverride(req, reply, evaluation, cell, body)` called by both routes.

**Tests**: `modules/grading/grading.db.test.ts`.

---

### B-11 — Dead surface: an unused SSE alias, an unused queue, an unused route, a duplicated stub
**Principle**: YAGNI · **LOC delta**: **−60** (source) + **−15** (test) · **Risk**: low

Each verified by a repo-wide grep (`apps`, `packages`, `scripts`, excluding
`dist`):

1. **`GET /app/events`** (`realtime/routes.ts:377`) — the "inherited path the
   shipped SPA already opens". It does not: `apps/web/src/live.ts` delegates
   to `realtime/useEventStream.ts:57`, whose `ENDPOINT` is
   `/app/api/events`. **Zero references anywhere**, tests included. Remove the
   route and the 10-line header paragraph that justifies it.
2. **`HOUSEKEEPING_QUEUE`** (`jobs.ts:18`, created at `:178`) — no `work()`
   handler and no `send()`. The session purge is a ticker task
   (`ticker.ts:38-43`). Dead queue: remove the constant and the
   `createQueue` call.
3. **`GET /app/api/classrooms/:id/join-code`** (`org/routes.ts:101`) — no
   caller in `apps/web`, none in the tests. The same two fields already ride
   on `CourseDetail.classrooms[]` (`org/routes.ts:59-60`).
4. **`unavailableRunner`** (`pool/routes.ts:1234-1243`) — a second
   implementation of `UnavailableRunner`
   (`modules/runner/unavailable.ts`), with an identical body. Import the
   class instead. In the same place, `runnerOf(app)`
   (`pool/routes.ts:115-117`) casts `app` structurally to reach
   `app.runner`, although `modules/runner/index.ts:50-55` declares the
   decorator globally — `live/routes.ts:335` just writes `app.runner`.
5. **`JobQueue.durable`** (`jobs.ts:64`, set in both implementations) — never
   read.
6. **`openStreamCount`** (`realtime/routes.ts:64`, *"Exposed for the tests"*)
   — no test uses it.
7. **`restoreQuestion`** (`pool/service.ts:1644`) — only
   `pool.db.test.ts:295` calls it; there is no restore route, and
   `docs/spec/02` (F-QST-11) says nothing about restoring a deleted
   question. **The spec is silent here** — flag it to the author rather than
   deleting unilaterally; `guards.ts:284` also claims *"restoring and
   hard-deleting them are routes too"*, which is half false today.
8. **`GET /app/api/student/attempts/:id/results`**
   (`results/routes.ts:157-166`) — a verbatim 10-line duplicate of
   `GET /app/api/attempts/:id/feedback`; only `results/routes.db.test.ts:168`
   calls it. The comment says PLAN-MVP §4.6 names that path — so this is a
   *choice*, not an accident. Either delete it or make it
   `app.get(pathB, opts, handlerOfPathA)`.
9. **`apps/api/package.json`**: `@quiz/qt-cloze`, `@quiz/qt-mcq`,
   `@quiz/qt-short` are declared dependencies that nothing in
   `apps/api/src` imports (they arrive through `@quiz/registry`, which
   declares all five). `@quiz/qt-circuit` is *not* declared yet is loaded at
   runtime by the same registry — the list is inconsistent either way.

---

### B-12 — The `org` domain has no service layer and is spread over four places
**Principle**: ARCH · **LOC delta**: ~0 (moves ~250 LOC) · **Risk**: medium

`docs/spec/05-architecture.md` §5.2 and `CLAUDE.md` (Conventions) both say a
module is `apps/api/src/modules/<name>/` with at most
`routes.ts`/`service.ts`/`events.ts`/`jobs.ts`. The `org` module (courses,
classrooms, staff, roster, join codes) is:

- `modules/courses.ts` — 579 LOC, 16 routes, **no service**: 18 direct
  `app.db.*` statements inside handlers, including the 55-line `GET /courses`
  aggregation (`courses.ts:64-118`);
- `modules/roster.ts` — 261 LOC, imported by `courses.ts`;
- `modules/org/routes.ts` + `modules/org/service.ts` — 284 LOC, which the
  file header openly describes as a completion: *"Courses, staff, classrooms
  and the roster live in `modules/courses.ts`; this file completes them
  rather than moving them"*;
- `modules/student.ts` (55 LOC) and `modules/admin.ts` (111 LOC) sit loose in
  `modules/` too.

The cost is concrete: `GET /app/api/courses/:id` (`org/routes.ts:26`) and
`GET /app/api/courses` (`courses.ts:64`) each build their own staff query
against `course_staff ⨝ users`, and `student.ts:33-42` builds a third.

**Refactoring** (three independent commits):
1. move `courses.ts`'s queries into `modules/org/service.ts`, leaving
   `courses.ts` as route registrations that call it;
2. rename `modules/courses.ts` → `modules/org/routes.ts` content (merge with
   the existing one) and `modules/roster.ts` → `modules/org/roster.ts`;
3. fold `student.ts` into `modules/org/routes.ts` (its one route is a roster
   read) or leave it as a documented exception.

**Tests**: `modules/org/org.db.test.ts`, `modules/roster.db.test.ts`,
`roles.db.test.ts`, `scripts/smoke.sh` (it walks `GET /courses` and
`GET /courses/:id`).

---

### B-13 — `live/service.ts` is three modules in one file (2 104 LOC, 120 functions)
**Principle**: ARCH / cohesion · **LOC delta**: ~0 · **Risk**: low (pure file split, all call sites are `import * as service`)

Reading the file, it holds five distinct responsibilities with no shared
state:

| Lines | Responsibility |
|---|---|
| 100–400 | failures, deadlines, participants, attempt creation |
| 440–680 | item ordering, locking, the three views |
| 690–1100 | the autosave gate, `saveAnswer`, `markDone`, `submit`, journal |
| 1170–1400 | `runVisibleCases`, `simulateAnswer` (runner-facing) |
| 1405–1630 | teacher controls (start/pause/resume/close/extend/reopen) |
| 1639–1830 | the dashboard read model |
| 1899–2100 | student home + the five ticker tasks |

**Refactoring**: split into `live/attempt.ts`, `live/autosave.ts`,
`live/run.ts`, `live/control.ts`, `live/dashboard.ts`, `live/ticker.ts`, and
keep `service.ts` as a re-export barrel so no importer changes. This exceeds
the "at most four files" convention — `pool/` already does (it has
`config.ts` and `assets.ts`), so **either the convention is amended in
`CLAUDE.md` or the split is refused**. That is an author decision, not mine;
I flag it because the convention is currently contradicted in two modules
and silent about the third.

**Tests**: `modules/live/live.db.test.ts` (850),
`modules/live/routes.db.test.ts`, `simulate.db.test.ts`,
`staffAttempt.db.test.ts`, `studentView.leak.test.ts`, `ticker.test.ts`.

---

### B-14 — `gradingQueue` (CC 21, 98 lines) and `runEvaluationGrading` (CC 19, 143 lines)
**Principle**: CC · **LOC delta**: +10 source / −0 · **Risk**: low

`grading/service.ts:350-448` does six things in one body: select items,
select attempts, load answers, load standing gradings, load history, load
roster, then build the cross product, filter by `query.state`, build each
entry (with `studentView` + `solutionView` inline), and finally recount
`validated`/`proposed` **by walking `pairs` a second time** (`:429-435`) —
the counts could be accumulated in the first loop.

**Refactoring**: extract `loadQueueContext(db, evaluation)` (the six
queries), `entryOf(pair, context)` (the per-cell build), and accumulate the
counts in the single pass. CC drops to ~8 for the orchestrator and ~6 for
`entryOf`; behaviour unchanged.

`grading/jobs.ts:110-252` (`runEvaluationGrading`) is the same shape: the
progress-event bookkeeping (`sinceEvent`, `PROGRESS_EVERY`) is interleaved
with the grading decision in two places (`:163-167` and `:236-239`). Extract
a small `progressReporter(evaluation, teacherIds, total)` closure with a
`tick()` method; the two call sites become one line each and the branch at
`:161` disappears.

**Constraint**: invariant 4 — `studentView`/`solutionView` must stay the only
producers; extracting `entryOf` keeps that (it still calls them).
Invariant 5 — `base.now` must stay `app.clock.now()` per cell, as today.

**Tests**: `modules/grading/grading.db.test.ts` (339),
`modules/grading/mcqPolicy.db.test.ts`, `modules/grading/regrade.db.test.ts`.

---

### B-15 — `distributionOf` (CC 20) is a per-type dispatch written as an if-chain
**Principle**: CC + ARCH (a generic module knowing type shapes) · **LOC delta**: −5 · **Risk**: low–medium

`results/service.ts:385-417` branches on `type === "mcq"`, `type === "cloze"`,
then falls back to string / `{text}` sniffing. Next to it,
`casePassRateOf` (`:421-437`) imports `CodeDetails` from
`@quiz/qt-code/server` (`results/service.ts:38`) — the *only* place in
`apps/api/src` where a generic module imports a concrete question type.

`docs/spec/05-architecture.md` §5.3 is explicit: *"The core only knows `type`,
`config`, `payload`, `details`."* The mechanism for this already exists —
`QuestionTypeServer.studentDetails` is exactly such a hook, used at
`results/service.ts:592`.

**Refactoring**: add an optional `distribution(payloads): AnswerDistributionEntry[]`
and `caseStats(details[])` to the `QuestionTypeServer` contract in
`packages/core`, implement them in `qt-mcq`, `qt-cloze`, `qt-short`,
`qt-code`; `distributionOf` becomes a two-line dispatch with the current
string/`{text}` behaviour as the default implementation. That also lets
`apps/api/package.json` drop its last direct `qt-*` dependency (B-11 #9).

**Note**: this touches `packages/core` and the `qt-*` packages, which are
outside my scope — flag for a cross-package ticket rather than a backend-only
change.

**Tests**: `modules/results/results.db.test.ts`.

---

### B-16 — Two recursive key-strippers with 90 % shared code
**Principle**: DRY · **LOC delta**: −15 · **Risk**: low (but it is invariant-4 code — review carefully)

`live/studentView.ts:61-70` (`stripMetadata`, depth cap 12, forbidden set of
19 keys) and `results/service.ts:572-583` (`stripDetailKeys`, depth cap 12,
forbidden set of 5 keys, plus one `visible && key === "expected"` exception).
Same walk, same cap, same array handling.

**Refactoring**: one `stripKeys(value, forbidden: ReadonlySet<string>, keep?: (obj, key) => boolean, depth = 0)`
in a shared place, with the two call sites supplying their own set and
`keep`. Keep the two exported *lists* (`FORBIDDEN_STUDENT_KEYS`,
`FORBIDDEN_DETAIL_KEYS`) exactly where they are — they are the auditable
surface.

**Constraint**: invariant 4 and `docs/spec/05` §5.7. Land only with
`studentView.leak.test.ts` green and unchanged.

**Tests**: `modules/live/studentView.leak.test.ts` (326 LOC),
`modules/results/feedback.db.test.ts` (301 LOC).

---

### B-17 — The "participant fallback" triplet, and the student-home join, written twice each
**Principle**: DRY · **LOC delta**: −25 · **Risk**: low

(a) The same five lines appear at `live/service.ts:571-577`
(`attemptOrLobbyView`), `:1602-1608` (`reopenAttempt`), and a variant at
`realtime/routes.ts:218-222` (`snapshotOf`):

```ts
const seat = attempt.userId === null ? null : await participantOf(db, evaluation, attempt.userId);
const participant: Participant = seat ?? { userId: attempt.userId, guestId: attempt.guestId, timeBonusPercent: 0 };
```
→ `export async function participantOfAttempt(db, evaluation, attempt): Promise<Participant>`.

(b) `live/service.ts:1900-1917` (`studentHome`) and
`results/service.ts:599-615` (`studentResultCards`) issue the *same*
four-table join (`enrollments ⨝ classrooms ⨝ courses ⨝ evaluations ⟕
attempts`, filtered on `status = 'claimed'`), differing only in `orderBy`.
→ one `enrolledEvaluationsOf(db, userId)` in `evaluation/service.ts` (it owns
`evaluations`), consumed by both.

(c) `orderItems(await joinedItems(db, evaluation.id), settings, attempt.seed, evaluation.id)`
appears at `live/service.ts:591`, `:921`, `:1019`.

**Tests**: `modules/live/live.db.test.ts`,
`modules/results/results.db.test.ts`, `modules/realtime/realtime.test.ts`.

---

### B-18 — `historyOf` and `historyOfCell` map the same row to the same DTO
**Principle**: DRY · **LOC delta**: −12 · **Risk**: low

`grading/service.ts:316-347` and `:550-567`: both order by `NEWEST_FIRST` and
build the identical nine-field `GradingHistoryEntry`. Extract
`const historyEntry = (g: GradingRecord): GradingHistoryEntry => ({…})` and
use it in both.

**Tests**: `modules/grading/grading.db.test.ts`.

---

### B-19 — The accepted-image-MIME set is defined three times, with three different contents
**Principle**: SSOT · **LOC delta**: −5 · **Risk**: low

| Location | Set |
|---|---|
| `packages/contracts/src/pool.ts:459` | `AssetMime = z.enum(["image/png","image/jpeg","image/gif","image/webp"])` |
| `modules/pool/assets.ts:21` | `const ALLOWED: readonly AssetMime[] = [same four, hand-written]` |
| `modules/avatar.ts:9` | `const ACCEPTED = new Set(["image/jpeg","image/png","image/webp"])` (no gif) |
| `app.ts:99` | `addContentTypeParser(["image/jpeg","image/png","image/webp"])` |

`assets.ts:21` is a pure duplicate of the zod enum: replace with
`AssetMime.options` and `isAllowedMime = (m): m is AssetMime => AssetMime.safeParse(m).success`.
The avatar set is deliberately narrower (no animated gif for an avatar) —
give it a named constant in `contracts` (`AvatarMime`) so `app.ts:99` and
`avatar.ts:9` stop being two hand-kept lists (invariant 7's spirit).

Similarly, `MAX_BYTES = 1_000_000` (`avatar.ts:10`) is a hard-coded sibling of
`config.ASSETS_MAX_BYTES`; that one is arguably fine (see "keep as is").

**Tests**: `modules/pool/routes.db.test.ts` (asset upload cases).

---

### B-20 — Forty symbols exported that no other file imports
**Principle**: KISS (module surface) · **LOC delta**: ~0 · **Risk**: low

A repo-wide reference scan (`unused2.sh` in the scratchpad) finds only **3**
symbols referenced nowhere at all (`NothingToRun`, `seatOf`, `UsingCourse`) —
the backend has almost no dead code, which is worth saying plainly. But
`knip` finds ~40 more that are exported and used **only inside their own
file** or only by that file's test: `live/service.ts` alone exports
`deadlineFor`, `pastGrace`, `ipAllowed`, `orderItems`, `lockedItemIds`,
`contentVisible`, `genericSummary`, `answerSummarizer`, `summarizeAnswer`,
`autoCloseAt`, `NotOpen`, `AccessCodeInvalid`, `IpNotAllowed`, `Irreversible`,
`ItemLocked`, `NotRunnable` in that category.

Most of those are exported *so a unit test can reach them*, which is a
legitimate reason — but it means the module's public surface is 20× larger
than its actual contract, and nothing stops a future module importing
`lockedItemIds` and re-deriving navigation rules outside `live`. Cheapest
fix: keep the exports (tests need them) but add a short `// --- internal,
exported for tests ---` banner section per file so the contract half is
readable. Zero risk, purely documentary.

---

## 3. Sequenced refactoring plan

Each phase is independently mergeable and leaves `pnpm build && pnpm
typecheck && pnpm test` green. Phases 1–3 touch no wire format at all.

**Phase 1 — the shared HTTP kit (no behaviour change).** B-03, B-01.
Create `apps/api/src/modules/http.ts` with `invalid`, `emptyBody`,
`notFound`, `failure` and move `issuesOf` to `packages/contracts`. Add
`tracer(app)` to `audit.ts`. Rewrite the 36 inline audit blocks and delete
the six `invalid`/`emptyBody` copies. **≈ −240 LOC.** Align the three 400
body shapes in a *separate* commit, with a look at the web error rendering.

**Phase 2 — the guard core (invariant 6, one implementation).** B-07.
Split `guards.ts` into reply-free finders + reply-aware wrappers; point
`realtime/routes.ts` at the finder; replace the four inlined `accessWhere`
copies. **≈ −30 LOC**, and invariant 6 gains a single implementation.

**Phase 3 — the route wrappers.** B-02, B-09, B-10.
`live` first (it has the densest test coverage and the clearest two
audiences), then `evaluation`, then `grading`, then `results`. `pool` last:
its `requirePoolRole` step makes its wrapper a different shape.
**≈ −220 LOC.** Land one module per PR.

**Phase 4 — `live/service.ts` internals.** B-04, B-05, B-17.
Merge the two views, unify the three write gates, extract the participant
fallback and the shared join. **≈ −90 LOC** and a real reduction in the
invariant-5 drift surface.

**Phase 5 — grading and results.** B-06, B-14, B-18, B-16.
The proposal helper, the two CC-21/CC-19 decompositions, the shared history
mapper, the shared key-stripper. **≈ −50 LOC**, max CC in the backend drops
from 21 to ~12.

**Phase 6 — SSOT and dead surface.** B-08, B-11, B-19, B-20.
One `totalPointsOf` on `round2`; delete `/app/events`, `HOUSEKEEPING_QUEUE`,
the join-code route, the duplicate `unavailableRunner`, `durable`,
`openStreamCount`; drop the three unused `qt-*` dependencies; derive
`ALLOWED` from `AssetMime`. **≈ −75 LOC.** B-08 is the only item here with a
behavioural edge (negative half-rounding) — call it out in the commit
message.

**Phase 7 (needs an author decision, not a PR).** B-12 (`org` gets a service
layer and one home), B-13 (`live/service.ts` split vs. amending the
four-file convention in `CLAUDE.md`), B-15 (a `distribution`/`caseStats`
hook on `QuestionTypeServer`, which crosses into `packages/`), B-11 #7
(`restoreQuestion`: delete, or build the restore route the guard comment
promises — **the spec is silent**).

---

## 4. Keep as is

Things that look like debt and are not:

- **`guards.ts` (515 LOC, 14 near-identical loaders).** They *are* the same
  motif fourteen times, but each one names a different entity and a different
  join, and the repetition is what makes invariant 6 auditable at a glance. A
  generic `loader(table, predicate)` would hide exactly the thing that must
  stay readable. Only the `reachable()` *duplicate* (B-07) is worth removing.
- **The three-layer event path** `module/events.ts` → `realtime/bus.ts` →
  `events.ts`. It looks like two layers too many, and some adapters are pure
  pass-throughs (`live/events.ts#runnerResult`, `poll/events.ts#tallyChanged`,
  `pool/events.ts#questionChanged`). But `docs/spec/05` §5.2 rule 4 — *"A
  module publishes its events through `realtime`, never directly"* — is what
  those adapters enforce, and `bus.ts` is the one place the §5.4 routing table
  (topic, audience, coalescing window) is written down. Keep.
- **`Coalescer` with injectable timers** (`realtime/coalesce.ts`, 85 LOC).
  Directly required by §5.4 ("cell updates grouped over 250 ms"), and the
  `TimerApi` injection is what lets `realtime.test.ts` close a window without
  sleeping.
- **`InProcessQueue`** (`jobs.ts:96-170`). It looks like a speculative
  abstraction; it is what makes `pnpm dev`/CI work without PostgreSQL, which
  `CLAUDE.md` promises in its first Development paragraph.
- **`config.ts`'s 29 environment variables.** I checked each one: all 29 are
  read somewhere in `apps/api/src`. No dead configuration.
- **`writeGrading`'s single-writer transaction** (`grading/service.ts:122`)
  and the `NEWEST_FIRST` tiebreaker (`:53`). Both are load-bearing under
  concurrency and documented as such.
- **`TestClock` / `app.clock`** — invariant 5's mechanism.
- **The two "read behind a POST" routes** (`config: { readOnly: true }`) and
  the `onResponse` hint hook in `app.ts:138-157`. The 30-line comment above
  it documents a real production incident (215 req/s on the student tab);
  the absence of a catch-all `else` is deliberate.
- **`smoke.sh`.** 220 lines, no duplication worth naming: the `api`/`expect`/
  `jqx` helpers are already the right three, the runner section is correctly
  guarded on `RUNNER=up`, and it exercises the whole life-cycle including the
  CSV BOM. The only nit is that it is the sole user of the
  `POST /evaluations/:id/grade` alias while the web app uses
  `/grading/run` — worth pointing one of them at the other.
- **`pool/config.ts`'s two-flavour API** (`loadConfig` throws /
  `tryLoadConfig` returns issues). Decision D16 requires exactly that.
- **Per-question `answerSummarizer` closure** (`live/service.ts:840-873`).
  It looks over-engineered for a cell preview; the comment explains it is a
  240→10 reduction in config parses per dashboard refresh, which the §5.4
  budget (100 updates/s) justifies.

---

## 5. Summary table

| Principle | Findings | Source LOC | Test LOC |
|---|---|---|---|
| DRY | B-01, B-02, B-03, B-04, B-05, B-06, B-07, B-09, B-10, B-16, B-17, B-18 | **−659** | 0 |
| SSOT | B-08, B-19 | **−15** | 0 |
| YAGNI | B-11 | **−60** | **−15** |
| CC | B-14, B-15 | **+5** | 0 |
| KISS | B-20 | 0 | 0 |
| ARCH | B-12, B-13 | 0 (≈500 LOC moved) | 0 |
| **Total** | **20 findings** | **≈ −729** | **≈ −15** |

≈ −729 source LOC is **4 % of the 18 259 LOC in scope**, and about **17 % of
the ~4 370 LOC that live in the route files** (`modules/*/routes.ts` = 3 789,
plus `courses.ts` = 579), which is where nearly all of it comes from. Max backend CC falls from 21 to ~12; no function above
80 lines survives except the plugin registration closures, whose length is
inherent.
