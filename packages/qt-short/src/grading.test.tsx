/** The `short` column of the grading table (ADR-044). */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { shortGrading } from "./grading.js";
import type { ShortDetails } from "./schema.js";
import { shortServer } from "./server.js";
import { config } from "./test/fixtures.js";

const view = { seed: 3, itemId: "i", shuffle: false };
const question = config({
  matchers: [
    { kind: "exact", value: "malloc", points: 1 },
    { kind: "exact", value: "calloc", points: 1 },
  ],
});
const student = shortServer.toStudent(question, view);
const solution = shortServer.toSolution(question, view);
const [column] = shortGrading.columns(student, solution);

const details = (fraction: number): ShortDetails => ({
  matchedIndex: fraction > 0 ? 0 : null,
  matchedKind: null,
  normalized: "",
  fraction,
});

describe("short grading column", () => {
  it("is one column, named Answer", () => {
    expect(shortGrading.columns(student, solution)).toHaveLength(1);
    expect(column!.label).toBe("Answer");
  });

  it("tints the typed answer by its verdict, neutral before any grading", () => {
    render(
      <>
        {column!.cell({ answer: { text: "malloc" }, details: details(1) })}
        {column!.cell({ answer: { text: "new" }, details: details(0) })}
        {column!.cell({ answer: { text: "alloc" }, details: null })}
      </>,
    );
    expect(screen.getByText("malloc").className).toContain("bg-success-soft");
    expect(screen.getByText("new").className).toContain("bg-danger-soft");
    expect(screen.getByText("alloc").className).toContain("bg-surface-3");
  });

  it("says an empty text is empty", () => {
    render(<>{column!.cell({ answer: { text: "  " }, details: details(0) })}</>);
    expect(screen.getByText("empty").className).toContain("italic");
  });

  it("lists the accepted answers on the expected row", () => {
    render(<>{column!.expected()}</>);
    expect(screen.getByText("malloc").className).toContain("text-info");
    expect(screen.getByText("calloc")).toBeInTheDocument();
  });

  it("sorts by the normal form of the text", () => {
    expect(column!.sortKey({ text: " Malloc " })).toBe("malloc");
    expect(column!.sortKey({ text: "malloc" })).toBe(
      column!.sortKey({ text: "MALLOC" }),
    );
    expect(column!.sortKey(null)).toBe("");
  });
});
