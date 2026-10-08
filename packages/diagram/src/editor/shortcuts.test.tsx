import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { CanvasShortcutsListener } from "@quiz/core/client";
import { boundKeys, claimedKeys } from "@quiz/ui/testing";

import { KINDS } from "../kinds.js";
import type { Scene } from "../scene.js";
import { DiagramEditor, SHORTCUT_LINES, UNLISTED_KEYS } from "./DiagramEditor.js";

/* The shortcut zone's lines (issue #549) against the editor's keyboard, and their wiring. */

const TWO: Scene = {
  nodes: [
    { id: "aaaa", t: "class", x: 0, y: 0, name: "A" },
    { id: "bbbb", t: "class", x: 200, y: 0, name: "B" },
  ],
  links: [],
};

function Host({
  readOnly = false,
  onChange,
  onShortcuts,
}: {
  readOnly?: boolean;
  onChange?: (next: Scene) => void;
  onShortcuts?: CanvasShortcutsListener;
}) {
  const [scene, setScene] = useState(TWO);
  return (
    <DiagramEditor
      kind="class"
      value={scene}
      height={400}
      readOnly={readOnly}
      onChange={(next) => {
        setScene(next);
        onChange?.(next);
      }}
      onShortcuts={onShortcuts}
    />
  );
}

const root = (): HTMLElement => screen.getByRole("group", { name: "Diagram" });

/**
 * One press on an editor that has one step to undo (both elements deleted)
 * and a tool armed (so Escape has something to cancel). What it did: whether
 * it took the key, whether it changed the scene, which tool is armed. A key
 * the editor ignores leaves it as it was, so the editor is remounted only
 * after a key it took (a remount per press runs past the CI timeout).
 *
 * The ~190 presses look the editor up once per mount, and read the armed
 * tool by attribute: a `getByRole` walks the accessibility tree of the whole
 * canvas, and one per press ran this test past 5 s under coverage on CI.
 */
let onChange = vi.fn();
let editor: HTMLElement | null = null;
function press(key: string, ctrlKey: boolean, shiftKey: boolean): string {
  if (!editor) {
    cleanup();
    onChange = vi.fn();
    render(<Host onChange={onChange} />);
    editor = root();
    fireEvent.keyDown(editor, { key: "a", ctrlKey: true });
    fireEvent.keyDown(editor, { key: "Delete" });
    fireEvent.keyDown(editor, { key: "1" });
  }
  const before = onChange.mock.calls.length;
  const taken = !fireEvent.keyDown(editor, { key, ctrlKey, shiftKey });
  if (!taken) return "";
  const armed = [...document.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.getAttribute("aria-label"));
  editor = null;
  const changed = onChange.mock.calls.length > before ? JSON.stringify(onChange.mock.lastCall) : "";
  return `taken|${changed}|${armed.join()}`;
}

describe("the diagram editor's shortcut lines", () => {
  it("cover every key the editor answers to, and show none it ignores", () => {
    const tools = Math.min(9, KINDS.class.tools.length + KINDS.class.links.length);
    expect(claimedKeys(SHORTCUT_LINES, UNLISTED_KEYS, tools)).toEqual(boundKeys(press));
    cleanup();
    editor = null;
    // ~190 presses and ~20 mounts by design (one probe per key, both ways):
    // under coverage instrumentation on a loaded CI runner that is seconds,
    // not milliseconds, so this one test gets more than the default 5 s.
  }, 15_000);

  it("are lent while the editor has the focus, and not when it is read-only", () => {
    const publish = vi.fn();
    render(<Host onShortcuts={publish} />);
    fireEvent.focus(root());
    expect(publish).toHaveBeenLastCalledWith(expect.arrayContaining([{ keys: ["I"], label: "Reverse the direction" }]));
    cleanup();
    publish.mockClear();
    render(<Host readOnly onShortcuts={publish} />);
    fireEvent.focus(root());
    expect(publish).not.toHaveBeenCalled();
  });

  it("arm, on digit N, the tool button that says N", () => {
    render(<Host />);
    fireEvent.keyDown(root(), { key: "3" });
    const pressed = screen.getAllByRole("button", { pressed: true }).filter((b) => b.hasAttribute("aria-keyshortcuts"));
    expect(pressed.map((b) => b.getAttribute("aria-keyshortcuts"))).toEqual(["3"]);
  });
});
