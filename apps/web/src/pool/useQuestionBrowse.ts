import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import type { QuestionRow } from "@quiz/contracts";

import { listboxIndex } from "../ui";
import type { QuestionGroup } from "./QuestionGroups";

/** A row as the list draws it: a question may repeat (grouped by concept), so it is keyed by section. */
interface Entry {
  key: string;
  row: QuestionRow;
}

/**
 * How long a click on a narrow window waits for a second one. There the pane
 * REPLACES the list, so a look taken at once would pull the row from under
 * the second click of a double-click, and the editor would never open. Not
 * under a coarse pointer: a touch screen has no double-click to wait for.
 */
const DOUBLE_CLICK_MS = 300;

export const entryKey = (group: QuestionGroup, row: QuestionRow) => `${group.key}:${row.id}`;

/**
 * Browsing the questions of a pool: LOOKING at one and EDITING it are two
 * gestures, shared by the table and the cards.
 *
 * - a click shows the question in the reading pane (`shown`) — on a narrow
 *   window once it is clear the click is not the first of a double-click;
 * - ↑/↓ (Home/End) move the focus through the rows in the order they are
 *   DRAWN — sections included, not the order the server sent — and stop at
 *   the last loaded one. Where the pane can dock, the row reached is SHOWN
 *   (the pane opens if it was closed): browsing with the arrows is the point;
 *   on a narrow window the pane would take the list away, so they only move;
 * - P shows the focused row in every layout — the keyboard's click, and the
 *   only way in on a narrow window;
 * - Enter and a double-click open the editor, like the row's pencil;
 * - Space stars the question, or unstars it (F-POOL-10): the row's own star
 *   button, from the keyboard. Only a key pressed ON the row — Space in the
 *   filter bar, a tick box, a button or the pane keeps its own meaning;
 * - `close` (Escape and the ✕, wired by the screen) hands the focus back to
 *   the row the pane showed.
 *
 * One row is in the Tab order (a roving tabindex): the one last focused or
 * shown, the first one otherwise. A key that started on a control inside the
 * row (the tick box, an action) is that control's.
 *
 * Why not `pressable()`: it fires on Enter AND Space, which is right for
 * every other clickable card of the app and wrong here, where a click does
 * not do what Enter does.
 */
export function useQuestionBrowse(
  groups: QuestionGroup[],
  onEdit: (row: QuestionRow) => void,
  /** The pane sits beside the list; otherwise it takes the list's place and arrows have nothing to follow. */
  docked: boolean,
  /** A touch screen: a tap shows at once, there is no double-click to wait for. */
  coarse: boolean,
  /** Space on a row: toggles its star. A soft-deleted question has none. */
  onStar: (row: QuestionRow) => void,
) {
  const entries = useMemo<Entry[]>(
    () => groups.flatMap((group) => group.rows.map((row) => ({ key: entryKey(group, row), row }))),
    [groups],
  );
  const indexOf = useMemo(() => new Map(entries.map((e, i) => [e.key, i])), [entries]);
  const [shown, setShown] = useState<Entry | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  // Set by a close: the next render with the list on screen hands the focus
  // back to the row (on a narrow window, the list has just been remounted).
  const refocus = useRef(false);
  const pendingLook = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pendingLook.current), []);

  const activeKey = active !== null && indexOf.has(active) ? active : (entries[0]?.key ?? null);

  useEffect(() => {
    if (!refocus.current || shown !== null) return;
    refocus.current = false;
    if (activeKey !== null) nodes.current.get(activeKey)?.focus();
  }, [shown, activeKey]);

  const close = () => {
    refocus.current = true;
    setShown(null);
  };

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    const entry = entries[index]!;
    if (e.key === "Enter") {
      e.preventDefault();
      onEdit(entry.row);
      return;
    }
    if (e.key === " ") {
      e.preventDefault();
      if (!entry.row.deletedAt) onStar(entry.row);
      return;
    }
    if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      setShown(entry);
      return;
    }
    const next = listboxIndex(e.key, index, entries.length, { ends: true, wrap: false });
    if (next === null) return;
    e.preventDefault();
    const to = entries[next]!;
    setActive(to.key);
    if (docked) setShown(to);
    nodes.current.get(to.key)?.focus();
  };

  /** What a row (or a card) spreads on its own element. */
  const rowProps = (key: string, row: QuestionRow) => ({
    ref: (el: HTMLElement | null) => {
      if (el) nodes.current.set(key, el);
      else nodes.current.delete(key);
    },
    tabIndex: key === activeKey ? 0 : -1,
    "aria-current": shown?.key === key ? true : undefined,
    "aria-keyshortcuts": "P Enter Space",
    onClick: (e: MouseEvent) => {
      if (e.detail > 1) return;
      setActive(key);
      clearTimeout(pendingLook.current);
      if (docked || coarse) setShown({ key, row });
      else pendingLook.current = setTimeout(() => setShown({ key, row }), DOUBLE_CLICK_MS);
    },
    onDoubleClick: (e: MouseEvent) => {
      // Two quick clicks on the tick box or an action are two ticks or two
      // actions, never a way into the editor.
      if ((e.target as Element).closest("button, input, label, a")) return;
      clearTimeout(pendingLook.current);
      onEdit(row);
    },
    onKeyDown: (e: KeyboardEvent) => onKeyDown(e, indexOf.get(key)!),
    onFocus: (e: FocusEvent) => {
      if (e.target === e.currentTarget) setActive(key);
    },
  });

  // The row as the latest page has it (a publication moves its version), or
  // as it was clicked when a narrower search has since hidden it.
  const current = shown && (entries.find((e) => e.row.id === shown.row.id)?.row ?? shown.row);
  return { shown: current, rowProps, close };
}

export type RowProps = ReturnType<ReturnType<typeof useQuestionBrowse>["rowProps"]>;
