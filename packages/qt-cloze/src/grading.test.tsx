/** The `cloze` columns of the grading table (ADR-044): one per blank. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { clozeGrading } from "./grading.js";
import type { ClozeDetails } from "./schema.js";
import { clozeServer } from "./server.js";
import { config } from "./test/fixtures.js";

const view = { seed: 3, itemId: "i", shuffle: false };
const question = config("for (int i = {{0}}; i {{<|!=}} 10; i{{=++|--}}) {}");
const student = clozeServer.toStudent(question, view);
const solution = clozeServer.toSolution(question, view);
const columns = clozeGrading.columns(student, solution);

/** The breakdown of a grading, blank by blank. */
function details(ok: boolean[]): ClozeDetails {
  return {
    perBlank: ok.map((v, index) => ({
      index,
      weight: 1,
      kind: "text",
      ok: v,
      given: null,
      expected: "",
    })),
    earned: ok.filter(Boolean).length,
    total: ok.length,
    fraction: ok.filter(Boolean).length / ok.length,
  };
}

describe("cloze grading columns", () => {
  it("has one column per blank, numbered from 1 in the order of the text", () => {
    expect(columns.map((c) => c.key)).toEqual(["blank-0", "blank-1", "blank-2"]);
    expect(columns.map((c) => c.label)).toEqual(["Blank 1", "Blank 2", "Blank 3"]);
  });

  it("tints each blank by its own verdict", () => {
    const answer = { blanks: ["0", "<=", "0"] };
    const graded = details([true, false, true]);
    render(
      <>
        {columns.map((c) => (
          <span key={c.key}>{c.cell({ answer, details: graded })}</span>
        ))}
      </>,
    );
    expect(screen.getByText("<=").className).toContain("bg-danger-soft");
    // Blank 1 and a dropdown answered by its canonical index, read as its label.
    expect(screen.getByText("0").className).toContain("bg-success-soft");
    expect(screen.getByText("++").className).toContain("bg-success-soft");
  });

  it("reads a blank left empty as empty, and neutral before any grading", () => {
    render(
      <>
        {columns[0]!.cell({
          answer: { blanks: [null, "<", null] },
          details: null,
        })}
        {columns[1]!.cell({
          answer: { blanks: [null, "<", null] },
          details: null,
        })}
      </>,
    );
    expect(screen.getByText("empty")).toBeInTheDocument();
    expect(screen.getByText("<").className).toContain("bg-surface-3");
  });

  it("lists each blank's accepted answers on the expected row", () => {
    render(<>{columns[1]!.expected()}</>);
    expect(screen.getByText("<").className).toContain("text-info");
    expect(screen.getByText("!=")).toBeInTheDocument();
  });

  it("sorts a blank by the normal form of what was put in it", () => {
    const key = columns[1]!.sortKey;
    expect(key({ blanks: [null, " != ", null] })).toBe("!=");
    expect(key({ blanks: ["x", "<", null] })).toBe(key({ blanks: [null, "<", "y"] }));
    expect(key(null)).toBe("");
    // A dropdown sorts by its label, not by its stored index.
    expect(columns[2]!.sortKey({ blanks: [null, null, "0"] })).toBe("++");
  });

  it("takes the host's words over its English defaults", () => {
    expect(clozeGrading.columns(student, solution, { blank: "Trou {n}" })[0]!.label).toBe("Trou 1");
  });
});
