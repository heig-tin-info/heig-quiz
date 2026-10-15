import { describe, expect, it } from "vitest";

import type { Concept } from "@quiz/contracts";
import { edgesOf } from "@quiz/domain";

import { acceptPlan, rowsOf, rowState, runAccept } from "./relationReview";

const concept = (n: number, over: Partial<Pick<Concept, "broader" | "related">> = {}): Concept => ({
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
  ...over,
});

const [c1, c2, c3, c4] = [concept(1), concept(2), concept(3), concept(4)];

describe("rowsOf", () => {
  it("names both concepts, drops a row whose concept is gone and repeats a pair once", () => {
    const rows = rowsOf(
      {
        contained: [{ concept: c1.id, target: c2.id }, { concept: c3.id, target: concept(9).id }],
        together: [
          { a: c2.id, b: c4.id, questions: 4 },
          { a: c4.id, b: c2.id, questions: 4 },
        ],
      },
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
  const row = (kind: "broader" | "related", a: Concept, b: Concept) => ({ kind, concept: a.id, target: b.id });

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

describe("acceptPlan and runAccept", () => {
  const rows = rowsOf(
    { contained: [{ concept: c3.id, target: c4.id }], together: [{ a: c1.id, b: c2.id, questions: 3 }] },
    [c1, c2, c3, c4],
  );

  it("writes the broader edges first, then the related ones", () => {
    const plan = acceptPlan([...rows].reverse());
    expect(plan.create).toEqual([]);
    expect(plan.edges.map((r) => r.kind)).toEqual(["broader", "related"]);
  });

  it("goes on after a refusal and reports each row", async () => {
    const order: string[] = [];
    const refusal = new Error("409");
    const out = await runAccept(acceptPlan(rows), {
      relate: async (row) => {
        order.push(row.kind);
        if (row.kind === "broader") throw refusal;
      },
    });
    expect(order).toEqual(["broader", "related"]);
    expect(out.get(rows[0]!.key)).toEqual({ error: refusal });
    expect(out.get(rows[1]!.key)).toEqual({ ok: true });
  });
});
