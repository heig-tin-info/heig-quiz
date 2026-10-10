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
import { choiceOrder, mcqServer } from "./server.js";

/** Shuffle on and off, the preview's seed and a spread of attempts'. */
const VIEWS = [0, 1, 7, 42, 99, 2024].flatMap((seed) =>
  [true, false].map((shuffle) => ({ seed, itemId: "item-1", shuffle })),
);

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

  /*
   * ADR-097 (audit H2): a choice's id is its displayed position. A canonical
   * id named the key whenever the teacher typed it first — the editor's
   * default — whatever the shuffle drew. Asserted for every view, the
   * identity permutation included: "the ids are not the canonical order"
   * would fail whenever the shuffle draws the identity, and prove nothing.
   */
  it.each(VIEWS)("names each choice by its displayed position (seed $seed, shuffle $shuffle)", (view) => {
    const student = mcqServer.toStudent(SECRET_CONFIG, view);
    const order = choiceOrder(SECRET_CONFIG, view);
    expect(student.choices.map((choice) => choice.id)).toEqual(order.map((_, position) => position));
    expect(student.choices.map((choice) => choice.text)).toEqual(
      order.map((canonical) => SECRET_CONFIG.choices[canonical]!.text),
    );
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

/*
 * ADR-097: the student exchanges positions, the server stores canonical
 * indices, ascending and unique. The round trip over every view is the
 * registry's contract test.
 */
describe("the answer in view coordinates", () => {
  const multiple = McqConfigSchema.parse({
    ...SECRET_CONFIG,
    choices: ["a", "b", "c", "d", "e"].map((text, index) => ({ text, correct: index % 2 === 0 })),
    mode: "multiple",
  });

  it.each(VIEWS)("decodes the position the student ticked to the choice shown there (seed $seed)", (view) => {
    const student = mcqServer.toStudent(multiple, view);
    for (const [position, choice] of student.choices.entries()) {
      const stored = mcqServer.fromStudentAnswer!(multiple, view, { selected: [position] });
      expect(multiple.choices[stored!.selected[0]!]!.text).toBe(choice.text);
    }
  });

  it("refuses a position the view does not have, never drops it", () => {
    const view = { seed: 7, itemId: "i", shuffle: true };
    expect(mcqServer.fromStudentAnswer!(multiple, view, { selected: [5] })).toBeNull();
    expect(mcqServer.fromStudentAnswer!(multiple, view, { selected: [0, 9] })).toBeNull();
  });

  it("names the key in the same coordinates as the choices", () => {
    for (const view of VIEWS) {
      const student = mcqServer.toStudent(multiple, view);
      const { correct } = mcqServer.toSolution(multiple, view);
      const keyTexts = multiple.choices.filter((choice) => choice.correct).map((choice) => choice.text);
      expect(correct.map((position) => student.choices[position]!.text).sort()).toEqual(keyTexts.sort());
    }
  });
});
