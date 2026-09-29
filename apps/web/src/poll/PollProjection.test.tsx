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
    settings: { anonymous: true, revealed: false, votes: true, ...(patch.settings ?? {}) },
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
      saved: false,
      pool: null,
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

  it("says who may answer when the poll belongs to no classroom, and goes back to the launcher", async () => {
    const anonymous = view({
      evaluation: { ...view().evaluation, classroomId: null, classroomName: null, courseName: null },
    });
    mockFetch({ [`GET ${POLL}`]: ok(anonymous) });
    const navigate = vi.fn();
    renderWithProviders(<PollProjection id={ID} navigate={navigate} />);
    expect(await screen.findByText("Anyone with the code")).toBeVisible();
    expect(screen.queryByText(/null/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back to polls" }));
    expect(navigate).toHaveBeenCalledWith({ view: "polls" });
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
            saved: false,
            pool: null,
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

  it("keeps the choices on the wall and the votes off it until shown (#157)", async () => {
    const { calls } = mockFetch({
      [`GET ${POLL}`]: ok(view({ settings: { anonymous: true, revealed: false, votes: false } })),
      [`POST ${POLL}/reveal`]: ok(view({ settings: { anonymous: true, revealed: false, votes: true } })),
    });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: /How many bytes/ });

    // The room reads what it votes on, not how it votes.
    expect(screen.getByText("four")).toBeVisible();
    expect(screen.getByText("eight")).toBeVisible();
    expect(screen.queryByText("75%")).toBeNull();
    expect(screen.queryByText("6 votes")).toBeNull();
    expect(screen.getByRole("switch", { name: "Show votes" })).not.toBeChecked();
    // The footer still says how many answered: that is when to move on.
    expect(screen.getByText("8 answers received · 2 waiting")).toBeVisible();

    await userEvent.keyboard("{ArrowRight}");
    expect(await screen.findByText("75%")).toBeVisible();
    expect(calls.find((c) => c.url === `${POLL}/reveal`)?.body).toEqual({
      revealed: false,
      votes: true,
    });
  });

  it("makes End the primary action and says who it would leave out", async () => {
    mockFetch({ [`GET ${POLL}`]: ok(view()) });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: /How many bytes/ });

    const end = screen.getByRole("button", { name: "End poll" });
    expect(end.className).toContain("bg-accent");
    // tally.joined − tally.answered, nothing else: no roster count.
    expect(screen.getByText("2 joined have not answered yet")).toBeVisible();
    // The two switches are secondary, and independent.
    expect(screen.getByRole("switch", { name: "Show votes" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Reveal answer" })).not.toBeChecked();
  });

  it("toggles the votes with v and the key with r, one switch each", async () => {
    const { calls } = mockFetch({
      [`GET ${POLL}`]: ok(view()),
      [`POST ${POLL}/reveal`]: ok(view()),
    });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: /How many bytes/ });

    await userEvent.keyboard("r");
    await userEvent.keyboard("v");
    const bodies = calls.filter((c) => c.url === `${POLL}/reveal`).map((c) => c.body);
    expect(bodies).toEqual([{ revealed: true }, { votes: false }]);
  });

  it("shows the key without the votes, and the remote adds the votes from there", async () => {
    const keyOnly = view({ settings: { anonymous: true, revealed: true, votes: false } });
    const { calls } = mockFetch({
      [`GET ${POLL}`]: ok(keyOnly),
      [`POST ${POLL}/reveal`]: ok(view({ settings: { anonymous: true, revealed: true, votes: true } })),
    });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: /How many bytes/ });

    expect(screen.getByText("Correct answer")).toBeVisible();
    expect(screen.queryByText("75%")).toBeNull();
    await userEvent.keyboard("{PageDown}");
    expect(await screen.findByText("75%")).toBeVisible();
    expect(calls.find((c) => c.url === `${POLL}/reveal`)?.body).toEqual({
      revealed: true,
      votes: true,
    });
  });

  it("lists no typed answer while the votes of a short poll are hidden", async () => {
    mockFetch({
      [`GET ${POLL}`]: ok(
        view({
          settings: { anonymous: true, revealed: false, votes: false },
          question: {
            id: "q1",
            type: "short",
            student: { prompt: "Name a pointer size" },
            solution: { expected: ["8"] },
            saved: false,
            pool: null,
          },
          tally: { joined: 3, answered: 2, choices: [], answers: [{ text: "eight", count: 2 }] },
        }),
      ),
    });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    expect(await screen.findByText("The answers stay hidden for now.")).toBeVisible();
    expect(screen.queryByText("eight")).toBeNull();
  });

  it("has no menu: the way back, the bookmark and End poll are on the strip", async () => {
    const navigate = vi.fn();
    mockFetch({ [`GET ${POLL}`]: ok(view()) });
    renderWithProviders(<PollProjection id={ID} navigate={navigate} />);
    await screen.findByRole("heading", { name: /How many bytes/ });

    expect(screen.queryByRole("button", { name: /^actions$/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Keep this question" })).toBeVisible();
    expect(screen.getByRole("button", { name: "End poll" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to the classroom" }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: ROOM });
  });

  it("names the correct choice once the answer is revealed", async () => {
    mockFetch({ [`GET ${POLL}`]: ok(view({ settings: { anonymous: true, revealed: true, votes: true } })) });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);

    // Icon AND word, never the tint alone: a projector eats half the
    // saturation of a lecture-hall wall.
    expect(await screen.findByText("Correct answer")).toBeVisible();
  });

  it("offers no reveal when the poll has no key, only the votes", async () => {
    const keyless = { id: "q1", type: "mcq" as const, student: view().question.student, solution: { correct: [] }, saved: false, pool: null };
    const { calls } = mockFetch({
      [`GET ${POLL}`]: ok(view({ settings: { anonymous: true, revealed: false, votes: false }, question: keyless })),
      [`POST ${POLL}/reveal`]: ok(view({ settings: { anonymous: true, revealed: false, votes: true }, question: keyless })),
    });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: /How many bytes/ });

    expect(screen.queryByRole("switch", { name: "Reveal answer" })).toBeNull();
    await userEvent.keyboard("r");
    expect(calls.some((c) => c.url === `${POLL}/reveal`)).toBe(false);
    await userEvent.click(screen.getByRole("switch", { name: "Show votes" }));
    expect(calls.find((c) => c.url === `${POLL}/reveal`)?.body).toEqual({ votes: true });
    // The distribution stays whole: no tick, no word, no faded row.
    expect(await screen.findByText("75%")).toBeVisible();
    expect(screen.queryByText("Correct answer")).toBeNull();
    expect(screen.getByText("25%").className).not.toContain("text-fg-faint");
  });

  it("shows the votes of a keyless poll revealed before the switches were split", async () => {
    const keyless = { id: "q1", type: "mcq" as const, student: view().question.student, solution: { correct: [] }, saved: false, pool: null };
    const { calls } = mockFetch({
      [`GET ${POLL}`]: ok(view({ settings: { anonymous: true, revealed: true, votes: false }, question: keyless })),
      [`POST ${POLL}/reveal`]: ok(view({ settings: { anonymous: true, revealed: false, votes: false }, question: keyless })),
    });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: /How many bytes/ });

    expect(screen.getByText("75%")).toBeVisible();
    expect(screen.getByRole("switch", { name: "Show votes" })).toBeChecked();
    await userEvent.click(screen.getByRole("switch", { name: "Show votes" }));
    // Hiding clears the stored reveal too, or the votes would stay on.
    expect(calls.find((c) => c.url === `${POLL}/reveal`)?.body).toEqual({ votes: false, revealed: false });
  });

  it("reveals through the server, never locally", async () => {
    const { calls } = mockFetch({
      [`GET ${POLL}`]: ok(view()),
      [`POST ${POLL}/reveal`]: ok(view({ settings: { anonymous: true, revealed: true, votes: true } })),
    });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: /How many bytes/ });

    await userEvent.click(screen.getByRole("switch", { name: "Reveal answer" }));
    expect(await screen.findByText("Correct answer")).toBeVisible();
    // The reveal says nothing of the votes: they stay where they were.
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

describe("PollProjection — keep this question (ADR-014, addenda item 6)", () => {
  const ended = {
    id: ID,
    classroomId: ROOM,
    classroomName: "PRG1-2026",
    courseName: "Programmation C",
    title: "Warm-up — sizes",
    state: "closed",
    code: "QZ4F7K",
    createdAt: new Date().toISOString(),
  };
  const kept = { saved: true, pool: { id: "p0", name: "Polls" } };

  it("keeps an unsaved question from its bookmark while the room answers", async () => {
    const navigate = vi.fn();
    const { calls } = mockFetch({
      [`GET ${POLL}`]: ok(view()),
      [`POST ${POLL}/keep`]: ok(view({ question: { ...view().question, ...kept } })),
    });
    renderWithProviders(<PollProjection id={ID} navigate={navigate} />);
    await screen.findByRole("heading", { name: /How many bytes/ });

    // The wall is the room's: an icon while the poll runs, not a button in words.
    await userEvent.click(screen.getByRole("button", { name: "Keep this question" }));
    expect(calls.some((c) => c.url === `${POLL}/keep`)).toBe(true);
    const where = await screen.findByRole("button", { name: "Kept in Polls" });
    expect(screen.queryByRole("button", { name: "Keep this question" })).toBeNull();
    await userEvent.click(where);
    expect(navigate).toHaveBeenCalledWith({ view: "question", id: "q1" });
  });

  it("offers Keep beside Run again once the poll is over, then where it went", async () => {
    const navigate = vi.fn();
    mockFetch({
      [`GET ${POLL}`]: ok(view({ evaluation: ended })),
      [`POST ${POLL}/keep`]: ok(
        view({ evaluation: ended, question: { ...view().question, ...kept } }),
      ),
    });
    renderWithProviders(<PollProjection id={ID} navigate={navigate} />);

    await userEvent.click(await screen.findByRole("button", { name: /Keep this question/ }));
    const where = await screen.findByRole("button", { name: /Kept in Polls/ });
    expect(screen.queryByRole("button", { name: /Keep this question/ })).toBeNull();
    await userEvent.click(where);
    expect(navigate).toHaveBeenCalledWith({ view: "question", id: "q1" });
  });

  it("offers nothing to keep when the question already sits in a pool", async () => {
    mockFetch({
      [`GET ${POLL}`]: ok(
        view({ evaluation: ended, question: { ...view().question, saved: true, pool: null } }),
      ),
    });
    renderWithProviders(<PollProjection id={ID} navigate={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Run again/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Keep this question/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Kept in/ })).toBeNull();
  });
});
