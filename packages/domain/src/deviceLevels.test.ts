import { describe, expect, it } from "vitest";

import { DEVICE_LEVEL_IDS, DEVICE_LEVELS, SUPERVISED_DEVICE_LEVELS, acceptsKiosk, deviceLevelClients, deviceLevelOf } from "./deviceLevels.js";

describe("DEVICE_LEVELS (ADR-089 point 2)", () => {
  it("lists the four levels in the order shown, each with its clients in TRUSTED_CLIENTS' order", () => {
    expect(DEVICE_LEVEL_IDS).toEqual(["any", "seb", "either", "kiosk"]);
    expect(DEVICE_LEVELS.map((l) => [...l.clients])).toEqual([[], ["seb"], ["seb", "kiosk"], ["kiosk"]]);
    expect(SUPERVISED_DEVICE_LEVELS).toEqual(DEVICE_LEVEL_IDS.filter((id) => id !== "any"));
  });

  it("maps every subset of the trusted clients to one level and back, whatever the order", () => {
    expect(deviceLevelOf([])).toBe("any");
    expect(deviceLevelOf(["seb"])).toBe("seb");
    expect(deviceLevelOf(["kiosk", "seb"])).toBe("either");
    expect(deviceLevelOf(["kiosk"])).toBe("kiosk");
    for (const id of DEVICE_LEVEL_IDS) expect(deviceLevelOf(deviceLevelClients(id))).toBe(id);
  });

  it("calls a level that accepts a kiosk station a station level", () => {
    expect(DEVICE_LEVEL_IDS.filter(acceptsKiosk)).toEqual(["either", "kiosk"]);
  });
});
