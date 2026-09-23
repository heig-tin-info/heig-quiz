import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CourseSummary, PollQuestionPick } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { PollLauncher } from "./PollLauncher";

/*
 * The launcher: one question and one classroom, then the wall. Both tabs end
 * in "Start the poll": on a picked question, or on one written in the type's
 * own editor and saved nowhere (ADR-014, addendum 2026-09-23).
 */

/*
 * jsdom implements `Range` but none of its layout methods, and ProseMirror —
 * the statement field of the "Ask a new question" tab — calls them. Stubbed
 * here, as in `QuestionEditor.test.tsx`, never globally.
 */
if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
document.elementFromPoint ??= () => null;

const QUESTIONS = "/app/api/polls/questions";
const COURSES = "/app/api/courses";
const ROOM = "22222222-2222-4222-8222-222222222222";
const QUESTION = "33333333-3333-4333-8333-333333333333";

const picks: PollQuestionPick[] = [
  {
    id: QUESTION,
    type: "mcq",
    internalName: "sizeof-ptr-64",
    prompt: "How many bytes is a pointer on LP64?",
    lastUsedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    useCount: 4,
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    type: "short",
    internalName: "binary-search-complexity",
    prompt: "Complexity of a binary search?",
    lastUsedAt: null,
    useCount: 0,
  },
];

const courses: CourseSummary[] = [
  {
    id: "c1",
    name: "Programmation C",
    code: "PRG1",
    classroomCount: 1,
    poolCount: 1,
    classrooms: [{ id: ROOM, name: "PRG1-2026", period: "2026", studentCount: 24, archivedAt: null }],
  } as unknown as CourseSummary,
];

describe("PollLauncher", () => {
  it("lists the pollable questions with how often they have been asked", async () => {
    mockFetch({ [`GET ${QUESTIONS}`]: ok(picks), [`GET ${COURSES}`]: ok(courses) });
    renderWithProviders(<PollLauncher navigate={vi.fn()} />);

    expect(await screen.findByText("sizeof-ptr-64")).toBeVisible();
    expect(screen.getByText(/Polled 4 times/)).toBeVisible();
    // A question never asked says so rather than showing "0".
    expect(screen.getByText("Never polled")).toBeVisible();
  });

  it("starts the poll on the picked question and the chosen classroom", async () => {
    const { calls } = mockFetch({
      [`GET ${QUESTIONS}`]: ok(picks),
      [`GET ${COURSES}`]: ok(courses),
      "POST /app/api/polls": ok({
        evaluation: { id: "e1", classroomId: ROOM, title: "t", state: "running", code: "QZ1", createdAt: new Date().toISOString() },
        joinUrl: "/p/QZ1",
        settings: { anonymous: true, revealed: false },
        question: { id: QUESTION, type: "mcq", student: {}, solution: {} },
        tally: { joined: 0, answered: 0, choices: [], answers: [] },
      }),
    });
    const navigate = vi.fn();
    renderWithProviders(<PollLauncher navigate={navigate} />);

    // Nothing picked yet: the one primary action is not available.
    await screen.findByText("sizeof-ptr-64");
    expect(screen.getByRole("button", { name: "Start the poll" })).toBeDisabled();
    await userEvent.click(screen.getByText("sizeof-ptr-64"));
    await userEvent.click(screen.getByRole("button", { name: "Start the poll" }));

    expect(calls.find((c) => c.url === "/app/api/polls")?.body).toEqual({
      questionId: QUESTION,
      classroomId: ROOM,
      anonymous: true,
    });
    expect(navigate).toHaveBeenCalledWith({ view: "poll", id: "e1" });
  });

  it("filters the list rather than re-fetching it", async () => {
    mockFetch({ [`GET ${QUESTIONS}`]: ok(picks), [`GET ${COURSES}`]: ok(courses) });
    renderWithProviders(<PollLauncher navigate={vi.fn()} />);
    await screen.findByText("sizeof-ptr-64");

    await userEvent.type(screen.getByLabelText("Search the questions"), "binary");
    expect(screen.queryByText("sizeof-ptr-64")).toBeNull();
    expect(screen.getByText("binary-search-complexity")).toBeVisible();
  });

  const started = ok({
    evaluation: { id: "e2", classroomId: ROOM, title: "t", state: "running", code: "QZ2", createdAt: new Date().toISOString() },
    joinUrl: "/p/QZ2",
    settings: { anonymous: true, revealed: false },
    question: { id: QUESTION, type: "short", student: {}, solution: {} },
    tally: { joined: 0, answered: 0, choices: [], answers: [] },
  });

  it("writes a new question in the type's own editor, without marks, and starts it", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [`GET ${QUESTIONS}`]: ok(picks),
      [`GET ${COURSES}`]: ok(courses),
      "POST /app/api/polls/inline": started,
    });
    const navigate = vi.fn();
    renderWithProviders(<PollLauncher navigate={navigate} />);

    await user.click(await screen.findByRole("tab", { name: /Ask a new question/ }));
    // No name to give, nothing to save: the tile grid, then the editor.
    expect(screen.queryByLabelText("Internal name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create question" })).toBeNull();
    expect(screen.getByText(/Nothing is saved/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Short answer/ }));
    const prompt = await screen.findByLabelText("Statement");
    // A poll gives no marks: no points, no prefilters.
    expect(screen.queryByLabelText("Points 1")).toBeNull();
    expect(screen.queryByLabelText("Trim")).toBeNull();

    // One keystroke: where a caret lands in a fresh contenteditable is jsdom's
    // business, as in `QuestionEditor.test.tsx`.
    await user.type(prompt, "?");
    await user.type(screen.getByLabelText("Value 1"), "C");
    await user.click(screen.getByRole("button", { name: "Start the poll" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "poll", id: "e2" }));
    const body = calls.find((c) => c.url === "/app/api/polls/inline")?.body as {
      type: string;
      config: { prompt: string; matchers: { value: string }[] };
      classroomId: string;
      anonymous: boolean;
    };
    expect(body).toMatchObject({ type: "short", classroomId: ROOM, anonymous: true });
    expect(body.config.prompt).toContain("?");
    expect(body.config.matchers[0]!.value).toBe("C");
    // Nothing went through the personal pool.
    expect(calls.some((c) => c.method === "POST" && c.url === QUESTIONS)).toBe(false);
  }, 20_000);

  it("places the schema's refusal under the fields, translated", async () => {
    const user = userEvent.setup();
    mockFetch({
      [`GET ${QUESTIONS}`]: ok(picks),
      [`GET ${COURSES}`]: ok(courses),
      "POST /app/api/polls/inline": fail(422, {
        error: "config_invalid",
        message: "The question is incomplete",
        details: [{ path: [], code: "custom", message: "mcq.no_correct_choice" }],
      }),
    });
    const navigate = vi.fn();
    renderWithProviders(<PollLauncher navigate={navigate} />);

    await user.click(await screen.findByRole("tab", { name: /Ask a new question/ }));
    await screen.findByLabelText("Statement");
    // The mcq editor, without its scoring card.
    expect(screen.queryByText("Scoring")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Start the poll" }));

    expect(await screen.findByText("Could not start the poll.")).toBeVisible();
    expect(screen.getByText(/fields that need attention/)).toBeVisible();
    expect(screen.getByText("Tick at least one correct choice.")).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
  }, 20_000);
});
