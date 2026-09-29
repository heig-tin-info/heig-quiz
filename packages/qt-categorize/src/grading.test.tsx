/**
 * The `categorize` columns of the grading table (ADR-040): one per card, the
 * column the student put it in tinted by the card's own verdict — and ONE
 * summary column once the question has more cards than a table can hold.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CATEGORIZE_GRADING_MAX_COLUMNS, categorizeGrading } from "./grading.js";
import type { CategorizeAnswer, CategorizeConfig, CategorizeDetails } from "./schema.js";
import { categorizeServer } from "./server.js";
import { C, config, gradeContext, K, RIGHT } from "./test/fixtures.js";

const view = { seed: 3, itemId: "i", shuffle: false };

function setup(cfg: CategorizeConfig) {
  const student = categorizeServer.toStudent(cfg, view);
  const solution = categorizeServer.toSolution(cfg, view);
  return { cfg, columns: categorizeGrading.columns(student, solution) };
}

function detailsOf(cfg: CategorizeConfig, answer: CategorizeAnswer): CategorizeDetails {
  const result = categorizeServer.grade(cfg, answer, gradeContext(1));
  if (result instanceof Promise || result.kind !== "graded") throw new Error("expected a grade");
  return result.details;
}

/** int and float right, double in Integer (wrong); the rest in the tray. */
const PARTIAL: CategorizeAnswer = {
  columns: { [C.int]: [K.int, K.double], [C.float]: [K.float], [C.ptr]: [] },
};

const html = (node: unknown) => render(<>{node}</>).container;
/** The chip itself, inside the wrapper that keeps the column's share. */
const chip = (el: HTMLElement) => el.querySelector("span span") ?? el.querySelector("span")!;

describe("categorize grading columns", () => {
  const { cfg, columns } = setup(config());

  it("has one column per card, headed by the card as plain text", () => {
    expect(cfg.cards).toHaveLength(CATEGORIZE_GRADING_MAX_COLUMNS);
    expect(columns).toHaveLength(8);
    expect(columns[0]!.key).toBe(`card-${K.int}`);
    expect(columns[0]!.label).toBe("int");
    expect(columns[4]!.title).toBe("void *");
  });

  it("asks the table for no width of its own, so eight columns keep equal shares", () => {
    const cell = html(columns[3]!.cell({ answer: PARTIAL, details: null }));
    expect(cell.firstElementChild!.className).toContain("w-0 min-w-full");
  });

  it("names the column the student chose, tinted by the card's verdict from the details", () => {
    const details = detailsOf(cfg, PARTIAL);
    const int = html(columns[0]!.cell({ answer: PARTIAL, details }));
    expect(int.textContent).toBe("Integer");
    expect(chip(int)!.className).toContain("bg-success-soft");
    const double = html(columns[2]!.cell({ answer: PARTIAL, details }));
    expect(double.textContent).toBe("Integer");
    expect(chip(double)!.className).toContain("bg-danger-soft");
  });

  it("draws a card left in the tray as an em dash, and an ungraded one neutral", () => {
    expect(html(columns[1]!.cell({ answer: PARTIAL, details: null })).textContent).toBe("—");
    const neutral = html(columns[0]!.cell({ answer: PARTIAL, details: null }));
    expect(chip(neutral)!.className).toContain("bg-surface-3");
  });

  it("draws the student's places neutral on a teacher's override", () => {
    const manual = { manual: true } as unknown as CategorizeDetails;
    expect(chip(html(columns[0]!.cell({ answer: PARTIAL, details: manual })))!.className).toContain("bg-surface-3");
    const many = setup(config({ cards: [...config().cards, { id: "n1n1", text: "`long`" }] })).columns;
    expect(html(many[0]!.cell({ answer: PARTIAL, details: manual })).textContent).toBe("3/9 placed");
  });

  it("puts the key's column on the expected row, and 'Left out' for a distractor", () => {
    expect(html(columns[3]!.expected()).textContent).toBe("Floating point");
    expect(html(columns[6]!.expected()).textContent).toBe("Left out");
    expect(chip(html(columns[6]!.expected()))!.className).toContain("text-info");
  });

  it("adds the rank on an ordered question", () => {
    const ordered = setup(config({ ordered: true })).columns;
    expect(html(ordered[2]!.cell({ answer: PARTIAL, details: null })).textContent).toBe("Integer · 2");
    expect(html(ordered[1]!.expected()).textContent).toBe("Integer · 2");
  });

  it("sorts by the column's name, normalised", () => {
    expect(columns[0]!.sortKey(PARTIAL)).toBe("integer");
    expect(columns[1]!.sortKey(PARTIAL)).toBe("");
    expect(columns[0]!.sortKey(null)).toBe("");
  });
});

describe("categorize grading, past eight cards", () => {
  const many = config({
    cards: [...config().cards, { id: "n1n1", text: "`long`" }],
  });
  const { columns } = setup(many);

  it("gives one summary column instead of a column per card", () => {
    expect(columns).toHaveLength(1);
    expect(columns[0]!.label).toBe("Cards");
    expect(html(columns[0]!.expected()).textContent).toBe("9 cards");
  });

  it("counts the cards right from the details, or the cards placed before grading", () => {
    const right = html(columns[0]!.cell({ answer: RIGHT, details: detailsOf(many, RIGHT) }));
    expect(right.textContent).toBe("9/9 right");
    expect(right.querySelector("span")!.className).toContain("bg-success-soft");
    const partial = html(columns[0]!.cell({ answer: PARTIAL, details: detailsOf(many, PARTIAL) }));
    expect(partial.querySelector("span")!.className).toContain("outline-dashed");
    expect(html(columns[0]!.cell({ answer: PARTIAL, details: null })).textContent).toBe("3/9 placed");
  });

  it("sorts identical boards together", () => {
    expect(columns[0]!.sortKey(RIGHT)).toBe(columns[0]!.sortKey({ columns: { ...RIGHT.columns } }));
    expect(columns[0]!.sortKey(RIGHT)).not.toBe(columns[0]!.sortKey(PARTIAL));
  });
});
