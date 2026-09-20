import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeFeedback } from "../grading/fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { Feedback } from "./Feedback";

/*
 * The two halves of `StudentFeedback` (deviation W6-9): before the release
 * the payload carries a reason and NO question content, and the page must
 * show exactly that — a calm wait, not an empty results screen.
 */

const URL = "/app/api/attempts/a1/feedback";

describe("student feedback", () => {
  it("waits calmly, naming the evaluation, while the results are not published", async () => {
    mockFetch({
      [`GET ${URL}`]: ok({
        available: false,
        reason: "results_pending",
        evaluation: { id: "e1", title: "Quiz 3" },
      }),
    });
    renderWithProviders(<Feedback attemptId="a1" />);

    expect(await screen.findByText("Results not published yet")).toBeVisible();
    // Named twice on purpose: the page header and the sentence that explains
    // the wait. A student arriving from a notification must see which one.
    expect(screen.getAllByText(/Quiz 3/).length).toBeGreaterThan(0);
    // Nothing of the attempt leaks into the waiting state.
    expect(screen.queryByText("Grade")).toBeNull();
    expect(screen.queryByText(/Question 1/)).toBeNull();
  });

  it("names the reason when the evaluation shows no feedback at all", async () => {
    mockFetch({
      [`GET ${URL}`]: ok({
        available: false,
        reason: "no_feedback",
        evaluation: { id: "e1", title: "Quiz 3" },
      }),
    });
    renderWithProviders(<Feedback attemptId="a1" />);
    expect(await screen.findByText("No feedback for this evaluation")).toBeVisible();
  });

  it("shows the grade, the points and the per-question review once published", async () => {
    mockFetch({ [`GET ${URL}`]: ok(makeFeedback()) });
    renderWithProviders(<Feedback attemptId="a1" />);

    expect(await screen.findByRole("heading", { name: "Your results" })).toBeVisible();
    expect(screen.getByText("Grade").nextSibling).toHaveTextContent("5.0");
    expect(screen.getByText("Points").nextSibling).toHaveTextContent("4 / 5");
    expect(screen.getByRole("heading", { name: "Question 1" })).toBeVisible();
    expect(await screen.findByText("An address is 64 bits wide.")).toBeVisible();
    expect(screen.getByText("Clean answer.")).toBeVisible();
  });

  // `position` is 0-based on the wire (the API stores it that way); every
  // screen of this app numbers questions from 1.
  it("numbers the questions from one, not from the stored position", async () => {
    const payload = makeFeedback();
    expect(payload.items[0]!.position).toBe(0);
    mockFetch({ [`GET ${URL}`]: ok(payload) });
    renderWithProviders(<Feedback attemptId="a1" />);
    expect(await screen.findByRole("heading", { name: "Question 1" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Question 0" })).toBeNull();
  });

  it("shows only what the policy let through", async () => {
    const payload = makeFeedback();
    mockFetch({
      [`GET ${URL}`]: ok({
        ...payload,
        items: [{ ...payload.items[0]!, explanation: null, comment: null, solution: null }],
      }),
    });
    renderWithProviders(<Feedback attemptId="a1" />);
    expect(await screen.findByRole("heading", { name: "Question 1" })).toBeVisible();
    expect(screen.queryByText("Explanation")).toBeNull();
    expect(screen.queryByText("Your teacher's comment")).toBeNull();
  });
});
