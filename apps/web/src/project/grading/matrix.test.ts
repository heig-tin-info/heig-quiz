import { describe, expect, it } from "vitest";

import type { CriteriaTableRow, ProjectGradingRepo } from "@quiz/contracts";

import {
  cellHeat,
  cellValue,
  criteriaStats,
  criteriaTree,
  headerRows,
  markStats,
  rowsById,
  visibleColumns,
  type MatrixColumn,
} from "./matrix";

const row = (criterionId: string, section: string, max: number, points: number | null, over: Partial<CriteriaTableRow> = {}): CriteriaTableRow => ({
  criterionId,
  section,
  description: `about ${criterionId}`,
  max,
  points,
  state: points === null ? "empty" : "validated",
  locked: false,
  ...over,
});

/** `rendu` has one leaf; `code` a leaf of its own beside two sub-sections; a penalty in `rapport`, a bonus. */
const table = (points: Partial<Record<string, number | null>> = {}, state?: CriteriaTableRow["state"]): CriteriaTableRow[] => {
  const p = (id: string, fallback: number) => (id in points ? points[id]! : fallback);
  const s = (id: string, fallback: number) => ({ ...(state ? { state } : {}), ...(p(id, fallback) === null ? { state: "empty" as const } : {}) });
  return [
    row("rendu.tests", "rendu", 8, p("rendu.tests", 8), s("rendu.tests", 8)),
    row("code.structure.modules", "code.structure", 2, p("code.structure.modules", 2), s("code.structure.modules", 2)),
    row("code.structure.entetes", "code.structure", 1, p("code.structure.entetes", 1), s("code.structure.entetes", 1)),
    row("code.style.nommage", "code.style", 1, p("code.style.nommage", 1), s("code.style.nommage", 1)),
    row("code.memoire", "code", 2, p("code.memoire", 2), s("code.memoire", 2)),
    row("rapport.reponses", "rapport", 4, p("rapport.reponses", 4), s("rapport.reponses", 4)),
    row("rapport.cle", "rapport", -3, p("rapport.cle", 0), s("rapport.cle", 0)),
    row("bonus.plus", "bonus", 0, p("bonus.plus", 0), { bonus: 1, ...s("bonus.plus", 0) }),
  ];
};

const repo = (id: string, rows: CriteriaTableRow[], total: { points: number; max: number } | null): ProjectGradingRepo => ({
  id,
  label: id,
  group: false,
  frozen: true,
  validation: { validated: total !== null, missing: [], proposed: [] },
  table: rows,
  evidence: null,
  total,
});

const names = (columns: readonly MatrixColumn[]) => columns.map((c) => (c.kind === "leaf" ? c.id : `[${c.key}]`));

describe("criteriaTree", () => {
  it("groups by the rows' sections, sums the positive maxima, and keeps penalties and bonuses apart", () => {
    const tree = criteriaTree(table());
    expect(tree.nodes.map((n) => (n.kind === "leaf" ? n.id : n.key))).toEqual(["rendu.tests", "code", "rapport.reponses"]);
    const code = tree.nodes[1]!;
    expect(code).toMatchObject({ kind: "group", label: "code", max: 6, leafIds: ["code.structure.modules", "code.structure.entetes", "code.style.nommage", "code.memoire"] });
    // `code.style` holds one leaf: that leaf, no section to fold.
    expect(code.kind === "group" && code.children.map((c) => (c.kind === "leaf" ? c.id : c.key))).toEqual([
      "code.structure",
      "code.style.nommage",
      "code.memoire",
    ]);
    expect(tree.extras.map((e) => [e.id, e.role, e.max])).toEqual([
      ["rapport.cle", "penalty", -3],
      ["bonus.plus", "bonus", 1],
    ]);
  });

  it("labels a leaf by what follows its section, prefixed by a lone section it stands for", () => {
    const tree = criteriaTree([row("a.b.c", "a.b", 1, 1), row("a.x", "a", 1, 1), row("root", "", 2, 1)]);
    const a = tree.nodes[0]!;
    expect(a.kind === "group" && a.children.map((c) => c.label)).toEqual(["b.c", "x"]);
    expect(tree.nodes[1]).toMatchObject({ kind: "leaf", id: "root", label: "root" });
  });
});

describe("visibleColumns and headerRows", () => {
  const tree = criteriaTree(table());

  it("folds every section by default; extras last", () => {
    expect(names(visibleColumns(tree, new Set()))).toEqual(["rendu.tests", "[code]", "rapport.reponses", "rapport.cle", "bonus.plus"]);
    expect(headerRows(visibleColumns(tree, new Set()))).toHaveLength(1);
  });

  it("unfolds recursively, an open section spanning its columns on a row of its own", () => {
    const open = visibleColumns(tree, new Set(["code", "code.structure"]));
    expect(names(open)).toEqual([
      "rendu.tests",
      "code.structure.modules",
      "code.structure.entetes",
      "code.style.nommage",
      "code.memoire",
      "rapport.reponses",
      "rapport.cle",
      "bonus.plus",
    ]);
    const rows = headerRows(open);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.map((c) => (c.kind === "open" ? `open:${c.group.key}:${c.colSpan}` : `col:${c.column.label}:${c.rowSpan}`))).toEqual([
      "col:rendu.tests:3",
      "open:code:4",
      "col:rapport.reponses:3",
      "col:rapport.cle:3",
      "col:bonus.plus:3",
    ]);
    expect(rows[1]!.map((c) => (c.kind === "open" ? `open:${c.group.key}:${c.colSpan}` : `col:${c.column.label}:${c.rowSpan}`))).toEqual([
      "open:code.structure:2",
      "col:style.nommage:2",
      "col:memoire:2",
    ]);
    expect(rows[2]!.map((c) => c.kind === "column" && c.column.label)).toEqual(["modules", "entetes"]);
  });
});

describe("cellValue and cellHeat", () => {
  const columns = visibleColumns(criteriaTree(table()), new Set());
  const at = (id: string) => columns.find((c) => (c.kind === "leaf" ? c.id : c.key) === id)!;

  it("sums a folded section over the points given; empty when none was", () => {
    const rows = rowsById({ table: table({ "code.memoire": null, "code.structure.modules": 1 }, "proposed") });
    expect(cellValue(at("code"), rows)).toEqual({ points: 3, max: 6, state: "proposed", role: "normal" });
    const none = rowsById({ table: table({ "code.memoire": null, "code.structure.modules": null, "code.structure.entetes": null, "code.style.nommage": null }) });
    expect(cellValue(at("code"), none)).toMatchObject({ points: null, state: "empty" });
    expect(cellValue(at("code"), rowsById({ table: table() }))).toMatchObject({ points: 6, state: "validated" });
  });

  it("reads the share as a grade band; a penalty applied fails, a bonus has no heat", () => {
    expect(cellHeat({ points: 8, max: 8, state: "validated", role: "normal" })).toBe("pass");
    expect(cellHeat({ points: 4, max: 8, state: "validated", role: "normal" })).toBe("fail");
    expect(cellHeat({ points: 5, max: 8, state: "validated", role: "normal" })).toBe("borderline");
    expect(cellHeat({ points: null, max: 8, state: "empty", role: "normal" })).toBeNull();
    expect(cellHeat({ points: -3, max: -3, state: "validated", role: "penalty" })).toBe("fail");
    expect(cellHeat({ points: 0, max: -3, state: "validated", role: "penalty" })).toBeNull();
    expect(cellHeat({ points: 1, max: 1, state: "validated", role: "bonus" })).toBeNull();
  });
});

describe("statistics over the validated repositories", () => {
  const repos = [
    repo("a", table(), { points: 20, max: 20 }),
    repo("b", table({ "rendu.tests": 4, "rapport.cle": -3, "bonus.plus": 1 }), { points: 14, max: 20 }),
    // Not validated: counted nowhere.
    repo("c", table({ "rendu.tests": 0, "code.memoire": 0 }, "proposed"), null),
  ];

  it("describes the marks by the project's scale", () => {
    const stats = markStats(repos, { kind: "linear", rounding: "nearest" });
    expect(stats.description).toMatchObject({ count: 2, mean: 5.25, median: 5.25 });
    expect(stats.histogram.find((b) => b.bucket === 6)!.count).toBe(1);
    expect(stats.histogram.find((b) => b.bucket === 4.5)!.count).toBe(1);
    expect(stats.passing).toBe(2);
  });

  it("ranks the columns of the fold worst first, and counts the penalties and bonuses", () => {
    const stats = criteriaStats(visibleColumns(criteriaTree(table()), new Set()), repos);
    expect(stats.criteria.map((c) => [names([c.column])[0], c.ratio])).toEqual([
      ["rendu.tests", 0.75],
      ["[code]", 1],
      ["rapport.reponses", 1],
    ]);
    expect(stats.penalties.map((p) => p.count)).toEqual([1]);
    expect(stats.bonuses.map((p) => p.count)).toEqual([1]);
  });
});
