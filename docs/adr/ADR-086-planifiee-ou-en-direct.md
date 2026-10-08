# ADR-086 — Scheduled or Live: who drives the clock, a safety deadline, and a limit cut at the window's end

## Status

Accepted (2026-10-08, issue #555; the product owner settled the issue's four
open questions the same day: an optional safety deadline in Live, the Live
date a calendar hint only, a limit cut at the end of a Scheduled window, the
names Scheduled / Live, « Planifiée / En direct »). No migration.

Scope: the time part of the configuration screen of an evaluation and of a
template (step 2, "Time and mode"), the action of the launch step, the
stored `timing` × `lobby` × `opensAt` / `closesAt` / `durationS` they map
to, the attempt deadline (`attemptDeadline`), the readiness and past-time
rules (`missingTimingFields`, `pastTiming`), and the live controls that move
`closesAt` (`extendTime`, `resumeEvaluation`).

Relations: amends F-EVAL-04 (an exam may be closed by the teacher when it
has a safety deadline), F-EVAL-05 (the extra time is added after the cut),
F-EVAL-06 (the waiting room is a Live setting) and F-LIVE-12 (a late
student's limit is cut at the end); the deadlines
it adds are swept by the ticker of [ADR-006](ADR-006-deadline-ticker.md),
whose rule (server clock, `deadline + 3 s`, `410 attempt_closed`) is
unchanged. Replaces the two named presets of the step (docs/spec/08 §8.2,
"Préréglages nommés").

## Context

Step 2 exposed three independent settings: `timing` (Per student / Common
end / I close it), `lobby` (none / automatic / you start) and the dates and
duration, under two preset cards that wrote a handful of them at once. The
labels said the model, not the intent: a newcomer could not tell "Common
end" from "I close it", some combinations were traps (an end set but
ignored, a schedule that skipped the waiting room the teacher believed
set), and the refusals leaked the model ("with a common end, extra time is
counted from the opening time").

Three gaps sat under the labels. `manual` had no deadline at all, so a
teacher-led exercise had no backstop if the teacher forgot to close it, and
an exam could not be teacher-led. A `duration` attempt ignored `closesAt`:
a student who started a minute before the end of a window got the full
duration, and the ticker kept the evaluation running until they finished.
And the launch step's "Schedule…" scheduled a teacher-led evaluation, which
opened its waiting room by itself at a time nobody asked it to.

## Decision

### 1. One question, then one switch

The step asks **who drives the clock?** — **Scheduled** (the platform opens
and closes it between a start and an end; students work without the
teacher; no waiting room) or **Live** (the teacher opens the waiting room,
starts and closes) — then **Time limit per student** (a number of minutes,
or none). The mode is never stored: `clockChoiceOf` (`@quiz/domain`) reads
it back from `timing` and `lobby`, and `clockPatch` writes them, so every
evaluation and template saved before keeps working and shows the mode its
settings mean.

| Choice | `timing` | `lobby` | Fields shown |
| --- | --- | --- | --- |
| Scheduled, no limit | `deadline` | `skip` | start, end |
| Scheduled, with limit | `duration` | `skip` | start, end, minutes |
| Live, no limit | `manual` | `manual` | date (a hint), safety deadline |
| Live, with limit | `duration` | `manual` | date (a hint), safety deadline, minutes |

Every choice shows the end (`closesAt`): the ticker closes on it whatever
the timing, so an end the screen hid would still be enforced, and a stored
one is always visible and clearable. Live's waiting room may be `auto`, or
`skip` without a limit, from the advanced options; it is kept when the mode
stays Live. `duration` + `skip` is Scheduled with a limit (the store cannot
tell it from a waiting-room-less Live with a limit, so Live does not offer
that pair). A pair outside the table (`deadline` with a waiting room) reads
as Live without a limit and is rewritten by the next choice. Picking a mode
writes the clock only: the dates stay the teacher's, and the navigation, the
presentation, the shuffles and the feedback keep what the creation preset
(`exam`, `exercise`) or the teacher set — except that the feedback falls back
to `on_release` in the same patch when a waiting room appears (F-EVAL-11,
#78). A limit turned on with no duration stored starts at 45 minutes.

### 2. A safety deadline in Live

`timing: "manual"` and `closesAt` may coexist: the ticker closes such an
evaluation at `closesAt` exactly as it closes a common end. The attempts
hang off it (`attemptDeadline` = `closesAt` + the attempt's own extra time;
no accommodation, nothing nominal being announced), so the autosave gate
refuses a write after `closesAt + 3 s` with `410 attempt_closed`, and a
"+N min" to everybody or a pause moves `closesAt` itself, as in `deadline`
timing (`anchoredOnClosesAt`). An **exam** in `manual` timing needs one —
F-EVAL-04's "an exam must end by itself" — so `missingTimingFields` asks for
`closesAt` instead of refusing the timing (the `timing` missing field is
gone from `TransitionRefusal`). An exercise may omit it. Live with a limit
may carry one too (`duration` with a waiting room and a `closesAt`): it then
cuts the minutes as §3 says.

A past `closesAt` refuses to schedule or open whatever the timing
(`pastTiming`, #178): the ticker closes on it whatever the timing. Before the
start, "+N min" to everybody moves `closesAt` whatever the timing — the way
out of a waiting room whose end went by — and the dashboard says so whatever
the timing.

### 3. A limit is cut at the end

In `duration` timing with a `closesAt`, an attempt's nominal end (start +
duration) is cut at `closesAt`, and the accommodation and the attempt's own
extra time are added after the cut: a student who starts ten minutes before
the end has ten minutes, plus their roster extra time (F-EVAL-05), which
carries them past `closesAt` exactly as in `deadline` timing. A pause the
student sat through is part of their extra time and pushes their end; a
pause before they started does not, since they had not begun. While the
evaluation runs, "+N min" to everybody goes to each attempt and does not
move `closesAt` (the end of a Scheduled window stays where it was
announced); before the start, it moves `closesAt` instead and carries the
minutes alone, never both, so a student cut at the end is not given them
twice. Before this record the end did not cut the attempt (the ticker waited
for the last attempt's own deadline): an existing `duration` evaluation with
a `closesAt` is now cut there, and an attempt reopened after the deploy has
its deadline recomputed under this rule.

### 4. The Live date is a hint; Scheduled is what schedules

In Live, `opensAt` places the evaluation in the calendar and nothing more:
the launch step offers no Schedule, and the teacher opens the waiting room.
Opening a waiting room at that time by itself is a later follow-up. In
Scheduled, while the start is still to come, **Schedule** is the launch
step's one action (the date is the timing step's, so no dialog asks for it
again) and **Open now** the secondary one; once the start has passed, the
action is **Open**. An evaluation already `scheduled` with a waiting room,
from before this record, keeps opening it at `opensAt`, and **Back to
draft** still unschedules it.

## Consequences

- One question a newcomer can answer, and fewer traps: every mode shows the
  end the server enforces, and only the fields its mode means.
- A teacher-led exam is possible, with an end the server enforces; a
  teacher-led exercise gets an optional backstop.
- Cutting the limit at the end changes the deadline of existing `duration`
  evaluations that carry a `closesAt` and were sat late in their window;
  the student is told, the conditions listing the closing instant beside the
  duration (`imposedConditions`).
- The presets' pedagogic side effects (shuffling and continuous layout for
  homework, immediate feedback) are no longer one click on step 2; the
  creation preset still sets them.
- The rule is read in one place on both sides: `clockMode.ts` and
  `deadline.ts` in `@quiz/domain`, unit-tested row by row and round trip.


## Alternatives considered

- **Store the mode** as a new column or setting. Rejected: it would duplicate
  what `timing` and `lobby` already say and need a migration of every row.
- **Keep the presets beside the mode.** Rejected: two cards that write the
  clock next to two cards that choose it is the confusion the issue is
  about.
- **Let a late student finish their duration past the window.** Rejected
  by the product owner: the window is the promise a Scheduled evaluation
  makes, and the ticker would keep it open for one student.
- **Auto-open a Live waiting room at its date.** Deferred: the date stays a
  hint until a teacher asks for it.
