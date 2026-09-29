import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { PlayedQuestion, type StudentQuestion } from "./PreviewedQuestion";

/*
 * The key of a preview is never shown unasked: not on open, and not on the
 * next question of the picker, whose pane stays mounted from one row to the
 * other.
 */

const view = (prompt: string): StudentQuestion => ({
  type: "mcq",
  student: { prompt, choices: [{ id: 0, text: "Oui" }, { id: 1, text: "Non" }], mode: "single" },
  points: 1,
});
const solution = {
  queryKey: ["key"],
  queryFn: () => Promise.resolve({ solution: { correct: [0] } }),
};

describe("PlayedQuestion", () => {
  it("hides the answers again on the next question", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(
      <PlayedQuestion view={view("Première ?")} solution={solution} />,
    );
    await user.click(screen.getByRole("button", { name: "Show answers" }));
    expect(await screen.findByText("Missed")).toBeInTheDocument();

    rerender(<PlayedQuestion view={view("Seconde ?")} solution={solution} />);
    expect(await screen.findByRole("button", { name: "Show answers" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Oui" })).not.toBeChecked();
  });
});
