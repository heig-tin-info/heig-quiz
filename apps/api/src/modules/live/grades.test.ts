import { describe, expect, it } from "vitest";

import { gradeStatus } from "./grades.js";

describe("gradeStatus (F-RES-04)", () => {
  it.each([
    [{ handedIn: false, released: true, results: "none" }, "missed"],
    [{ handedIn: false, released: false, results: "none" }, "missed"],
    [{ handedIn: true, released: true, results: "available" }, "released"],
    // Released under the policy `none`: the grade is not shared.
    [{ handedIn: true, released: true, results: "none" }, "withheld"],
    // Released, the counted attempt's results still to come (an attempt
    // reopened, retakes open): released, not withheld.
    [{ handedIn: true, released: true, results: "pending" }, "released"],
    [{ handedIn: true, released: false, results: "available" }, "available"],
    [{ handedIn: true, released: false, results: "pending" }, "pending"],
    [{ handedIn: true, released: false, results: "none" }, "submitted"],
  ] as const)("%o is %s", (fact, status) => {
    expect(gradeStatus(fact)).toBe(status);
  });
});
