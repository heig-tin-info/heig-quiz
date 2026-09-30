import { describe, expect, it } from "vitest";

import { findStudentLeaks } from "./testing.js";

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
