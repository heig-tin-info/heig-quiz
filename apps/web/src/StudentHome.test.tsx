import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StudentHome } from "./StudentHome";
import { makeStudentClassroom } from "./test/fixtures";
import { mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * The student surface. It shows what belongs to the reader and nothing else:
 * no course listing, no roster, no other student's name.
 */

const ROOMS = "/app/api/student/classrooms";

describe("StudentHome", () => {
  it("lists the classrooms, their course and their teachers", async () => {
    mockFetch({
      [`GET ${ROOMS}`]: ok([makeStudentClassroom({ teachers: ["Marie Dupont", "Pierre Roulet"] })]),
    });
    renderWithProviders(<StudentHome />);
    expect(await screen.findByText("PRG1-2026")).toBeVisible();
    expect(screen.getByText(/PRG1 — Programmation C/)).toBeVisible();
    expect(screen.getByText("Taught by Marie Dupont, Pierre Roulet")).toBeVisible();
  });

  it("shows the accommodation when there is one, and nothing when there is not", async () => {
    mockFetch({ [`GET ${ROOMS}`]: ok([makeStudentClassroom({ timeBonusPercent: 25 })]) });
    const { unmount } = renderWithProviders(<StudentHome />);
    expect(await screen.findByText("Extra time: +25%")).toBeVisible();
    unmount();

    mockFetch({ [`GET ${ROOMS}`]: ok([makeStudentClassroom()]) });
    renderWithProviders(<StudentHome />);
    await screen.findByText("PRG1-2026");
    expect(screen.queryByText(/Extra time/)).toBeNull();
  });

  it("explains how to get into a classroom when there is none", async () => {
    mockFetch({ [`GET ${ROOMS}`]: ok([]) });
    renderWithProviders(<StudentHome />);
    expect(await screen.findByText("No classroom yet")).toBeVisible();
  });
});
