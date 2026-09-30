import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { ExpandChrome, ExpandLayer } from "./ExpandLayer";
import { QuestionHost } from "./QuestionHost";

/*
 * The student's host lends the `diagram` and `circuit` players its expand layer
 * (`PlayerProps.Expand`, ADR-046 addendum): the canvas over the page, a thin
 * bar with the server's clock, the save state and "Back to the questions".
 * The package's suite proves the player uses the slot; this proves what the
 * host's layer does with the keyboard.
 */
const student = {
  prompt: "Complétez l'organigramme.",
  kind: "flow",
  starter: { nodes: [{ id: "s2d7fe4k", t: "terminal", x: 340, y: 20, name: "Début" }], links: [] },
};

function renderPlayer(onChange = vi.fn()) {
  renderWithProviders(
    <ExpandChrome.Provider value={{ deadlineAt: Date.now() + 600_000, clock: Date.now, paused: false, sync: "saved" }}>
      <QuestionHost type="diagram" student={student} answer={null} onChange={onChange} readOnly={false} Expand={ExpandLayer} />
    </ExpandChrome.Provider>,
  );
}

async function expand() {
  fireEvent.click(await screen.findByRole("button", { name: "Expand" }));
  return screen.getByRole("dialog", { name: "Expanded view" });
}

describe("the expand layer of the diagram player", () => {
  it("opens the canvas over the page, under the clock, the save state and one way back", async () => {
    renderPlayer();
    const layer = await expand();
    expect(layer).toContainElement(screen.getByRole("group", { name: "Your diagram" }));
    expect(layer).toContainElement(screen.getByRole("timer"));
    expect(layer).toHaveTextContent("Saved");
    fireEvent.click(screen.getByRole("button", { name: "Back to the questions" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lets the canvas cancel its tool on Escape first, and closes on the next one", async () => {
    renderPlayer();
    await expand();
    const canvas = screen.getByRole("group", { name: "Your diagram" });
    fireEvent.click(screen.getByRole("button", { name: "Action" }));
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays open on Escape in a field of the inspector, which the field consumes", async () => {
    renderPlayer();
    await expand();
    fireEvent.keyDown(screen.getByRole("group", { name: "Your diagram" }), { key: "a", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on Alt+arrow, and leaves the key to the player's navigation", async () => {
    renderPlayer();
    await expand();
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    try {
      fireEvent.keyDown(screen.getByRole("group", { name: "Your diagram" }), { key: "ArrowRight", altKey: true });
    } finally {
      window.removeEventListener("keydown", onWindow);
    }
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onWindow).toHaveBeenCalledTimes(1);
    expect((onWindow.mock.calls[0]![0] as KeyboardEvent).defaultPrevented).toBe(false);
  });

  it("serves the circuit player the same way, Escape first to its canvas", async () => {
    const circuit = {
      prompt: "Câblez un passe-bas.",
      palette: { kinds: ["R", "C", "GND"], maxComponents: 4 },
      supplies: { vcc: null, vee: null },
      commonGround: true,
      visibleStimuli: [],
      hiddenCount: 0,
      hiddenPoints: 0,
      canSimulate: false,
      showExpected: false,
      simulationsPerMinute: 10,
    };
    renderWithProviders(
      <ExpandChrome.Provider value={{ deadlineAt: Date.now() + 600_000, clock: Date.now, paused: false, sync: "saved" }}>
        <QuestionHost type="circuit" student={circuit} answer={null} onChange={vi.fn()} readOnly={false} Expand={ExpandLayer} />
      </ExpandChrome.Provider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Expand" }));
    const layer = screen.getByRole("dialog", { name: "Expanded view" });
    expect(layer).toContainElement(screen.getByRole("timer"));
    const canvas = within(layer).getAllByRole("group", { name: "Your circuit" })[0]!;
    fireEvent.click(within(layer).getByRole("button", { name: "Wire" }));
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no Expand button where the host lends no layer", async () => {
    renderWithProviders(<QuestionHost type="diagram" student={student} answer={null} onChange={vi.fn()} readOnly={false} />);
    expect(await screen.findByRole("group", { name: "Your diagram" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
  });
});
