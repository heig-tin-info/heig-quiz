/**
 * The player's state, as a pure reducer.
 *
 * Everything the zen player decides — where the student is, what they may
 * still write to, which question the arrows reach — is a function of the
 * `AttemptView` the server sent and of what happened since. Keeping it pure
 * is what makes the navigation rules testable without a browser, and it is
 * the only way the client rule and the server rule can be compared line by
 * line: `lockedIds` below is `lockedItemIds` of
 * `apps/api/src/modules/live/service.ts`, rewritten in the same order.
 *
 * The server enforces the same rules on every write (deviation W5-15 also
 * sends `items[].locked`, which is why `load` adopts it). The client enforces
 * them so that a student is never offered something the server will refuse —
 * F-EVAL-07 ("un drapeau par item au-delà duquel on ne revient pas") and
 * F-LIVE-09 ("permet d'y aller si la navigation l'autorise").
 */
import type { AttemptItem, AttemptView, Navigation } from "@quiz/contracts";

import type { Segment } from "../ui";

export interface PlayerItem {
  id: string;
  position: number;
  points: number;
  type: string;
  milestone: boolean;
  markedDone: boolean;
  /** What `toStudent` published. Opaque here; only the type's Player reads it. */
  student: unknown;
  /** The server's own verdict when the view was built. */
  serverLocked: boolean;
}

export interface PlayerState {
  items: PlayerItem[];
  /** Index into `items`, which is already in the student's own order. */
  index: number;
  navigation: Navigation;
  /** itemId → the answer payload, `null` for "opened, nothing written". */
  answers: Record<string, unknown>;
}

export type PlayerAction =
  | { type: "load"; view: AttemptView }
  | { type: "goto"; itemId: string }
  | { type: "move"; delta: 1 | -1 }
  | { type: "answer"; itemId: string; payload: unknown }
  | { type: "adopt"; itemId: string; payload: unknown }
  | { type: "done"; itemId: string; done: boolean };

export const emptyPlayerState: PlayerState = {
  items: [],
  index: 0,
  navigation: "free",
  answers: {},
};

const toItem = (item: AttemptItem): PlayerItem => ({
  id: item.id,
  position: item.position,
  points: item.points,
  type: item.type,
  milestone: item.milestone,
  markedDone: item.markedDone,
  student: item.student,
  serverLocked: item.locked,
});

/**
 * Which items are closed to writing, and therefore to navigation.
 *
 * `free`: none. `forward_only`: every question already marked done.
 * `milestones`: everything up to and including the furthest validated
 * milestone. Identical to the server's rule, on purpose.
 */
export function lockedIds(state: PlayerState): Set<string> {
  const locked = new Set<string>();
  if (state.navigation === "free") return locked;
  if (state.navigation === "forward_only") {
    for (const item of state.items) if (item.markedDone) locked.add(item.id);
    return locked;
  }
  let furthest = -1;
  state.items.forEach((item, rank) => {
    if (item.milestone && item.markedDone) furthest = rank;
  });
  state.items.forEach((item, rank) => {
    if (rank <= furthest) locked.add(item.id);
  });
  return locked;
}

export function isLocked(state: PlayerState, itemId: string): boolean {
  const item = state.items.find((i) => i.id === itemId);
  // The server's verdict is kept as a floor: it knows about writes this
  // client never saw (another tab, a teacher action).
  return (item?.serverLocked ?? false) || lockedIds(state).has(itemId);
}

/** A locked question is out of reach: one does not come back (F-EVAL-07). */
export function canReach(state: PlayerState, index: number): boolean {
  const item = state.items[index];
  if (!item) return false;
  if (index === state.index) return true;
  return !isLocked(state, item.id);
}

export const currentItem = (state: PlayerState): PlayerItem | undefined => state.items[state.index];

/** The next index the arrows would land on, or `null` when there is none. */
export function neighbour(state: PlayerState, delta: 1 | -1): number | null {
  for (let i = state.index + delta; i >= 0 && i < state.items.length; i += delta) {
    if (canReach(state, i)) return i;
  }
  return null;
}

/**
 * The progress strip, one segment per question: where the student is, what
 * they marked done, what holds an answer. Whether an answer holds SOMETHING
 * is the question type's call, so it comes in as `answered` and this module
 * stays free of the registry.
 */
export function segmentsOf(
  state: PlayerState,
  answered: (type: string, answer: unknown) => boolean,
): Segment[] {
  return state.items.map((item, index) => ({
    id: item.id,
    state:
      index === state.index
        ? "current"
        : item.markedDone
          ? "done"
          : answered(item.type, state.answers[item.id] ?? null)
            ? "answered"
            : "empty",
  }));
}

export function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case "load": {
      const items = action.view.items.map(toItem);
      const answers: Record<string, unknown> = {};
      for (const item of action.view.items) {
        if (item.answer !== null) answers[item.id] = item.answer;
      }
      // F-LIVE-06: the position comes back with the answers. An unknown
      // `lastItemId` (a shuffled order the server no longer serves) falls
      // back to the first question rather than to nothing.
      const resumed = action.view.attempt.lastItemId;
      const index = Math.max(
        0,
        items.findIndex((i) => i.id === resumed),
      );
      return { items, index, navigation: action.view.evaluation.settings.navigation, answers };
    }
    case "goto": {
      const index = state.items.findIndex((i) => i.id === action.itemId);
      if (index < 0 || !canReach(state, index)) return state;
      return { ...state, index };
    }
    case "move": {
      const index = neighbour(state, action.delta);
      return index === null ? state : { ...state, index };
    }
    case "answer":
    case "adopt":
      if (action.type === "answer" && isLocked(state, action.itemId)) return state;
      return { ...state, answers: { ...state.answers, [action.itemId]: action.payload } };
    case "done": {
      const items = state.items.map((item) =>
        item.id === action.itemId ? { ...item, markedDone: action.done } : item,
      );
      const next = { ...state, items };
      // F-LIVE-08: in `forward_only` marking done is irreversible AND moves
      // on — the question the student just closed is no longer reachable, so
      // staying on it would be a dead end.
      if (action.done && state.navigation !== "free" && action.itemId === currentItem(state)?.id) {
        const forward = neighbour(next, 1);
        if (forward !== null) return { ...next, index: forward };
      }
      return next;
    }
  }
}
