import { useEffect, useRef, type FocusEvent } from "react";

import type { CanvasShortcut, CanvasShortcutsListener } from "@quiz/core/client";

/**
 * Publishes a canvas editor's keys to the host's shortcut zone
 * (`EditorProps.onCanvasShortcuts`, issue #549) while the focus is inside
 * the editor and NOT in one of its text fields — there a key is a character,
 * and the editor ignores it. `null` once the focus leaves, the editor turns
 * read-only, or it unmounts. Nothing at all without a listener or while
 * disabled: a read-only canvas publishes nothing.
 *
 * It returns the two handlers the editor's root spreads. React's `onFocus`
 * and `onBlur` bubble, so a move between two controls of the editor is a
 * blur the root ignores (the focus stays inside) and a focus it reads again.
 */
export function useCanvasShortcuts({
  publish,
  list,
  enabled,
  isTextField,
}: {
  publish: CanvasShortcutsListener | undefined;
  list: readonly CanvasShortcut[];
  enabled: boolean;
  /** The editor's own reading of "a field the keys do not reach". */
  isTextField: (target: EventTarget | null) => boolean;
}): {
  onFocus: (e: FocusEvent<HTMLElement>) => void;
  onBlur: (e: FocusEvent<HTMLElement>) => void;
} {
  /** Whether the host holds our lines now, so `null` is sent once, and only after a list. */
  const shown = useRef(false);
  const listener = useRef(publish);
  useEffect(() => {
    listener.current = publish;
  }, [publish]);

  const send = (next: readonly CanvasShortcut[] | null): void => {
    if (next === null && !shown.current) return;
    shown.current = next !== null;
    listener.current?.(next);
  };

  useEffect(() => {
    if (!enabled) send(null);
  }, [enabled]);
  useEffect(() => () => send(null), []);

  return {
    onFocus: (e) => {
      if (!enabled || publish === undefined) return;
      send(isTextField(e.target) ? null : list);
    },
    onBlur: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) send(null);
    },
  };
}
