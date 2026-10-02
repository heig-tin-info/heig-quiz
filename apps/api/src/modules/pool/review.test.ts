/**
 * The review's reply schema goes through the SDK's structured-output
 * conversion (ADR-060): a schema the conversion refuses would fail at the
 * first real call, which no fake provider sees. And the findings kept from
 * a reply, without a database.
 */
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";

import { keptFindings, ReviewReply } from "./review.js";

describe("the review's reply", () => {
  it("converts to a structured output", () => {
    expect(JSON.stringify(zodOutputFormat(ReviewReply))).toContain("severity");
  });

  it("keeps a finding on a field the version has, its fix only when it applies there", () => {
    const config = { prompt: "Le resultat", choices: [{ text: "a", correct: false }] };
    const kept = keptFindings(config, "Parce que.", [
      { severity: "notice", path: "prompt", message: " m ", fix: { from: "resultat", to: "résultat" } },
      { severity: "error", path: "choices.0.correct", message: "key", fix: { from: "false", to: "true" } },
      { severity: "warn", path: "explanation", message: "e", fix: { from: "absent", to: "x" } },
      { severity: "warn", path: "choices..text", message: "bad path", fix: null },
    ]);
    expect(kept).toEqual([
      { severity: "notice", path: "prompt", message: "m", fix: { from: "resultat", to: "résultat" } },
      { severity: "error", path: "choices.0.correct", message: "key", fix: { from: "false", to: "true" } },
      { severity: "warn", path: "explanation", message: "e", fix: null },
    ]);
  });
});
