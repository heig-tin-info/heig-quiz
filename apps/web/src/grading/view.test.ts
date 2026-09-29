import { describe, expect, it } from "vitest";

import { GRADING_VIEW_DEFAULTS, parseGradingView, type GradingView } from "./view";

/*
 * Issue #110: what is read back from storage is validated field by field.
 * Nothing stored, garbage, or one bad field never costs the others — and a
 * value stored by the previous panel (ADR-040) reads gracefully.
 */

const CHOSEN: GradingView = { stateFilter: "todo", source: "llm", confidence: "low" };

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
      JSON.stringify({ stateFilter: "everything", source: 42, confidence: "high" }),
    );
    expect(view).toEqual({ stateFilter: "all", source: "any", confidence: "high" });
  });

  it("reads the previous panel's stored view: order and parts dropped, proposed kept", () => {
    const old = {
      order: "student",
      stateFilter: "proposed",
      source: "auto",
      confidence: "any",
      parts: { prompt: false, explanation: true, solution: true, comment: false },
    };
    expect(parseGradingView(JSON.stringify(old))).toEqual({
      stateFilter: "todo",
      source: "auto",
      confidence: "any",
    });
    // Its third state had no control left: it reads as everything.
    expect(parseGradingView(JSON.stringify({ stateFilter: "validated" })).stateFilter).toBe("all");
  });

  it("never carries a names switch, even when one was stored", () => {
    const view = parseGradingView(JSON.stringify({ ...CHOSEN, showNames: true, anonymise: false }));
    expect(view).toEqual(CHOSEN);
  });
});
