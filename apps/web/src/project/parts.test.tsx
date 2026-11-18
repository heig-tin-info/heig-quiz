import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ProjectRepoView } from "@quiz/contracts";

import { renderWithProviders } from "../test/render";
import { Score } from "./parts";

/*
 * The final score of a repository as the table writes it (I42), and the
 * CI's score of a project graded by criteria (product owner, 2026-11-18):
 * the CI's rate as a ring, the points beside it, never a grade.
 */
type Final = NonNullable<ProjectRepoView["scores"]["final"]>;
// The server sends no grade for the CI's share of a project graded by criteria (`ciShareOnly`).
const final = (over: Partial<Final> = {}): Final => ({ points: 40, max: 48, source: "ci", toVerify: false, grade: null, ...over });

describe("Score", () => {
  it("draws the CI's score of a project graded by criteria as its rate, without a grade", () => {
    const { container } = renderWithProviders(<Score score={final()} gradingMode="criteria" />);
    expect(screen.getByRole("img", { name: "CI: 40 of 48 points, 83%" })).toBeInTheDocument();
    expect(screen.getByText("40/48")).toBeInTheDocument();
    expect(screen.getByText("CI")).toBeInTheDocument();
    expect(container.querySelector<SVGCircleElement>(".score-ramp-stroke")!.style.getPropertyValue("--rate")).toBe("83%");
  });

  it("keeps the grade of a whole score: validated criteria, a teacher's, or the CI's under auto", () => {
    for (const [score, mode] of [
      [final({ source: "criteria", points: 17, max: 20, grade: { grade: 5.3 } }), "criteria"],
      [final({ source: "teacher", points: 17, max: 20, grade: { grade: 5.3 } }), "criteria"],
      [final({ points: 17, max: 20, grade: { grade: 5.3 } }), "auto"],
    ] as const) {
      const { unmount } = renderWithProviders(<Score score={score} gradingMode={mode} />);
      expect(screen.getByText("17/20")).toBeInTheDocument();
      expect(screen.getByText("5.3")).toBeInTheDocument();
      expect(screen.queryByRole("img")).toBeNull();
      unmount();
    }
  });

  it("writes a dash without a score", () => {
    renderWithProviders(<Score score={null} gradingMode="criteria" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
