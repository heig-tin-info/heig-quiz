import { describe, expect, it } from "vitest";

import type { AdminConcept } from "@quiz/contracts";
import { edgesOf } from "@quiz/domain";

import { rowsOf, rowState, runAccept } from "./relationReview";

const concept = (n: number, over: Partial<Pick<AdminConcept, "broader" | "related">> = {}): AdminConcept => ({
  id: `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, "0")}`,
  status: "validated",
  mergedInto: null,
  labels: { fr: `C${n}`, en: `C${n}` },
  qualifiers: { fr: "", en: "" },
  descriptions: { fr: "", en: "" },
  aliases: [],
  broader: [],
  related: [],
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
  questionCount: 0,
  deletable: true,
  creator: null,
  ...over,
});

const [c1, c2, c3, c4] = [concept(1), concept(2), concept(3), concept(4)];

describe("rowsOf", () => {
  it("names both concepts and drops a row whose concept is gone", () => {
    const rows = rowsOf(
      [
        { kind: "broader", concept: c1.id, target: c2.id, questions: null },
        { kind: "broader", concept: c3.id, target: concept(9).id, questions: null },
        { kind: "related", concept: c2.id, target: c4.id, questions: 4 },
      ],
      [c1, c2, c3, c4],
    );
    expect(rows.map((r) => [r.kind, r.a.id, r.b.id, r.questions])).toEqual([
      ["broader", c1.id, c2.id, null],
      ["related", c2.id, c4.id, 4],
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
});

describe("rowState", () => {
  const row = (kind: "broader" | "related", a: AdminConcept, b: AdminConcept) =>
    kind === "broader" ? { kind, concept: a.id, target: b.id, questions: null } : { kind, concept: a.id, target: b.id, questions: 3 };

  it("is open, added once the edge exists, blocked by the rule otherwise", () => {
    expect(rowState(row("broader", c1, c2), edgesOf([c1, c2]))).toEqual({ state: "open" });
    const placed = [concept(1, { broader: [c2.id] }), c2];
    expect(rowState(row("broader", c1, c2), edgesOf(placed))).toEqual({ state: "added" });
    expect(rowState(row("broader", c2, c1), edgesOf(placed))).toEqual({
      state: "blocked",
      refusal: { kind: "cycle", path: [c2.id, c1.id, c2.id] },
    });
    expect(rowState(row("related", c1, c2), edgesOf(placed))).toEqual({ state: "blocked", refusal: { kind: "redundant" } });
    const related = [concept(1, { related: [c2.id] }), concept(2, { related: [c1.id] })];
    expect(rowState(row("related", c2, c1), edgesOf(related))).toEqual({ state: "added" });
  });
});

describe("runAccept", () => {
  const rows = rowsOf(
    [
      { kind: "related", concept: c1.id, target: c2.id, questions: 3 },
      { kind: "broader", concept: c3.id, target: c4.id, questions: null },
    ],
    [c1, c2, c3, c4],
  );

  it("writes the broader edges first, goes on after a refusal and reports each row", async () => {
    const order: string[] = [];
    const refusal = new Error("409");
    const out = await runAccept(rows, async (row) => {
      order.push(row.kind);
      if (row.kind === "broader") throw refusal;
    });
    expect(order).toEqual(["broader", "related"]);
    expect(out.get(rows[1]!.key)).toEqual({ error: refusal });
    expect(out.get(rows[0]!.key)).toEqual({ ok: true });
  });
});
