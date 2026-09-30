import { describe, expect, it } from "vitest";

import { KioskAttestVerify, KioskDevicePatch } from "./kiosk.js";

describe("KioskAttestVerify", () => {
  it("takes a response, or the extension's failure, never both nor neither", () => {
    expect(KioskAttestVerify.parse({ response: "UkVTUA==" })).toEqual({ response: "UkVTUA==" });
    expect(KioskAttestVerify.parse({ error: "no platformKeys" })).toEqual({ error: "no platformKeys" });
    expect(KioskAttestVerify.safeParse({ response: "x", error: "y" }).success).toBe(false);
    expect(KioskAttestVerify.safeParse({}).success).toBe(false);
    expect(KioskAttestVerify.safeParse({ response: "" }).success).toBe(false);
    expect(KioskAttestVerify.safeParse({ response: "x".repeat(16_385) }).success).toBe(false);
  });
});

describe("KioskDevicePatch", () => {
  it("trims the label and bounds it to 1..80 characters", () => {
    expect(KioskDevicePatch.parse({ label: "  Poste n° 7 " })).toEqual({ label: "Poste n° 7" });
    expect(KioskDevicePatch.safeParse({ label: "   " }).success).toBe(false);
    expect(KioskDevicePatch.safeParse({ label: "x".repeat(81) }).success).toBe(false);
    expect(KioskDevicePatch.parse({ label: "x".repeat(80) }).label).toHaveLength(80);
  });

  it("sets a status an admin may choose, and refuses an empty patch", () => {
    expect(KioskDevicePatch.parse({ status: "retired" })).toEqual({ status: "retired" });
    expect(KioskDevicePatch.safeParse({ status: "unnamed" }).success).toBe(false);
    expect(KioskDevicePatch.safeParse({}).success).toBe(false);
    expect(KioskDevicePatch.safeParse({ label: "x", extra: 1 }).success).toBe(false);
  });
});
