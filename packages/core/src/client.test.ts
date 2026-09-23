/**
 * `resolveStrings` is the one string merge of the repository: every question
 * type's dictionary passes through it, so its two edge cases are worth a test
 * rather than a comment.
 */
import { describe, expect, it } from "vitest";

import { resolveStrings } from "./client.js";

const DEFAULTS = { title: "Answer", hint: "Pick one", count: (n: number) => `${n} left` };

describe("resolveStrings", () => {
  it("returns the defaults untouched when there is no override", () => {
    expect(resolveStrings(DEFAULTS)).toBe(DEFAULTS);
  });

  it("takes the override's entries over the defaults", () => {
    expect(resolveStrings(DEFAULTS, { title: "Réponse" }).title).toBe("Réponse");
  });

  it("skips an entry whose value is undefined rather than blanking the default", () => {
    expect(resolveStrings(DEFAULTS, { title: undefined }).title).toBe("Answer");
  });

  it("carries a parameterised entry, which a Record<K, string> could not", () => {
    const s = resolveStrings(DEFAULTS, { count: (n: number) => `il en reste ${n}` });
    expect(s.count(3)).toBe("il en reste 3");
  });
});
