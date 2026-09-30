import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { mockFetch, ok, renderWithProviders } from "../test/render";
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
  });
});
