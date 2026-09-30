import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { PlayedQuestion, type StudentQuestion } from "./PreviewedQuestion";

/*
 * The key of a preview is never shown unasked: not on open, and not on the
 * next question of the picker, whose pane stays mounted from one row to the
 * other and remounts the player per question (`key`), as `QuestionPreview`
 * does.
 */

const view = (prompt: string): StudentQuestion => ({
  type: "mcq",
  student: { prompt, choices: [{ id: 0, text: "Oui" }, { id: 1, text: "Non" }], mode: "single" },
  points: 1,
});
const source = (id: string) => ({
  queryKey: ["key", id],
  queryFn: vi.fn(() => Promise.resolve({ solution: { correct: [0] } })),
});

describe("PlayedQuestion", () => {
  it("hides the answers again on the next question", async () => {
    const user = userEvent.setup();
    const first = source("q1");
    const second = source("q2");
    const { rerender } = renderWithProviders(
      <PlayedQuestion key="q1" view={view("Première ?")} solution={first} />,
    );
    await user.click(screen.getByRole("button", { name: "Show answers" }));
    expect(await screen.findByText("Missed")).toBeInTheDocument();

    rerender(<PlayedQuestion key="q2" view={view("Seconde ?")} solution={second} />);
    expect(await screen.findByRole("button", { name: "Show answers" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Oui" })).not.toBeChecked();
    // Not even one render fetched the next question's key.
    expect(first.queryFn).toHaveBeenCalledTimes(1);
    expect(second.queryFn).not.toHaveBeenCalled();
  });

  it("offers no answers without a source for them", () => {
    renderWithProviders(<PlayedQuestion view={view("Première ?")} />);
    expect(screen.queryByRole("button", { name: "Show answers" })).toBeNull();
  });
});
