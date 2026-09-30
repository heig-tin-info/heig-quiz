import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { diagramGrading } from "./grading.js";
import { REFERENCE, STARTER } from "./test/fixtures.js";

const student = { prompt: "Draw.", kind: "class" as const };

describe("the diagram column of the grading table", () => {
  const [column] = diagramGrading.columns(student, { reference: REFERENCE }, {});

  it("is one column of counts, no thumbnail", () => {
    expect(diagramGrading.columns(student, null)).toHaveLength(1);
    render(<>{column!.cell({ answer: { scene: STARTER }, details: null })}</>);
    expect(screen.getByText("1 element · 0 links")).toBeInTheDocument();
    expect(document.querySelector("svg")).toBeNull();
  });

  it("gives the reference's counts as the expected row, a dash for no answer", () => {
    render(
      <>
        {column!.expected()}
        {column!.cell({ answer: null, details: null })}
      </>,
    );
    expect(screen.getByText("2 elements · 1 link")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("sorts by size", () => {
    const small = column!.sortKey({ scene: STARTER });
    const large = column!.sortKey({ scene: REFERENCE });
    expect(small < large).toBe(true);
    expect(column!.sortKey(null)).toBe("");
  });
});
