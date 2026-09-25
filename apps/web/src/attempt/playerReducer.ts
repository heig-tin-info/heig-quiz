/**
 * The player's state, as a pure reducer.
 *
 * Everything the zen player decides — where the student is, what they may
 * still write to, which question the arrows reach — is a function of the
 * `AttemptView` the server sent and of what happened since. Keeping it pure
 * is what makes the navigation rules testable without a browser, and it is
 * the only way the client rule and the server rule can agree: `lockedIds`
 * below and `lockedItemIds` of `apps/api/src/modules/live/attempt.ts` are the
 * SAME function, `@quiz/domain#lockedItems`.
 *
 * The server enforces the same rules on every write (deviation W5-15 also
 * sends `items[].locked`, which is why `load` adopts it). The client enforces
 * them so that a student is never offered something the server will refuse —
 * F-EVAL-07 ("un drapeau par item au-delà duquel on ne revient pas") and
 * F-LIVE-09 ("permet d'y aller si la navigation l'autorise").
 */
import type { AttemptItem, AttemptView, Navigation } from "@quiz/contracts";
import { answerMark, lockedItems } from "@quiz/domain";

import type { Segment } from "../ui";

export interface PlayerItem {
  id: string;
  position: number;
  points: number;
  type: string;
  milestone: boolean;
  /**
   * VALIDATED: "Validate and continue" in `forward_only`, a crossed
   * checkpoint in `milestones` (F-LIVE-08, issue #89).
   */
  markedDone: boolean;
  /** "I won't answer this question" (issue #89). */
  skipped: boolean;
  /** The student's review flag (issue #89). */
  flagged: boolean;
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
  /**
   * `answered`: the payload holds something (the type's `isAnswered`), which
   * takes back an "I won't answer" — the server does the same on its side.
   */
  | { type: "answer"; itemId: string; payload: unknown; answered?: boolean }
  | { type: "adopt"; itemId: string; payload: unknown }
  | { type: "done"; itemId: string; done: boolean }
  | { type: "skip"; itemId: string; skipped: boolean }
  | { type: "flag"; itemId: string; flagged: boolean };

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
  skipped: item.skipped,
  flagged: item.flagged,
  student: item.student,
  serverLocked: item.locked,
});

/**
 * Which items are closed to writing, and therefore to navigation.
 *
 * `free`: none. `forward_only`: every validated question. `milestones`:
 * everything up to and including the furthest validated checkpoint. The
 * server's rule, from the same function.
 */
export function lockedIds(state: PlayerState): Set<string> {
  return lockedItems(
    state.navigation,
    state.items.map((item) => ({
      id: item.id,
      milestone: item.milestone,
      validated: item.markedDone,
    })),
  );
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
 * The question list (F-LIVE-09, issue #89), one segment per question: its
 * mark — answered, "won't answer", or nothing yet — whether it is flagged,
 * whether it is closed, and where the student is. Whether an answer holds
 * SOMETHING is the question type's call, so it comes in as `answered` and
 * this module stays free of the registry.
 */
export function segmentsOf(
  state: PlayerState,
  answered: (type: string, answer: unknown) => boolean,
): Segment[] {
  const locked = lockedIds(state);
  return state.items.map((item, index) => ({
    id: item.id,
    mark: answerMark({
      answered: answered(item.type, state.answers[item.id] ?? null),
      skipped: item.skipped,
    }),
    current: index === state.index,
    flagged: item.flagged,
    locked: item.serverLocked || locked.has(item.id),
  }));
}

/** One item's own fields, replaced; the SAME state when nothing moved. */
function patchItem(state: PlayerState, itemId: string, patch: Partial<PlayerItem>): PlayerState {
  let changed = false;
  const items = state.items.map((item) => {
    if (item.id !== itemId) return item;
    const next = { ...item, ...patch };
    if ((Object.keys(patch) as (keyof PlayerItem)[]).every((k) => next[k] === item[k])) return item;
    changed = true;
    return next;
  });
  return changed ? { ...state, items } : state;
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
    case "adopt": {
      if (action.type === "answer" && isLocked(state, action.itemId)) return state;
      const next = { ...state, answers: { ...state.answers, [action.itemId]: action.payload } };
      return action.type === "answer" && action.answered === true
        ? patchItem(next, action.itemId, { skipped: false })
        : next;
    }
    case "skip":
      if (isLocked(state, action.itemId)) return state;
      return patchItem(state, action.itemId, { skipped: action.skipped });
    case "flag":
      if (isLocked(state, action.itemId)) return state;
      return patchItem(state, action.itemId, { flagged: action.flagged });
    case "done": {
      const items = state.items.map((item) =>
        item.id === action.itemId ? { ...item, markedDone: action.done } : item,
      );
      const next = { ...state, items };
      // F-LIVE-08: "Validate and continue" is irreversible AND moves on —
      // the question the student just closed is no longer reachable, so
      // staying on it would be a dead end.
      if (action.done && state.navigation !== "free" && action.itemId === currentItem(state)?.id) {
        const forward = neighbour(next, 1);
        if (forward !== null) return { ...next, index: forward };
      }
      return next;
    }
  }
}
