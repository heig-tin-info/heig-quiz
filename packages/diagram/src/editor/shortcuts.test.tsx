import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CanvasShortcutsListener } from "@quiz/core/client";

import { KINDS, type DiagramKind } from "../kinds.js";
import { emptyScene, type Scene } from "../scene.js";
import { DiagramEditor, SHORTCUT_LINES, UNLISTED_KEYS } from "./DiagramEditor.js";

/*
 * The shortcut zone's lines (issue #549) against the editor's keyboard, and
 * when the editor lends them to its host.
 */

function Host({
  kind = "class",
  initial = emptyScene(),
  readOnly = false,
  withText = false,
  onShortcuts,
}: {
  kind?: DiagramKind;
  initial?: Scene;
  readOnly?: boolean;
  withText?: boolean;
  onShortcuts?: CanvasShortcutsListener;
}) {
  const [scene, setScene] = useState(initial);
  return (
    <DiagramEditor
      kind={kind}
      value={scene}
      height={400}
      readOnly={readOnly}
      withText={withText}
      onChange={setScene}
      onShortcuts={onShortcuts}
    />
  );
}

const root = (): HTMLElement => screen.getByRole("group", { name: "Diagram" });

const NAMED = ["Delete", "Backspace", "Escape", "Enter", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Insert", "F1", "F2"];
const PRINTABLE = [..."abcdefghijklmnopqrstuvwxyz0123456789 -=+[]/.,;"];

const shown = (key: string): string =>
  ({ " ": "Space", Delete: "Del", Escape: "Esc" })[key] ?? (key.length === 1 ? key.toUpperCase() : key);

describe("the diagram editor's shortcut lines", () => {
  /**
   * Every key the editor CONSUMES. A tool is armed before each press, so
   * Escape has something to cancel. `fireEvent` cannot tell what a chord did,
   * only that it did something, so Shift on a chord counts where the chord
   * alone does nothing — or where the list names it (Ctrl+Shift+Z).
   */
  function boundKeys(): string[] {
    render(<Host />);
    const press = (key: string, ctrlKey = false, shiftKey = false): boolean => {
      fireEvent.keyDown(root(), { key: "1" });
      return !fireEvent.keyDown(root(), { key, ctrlKey, shiftKey });
    };
    const out = new Set<string>();
    for (const key of [...PRINTABLE, ...NAMED]) {
      if (press(key)) out.add(shown(key));
      const chord = press(key, true);
      if (chord) out.add(`Mod+${shown(key)}`);
      const shifted = `Mod+Shift+${shown(key)}`;
      if (press(key, true, true) && (!chord || (UNLISTED_KEYS as readonly string[]).includes(shifted))) out.add(shifted);
    }
    return [...out].sort();
  }

  it("cover every key the editor answers to, and show none it ignores", () => {
    const tools = KINDS.class.tools.length + KINDS.class.links.length;
    const digits = Array.from({ length: Math.min(9, tools) }, (_, i) => String(i + 1));
    const listed = SHORTCUT_LINES.flatMap((line) => line.keys.flatMap((k) => (k === "1–9" ? digits : [k])));
    expect([...listed, ...UNLISTED_KEYS].sort()).toEqual(boundKeys());
  });

  it("fit the zone: five lines at most", () => {
    expect(SHORTCUT_LINES.length).toBeLessThanOrEqual(5);
  });
});

describe("lending the lines", () => {
  const LINES = [
    { keys: ["Mod+Z", "Mod+Y"], label: "Undo / Redo" },
    { keys: ["I"], label: "Reverse the direction" },
    { keys: ["1–9"], label: "Pick a tool" },
    { keys: ["Del"], label: "Delete" },
  ];

  it("while it has the focus, and null on blur", () => {
    const publish = vi.fn();
    render(<Host onShortcuts={publish} />);
    fireEvent.focus(root());
    expect(publish).toHaveBeenLastCalledWith(LINES);
    fireEvent.blur(root(), { relatedTarget: document.body });
    expect(publish).toHaveBeenLastCalledWith(null);
  });

  it("null while the caret is in the inspector", () => {
    const publish = vi.fn();
    const initial: Scene = { nodes: [{ id: "aaaa", t: "vertex", x: 0, y: 0, name: "A" }], links: [] };
    render(<Host kind="graph" initial={initial} onShortcuts={publish} />);
    fireEvent.focus(root());
    fireEvent.keyDown(root(), { key: "a", ctrlKey: true });
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.blur(root(), { relatedTarget: name });
    fireEvent.focus(name);
    expect(publish).toHaveBeenLastCalledWith(null);
  });

  it("null on the text tab, where the keys are the text's", () => {
    const publish = vi.fn();
    render(<Host withText onShortcuts={publish} />);
    fireEvent.focus(root());
    fireEvent.click(screen.getByRole("tab", { name: "Text" }));
    expect(publish).toHaveBeenLastCalledWith(null);
  });

  it("never when it is read-only", () => {
    const publish = vi.fn();
    render(<Host readOnly onShortcuts={publish} />);
    fireEvent.focus(root());
    expect(publish).not.toHaveBeenCalled();
  });

  it("names the digit of each tool", () => {
    render(<Host />);
    expect(screen.getByRole("button", { name: "Class" })).toHaveAttribute("aria-keyshortcuts", "1");
    expect(screen.getByRole("button", { name: "Association" })).toHaveAttribute("aria-keyshortcuts", "2");
  });
});
