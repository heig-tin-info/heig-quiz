import { describe, expect, it } from "vitest";

import { mergeShort } from "./generate.js";
import { emptyShortDraft, type ShortConfig } from "./schema.js";

const draft = (patch: Partial<ShortConfig> = {}): ShortConfig => ({ ...emptyShortDraft(), prompt: "Capital?", ...patch });

describe("mergeShort", () => {
  it("replaces the empty placeholder of a fresh draft with exact matchers", () => {
    const merged = mergeShort(draft(), { answers: [{ value: "Berne" }, { value: "Bern" }, { value: " berne " }] });
    expect(merged.matchers).toEqual([
      { kind: "exact", value: "Berne", points: 1 },
      { kind: "exact", value: "Bern", points: 1 },
    ]);
  });

  it("keeps the teacher's matchers and the question's kind", () => {
    const merged = mergeShort(
      draft({ kind: "number", matchers: [{ kind: "number", value: 3.14, tolerance: 0.01, toleranceMode: "abs", unitRequired: false, points: 1 }] }),
      { answers: [{ value: "3.14" }, { value: "3,1416", tolerance: 0.001 }, { value: "pi" }] },
    );
    expect(merged.kind).toBe("number");
    expect(merged.matchers).toEqual([
      { kind: "number", value: 3.14, tolerance: 0.01, toleranceMode: "abs", unitRequired: false, points: 1 },
      { kind: "number", value: 3.1416, tolerance: 0.001, toleranceMode: "abs", unitRequired: false, points: 1 },
    ]);
  });

  it("drops what does not read as the kind, and leaves the draft alone when nothing is left", () => {
    const before = draft({ kind: "date", matchers: [{ kind: "date", value: "", toleranceDays: 0, points: 1 }] });
    expect(mergeShort(before, { answers: [{ value: "next Monday" }] })).toBe(before);
    expect(mergeShort(before, { answers: [{ value: "2026-10-01" }] }).matchers).toEqual([
      { kind: "date", value: "2026-10-01", toleranceDays: 0, points: 1 },
    ]);
  });
});
