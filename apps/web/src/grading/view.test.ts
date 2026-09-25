import { describe, expect, it } from "vitest";

import { ALL_PARTS_SHOWN } from "./parts";
import { GRADING_VIEW_DEFAULTS, parseGradingView, type GradingView } from "./view";

/*
 * Issue #110: what is read back from storage is validated field by field.
 * Nothing stored, garbage, or one bad field never costs the others.
 */

const CHOSEN: GradingView = {
  order: "student",
  stateFilter: "proposed",
  source: "llm",
  confidence: "low",
  parts: { ...ALL_PARTS_SHOWN, prompt: false, comment: false },
};

describe("parseGradingView", () => {
  it("gives the defaults when nothing is stored", () => {
    expect(parseGradingView(null)).toEqual(GRADING_VIEW_DEFAULTS);
  });

  it("reads back what was written", () => {
    expect(parseGradingView(JSON.stringify(CHOSEN))).toEqual(CHOSEN);
  });

  it("gives the defaults for a value that is not JSON, or not an object", () => {
    expect(parseGradingView("{not json")).toEqual(GRADING_VIEW_DEFAULTS);
    expect(parseGradingView("[1,2]")).toEqual(GRADING_VIEW_DEFAULTS);
    expect(parseGradingView("null")).toEqual(GRADING_VIEW_DEFAULTS);
    expect(parseGradingView('"student"')).toEqual(GRADING_VIEW_DEFAULTS);
  });

  it("falls back field by field, keeping the valid ones", () => {
    const view = parseGradingView(
      JSON.stringify({
        order: "student",
        stateFilter: "everything",
        source: 42,
        confidence: "high",
        parts: { prompt: false, solution: "no", comment: null },
      }),
    );
    expect(view).toEqual({
      order: "student",
      stateFilter: "all",
      source: "any",
      confidence: "high",
      parts: { ...ALL_PARTS_SHOWN, prompt: false },
    });
  });

  it("never carries the names switch, even when one was stored", () => {
    const view = parseGradingView(JSON.stringify({ ...CHOSEN, showNames: true }));
    expect(view).not.toHaveProperty("showNames");
  });
});
