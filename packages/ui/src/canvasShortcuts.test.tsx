import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CanvasShortcutsListener } from "@quiz/core/client";

import { useCanvasShortcuts, type CanvasShortcutLine } from "./canvasShortcuts.js";

/* When a canvas lends its keys to the host's shortcut zone (issue #549). */

const STRINGS = { undo: "Undo / Redo", remove: "Delete" };
const LINES: CanvasShortcutLine<typeof STRINGS>[] = [
  { keys: ["Mod+Z", "Mod+Y"], label: "undo" },
  { keys: ["Del"], label: "remove" },
];
const LENT = [
  { keys: ["Mod+Z", "Mod+Y"], label: "Undo / Redo" },
  { keys: ["Del"], label: "Delete" },
];

function Canvas({ publish, enabled = true }: { publish: CanvasShortcutsListener; enabled?: boolean }) {
  const handlers = useCanvasShortcuts({ publish, lines: LINES, strings: STRINGS, enabled });
  return (
    <div role="group" aria-label="canvas" tabIndex={0} {...handlers}>
      <button type="button">tool</button>
      <input aria-label="name" />
    </div>
  );
}

const canvas = () => screen.getByRole("group", { name: "canvas" });

/** Moves the focus from `from` to `to` the way a browser does: blur, then focus. */
function move(from: HTMLElement, to: HTMLElement | null): void {
  fireEvent.blur(from, { relatedTarget: to });
  if (to) fireEvent.focus(to);
}

describe("useCanvasShortcuts", () => {
  it("lends the lines on focus and takes them back when the focus leaves", () => {
    const publish = vi.fn();
    render(<Canvas publish={publish} />);
    fireEvent.focus(canvas());
    expect(publish).toHaveBeenLastCalledWith(LENT);
    move(canvas(), document.body);
    expect(publish.mock.calls).toEqual([[LENT], [null]]);
  });

  it("keeps them, without sending them again, while the focus moves to a control of its own", () => {
    const publish = vi.fn();
    render(<Canvas publish={publish} />);
    fireEvent.focus(canvas());
    move(canvas(), screen.getByRole("button", { name: "tool" }));
    expect(publish.mock.calls).toEqual([[LENT]]);
  });

  it("takes them back while the caret is in a text field, and lends them again after", () => {
    const publish = vi.fn();
    render(<Canvas publish={publish} />);
    fireEvent.focus(canvas());
    move(canvas(), screen.getByRole("textbox", { name: "name" }));
    move(screen.getByRole("textbox", { name: "name" }), canvas());
    expect(publish.mock.calls).toEqual([[LENT], [null], [LENT]]);
  });

  it("lends nothing while disabled, and the lines once enabled with the focus inside", () => {
    const publish = vi.fn();
    const { rerender } = render(<Canvas publish={publish} enabled={false} />);
    fireEvent.focus(canvas());
    expect(publish).not.toHaveBeenCalled();
    rerender(<Canvas publish={publish} enabled />);
    expect(publish.mock.calls).toEqual([[LENT]]);
    rerender(<Canvas publish={publish} enabled={false} />);
    expect(publish).toHaveBeenLastCalledWith(null);
  });

  it("takes them back when it unmounts with the focus", () => {
    const publish = vi.fn();
    const { unmount } = render(<Canvas publish={publish} />);
    fireEvent.focus(canvas());
    unmount();
    expect(publish).toHaveBeenLastCalledWith(null);
  });
});
