/**
 * `resolveStrings` is the one string merge of the repository: every question
 * type's dictionary passes through it, so its two edge cases are worth a test
 * rather than a comment.
 */
import { describe, expect, it } from "vitest";

import { fmt, issuesAt, plural, resolveStrings, rootIssues, showsSection } from "./client.js";

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

  it("reads only the variables' own keys, never the prototype chain", () => {
    expect(fmt("{constructor} {toString}", {})).toBe("{constructor} {toString}");
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

describe("issuesAt / rootIssues", () => {
  const issues = [
    { path: [], message: "root" },
    { path: ["choices"], message: "list" },
    { path: ["choices", 2, "text"], message: "row" },
    { path: ["prompt"], message: "prompt" },
  ];

  it("keeps the issues under a path prefix", () => {
    expect(issuesAt(issues, "choices").map((i) => i.message)).toEqual(["list", "row"]);
    expect(issuesAt(issues, "choices", 2).map((i) => i.message)).toEqual(["row"]);
    expect(issuesAt(issues, "choices", 1)).toEqual([]);
  });

  it("keeps the issues of the config as a whole", () => {
    expect(rootIssues(issues).map((i) => i.message)).toEqual(["root"]);
  });
});

describe("showsSection", () => {
  it("shows every part when no selection is given", () => {
    expect(showsSection(undefined, "prompt")).toBe(true);
    expect(showsSection(undefined, "solution")).toBe(true);
  });

  it("shows a part left out of the selection, and one set to true", () => {
    expect(showsSection({ solution: false }, "prompt")).toBe(true);
    expect(showsSection({ prompt: true }, "prompt")).toBe(true);
  });

  it("hides only a part explicitly set to false", () => {
    expect(showsSection({ prompt: false }, "prompt")).toBe(false);
    expect(showsSection({ prompt: false }, "solution")).toBe(true);
  });
});
