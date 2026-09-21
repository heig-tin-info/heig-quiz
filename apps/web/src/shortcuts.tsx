import { useEffect, useSyncExternalStore } from "react";

/**
 * The keyboard shortcuts that are LIVE right now, for the strip the sidebar
 * shows above the account row.
 *
 * A screen registers the shortcuts it answers to while it is mounted (the
 * question editor: Ctrl+S, Ctrl+Enter…), and a focused control registers its
 * own on top while it has the focus (a rich-text field: Ctrl+B, Ctrl+I; a
 * choice: Tab adds one). The strip reads the union, in registration order,
 * so what it shows follows both the page and the caret.
 *
 * `useScreenCommands` next door feeds the palette; this feeds the eye. Two
 * registries on purpose: a shortcut is not always a command (Ctrl+B is not
 * in the palette) and a command rarely has a key.
 */
export interface Shortcut {
  /** As shown: "Ctrl+S", "Ctrl+Shift+P", "Tab", "Esc". `modKey()` in ui.tsx spells Ctrl/⌘. */
  keys: string;
  /** Translated, short: "Save", "Try the question". */
  label: string;
}

let nextId = 0;
/** The frame's own shortcuts, always ahead of the page's (see `useGlobalShortcuts`). */
const globals = new Map<number, Shortcut[]>();
const registry = new Map<number, Shortcut[]>();
const listeners = new Set<() => void>();
let snapshot: Shortcut[] = [];

function emit(): void {
  // One line per key combination, and the LAST registration wins: a focused
  // field registers after the page it sits in, so `Ctrl+Enter` reads "New
  // line" while the caret is in a choice and "Try" once it leaves — which is
  // also what the key does, since the field stops that event from reaching
  // the page.
  const byKeys = new Map<string, Shortcut>();
  for (const s of [...globals.values(), ...registry.values()].flat()) byKeys.set(s.keys, s);
  snapshot = [...byKeys.values()];
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Registers `shortcuts` in `into` while the component is mounted and `enabled`. */
function useRegistration(
  into: Map<number, Shortcut[]>,
  shortcuts: Shortcut[],
  enabled: boolean,
): void {
  const key = enabled ? JSON.stringify(shortcuts) : "";
  useEffect(() => {
    if (!enabled) return;
    const id = nextId++;
    into.set(id, JSON.parse(key) as Shortcut[]);
    emit();
    return () => {
      into.delete(id);
      emit();
    };
  }, [into, key, enabled]);
}

/**
 * Registers `shortcuts` for as long as the component is mounted and `enabled`
 * is true. The list is compared by content, so a screen may build it inline.
 */
export function useShortcuts(shortcuts: Shortcut[], enabled = true): void {
  useRegistration(registry, shortcuts, enabled);
}

/**
 * The same, for the shortcuts of the FRAME itself (Ctrl+K). They lead the
 * strip whatever order the effects ran in: a child's effect fires before its
 * parent's, so insertion order alone would put the page's keys above the one
 * that works everywhere.
 */
export function useGlobalShortcuts(shortcuts: Shortcut[], enabled = true): void {
  useRegistration(globals, shortcuts, enabled);
}

/** The live union, for the sidebar strip. Re-renders on every change. */
export function useActiveShortcuts(): Shortcut[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** "Ctrl+Shift+P" -> ["Ctrl", "Shift", "P"]: one `Kbd` cap per key. */
export function shortcutCaps(keys: string): string[] {
  return keys.split("+").filter((part) => part !== "");
}

/** Test seam. */
export function resetShortcuts(): void {
  globals.clear();
  registry.clear();
  emit();
}
