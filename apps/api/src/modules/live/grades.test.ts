import { describe, expect, it } from "vitest";

import { gradeStatus } from "./grades.js";

describe("gradeStatus (F-RES-04)", () => {
  it.each([
    [{ handedIn: false, released: true, results: "none", excused: false }, "missed"],
    [{ handedIn: false, released: false, results: "none", excused: false }, "missed"],
    [{ handedIn: true, released: true, results: "available", excused: false }, "released"],
    // Released under the policy `none`: the grade is not shared.
    [{ handedIn: true, released: true, results: "none", excused: false }, "withheld"],
    // Released, the counted attempt's results still to come (an attempt
    // reopened, retakes open): released, not withheld.
    [{ handedIn: true, released: true, results: "pending", excused: false }, "released"],
    [{ handedIn: true, released: false, results: "available", excused: false }, "available"],
    [{ handedIn: true, released: false, results: "pending", excused: false }, "pending"],
    [{ handedIn: true, released: false, results: "none", excused: false }, "submitted"],
    // Excused (#969): once released, whatever the policy or the hand-in; before, the mark is the staff's alone.
    [{ handedIn: true, released: true, results: "available", excused: true }, "excused"],
    [{ handedIn: false, released: true, results: "none", excused: true }, "excused"],
    [{ handedIn: true, released: false, results: "available", excused: true }, "available"],
  ] as const)("%o is %s", (fact, status) => {
    expect(gradeStatus(fact)).toBe(status);
  });
});
