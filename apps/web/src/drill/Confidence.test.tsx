import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DrillCalibrationLevel, DrillQuestionConfidence } from "@quiz/contracts";

import { mockFetch, ok, renderWithProviders } from "../test/render";
import { ConfidencePerQuestion, DrillCalibration } from "./Confidence";

/*
 * What stated confidences add up to (ADR-085 §8): the student's calibration
 * in plain words, a level below the threshold saying so; the teacher's 2×2
 * per question, with the confident errors among the wrong answers, and the
 * empty state while no question has enough students.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const level = (confidence: number, answers: number, right: number): DrillCalibrationLevel => ({
  confidence,
  answers,
  right,
});

describe("the student's calibration", () => {
  it("says, per level, how often the student was right, and when there are too few answers", async () => {
    mockFetch({
      "GET /app/api/drill/calibration": ok([level(0, 3, 1), level(1, 0, 0), level(2, 10, 6), level(3, 8, 5), level(4, 1, 1)]),
    });
    renderWithProviders(<DrillCalibration />);
    expect(await screen.findByRole("heading", { name: "How sure, how right" })).toBeVisible();
    expect(screen.getByText("When you said “Sure”, you were right 63% of the time")).toBeVisible();
    expect(screen.getByText("When you said “No idea”: not enough answers yet")).toBeVisible();
    expect(screen.getByText("When you said “Certain”: not enough answers yet")).toBeVisible();
    expect(screen.getByText("1 answer")).toBeVisible();
    expect(screen.getByText("8 answers")).toBeVisible();
  });

  it("is not drawn before the student has stated a confidence once", async () => {
    const { calls } = mockFetch({
      "GET /app/api/drill/calibration": ok([0, 1, 2, 3, 4].map((c) => level(c, 0, 0))),
    });
    const { container } = renderWithProviders(<DrillCalibration />);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    await vi.waitFor(() => expect(container.querySelector("section")).toBeNull());
    expect(screen.queryByRole("heading", { name: "How sure, how right" })).toBeNull();
  });
});

describe("the teacher's confidence per question", () => {
  const url = "GET /app/api/classrooms/r1/drill/confidence";
  const ROW: DrillQuestionConfidence = {
    questionId: "00000000-0000-4000-8000-000000000001",
    name: "Pointeur nul",
    students: 12,
    split: { rightSure: 6, rightUnsure: 2, wrongSure: 3, wrongUnsure: 1 },
  };

  it("draws the 2×2 with its counts, and the confident errors among the wrong answers", async () => {
    mockFetch({ [url]: ok([ROW]) });
    renderWithProviders(<ConfidencePerQuestion classroomId="r1" />);
    const table = await screen.findByRole("table", { name: "Stated answers: right or wrong, sure or unsure" });
    const wrong = within(table).getByRole("rowheader", { name: "Wrong" }).closest("tr")!;
    expect(within(wrong).getByText("3")).toBeVisible();
    expect(within(wrong).getByText("25%")).toBeVisible();
    expect(screen.getByText("Confident errors: 75% of the wrong answers (3 of 4)")).toBeVisible();
    expect(screen.getByText("12 stated answers · 12 students")).toBeVisible();
  });

  it("says why nothing is shown while no question has enough students", async () => {
    mockFetch({ [url]: ok([]) });
    renderWithProviders(<ConfidencePerQuestion classroomId="r1" />);
    expect(await screen.findByText("Not enough statements yet")).toBeVisible();
    expect(screen.getByText(/once 10 students have said how sure they were/)).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
