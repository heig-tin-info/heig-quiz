/** The mandatory leak test (PLAN-MVP §2.5, docs/05 §5.7, N-SEC-04). */
import { describe, expect, it } from "vitest";
import { COMMON_FORBIDDEN_STUDENT_KEYS } from "@quiz/core/server";
import { SECRET_CONFIG, SECRET_VALUES } from "./test/fixtures.js";
import { shortServer } from "./server.js";

/*
 * The shared floor (`@quiz/core/server`) plus what only `short` has: the
 * matcher's own vocabulary, which says how the answer is compared and
 * therefore what it looks like.
 */
const FORBIDDEN_KEYS = [
  ...COMMON_FORBIDDEN_STUDENT_KEYS,
  // Out of the floor since R-06 (only `code` publishes it, on purpose); here it
  // still names nothing this type may publish.
  "compare",
  "expected",
  "policy",
  "reference",
  "tolerance",
  "toleranceDays",
  "toleranceMinutes",
  "toleranceMode",
  "unit",
  "unitRequired",
  "value",
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
    expect(Object.keys(student).sort()).toEqual(["constraints", "kind", "placeholder", "prompt"]);
    expect(shortServer.studentSchema.safeParse(student).success).toBe(true);
  });

  it("carries the constraints, which are what the FIELD takes and not the key", () => {
    const student = shortServer.toStudent(SECRET_CONFIG, view);
    expect(student.constraints).toEqual({
      minLength: 0,
      maxLength: 255,
      integer: true,
      min: 1,
      max: 100,
    });
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
