import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { useToast } from "./notify";
import { renderWithProviders } from "./test/render";

/*
 * The toast's one action (M3-16a: Undo after a move, ADR-070 §6): it runs
 * and the toast goes; a toast with a key replaces the one standing with
 * the same key, so only the latest move can be undone.
 */

function Probe({ onUndo }: { onUndo: (n: number) => void }) {
  const toast = useToast();
  return (
    <>
      {[1, 2].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => toast(`Move ${n}`, "success", { key: "undo", action: { label: "Undo", run: () => onUndo(n) } })}
        >
          move {n}
        </button>
      ))}
    </>
  );
}

describe("a toast's action", () => {
  it("runs once and dismisses the toast; a keyed toast replaces the one before it", async () => {
    const onUndo = vi.fn();
    renderWithProviders(<Probe onUndo={onUndo} />);
    await userEvent.click(screen.getByRole("button", { name: "move 1" }));
    await userEvent.click(screen.getByRole("button", { name: "move 2" }));
    expect(screen.queryByText("Move 1")).toBeNull();
    expect(screen.getByText("Move 2")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledExactlyOnceWith(2);
    // Leaving: its exit animation plays, then the element goes.
    expect(screen.getByText("Move 2").closest("[role=status]")).toHaveClass("toast-leave");
  });
});
