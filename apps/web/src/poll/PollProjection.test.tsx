import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PollTeacherView } from "@quiz/contracts";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { PollProjection } from "./PollProjection";

/*
 * The beamer screen. Three things are worth a test, because none of them is
 * visible in a code review of a page made of clamp() sizes: the key stays
 * hidden until the teacher reveals it, revealing is one POST and not a local
 * toggle, and the way in (code, host, QR) is on screen the whole time.
 */

const ID = "11111111-1111-4111-8111-111111111111";
const POLL = `/app/api/evaluations/${ID}/poll`;
const ROOM = "22222222-2222-4222-8222-222222222222";

function view(patch: Partial<PollTeacherView> = {}): PollTeacherView {
  return {
    evaluation: {
      id: ID,
      classroomId: ROOM,
      title: "Warm-up — sizes",
      state: "running",
      code: "QZ4F7K",
      createdAt: new Date().toISOString(),
      ...(patch.evaluation ?? {}),
    },
    joinUrl: "https://quiz.heig-vd.ch/p/QZ4F7K",
    settings: { anonymous: true, revealed: false, ...(patch.settings ?? {}) },
    question: {
      id: "q1",
      type: "mcq",
      student: {
        prompt: "How many bytes is a pointer?",
        mode: "single",
        choices: [
          { id: 0, text: "four" },
          { id: 1, text: "eight" },
        ],
      },
      solution: { correct: [1] },
      ...(patch.question ?? {}),
    },
    tally: {
      joined: 10,
      answered: 8,
      choices: [
        { index: 0, count: 2 },
        { index: 1, count: 6 },
      ],
      answers: [],
      ...(patch.tally ?? {}),
    },
  };
}

describe("PollProjection", () => {
  it("shows the distribution and the way in, and keeps the key to itself", async () => {
    mockFetch({ [`GET ${POLL}`]: ok(view()) });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: /How many bytes/ })).toBeVisible();
    expect(screen.getByText("75%")).toBeVisible();
    expect(screen.getByText("25%")).toBeVisible();
    // The way in is permanent: a latecomer joins from the back of the room.
    expect(screen.getByText("QZ4F7K")).toBeVisible();
    expect(screen.getByText(/quiz\.heig-vd\.ch/)).toBeVisible();
    expect(screen.getByText("8 answers received · 2 waiting")).toBeVisible();
    // Not revealed: nothing on the wall says which one is right.
    expect(screen.queryByText("Correct answer")).toBeNull();
  });

  it("names the correct choice once the answer is revealed", async () => {
    mockFetch({ [`GET ${POLL}`]: ok(view({ settings: { anonymous: true, revealed: true } })) });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);

    // Icon AND word, never the tint alone: a projector eats half the
    // saturation of a lecture-hall wall.
    expect(await screen.findByText("Correct answer")).toBeVisible();
  });

  it("reveals through the server, never locally", async () => {
    const { calls } = mockFetch({
      [`GET ${POLL}`]: ok(view()),
      [`POST ${POLL}/reveal`]: ok(view({ settings: { anonymous: true, revealed: true } })),
    });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: /How many bytes/ });

    await userEvent.click(screen.getByRole("radio", { name: "Answer revealed" }));
    expect(await screen.findByText("Correct answer")).toBeVisible();
    expect(calls.find((c) => c.url === `${POLL}/reveal`)?.body).toEqual({ revealed: true });
  });

  it("offers Run again, and only that, once the poll is over", async () => {
    mockFetch({
      [`GET ${POLL}`]: ok(
        view({
          evaluation: {
            id: ID,
            classroomId: ROOM,
            title: "Warm-up — sizes",
            state: "closed",
            code: "QZ4F7K",
            createdAt: new Date().toISOString(),
          },
        }),
      ),
    });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /Run again/ })).toBeVisible();
    expect(screen.getByText("Poll ended")).toBeVisible();
  });
});
