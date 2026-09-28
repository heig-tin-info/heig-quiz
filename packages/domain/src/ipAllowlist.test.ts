import { describe, expect, it } from "vitest";

import { ipAllowed } from "./ipAllowlist.js";

describe("ipAllowed (F-EVAL-12)", () => {
  it("lets everybody in when the list is empty", () => {
    expect(ipAllowed([], "203.0.113.9")).toBe(true);
    expect(ipAllowed([], undefined)).toBe(true);
  });

  it("matches a prefix literally", () => {
    expect(ipAllowed(["10.20."], "10.20.0.7")).toBe(true);
    expect(ipAllowed(["10.20."], "10.200.0.7")).toBe(false);
    expect(ipAllowed(["10.20.", "192.168.1."], "192.168.1.4")).toBe(true);
  });

  it("refuses an unknown address under a non-empty list", () => {
    expect(ipAllowed(["10.20."], undefined)).toBe(false);
  });
});
