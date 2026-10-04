import { describe, expect, it } from "vitest";

import { brainstormServer } from "./server.js";

const config = brainstormServer.configSchema.parse({ configVersion: 1, prompt: "Un être vivant ?", maxIdeas: 2 });
const ctx = { seed: 0, itemId: "i", attemptId: "a", itemPoints: 1, now: new Date(0), runner: {} as never };

describe("brainstormServer", () => {
  it("has no key, so only a poll runs it", () => {
    expect(brainstormServer.hasKey?.(config)).toBe(false);
    expect(brainstormServer.toSolution(config, { seed: 0, itemId: "i", shuffle: false })).toBeNull();
    expect(brainstormServer.grade(config, { ideas: ["x"] }, ctx)).toEqual({
      kind: "graded",
      points: 0,
      maxPoints: 1,
      details: {},
    });
  });

  it("hands a student the prompt and the cap, nothing else", () => {
    expect(brainstormServer.toStudent(config, { seed: 0, itemId: "i", shuffle: false })).toEqual({
      prompt: "Un être vivant ?",
      maxIdeas: 2,
    });
  });

  it("refuses more ideas than the cap, and blank or long ones", () => {
    expect(brainstormServer.answerMisfit?.(config, { ideas: ["a", "b", "c"] })).not.toBeNull();
    expect(brainstormServer.answerMisfit?.(config, { ideas: ["a"] })).toBeNull();
    expect(brainstormServer.answerSchema.safeParse({ ideas: [" "] }).success).toBe(false);
    expect(brainstormServer.answerSchema.safeParse({ ideas: ["x".repeat(61)] }).success).toBe(false);
  });

  it("summarises, counts and aggregates by idea", () => {
    expect(brainstormServer.isAnswered({ ideas: [] })).toBe(false);
    expect(brainstormServer.summarizeAnswer?.(config, { ideas: ["respire", "grandit"] })).toBe("respire · grandit");
    const { distribution } = brainstormServer.aggregate!({
      answers: [{ ideas: ["Respire", "respire !"] }, { ideas: ["respire"] }, "junk"],
      details: [],
    });
    expect(distribution).toEqual([{ key: "respire", label: "respire !", count: 2 }]);
  });

  it("migrates nothing it did not write", () => {
    expect(brainstormServer.migrate(config, 1)).toBe(config);
    expect(() => brainstormServer.migrate(config, 0)).toThrow();
    expect(brainstormServer.emptyDraft().prompt).toBe("");
    expect(brainstormServer.searchText(config)).toBe("Un être vivant ?");
  });
});
