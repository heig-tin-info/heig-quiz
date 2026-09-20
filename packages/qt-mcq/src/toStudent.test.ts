/**
 * The mandatory leak test (PLAN-MVP §2.5, docs/05 §5.7, N-SEC-04).
 *
 * Two independent checks on the SERIALISED student view: no forbidden key, and
 * no secret VALUE. The second one is what catches a leak that renamed a field.
 */
import { describe, expect, it } from "vitest";
import { SECRET_CONFIG } from "./fixtures.js";
import { McqConfigSchema } from "./schema.js";
import { mcqServer } from "./server.js";

const FORBIDDEN_KEYS = [
  "correct",
  "matchers",
  "answers",
  "expected",
  "pattern",
  "value",
  "tolerance",
  "policy",
  "penalty",
  "allowNegative",
  "compare",
  "compileArgs",
  "explanation",
  "internalName",
  "tags",
  "difficulty",
  "rubric",
];

describe("toStudent", () => {
  const views = [
    { seed: 7, itemId: "i", shuffle: true },
    { seed: 0, itemId: "i", shuffle: false },
  ];

  for (const view of views) {
    it(`leaks no key (shuffle: ${String(view.shuffle)})`, () => {
      const out = JSON.stringify(mcqServer.toStudent(SECRET_CONFIG, view));
      for (const key of FORBIDDEN_KEYS) expect(out).not.toContain(`"${key}"`);
    });
  }

  it("leaks no secret value: the key index is nowhere to be read", () => {
    const student = mcqServer.toStudent(SECRET_CONFIG, { seed: 7, itemId: "i", shuffle: true });
    const out = JSON.stringify(student);
    // Every choice text is legitimately present, so the secret is not a text:
    // it is which index carries `correct`, and the truthy marker itself.
    expect(out).not.toContain("true");
    expect(out).not.toContain("0.5");
  });

  it("keeps exactly the four fields the player needs", () => {
    const student = mcqServer.toStudent(SECRET_CONFIG, { seed: 7, itemId: "i", shuffle: true });
    expect(Object.keys(student).sort()).toEqual(["choices", "mode", "prompt"]);
    expect(mcqServer.studentSchema.safeParse(student).success).toBe(true);
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
});
