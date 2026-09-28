/** The mandatory leak test (PLAN-MVP §2.5, docs/05 §5.7, N-SEC-04). */
import { describe, expect, it } from "vitest";
import { COMMON_FORBIDDEN_STUDENT_KEYS } from "@quiz/core/server";
import { SECRET_CONFIG, SECRET_VALUES } from "./test/fixtures.js";
import { richServer } from "./server.js";

/** The shared floor plus what only `rich` holds: the model answer. */
const FORBIDDEN_KEYS = [...COMMON_FORBIDDEN_STUDENT_KEYS, "compare", "expected", "reference"];

describe("toStudent", () => {
  const view = { seed: 7, itemId: "i", shuffle: true };

  it("leaks no key", () => {
    const out = JSON.stringify(richServer.toStudent(SECRET_CONFIG, view));
    for (const key of FORBIDDEN_KEYS) expect(out).not.toContain(`"${key}"`);
  });

  it("leaks no secret value: neither the rubric nor the model answer", () => {
    const out = JSON.stringify(richServer.toStudent(SECRET_CONFIG, view));
    for (const secret of SECRET_VALUES) expect(out).not.toContain(secret);
  });

  it("keeps exactly what the player needs", () => {
    const student = richServer.toStudent(SECRET_CONFIG, view);
    expect(student).toEqual({ prompt: SECRET_CONFIG.prompt, format: "markdown", maxChars: 3000 });
    expect(richServer.studentSchema.safeParse(student).success).toBe(true);
  });

  it("omits the limit when the teacher set none", () => {
    const { maxChars: _drop, ...unlimited } = SECRET_CONFIG;
    expect("maxChars" in richServer.toStudent(unlimited, view)).toBe(false);
  });
});
