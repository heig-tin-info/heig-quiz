import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { PollIdeaBoard, PollTeacherView } from "@quiz/contracts";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { PollModeration } from "./PollModeration";

const ID = "00000000-0000-4000-8000-0000000000aa";
const POLL = `/app/api/evaluations/${ID}/poll`;

const view = {
  evaluation: {
    id: ID,
    classroomId: null,
    classroomName: null,
    courseName: null,
    title: "Vivant",
    state: "running",
    code: "BR4N5T",
    createdAt: new Date().toISOString(),
  },
  joinUrl: "https://quiz.heig-vd.ch/p/BR4N5T",
  settings: { anonymous: true, revealed: false, votes: true, moderation: true, ai: true },
  question: {
    id: "q1",
    type: "brainstorm",
    student: { prompt: "Qu'est-ce qui caractérise un être vivant ?", maxIdeas: 5 },
    solution: null,
    saved: false,
    pool: null,
  },
  tally: { joined: 3, answered: 2, choices: [], answers: [], ideas: [], pending: 1 },
} satisfies PollTeacherView;

const board = (patch: Partial<PollIdeaBoard> = {}): PollIdeaBoard => ({
  moderation: true,
  ai: { available: true, on: true, error: null },
  answered: 2,
  pending: 1,
  clusters: [
    {
      key: "il respir",
      label: "Respiration",
      renamed: false,
      count: 1,
      total: 1,
      variants: [{ key: "il respir", text: "il respir", correction: "Respiration", ai: true, count: 1, status: "approved" }],
    },
    {
      key: "grandit",
      label: "grandit",
      renamed: false,
      count: 0,
      total: 1,
      variants: [{ key: "grandit", text: "grandit", correction: null, ai: false, count: 1, status: "pending" }],
    },
  ],
  ...patch,
});

describe("PollModeration", () => {
  it("shows what was typed beside the AI's correction, the waiting idea first, and approves the queue", async () => {
    const { calls } = mockFetch({
      [`GET ${POLL}`]: ok(view),
      [`GET ${POLL}/ideas`]: ok(board()),
      [`POST ${POLL}/ideas`]: ok(board({ pending: 0 })),
    });
    renderWithProviders(<PollModeration id={ID} />);

    const cards = await screen.findAllByRole("listitem");
    expect(within(cards[0]!).getByText("grandit", { selector: "span.break-all" })).toBeVisible();
    expect(screen.getByText("il respir")).toBeVisible();
    expect(screen.getByText("→ Respiration")).toBeVisible();
    expect(screen.getAllByLabelText("Decided by the AI")).toHaveLength(1);
    expect(screen.getByRole("switch", { name: "AI assistance" })).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: /Approve all \(1\)/ }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ action: "approve", keys: ["grandit"] });
  });

  it("says when the AI stopped judging, and offers no switch when no model can be called", async () => {
    mockFetch({
      [`GET ${POLL}`]: ok(view),
      [`GET ${POLL}/ideas`]: ok(board({ ai: { available: true, on: true, error: "budget_exhausted" } })),
    });
    const { unmount } = renderWithProviders(<PollModeration id={ID} />);
    expect(await screen.findByText("The AI stopped judging the ideas")).toBeVisible();
    unmount();

    mockFetch({
      [`GET ${POLL}`]: ok(view),
      [`GET ${POLL}/ideas`]: ok(board({ ai: { available: false, on: false, error: null } })),
    });
    renderWithProviders(<PollModeration id={ID} />);
    expect(await screen.findByRole("switch", { name: "Moderation" })).toBeVisible();
    expect(screen.queryByRole("switch", { name: "AI assistance" })).toBeNull();
  });
});
