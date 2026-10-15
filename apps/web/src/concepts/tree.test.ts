import { describe, expect, it } from "vitest";

import type { Concept } from "@quiz/contracts";

import { conceptTree } from "./tree";

let seq = 0;
const node = (label: string, broader: Concept[] = []): Concept => ({
  id: `c0c0c0c0-0000-4000-8000-${String((seq += 1)).padStart(12, "0")}`,
  status: "validated",
  mergedInto: null,
  labels: { fr: label, en: label },
  qualifiers: { fr: "", en: "" },
  descriptions: { fr: "", en: "" },
  aliases: [],
  broader: broader.map((b) => b.id),
  related: [],
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
});

/** The rows as `"  Name"`, two spaces a level, `(path)` and `+ Other` marking the rest. */
const drawn = (all: Concept[], shown: Concept[] = all) =>
  conceptTree(all, shown, "en").map(
    (r) =>
      "  ".repeat(r.depth) +
      r.concept.labels.en +
      (r.pathOnly ? " (path)" : "") +
      r.alsoUnder.map((c) => ` + ${c.labels.en}`).join(""),
  );

describe("conceptTree (#897)", () => {
  const pointer = node("Pointer");
  const allocation = node("Dynamic allocation", [pointer]);
  const heap = node("Heap");
  const leak = node("Memory leak", [heap, allocation]);
  const array = node("Array", [pointer]);
  const lone = node("Lone");
  const all = [leak, lone, heap, array, allocation, pointer];

  it("draws a chain of three indented, roots and siblings by name", () => {
    expect(drawn([leak, allocation, pointer])).toEqual(["Pointer", "  Dynamic allocation", "    Memory leak"]);
    expect(drawn(all)).toEqual([
      "Heap",
      "Lone",
      "Pointer",
      "  Array",
      "  Dynamic allocation",
      "    Memory leak + Heap",
    ]);
  });

  it("draws a concept with two broader concepts once, under the first by name, the other as also under", () => {
    const rows = conceptTree(all, all, "en").filter((r) => r.concept === leak);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.alsoUnder).toEqual([heap]);
    expect(rows[0]!.depth).toBe(2);
  });

  it("keeps a shown concept's ancestors as path-only rows, never the other branches", () => {
    expect(drawn(all, [leak])).toEqual(["Pointer (path)", "  Dynamic allocation (path)", "    Memory leak + Heap"]);
    expect(drawn(all, [array, allocation])).toEqual(["Pointer (path)", "  Array", "  Dynamic allocation"]);
  });

  it("ends on a stored cycle, every concept drawn once", () => {
    const a = node("A");
    const b = node("B", [a]);
    a.broader = [b.id];
    const c = node("C", [b]);
    expect(drawn([c, b, a])).toEqual(["A", "  B", "    C"]);
  });

  it("ignores a broader concept the list does not hold", () => {
    expect(drawn([array])).toEqual(["Array"]);
  });
});
