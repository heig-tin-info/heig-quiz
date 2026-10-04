import { describe, expect, it } from "vitest";

import { acceptRefusal, type ProjectAcceptLike } from "./projectAccept.js";

const project: ProjectAcceptLike = {
  startAt: new Date("2026-10-02T08:00:00Z"),
  deadlineAt: new Date("2026-10-09T22:00:00Z"),
  distributionFullName: "org/lab-1-squashed",
};
const at = (iso: string) => new Date(iso);

describe("acceptRefusal (F-PROJ-05)", () => {
  it("accepts between the start (included) and the deadline (excluded)", () => {
    expect(acceptRefusal(project, at("2026-10-02T08:00:00Z"))).toBeNull();
    expect(acceptRefusal(project, at("2026-10-09T21:59:59.999Z"))).toBeNull();
  });

  it("refuses before the start and from the deadline on, with no grace", () => {
    expect(acceptRefusal(project, at("2026-10-02T07:59:59.999Z"))).toBe("not_started");
    expect(acceptRefusal(project, at("2026-10-09T22:00:00Z"))).toBe("deadline_passed");
  });

  it("refuses a project with nothing to hand out, the dates first", () => {
    const now = at("2026-10-03T00:00:00Z");
    expect(acceptRefusal({ ...project, distributionFullName: null }, now)).toBe("distribution_missing");
    expect(acceptRefusal({ ...project, distributionFullName: null }, at("2026-10-01T00:00:00Z"))).toBe("not_started");
  });
});
