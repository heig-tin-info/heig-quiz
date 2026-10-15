import { describe, expect, it } from "vitest";

import type { AdminConcept, ConceptRelationProposals } from "@quiz/contracts";
import { edgesOf } from "@quiz/domain";

import { ApiError } from "../api";
import {
  aiRowsOf,
  broaderRowsFor,
  conflicting,
  isConcept,
  rowsOf,
  rowState,
  runAccept,
  type RelationRow,
  type TopConcept,
} from "./relationReview";

const concept = (n: number, over: Partial<AdminConcept> = {}): AdminConcept => ({
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
const all = [c1, c2, c3, c4];

const proposals = (over: Partial<ConceptRelationProposals> = {}): ConceptRelationProposals => ({
  lang: "fr",
  asked: [],
  broader: [],
  related: [],
  tops: [],
  remaining: 0,
  truncated: false,
  ...over,
});
const structure = { label: "Structure", qualifier: "", reason: "Groups them.", narrower: [c3.id, c4.id] };

describe("rowsOf", () => {
  it("names both concepts and drops a row whose concept is gone", () => {
    const rows = rowsOf(
      [
        { kind: "broader", concept: c1.id, target: c2.id, questions: null },
        { kind: "broader", concept: c3.id, target: concept(9).id, questions: null },
        { kind: "related", concept: c2.id, target: c4.id, questions: 4 },
      ],
      all,
    );
    expect(rows.map((r) => [r.kind, r.a.id, isConcept(r.b) && r.b.id, r.questions])).toEqual([
      ["broader", c1.id, c2.id, null],
      ["related", c2.id, c4.id, 4],
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
});

describe("aiRowsOf", () => {
  const prepass = rowsOf(
    [
      { kind: "broader", concept: c1.id, target: c2.id, questions: null },
      { kind: "related", concept: c3.id, target: c4.id, questions: 3 },
    ],
    all,
  );

  it("drops what the pre-pass lists already, same kind and pair in either order, and a concept that is gone", () => {
    const rows = aiRowsOf(
      proposals({
        broader: [
          { concept: c1.id, target: c2.id },
          { concept: c2.id, target: c1.id },
          { concept: c3.id, target: concept(9).id },
          { concept: c2.id, target: c3.id },
        ],
        related: [
          { a: c4.id, b: c3.id, reason: "listed" },
          { a: c1.id, b: c2.id, reason: "Another kind." },
        ],
      }),
      all,
      prepass,
    );
    expect(rows.map((r) => [r.kind, r.concept, r.target, r.reason])).toEqual([
      ["broader", c2.id, c3.id, null],
      ["related", c1.id, c2.id, "Another kind."],
    ]);
  });

  it("puts a top's concepts under it, as a placeholder until the vocabulary holds it", () => {
    const [before] = [aiRowsOf(proposals({ tops: [structure] }), all, [])];
    expect(before.map((r) => [r.concept, r.target, isConcept(r.b), r.top?.label])).toEqual([
      [c3.id, "top:structure", false, "Structure"],
      [c4.id, "top:structure", false, "Structure"],
    ]);
    expect(rowState(before[0]!, edgesOf(all))).toEqual({ state: "open" });

    const created = concept(5, { labels: { fr: "Structure", en: null }, status: "proposed" });
    const after = aiRowsOf(proposals({ tops: [structure] }), [...all, created], []);
    expect(after.map((r) => [r.target, isConcept(r.b) && r.b.id, r.top?.key])).toEqual([
      [created.id, created.id, "structure"],
      [created.id, created.id, "structure"],
    ]);
  });
});

describe("broaderRowsFor", () => {
  it("keeps one concept's broader rows and the top gathering it, nothing else", () => {
    const rows = broaderRowsFor(
      proposals({
        broader: [
          { concept: c3.id, target: c1.id },
          { concept: c2.id, target: c1.id },
        ],
        related: [{ a: c3.id, b: c2.id, reason: "Connected." }],
        tops: [structure],
      }),
      all,
      c3.id,
    );
    expect(rows.map((r) => [r.kind, r.concept, isConcept(r.b) ? r.b.id : r.b.label])).toEqual([
      ["broader", c3.id, c1.id],
      ["broader", c3.id, "Structure"],
    ]);
    expect(broaderRowsFor(undefined, all, c3.id)).toEqual([]);
  });
});

describe("rowState", () => {
  const row = (kind: "broader" | "related", a: AdminConcept, b: AdminConcept) => ({ kind, concept: a.id, target: b.id });

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

describe("conflicting", () => {
  it("names the open rows the ticked ones would make refused, across the two lists", () => {
    const prepass = rowsOf([{ kind: "related", concept: c1.id, target: c2.id, questions: 3 }], all);
    const ai = aiRowsOf(
      proposals({ broader: [{ concept: c2.id, target: c1.id }, { concept: c1.id, target: c3.id }, { concept: c3.id, target: c4.id }] }),
      all,
      prepass,
    );
    const rows = [...prepass, ...ai];
    const edges = edgesOf(all);
    expect(conflicting(rows, [], edges)).toEqual(new Set());
    // c2 under c1 makes the related pair redundant; with c1 under c3, c3 under c4 stays fine.
    expect(conflicting(rows, [ai[0]!, ai[1]!], edges)).toEqual(new Set([prepass[0]!.key]));
    expect(conflicting(rows, [prepass[0]!], edges)).toEqual(new Set([ai[0]!.key]));
  });
});

describe("runAccept", () => {
  const top = (n: number): TopConcept => ({ key: `t${n}`, lang: "fr", label: `T${n}`, qualifier: "", reason: "r" });
  const under = (a: AdminConcept, t: TopConcept): RelationRow => ({
    key: `top:${t.key}:${a.id}`,
    kind: "broader",
    concept: a.id,
    target: `top:${t.key}`,
    a,
    b: t,
    questions: null,
    reason: null,
    top: t,
  });
  const [related, broader] = rowsOf(
    [
      { kind: "related", concept: c1.id, target: c2.id, questions: 3 },
      { kind: "broader", concept: c3.id, target: c4.id, questions: null },
    ],
    all,
  ) as [RelationRow, RelationRow];

  it("writes the broader edges first, goes on after a refusal and reports each row", async () => {
    const order: string[] = [];
    const refusal = new Error("409");
    const out = await runAccept([related, broader], {
      create: () => Promise.reject(new Error("no top here")),
      relate: async (row) => {
        order.push(row.kind);
        if (row.kind === "broader") throw refusal;
      },
    });
    expect(order).toEqual(["broader", "related"]);
    expect(out.get(broader.key)).toEqual({ error: refusal });
    expect(out.get(related.key)).toEqual({ ok: true });
  });

  it("creates each top once before any edge, and writes its rows towards the new id", async () => {
    const steps: string[] = [];
    const t1 = top(1);
    const out = await runAccept([related, under(c1, t1), under(c2, t1), broader], {
      create: async (t) => {
        steps.push(`create ${t.label}`);
        return { id: "new-t1" };
      },
      relate: async (row, target) => {
        steps.push(`${row.kind} ${row.a.labels.fr} ${target}`);
      },
    });
    expect(steps).toEqual([
      "create T1",
      "broader C1 new-t1",
      "broader C2 new-t1",
      `broader C3 ${c4.id}`,
      `related C1 ${c2.id}`,
    ]);
    expect([...out.values()].every((o) => "ok" in o)).toBe(true);
  });

  it("reuses the concept a 409 concept_exists names, and fails every row of a top whose creation failed, the others going on", async () => {
    const [t1, t2] = [top(1), top(2)];
    const exists = new ApiError(409, { error: "concept_exists", concept: { ...c4, labels: { fr: "T1", en: null } } });
    const dropped = new ApiError(422, { error: "concept_dropped" });
    const targets: string[] = [];
    const rows = [under(c1, t1), under(c2, t2), under(c3, t2), related];
    const out = await runAccept(rows, {
      create: (t) => Promise.reject(t.key === "t1" ? exists : dropped),
      relate: async (_row, target) => {
        targets.push(target);
      },
    });
    expect(targets).toEqual([c4.id, c2.id]);
    expect(rows.map((r) => out.get(r.key))).toEqual([{ ok: true }, { error: dropped }, { error: dropped }, { ok: true }]);
  });
});
