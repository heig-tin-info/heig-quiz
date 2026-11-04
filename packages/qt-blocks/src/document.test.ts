/**
 * The `blocks` question on paper (ADR-126 §8, §9): the hand-out's side —
 * the statement and the answer zone, built from `toStudent` — searched in
 * its three text forms (the tree as JSON, the Typst source, the Markdown)
 * for every value of the key: a hidden warehouse's rows, name and battery,
 * its map as a figure, and the reference program. The student's key keeps
 * the visible warehouses only; the staff's holds everything (the positive
 * control).
 */
import { describe, expect, it } from "vitest";

import type { GradedResult } from "@quiz/core/server";
import { testGradeContext } from "@quiz/core/testing";
import { EN_LABELS, FR_LABELS, LABELS, toSvg, type Block, type Drawing, type DrawingBlock, type Lang } from "@quiz/docexport";
import { markdownBody } from "@quiz/docexport/markdown";
import { renderTypst } from "@quiz/docexport/typst";

import { mapFigure } from "./mapFigure.js";
import { pseudoCode } from "./pseudo.js";
import type { BlocksDetails } from "./schema.js";
import { blocksServer } from "./server.js";
import { BLOCKS_PAPER_WORDS } from "./strings.js";
import { blocksLeakFixture, SECRET_CONFIG } from "./testing.js";

const view = { seed: 0, itemId: "item-1", shuffle: false };
const student = blocksServer.toStudent(SECRET_CONFIG, view);
const hidden = SECRET_CONFIG.cases.filter((c) => !c.visible);
const visible = SECRET_CONFIG.cases.filter((c) => c.visible);

const provenance = { kind: "handout", version: 1, source: {}, attempts: [], generatedAt: "2026-11-04T00:00:00Z", app: null };

/** A list of blocks in the three text forms of 05 §5.7, Typst escapes undone (a raw block's `\n` a newline). */
function forms(blocks: readonly Block[], lang: Lang): string[] {
  const doc = { provenance, lang, blocks };
  const typst = renderTypst(doc).source.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c));
  return [JSON.stringify(blocks), typst, markdownBody(doc)];
}

const drawings = (blocks: readonly Block[]) => blocks.filter((b): b is DrawingBlock => b.kind === "drawing");

/** The figure a warehouse would print as, in `lang`'s dock word. */
const figureOf = (rows: readonly string[], lang: Lang) => mapFigure(rows, { dockLabel: BLOCKS_PAPER_WORDS[lang].dock });

/** Every value of the key, as text, in `lang`. */
function keyValues(lang: Lang): string[] {
  const reference = pseudoCode(SECRET_CONFIG.referenceSolution!, BLOCKS_PAPER_WORDS[lang]);
  return [
    ...blocksLeakFixture.secrets,
    ...hidden.flatMap((c) => [c.name, `${BLOCKS_PAPER_WORDS[lang].battery}${LABELS[lang].colon}${c.battery}`]),
    reference,
    // The reference's distinctive line: no line of the starter reads like it.
    reference.split("\n")[0]!,
  ];
}

/** The reference graded: every warehouse reached, each trail recorded. */
function graded(): BlocksDetails {
  const result = blocksServer.grade(SECRET_CONFIG, { program: SECRET_CONFIG.referenceSolution! }, testGradeContext(7));
  if (result instanceof Promise || result.kind !== "graded") throw new Error("expected a synchronous grade");
  return (result as GradedResult<BlocksDetails>).details;
}

describe("the hand-out of a blocks question (ADR-126 §8, §9)", () => {
  for (const lang of ["en", "fr"] as const) {
    const labels = LABELS[lang];
    const handout = [...blocksServer.statementDoc!(student, labels), ...blocksServer.answerZone!(student)];

    it(`holds no value of the key in any form (${lang})`, () => {
      for (const form of forms(handout, lang)) {
        expect(keyValues(lang).filter((secret) => form.includes(secret))).toEqual([]);
      }
    });

    it(`draws the visible warehouses and never a hidden one (${lang})`, () => {
      const figures = drawings(handout).map((b) => JSON.stringify(b.drawing));
      expect(figures).toEqual(visible.map((c) => JSON.stringify(figureOf(c.map, lang))));
      for (const c of hidden) expect(figures).not.toContain(JSON.stringify(figureOf(c.map, lang)));
    });

    it(`counts the hidden warehouses, lists the toolbox and prints the starter in the reader's words (${lang})`, () => {
      const [, typst, markdown] = forms(handout, lang);
      const words = BLOCKS_PAPER_WORDS[lang];
      for (const form of [typst!, markdown!]) {
        expect(form).toContain(`${labels.blocksHiddenWarehouses}${labels.colon}2 · 5 pt`);
        expect(form).toContain(words.kindRepeatUntilDock);
        expect(form).toContain(pseudoCode(SECRET_CONFIG.starter, words));
        for (const c of visible) expect(form).toContain(c.name);
      }
    });
  }

  it("speaks French to a French reader, the dock's word in the figure too", () => {
    const [, typst] = forms(blocksServer.statementDoc!(student, FR_LABELS), "fr");
    expect(typst).toContain("répéter 7 fois\n  avancer");
    expect(typst).toContain(">QUAI</text>");
    expect(typst).not.toContain("DOCK");
  });

  it("answers in a ruled free frame, sized without the reference (ADR-126 §3, §6)", () => {
    expect(blocksServer.answerZone!(student)).toEqual([
      { kind: "answerZone", zone: "free", heightMm: 96, ruling: { kind: "lines", pitchMm: 8 } },
    ]);
  });
});

describe("the key of a blocks question", () => {
  const solution = blocksServer.toSolution(SECRET_CONFIG, view);

  it("gives a student the reference and the visible warehouses only", () => {
    const own = blocksServer.solutionDoc!(blocksServer.studentSolution!(solution, SECRET_CONFIG)!, student, EN_LABELS);
    expect(drawings(own)).toHaveLength(visible.length);
    for (const form of forms(own, "en")) {
      for (const c of hidden) expect(form).not.toContain(c.name);
      expect(form).not.toContain(`Battery: ${hidden[0]!.battery}`);
    }
    // A hidden map's own size and racks, whatever the trail drawn over it.
    const plan = (d: Drawing) => JSON.stringify([d.viewBox, d.items.filter((i) => i.kind === "g" && !i.transform)]);
    const plans = drawings(own).map((b) => plan(b.drawing));
    for (const c of hidden) expect(plans).not.toContain(plan(figureOf(c.map, "en")!));
    expect(plans).toEqual(visible.map((c) => plan(figureOf(c.map, "en")!)));
    expect(forms(own, "en")[2]).toContain(pseudoCode(SECRET_CONFIG.referenceSolution!, BLOCKS_PAPER_WORDS.en));
  });

  it("gives the staff every warehouse and the reference (the positive control)", () => {
    const staff = blocksServer.solutionDoc!(solution, student, EN_LABELS);
    expect(drawings(staff)).toHaveLength(SECRET_CONFIG.cases.length);
    const [, typst] = forms(staff, "en");
    for (const c of hidden) expect(typst).toContain(c.name);
    expect(typst).toContain("Battery: 23 · 2 pt · Hidden");
    expect(typst).toContain(pseudoCode(SECRET_CONFIG.referenceSolution!, BLOCKS_PAPER_WORDS.en));
    // Each warehouse carries the reference's walk, ringed where it ends.
    for (const block of drawings(staff)) expect(block.drawing.items.filter((i) => i.kind === "ellipse").length).toBeGreaterThan(1);
  });
});

describe("the student's own answer", () => {
  const program = SECRET_CONFIG.referenceSolution!;

  it("prints their program and each warehouse's verdict, a hidden one by its number unless the names are open", () => {
    const closed = blocksServer.studentDetails!(graded(), { showKey: false, showHiddenCaseNames: false });
    const body = forms(blocksServer.studentAnswerDoc!(student, { program }, closed, FR_LABELS), "fr")[2]!;
    expect(body).toContain(pseudoCode(program, BLOCKS_PAPER_WORDS.fr));
    expect(body).toContain("| Clear aisle | Quai atteint | 1 / 1 |");
    expect(body).toContain("| #3 | Quai atteint | 2 / 2 |");
    for (const c of hidden) expect(body).not.toContain(c.name);
    const open = blocksServer.studentDetails!(graded(), { showKey: false, showHiddenCaseNames: true });
    expect(forms(blocksServer.studentAnswerDoc!(student, { program }, open, EN_LABELS), "en")[2]).toContain("| Hidden north-east |");
  });

  it("says there is no answer, and prints no table without details", () => {
    expect(forms(blocksServer.studentAnswerDoc!(student, { program: [] }, null, EN_LABELS), "en")[2]).toBe("No answer.\n");
  });
});

describe("mapFigure", () => {
  it("writes every case's map as an SVG toSvg accepts, with nothing but drawing", () => {
    for (const c of SECRET_CONFIG.cases) {
      const svg = toSvg(figureOf(c.map, "en")!);
      expect(svg.ok).toBe(true);
      if (!svg.ok) continue;
      expect(svg.svg).toContain(">DOCK</text>");
      expect(svg.svg).not.toMatch(/class=|style=|href|url\(|<script|foreignObject|<image/);
    }
  });

  it("turns the robot to its heading, and refuses rows the domain refuses", () => {
    const robot = (rows: string[]) => figureOf(rows, "en")!.items.findLast((i) => i.kind === "g" && i.transform);
    expect(robot(["^..", "...", "..D"])).toMatchObject({ transform: [1, 0, -0, 1, 22, 22] });
    expect(robot([">..", "...", "..D"])).toMatchObject({ transform: [0, 1, -1, 0, 22, 22] });
    expect(figureOf(["..", ".."], "en")).toBeNull();
  });

  it("draws a trail between the start and the end, the end ringed", () => {
    const trail = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
    const figure = mapFigure([">.D", "...", "..."], { dockLabel: "DOCK", trail })!;
    const rings = figure.items.filter((i) => i.kind === "ellipse");
    expect(rings).toHaveLength(2);
    expect(rings[1]).toMatchObject({ cx: 110, cy: 22 });
  });
});
