import { describe, expect, it } from "vitest";

import { extractScore } from "./ciScore.js";

const score = (message: string | null) => ({ title: "GRADE", message });

describe("extractScore, the message", () => {
  it.each([
    ["4.5/6", 4.5, 6],
    ["10/10", 10, 10],
    ["0/6", 0, 6],
    ["  85 / 100  ", 85, 100],
    ["5.25/6.0", 5.25, 6],
  ])("accepts %s", (msg, points, max) => {
    expect(extractScore([score(msg)])).toEqual({ status: "ok", points, max, clamped: false });
  });

  it.each([
    "6/0", // zero max
    "7/6", // points > max
    "-2/0", // zero max
    "-2/-6", // negative max
    "2/-6",
    "+2/6", // plus sign is not in the grammar
    "--2/6",
    "4,5/6", // decimal comma
    "4.5", // no denominator
    "note: 4/6", // stray prefix
    "4/6 points", // stray suffix
    "",
  ])("rejects %s", (msg) => {
    expect(extractScore([score(msg)]).status).toBe("malformed");
  });
});

describe("extractScore, a negative score (M3-14n)", () => {
  it("counts a negative points value 0 and says it was clamped", () => {
    expect(extractScore([score("-2/6")])).toEqual({ status: "ok", points: 0, max: 6, clamped: true, message: "-2/6" });
    expect(extractScore([score(" -0.5 / 6 ")])).toEqual({ status: "ok", points: 0, max: 6, clamped: true, message: " -0.5 / 6 " });
  });

  it("does not flag -0: nothing was lost", () => {
    const parsed = extractScore([score("-0/6")]);
    expect(parsed).toMatchObject({ status: "ok", max: 6, clamped: false });
    expect(Object.is((parsed as { points: number }).points, 0)).toBe(true);
  });
});

describe("extractScore, the annotations", () => {
  it("single valid annotation", () => {
    expect(extractScore([score("4/6"), { title: "info", message: "x" }])).toEqual({
      status: "ok",
      points: 4,
      max: 6,
      clamped: false,
    });
  });

  it("no GRADE annotation", () => {
    expect(extractScore([{ title: "warning", message: "4/6" }])).toEqual({
      status: "no_annotation",
    });
  });

  it("multiple annotations, even identical, invalidate (anti-tampering H5)", () => {
    expect(extractScore([score("4/6"), score("4/6")])).toEqual({
      status: "multiple",
      count: 2,
    });
  });

  it("null message treated as malformed", () => {
    expect(extractScore([score(null)])).toMatchObject({
      status: "malformed",
    });
  });
});
