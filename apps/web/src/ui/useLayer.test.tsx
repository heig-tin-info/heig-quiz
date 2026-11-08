import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { elapse, flowingClock } from "../test/clock";
import { renderWithProviders } from "../test/render";
import { Button, Modal } from ".";

/*
 * `useLayer` gives the focus back to whatever opened the layer, one frame
 * after the close. One frame, because the palette runs a command and unmounts
 * itself in the same tick, and the command may be "open the help drawer": the
 * question "did something else take the focus?" cannot be answered at cleanup
 * time, when the focused node has just been removed and the browser has
 * already parked the focus on <body>.
 */
describe("useLayer focus restore", () => {
  /** A layer that closes itself while opening another, the palette's shape. */
  function Relay() {
    const [first, setFirst] = useState(false);
    const [second, setSecond] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setFirst(true)}>
          Open first
        </button>
        {first ? (
          <Modal title="First" onClose={() => setFirst(false)}>
            <Button
              onClick={() => {
                setSecond(true);
                setFirst(false);
              }}
            >
              Relay
            </Button>
          </Modal>
        ) : null}
        {second ? (
          <Modal title="Second" onClose={() => setSecond(false)}>
            <p>Second panel</p>
          </Modal>
        ) : null}
      </>
    );
  }

  /** Past the deferred restore, which is one `requestAnimationFrame` away. */
  const afterTheFrame = () => elapse(60);

  it("leaves the focus to a layer that opened in the same tick", async () => {
    const user = flowingClock();
    renderWithProviders(<Relay />);
    const trigger = screen.getByRole("button", { name: "Open first" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Relay" }));

    const second = screen.getByRole("dialog", { name: "Second" });
    expect(second.contains(document.activeElement)).toBe(true);
    await afterTheFrame();
    // The restore of the first layer must not pull the reader back out to a
    // trigger sitting behind the panel they are now reading.
    expect(second.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);
  });

  it("still restores to the opener on an ordinary close", async () => {
    renderWithProviders(<Relay />);
    const trigger = screen.getByRole("button", { name: "Open first" });
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    // The focused node was inside the panel that just went away, so at that
    // point nothing else holds the focus and the trigger gets it back.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
