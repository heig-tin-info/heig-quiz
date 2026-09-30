import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DrillClassroom, DrillReviewResult, DrillSession } from "@quiz/contracts";

import { fail, mockFetch, noContent, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { DrillPage } from "./DrillPage";

/*
 * The student's drill (ADR-041, #317): the day, the run of one card at a
 * time through the type's own player, the verdict with the key, the end of
 * the session; and the classrooms with the opt-out, whose confirmation says
 * what the product owner decided it must say.
 */

const ROOM: DrillClassroom = {
  classroomId: "r1",
  classroomName: "PRG1-2026",
  courseCode: "PRG1",
  courseName: "Programmation C",
  optedOutAt: null,
};

const card = (id: string) => ({
  id,
  type: "short",
  courseCode: "PRG1",
  courseName: "Programmation C",
  isNew: id === "k2",
});

const SESSION: DrillSession = { cards: [card("k1"), card("k2")], budgetMs: 600_000, nextDueAt: null };

const served = (id: string) => ({
  cardId: id,
  type: "short",
  student: {
    prompt: `Question ${id}: sizeof(int) ?`,
    kind: "text",
    constraints: { minLength: 0, maxLength: 200, integer: false },
  },
});

const review = (over: Partial<DrillReviewResult>): DrillReviewResult => ({
  correctness: "right",
  rating: 3,
  points: 1,
  maxPoints: 1,
  activeMs: 12_000,
  referenceMs: null,
  dueAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
  solution: { expected: ["4 bytes"] },
  ...over,
});

const SESSION_URL = "GET /app/api/drill/session?device=fine";

function stub(over: Record<string, RouteHandler> = {}) {
  return mockFetch({
    "GET /app/api/drill/classrooms": ok([ROOM]),
    [SESSION_URL]: ok(SESSION),
    "POST /app/api/drill/cards/k1/serve": ok(served("k1")),
    "POST /app/api/drill/cards/k2/serve": ok(served("k2")),
    "POST /app/api/drill/cards/k1/shown": noContent(),
    "POST /app/api/drill/cards/k2/shown": noContent(),
    "POST /app/api/drill/cards/k1/answer": ok(review({})),
    "POST /app/api/drill/cards/k2/answer": ok(
      review({ correctness: "wrong", rating: 1, points: 0, solution: { expected: ["8"] } }),
    ),
    ...over,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the drill session", () => {
  it("walks answer → verdict and key → next → summary, one card at a time", async () => {
    const user = userEvent.setup();
    const { calls } = stub();
    const navigate = vi.fn();
    renderWithProviders(<DrillPage navigate={navigate} />);

    expect(await screen.findByText("Today's drill")).toBeVisible();
    expect(screen.getByText("2 questions · up to 10 min")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Start" }));

    // The first card, served, in the type's own player.
    expect(await screen.findByText("Question 1 of 2")).toBeVisible();
    await user.type(await screen.findByRole("textbox", { name: "Your answer" }), "4");
    await user.click(screen.getByRole("button", { name: "Check" }));

    // The verdict, the rating and the next review, then the key through the type's review.
    expect(await screen.findByText("Correct", { selector: "span" })).toBeVisible();
    expect(screen.getByText(/^Good · next review in 4 days$/)).toBeVisible();
    expect(await screen.findByText("4 bytes")).toBeVisible();
    const answer = calls.find((c) => c.url === "/app/api/drill/cards/k1/answer");
    expect(answer?.body).toEqual({ answer: { text: "4" }, deviceClass: "fine" });
    // One primary: Next, and nothing else to press but the page's navigation.
    await user.click(screen.getByRole("button", { name: "Next" }));

    // The second card, revealed without an answer: an empty answer is a review too.
    expect(await screen.findByText("Question 2 of 2")).toBeVisible();
    await screen.findByRole("textbox", { name: "Your answer" });
    await user.click(screen.getByRole("button", { name: "Show the answer" }));
    expect(await screen.findByText("Wrong", { selector: "span" })).toBeVisible();
    expect(calls.find((c) => c.url === "/app/api/drill/cards/k2/answer")?.body).toEqual({
      answer: null,
      deviceClass: "fine",
    });
    await user.click(screen.getByRole("button", { name: "Finish" }));

    expect(await screen.findByText("Done for today")).toBeVisible();
    expect(screen.getByText("2 questions reviewed. Come back tomorrow for the next ones.")).toBeVisible();
    expect(screen.getByText("1 right · 0 partly right · 1 wrong")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to home" }));
    expect(navigate).toHaveBeenCalledWith({ view: "home" });
  });

  it("reports the question hidden while the tab is, and shown when it comes back", async () => {
    const user = userEvent.setup();
    const { calls } = stub();
    renderWithProviders(<DrillPage navigate={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByRole("textbox", { name: "Your answer" });

    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    visibility.mockRestore();

    const shown = calls.filter((c) => c.url === "/app/api/drill/cards/k1/shown").map((c) => c.body);
    expect(shown).toEqual([{ shown: true }, { shown: false }, { shown: true }]);
  });

  it("reports the question hidden when the page is left with the card unanswered, and not once answered", async () => {
    const user = userEvent.setup();
    const { calls } = stub();
    const first = renderWithProviders(<DrillPage navigate={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Start" }));
    await screen.findByRole("textbox", { name: "Your answer" });
    first.unmount();
    const k1 = calls.filter((c) => c.url === "/app/api/drill/cards/k1/shown").map((c) => c.body);
    expect(k1.at(-1)).toEqual({ shown: false });

    // Answered: the answer closed the interval, nothing more is reported.
    renderWithProviders(<DrillPage navigate={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Start" }));
    await user.click(await screen.findByRole("button", { name: "Show the answer" }));
    await screen.findByRole("button", { name: "Next" });
    const before = calls.length;
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Question 2 of 2");
    expect(calls.slice(before).filter((c) => c.url === "/app/api/drill/cards/k1/shown")).toEqual([]);
  });

  it("lets the student skip a card that cannot be served, and counts only the reviews", async () => {
    const user = userEvent.setup();
    const { calls } = stub({ "POST /app/api/drill/cards/k1/serve": fail(404, { message: "gone" }) });
    renderWithProviders(<DrillPage navigate={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Start" }));

    expect(await screen.findByText("This question could not be loaded")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Skip it" }));
    expect(await screen.findByText("Question 2 of 2")).toBeVisible();
    await user.click(await screen.findByRole("button", { name: "Show the answer" }));
    await user.click(await screen.findByRole("button", { name: "Finish" }));

    expect(await screen.findByText("One question reviewed. Come back tomorrow for the next ones.")).toBeVisible();
    expect(calls.some((c) => c.url === "/app/api/drill/cards/k1/answer")).toBe(false);
  });

  it("keeps the answer and says so when it could not be sent", async () => {
    const user = userEvent.setup();
    stub({ "POST /app/api/drill/cards/k1/answer": fail(500, { message: "boom" }) });
    renderWithProviders(<DrillPage navigate={() => {}} />);
    await user.click(await screen.findByRole("button", { name: "Start" }));
    await user.type(await screen.findByRole("textbox", { name: "Your answer" }), "4");
    await user.click(screen.getByRole("button", { name: "Check" }));

    expect(await screen.findByText("Your answer was not sent")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Your answer" })).toHaveValue("4");
    expect(screen.getByRole("button", { name: "Check" })).toBeEnabled();
  });
});

describe("the drill's day", () => {
  it("says there is nothing to review today, and when the next review is", async () => {
    stub({ [SESSION_URL]: ok({ cards: [], budgetMs: 600_000, nextDueAt: "2026-10-01T10:00:00.000Z" }) });
    renderWithProviders(<DrillPage navigate={() => {}} />);
    expect(await screen.findByText("Nothing to review today")).toBeVisible();
    expect(screen.getByText(/^Your next review is on 2026-10-01\.$/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("says the drill is not on anywhere when no classroom has it", async () => {
    stub({ "GET /app/api/drill/classrooms": ok([]) });
    renderWithProviders(<DrillPage navigate={() => {}} />);
    expect(await screen.findByText("No drill yet")).toBeVisible();
  });

  it("offers a retry when the drill could not be loaded", async () => {
    stub({ "GET /app/api/drill/classrooms": fail(500, { message: "down" }) });
    renderWithProviders(<DrillPage navigate={() => {}} />);
    expect(await screen.findByText("Could not load your drill")).toBeVisible();
    expect(screen.getByRole("button", { name: /retry/i })).toBeVisible();
  });
});

describe("the opt-out", () => {
  it("tells the student that the past stays visible and that the teacher sees the opt-out", async () => {
    const user = userEvent.setup();
    const { calls } = stub({
      "PUT /app/api/drill/classrooms/r1/opt-out": ok({ ...ROOM, optedOutAt: new Date().toISOString() }),
    });
    renderWithProviders(<DrillPage navigate={() => {}} />);
    // The tab says who sees the activity.
    expect(await screen.findByText(/Your teachers see your drill activity/)).toBeVisible();

    await user.click(screen.getByRole("switch", { name: "Take part in the drill of PRG1-2026" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave the drill of PRG1-2026?" });
    expect(within(dialog).getByText("What you practised until now stays visible to your teacher.")).toBeVisible();
    expect(within(dialog).getByText("Your teacher sees that you left the drill, and when.")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Leave the drill" }));

    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ optedOut: true });
  });

  it("takes the student back in with one action, no dialog", async () => {
    const user = userEvent.setup();
    const { calls } = stub({
      "GET /app/api/drill/classrooms": ok([{ ...ROOM, optedOutAt: "2026-09-20T08:00:00.000Z" }]),
      "PUT /app/api/drill/classrooms/r1/opt-out": ok(ROOM),
    });
    renderWithProviders(<DrillPage navigate={() => {}} />);
    const toggle = await screen.findByRole("switch", { name: "Take part in the drill of PRG1-2026" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/left on 2026-09-20/)).toBeVisible();

    await user.click(toggle);
    expect(screen.queryByRole("dialog")).toBeNull();
    await vi.waitFor(() => expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ optedOut: false }));
  });
});
