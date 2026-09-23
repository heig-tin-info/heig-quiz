/**
 * `resolveStrings` is the one string merge of the repository: every question
 * type's dictionary passes through it, so its two edge cases are worth a test
 * rather than a comment.
 */
import { describe, expect, it } from "vitest";

import { fmt, plural, resolveStrings } from "./client.js";

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

describe("fmt", () => {
  it("fills every placeholder, as often as it appears", () => {
    expect(fmt("{n} of {total}, {n} again", { n: 2, total: 3 })).toBe("2 of 3, 2 again");
  });

  it("leaves an unknown placeholder as written", () => {
    expect(fmt("Case {n}", {})).toBe("Case {n}");
  });
});

describe("plural", () => {
  const strings = {
    cases: "{n} cases",
    "cases.one": "1 case",
    worth: "{count} cases, {points} pts",
    "worth.one": "1 case, {points} pts",
  };

  it("fills the .one sibling for 1 and the key itself otherwise", () => {
    expect(plural(strings, "cases", 1)).toBe("1 case");
    expect(plural(strings, "cases", 0)).toBe("0 cases");
    expect(plural(strings, "cases", 2)).toBe("2 cases");
  });

  it("takes the variables of a sentence that names its count otherwise", () => {
    expect(plural(strings, "worth", 1, { count: 1, points: 2 })).toBe("1 case, 2 pts");
    expect(plural(strings, "worth", 3, { count: 3, points: 2 })).toBe("3 cases, 2 pts");
  });
});
