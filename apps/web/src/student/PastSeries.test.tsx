import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Me, PracticeCard, StudentHome as StudentHomeData } from "@quiz/contracts";

import { makeMe } from "../test/fixtures";
import { mockFetch, ok, publicConfig, renderWithProviders, type Reply } from "../test/render";
import { StudentHome } from "./StudentHome";

/*
 * "Past series" on the student's home (ADR-122): the exercises over and open
 * to practice, each with one quiet action and its latest practice's points —
 * never a grade — and nothing at all when the list is empty.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const me: Me = makeMe({ id: "u1", givenName: "Léa", familyName: "Perret", role: "student" });

const practice = (over: Partial<PracticeCard>): PracticeCard => ({
  id: "e9",
  title: "Série 2 — Boucles",
  classroomId: "r1",
  classroomName: "PRG1-2026",
  courseCode: "PRG1",
  closedAt: "2026-10-20T16:00:00.000Z",
  openAttemptId: null,
  count: 0,
  last: null,
  ...over,
});

const homeWith = (cards: PracticeCard[]): StudentHomeData => ({
  polls: [],
  groupSets: [],
  open: [],
  upcoming: [],
  past: [],
  practice: cards,
  serverNow: new Date().toISOString(),
});

const PRINT = "/app/api/student/evaluations/e9/handout.pdf";

const render = (cards: PracticeCard[], navigate = vi.fn(), extra: Record<string, Reply> = {}) => {
  const { calls } = mockFetch({
    "GET /app/api/student/home": ok(homeWith(cards)),
    "GET /app/api/student/classrooms": ok([]),
    ...extra,
  });
  renderWithProviders(<StudentHome me={me} navigate={navigate} />);
  return Object.assign(navigate, { calls });
};

describe("the student's Past series", () => {
  it("lists an exercise open to practice, and opens its practice route", async () => {
    const user = userEvent.setup();
    const navigate = render([practice({})]);
    const section = (await screen.findByRole("heading", { name: "Past series" })).closest("section")!;
    expect(within(section).getByText("Série 2 — Boucles")).toBeVisible();
    await user.click(within(section).getByRole("button", { name: "Practise" }));
    expect(navigate).toHaveBeenCalledWith({ view: "attempt", evaluationId: "e9", practice: true });
  });

  it("shows the latest practice's points, never a grade, and offers to practise again", async () => {
    render([
      practice({
        count: 2,
        last: { attemptId: "a7", finishedAt: null, score: { points: 7.5, totalPoints: 10, pendingCount: 0 } },
      }),
    ]);
    const section = (await screen.findByRole("heading", { name: "Past series" })).closest("section")!;
    expect(within(section).getByText("Last practice: 7.5 / 10 points")).toBeVisible();
    expect(within(section).getByRole("button", { name: "Practise again" })).toBeVisible();
    // The title opens that practice's results.
    expect(within(section).getByRole("link", { name: "Série 2 — Boucles" })).toHaveAttribute(
      "href",
      expect.stringContaining("a7"),
    );
  });

  it("resumes a practice attempt still open", async () => {
    render([practice({ openAttemptId: "a8" })]);
    const section = (await screen.findByRole("heading", { name: "Past series" })).closest("section")!;
    expect(within(section).getByText("in progress")).toBeVisible();
    expect(within(section).getByRole("button", { name: "Resume" })).toBeVisible();
  });

  it("prints the blank series beside the row's one action, when the server makes PDFs", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn((_blob: Blob) => "blob:pdf");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const { calls } = render([practice({})], vi.fn(), { ...publicConfig(true), [`GET ${PRINT}`]: ok("%PDF-1.7") });
    const section = (await screen.findByRole("heading", { name: "Past series" })).closest("section")!;
    const print = await within(section).findByRole("button", { name: "Print the series" });
    // Practise stays the row's one button with a label.
    expect(within(section).getByRole("button", { name: "Practise" })).toBeVisible();
    await user.click(print);
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.url === PRINT)).toHaveLength(1);
  });

  it("offers no print when the server makes no PDF", async () => {
    render([practice({})], vi.fn(), publicConfig(false));
    const section = (await screen.findByRole("heading", { name: "Past series" })).closest("section")!;
    expect(within(section).getByRole("button", { name: "Practise" })).toBeVisible();
    // The config has answered: still no print.
    await waitFor(() => expect(within(section).queryByRole("button", { name: "Print the series" })).toBeNull());
  });

  it("draws nothing when no exercise is open to practice", async () => {
    render([]);
    expect(await screen.findByRole("heading", { name: "Coming up" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Past series" })).toBeNull();
  });
});
