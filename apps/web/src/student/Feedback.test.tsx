import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { makeEvaluationDetail, makeFeedback } from "../test/grading-fixtures";
import { fail, mockFetch, ok, publicConfig, renderWithProviders } from "../test/render";
import { enterStudentView, studentViewOn } from "../studentView";
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
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);

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
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    expect(await screen.findByText("No feedback for this evaluation")).toBeVisible();
  });

  it("shows the grade, the points and the per-question review once published", async () => {
    mockFetch({ [`GET ${URL}`]: ok(makeFeedback()) });
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);

    expect(await screen.findByRole("heading", { name: "Your results" })).toBeVisible();
    expect(screen.getByText("Grade").nextSibling).toHaveTextContent("5.0");
    expect(screen.getByText("Points").nextSibling).toHaveTextContent("4 / 5");
    expect(screen.getByRole("heading", { name: "Question 1" })).toBeVisible();
    expect(await screen.findByText("An address is 64 bits wide.")).toBeVisible();
    expect(screen.getByText("Clean answer.")).toBeVisible();
  });

  // A pending cell is not a zero: the validated points, the count, no grade.
  it("shows no grade while questions wait for their grading, and says how many", async () => {
    const payload = makeFeedback();
    mockFetch({
      [`GET ${URL}`]: ok({
        ...payload,
        evaluation: { ...payload.evaluation, releasedAt: null },
        points: 2,
        grade: null,
        pendingCount: 1,
        items: [
          payload.items[0]!,
          { ...payload.items[0]!, itemId: "i2", position: 1, points: null, verdict: null, details: null },
        ],
      }),
    });
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Your results" })).toBeVisible();
    expect(screen.queryByText("Grade")).toBeNull();
    expect(screen.getByText("Points").nextSibling).toHaveTextContent("2 / 5");
    expect(screen.getByText("1 question awaiting grading")).toBeVisible();
  });

  it("says an exam's results come after the deadline", async () => {
    mockFetch({
      [`GET ${URL}`]: ok({
        available: false,
        reason: "exam_open",
        evaluation: { id: "e1", title: "Test 1" },
      }),
    });
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    expect(await screen.findByText("Results after the deadline")).toBeVisible();
    expect(screen.queryByText("Points")).toBeNull();
  });

  // `position` is 0-based on the wire (the API stores it that way); every
  // screen of this app numbers questions from 1.
  it("numbers the questions from one, not from the stored position", async () => {
    const payload = makeFeedback();
    expect(payload.items[0]!.position).toBe(0);
    mockFetch({ [`GET ${URL}`]: ok(payload) });
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Question 1" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Question 0" })).toBeNull();
  });

  // ADR-050: a correction published while the exercise still takes retakes.
  it("shows the correction and keeps Try again when the retakes go on", async () => {
    mockFetch({
      [`GET ${URL}`]: ok({
        ...makeFeedback(),
        retake: { evaluationId: "e1", keep: "best", maxAttempts: 3, attemptCount: 1, refusal: null },
      }),
    });
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Question 1" })).toBeVisible();
    expect(screen.getByRole("button", { name: /try again/i })).toBeVisible();
    expect(screen.getByText(/1 of 3/)).toBeVisible();
  });

  it("shows only what the policy let through", async () => {
    const payload = makeFeedback();
    mockFetch({
      [`GET ${URL}`]: ok({
        ...payload,
        items: [{ ...payload.items[0]!, explanation: null, comment: null, solution: null }],
      }),
    });
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Question 1" })).toBeVisible();
    expect(screen.queryByText("Explanation")).toBeNull();
    expect(screen.queryByText("Your teacher's comment")).toBeNull();
  });

  describe("Download my copy (F-EXP-06)", () => {
    const COPY = "/app/api/attempts/a1/copy";
    const open = async () => {
      await userEvent.click(await screen.findByRole("button", { name: "Download my copy" }));
      return (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
    };

    it("offers the PDF and the JSON of the page, and words the hourly limit", async () => {
      const createObjectURL = vi.fn((_blob: Blob) => "blob:pdf");
      // jsdom has no object URLs (and `URL` is this file's route here).
      Object.assign(globalThis.URL, { createObjectURL, revokeObjectURL: vi.fn() });
      mockFetch({
        [`GET ${URL}`]: ok(makeFeedback()),
        ...publicConfig(true),
        [`GET ${COPY}.pdf`]: fail(429, { error: "rate_limited" }),
      });
      renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
      await waitFor(async () => expect(await open()).toEqual(["PDF", "JSON"]));
      expect(screen.getByRole("menuitem", { name: "JSON" })).toHaveAttribute("href", `${COPY}.json`);
      await userEvent.click(screen.getByRole("menuitem", { name: "PDF" }));
      expect(await screen.findByText("Too many downloads in an hour. Try again later.")).toBeInTheDocument();
      expect(createObjectURL).not.toHaveBeenCalled();
    });

    it("hides the PDF when the server makes none", async () => {
      mockFetch({ [`GET ${URL}`]: ok(makeFeedback()), ...publicConfig(false) });
      renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
      expect(await open()).toEqual(["JSON"]);
    });

    it("is not offered on a practice attempt, nor before the page shows anything", async () => {
      mockFetch({ [`GET ${URL}`]: ok({ ...makeFeedback(), grade: null, practice: true }), ...publicConfig(true) });
      const { unmount } = renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
      expect(await screen.findByRole("heading", { name: "Question 1" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Download my copy" })).toBeNull();
      unmount();

      mockFetch({
        [`GET ${URL}`]: ok({ available: false, reason: "results_pending", evaluation: { id: "e1", title: "Quiz 3" } }),
        ...publicConfig(true),
      });
      renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
      expect(await screen.findByText("Results not published yet")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Download my copy" })).toBeNull();
    });
  });

  // ADR-118 §5: the essay's validated points per criterion, when the key let them through.
  it("lists an essay's points per criterion only when its details carry them", async () => {
    const essay = (details: Record<string, unknown>) => ({
      itemId: "i1",
      position: 0,
      type: "rich",
      points: 2.75,
      maxPoints: 4,
      counting: "normal" as const,
      verdict: "partial" as const,
      student: { prompt: "Explain the stack.", format: "plain" },
      answer: { text: "It grows down." },
      solution: { reference: "A model answer." },
      explanation: null,
      details,
      comment: null,
      contestation: null,
      contestable: false,
    });
    const breakdown = [
      { id: "thesis", title: "Thesis", points: 2, maxPoints: 2.5 },
      { id: "sources", title: "Sources", points: 0.75, maxPoints: 1.5 },
    ];
    mockFetch({ [`GET ${URL}`]: ok(makeFeedback({ items: [essay({ reason: "llm", chars: 14, breakdown })] })) });
    const { unmount } = renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    const list = await screen.findByRole("list", { name: "Points per criterion" });
    expect(within(list).getAllByRole("listitem").map((l) => l.textContent)).toEqual([
      "Thesis2 / 2.5",
      "Sources0.75 / 1.5",
    ]);
    unmount();

    mockFetch({ [`GET ${URL}`]: ok(makeFeedback({ items: [essay({ reason: "llm", chars: 14 })] })) });
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    expect(await screen.findByText("It grows down.")).toBeVisible();
    expect(screen.queryByRole("list", { name: "Points per criterion" })).toBeNull();
  });
});

describe("a teacher in the student view (ADR-018, amended 2026-11-17)", () => {
  const EVALUATION = "GET /app/api/evaluations/e1";
  /** The evaluation's staff read, saying whose walk this attempt is. */
  const staffRead = (self: { seat: boolean; staffSeat: boolean; attemptId: string | null }) => ok(makeEvaluationDetail({ self }));
  const OWN = { seat: true, staffSeat: true, attemptId: "a1" };

  it("offers the class's results on their own staff walk, which leave the student view for that evaluation's results", async () => {
    enterStudentView({ view: "evaluation", id: "e1" });
    const navigate = vi.fn();
    const feedback = makeFeedback();
    mockFetch({ [`GET ${URL}`]: ok(feedback), [EVALUATION]: staffRead(OWN) });
    renderWithProviders(<Feedback attemptId="a1" navigate={navigate} studentView />);

    await userEvent.click(await screen.findByRole("button", { name: "See the class results" }));
    expect(studentViewOn()).toBe(false);
    expect(navigate).toHaveBeenCalledWith({ view: "results", evaluationId: feedback.evaluation.id });
  });

  it("offers it on a page still waiting too", async () => {
    mockFetch({
      [`GET ${URL}`]: ok({ available: false, reason: "results_pending", evaluation: { id: "e1", title: "Quiz 3" } }),
      [EVALUATION]: staffRead(OWN),
    });
    renderWithProviders(<Feedback attemptId="a1" navigate={vi.fn()} studentView />);
    expect(await screen.findByRole("button", { name: "See the class results" })).toBeVisible();
  });

  it("offers nothing on an attempt that is not their staff walk, nor off the course's staff", async () => {
    for (const evaluation of [staffRead({ seat: true, staffSeat: false, attemptId: "a1" }), staffRead({ ...OWN, attemptId: "a9" }), fail(404, { error: "not_found" })]) {
      const { calls } = mockFetch({ [`GET ${URL}`]: ok(makeFeedback()), [EVALUATION]: evaluation });
      const { unmount } = renderWithProviders(<Feedback attemptId="a1" navigate={vi.fn()} studentView />);
      expect(await screen.findByRole("heading", { name: "Your results" })).toBeVisible();
      await waitFor(() => expect(calls.some((c) => c.url === "/app/api/evaluations/e1")).toBe(true));
      expect(screen.queryByRole("button", { name: "See the class results" })).toBeNull();
      unmount();
    }
  });

  it("is never offered to a student, who reads no staff route", async () => {
    const { calls } = mockFetch({ [`GET ${URL}`]: ok(makeFeedback()) });
    renderWithProviders(<Feedback attemptId="a1" navigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Your results" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "See the class results" })).toBeNull();
    expect(calls.some((c) => c.url.startsWith("/app/api/evaluations/"))).toBe(false);
  });
});

/*
 * ADR-139: a question of a released exam is contested from its card, once,
 * with a reason; the card then shows where the contestation stands, with the
 * student's reason and the teacher's reply, line breaks kept.
 */
describe("contesting a question", () => {
  const DAY = 86_400_000;
  const AHEAD = new Date(Date.now() + 5 * DAY).toISOString();
  const PAST = new Date(Date.now() - DAY).toISOString();
  const POST = "POST /app/api/attempts/a1/items/i1/contestation";
  const page = (over: Record<string, unknown> = {}, closesAt = AHEAD) => {
    const feedback = makeFeedback();
    return {
      ...feedback,
      contestationClosesAt: closesAt,
      items: [{ ...feedback.items[0]!, points: 1, verdict: "partial" as const, contestation: null, contestable: true, ...over }],
    };
  };
  const filed = (state: "open" | "accepted" | "refused", reply: string | null) => ({
    state,
    reason: "I wrote 31.\nThe key accepts 0x1F.",
    filedAt: "2026-09-11T08:00:00.000Z",
    reply,
    resolvedAt: state === "open" ? null : "2026-09-12T08:00:00.000Z",
  });
  const send = async (reason: string) => {
    await userEvent.click(await screen.findByRole("button", { name: "Contest question 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Contest question 1" });
    await userEvent.type(within(dialog).getByLabelText("Reason"), reason);
    await userEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    return dialog;
  };

  it("sends a reason once, then shows the question as contested, the focus on its state", async () => {
    let current = page();
    const { calls } = mockFetch({
      [`GET ${URL}`]: () => ok(current),
      [POST]: () => {
        current = page({ contestation: filed("open", null), contestable: false });
        return ok(filed("open", null));
      },
    });
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);

    // Until when, discreetly, while a question may be contested.
    expect(await screen.findByText(/Contestations open until/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Contest question 1" }));
    const dialog = await screen.findByRole("dialog", { name: "Contest question 1" });
    expect(within(dialog).getByText("Sent once, it cannot be changed.")).toBeVisible();
    expect(within(dialog).getByText(/Contestations open until/)).toBeVisible();
    const button = within(dialog).getByRole("button", { name: "Send" });
    // A blank reason is no reason: the contract's own check.
    await userEvent.type(within(dialog).getByLabelText("Reason"), "   ");
    expect(button).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Reason"), "I wrote 31.");
    expect(within(dialog).getByText("14 / 2000 characters")).toBeVisible();
    await userEvent.click(button);

    const state = await screen.findByText("Contestation awaiting an answer");
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ reason: "I wrote 31." });
    expect(screen.queryByRole("button", { name: "Contest question 1" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(state.closest("p")).toHaveFocus());
  });

  it("says why a contestation is refused, and reads the page again", async () => {
    const { calls } = mockFetch({ [`GET ${URL}`]: ok(page()), [POST]: fail(409, { error: "contestation_closed" }) });
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    const dialog = await send("Late.");
    expect(await within(dialog).findByText("Contestations are closed for this evaluation.")).toBeVisible();
    await waitFor(() => expect(calls.filter((c) => c.url === URL).length).toBe(2));
  });

  it("words the reason a question may not be contested, else the server's message", async () => {
    mockFetch({
      [`GET ${URL}`]: ok(page()),
      [POST]: fail(409, { error: "not_contestable", message: "this question cannot be contested", reason: "full_points" }),
    });
    const { unmount } = renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    expect(await within(await send("More points.")).findByText("This question already has all its points.")).toBeVisible();
    unmount();

    mockFetch({ [`GET ${URL}`]: ok(page()), [POST]: fail(500, { error: "boom", message: "Something broke." }) });
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    expect(await within(await send("More points.")).findByText("Something broke.")).toBeVisible();
  });

  it.each([
    ["open", null, "Contestation awaiting an answer"],
    ["accepted", null, "Contestation accepted"],
    ["refused", "Read the statement again.\nIt asks for bits.", "Contestation refused"],
  ] as const)("shows a %s contestation with its reason and its reply", async (state, reply, words) => {
    mockFetch({ [`GET ${URL}`]: ok(page({ contestation: filed(state, reply), contestable: false })) });
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    expect(await screen.findByText(words)).toBeVisible();
    // Plain text, line breaks kept: one paragraph, never Markdown.
    expect(screen.getByText(/I wrote 31\.\s+The key accepts 0x1F\./)).toBeVisible();
    if (reply) expect(screen.getByText(/Read the statement again\.\s+It asks for bits\./)).toBeVisible();
    else expect(screen.queryByText("Reply")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Contest/ })).toBeNull();
  });

  it("says the window closed once it has, beside a contestation; nothing while nothing is or may be contested", async () => {
    mockFetch({ [`GET ${URL}`]: ok(page({ contestation: filed("open", null), contestable: false }, PAST)) });
    const { unmount } = renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    expect(await screen.findByText("Contestations closed")).toBeVisible();
    unmount();

    // Open, but nothing to contest (full points) and nothing contested.
    mockFetch({ [`GET ${URL}`]: ok({ ...makeFeedback(), contestationClosesAt: AHEAD }) });
    renderWithProviders(<Feedback attemptId="a1" navigate={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Question 1" })).toBeVisible();
    expect(screen.queryByText(/Contestations/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Contest/ })).toBeNull();
  });
});
