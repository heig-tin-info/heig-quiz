/**
 * The player's state, as a pure reducer.
 *
 * Everything the zen player decides — where the student is, what they may
 * still write to, which question the arrows reach — is a function of the
 * `AttemptView` the server sent and of what happened since. Keeping it pure
 * is what makes the navigation rules testable without a browser, and it is
 * the only way the client rule and the server rule can agree: `lockedIds`
 * below and `lockedItemIds` of `apps/api/src/modules/live/order.ts` are the
 * SAME function, `@quiz/domain#lockedItems`.
 *
 * The server enforces the same rules on every write (deviation W5-15 also
 * sends `items[].locked`, which is why `load` adopts it). The client enforces
 * them so that a student is never offered something the server will refuse —
 * F-EVAL-07 ("un drapeau par item au-delà duquel on ne revient pas") and
 * F-LIVE-09 ("permet d'y aller si la navigation l'autorise").
 */
import type { AttemptItem, AttemptView, ItemCorrection, ItemCounting, Navigation } from "@quiz/contracts";
import { answerMark, lockedItems } from "@quiz/domain";

import { markdownTitle } from "../markdown/outline";
import type { Segment } from "../ui";

export interface PlayerItem {
  id: string;
  position: number;
  points: number;
  type: string;
  milestone: boolean;
  /** ADR-052, ADR-108: a bonus is labelled "Bonus question"; its points are not in the total. */
  counting: ItemCounting;
  /**
   * ADR-084: the teacher's passage shown before the item; null for none. A
   * section's text (ADR-143) is on the first item of its section.
   */
  intro: string | null;
  /** ADR-143: the section the item belongs to (the id of the item opening it); null outside one. */
  section: string | null;
  /**
   * VALIDATED: "Validate and continue" in `forward_only`, a crossed
   * checkpoint in `milestones` (F-LIVE-08, issue #89).
   */
  markedDone: boolean;
  /** "I won't answer this question" (issue #89). */
  skipped: boolean;
  /** The student's review flag (issue #89). */
  flagged: boolean;
  /**
   * ADR-091: carried over from the previous attempt by a partial retake —
   * read-only, still reachable (it is not a navigation lock), the server
   * refusing any write to it.
   */
  acquired: boolean;
  /**
   * ADR-124 §3: checked in this attempt of an exercise — read-only for the
   * rest of it, still reachable (it is not a navigation lock), the server
   * refusing any write to it. Never taken back within an attempt.
   */
  checked: boolean;
  /** ADR-124 §3: its correction once checked, as the server built it; null before. */
  correction: ItemCorrection | null;
  /** What `toStudent` published. Opaque here; only the type's Player reads it. */
  student: unknown;
  /** The server's own verdict when the view was built. */
  serverLocked: boolean;
  /**
   * Bumped by `replace`: the question's content changed under the same item
   * id, and the player keys its question on both so the type's component
   * starts over rather than keeping state built for the old content.
   */
  generation?: number;
}

export interface PlayerState {
  items: PlayerItem[];
  /** Index into `items`, which is already in the student's own order. */
  index: number;
  navigation: Navigation;
  /** itemId → the answer payload, `null` for "opened, nothing written". */
  answers: Record<string, unknown>;
  /**
   * ADR-084: the items whose intro this player has passed ("Continue"), or
   * that were already started when the attempt loaded — for a section's
   * text (ADR-143), the first item of the section, passed once any of its
   * items is started. Held here, never stored: see {@link passageOf}.
   */
  passed: Readonly<Record<string, true>>;
}

export type PlayerAction =
  /**
   * `unsaved`: the items whose local answer is newer than the view's — typed
   * since, not yet acknowledged. A refetch that landed mid-typing must not
   * hand the editor back an older text.
   */
  | { type: "load"; view: AttemptView; unsaved?: ReadonlySet<string> }
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
  | { type: "flag"; itemId: string; flagged: boolean }
  /** ADR-124 §3: the server checked the question; its correction, as it answered. */
  | { type: "check"; itemId: string; correction: ItemCorrection }
  /** ADR-084: "Continue" on the passage screen: the question shows. */
  | { type: "pass"; itemId: string }
  /**
   * ADR-084: the passage's entry of the question list, chosen: its item, with
   * the text shown again (see {@link introReachable}).
   */
  | { type: "intro"; itemId: string }
  /**
   * The teacher's preview only (ADR-018, sixth addendum): one item moved to
   * a newer version of its question. Its content is replaced and its answer
   * dropped — written for another question; everything else stays.
   */
  | { type: "replace"; item: AttemptItem };

export const emptyPlayerState: PlayerState = {
  items: [],
  index: 0,
  navigation: "free",
  answers: {},
  passed: {},
};

const toItem = (item: AttemptItem): PlayerItem => ({
  id: item.id,
  position: item.position,
  points: item.points,
  type: item.type,
  milestone: item.milestone,
  counting: item.counting,
  intro: item.intro,
  section: item.section,
  markedDone: item.markedDone,
  skipped: item.skipped,
  flagged: item.flagged,
  acquired: item.acquired,
  checked: item.checked,
  correction: item.correction,
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

/**
 * Whether the student may still write to `itemId`: not closed by the
 * navigation, not carried over (ADR-091), not checked (ADR-124 §3). The
 * last two leave the question reachable, read-only.
 */
export function isWritable(state: PlayerState, itemId: string): boolean {
  const item = state.items.find((i) => i.id === itemId);
  return item !== undefined && !item.acquired && !item.checked && !isLocked(state, itemId);
}

export const currentItem = (state: PlayerState): PlayerItem | undefined => state.items[state.index];

/**
 * The item that opens the section of `item` in this order — the first of
 * its items, which carries the section's text (ADR-143) — or `undefined`
 * outside a section.
 */
function sectionHead(state: PlayerState, item: PlayerItem): PlayerItem | undefined {
  if (item.section === null) return undefined;
  const head = state.items.find((i) => i.section === item.section);
  return head?.intro === null ? undefined : head;
}

/** Whether `item` carries its section's text (ADR-143). */
const headsSection = (state: PlayerState, item: PlayerItem): boolean => sectionHead(state, item) === item;

/**
 * The item whose text the passage screen shows (ADR-084), or `null`. One
 * rule for every navigation: a text shows on arriving at its item until
 * Continue; a section's text (ADR-143) shows on arriving at ANY item of its
 * section until it is passed — Continue, or an item of the section started —
 * so a student jumping to its third question reads it first. An item's own
 * text inside a section comes after its section's. What differs between
 * navigations is only whether the list can bring a text back
 * ({@link introReachable}).
 */
export function passageItem(state: PlayerState): PlayerItem | null {
  const item = currentItem(state);
  if (!item) return null;
  const head = sectionHead(state, item);
  if (head !== undefined && head !== item && state.passed[head.id] !== true) return head;
  return item.intro !== null && state.passed[item.id] !== true ? item : null;
}

/** The text of the passage screen ({@link passageItem}), `null` when the question shows. */
export function passageOf(state: PlayerState): string | null {
  return passageItem(state)?.intro ?? null;
}

/**
 * The questions a section's text on screen applies to, numbered in the
 * student's order (`from` to `to`, both counted from 1), or `null` when the
 * passage is not a section's or its section holds one question.
 */
export function passageSpan(state: PlayerState): { from: number; to: number } | null {
  const item = passageItem(state);
  if (item === null || !headsSection(state, item)) return null;
  const from = state.items.indexOf(item);
  const count = state.items.filter((i) => i.section === item.section).length;
  // The items of a section are contiguous in the student's order, its head first.
  return count > 1 ? { from: from + 1, to: from + count } : null;
}

/**
 * Whether the passage before `itemId` can be opened from the question list:
 * the item has an intro and can be reached, and — outside `free` navigation —
 * the text has not been passed yet. In `forward_only` and `milestones`
 * Continue is one way, which is what makes "memorise this, then answer"
 * possible (ADR-084 §6); before that, the entry leads where the question's
 * would. The one rule behind the entry's lock and the `intro` action.
 */
export function introReachable(state: PlayerState, itemId: string): boolean {
  const index = state.items.findIndex((i) => i.id === itemId);
  const item = state.items[index];
  if (item === undefined || item.intro === null || !canReach(state, index)) return false;
  return state.navigation === "free" || state.passed[itemId] !== true;
}

/**
 * Where the student stands while the text of `itemId` is read again: on the
 * question they are on when it is of the same section (ADR-143: a section's
 * text is reread from any of its questions, and Continue leads back there),
 * on the text's own item otherwise.
 */
function readingIndex(state: PlayerState, itemId: string): number {
  const current = currentItem(state);
  const head = current === undefined ? undefined : sectionHead(state, current);
  return head?.id === itemId ? state.index : state.items.findIndex((i) => i.id === itemId);
}

/**
 * The prefix of a passage's entry in the question list. An item id is a
 * UUID, so it cannot meet a question's own entry.
 */
const PASSAGE = "intro:";

/** What choosing an entry of the question list does: open a passage, or go to a question. */
export function selectEntry(entryId: string): PlayerAction {
  return entryId.startsWith(PASSAGE)
    ? { type: "intro", itemId: entryId.slice(PASSAGE.length) }
    : { type: "goto", itemId: entryId };
}

/** Already started: an answer, "Leave unanswered", or validated. Its intro is behind the student. */
const started = (item: AttemptItem): boolean =>
  item.answer !== null || item.skipped || item.markedDone;

/**
 * Whether the text before `item` is behind the student when the attempt
 * loads (ADR-084): its item is started. A section's text (ADR-143), on its
 * first item, once any item of the section is started — but not by one
 * carried over by a partial retake (ADR-091), which must not swallow the
 * text of a section it retakes; with nothing of it retaken, it is passed.
 */
function passedOnLoad(items: readonly AttemptItem[], item: AttemptItem): boolean {
  const members = item.section === null ? [] : items.filter((i) => i.section === item.section);
  if (members[0] !== item) return started(item);
  return members.some((i) => started(i) && !i.acquired) || members.every((i) => i.acquired);
}

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
 *
 * An item with an intro (ADR-084) gets an entry before its question, named by
 * the text's first heading: current while the passage is on screen, closed
 * once it cannot be opened again ({@link introReachable}). Its mark is the
 * neutral "unanswered", never drawn: reading a text is not recorded.
 */
export function segmentsOf(
  state: PlayerState,
  answered: (type: string, answer: unknown) => boolean,
): Segment[] {
  const locked = lockedIds(state);
  const reading = passageItem(state);
  return state.items.flatMap((item, index) => {
    const mark = answerMark({
      answered: answered(item.type, state.answers[item.id] ?? null),
      skipped: item.skipped,
    });
    // ADR-143: a section's questions, and the texts of their own, stand
    // indented under the section's text; that text's entry does not.
    const indent = item.section !== null ? { indent: true } : {};
    const question: Segment = {
      id: item.id,
      mark,
      current: index === state.index && reading === null,
      flagged: item.flagged,
      locked: item.serverLocked || locked.has(item.id),
      ...indent,
    };
    if (item.intro === null) return [question];
    const passage: Segment = {
      id: `${PASSAGE}${item.id}`,
      mark: "unanswered",
      current: reading === item,
      locked: !introReachable(state, item.id),
      passage: { title: markdownTitle(item.intro) },
      ...(headsSection(state, item) ? {} : indent),
    };
    return [passage, question];
  });
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
      // A check is never taken back within an attempt: a view read before
      // the check landed must not reopen the question it locked.
      const before = new Map(state.items.map((item) => [item.id, item]));
      const items = action.view.items.map((viewItem) => {
        const item = toItem(viewItem);
        const prior = before.get(item.id);
        return !item.checked && prior?.checked === true
          ? { ...item, checked: true, correction: prior.correction }
          : item;
      });
      const answers: Record<string, unknown> = {};
      for (const item of action.view.items) {
        if (action.unsaved?.has(item.id) === true && item.id in state.answers) {
          answers[item.id] = state.answers[item.id];
        } else if (item.answer !== null) {
          answers[item.id] = item.answer;
        }
      }
      // F-LIVE-06: the position comes back with the answers — on the first
      // load. A refetch keeps the question on screen: the bookmark it carries
      // may predate the student's last move. An unknown `lastItemId` (a
      // shuffled order the server no longer serves) falls back to the first
      // question rather than to nothing.
      const resumed = currentItem(state)?.id ?? action.view.attempt.lastItemId;
      const index = Math.max(
        0,
        items.findIndex((i) => i.id === resumed),
      );
      // ADR-084: a passage once passed stays passed across a refetch; one
      // whose item is already started is not shown again after a reload.
      // Only for an item this player does not track yet: a refetch must not
      // close again a text the student reopened from the list.
      const passed: Record<string, true> = { ...state.passed };
      for (const item of action.view.items) {
        if (!before.has(item.id) && passedOnLoad(action.view.items, item)) passed[item.id] = true;
      }
      return {
        items,
        index,
        navigation: action.view.evaluation.settings.navigation,
        answers,
        passed,
      };
    }
    case "pass":
      if (state.passed[action.itemId] === true) return state;
      return { ...state, passed: { ...state.passed, [action.itemId]: true } };
    case "intro": {
      if (!introReachable(state, action.itemId)) return state;
      // Already on screen: nothing moves.
      if (passageItem(state)?.id === action.itemId) return state;
      const { [action.itemId]: _reopened, ...passed } = state.passed;
      return { ...state, index: readingIndex(state, action.itemId), passed };
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
      if (action.type === "answer" && !isWritable(state, action.itemId)) return state;
      const next = { ...state, answers: { ...state.answers, [action.itemId]: action.payload } };
      return action.type === "answer" && action.answered === true
        ? patchItem(next, action.itemId, { skipped: false })
        : next;
    }
    case "skip":
      if (!isWritable(state, action.itemId)) return state;
      return patchItem(state, action.itemId, { skipped: action.skipped });
    case "flag":
      if (!isWritable(state, action.itemId)) return state;
      return patchItem(state, action.itemId, { flagged: action.flagged });
    case "check":
      return patchItem(state, action.itemId, { checked: true, correction: action.correction });
    case "replace": {
      const { id } = action.item;
      if (!state.items.some((item) => item.id === id)) return state;
      const items = state.items.map((item) =>
        item.id === id
          ? {
              ...toItem(action.item),
              // New content, no answer: nothing is validated any more. Kept
              // done, the question would stay locked (forward_only,
              // milestones) with no answer in it.
              markedDone: false,
              flagged: item.flagged,
              generation: (item.generation ?? 0) + 1,
            }
          : item,
      );
      const { [id]: _dropped, ...answers } = state.answers;
      return { ...state, items, answers };
    }
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
