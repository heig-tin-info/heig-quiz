import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { PlayedQuestion, type StudentQuestion } from "./PreviewedQuestion";

/*
 * The key of a preview is never shown unasked: not on open, and not on the
 * next question of the picker, whose pane stays mounted from one row to the
 * other and remounts the player per question (`key`), as `QuestionPreview`
 * does. Shown, it is marked ON the player, which does not move (#554), with
 * the explanation under the question.
 */

const view = (prompt: string): StudentQuestion => ({
  type: "mcq",
  student: { prompt, choices: [{ id: 0, text: "Oui" }, { id: 1, text: "Non" }], mode: "single" },
  points: 1,
});
const source = (id: string, explanation: string | null = null) => ({
  queryKey: ["key", id],
  queryFn: vi.fn(() => Promise.resolve({ solution: { correct: [0] }, explanation })),
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
    expect(await screen.findByText("Correct answer")).toBeInTheDocument();

    rerender(<PlayedQuestion key="q2" view={view("Seconde ?")} solution={second} />);
    expect(await screen.findByRole("button", { name: "Show answers" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Oui" })).not.toBeChecked();
    // Not even one render fetched the next question's key.
    expect(first.queryFn).toHaveBeenCalledTimes(1);
    expect(second.queryFn).not.toHaveBeenCalled();
  });

  it("marks the key on the same player, without moving the question", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PlayedQuestion view={view("Première ?")} solution={source("q1", "Parce que **oui**.")} />,
    );
    const legend = await screen.findByText("Première ?");
    const prompt = legend.closest("legend")!;
    const container = prompt.closest("fieldset")!;
    const before = { prompt: prompt.className, container: container.className };
    await user.click(screen.getByRole("radio", { name: "Non" }));

    await user.click(screen.getByRole("button", { name: "Show answers" }));
    expect(await screen.findByText("Correct answer")).toBeInTheDocument();
    // The very elements, with the very classes: no swap to another layout.
    expect(screen.getByText("Première ?").closest("legend")).toBe(prompt);
    expect(prompt.closest("fieldset")).toBe(container);
    expect({ prompt: prompt.className, container: container.className }).toEqual(before);
    // The teacher's answer is still there, and the explanation under it.
    expect(screen.getByRole("radio", { name: /Non/ })).toBeChecked();
    expect(screen.getByText("Explanation")).toBeInTheDocument();
    expect(screen.getByText("oui")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide answers" }));
    expect(screen.queryByText("Correct answer")).toBeNull();
    expect(screen.queryByText("Explanation")).toBeNull();
    expect(prompt.className).toBe(before.prompt);
  });

  it("offers no answers without a source for them", () => {
    renderWithProviders(<PlayedQuestion view={view("Première ?")} />);
    expect(screen.queryByRole("button", { name: "Show answers" })).toBeNull();
  });
});
