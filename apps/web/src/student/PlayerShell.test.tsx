import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { resetShortcuts, useShortcuts } from "../shortcuts";
import { renderWithProviders } from "../test/render";
import { PlayerShell } from "./PlayerShell";

/*
 * The frame of the zen player around a question that asks for the room
 * (`QuestionTypeClient.wide`, a statement beside an editor) and one that does
 * not. jsdom lays nothing out, so the widths are read where they are decided:
 * the classes of the frame and of the question's column.
 */
const shell = (wide: boolean, aside: boolean) => (
  <PlayerShell title="Test 1" deadlineAt={null} wide={wide} {...(aside ? { aside: <p>list</p> } : {})}>
    <p>question</p>
  </PlayerShell>
);

describe("the zen player's frame", () => {
  it("keeps the side column where it is, whatever the width of the question", () => {
    const { container, rerender } = renderWithProviders(shell(false, true));
    const frame = container.querySelector("aside")!.parentElement!;
    const bar = container.querySelector("header > div")!;
    const at = { frame: frame.className, bar: bar.className };
    const main = container.querySelector("main")!;
    expect(main).toHaveClass("max-w-190");
    expect(main).not.toHaveClass("max-w-400");

    rerender(shell(true, true));
    // The frame and the bar are the same: the list does not move.
    expect(frame.className).toBe(at.frame);
    expect(bar.className).toBe(at.bar);
    // The question's column alone takes the room right of the list.
    expect(main).toHaveClass("max-w-400");
    expect(main).not.toHaveClass("max-w-190");
  });

  it("without a side column, sets the bar and the body to the question's column", () => {
    const { container } = renderWithProviders(shell(true, false));
    expect(container.querySelector("aside")).toBeNull();
    expect(container.querySelector("header > div")).toHaveClass("max-w-190", "lg:max-w-400");
    expect(container.querySelector("main")!.parentElement).toHaveClass("max-w-190", "lg:max-w-400");
  });
});

/*
 * The keys a focused canvas lends (issue #549): under the move keys of the
 * side column, and only those — the column is no live strip of the page.
 */
describe("the side column's canvas keys", () => {
  afterEach(() => resetShortcuts());

  const CANVAS = [
    { keys: "Ctrl+Z / Ctrl+Y", label: "Undo / Redo" },
    { keys: "Del", label: "Delete" },
  ];

  /** The player's own keys, registered as `usePlayerControls` does. */
  function Question() {
    useShortcuts([{ keys: "Ctrl+Enter", label: "Validate and continue" }]);
    return <p>question</p>;
  }

  it("lists what the canvas lent under Alt + arrows, and nothing the page registered", () => {
    const { container } = renderWithProviders(
      <PlayerShell title="Test 1" deadlineAt={null} aside={<p>list</p>} asideShortcuts={CANVAS}>
        <Question />
      </PlayerShell>,
    );
    const aside = container.querySelector("aside")!;
    const keys = within(aside).getByRole("list", { name: "Shortcuts" });
    expect(within(keys).getAllByRole("listitem").map((el) => el.textContent)).toEqual([
      "CtrlZ/CtrlYUndo / Redo",
      "DelDelete",
    ]);
    // Under the move keys.
    expect(aside.textContent!.indexOf("to move between questions")).toBeLessThan(
      aside.textContent!.indexOf("Undo / Redo"),
    );
    expect(aside).not.toHaveTextContent("Validate and continue");
  });

  it("shows them nowhere without the side column", () => {
    renderWithProviders(
      <PlayerShell title="Test 1" deadlineAt={null} asideShortcuts={CANVAS}>
        <Question />
      </PlayerShell>,
    );
    expect(screen.queryByText("Undo / Redo")).toBeNull();
  });
});
