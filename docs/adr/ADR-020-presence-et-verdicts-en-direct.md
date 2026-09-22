# ADR-020 — Presence is a body in the room, and the Results switch colours it now

## Status

Accepted (2026-09-22, both halves asked for by the product owner after the
first real evaluation). It amends decision 4 of ADR-018 on one point, named
below, and leaves the rest of it standing.

## Context

A teacher ran a one-question evaluation on the deployed application. They are
staff of the course AND they had put themselves on the classroom roster, which
is exactly the walk ADR-018 exists for. Two things were wrong, and they are
independent.

### 1. The room said nobody was in it

- The live dashboard, in the teacher's first tab: ring at **0 present**, "Not
  here yet: Yves Chevallier (1)", header "Live · 0 of 1 connected".
- The student view, in the second tab: the waiting room rendered, "Connected ·
  clock synchronised", the attempt had been created — and the ring read
  **0 % · 0 / 0**.

So the person was demonstrably connected, demonstrably held an attempt, and
was counted on neither screen. Two causes, one per figure.

**The numerator.** Presence is a property of the OPEN CONNECTIONS
(`modules/realtime/presence.ts`), and the SSE handler decided whether to
register one by asking whether the caller was staff:

```ts
if (watch !== null && !staff) presence.join(watch.evaluationId, me.id, now);
```

`staff` came from `reachable()`, which admits a user through the course's
staff seats FIRST. But the student's waiting room and the teacher's dashboard
open the SAME subject — `?watch=evaluation:<id>` — so the server had nothing
to tell them apart by except the caller's role, and for this person the role
said "teacher" on both tabs. Their waiting room therefore registered no
presence at all, and `presence.count()` answered 0 to both screens.

**The denominator.** `enrolledCount` counted the roster with
`staff = false`, per decision 4 of ADR-018. The only seat in that classroom
was the teacher's staff seat, so the student ring's denominator was 0 — and a
ring of 0 / 0 is a ring that cannot be right whatever the numerator does.

### 2. The Results switch showed nothing until the closing

The dashboard's third toggle is "Results". A cell only ever carried a
`verdict` when a row existed in `gradings`, and `gradings` is written by the
grading pass, which runs AFTER the evaluation is closed (F-GRADE-01,
docs/spec/05 §5.6). So during the exam — the one moment the teacher is
looking at the grid — every cell was the blue "done" state whatever the
student had written, and the class row read "0 % · after closing".

The teacher's question while a class answers is not "how many have finished",
it is "have they understood". The grid could answer it: the server holds the
answer and the question's `grade` is a pure function of the two.

## Decision

### A. The subject says which side of the room a connection is on

`WatchSubject` gains a third member, `lobby:<uuid>`
(`packages/contracts/src/realtime.ts`). It carries the same topic and the
same authorisation as `evaluation:<uuid>` — `reachable()`, unchanged,
answering the 404 of a missing entity to anyone else (invariant 6). What it
adds is the side of the room:

| Subject | Who opens it | `dashboard.*` | Counted present |
| --- | --- | --- | --- |
| `evaluation:<id>` | the teacher's live dashboard | yes, if staff | no |
| `lobby:<id>` | a participant's waiting room | never | yes, with a seat |
| `attempt:<id>` | the player, or a staff inspector | if staff | only one's OWN attempt |

The stream therefore carries a `participant` flag beside `staff`, and they
are NOT each other's opposite: a teacher walking their own quiz is both. A
`lobby:` connection is `staff: false` for routing, which is also more correct
than what came before — the student tab of a teacher was being sent
`dashboard.*` frames it had no screen for.

`participant` requires a CLAIMED SEAT (`participantOf`, the same admission
`POST /evaluations/:id/attempt` uses), so an administrator who can reach every
evaluation is still not in the room until they take a seat.

### B. The lobby denominator is the seats in the room

`enrolledCount` now counts the class, PLUS the staff seats that hold an
attempt on this evaluation. That is exactly the row set `dashboardView`
builds, so the ring, the "here / not here yet" lists and the grid can never
disagree about who is expected.

This is the one point where decision 4 of ADR-018 ("a staff attempt counts in
NOTHING") is amended, and the line is drawn where the sentence after it
already drew it: **presence is not a statistic.** A staff attempt still
counts in no completion, no success rate, no class figure, no histogram, no
frozen snapshot and no CSV. It counts in how many people are sitting in the
room, because it is a person sitting in the room. A staff seat that took no
attempt is listed nowhere and counted nowhere, exactly as before.

### C. With `?results=1`, the server grades what it can, and says it is a preview

`GET /evaluations/:id/dashboard?results=1` computes, per cell with an answer
and no grading on record, the verdict that answer WOULD get if the evaluation
closed now. It calls the question type's own `grade` — the same function the
grading pass calls, on the same config — so a preview and the final grading
cannot disagree by construction.

Four properties make it a preview and not a grading:

1. **Nothing is written.** No row in `gradings`, no job enqueued, no runner
   request. The grading pass at closing runs exactly as it did.
2. **A grading on record always wins.** A validated verdict, or a proposal
   awaiting the teacher's eyes, is never overwritten by a computed one.
3. **It never reaches a student.** It travels on `DashboardView` and on the
   staff-only `dashboard.cell` frame; no student payload goes near it, and
   `toStudent` is untouched (invariant 4).
4. **It is flagged.** `DashboardCell.provisional` and the totals'
   `provisional` say which kind of verdict the screen is showing. The grid's
   class row reads "success 42 % · live", and the legend carries one line
   saying the verdicts are computed from the current answers.

**Only for the types that grade without the runner.** `finalizeRunner` is a
type's declaration of "graded in two halves"; for `code` and `circuit`,
building the request and running nothing would cost the assembly of every
student's source on every refresh, to answer `null`. Those columns colour when
their real grading lands, as before.

**Only when it was asked for.** `results` is a request flag validated by
`DashboardQuery` (invariant 7) and part of the client's query key, so a
projected grid with the switch off costs exactly what it used to. The
incremental `dashboard.cell` frame carries the verdict unconditionally: one
`grade()` of a deterministic answer costs about what the `summary` already
beside it costs, and the bus has no idea which teacher has which switch on.

## Conflict with the specification, and why it was accepted

Three lines of the specification tie a verdict to the closing:

- `docs/spec/02-exigences-fonctionnelles.md:102` — F-DASH-01, "Every cell
  shows the state: empty, in progress, done, and **after grading** correct /
  partial / wrong."
- `docs/spec/02-exigences-fonctionnelles.md:106` — F-DASH-04, "Total row per
  question: completion rate, and **after grading** success rate."
- `docs/spec/02-exigences-fonctionnelles.md:113` — F-GRADE-01, "**On close**,
  every answer of the deterministic types is graded automatically and
  validated." And `docs/spec/05-architecture.md` §5.6: "**After closing**, the
  `grading` module enqueues a `grading.evaluation` job".

None of them FORBIDS showing what an answer is worth before the closing; they
describe when the grading of record happens, and that has not moved. But they
are the reason the grid behaved as it did, and the wording "after grading" is
now ambiguous on the dashboard. The decision above was asked for explicitly by
the product owner and is implemented behind the existing "Results" toggle.
`docs/spec/02` and `docs/spec/05` should be amended to distinguish the
GRADING OF RECORD (unchanged, at the closing) from the LIVE PREVIEW of the
dashboard; that edit is not made here, and this section is the record of it.

## Consequences

- `WatchSubject` has three members; the student's `attemptStream.ts` watches
  `lobby:<id>` and no longer `evaluation:<id>`. An old tab still opening the
  latter keeps working — it simply is not counted present, which is the
  pre-existing behaviour for that subject.
- `enrolledCount` takes the evaluation and not the classroom id: the staff
  half of the count is per evaluation.
- `DashboardCell` gains `provisional`, the totals gain `provisional`,
  `DashboardCellEvent` gains `verdict`, `DashboardQuery` gains `results`.
- The dashboard's query key holds both toggles, so flipping "Results" refetches
  its own variant instead of reading the other one's cells.
- `live.grid.afterClose` is now only shown with the switch OFF; with it on and
  nothing gradable, the footer says "graded at closing", which is accurate for
  a `code` column.
- The whole of it is one process's in-memory presence map, as before
  (ADR-001, ADR-009): with `WORKER_MODE` split across processes each web
  process would know its own connections, and that is unchanged.

## Rejected alternatives

1. **Counting presence from a claimed seat alone, whatever the subject.** A
   teacher with a seat who opens the DASHBOARD would then be "present" in a
   room they are not in, and the ring would say somebody is waiting who is
   not.
2. **An `?as=participant` query parameter instead of a subject.** It is the
   same information in a second place. The subject already exists, is already
   a validated union, and is already what the authorisation is computed from.
3. **Grading every cell on every dashboard read.** The teacher who projects
   the grid with the results off would pay for verdicts nobody is looking at.
   Hence the request flag.
4. **Writing the preview into `gradings` as a `proposed` row.** It would make
   the grading panel fill with proposals nobody asked for, it would race the
   real pass at the closing, and every keystroke of every student would be a
   write. A preview that is stored is not a preview.
5. **Showing the provisional verdict to the student.** It is the answer key,
   one bit at a time, during the exam. Invariant 4 exists for this.
6. **Colouring `code` and `circuit` from a student's own interactive run.**
   That run is the student's, with the visible cases only; calling it a
   verdict on the teacher's grid would report a pass on a question the hidden
   cases fail.
