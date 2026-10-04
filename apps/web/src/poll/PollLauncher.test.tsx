import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CourseSummary, PollPoolPage, PollQuestionPick } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { PollLauncher } from "./PollLauncher";

/*
 * The launcher: one question and one audience, then the wall. Both tabs end
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
    saved: true,
    outcome: {
      kind: "keyed",
      runs: 4,
      correct: { rate: 0.45, percent: 45 },
      incorrect: { rate: 0.3, percent: 30 },
      abstention: { rate: 0.25, percent: 25 },
    },
  },
  {
    id: "55555555-5555-4555-8555-555555555555",
    type: "mcq",
    internalName: "Is the lab pace right?",
    prompt: "Is the lab pace right?",
    lastUsedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    useCount: 2,
    saved: false,
    outcome: { kind: "opinion", runs: 2, answers: 38 },
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    type: "short",
    internalName: "binary-search-complexity",
    prompt: "Complexity of a binary search?",
    lastUsedAt: null,
    useCount: 0,
    saved: true,
    outcome: { kind: "none" },
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

    await userEvent.click(screen.getByRole("tab", { name: /Recent polls/ }));
    expect(await screen.findByText("sizeof-ptr-64")).toBeVisible();
    expect(screen.getByText(/Polled 4 times/)).toBeVisible();
    // A question never asked says so rather than showing "0".
    expect(screen.getByText("Never polled")).toBeVisible();
  });

  it("opens on a new question, even with past polls: nothing of them on the wall", async () => {
    mockFetch({ [`GET ${QUESTIONS}`]: ok(picks), [`GET ${COURSES}`]: ok(courses) });
    renderWithProviders(<PollLauncher navigate={vi.fn()} />);

    expect(await screen.findByLabelText("Statement")).toBeVisible();
    expect(screen.getByRole("tab", { name: /Ask a new question/, selected: true })).toBeVisible();
    expect(
      screen.getAllByRole("tab").map((tab) => tab.textContent?.replace(/\d+$/, "")),
    ).toEqual(["Ask a new question", "Recent polls", "From pools"]);
    expect(screen.queryByText("sizeof-ptr-64")).toBeNull();
  }, 20_000);

  it("shows the recent polls on demand, each with its outcome in words", async () => {
    mockFetch({ [`GET ${QUESTIONS}`]: ok(picks), [`GET ${COURSES}`]: ok(courses) });
    renderWithProviders(<PollLauncher navigate={vi.fn()} />);

    await userEvent.click(screen.getByRole("tab", { name: /Recent polls/ }));
    await screen.findByText("sizeof-ptr-64");
    // A donut is an image whose name spells every share out.
    expect(
      screen.getByRole("img", { name: "Correct 45 % · Incorrect 30 % · No answer 25 % (last 4 runs)" }),
    ).toBeVisible();
    // An opinion poll has no donut, a count instead; a question never kept says so.
    expect(screen.getByText("38 answers")).toBeVisible();
    expect(screen.getByText(/not kept/)).toBeVisible();
    // One legend names the colours, abstention included.
    expect(screen.getByText("Outcome of the last runs")).toBeVisible();
    expect(screen.getByText("no answer")).toBeVisible();
  });

  it("says so when there is no poll to run again", async () => {
    // A teacher who never polled: the API answers an empty list, never a 404.
    mockFetch({ [`GET ${QUESTIONS}`]: ok([]), [`GET ${COURSES}`]: ok(courses) });
    renderWithProviders(<PollLauncher navigate={vi.fn()} />);

    expect(await screen.findByLabelText("Statement")).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: /Recent polls/ }));
    expect(await screen.findByText("No poll yet")).toBeVisible();
    expect(screen.getByText(/The questions of the polls you launch land here/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Ask a new question" }));
    expect(await screen.findByLabelText("Statement")).toBeVisible();
  }, 20_000);

  it("asks who answers with ONE control: anyone with the code, or a classroom", async () => {
    // An earlier launcher remembered the last classroom; this one never does.
    localStorage.setItem("quiz-poll-classroom", ROOM);
    mockFetch({ [`GET ${QUESTIONS}`]: ok(picks), [`GET ${COURSES}`]: ok(courses) });
    renderWithProviders(<PollLauncher navigate={vi.fn()} />);

    const audience = await screen.findByRole("combobox", { name: "Who answers" });
    // Anyone with the code, always: a classroom is chosen for each poll.
    expect(audience).toHaveValue("anonymous");
    expect(
      Array.from((audience as HTMLSelectElement).options).map((o) => o.textContent),
    ).toEqual(["Anyone with the code (anonymous)", "PRG1 · PRG1-2026"]);
    // The anonymity switch is gone: it is the audience now.
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("starts the poll on the picked question and the chosen classroom", async () => {
    const { calls } = mockFetch({
      [`GET ${QUESTIONS}`]: ok(picks),
      [`GET ${COURSES}`]: ok(courses),
      "POST /app/api/polls": ok({
        evaluation: { id: "e1", classroomId: ROOM, title: "t", state: "running", code: "QZ1", createdAt: new Date().toISOString() },
        joinUrl: "/p/QZ1",
        settings: { anonymous: true, revealed: false, votes: false },
        question: { id: QUESTION, type: "mcq", student: {}, solution: {} },
        tally: { joined: 0, answered: 0, choices: [], answers: [] },
      }),
    });
    const navigate = vi.fn();
    renderWithProviders(<PollLauncher navigate={navigate} />);

    // Nothing picked yet: the one primary action is not available.
    await userEvent.click(screen.getByRole("tab", { name: /Recent polls/ }));
    await screen.findByText("sizeof-ptr-64");
    expect(screen.getByRole("button", { name: "Start the poll" })).toBeDisabled();
    await userEvent.click(screen.getByText("sizeof-ptr-64"));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Who answers" }), ROOM);
    await userEvent.click(screen.getByRole("button", { name: "Start the poll" }));

    expect(calls.find((c) => c.url === "/app/api/polls")?.body).toEqual({
      questionId: QUESTION,
      audience: { kind: "classroom", classroomId: ROOM },
    });
    expect(navigate).toHaveBeenCalledWith({ view: "poll", id: "e1" });
  });

  it("filters the list rather than re-fetching it", async () => {
    mockFetch({ [`GET ${QUESTIONS}`]: ok(picks), [`GET ${COURSES}`]: ok(courses) });
    renderWithProviders(<PollLauncher navigate={vi.fn()} />);
    await userEvent.click(screen.getByRole("tab", { name: /Recent polls/ }));
    await screen.findByText("sizeof-ptr-64");

    await userEvent.type(screen.getByLabelText("Search the questions"), "binary");
    expect(screen.queryByText("sizeof-ptr-64")).toBeNull();
    expect(screen.getByText("binary-search-complexity")).toBeVisible();
  });

  const started = ok({
    evaluation: { id: "e2", classroomId: ROOM, title: "t", state: "running", code: "QZ2", createdAt: new Date().toISOString() },
    joinUrl: "/p/QZ2",
    settings: { anonymous: true, revealed: false, votes: false },
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
    // A poll starts with no key at all; the teacher adds one if they want it.
    expect(screen.queryByLabelText("Value 1")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Add an accepted answer" }));
    await user.type(screen.getByLabelText("Value 1"), "C");
    await user.click(screen.getByRole("button", { name: "Start the poll" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "poll", id: "e2" }));
    const body = calls.find((c) => c.url === "/app/api/polls/inline")?.body as {
      type: string;
      config: { prompt: string; matchers: { value: string }[] };
      audience: unknown;
    };
    expect(body).toMatchObject({ type: "short", audience: { kind: "anonymous" } });
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
        details: [{ path: [], code: "custom", message: "mcq.single_needs_one" }],
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
    expect(
      screen.getByText("A single-answer question has exactly one correct choice."),
    ).toBeVisible();
    expect(navigate).not.toHaveBeenCalled();
  }, 20_000);

  it("starts an opinion poll: no choice is correct, and nothing blocks on it", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [`GET ${QUESTIONS}`]: ok(picks),
      [`GET ${COURSES}`]: ok(courses),
      "POST /app/api/polls/inline": started,
    });
    const navigate = vi.fn();
    renderWithProviders(<PollLauncher navigate={navigate} />);

    await user.click(await screen.findByRole("tab", { name: /Ask a new question/ }));
    const prompt = await screen.findByLabelText("Statement");
    // Said once, quietly: the key is optional here.
    expect(screen.getByText(/Marking a correct answer is optional/)).toBeVisible();
    // Nothing ticked in advance: a key the teacher never chose would be on the wall.
    expect(screen.getByRole("checkbox", { name: "Choice A is correct" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Choice B is correct" })).not.toBeChecked();
    // …and the editor does not contradict it with "Tick the correct answers".
    expect(screen.queryByText("Tick the correct answers.")).toBeNull();

    await user.type(prompt, "?");
    await user.type(screen.getByLabelText("Text of choice A"), "Y");
    await user.type(screen.getByLabelText("Text of choice B"), "N");
    const start = screen.getByRole("button", { name: "Start the poll" });
    expect(start).toBeEnabled();
    await user.click(start);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "poll", id: "e2" }));
    const body = calls.find((c) => c.url === "/app/api/polls/inline")?.body as {
      config: { choices: { text: string; correct: boolean }[] };
    };
    expect(body.config.choices.map((c) => c.correct)).toEqual([false, false]);
  }, 20_000);
});

describe("PollLauncher · From pools (#162)", () => {
  const POOLS = "/app/api/polls/pool-questions";
  const POOL_QUESTION = "66666666-6666-4666-8666-666666666666";
  const OTHER_QUESTION = "77777777-7777-4777-8777-777777777777";

  const pageOf = (items: PollPoolPage["items"], tags: string[] = []): PollPoolPage => ({
    items,
    nextCursor: null,
    total: items.length,
    tags,
  });
  const linked = {
    id: POOL_QUESTION,
    type: "mcq" as const,
    internalName: "ptr-arith",
    prompt: "What does `p + 1` point to?",
    pool: { id: "88888888-8888-4888-8888-888888888888", name: "Programmation C" },
    tags: ["pointeurs"],
    difficulty: 2,
    latestNumber: 3,
  };
  const elsewhere = {
    id: OTHER_QUESTION,
    type: "short" as const,
    internalName: "i2c-lines",
    prompt: "How many lines does I²C use?",
    pool: { id: "99999999-9999-4999-8999-999999999999", name: "Systèmes embarqués" },
    tags: ["i2c"],
    difficulty: 1,
    latestNumber: 1,
  };

  it("searches every pool without a scope control when anyone answers, and starts the pick", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [`GET ${QUESTIONS}`]: ok(picks),
      [`GET ${COURSES}`]: ok(courses),
      [`GET ${POOLS}?limit=25`]: ok(pageOf([linked, elsewhere], ["i2c", "pointeurs"])),
      "POST /app/api/polls": ok({
        evaluation: { id: "e3", classroomId: null, title: "t", state: "running", code: "QZ3", createdAt: new Date().toISOString() },
        joinUrl: "/p/QZ3",
        settings: { anonymous: true, revealed: false, votes: false },
        question: { id: OTHER_QUESTION, type: "short", student: {}, solution: {} },
        tally: { joined: 0, answered: 0, choices: [], answers: [] },
      }),
    });
    const navigate = vi.fn();
    renderWithProviders(<PollLauncher navigate={navigate} />);

    await user.click(await screen.findByRole("tab", { name: /From pools/ }));
    expect(await screen.findByText("i2c-lines")).toBeVisible();
    // The pool, the version and the tags say where the question comes from.
    expect(screen.getByText(/Systèmes embarqués · v1 · #i2c/)).toBeVisible();
    expect(screen.getByText("2 questions")).toBeVisible();
    // An anonymous poll belongs to no course: nothing to narrow to.
    expect(screen.queryByRole("radiogroup", { name: "Which pools" })).toBeNull();

    const start = screen.getByRole("button", { name: "Start the poll" });
    expect(start).toBeDisabled();
    await user.click(screen.getByText("i2c-lines"));
    await user.click(start);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "poll", id: "e3" }));
    expect(calls.find((c) => c.url === "/app/api/polls")?.body).toEqual({
      questionId: OTHER_QUESTION,
      audience: { kind: "anonymous" },
    });
  });

  it("narrows to the classroom's pools by default, and widens to all of them", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [`GET ${QUESTIONS}`]: ok(picks),
      [`GET ${COURSES}`]: ok(courses),
      [`GET ${POOLS}?limit=25`]: ok(pageOf([linked, elsewhere])),
      [`GET ${POOLS}?limit=25&classroomId=${ROOM}`]: ok(pageOf([linked])),
    });
    renderWithProviders(<PollLauncher navigate={vi.fn()} />);

    await user.selectOptions(await screen.findByRole("combobox", { name: "Who answers" }), ROOM);
    await user.click(screen.getByRole("tab", { name: /From pools/ }));
    const scope = await screen.findByRole("radiogroup", { name: "Which pools" });
    expect(within(scope).getByRole("radio", { name: "Classroom pools" })).toBeChecked();
    expect(await screen.findByText("ptr-arith")).toBeVisible();
    expect(screen.queryByText("i2c-lines")).toBeNull();
    expect(calls.some((c) => c.url === `${POOLS}?limit=25&classroomId=${ROOM}`)).toBe(true);

    await user.click(within(scope).getByRole("radio", { name: "All pools" }));
    expect(await screen.findByText("i2c-lines")).toBeVisible();
    expect(screen.getByText("ptr-arith")).toBeVisible();
  });

  it("offers every pool when the classroom's are empty", async () => {
    const user = userEvent.setup();
    mockFetch({
      [`GET ${QUESTIONS}`]: ok(picks),
      [`GET ${COURSES}`]: ok(courses),
      [`GET ${POOLS}?limit=25`]: ok(pageOf([elsewhere])),
      [`GET ${POOLS}?limit=25&classroomId=${ROOM}`]: ok(pageOf([])),
    });
    renderWithProviders(<PollLauncher navigate={vi.fn()} />);

    await user.selectOptions(await screen.findByRole("combobox", { name: "Who answers" }), ROOM);
    await user.click(screen.getByRole("tab", { name: /From pools/ }));
    expect(await screen.findByText("No question to poll in this classroom's pools")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "All pools" }));
    expect(await screen.findByText("i2c-lines")).toBeVisible();
  });

  it("speaks the pool screen's grammar, and its sheet offers only the two poll types", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      [`GET ${QUESTIONS}`]: ok(picks),
      [`GET ${COURSES}`]: ok(courses),
      [`GET ${POOLS}?limit=25`]: ok(pageOf([linked, elsewhere], ["i2c", "pointeurs"])),
      [`GET ${POOLS}?tag=i2c&limit=25`]: ok(pageOf([elsewhere], ["i2c", "pointeurs"])),
    });
    renderWithProviders(<PollLauncher navigate={vi.fn()} />);

    await user.click(await screen.findByRole("tab", { name: /From pools/ }));
    await screen.findByText("ptr-arith");
    await user.type(screen.getByLabelText("Search a question"), "tag:i2c ");
    await waitFor(() => expect(screen.queryByText("ptr-arith")).toBeNull());
    expect(calls.some((c) => c.url === `${POOLS}?tag=i2c&limit=25`)).toBe(true);
    // The token became a chip, as on the pool screen.
    expect(screen.getByRole("button", { name: "Clear filters — #i2c" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Filters/ }));
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    expect(within(sheet).getByRole("button", { name: /Multiple choice/ })).toBeVisible();
    expect(within(sheet).getByRole("button", { name: /Short answer/ })).toBeVisible();
    expect(within(sheet).queryByRole("button", { name: /^Code/ })).toBeNull();
    // A poll never runs a deleted question: no switch for them.
    expect(within(sheet).queryByRole("switch")).toBeNull();
  });
});
