import { describe, expect, it } from "vitest";

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
    expect(main).not.toHaveClass("lg:max-w-400");

    rerender(shell(true, true));
    // The frame and the bar are the same: the list does not move.
    expect(frame.className).toBe(at.frame);
    expect(bar.className).toBe(at.bar);
    // The question's column alone takes the room right of the list.
    expect(main).toHaveClass("lg:max-w-400");
  });

  it("without a side column, sets the bar and the body to the question's column", () => {
    const { container } = renderWithProviders(shell(true, false));
    expect(container.querySelector("aside")).toBeNull();
    expect(container.querySelector("header > div")).toHaveClass("max-w-190", "lg:max-w-400");
    expect(container.querySelector("main")!.parentElement).toHaveClass("max-w-190", "lg:max-w-400");
  });
});
