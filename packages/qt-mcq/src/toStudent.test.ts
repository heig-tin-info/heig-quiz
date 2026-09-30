/**
 * The type-specific half of the leak test (PLAN-MVP §2.5, docs/05 §5.7,
 * N-SEC-04). The generic half — the full fixture of `./testing.ts` through
 * `toStudent`, shuffle on and off, searched for every forbidden key and every
 * secret value — is the registry's contract test, for every type at once.
 */
import { describe, expect, it } from "vitest";
import { findStudentLeaks } from "@quiz/core/testing";
import { mcqLeakFixture, SECRET_CONFIG } from "./test/fixtures.js";
import { McqConfigSchema } from "./schema.js";
import { mcqServer } from "./server.js";

describe("toStudent", () => {
  it("keeps exactly the fields the player needs", () => {
    const student = mcqServer.toStudent(SECRET_CONFIG, { seed: 7, itemId: "i", shuffle: true });
    expect(Object.keys(student).sort()).toEqual(["choices", "mode", "prompt"]);
  });

  it("carries maxSelections when the teacher set one", () => {
    const config = McqConfigSchema.parse({
      ...SECRET_CONFIG,
      mode: "multiple",
      maxSelections: 2,
    });
    const student = mcqServer.toStudent(config, { seed: 1, itemId: "i", shuffle: false });
    expect(student.maxSelections).toBe(2);
  });

  it("keeps the canonical index on every choice, whatever the display order", () => {
    const student = mcqServer.toStudent(SECRET_CONFIG, { seed: 99, itemId: "i", shuffle: true });
    for (const choice of student.choices) {
      expect(SECRET_CONFIG.choices[choice.id]?.text).toBe(choice.text);
    }
  });

  it("gives the teacher preview (seed 0) a stable order", () => {
    const preview = { seed: 0, itemId: "item-1", shuffle: true };
    expect(mcqServer.toStudent(SECRET_CONFIG, preview)).toEqual(
      mcqServer.toStudent(SECRET_CONFIG, preview),
    );
  });

  /*
   * ADR-026: under the evaluation's negative marking the student is told that
   * wrong answers cost points — one flag, and nothing else of the scoring.
   */
  it("says negative marking is on, and still leaks neither key nor policy", () => {
    const view = {
      seed: 7,
      itemId: "i",
      shuffle: true,
      defaults: { mcq: { policy: "discordance", negativeMarking: true } },
    };
    const student = mcqServer.toStudent(SECRET_CONFIG, view);
    expect(student.negativeMarking).toBe(true);
    expect(Object.keys(student).sort()).toEqual(["choices", "mode", "negativeMarking", "prompt"]);
    expect(mcqServer.studentSchema.safeParse(student).success).toBe(true);
    // The flag itself is `true` here, so that one secret of the fixture is
    // out of this search; `"correct"` (the common floor) still covers the key.
    const leaks = findStudentLeaks(student, {
      forbiddenKeys: mcqLeakFixture.forbiddenKeys,
      secrets: mcqLeakFixture.secrets.filter((secret) => secret !== "true"),
    });
    expect(leaks).toEqual([]);
  });

  it("says nothing when negative marking is off or unreadable", () => {
    for (const defaults of [
      { mcq: { policy: "symmetric", negativeMarking: false } },
      { mcq: { policy: "symmetric" } },
      { mcq: "negative" },
    ]) {
      const student = mcqServer.toStudent(SECRET_CONFIG, { seed: 7, itemId: "i", shuffle: false, defaults });
      expect(student.negativeMarking).toBeUndefined();
    }
  });
});
