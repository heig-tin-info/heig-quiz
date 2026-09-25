/*
 * The live grid as a pure value, and the one function that moves it.
 *
 * The dashboard is a read model the server already computed once
 * (`GET /evaluations/:id/dashboard`). While it is open, the SSE stream sends
 * the differences instead of asking the teacher's browser to fetch thirty
 * rows every second: a `dashboard.cell` per answered question, a
 * `dashboard.presence` per connection, a `dashboard.attempt` per student who
 * enters or starts, an `evaluation.state` per teacher control, a
 * `lobby.count` while nobody has started yet.
 *
 * Applying them is a pure function of (state, event), kept away from React on
 * purpose: this is the part where a wrong answer means a teacher reading a
 * wrong grid, and it is the part worth testing without a DOM. Two properties
 * the callers rely on:
 *
 *   - an event that changes nothing returns the SAME object. React then
 *     re-renders nothing, which is what keeps a 30 x 12 grid still while a
 *     class of twenty-four types;
 *   - a `dashboard.cell` older than what the cell already holds is dropped.
 *     The coalescer publishes per (attemptId, itemId), the network does not
 *     promise an order, and a student's revision counter is monotonic: the
 *     lower revision is the stale one, always.
 */
import type { DashboardCell, DashboardRow, DashboardView, ServerEvent } from "@quiz/contracts";
import { countsAsCompleted, round2 } from "@quiz/domain";

/** The lobby figures, which live outside `DashboardView` (F-LIVE-02). */
export interface LobbyCount {
  present: number;
  enrolled: number;
}

/**
 * Everything one dashboard page holds. `lobby` is null until a `lobby.count`
 * lands; the header then falls back to counting the rows, which is the same
 * number one refresh later.
 */
export interface GridState {
  view: DashboardView;
  lobby: LobbyCount | null;
}

export function initialGrid(view: DashboardView): GridState {
  return { view, lobby: null };
}

/**
 * Present / enrolled, for the header counter and the lobby ring.
 *
 * `present` is counted from the ROWS, never from the last `lobby.count`. The
 * two travel on different channels: `dashboard.presence` moves one row's dot,
 * `lobby.count` is a whole-room figure the server only publishes when a
 * stream opens or closes. Reading the second made the header disagree with
 * the dots right beside it — "0 of 6 connected" under a green name — and it
 * stayed wrong until the teacher reloaded. The rows are the per-student truth
 * the grid already keeps current, so they answer both questions.
 *
 * `enrolled` still comes from the event when there is one: it counts the
 * roster lines nobody has claimed yet, which have no row here.
 */
export function presence(state: GridState): LobbyCount {
  return {
    present: state.view.rows.filter((r) => r.online).length,
    enrolled: state.lobby?.enrolled ?? state.view.rows.length,
  };
}

/**
 * How many rows the server counts as "started". `totals[].completion` is a
 * share of those, not of the roster: a class of twenty-four where six have
 * opened the quiz is at 100 % on question 1 when those six have done it.
 */
function startedRows(rows: readonly DashboardRow[]): number {
  return rows.filter((r) => r.attemptId !== null).length;
}

/**
 * Recomputes the completion of ONE item, the same way `dashboardView` does —
 * or of every item when `itemId` is null, which is what a row that just
 * acquired an attempt needs: it moves the DENOMINATOR of all of them.
 */
function recomputeTotals(view: DashboardView, itemId: string | null): DashboardView["totals"] {
  const started = startedRows(view.rows);
  let changed = false;
  const totals = view.totals.map((total) => {
    if (itemId !== null && total.itemId !== itemId) return total;
    // The server's rule (`dashboardView`): answered, skipped or validated.
    const done = view.rows.filter((r) => {
      const status = r.cells.find((c) => c.itemId === total.itemId)?.status;
      return status !== undefined && countsAsCompleted(status);
    }).length;
    const completion = started === 0 ? 0 : round2(done / started);
    if (completion === total.completion) return total;
    changed = true;
    return { ...total, completion };
  });
  return changed ? totals : view.totals;
}

/** Replaces one row, keeping every identity untouched when nothing moved. */
function withRow(
  view: DashboardView,
  index: number,
  row: DashboardRow,
): DashboardView {
  if (row === view.rows[index]) return view;
  const rows = view.rows.slice();
  rows[index] = row;
  return { ...view, rows };
}

function applyCell(state: GridState, event: Extract<ServerEvent, { type: "dashboard.cell" }>): GridState {
  const { view } = state;
  if (event.evaluationId !== view.evaluation.id) return state;
  const index = view.rows.findIndex((r) => r.attemptId === event.attemptId);
  if (index < 0) return state;
  const row = view.rows[index]!;
  const cellIndex = row.cells.findIndex((c) => c.itemId === event.itemId);
  if (cellIndex < 0) return state;
  const cell = row.cells[cellIndex]!;
  // The stale-write rule of the autosave protocol, read from the other end.
  if (event.revision < cell.revision) return state;
  /*
   * The verdict the frame carries is the LIVE one (ADR-020): the answer just
   * changed, so a verdict computed from the previous one is stale whatever it
   * said. A cell that already holds a real grading keeps it — the frame
   * cannot produce one, and a teacher's validated verdict is not overwritten
   * by a preview.
   */
  const keepGrading = cell.verdict !== null && !cell.provisional;
  const next: DashboardCell = {
    ...cell,
    status: event.status,
    revision: event.revision,
    points: event.points,
    verdict: keepGrading ? cell.verdict : event.verdict,
    provisional: keepGrading ? cell.provisional : event.verdict !== null,
    // `summary` only travels when the teacher asked for the answers; keeping
    // the previous one on a null would show an answer the toggle just hid.
    summary: event.summary,
    // Every frame carries the WHOLE cell, the flag included (issue #89).
    flagged: event.flagged,
  };
  if (
    next.status === cell.status &&
    next.revision === cell.revision &&
    next.points === cell.points &&
    next.verdict === cell.verdict &&
    next.provisional === cell.provisional &&
    next.summary === cell.summary &&
    next.flagged === cell.flagged
  ) {
    return state;
  }
  const cells = row.cells.slice();
  cells[cellIndex] = next;
  let updated = withRow(view, index, { ...row, cells });
  const totals = recomputeTotals(updated, event.itemId);
  if (totals !== updated.totals) updated = { ...updated, totals };
  return { ...state, view: updated };
}

function applyPresence(
  state: GridState,
  event: Extract<ServerEvent, { type: "dashboard.presence" }>,
): GridState {
  const { view } = state;
  if (event.evaluationId !== view.evaluation.id) return state;
  const index = view.rows.findIndex((r) => r.userId === event.userId);
  if (index < 0) return state;
  const row = view.rows[index]!;
  if (row.online === event.online && row.lastSeenAt === event.lastSeenAt) return state;
  const updated = withRow(view, index, {
    ...row,
    online: event.online,
    lastSeenAt: event.lastSeenAt,
  });
  return { ...state, view: updated };
}

/**
 * The row of a student who just entered or just started (F-DASH-03).
 *
 * The roster row exists from the first fetch with `attemptId: null` and
 * `state: "not_started"`; nothing else in the stream ever filled those in, so
 * a student who was visibly ONLINE still read "never connected" until the
 * teacher reloaded. `dashboard.cell` is keyed by `attemptId` too, so this is
 * also what lets the very first answer of a student land in the grid.
 */
function applyAttempt(
  state: GridState,
  event: Extract<ServerEvent, { type: "dashboard.attempt" }>,
): GridState {
  const { view } = state;
  if (event.evaluationId !== view.evaluation.id) return state;
  const index = view.rows.findIndex((r) => r.userId === event.userId);
  if (index < 0) return state;
  const row = view.rows[index]!;
  const gainedAnAttempt = row.attemptId === null;
  if (
    row.attemptId === event.attemptId &&
    row.state === event.state &&
    row.deadlineAt === event.deadlineAt
  ) {
    return state;
  }
  let updated = withRow(view, index, {
    ...row,
    attemptId: event.attemptId,
    state: event.state,
    deadlineAt: event.deadlineAt,
  });
  if (gainedAnAttempt) {
    // One more started row: every completion is a share of THOSE.
    const totals = recomputeTotals(updated, null);
    if (totals !== updated.totals) updated = { ...updated, totals };
  }
  return { ...state, view: updated };
}

function applyState(
  state: GridState,
  event: Extract<ServerEvent, { type: "evaluation.state" }>,
): GridState {
  const { view } = state;
  if (event.evaluationId !== view.evaluation.id) return state;
  const evaluation = view.evaluation;
  if (
    evaluation.state === event.state &&
    evaluation.pausedAt === event.pausedAt &&
    evaluation.closesAt === event.closesAt
  ) {
    return state;
  }
  return {
    ...state,
    view: {
      ...view,
      evaluation: {
        ...evaluation,
        state: event.state,
        pausedAt: event.pausedAt,
        closesAt: event.closesAt,
        serverNow: event.serverNow,
      },
    },
  };
}

function applyDeadline(
  state: GridState,
  event: Extract<ServerEvent, { type: "attempt.deadline" }>,
): GridState {
  const index = state.view.rows.findIndex((r) => r.attemptId === event.attemptId);
  if (index < 0) return state;
  const row = state.view.rows[index]!;
  if (row.deadlineAt === event.deadlineAt) return state;
  return { ...state, view: withRow(state.view, index, { ...row, deadlineAt: event.deadlineAt }) };
}

function applyClosed(
  state: GridState,
  event: Extract<ServerEvent, { type: "attempt.closed" }>,
): GridState {
  if (event.evaluationId !== state.view.evaluation.id) return state;
  const index = state.view.rows.findIndex((r) => r.attemptId === event.attemptId);
  if (index < 0) return state;
  const row = state.view.rows[index]!;
  // The server stores `submitted` only when the student handed in; a deadline
  // and a teacher both leave `expired` (live/service.ts#closeAttempt).
  const next = event.closedBy === "student" ? "submitted" : "expired";
  if (row.state === next) return state;
  return { ...state, view: withRow(state.view, index, { ...row, state: next }) };
}

/**
 * Folds one server event into the grid. Anything the grid does not read —
 * `clock`, `runner.result`, `grading.progress`, `hint`, a `snapshot` of
 * another subject — leaves it untouched, by identity.
 */
export function applyGridEvent(state: GridState, event: ServerEvent): GridState {
  switch (event.type) {
    case "dashboard.cell":
      return applyCell(state, event);
    case "dashboard.presence":
      return applyPresence(state, event);
    case "dashboard.attempt":
      return applyAttempt(state, event);
    case "evaluation.state":
      return applyState(state, event);
    case "attempt.deadline":
      return applyDeadline(state, event);
    case "attempt.closed":
      return applyClosed(state, event);
    case "lobby.count":
      if (event.evaluationId !== state.view.evaluation.id) return state;
      if (
        state.lobby !== null &&
        state.lobby.present === event.present &&
        state.lobby.enrolled === event.enrolled
      ) {
        return state;
      }
      return { ...state, lobby: { present: event.present, enrolled: event.enrolled } };
    default:
      return state;
  }
}
