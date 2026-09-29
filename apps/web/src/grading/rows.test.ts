import { describe, expect, it } from "vitest";

import { makeEntry, makeGrading } from "../test/grading-fixtures";
import {
  byName,
  entryKey,
  EXPECTED,
  filterRows,
  moveSelection,
  needsPass,
  nextSort,
  panelTarget,
  primaryAction,
  rowAction,
  rowVerdict,
  shuffled,
  sortRows,
} from "./rows";

/** An answer of attempt `a`, graded `points` / 2 in `state`. */
const row = (a: string, points: number, over: Parameters<typeof makeGrading>[0] = {}) =>
  makeEntry({
    attemptId: a,
    grading: makeGrading({ id: `g-${a}`, attemptId: a, points, ...over }),
  });

describe("rowVerdict", () => {
  it("reads right, partly right and wrong from the points, a negative score as wrong", () => {
    expect(rowVerdict(row("a", 2))).toBe("correct");
    expect(rowVerdict(row("a", 1))).toBe("partial");
    expect(rowVerdict(row("a", 0))).toBe("wrong");
    expect(rowVerdict(row("a", -1))).toBe("wrong");
  });

  it("is pending for an answer not graded yet, or a 0-point placeholder", () => {
    expect(rowVerdict(makeEntry({ grading: null }))).toBe("pending");
    expect(rowVerdict(row("a", 0, { state: "proposed", confidence: null }))).toBe("pending");
  });

  it("is wrong for a missing answer, whatever its grading", () => {
    expect(rowVerdict(makeEntry({ answerId: null, answer: null, grading: null }))).toBe("wrong");
  });
});

describe("the base order", () => {
  const rows = ["a1", "a2", "a3", "a4", "a5", "a6"].map((a) => row(a, 2));

  it("shuffles by the visit's seed, the same way on every call", () => {
    const once = shuffled(rows, 42).map(entryKey);
    expect(shuffled([...rows].reverse(), 42).map(entryKey)).toEqual(once);
    expect(shuffled(rows, 7).map(entryKey)).not.toEqual(once);
  });

  it("never moves a row when another one leaves the list", () => {
    const once = shuffled(rows, 42).map(entryKey);
    const without = shuffled(
      rows.filter((r) => r.attemptId !== "a3"),
      42,
    ).map(entryKey);
    expect(without).toEqual(once.filter((k) => !k.startsWith("a3:")));
  });

  it("orders by name when names are shown", () => {
    const named = [
      makeEntry({ attemptId: "x", label: "Zoe" }),
      makeEntry({ attemptId: "y", label: "Adam" }),
    ];
    expect(byName(named).map((e) => e.label)).toEqual(["Adam", "Zoe"]);
  });
});

describe("filterRows", () => {
  const rows = [
    row("a", 2, { state: "validated", source: "auto", confidence: null }),
    row("b", 1, { state: "proposed", source: "llm", confidence: "low" }),
    row("c", 2, { state: "proposed", source: "llm", confidence: "high" }),
  ];
  const all = { state: "all", source: "any", confidence: "any" } as const;

  it("keeps what is not validated under To validate", () => {
    expect(filterRows(rows, { ...all, state: "todo" }).map((e) => e.attemptId)).toEqual(["b", "c"]);
  });

  it("reads the confidence only while the source is AI", () => {
    expect(
      filterRows(rows, { ...all, source: "llm", confidence: "high" }).map((e) => e.attemptId),
    ).toEqual(["c"]);
    expect(filterRows(rows, { ...all, confidence: "high" })).toHaveLength(3);
  });
});

describe("sorting", () => {
  it("cycles ascending, descending, then off", () => {
    expect(nextSort(null, "points")).toEqual({ key: "points", dir: 1 });
    expect(nextSort({ key: "points", dir: 1 }, "points")).toEqual({ key: "points", dir: -1 });
    expect(nextSort({ key: "points", dir: -1 }, "points")).toBeNull();
    expect(nextSort({ key: "points", dir: -1 }, "verdict")).toEqual({ key: "verdict", dir: 1 });
  });

  it("is stable over the base order in both directions", () => {
    const base = [row("a", 1), row("b", 2), row("c", 1), row("d", 2)];
    const points = (e: (typeof base)[number]) => e.grading!.points;
    expect(sortRows(base, { key: "p", dir: 1 }, points).map((e) => e.attemptId)).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
    expect(sortRows(base, { key: "p", dir: -1 }, points).map((e) => e.attemptId)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
    expect(sortRows(base, null, points)).toEqual(base);
  });
});

describe("moveSelection", () => {
  const rows = [row("a", 2), row("b", 2), row("c", 2)];
  const key = (a: string) => entryKey(rows.find((r) => r.attemptId === a)!);

  it("walks the rows, the expected row above the first", () => {
    expect(moveSelection(rows, null, -1, 1)).toBe(key("a"));
    expect(moveSelection(rows, null, -1, -1)).toBe(EXPECTED);
    expect(moveSelection(rows, key("a"), 0, -1)).toBe(EXPECTED);
    expect(moveSelection(rows, key("c"), 2, 1)).toBe(key("c"));
  });

  it("lands on the row that took the place of one that left the table", () => {
    const left = rows.filter((r) => r.attemptId !== "b");
    // "b" stood at index 1 and was validated away under "To validate".
    expect(moveSelection(left, key("b"), 1, 1)).toBe(key("c"));
    expect(moveSelection(left, key("b"), 1, -1)).toBe(key("a"));
  });
});

describe("primaryAction", () => {
  const proposal = row("p", 2, { state: "proposed", confidence: "high" });
  const placeholder = row("h", 0, { state: "proposed", confidence: null });
  const done = row("d", 2, { state: "validated" });

  it("validates what is shown and can go in a batch", () => {
    expect(primaryAction([proposal, done], [proposal, done], false)).toEqual({
      kind: "validate",
      count: 1,
    });
  });

  it("moves on once the question is validated, to the results after the last one", () => {
    expect(primaryAction([done], [done], false)).toEqual({ kind: "next" });
    expect(primaryAction([done], [done], true)).toEqual({ kind: "results" });
  });

  it("stays, disabled, while what is left needs a person or is hidden by a filter", () => {
    expect(primaryAction([placeholder, done], [placeholder, done], false)).toEqual({
      kind: "blocked",
      reason: "byHand",
    });
    expect(primaryAction([proposal, done], [done], false)).toEqual({
      kind: "blocked",
      reason: "hidden",
    });
  });
});

describe("needsPass", () => {
  it("is an answer nothing graded, or a machine's proposal saying why it could not", () => {
    expect(needsPass(makeEntry({ grading: null }))).toBe(true);
    const unrun = row("a", 0, { state: "proposed", confidence: null, details: { reason: "runner_unavailable" } });
    expect(needsPass(unrun)).toBe(true);
  });

  it("is not a question's own fault, which a new pass would only repeat", () => {
    const broken = row("a", 0, { state: "proposed", confidence: null, details: { reason: "reference_failed" } });
    expect(needsPass(broken)).toBe(false);
  });

  it("is not an essay's placeholder, a model's opinion or a validated grading", () => {
    const essay = row("a", 0, { state: "proposed", confidence: null, details: { reason: "manual" } });
    expect(needsPass(essay)).toBe(false);
    expect(needsPass(row("b", 1, { state: "proposed", confidence: "high" }))).toBe(false);
    expect(needsPass(row("c", 2, { state: "validated" }))).toBe(false);
  });
});

describe("rowAction", () => {
  it("validates what the batch would take, and sends a placeholder to be graded", () => {
    expect(rowAction(row("a", 1, { state: "proposed", confidence: "high" }))).toBe("validate");
    expect(rowAction(row("a", 0, { state: "proposed", confidence: "low" }))).toBe("validate");
    const essay = row("a", 0, { state: "proposed", confidence: null, details: { reason: "manual" } });
    expect(rowAction(essay)).toBe("grade");
  });

  it("offers nothing on a validated or an ungraded answer", () => {
    expect(rowAction(row("a", 2, { state: "validated" }))).toBeNull();
    expect(rowAction(makeEntry({ grading: null }))).toBeNull();
  });
});

describe("panelTarget", () => {
  const entries = [row("a", 2), row("b", 1)];

  it("finds the entry by its key, whatever the table shows", () => {
    const b = entries[1]!;
    expect(panelTarget({ key: entryKey(b), adjust: true }, entries)).toEqual({
      kind: "entry",
      entry: b,
      adjust: true,
    });
  });

  it("is the key's panel for the expected row, and nothing for an unknown key", () => {
    expect(panelTarget({ key: EXPECTED, adjust: false }, entries)).toEqual({ kind: "expected" });
    expect(panelTarget({ key: "zz:i1", adjust: false }, entries)).toBeNull();
    expect(panelTarget(null, entries)).toBeNull();
  });
});
