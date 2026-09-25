import { describe, expect, it } from "vitest";

import { LIVE_TOGGLE_DEFAULTS, parseLiveToggles } from "./toggles";

describe("parseLiveToggles (#80)", () => {
  it("gives the defaults when nothing is stored", () => {
    expect(parseLiveToggles(null)).toEqual(LIVE_TOGGLE_DEFAULTS);
  });

  it("reads back what was stored", () => {
    expect(parseLiveToggles('{"names":false,"answers":true,"results":false}')).toEqual({
      names: false,
      answers: true,
      results: false,
    });
  });

  it("ignores a value that is not JSON, or not an object", () => {
    for (const raw of ["", "not json", "true", "[false,false,false]", "null", '"names"']) {
      expect(parseLiveToggles(raw)).toEqual(LIVE_TOGGLE_DEFAULTS);
    }
  });

  it("falls back field by field: a malformed field does not take the others down", () => {
    expect(parseLiveToggles('{"names":false,"answers":"no","results":0,"extra":1}')).toEqual({
      names: false,
      answers: true,
      results: true,
    });
  });

  it("never hands out the shared defaults object", () => {
    const a = parseLiveToggles(null);
    a.names = false;
    expect(parseLiveToggles(null).names).toBe(true);
  });
});
