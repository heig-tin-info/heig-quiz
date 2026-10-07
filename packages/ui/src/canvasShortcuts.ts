import { useEffect, useRef, type FocusEvent } from "react";

import type { CanvasShortcut, CanvasShortcutsListener } from "@quiz/core/client";

/**
 * A field a key types into rather than commands: the canvas editors leave
 * such a key alone, and lend no shortcut line while the caret is there.
 */
export const isTextField = (target: EventTarget | null): boolean =>
  target instanceof Element && target.matches("input, textarea, select, [contenteditable]");

/** The keys of `S` whose value is a sentence (a dictionary may hold lookups too). */
type SentenceKey<S> = { [K in keyof S]: S[K] extends string ? K : never }[keyof S];

/**
 * One line of a canvas's shortcut descriptor: its keys in the
 * `CanvasShortcut` spelling, and its label as a key of the canvas's own
 * dictionary, so the list is static and the words are the host's.
 */
export interface CanvasShortcutLine<S> {
  readonly keys: readonly string[];
  readonly label: SentenceKey<S>;
}

/**
 * Publishes a canvas editor's keys to the host's shortcut zone
 * (`EditorProps.onCanvasShortcuts`, issue #549) while the focus is inside
 * the editor and not in one of its text fields, and the editor is enabled
 * (editable, on its drawing). `null` once that stops being true — the focus
 * leaves, the editor is disabled, it unmounts — and the lines again when it
 * becomes true with the focus still inside (the diagram's Draw tab).
 *
 * It returns the two handlers the editor's root spreads. React's `onFocus`
 * and `onBlur` bubble, so a move between two controls of the editor is a
 * blur the root ignores (the focus stays inside) and a focus it reads again.
 */
export function useCanvasShortcuts<S>({
  publish,
  lines,
  strings,
  enabled,
}: {
  publish: CanvasShortcutsListener | undefined;
  lines: readonly CanvasShortcutLine<S>[];
  strings: S;
  enabled: boolean;
}): {
  onFocus: (e: FocusEvent<HTMLElement>) => void;
  onBlur: (e: FocusEvent<HTMLElement>) => void;
} {
  /** The focus is in the editor, outside a text field. */
  const inside = useRef(false);
  /** The host holds our lines: `null` is sent once, and only after them. */
  const shown = useRef(false);
  const listener = useRef(publish);
  useEffect(() => {
    listener.current = publish;
  }, [publish]);

  const send = (want: boolean): void => {
    if (want === shown.current || listener.current === undefined) return;
    shown.current = want;
    const list: CanvasShortcut[] = lines.map((line) => ({ keys: line.keys, label: strings[line.label] as string }));
    listener.current(want ? list : null);
  };

  useEffect(() => send(enabled && inside.current), [enabled]);
  useEffect(() => () => send(false), []);

  return {
    onFocus: (e) => {
      inside.current = !isTextField(e.target);
      send(enabled && inside.current);
    },
    onBlur: (e) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      inside.current = false;
      send(false);
    },
  };
}
