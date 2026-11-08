/**
 * The contract surface of `mathServer` (docs/spec/04 §4.16, ADR-102). What
 * every type owes — the version stamp, the migration of its own version, the
 * empty draft, the leak test of the full fixture through `toStudent` and the
 * paper documents — is the registry's contract test; `./toStudent.test.ts`
 * holds the student view and the feedback path. This file holds the hooks that are the
 * type's own: publication, the live grid and the debrief.
 */
import { describe, expect, it } from "vitest";

import { mathPublicationIssues, mathServer } from "./server.js";
import { config, SECRET_CONFIG } from "./test/fixtures.js";

describe("publication", () => {
  it("names a key that does not read, by its problem", () => {
    expect(mathPublicationIssues(config({ answers: [{ value: "2x^2-3", points: 1 }, { value: "x+y", points: 1 }, { value: "x^{2", points: 1 }] }))).toEqual([
      { path: ["answers", 1, "value"], message: "math.key_unknown_symbol" },
      { path: ["answers", 2, "value"], message: "math.key_syntax" },
    ]);
    expect(mathPublicationIssues(config({ answers: [{ value: "\\sum_{n=0}^{9}x", points: 1 }] }))).toEqual([
      { path: ["answers", 0, "value"], message: "math.key_unsupported" },
    ]);
  });

  it("refuses a first key with no value anywhere on the domain", () => {
    expect(mathPublicationIssues(config({ symbols: [{ name: "x", min: -5, max: -1 }], answers: [{ value: "\\sqrt{x}", points: 1 }] }))).toEqual([
      { path: ["answers", 0, "value"], message: "math.key_undefined" },
    ]);
    expect(mathPublicationIssues(config({ symbols: [{ name: "x", min: 1, max: 5 }], answers: [{ value: "\\sqrt{x}", points: 1 }] }))).toEqual([]);
  });

  it("passes a sound question", () => {
    expect(mathPublicationIssues(SECRET_CONFIG)).toEqual([]);
  });
});

describe("the rest of the server contract", () => {
  it("summarises and aggregates by the text typed", () => {
    expect(mathServer.summarizeAnswer!(SECRET_CONFIG, { latex: " R_1 +\nR_2 " })).toBe("R_1 + R_2");
    const aggregate = mathServer.aggregate!({ answers: [{ latex: "x" }, { latex: "x " }, { latex: "y" }, "junk", null], details: [] });
    expect(aggregate.distribution?.map((e) => [e.key, e.count])).toEqual([
      ["x", 2],
      ["y", 1],
    ]);
  });

  it("indexes the prompt and the keys", () => {
    expect(mathServer.searchText(SECRET_CONFIG)).toContain("R_1+R_2");
    expect(mathServer.defaultPoints(SECRET_CONFIG)).toBe(1);
    expect(mathServer.shuffleable(SECRET_CONFIG)).toBe(false);
    expect(mathServer.hasKey!(SECRET_CONFIG)).toBe(true);
    expect(mathServer.isAnswered({ latex: " " })).toBe(false);
    expect(mathServer.isAnswered({ latex: "x" })).toBe(true);
  });
});
