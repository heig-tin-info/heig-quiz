import { describe, expect, it } from "vitest";

import {
  DEFAULT_LLM_MODEL,
  isParis,
  llmCostUsd,
  llmModel,
  llmWorstCaseUsd,
  modelFor,
  shareAllows,
} from "./llm.js";

describe("llmCostUsd", () => {
  it("prices input and output tokens per million", () => {
    expect(llmCostUsd("claude-sonnet-5-5", 1_000_000, 0)).toBe(2);
    expect(llmCostUsd("claude-sonnet-5-5", 0, 1_000_000)).toBe(10);
    expect(llmCostUsd("claude-haiku-4-5", 2_000, 1_000)).toBeCloseTo(0.007);
  });

  it("prices a dated variant as its model, and an unknown model as the dearest", () => {
    expect(llmModel("claude-sonnet-5-5-20260901").id).toBe("claude-sonnet-5-5");
    expect(llmModel("some-future-model").id).toBe("claude-opus-5-5");
  });
});

describe("llmWorstCaseUsd", () => {
  it("counts the prompt generously and the whole output budget", () => {
    // 3 000 characters → 1 000 tokens at $2/M, 1 000 output tokens at $10/M.
    expect(llmWorstCaseUsd("claude-sonnet-5-5", 3_000, 1_000)).toBeCloseTo(0.012);
  });
});

describe("modelFor", () => {
  it("takes the purpose's model, else the default, else the platform's", () => {
    expect(modelFor({ test: "claude-haiku-4-5", default: "claude-opus-5-5" }, "test")).toBe("claude-haiku-4-5");
    expect(modelFor({ default: "claude-opus-5-5" }, "generate")).toBe("claude-opus-5-5");
    expect(modelFor({}, "review")).toBe(DEFAULT_LLM_MODEL);
    // A live poll takes the fast model unless the settings name one for it.
    expect(modelFor({ default: "claude-opus-5-5" }, "poll")).toBe("claude-haiku-4-5");
    expect(modelFor({ poll: "claude-sonnet-5-5" }, "poll")).toBe("claude-sonnet-5-5");
  });
});

describe("isParis", () => {
  it("accepts Paris however it is written, and nothing else", () => {
    expect(isParis("Paris")).toBe(true);
    expect(isParis("PARIS.")).toBe(true);
    expect(isParis("The capital of France is Paris")).toBe(true);
    expect(isParis("Lyon")).toBe(false);
    expect(isParis("Parisien")).toBe(false);
  });
});

describe("shareAllows", () => {
  const cap = 20;
  const share = 0.25 * cap;

  it("allows a call within the chat's share and the others' reserve", () => {
    expect(shareAllows({ spentTotalUsd: 0, spentPurposeUsd: 0, worstCaseUsd: 0.1, capUsd: cap }, 0.25)).toBe(true);
    expect(shareAllows({ spentTotalUsd: 1, spentPurposeUsd: share - 0.1, worstCaseUsd: 0.1, capUsd: cap }, 0.25)).toBe(
      true,
    );
  });

  it("refuses once the chat spent its share", () => {
    expect(shareAllows({ spentTotalUsd: share, spentPurposeUsd: share, worstCaseUsd: 0.01, capUsd: cap }, 0.25)).toBe(
      false,
    );
  });

  it("refuses the chat first when the day nears the cap, whoever spent it", () => {
    // Grading spent 14.95 USD: the chat may not take what is left of the last quarter.
    expect(shareAllows({ spentTotalUsd: 14.95, spentPurposeUsd: 0, worstCaseUsd: 0.1, capUsd: cap }, 0.25)).toBe(false);
  });
});

