import { describe, expect, it } from "vitest";

import { ExtendBody } from "./live.js";

describe("ExtendBody (F-LIVE-11)", () => {
  it("takes a date with its offset, for the whole class only", () => {
    expect(ExtendBody.parse({ until: "2026-11-19T16:30:00+01:00" })).toEqual({ until: "2026-11-19T16:30:00+01:00" });
    expect(ExtendBody.parse({ until: "2026-11-19T15:30:00.000Z" })).toEqual({ until: "2026-11-19T15:30:00.000Z" });
    // No per-attempt date, no local time without its offset.
    const attemptId = "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f";
    expect(ExtendBody.safeParse({ until: "2026-11-19T16:30:00Z", scope: "attempt", attemptId }).success).toBe(false);
    expect(ExtendBody.safeParse({ until: "2026-11-19T16:30" }).success).toBe(false);
  });
});
