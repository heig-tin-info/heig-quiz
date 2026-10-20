import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DrillClassroom, StudentConceptMastery } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { ConceptMastery } from "./ConceptMastery";

/*
 * The student's level on their course's concepts (ADR-098): a band in words,
 * "No data yet" apart from the scale, the cards behind it, the fading
 * sentence; no number, no comparison, no button but "Revise a concept"
 * while targeted revision is open (ADR-115); nothing for a course
 * without concepts.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROOM: DrillClassroom = {
  classroomId: "r1",
  classroomName: "Classe A",
  courseCode: "PRG1",
  courseName: "Programmation C",
  optedOutAt: null,
};
const URL = "GET /app/api/student/classrooms/r1/drill/mastery";
const row = (label: string, level: StudentConceptMastery["concepts"][number]["level"], cards: number, qualifier = "") => ({
  concept: { id: `id-${label}`, label, qualifier },
  level,
  cards,
});

describe("the student's concepts", () => {
  it("names each concept with its band and the cards behind it, in the given order", async () => {
    mockFetch({
      [URL]: ok({
        declared: true,
        concepts: [
          row("Pointeurs", "work", 11),
          row("Boucles", "getting", 1),
          row("Tableaux", "solid", 22),
          row("Types", null, 4),
          row("Récursivité", null, 0),
          row("Adresse", "solid", 6, "mémoire"),
        ],
      } satisfies StudentConceptMastery),
    });
    renderWithProviders(<ConceptMastery room={ROOM} navigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Concepts" })).toBeVisible();
    const items = screen.getAllByText(/^(Pointeurs|Boucles|Tableaux|Types|Récursivité|Adresse)/).map((e) => e.textContent);
    expect(items).toEqual(["Pointeurs", "Boucles", "Tableaux", "Types", "Récursivité", "Adresse (mémoire)"]);

    const line = (name: string) => screen.getByText(name).closest("div")!.parentElement!;
    expect(within(line("Pointeurs")).getByText("To work on")).toBeVisible();
    expect(within(line("Pointeurs")).getByText("11 cards")).toBeVisible();
    expect(within(line("Boucles")).getByText("Getting there")).toBeVisible();
    expect(within(line("Boucles")).getByText("1 card")).toBeVisible();
    expect(within(line("Tableaux")).getByText("Solid")).toBeVisible();
    expect(within(line("Types")).getByText("No data yet")).toBeVisible();
    expect(within(line("Types")).getByText("4 cards")).toBeVisible();
    expect(within(line("Récursivité")).getByText("No card reviewed yet")).toBeVisible();
  });

  it("says the levels are as of today and fade, and offers neither a number nor a button", async () => {
    mockFetch({ [URL]: ok({ declared: true, concepts: [row("Pointeurs", "solid", 8)] }) });
    const { container } = renderWithProviders(<ConceptMastery room={ROOM} navigate={vi.fn()} />);
    expect(await screen.findByText(/Levels as of today: they fade when a concept is not reviewed/)).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).not.toMatch(/%|\d\.\d/);
  });

  it("offers \"Revise a concept\" only while targeted revision is open there (ADR-115 §13)", async () => {
    const user = userEvent.setup();
    const REVISION = "GET /app/api/student/classrooms/r1/revision/concepts";
    const mastery = ok({ declared: true, concepts: [row("Pointeurs", "solid", 8)] });
    const closed = mockFetch({ [URL]: mastery, [REVISION]: ok({ available: false, concepts: [] }) });
    const first = renderWithProviders(<ConceptMastery room={ROOM} navigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Concepts" })).toBeVisible();
    await vi.waitFor(() => expect(closed.calls.some((c) => c.url.endsWith("/revision/concepts"))).toBe(true));
    expect(screen.queryByRole("button", { name: "Revise a concept" })).toBeNull();
    first.unmount();

    mockFetch({ [URL]: mastery, [REVISION]: ok({ available: true, concepts: [row("Pointeurs", "solid", 8).concept] }) });
    const navigate = vi.fn();
    renderWithProviders(<ConceptMastery room={ROOM} navigate={navigate} />);
    await user.click(await screen.findByRole("button", { name: "Revise a concept" }));
    expect(navigate).toHaveBeenCalledWith({ view: "revise", classroomId: "r1" });
  });

  it("draws nothing for a course that declares no concept, and nothing when the read fails", async () => {
    const quiet = mockFetch({ [URL]: ok({ declared: false, concepts: [] }) });
    const first = renderWithProviders(<ConceptMastery room={ROOM} navigate={vi.fn()} />);
    await vi.waitFor(() => expect(quiet.calls.filter((c) => c.url.endsWith("/drill/mastery")).length).toBe(1));
    expect(first.container.querySelector("section")).toBeNull();
    first.unmount();

    const broken = mockFetch({ [URL]: fail(500) });
    const second = renderWithProviders(<ConceptMastery room={ROOM} navigate={vi.fn()} />);
    await vi.waitFor(() => expect(broken.calls.length).toBeGreaterThan(0));
    expect(second.container.querySelector("section")).toBeNull();
  });
});
