/**
 * `askGrader`'s wiring of the scale (ADR-118): a reply becomes points and a
 * breakdown on the item's scale that agree. The rule itself is
 * `scaleCriteria`'s, tested in `@quiz/domain`.
 */
import { describe, expect, it } from "vitest";

import { AI_KEY } from "@quiz/contracts";
import type { LlmGradeOutcome, LlmGradeRequest } from "@quiz/core/server";

import { askGrader, onItemScale, type GradingLlm } from "./service.js";

const base: LlmGradeRequest = { statement: "Why?", form: "free text", rubric: "", answer: "Because.", maxPoints: 1 };
const outcome = (over: Partial<LlmGradeOutcome>): LlmGradeOutcome => ({
  points: 0,
  justification: "j",
  confidence: "medium",
  criteria: [],
  model: "m",
  ...over,
});
const twoCriteria = {
  ...base,
  maxPoints: 4,
  criteria: [
    { id: "a", title: "A", weight: 2, prompt: "" },
    { id: "b", title: "B", weight: 2, prompt: "" },
  ],
};

describe("onItemScale", () => {
  it("reads structured criteria in the request's order and titles; a criterion left out earns 0", () => {
    const scaled = onItemScale(
      twoCriteria,
      outcome({ criteria: [{ id: "a", criterion: "renamed", points: 1.5, maxPoints: 9, comment: "a ok" }] }),
    );
    expect(scaled).toEqual({
      points: 1.5,
      criteria: [
        { id: "a", criterion: "A", points: 1.5, maxPoints: 2, comment: "a ok" },
        { id: "b", criterion: "B", points: 0, maxPoints: 2, comment: "" },
      ],
    });
  });

  it("rescales a free rubric's breakdown whose maxima miss the item's points (the 1 of 1 bug)", () => {
    const scaled = onItemScale(
      base,
      outcome({
        points: 1,
        criteria: [
          { criterion: "One", points: 1, maxPoints: 1, comment: "" },
          { criterion: "Two", points: 1, maxPoints: 1, comment: "" },
        ],
      }),
    );
    expect(scaled.criteria.map((c) => [c.points, c.maxPoints])).toEqual([
      [0.5, 0.5],
      [0.5, 0.5],
    ]);
    expect(scaled.points).toBe(1);
  });
});

describe("askGrader", () => {
  it("stores the scaled breakdown under details.ai and its total as the points", async () => {
    const llm: GradingLlm = {
      ready: () => Promise.resolve(true),
      grade: () => Promise.resolve(outcome({ criteria: [{ id: "a", criterion: "A", points: 1, maxPoints: 2, comment: "c" }] })),
      reviewProject: () => Promise.reject(new Error("not under test")),
    };
    const log = { error: () => {} } as never;
    const proposal = await askGrader(llm, { ...twoCriteria, maxPoints: 2 }, { billedTo: null, purpose: "try", own: { reason: "llm" }, log, context: {} });
    expect(proposal.points).toBe(0.5);
    expect(proposal.details).toMatchObject({ reason: "llm", justification: "j" });
    expect(proposal.details[AI_KEY]).toEqual({
      model: "m",
      criteria: [
        { id: "a", criterion: "A", points: 0.5, maxPoints: 1, comment: "c" },
        { id: "b", criterion: "B", points: 0, maxPoints: 1, comment: "" },
      ],
    });
  });
});
