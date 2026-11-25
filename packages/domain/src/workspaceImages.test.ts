import { describe, expect, it } from "vitest";

import { compareBaseVersions, imageObsolete } from "./workspaceImages.js";

describe("compareBaseVersions", () => {
  it("orders number by number, never as text", () => {
    expect(compareBaseVersions("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareBaseVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareBaseVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("counts a missing part as 0", () => {
    expect(compareBaseVersions("1.2", "1.2.0")).toBe(0);
    expect(compareBaseVersions("1", "1.0.1")).toBeLessThan(0);
  });

  it("refuses what is not a version", () => {
    for (const [a, b] of [
      ["1.0.0-rc1", "1.0.0"],
      ["v1.0.0", "1.0.0"],
      ["1.0.0", ""],
      ["latest", "1.0.0"],
      ["1..0", "1.0.0"],
    ] as const) {
      expect(compareBaseVersions(a, b)).toBeNull();
    }
  });
});

describe("imageObsolete", () => {
  it("is true on an older base only", () => {
    expect(imageObsolete("1.0.0", "1.1.0")).toBe(true);
    expect(imageObsolete("1.1.0", "1.1.0")).toBe(false);
    expect(imageObsolete("1.2.0", "1.1.0")).toBe(false);
  });

  it("is unknown without both versions, or with one it cannot order", () => {
    expect(imageObsolete(null, "1.0.0")).toBeNull();
    expect(imageObsolete("1.0.0", null)).toBeNull();
    expect(imageObsolete("1.0.0", "next")).toBeNull();
  });
});
