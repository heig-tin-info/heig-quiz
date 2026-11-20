import { describe, expect, it } from "vitest";

import { AiAgreement, ContestationTally, GradingFigures } from "./gradingFigures.js";
import { ByQuestion } from "./results.js";
import { GradingQueueItem } from "./grading.js";

/*
 * The agreement figures (ADR-139 §15): every nullable part of their shape,
 * and the two staff payloads that carry them.
 */

const TALLY = { compared: 4, unchanged: 3, changed: 1, meanAbsDelta: 0.5 };
const AGREEMENT = { ...TALLY, byConfidence: { high: TALLY, medium: null, low: null } };
const NONE = { filed: 0, accepted: 0 };
const CONTESTED = {
  filed: 2,
  accepted: 1,
  graded: 9,
  open: 0,
  refused: 1,
  bySource: { auto: { filed: 2, accepted: 1 }, llm: NONE, manual: NONE },
};

describe("the agreement figures' contract", () => {
  it("takes an agreement with a mean difference or none, and a confidence with no cell as null", () => {
    expect(AiAgreement.parse(AGREEMENT)).toEqual(AGREEMENT);
    const unchanged = { ...AGREEMENT, changed: 0, unchanged: 4, meanAbsDelta: null, byConfidence: { high: null, medium: null, low: { ...TALLY, meanAbsDelta: null } } };
    expect(AiAgreement.parse(unchanged)).toEqual(unchanged);
  });

  it("refuses a confidence left out, a negative or fractional count, and a source without its accepted count", () => {
    expect(AiAgreement.safeParse({ ...AGREEMENT, byConfidence: { high: TALLY } }).success).toBe(false);
    expect(AiAgreement.safeParse({ ...AGREEMENT, compared: -1 }).success).toBe(false);
    expect(ContestationTally.safeParse({ ...CONTESTED, filed: 1.5 }).success).toBe(false);
    expect(ContestationTally.safeParse({ ...CONTESTED, bySource: { ...CONTESTED.bySource, llm: 1 } }).success).toBe(false);
  });

  it("takes each figure present or null", () => {
    for (const figures of [
      { agreement: AGREEMENT, contestations: CONTESTED },
      { agreement: null, contestations: CONTESTED },
      { agreement: AGREEMENT, contestations: null },
      { agreement: null, contestations: null },
    ]) {
      expect(GradingFigures.parse(figures)).toEqual(figures);
    }
    expect(GradingFigures.safeParse({ agreement: null }).success).toBe(false);
  });

  it("travels on the queue's item, which always carries it, null or not", () => {
    const item = { id: "0190d3c4-0000-7000-8000-000000000001", position: 0, internalName: "q", type: "rich", points: 3 };
    expect(GradingQueueItem.parse({ ...item, agreement: null }).agreement).toBeNull();
    expect(GradingQueueItem.parse({ ...item, agreement: AGREEMENT }).agreement).toEqual(AGREEMENT);
    expect(GradingQueueItem.safeParse(item).success).toBe(false);
  });

  it("travels on every question of the per-question results, and the evaluation's beside it", () => {
    const shape = ByQuestion.shape;
    expect(shape.figures.parse({ agreement: null, contestations: CONTESTED })).toMatchObject({ contestations: { graded: 9 } });
    expect(shape.totalFigures.safeParse(undefined).success).toBe(false);
  });
});
