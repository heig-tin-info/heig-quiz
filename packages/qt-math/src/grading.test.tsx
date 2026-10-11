import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { mathGrading } from "./grading.js";
import { mathServer } from "./server.js";
import { SECRET_CONFIG } from "./test/fixtures.js";

const view = { seed: 1, itemId: "i", shuffle: false };
const student = mathServer.toStudent(SECRET_CONFIG, view);
const solution = mathServer.toSolution(SECRET_CONFIG, view);

describe("the grading column (ADR-044)", () => {
  const [column] = mathGrading.columns(student, solution, { answer: "Réponse", empty: "vide" });

  it("is one column, worded by the host", () => {
    expect(mathGrading.columns(student, solution)).toHaveLength(1);
    expect(column?.label).toBe("Réponse");
  });

  it("shows the typed LaTeX tinted by the verdict, and 'empty' for none", () => {
    render(
      <>
        {column!.cell({ answer: { latex: "R_1+R_2" }, details: { status: "graded", matchedIndex: 1, fraction: 0.25, latex: "R_1+R_2" } })}
        {column!.cell({ answer: { latex: "" }, details: null })}
        {column!.cell({ answer: { latex: "x" }, details: { status: "invalid", problem: { code: "syntax" }, matchedIndex: null, fraction: 0, latex: null } })}
      </>,
    );
    expect(screen.getByText("R_1+R_2")).toBeInTheDocument();
    expect(screen.getByText("vide")).toBeInTheDocument();
    expect(screen.getByText("x")).toBeInTheDocument();
  });

  it("pins the accepted answers on the expected row", () => {
    render(<>{column!.expected()}</>);
    expect(screen.getByText("\\frac{R_1 R_2}{R_1+R_2}")).toBeInTheDocument();
    expect(screen.getByText("R_1+R_2")).toBeInTheDocument();
  });

  it("sorts by the normal form of the text", () => {
    expect(column!.sortKey({ latex: " R_1 +  R_2 " })).toBe("r_1 + r_2");
    expect(column!.sortKey(null)).toBe("");
  });
});
