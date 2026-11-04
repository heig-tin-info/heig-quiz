import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { viewport } from "../test/viewport";
import { NewQuestionModal } from "./NewQuestionModal";

/*
 * The two steps of "New question": choosing a type slides to the name with
 * the focus in its field, Enter creates, Back keeps what was typed, and the
 * palette's typed entry opens straight on the name.
 */

const CREATE = "POST /app/api/pools/p1/questions";

function open(initialType: string | null) {
  const onCreated = vi.fn();
  const { calls } = mockFetch({ [CREATE]: ok({ meta: { id: "q1" } }) });
  renderWithProviders(
    <NewQuestionModal
      poolId="p1"
      categoryId="c1"
      initialType={initialType}
      onClose={vi.fn()}
      onCreated={onCreated}
    />,
  );
  return { onCreated, calls };
}

const narrow = window.matchMedia;
afterEach(() => vi.stubGlobal("matchMedia", narrow));

describe("NewQuestionModal", () => {
  it("goes to the name as soon as a type is chosen, and Enter creates", async () => {
    const { onCreated, calls } = open(null);
    expect(screen.queryByRole("button", { name: "Create question" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^Short answer/ }));
    const field = screen.getByLabelText("Internal name");
    await waitFor(() => expect(field).toHaveFocus());
    await userEvent.type(field, "ptr-arith-01{Enter}");
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(calls.find((c) => `${c.method} ${c.url}` === CREATE)?.body).toEqual({
      type: "short",
      internalName: "ptr-arith-01",
      categoryId: "c1",
    });
  });

  it("offers the logic circuit right after the circuit, and no brainstorm (it starts as a poll)", () => {
    viewport(1440);
    open(null);
    expect(screen.queryByRole("tablist")).toBeNull();
    const tiles = screen.getAllByRole("button", { pressed: false }).map((b) => b.textContent ?? "");
    const circuit = tiles.findIndex((text) => text.startsWith("Circuit"));
    expect(tiles[circuit + 1]).toMatch(/^Logic circuit/);
    expect(tiles.some((text) => text.startsWith("Brainstorm"))).toBe(false);
  });

  it("files the types under tabs on a small screen, and remembers the last one", async () => {
    open(null);
    expect(screen.getByRole("tab", { name: "Basics" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: /^Short answer/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Circuit/ })).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Engineering" }));
    expect(screen.getByRole("button", { name: /^Circuit/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Short answer/ })).toBeNull();
    expect(localStorage.getItem("quiz-question-type-tab")).toBe("engineering");
  });

  it("opens on the tab last used", () => {
    localStorage.setItem("quiz-question-type-tab", "engineering");
    open(null);
    expect(screen.getByRole("tab", { name: "Engineering" })).toHaveAttribute("aria-selected", "true");
  });

  it("goes back to the grid with the type marked and the name kept", async () => {
    open(null);
    await userEvent.click(screen.getByRole("button", { name: /^Essay/ }));
    await userEvent.type(screen.getByLabelText("Internal name"), "essai");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    const essay = screen.getByRole("button", { name: /^Essay/ });
    expect(essay).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(essay).toHaveFocus());
    expect(screen.getByLabelText("Internal name")).toHaveValue("essai");
  });

  it("opens on the name when the palette already chose the type", async () => {
    open("code");
    await waitFor(() => expect(screen.getByLabelText("Internal name")).toHaveFocus());
    expect(screen.getByRole("button", { name: "Create question" })).toBeDisabled();
    // "Back" finds the type on its own tab, whatever tab was last used.
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("tab", { name: "Engineering" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { pressed: true })).toHaveTextContent(/^Code(?! image)/);
  });
});
