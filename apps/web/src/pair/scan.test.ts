import { describe, expect, it } from "vitest";

import { stationCodeOf } from "./scan";

const ORIGIN = "https://quiz.heig-vd.ch";

describe("the code a scanned QR carries (ADR-051 §7)", () => {
  it("reads a station's own /pair link on this site", () => {
    expect(stationCodeOf(`${ORIGIN}/pair?code=BCDF-GHJK`, ORIGIN)).toBe("BCDF-GHJK");
    expect(stationCodeOf(`${ORIGIN}/pair/?code=bcdfghjk`, ORIGIN)).toBe("BCDF-GHJK");
  });

  it("refuses the same link on another site", () => {
    expect(stationCodeOf("https://evil.example/pair?code=BCDF-GHJK", ORIGIN)).toBeNull();
    expect(stationCodeOf("http://quiz.heig-vd.ch/pair?code=BCDF-GHJK", ORIGIN)).toBeNull();
  });

  it("refuses another page of this site", () => {
    expect(stationCodeOf(`${ORIGIN}/login?code=BCDF-GHJK`, ORIGIN)).toBeNull();
    expect(stationCodeOf(`${ORIGIN}/pair/extra?code=BCDF-GHJK`, ORIGIN)).toBeNull();
  });

  it("reads a bare code", () => {
    expect(stationCodeOf("bcdf-ghjk", ORIGIN)).toBe("BCDF-GHJK");
    expect(stationCodeOf(" BCDFGHJK\n", ORIGIN)).toBe("BCDF-GHJK");
  });

  it("refuses anything else", () => {
    expect(stationCodeOf("", ORIGIN)).toBeNull();
    expect(stationCodeOf("hello world", ORIGIN)).toBeNull();
    expect(stationCodeOf("javascript:alert(1)", ORIGIN)).toBeNull();
    expect(stationCodeOf(`${ORIGIN}/pair`, ORIGIN)).toBeNull();
    expect(stationCodeOf(`${ORIGIN}/pair?code=NOT-A-CODE!`, ORIGIN)).toBeNull();
  });
});
