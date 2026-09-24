import { describe, expect, it } from "vitest";

import {
  COOLDOWN_BASE_MS,
  COOLDOWN_MAX_MS,
  COOLDOWN_SERVER_SLACK_MS,
  cooldownMs,
  decayedUses,
  effectiveCooldownMs,
  serverFloorMs,
} from "./cooldown.js";

describe("cooldownMs", () => {
  it("is always the base under fixed", () => {
    expect(cooldownMs("fixed", 0)).toBe(3000);
    expect(cooldownMs("fixed", 50)).toBe(3000);
  });

  it("grows by 30 % per recent use under progressive", () => {
    expect(cooldownMs("progressive", 0)).toBe(3000);
    expect(cooldownMs("progressive", 1)).toBe(3900);
    expect(cooldownMs("progressive", 2)).toBe(5070);
  });

  it("is capped at 30 s", () => {
    expect(cooldownMs("progressive", 8)).toBeLessThan(COOLDOWN_MAX_MS);
    expect(cooldownMs("progressive", 9)).toBe(COOLDOWN_MAX_MS);
    expect(cooldownMs("progressive", 1000)).toBe(COOLDOWN_MAX_MS);
  });

  it("reads a negative or broken count as zero", () => {
    expect(cooldownMs("progressive", -3)).toBe(COOLDOWN_BASE_MS);
    expect(cooldownMs("progressive", Number.NaN)).toBe(COOLDOWN_BASE_MS);
    expect(cooldownMs("progressive", 1.9)).toBe(3900);
  });
});

describe("decayedUses", () => {
  it("forgives one use per full 20 s idle", () => {
    expect(decayedUses(5, 0)).toBe(5);
    expect(decayedUses(5, 19_999)).toBe(5);
    expect(decayedUses(5, 20_000)).toBe(4);
    expect(decayedUses(5, 65_000)).toBe(2);
  });

  it("never goes below zero", () => {
    expect(decayedUses(2, 600_000)).toBe(0);
    expect(decayedUses(0, 0)).toBe(0);
    expect(decayedUses(3, -5)).toBe(3);
  });
});

describe("serverFloorMs", () => {
  it("spaces the runs by the budget, with slack", () => {
    expect(serverFloorMs(10)).toBe(6000 + COOLDOWN_SERVER_SLACK_MS);
    expect(serverFloorMs(30)).toBe(2000 + COOLDOWN_SERVER_SLACK_MS);
    expect(serverFloorMs(7)).toBe(8572 + COOLDOWN_SERVER_SLACK_MS);
  });

  it("never lets a spacing fit more runs than the budget in a minute", () => {
    for (let rpm = 1; rpm <= 30; rpm++) expect(serverFloorMs(rpm) * rpm).toBeGreaterThan(60_000);
  });
});

describe("effectiveCooldownMs", () => {
  it("applies the floor on the server only", () => {
    const base = { mode: "fixed" as const, uses: 0, runsPerMinute: 10 };
    expect(effectiveCooldownMs({ ...base, onServer: false })).toBe(3000);
    expect(effectiveCooldownMs({ ...base, onServer: true })).toBe(6500);
  });

  it("keeps the teacher's rule when it is already longer", () => {
    expect(
      effectiveCooldownMs({ mode: "progressive", uses: 9, runsPerMinute: 10, onServer: true }),
    ).toBe(COOLDOWN_MAX_MS);
  });
});
