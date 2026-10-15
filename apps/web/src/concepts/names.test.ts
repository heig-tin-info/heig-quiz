import { describe, expect, it } from "vitest";

import type { Concept } from "@quiz/contracts";

import { unplaced } from "./names";

const concept = (n: number, broader: Concept[] = []): Concept => ({
  id: `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, "0")}`,
  status: "validated",
  mergedInto: null,
  labels: { fr: `C${n}`, en: `C${n}` },
  qualifiers: { fr: "", en: "" },
  descriptions: { fr: "", en: "" },
  aliases: [],
  broader: broader.map((b) => b.id),
  related: [],
  createdBy: null,
  createdAt: "2026-10-01T08:00:00.000Z",
});

describe("unplaced", () => {
  const root = concept(1);
  const child = concept(2, [root]);
  const lone = concept(3);
  const relatedOnly = { ...concept(4), related: [lone.id] };

  it("keeps a concept with no broader and no narrower concept, related or not", () => {
    expect(unplaced([root, child, lone, relatedOnly])).toEqual([lone, relatedOnly]);
  });

  it("places a root by its child and the child by its broader concept", () => {
    expect(unplaced([root, child])).toEqual([]);
  });

  it("ends on a cycle the server should have refused", () => {
    const a = concept(5);
    const b = concept(6, [a]);
    a.broader = [b.id];
    expect(unplaced([a, b, lone])).toEqual([lone]);
  });
});
