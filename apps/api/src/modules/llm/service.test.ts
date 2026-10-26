/**
 * `askGrader`'s scale (ADR-118): what a model replies becomes points and a
 * breakdown on the item's scale that agree with each other.
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

describe("onItemScale", () => {
  it("scales structured criteria from weight units to the item, the total from the raw sum", () => {
    const request = {
      ...base,
      maxPoints: 1,
      criteria: [
        { id: "a", title: "A", weight: 1, prompt: "" },
        { id: "b", title: "B", weight: 1, prompt: "" },
      ],
    };
    const scaled = onItemScale(
      request,
      outcome({
        points: 2,
        criteria: [
          { id: "b", criterion: "renamed", points: 1, maxPoints: 1, comment: "b ok" },
          { id: "a", criterion: "A", points: 1, maxPoints: 1, comment: "a ok" },
        ],
      }),
    );
    expect(scaled).toEqual({
      points: 1,
      criteria: [
        { id: "a", criterion: "A", points: 0.5, maxPoints: 0.5, comment: "a ok" },
        { id: "b", criterion: "B", points: 0.5, maxPoints: 0.5, comment: "b ok" },
      ],
    });
  });

  it("gives 0 to a criterion the reply left out", () => {
    const request = { ...base, maxPoints: 3, criteria: [{ id: "a", title: "A", weight: 3, prompt: "" }] };
    expect(onItemScale(request, outcome({}))).toEqual({
      points: 0,
      criteria: [{ id: "a", criterion: "A", points: 0, maxPoints: 3, comment: "" }],
    });
  });

  it("rescales a free rubric's breakdown whose maxima miss the item's points, so both agree (the 1 of 1 bug)", () => {
    const scaled = onItemScale(
      base,
      outcome({
        points: 2,
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

  it("keeps a breakdown that already adds up, and clamps the total as the last guard", () => {
    const criteria = [{ criterion: "One", points: 1, maxPoints: 2, comment: "" }];
    expect(onItemScale({ ...base, maxPoints: 2 }, outcome({ points: 5, criteria }))).toEqual({ points: 2, criteria });
    expect(onItemScale(base, outcome({ points: -1 }))).toEqual({ points: 0, criteria: [] });
  });
});

describe("askGrader", () => {
  it("stores the scaled breakdown under details.ai and the total as the points", async () => {
    const llm: GradingLlm = {
      ready: () => Promise.resolve(true),
      grade: () =>
        Promise.resolve(
          outcome({ points: 3, criteria: [{ id: "a", criterion: "A", points: 1.5, maxPoints: 2, comment: "c" }] }),
        ),
      reviewProject: () => Promise.reject(new Error("not under test")),
    };
    const request = {
      ...base,
      maxPoints: 4,
      criteria: [
        { id: "a", title: "A", weight: 2, prompt: "" },
        { id: "b", title: "B", weight: 2, prompt: "" },
      ],
    };
    const log = { error: () => {} } as never;
    const proposal = await askGrader(llm, request, { billedTo: null, purpose: "try", own: { reason: "llm" }, log, context: {} });
    expect(proposal.points).toBe(1.5);
    expect(proposal.details[AI_KEY]).toEqual({
      model: "m",
      criteria: [
        { id: "a", criterion: "A", points: 1.5, maxPoints: 2, comment: "c" },
        { id: "b", criterion: "B", points: 0, maxPoints: 2, comment: "" },
      ],
    });
  });
});
