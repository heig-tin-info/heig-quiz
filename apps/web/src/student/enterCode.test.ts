import { describe, expect, it } from "vitest";

import { codeTarget, normalizeCode } from "./enterCode";

describe("normalizeCode", () => {
  it("drops spaces and hyphens and upper-cases", () => {
    expect(normalizeCode(" k7pm-q2xr ")).toBe("K7PMQ2XR");
    expect(normalizeCode("nm2 x9a")).toBe("NM2X9A");
    expect(normalizeCode("NM2\tX9A\n")).toBe("NM2X9A");
  });

  it("corrects no look-alike character", () => {
    expect(normalizeCode("o0il1")).toBe("O0IL1");
  });
});

describe("codeTarget (ADR-045)", () => {
  it("sends six characters to the poll", () => {
    expect(codeTarget("nm2x9a")).toEqual({ kind: "poll", code: "NM2X9A" });
    expect(codeTarget("NM2-X9A")).toEqual({ kind: "poll", code: "NM2X9A" });
  });

  it("sends eight characters to the classroom", () => {
    expect(codeTarget("k7pm-q2xr")).toEqual({ kind: "classroom", code: "K7PMQ2XR" });
  });

  it("refuses every other length, the empty field included", () => {
    for (const raw of ["", "   ", "-", "ABCDE", "ABCDEFG", "ABCDEFGHJ"]) {
      expect(codeTarget(raw)).toEqual({ kind: "invalid" });
    }
  });
});
