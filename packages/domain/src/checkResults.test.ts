import { describe, expect, it } from "vitest";

import { RESULT_LOG_MAX_BYTES, TRUNCATED_MARK, checkOutcomes, tailUtf8 } from "./checkResults.js";
import type { CriteriaLeaf } from "./criteria.js";

const leaf = (id: string, extra: Partial<CriteriaLeaf>): CriteriaLeaf => ({ id, sectionPath: [], description: id, maxPoints: 1, ...extra });

describe("checkOutcomes", () => {
  const leaves = [
    leaf("tests.functional", { maxPoints: 10, command: ["make", "test"] }),
    leaf("code.format", { maxPoints: 1, command: ["make", "format"], prompt: "p" }),
    leaf("code.crash", { maxPoints: -2, command: ["./crash"] }),
    leaf("extra.fast", { maxPoints: 0, bonusPoints: 1, command: ["./bench"] }),
    leaf("report.style", { maxPoints: 4, prompt: "Readable?" }),
    leaf("tests.missing", { maxPoints: 3, command: ["make", "other"] }),
    leaf("git.history", { maxPoints: 2 }),
  ];

  it("maps each command criterion to its points, its maximum and its log, in the criteria's order", () => {
    const outcomes = checkOutcomes(leaves, {
      criteria: {
        "code.format": { score: "1/1", log: "ok" },
        "tests.functional": { score: " 7.5 / 10 " },
        "code.crash": { score: "1/4", log: "segfault" },
        "extra.fast": { score: "3/2" },
        "report.style": { score: "1/1" },
        "unknown.id": { score: "1/1" },
      },
    });
    expect(outcomes).toEqual([
      { id: "tests.functional", points: 7.5, max: 10, log: null },
      { id: "code.format", points: 1, max: 1, log: "ok" },
      { id: "code.crash", points: -1.5, max: -2, log: "segfault" },
      { id: "extra.fast", points: 1, max: 1, log: null },
      { id: "tests.missing", reason: "no_result" },
    ]);
  });

  it("reads an invalid score, or an inherited key, as no result", () => {
    const outcomes = checkOutcomes([leaf("a", { command: ["x"] }), leaf("toString", { command: ["y"] })], { criteria: { a: { score: "1/0" } } });
    expect(outcomes).toEqual([
      { id: "a", reason: "no_result" },
      { id: "toString", reason: "no_result" },
    ]);
  });

  it("gives nothing when no criterion has a command", () => {
    expect(checkOutcomes([leaf("a", { prompt: "p" })], { criteria: { a: { score: "1/1" } } })).toEqual([]);
  });
});

describe("tailUtf8", () => {
  const bytes = (text: string) => new TextEncoder().encode(text).length;

  it("keeps a text that fits, and the tail of one that does not, marked", () => {
    expect(tailUtf8("short", 8)).toBe("short");
    const cut = tailUtf8("x".repeat(100) + "END", 40);
    expect(cut.startsWith(TRUNCATED_MARK) && cut.endsWith("END")).toBe(true);
    expect(bytes(cut)).toBe(40);
  });

  it("never keeps half a character", () => {
    const cut = tailUtf8("é".repeat(50), 30);
    expect(cut).toBe(TRUNCATED_MARK + "é".repeat(7));
    expect(bytes(cut)).toBeLessThanOrEqual(30);
  });

  it("keeps the mark alone under a cap smaller than it", () => {
    expect(tailUtf8("abcdefghijklmnopqrstuvwxyz", 4)).toBe(TRUNCATED_MARK);
  });

  it("cuts a check's log in bytes, from its start", () => {
    const [outcome] = checkOutcomes([leaf("a", { command: ["x"] })], { criteria: { a: { score: "1/1", log: "€".repeat(4000) } } });
    const log = (outcome as { log: string }).log;
    expect(bytes(log)).toBeLessThanOrEqual(RESULT_LOG_MAX_BYTES);
    expect(log.startsWith(TRUNCATED_MARK)).toBe(true);
  });
});
