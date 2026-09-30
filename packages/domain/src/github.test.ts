import { describe, expect, it } from "vitest";

import { parseStudentIgnore, rateLimitReset } from "./github.js";

describe("parseStudentIgnore", () => {
  it("keeps plain relative paths and drops comments and blanks", () => {
    expect(parseStudentIgnore("# teacher only\n\nscripts/\n/.github/workflows/studentize.yml\r\n")).toEqual([
      "scripts",
      ".github/workflows/studentize.yml",
    ]);
  });

  it("refuses anything that leaves the tree or touches git", () => {
    expect(parseStudentIgnore("../outside\na/../../b\n.git\n.git/config\n./x\n/\n")).toEqual([]);
  });
});

describe("rateLimitReset", () => {
  const refusal = (status: number, headers: Record<string, string>) => ({ status, response: { headers } });
  const now = 1_000_000;

  it("reads the reset of an exhausted quota, in seconds", () => {
    expect(rateLimitReset(refusal(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800" }), now)).toBe(
      1_800_000,
    );
  });

  it("counts a retry-after delay from now", () => {
    expect(rateLimitReset(refusal(429, { "retry-after": "60" }), now)).toBe(now + 60_000);
    // A quota not exhausted is not the reason: the secondary limit's delay is.
    expect(
      rateLimitReset(refusal(403, { "x-ratelimit-remaining": "12", "x-ratelimit-reset": "1800", "retry-after": "5" }), now),
    ).toBe(now + 5_000);
  });

  it("is null for any other refusal or error", () => {
    expect(rateLimitReset(refusal(403, {}), now)).toBeNull();
    expect(rateLimitReset({ status: 403 }, now)).toBeNull();
    expect(rateLimitReset(refusal(500, { "retry-after": "60" }), now)).toBeNull();
    expect(rateLimitReset(new Error("boom"), now)).toBeNull();
    expect(rateLimitReset(null, now)).toBeNull();
  });
});
