import { describe, expect, it, vi } from "vitest";

import { CANVAS_STRINGS } from "./canvasStrings.js";
import { canvasShortcuts, editorKey, SHORTCUT_LINES, UNLISTED_KEYS, type KeyActions } from "./useSelection.js";

/*
 * The shortcut zone's lines against the keyboard itself (issue #549): every
 * key `editorKey` answers to is on a line or deliberately unlisted, and every
 * key a line shows is one it answers to. The keys are found by PRESSING them,
 * not by reading the tables, so a binding added anywhere is caught.
 */

const NAMED = ["Delete", "Backspace", "Escape", "Enter", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Insert", "F1", "F2"];
const PRINTABLE = [..."abcdefghijklmnopqrstuvwxyz0123456789 -=+[]/.,;"];

/** A key as the zone spells it. */
const shown = (key: string): string =>
  ({ " ": "Space", Delete: "Del", Escape: "Esc" })[key] ?? (key.length === 1 ? key.toUpperCase() : key);

/** What a press of `key` did — the actions it called — or `""` when it did nothing. */
function answers(key: string, mod: boolean, shift: boolean): string {
  const spies = {
    undo: vi.fn(),
    redo: vi.fn(),
    duplicate: vi.fn(),
    selectAll: vi.fn(),
    transform: vi.fn(),
    toggleWire: vi.fn(),
    remove: vi.fn(),
    escape: vi.fn(() => true),
    arm: vi.fn(),
  } satisfies KeyActions;
  const preventDefault = vi.fn();
  editorKey({ key, target: null, ctrlKey: mod, metaKey: false, shiftKey: shift, preventDefault }, spies, false);
  const called = Object.entries(spies).filter(([, spy]) => spy.mock.calls.length > 0).map(([name]) => name);
  return called.length > 0 ? called.join() : preventDefault.mock.calls.length > 0 ? "prevented" : "";
}

function boundKeys(): string[] {
  const out = new Set<string>();
  for (const key of [...PRINTABLE, ...NAMED]) {
    if (answers(key, false, false)) out.add(shown(key));
    const chord = answers(key, true, false);
    if (chord) out.add(`Mod+${shown(key)}`);
    // Shift counts only where it changes what the chord does (Ctrl+Shift+Z).
    const shifted = answers(key, true, true);
    if (shifted && shifted !== chord) out.add(`Mod+Shift+${shown(key)}`);
  }
  return [...out].sort();
}

const expand = (key: string): string[] =>
  key === "1–9" ? ["1", "2", "3", "4", "5", "6", "7", "8", "9"] : [key];

describe("the circuit editor's shortcut lines", () => {
  it("cover every key the editor answers to, and show none it ignores", () => {
    const listed = SHORTCUT_LINES.flatMap((line) => line.keys.flatMap(expand));
    expect([...listed, ...UNLISTED_KEYS].sort()).toEqual(boundKeys());
    // No key is both shown and unlisted.
    expect(listed.filter((k) => (UNLISTED_KEYS as readonly string[]).includes(k))).toEqual([]);
  });

  it("fit the zone: five lines at most", () => {
    expect(SHORTCUT_LINES.length).toBeLessThanOrEqual(5);
  });

  it("are worded by the canvas's dictionary", () => {
    expect(canvasShortcuts({ ...CANVAS_STRINGS, shortcutPart: "Choisir un composant" })).toContainEqual({
      keys: ["1–9"],
      label: "Choisir un composant",
    });
  });
});
