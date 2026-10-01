/**
 * The config pipeline of `./config.ts` on plain objects (§1.6): what a
 * stored row loads as, and what a draft is stored as. The same pipeline
 * through the database is `pool.db.test.ts`'s "read/write pipeline".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerForTests } from "@quiz/registry/server";

import { fakeShort } from "../../test/fakeType.js";
import { loadConfig, saveDraftConfig, tryLoadConfig } from "./config.js";

let restore: () => void;
beforeAll(() => {
  restore = registerForTests(fakeShort);
});
afterAll(() => restore());

describe("loading and saving a config (§1.6)", () => {
  it("loadConfig throws on a config no migration can save, tryLoadConfig does not", () => {
    const row = { config: { statement: 7 }, configVersion: 2, variables: null };
    expect(() => loadConfig("short", row)).toThrow();
    const outcome = tryLoadConfig("short", row);
    expect(outcome.ok).toBe(false);
  });

  /*
   * An INVALID draft at an old version, which is where the two halves of a
   * row used to part company: the editor was handed the stored bytes, wrote
   * them back unchanged, and `saveDraftConfig` stamped the row with the
   * current version — an old shape under a number it did not have. Nothing
   * migrated it afterwards, `configVersion` failed on every parse, and a
   * failing literal ABORTS a zod object: the refinements never ran, so the
   * teacher was told nothing about the field they were working on.
   *
   * The real `mcq` type, because the fakes carry no `configVersion` inside
   * their configs and this is precisely about that field.
   */
  const v1Mcq = (over: Record<string, unknown> = {}) => ({
    configVersion: 1,
    prompt: "Which of these are prime?",
    choices: [
      { text: "2", correct: true },
      { text: "3", correct: true },
      { text: "5", correct: true },
    ],
    mode: "multiple",
    policy: "partial",
    penalty: 1,
    allowNegative: false,
    shuffleChoices: true,
    ...over,
  });

  it("hands an invalid draft back at the CURRENT shape, migrated", () => {
    const outcome = tryLoadConfig("mcq", { config: v1Mcq({ prompt: "" }), configVersion: 1 });
    expect(outcome.ok).toBe(false);
    expect(outcome.config).toMatchObject({ configVersion: 2, policy: "symmetric" });
    expect(outcome.config).not.toHaveProperty("penalty");
  });

  it("raises a draft that declares an older version before storing it", () => {
    const { row, issues } = saveDraftConfig("mcq", v1Mcq({ maxSelections: 2 }));
    // The stored blob agrees with the column beside it…
    expect(row.configVersion).toBe(2);
    expect(row.config).toMatchObject({ configVersion: 2 });
    // …and the issue reported is the teacher's, not a version mismatch that
    // would have hidden it.
    expect(issues.map((i) => i.message)).toEqual(["mcq.max_below_correct"]);
    expect(issues[0]?.path).toEqual(["maxSelections"]);
  });
});
