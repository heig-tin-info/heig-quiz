import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Journal, JournalPage, StudentClassroomPage } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { StudentClassroom } from "./StudentClassroom";

/*
 * The Journal tab of the student classroom page (F-ORG-15, F-JRN-07), in
 * every build since M4-05: no `CLASSROOM_PAGES` here.
 */

const page = (hasJournal: boolean): StudentClassroomPage => ({
  classroom: {
    id: "r1",
    name: "PRG1-2026",
    period: "2026-A",
    courseName: "Programmation C",
    courseCode: "PRG1",
    teachers: [],
    timeBonusPercent: 0,
    archived: false,
  },
  activities: { polls: [], groupSets: [], open: [], upcoming: [], past: [] },
  hasJournal,
  hasGroups: false,
  serverNow: new Date().toISOString(),
});

const journal: Journal = { view: "student", nav: [], homePath: "README.md" };
const home: JournalPage = {
  view: "student",
  path: "README.md",
  title: "Programmation 1",
  html: "<h1>Programmation 1</h1><p>Bienvenue.</p>",
  toc: [],
  updatedAt: new Date().toISOString(),
};

describe("the student classroom page's Journal tab", () => {
  it("is there only when the classroom has a journal", async () => {
    mockFetch({ "GET /app/api/student/classrooms/r1": ok(page(false)) });
    renderWithProviders(<StudentClassroom id="r1" tab="activities" navigate={vi.fn()} />);
    await screen.findByRole("heading", { level: 1, name: "PRG1-2026" });
    expect(screen.queryByRole("tab", { name: "Journal" })).toBeNull();
  });

  it("opens the journal's route from the Activities", async () => {
    mockFetch({ "GET /app/api/student/classrooms/r1": ok(page(true)) });
    const navigate = vi.fn();
    renderWithProviders(<StudentClassroom id="r1" tab="activities" navigate={navigate} />);
    expect(await screen.findByRole("tab", { name: "Activities" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Journal" }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroomJournal", id: "r1" });
  });

  it("reads the student journal under the compact header, whose document owns the title", async () => {
    const { calls } = mockFetch({
      "GET /app/api/student/classrooms/r1": ok(page(true)),
      "GET /app/api/classrooms/r1/journal?view=student": ok(journal),
      "GET /app/api/classrooms/r1/journal/pages/README.md?view=student": ok(home),
    });
    const navigate = vi.fn();
    renderWithProviders(<StudentClassroom id="r1" tab="journal" path="README.md" navigate={navigate} />);
    expect(await screen.findByText("Bienvenue.")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Journal" })).toHaveAttribute("aria-selected", "true");
    // One h1, the document's: the classroom's name is a crumb here.
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Programmation 1"]);
    expect(screen.getByText("PRG1-2026")).toBeVisible();
    expect(calls.every((c) => !c.url.includes("/journal") || c.url.endsWith("view=student"))).toBe(true);

    await userEvent.click(screen.getByRole("tab", { name: "Activities" }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r1" });
  });

  it("sends the Journal's address back to the classroom when it has no journal", async () => {
    mockFetch({
      "GET /app/api/student/classrooms/r1": ok(page(false)),
      "GET /app/api/classrooms/r1/journal?view=student": fail(404, {}),
    });
    const navigate = vi.fn();
    renderWithProviders(<StudentClassroom id="r1" tab="journal" navigate={navigate} />);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r1" }, { replace: true }));
  });

  it("keeps the breadcrumb and the tabs when the journal fails to load", async () => {
    mockFetch({
      "GET /app/api/student/classrooms/r1": ok(page(true)),
      "GET /app/api/classrooms/r1/journal?view=student": fail(500, { message: "Boom" }),
    });
    const navigate = vi.fn();
    renderWithProviders(<StudentClassroom id="r1" tab="journal" navigate={navigate} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Could not load the journal" })).toBeVisible();
    expect(screen.getByText("Boom")).toBeVisible();
    expect(await screen.findByText("PRG1-2026")).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: "Activities" }));
    expect(navigate).toHaveBeenCalledWith({ view: "classroom", id: "r1" });
  });
});
