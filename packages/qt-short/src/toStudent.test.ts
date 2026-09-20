/** The mandatory leak test (PLAN-MVP §2.5, docs/05 §5.7, N-SEC-04). */
import { describe, expect, it } from "vitest";
import { SECRET_CONFIG, SECRET_VALUES } from "./fixtures.js";
import { shortServer } from "./server.js";

const FORBIDDEN_KEYS = [
  "correct",
  "matchers",
  "answers",
  "expected",
  "pattern",
  "value",
  "tolerance",
  "toleranceMode",
  "toleranceDays",
  "toleranceMinutes",
  "unit",
  "unitRequired",
  "caseSensitive",
  "policy",
  "penalty",
  "compare",
  "compileArgs",
  "explanation",
  "internalName",
  "tags",
  "difficulty",
  "rubric",
  "reference",
];

describe("toStudent", () => {
  const view = { seed: 7, itemId: "i", shuffle: true };

  it("leaks no key", () => {
    const out = JSON.stringify(shortServer.toStudent(SECRET_CONFIG, view));
    for (const key of FORBIDDEN_KEYS) expect(out).not.toContain(`"${key}"`);
  });

  it("leaks no secret value", () => {
    const out = JSON.stringify(shortServer.toStudent(SECRET_CONFIG, view));
    for (const secret of SECRET_VALUES) expect(out).not.toContain(secret);
  });

  it("keeps exactly what the player needs", () => {
    const student = shortServer.toStudent(SECRET_CONFIG, view);
    expect(Object.keys(student).sort()).toEqual(["kind", "placeholder", "prompt"]);
    expect(shortServer.studentSchema.safeParse(student).success).toBe(true);
  });

  it("omits the placeholder when the teacher set none", () => {
    const student = shortServer.toStudent(
      { ...SECRET_CONFIG, placeholder: undefined },
      view,
    );
    expect("placeholder" in student).toBe(false);
  });

  it("does not depend on the seed: there is nothing to shuffle", () => {
    expect(shortServer.toStudent(SECRET_CONFIG, { ...view, seed: 1 })).toEqual(
      shortServer.toStudent(SECRET_CONFIG, { ...view, seed: 2 }),
    );
  });
});
