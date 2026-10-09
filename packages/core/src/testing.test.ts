import { describe, expect, it } from "vitest";

import { findStudentLeaks, testGradeContext } from "./testing.js";

describe("findStudentLeaks", () => {
  it("finds nothing in a clean view", () => {
    expect(findStudentLeaks({ prompt: "p", choices: [{ id: 0, text: "a" }] }, { secrets: ["0x1004"] })).toEqual([]);
  });

  it("reports every leak at once: a floor key, an own key, a secret value", () => {
    const view = { prompt: "p", nested: [{ rubric: "r", unit: "0x1004 bytes" }] };
    expect(findStudentLeaks(view, { forbiddenKeys: ["unit"], secrets: ["0x1004"] })).toEqual([
      'forbidden key "rubric"',
      'forbidden key "unit"',
      'secret value "0x1004"',
    ]);
  });

  it("refuses an empty secret, which would match anything", () => {
    expect(() => findStudentLeaks({}, { secrets: [""] })).toThrow();
  });
});

describe("testGradeContext", () => {
  it("carries the item's scale and the defaults only when given", () => {
    const ctx = testGradeContext(3);
    expect(ctx).toMatchObject({ seed: 7, itemId: "item-1", attemptId: "attempt-1", itemPoints: 3 });
    expect(ctx).not.toHaveProperty("defaults");
    expect(testGradeContext(1, { mcq: { policy: "all" } }).defaults).toEqual({ mcq: { policy: "all" } });
  });

  it("hands a runner that refuses to run and reports itself down", async () => {
    const { runner } = testGradeContext(1);
    expect(() => runner.run({} as never)).toThrow(/never call the runner/);
    await expect(runner.health()).resolves.toMatchObject({ ok: false });
  });
});
