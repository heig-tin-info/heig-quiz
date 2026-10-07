# ADR-076 — An attempt starts by an explicit Start, not by opening the link

## Status

Accepted (2026-10-05, decided by the product owner in conversation on
issue #525).

Scope: F-LIVE-01 (amended), `POST /evaluations/:id/attempt`, the new
`POST /evaluations/:id/attempt/start` and the student's `/take/:evaluationId`
route.

Relations: amends [ADR-020](ADR-020-presence-et-verdicts-en-direct.md) (the
presence table gains a row: the ready screen counts nobody); leaves
[ADR-025](ADR-025-plusieurs-tentatives-exercice.md) (a retake starts on its
own click), [ADR-027](ADR-027-tickets-de-lancement-et-sessions-typees.md) and
[ADR-051](ADR-051-postes-kiosque-attestes.md) (trusted clients) and
[ADR-034](ADR-034-agir-en-tant-qu-etudiant.md) §4 as they are. Amended by
[ADR-079](ADR-079-conditions-de-l-evaluation.md) §6 (2026-10-07): the rules
the ready screen carries (§1) are the evaluation's conditions.

## Context

`/take/:evaluationId` is the link of the `activity_available` and
`deadline_approaching` notifications, of the student home card, of e-mails and
Teams messages. The page POSTed `/evaluations/:id/attempt` on mount, and on a
`running` evaluation the server answered by creating the attempt, marking the
student present and beginning it: `in_progress`, `startedAt`, and the
per-student deadline. A mere look at a link therefore started the clock,
consumed the attempt and, at the close, got the attempt graded.

## Decision

1. **The criterion is the absence of a row.** On a `running` evaluation, a
   participant with NO attempt row is answered `{ kind: "ready", view }` and
   nothing is written: no attempt, no presence (`markPresent`), no lobby event.
   The ready screen carries the evaluation's rules (navigation, negative
   marking, calculator), what Start announces (timing, duration, the
   participant's extra-time percent, the closing instant) and no question
   content (invariant 4).
2. **Start is explicit.** `POST /evaluations/:id/attempt/start`, behind the
   same loader and guards as the entry route (sitting refusal, trusted-client
   checks, impersonation rules), creates the row, marks presence and begins
   the attempt, each idempotently, and answers like the entry route: the
   attempt, the lobby when the evaluation is in `lobby` or `paused`, `409
   not_open` when it is closed. A second call answers the same attempt with
   the same `startedAt`.
3. **Lobby and paused are unchanged.** There the entry route still creates the
   row and marks presence: the waiting room needs them (F-LIVE-02, F-LIVE-03,
   `beginWaitingAttempts`). A participant whose row exists, having entered in
   the lobby or while paused, begins directly when the evaluation runs.
4. **Trusted clients keep beginning directly.** A `seb` or `kiosk` session
   (ADR-027, ADR-051) is confined to one evaluation and its pairing or `.seb`
   opening already is the explicit act.
5. **A retake is unchanged.** Pressing Retake (F-EVAL-15) is the explicit act;
   `retakeAttempt` still starts the new attempt at once.
6. **A late student gets the ready screen too.** A student arriving on an
   evaluation the teacher already started has no row, so they follow the
   criterion of point 1.
7. **The ready screen is not presence.** It opens no event stream and writes no
   row, so it counts nobody in the room (ADR-020's table). Presence begins
   with the Start, or with the waiting room.

The web route renders a `Ready` screen for `kind: "ready"`: one primary
action, "Start", with the consequence stated beside it (the N-minute clock,
with the student's own extra time; "available until …"; or no clock), and a
quiet "Later" back home (the station's own screen on a kiosk). Start's answer
replaces the entry query's data, so the player mounts on the attempt.

F-LIVE-01 reads: the student sees the open evaluations of their classrooms and
enters one in a single click; an attempt begins only by an explicit Start,
except for trusted clients (SEB, kiosk) and a retake.

## Consequences

- A link opened by curiosity, a preview in a chat client or a prefetch no
  longer consumes an attempt or burns the clock.
- One more request per attempt, and one more screen on the way in.
- `AttemptOrLobby` has a third member. The polls are not entered here and are
  unchanged.
- A student who opens an exam link and walks away holds no row: the dashboard
  lists them as not here, which is true.
- The home's retake confirmation is not changed by this decision.

## Alternatives considered

1. **Keep starting on entry, and only warn.** The clock still runs by the time
   the warning is read.
2. **Start in the lobby view with a new `kind: "lobby"` state.** The lobby
   watches the presence stream and begins as soon as the evaluation runs,
   which would loop; the ready screen needs its own kind.
3. **Create the row on entry and begin it only at Start.** It would still count
   the student present and show a `not_started` row for a look.
