import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { CourseSummary, PollQuestionPick } from "@quiz/contracts";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { PollLauncher } from "./PollLauncher";

/*
 * The launcher: one question and one classroom, then the wall. The two tabs
 * do NOT share a primary action — picking ends in "Start poll", writing ends
 * in the editor — and that split is what these tests pin down.
 */

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

  it("sends a new question to the editor and says it will come back", async () => {
    mockFetch({
      [`GET ${QUESTIONS}`]: ok(picks),
      [`GET ${COURSES}`]: ok(courses),
      [`POST ${QUESTIONS}`]: ok({ meta: { id: "q-new" }, draft: {}, versions: [] }),
    });
    const navigate = vi.fn();
    renderWithProviders(<PollLauncher navigate={navigate} />);

    await userEvent.click(await screen.findByRole("tab", { name: /Ask a new question/ }));
    expect(screen.getByText(/come back here to run it/)).toBeVisible();
    await userEvent.type(screen.getByLabelText("Internal name"), "warm-up-1");
    await userEvent.click(screen.getByRole("button", { name: "Create question" }));

    expect(navigate).toHaveBeenCalledWith({ view: "question", id: "q-new" });
  });
});
