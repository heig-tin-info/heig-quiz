import { describe, expect, it } from "vitest";

import { extractScore, parseScoreMessage } from "./ciScore.js";

describe("parseScoreMessage (GR-02)", () => {
  it.each([
    ["4.5/6", 4.5, 6],
    ["10/10", 10, 10],
    ["0/6", 0, 6],
    ["  85 / 100  ", 85, 100],
    ["5.25/6.0", 5.25, 6],
  ])("accepts %s", (msg, points, max) => {
    expect(parseScoreMessage(msg)).toEqual({ status: "ok", points, max });
  });

  it.each([
    "6/0", // zero max
    "7/6", // points > max
    "-1/6", // negative (the sign is not in the grammar)
    "4,5/6", // decimal comma
    "4.5", // no denominator
    "note: 4/6", // stray prefix
    "4/6 points", // stray suffix
    "",
  ])("rejects %s", (msg) => {
    expect(parseScoreMessage(msg).status).toBe("malformed");
  });
});

describe("extractScore (GR-17)", () => {
  const score = (message: string) => ({ title: "GRADE", message });

  it("single valid annotation", () => {
    expect(extractScore([score("4/6"), { title: "info", message: "x" }])).toEqual({
      status: "ok",
      points: 4,
      max: 6,
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
    expect(extractScore([{ title: "GRADE", message: null }])).toMatchObject({
      status: "malformed",
    });
  });
});
