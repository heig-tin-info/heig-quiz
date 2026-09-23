import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PollTeacherView } from "@quiz/contracts";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { PollProjection } from "./PollProjection";

/*
 * The beamer screen. Four things are worth a test, because none of them is
 * visible in a code review of a page made of clamp() sizes: the key stays
 * hidden until the teacher reveals it, revealing is one POST and not a local
 * toggle, the way in (code, host, QR) is on screen the whole time, and it is
 * on screen in the corner the toasts do NOT use.
 */

const ID = "11111111-1111-4111-8111-111111111111";
const POLL = `/app/api/evaluations/${ID}/poll`;
const ROOM = "22222222-2222-4222-8222-222222222222";

function view(patch: Partial<PollTeacherView> = {}): PollTeacherView {
  return {
    evaluation: {
      id: ID,
      classroomId: ROOM,
      // The context line reads these two off the poll view itself; the screen
      // used to fetch `GET /classrooms/:id` for them.
      classroomName: "PRG1-2026",
      courseName: "Programmation C",
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

  it("writes where the poll is held without a second request", async () => {
    const { calls } = mockFetch({ [`GET ${POLL}`]: ok(view()) });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    expect(await screen.findByText("Programmation C · PRG1-2026")).toBeVisible();
    // The course and the room travel with the poll view; the classroom route
    // is not touched, because a beamer must not wait on a second round trip.
    expect(calls.some((c) => c.url.includes("/app/api/classrooms/"))).toBe(false);
  });

  it("puts the way in in the top-right corner, clear of the toasts", async () => {
    mockFetch({ [`GET ${POLL}`]: ok(view()) });
    const { container } = renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: /How many bytes/ });

    // The host, the code and the QR travel together, and they live in the
    // FIRST band of the stage — the top strip — not under the distribution.
    const join = container.querySelector<HTMLElement>("[data-poll-join]");
    expect(join).not.toBeNull();
    const header = join!.closest("header");
    expect(header).not.toBeNull();
    expect(header!.parentElement!.firstElementChild).toBe(header);
    expect(header!.className).toContain("items-start");
    expect(within(join!).getByRole("img", { name: /QZ4F7K/ })).toBeVisible();
    expect(within(join!).getByText("QZ4F7K")).toBeVisible();

    // The app's toaster stack is pinned to the OPPOSITE corner (notify.tsx),
    // which is the whole reason the tile moved: a "student joined" notice
    // used to land on the QR the room was scanning.
    const toaster = document.querySelector('[aria-live="polite"][aria-relevant="additions"]');
    expect(toaster).not.toBeNull();
    expect(toaster!.className).toContain("bottom-4");
    expect(toaster!.className).toContain("right-4");
    expect(toaster!.contains(join!)).toBe(false);
  });

  it("splits a long list of choices into two columns, in reading order", async () => {
    const choices = Array.from({ length: 8 }, (_, i) => ({ id: i, text: `choice ${i + 1}` }));
    mockFetch({
      [`GET ${POLL}`]: ok(
        view({
          question: {
            id: "q1",
            type: "mcq",
            student: { prompt: "Which of these are true?", mode: "multiple", choices },
            solution: { correct: [1] },
          },
          tally: {
            joined: 20,
            answered: 16,
            choices: choices.map((c) => ({ index: c.id, count: 2 })),
            answers: [],
          },
        }),
      ),
    });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);

    const list = (await screen.findByText("choice 1")).closest("ul")!;
    // Eight bars in one column is a list so tall the fit shrinks the whole
    // wall to hold it; two columns halve the height for the same text.
    expect(list.className).toContain("lg:grid");
    expect(list.className).toContain("lg:grid-flow-col");
    // Column-major over four rows: A–D on the left, E–H on the right, so the
    // letters still read downwards.
    expect(list.style.gridTemplateRows).toBe("repeat(4, auto)");
    expect(list.style.gridAutoColumns).toBe("minmax(0, 1fr)");
    // The DOM order is the served order, whatever the columns do with it.
    expect(within(list).getAllByText(/^choice /).map((el) => el.textContent)).toEqual(
      choices.map((c) => c.text),
    );
  });

  it("keeps a short list in one column", async () => {
    mockFetch({ [`GET ${POLL}`]: ok(view()) });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    const list = (await screen.findByText("four")).closest("ul")!;
    expect(list.className).not.toContain("lg:grid");
    expect(list.style.gridTemplateRows).toBe("");
  });

  it("hides what leaves the middle band instead of scrolling it", async () => {
    mockFetch({ [`GET ${POLL}`]: ok(view()) });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    const heading = await screen.findByRole("heading", { name: /How many bytes/ });

    // A scrollbar on a wall is a bar nobody in the room will ever see; the
    // band shrinks its content (`useStageFit` + `fitScale`) instead.
    const band = heading.closest("div[class*='overflow']");
    expect(band).not.toBeNull();
    expect(band!.className).toContain("sm:overflow-hidden");
    expect(band!.className).not.toContain("overflow-y-auto");
  });

  it("names the correct choice once the answer is revealed", async () => {
    mockFetch({ [`GET ${POLL}`]: ok(view({ settings: { anonymous: true, revealed: true } })) });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);

    // Icon AND word, never the tint alone: a projector eats half the
    // saturation of a lecture-hall wall.
    expect(await screen.findByText("Correct answer")).toBeVisible();
  });

  it("marks nothing right when the poll has no key, and says results instead", async () => {
    const { calls } = mockFetch({
      [`GET ${POLL}`]: ok(view({ question: { id: "q1", type: "mcq", student: view().question.student, solution: { correct: [] } } })),
      [`POST ${POLL}/reveal`]: ok(
        view({
          settings: { anonymous: true, revealed: true },
          question: { id: "q1", type: "mcq", student: view().question.student, solution: { correct: [] } },
        }),
      ),
    });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: /How many bytes/ });

    await userEvent.click(screen.getByRole("radio", { name: "Results shown" }));
    expect(await screen.findByText("Results shown", { selector: "span" })).toBeVisible();
    expect(calls.find((c) => c.url === `${POLL}/reveal`)?.body).toEqual({ revealed: true });
    // The distribution stays whole: no tick, no word, no faded row.
    expect(screen.getByText("75%")).toBeVisible();
    expect(screen.queryByText("Correct answer")).toBeNull();
    expect(screen.queryByText("Answer revealed")).toBeNull();
    expect(screen.getByText("25%").className).not.toContain("text-fg-faint");
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
            classroomName: "PRG1-2026",
            courseName: "Programmation C",
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
