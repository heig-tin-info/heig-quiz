import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { usePaintSelection } from "./paintSelection";

/*
 * The hook alone, on bare boxes: the picker's tests cover the gesture on the
 * screen; these pin the record's lifetime around the release.
 */
function Boxes({ apply, toggle }: { apply: (id: string, on: boolean) => void; toggle: (id: string) => void }) {
  const paint = usePaintSelection(apply);
  return (
    <>
      {["a", "b"].map((id) => (
        <span key={id} data-testid={id} onPointerDown={paint.start(id, false)} onPointerEnter={paint.enter(id)}>
          <button type="button" onClick={paint.change(id, () => toggle(id))}>
            {id}
          </button>
        </span>
      ))}
    </>
  );
}

describe("usePaintSelection", () => {
  it("paints the origin then the box entered, each once", () => {
    const apply = vi.fn();
    render(<Boxes apply={apply} toggle={vi.fn()} />);
    fireEvent.pointerDown(screen.getByTestId("a"), { button: 0 });
    fireEvent.pointerEnter(screen.getByTestId("b"), { buttons: 1 });
    fireEvent.pointerEnter(screen.getByTestId("a"), { buttons: 1 });
    fireEvent.pointerEnter(screen.getByTestId("b"), { buttons: 1 });
    expect(apply.mock.calls).toEqual([
      ["a", true],
      ["b", true],
    ]);
  });

  it("ignores a press of another button than the primary", () => {
    const apply = vi.fn();
    render(<Boxes apply={apply} toggle={vi.fn()} />);
    fireEvent.pointerDown(screen.getByTestId("a"), { button: 2 });
    fireEvent.pointerEnter(screen.getByTestId("b"), { buttons: 1 });
    expect(apply).not.toHaveBeenCalled();
  });

  it("swallows the release's click on a painted box, then forgets the gesture", async () => {
    const toggle = vi.fn();
    render(<Boxes apply={vi.fn()} toggle={toggle} />);
    fireEvent.pointerDown(screen.getByTestId("a"), { button: 0 });
    fireEvent.pointerEnter(screen.getByTestId("b"), { buttons: 1 });
    fireEvent.pointerUp(window);
    fireEvent.click(screen.getByText("a"));
    expect(toggle).not.toHaveBeenCalled();
    // A later click with no press before it (Space on the focused box).
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(screen.getByText("a"));
    expect(toggle).toHaveBeenCalledWith("a");
  });
});
