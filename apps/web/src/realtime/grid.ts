/*
 * The live grid as a pure value, and the one function that moves it.
 *
 * The dashboard is a read model the server already computed once
 * (`GET /evaluations/:id/dashboard`). While it is open, the SSE stream sends
 * the differences instead of asking the teacher's browser to fetch thirty
 * rows every second: a `dashboard.cell` per answered question, a
 * `dashboard.presence` per connection, an `evaluation.state` per teacher
 * control, a `lobby.count` while nobody has started yet.
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

/** Present / enrolled, from the event when there is one, from the rows otherwise. */
export function presence(state: GridState): LobbyCount {
  return (
    state.lobby ?? {
      present: state.view.rows.filter((r) => r.online).length,
      enrolled: state.view.rows.length,
    }
  );
}

/**
 * How many rows the server counts as "started". `totals[].completion` is a
 * share of those, not of the roster: a class of twenty-four where six have
 * opened the quiz is at 100 % on question 1 when those six have done it.
 */
function startedRows(rows: readonly DashboardRow[]): number {
  return rows.filter((r) => r.attemptId !== null).length;
}

/** Recomputes the completion of ONE item, the same way `dashboardView` does. */
function recomputeTotals(view: DashboardView, itemId: string): DashboardView["totals"] {
  const started = startedRows(view.rows);
  let changed = false;
  const totals = view.totals.map((total) => {
    if (total.itemId !== itemId) return total;
    const done = view.rows.filter(
      (r) => r.cells.find((c) => c.itemId === itemId)?.status === "done",
    ).length;
    const completion = started === 0 ? 0 : Math.round((done / started) * 100) / 100;
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
  const next: DashboardCell = {
    ...cell,
    status: event.status,
    revision: event.revision,
    points: event.points,
    // `summary` only travels when the teacher asked for the answers; keeping
    // the previous one on a null would show an answer the toggle just hid.
    summary: event.summary,
  };
  if (
    next.status === cell.status &&
    next.revision === cell.revision &&
    next.points === cell.points &&
    next.summary === cell.summary
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
