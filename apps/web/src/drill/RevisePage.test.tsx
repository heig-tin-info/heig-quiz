import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DrillClassroom,
  RevisionAnswerResult,
  RevisionRound,
  StudentRevisionConcepts,
  StudentRevisionRound,
} from "@quiz/contracts";

import { fail, mockFetch, noContent, ok, renderWithProviders, type RouteHandler } from "../test/render";
import { RevisePage } from "./RevisePage";

/*
 * Targeted revision of one concept (ADR-115): the pick and its two notes,
 * the recent rounds, the round served and answered on its own routes — no
 * confidence ever sent —, a wrong first pass coming back three cards later,
 * the end with "Another round", and the empty and unavailable states.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROOM: DrillClassroom = {
  classroomId: "r1",
  classroomName: "PRG1-2026",
  courseCode: "PRG1",
  courseName: "Programmation C",
  optedOutAt: null,
};
const POINTER = { id: "00000000-0000-4000-8000-0000000000c1", label: "Pointeur", qualifier: "" };
const LOOP = { id: "00000000-0000-4000-8000-0000000000c2", label: "Boucle", qualifier: "" };
const CONCEPTS: StudentRevisionConcepts = { available: true, concepts: [LOOP, POINTER] };

const card = (id: string) => ({ id, type: "short", courseCode: "PRG1", courseName: "Programmation C", isNew: false });
const ROUND: RevisionRound = {
  id: "o1",
  concept: POINTER,
  startedAt: "2026-10-15T08:00:00.000Z",
  cards: ["k1", "k2", "k3", "k4", "k5"].map(card),
};
const served = (id: string) => ({
  cardId: id,
  type: "short",
  pass: 1,
  student: { prompt: `Question ${id}`, kind: "text", constraints: { minLength: 0, maxLength: 200, integer: false } },
});
const result = (over: Partial<RevisionAnswerResult> = {}): RevisionAnswerResult => ({
  correctness: "right",
  points: 1,
  maxPoints: 1,
  solution: { expected: ["4 bytes"] },
  requeued: false,
  ...over,
});
const RECENT: StudentRevisionRound[] = [
  { id: "o0", concept: LOOP, startedAt: "2026-10-14T08:00:00.000Z", endedAt: "2026-10-14T08:10:00.000Z", cardsServed: 6, cardsCorrect: 4 },
  { id: "o9", concept: null, startedAt: "2026-10-10T08:00:00.000Z", endedAt: null, cardsServed: 2, cardsCorrect: 2 },
];

const base = "/app/api/student/classrooms/r1/revision";
const round = "/app/api/student/revision/rounds/o1";

function stub(over: Record<string, RouteHandler> = {}) {
  return mockFetch({
    "GET /app/api/drill/classrooms": ok([ROOM]),
    [`GET ${base}/concepts`]: ok(CONCEPTS),
    [`GET ${base}/rounds`]: ok(RECENT),
    [`POST ${base}/rounds`]: ok({ round: ROUND }),
    ...Object.fromEntries(ROUND.cards.map((c) => [`POST ${round}/serve/${c.id}`, ok(served(c.id))])),
    ...Object.fromEntries(ROUND.cards.map((c) => [`POST ${round}/cards/${c.id}/answer`, ok(result())])),
    [`POST ${round}/end`]: noContent(),
    ...over,
  });
}

const page = (navigate = vi.fn()) => renderWithProviders(<RevisePage classroomId="r1" navigate={navigate} />);

/** Picks the pointer and starts. */
async function startPointer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("radio", { name: "Pointeur" }));
  await user.click(screen.getByRole("button", { name: "Start" }));
}

/** Answers the card on screen ("Check" with a text, or "Show the answer" without), then Next or Finish. */
async function answer(user: ReturnType<typeof userEvent.setup>, text: string | null, then: "Next" | "Finish") {
  const field = await screen.findByRole("textbox", { name: "Your answer" });
  if (text !== null) await user.type(field, text);
  await user.click(screen.getByRole("button", { name: text === null ? "Show the answer" : "Check" }));
  await user.click(await screen.findByRole("button", { name: then }));
}

describe("targeted revision", () => {
  it("offers the concepts, says what a round is and who sees it, and lists the recent rounds", async () => {
    stub();
    page();
    expect(await screen.findByRole("heading", { name: "Revise a concept" })).toBeVisible();
    const group = await screen.findByRole("group", { name: "Which concept?" });
    expect(within(group).getAllByRole("radio").map((r) => r.closest("label")!.textContent)).toEqual(["Boucle", "Pointeur"]);
    // Start waits for a concept: one primary, disabled until then.
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByText("Practice only: it does not change your schedule or your levels.")).toBeVisible();
    expect(screen.getByText(/^Your teacher sees your rounds/)).toBeVisible();

    expect(await screen.findByRole("heading", { name: "Your recent rounds" })).toBeVisible();
    expect(screen.getByText("4 of 6 right")).toBeVisible();
    expect(screen.getByText("A removed concept")).toBeVisible();
    expect(screen.getByText("2 of 2 right")).toBeVisible();
  });

  it("starts a round, serves and answers on the round's routes, and never sends a confidence", async () => {
    const user = userEvent.setup();
    const { calls } = stub();
    page();
    await startPointer(user);
    expect(calls.find((c) => c.method === "POST" && c.url === `${base}/rounds`)?.body).toEqual({ conceptId: POINTER.id });

    expect(await screen.findByText("Question 1 of 5")).toBeVisible();
    expect(screen.getByText("Pointeur")).toBeVisible();
    // The confidence is asked, and said back, but stays in the browser.
    await user.type(await screen.findByRole("textbox", { name: "Your answer" }), "4");
    await user.click(screen.getByText("Certain"));
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Practice · not counted in your schedule")).toBeVisible();
    expect(screen.getByText("You said: Certain")).toBeVisible();
    expect(await screen.findByText("4 bytes")).toBeVisible();

    const posts = calls.filter((c) => c.method === "POST").map((c) => c.url);
    expect(posts).toEqual([`${base}/rounds`, `${round}/serve/k1`, `${round}/cards/k1/answer`]);
    expect(calls.find((c) => c.url === `${round}/cards/k1/answer`)?.body).toEqual({ answer: { text: "4" }, coordinates: "position" });
    // No visibility report, no daily route.
    expect(calls.some((c) => c.url.startsWith("/app/api/drill/cards"))).toBe(false);
  });

  it("brings a wrong first pass back three cards later, the count growing, then sums up the round", async () => {
    const user = userEvent.setup();
    const { calls } = stub({
      [`POST ${round}/cards/k1/answer`]: (call) =>
        ok(
          calls.filter((c) => c.url === call.url).length === 1
            ? result({ correctness: "wrong", points: 0, requeued: true })
            : result(),
        ),
    });
    const navigate = vi.fn();
    page(navigate);
    await startPointer(user);

    await user.click(await screen.findByRole("button", { name: "Show the answer" }));
    expect(await screen.findByText("Practice · not counted in your schedule · comes back later in this round")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Next" }));
    // k1 comes back after k2, k3, k4: six cards to answer now.
    expect(await screen.findByText("Question 2 of 6")).toBeVisible();
    await answer(user, "4", "Next"); // k2
    await answer(user, "4", "Next"); // k3
    await answer(user, "4", "Next"); // k4
    expect(await screen.findByText("Question 5 of 6")).toBeVisible();
    await answer(user, "4", "Next"); // k1, its second pass
    await answer(user, "4", "Finish"); // k5

    const answered = calls.filter((c) => c.url.endsWith("/answer")).map((c) => c.url.split("/").at(-2));
    expect(answered).toEqual(["k1", "k2", "k3", "k4", "k1", "k5"]);
    // The round ended by itself: no explicit end.
    expect(calls.some((c) => c.url === `${round}/end`)).toBe(false);

    // The first pass counts: 4 of 5 right.
    expect(await screen.findByText("Round done")).toBeVisible();
    expect(screen.getByText(/^4 of 5 right at the first try/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Another round" }));
    expect(await screen.findByText("Question 1 of 5")).toBeVisible();
    expect(calls.filter((c) => c.method === "POST" && c.url === `${base}/rounds`)).toHaveLength(2);
  });

  it("skips a card that cannot be served, and closes the round itself at the end", async () => {
    const user = userEvent.setup();
    const { calls } = stub({
      [`POST ${base}/rounds`]: ok({ round: { ...ROUND, cards: [card("k1"), card("k2")] } }),
      [`POST ${round}/serve/k1`]: fail(404),
    });
    const navigate = vi.fn();
    page(navigate);
    await startPointer(user);
    await user.click(await screen.findByRole("button", { name: "Skip" }));
    await answer(user, "4", "Finish");
    expect(await screen.findByText(/^1 of 1 right at the first try/)).toBeVisible();
    await vi.waitFor(() => expect(calls.some((c) => c.url === `${round}/end`)).toBe(true));
    await user.click(screen.getByRole("button", { name: "Back to the drill" }));
    expect(navigate).toHaveBeenCalledWith({ view: "drill" });
  });

  it("says so when no card of the student covers the concept", async () => {
    const user = userEvent.setup();
    stub({ [`POST ${base}/rounds`]: ok({ round: null }) });
    const navigate = vi.fn();
    page(navigate);
    await startPointer(user);
    expect(await screen.findByText("Nothing to revise yet")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Back to the drill" }));
    expect(navigate).toHaveBeenCalledWith({ view: "drill" });
  });

  it("says revision is not open when the server says so, with no Start", async () => {
    stub({ [`GET ${base}/concepts`]: ok({ available: false, concepts: [] }) });
    page();
    expect(await screen.findByText("Targeted revision is not available in this classroom")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });
});
